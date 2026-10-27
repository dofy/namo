import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 11;

/** Called inside Store's upgrade transaction. Legacy ledgers remain intact. */
export function migrateScheduling(db: DatabaseSync): void {
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 11) return;
  const columns = new Set(db.prepare('PRAGMA table_info(outbox)').all().map(row => row.name));
  if (!columns.has('progressRetired')) db.exec('ALTER TABLE outbox ADD COLUMN progressRetired INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE INDEX IF NOT EXISTS outbox_live_progress ON outbox(id)
      WHERE kind='progress' AND mutableProgress=1 AND state='sent' AND payload IS NOT NULL AND progressRetired=0;
    CREATE TABLE IF NOT EXISTS background_work (
      key TEXT PRIMARY KEY REFERENCES settings(key) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('memory','artifact','artifact-intent')),
      readyAt INTEGER NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS background_work_ready ON background_work(kind,readyAt,createdAt,key);
  `);
  // Projections also cover legacy code paths writing the JSON ledger directly.
  // Each update removes terminal jobs from the hot set in the same transaction.
  const project = (key: string, value: string) => `
    INSERT OR REPLACE INTO background_work(key,kind,readyAt,createdAt)
    SELECT ${key},
      CASE WHEN ${key} GLOB 'auto-memory:job:*' THEN 'memory' WHEN ${key} GLOB 'artifact-intent:*' THEN 'artifact-intent' ELSE 'artifact' END,
      CASE WHEN ${key} GLOB 'auto-memory:job:*' THEN CASE WHEN json_extract(${value},'$.state')='running'
        THEN json_extract(${value},'$.leaseUntil') ELSE json_extract(${value},'$.dueAt') END ELSE 0 END,
      COALESCE(json_extract(${value},'$.createdAt'),0)
    WHERE CASE WHEN json_valid(${value}) THEN
      (${key} GLOB 'auto-memory:job:*' AND json_extract(${value},'$.version')=1
        AND ((json_extract(${value},'$.state')='pending' AND json_extract(${value},'$.attempts')<3)
          OR json_extract(${value},'$.state')='running')
        AND typeof(json_extract(${value},'$.dueAt')) IN ('integer','real')
        AND typeof(json_extract(${value},'$.leaseUntil')) IN ('integer','real'))
      OR (${key} GLOB 'artifact-intent:*' AND json_extract(${value},'$.state')='pending')
      OR (${key} GLOB 'artifact:*' AND json_extract(${value},'$.state') IN ('pending','uploaded'))
      ELSE 0 END;
  `;
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS background_work_insert AFTER INSERT ON settings BEGIN ${project('NEW.key','NEW.value')} END;
    CREATE TRIGGER IF NOT EXISTS background_work_update AFTER UPDATE ON settings BEGIN
      DELETE FROM background_work WHERE key=OLD.key; ${project('NEW.key','NEW.value')} END;
  `);
  const insert = db.prepare(project('$key', '$value'));
  for (const row of db.prepare("SELECT key,value FROM settings WHERE key GLOB 'auto-memory:job:*' OR key GLOB 'artifact:*' OR key GLOB 'artifact-intent:*'").all()) {
    insert.run({ $key: row.key, $value: row.value });
  }
  db.exec('PRAGMA user_version=11');
}
