import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 12;

/** Historical versions 0–10 used additive schema discovery. Keep that compatibility
 * path intact; subsequent changes run once through the numbered migrations below. */
function migrateTo11(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE,
      messageId TEXT NOT NULL, chatKey TEXT NOT NULL, chatId TEXT NOT NULL,
      senderId TEXT NOT NULL, text TEXT NOT NULL, createdAt INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued', cancelRequested INTEGER NOT NULL DEFAULT 0,
      threadId TEXT, turnId TEXT, error TEXT, finishedAt INTEGER
    );
    CREATE INDEX IF NOT EXISTS inbox_queue ON inbox(state,seq);
    CREATE INDEX IF NOT EXISTS inbox_chat ON inbox(chatKey,seq);
    CREATE TABLE IF NOT EXISTS sessions (
      chatKey TEXT PRIMARY KEY, threadId TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, inboxKey TEXT NOT NULL REFERENCES inbox(key),
      chatId TEXT NOT NULL, kind TEXT NOT NULL, part INTEGER NOT NULL,
      content TEXT NOT NULL, uuid TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'pending',
      platformId TEXT, error TEXT, createdAt INTEGER NOT NULL,
      UNIQUE(inboxKey,kind,part)
    );
  `);
  const columns = new Set((db.prepare('PRAGMA table_info(inbox)').all() as { name: string }[]).map(x => x.name));
  for (const [name, type] of [['envelope', 'TEXT'], ['taskId', 'TEXT'], ['materialUntil', 'INTEGER']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE inbox ADD COLUMN ${name} ${type}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, chatKey TEXT NOT NULL, scopeKey TEXT NOT NULL, ownerId TEXT NOT NULL,
      project TEXT, cwd TEXT NOT NULL, policyHash TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bindings (
      scopeKey TEXT NOT NULL, ownerId TEXT NOT NULL, workstreamId TEXT NOT NULL REFERENCES workstreams(id),
      PRIMARY KEY(scopeKey,ownerId)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, inboxKey TEXT NOT NULL UNIQUE REFERENCES inbox(key),
      workstreamId TEXT NOT NULL REFERENCES workstreams(id), ownerId TEXT NOT NULL,
      chatKey TEXT NOT NULL, scopeKey TEXT NOT NULL, project TEXT, cwd TEXT NOT NULL, policyHash TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued', inputVersion INTEGER NOT NULL DEFAULT 1,
      startedAt INTEGER, finishedAt INTEGER, error TEXT
    );
    CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(state);
    CREATE INDEX IF NOT EXISTS tasks_workstream ON tasks(workstreamId);
    CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(ownerId);
    CREATE INDEX IF NOT EXISTS inbox_created ON inbox(createdAt,seq);
    CREATE INDEX IF NOT EXISTS bindings_workstream ON bindings(workstreamId);
    CREATE TABLE IF NOT EXISTS task_messages (
      taskId TEXT NOT NULL REFERENCES tasks(id), inboxKey TEXT NOT NULL REFERENCES inbox(key),
      role TEXT NOT NULL, version INTEGER NOT NULL, dispatch TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY(taskId,inboxKey), UNIQUE(inboxKey)
    );
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), inputVersion INTEGER NOT NULL,
      state TEXT NOT NULL, threadId TEXT, turnId TEXT, startedAt INTEGER NOT NULL, finishedAt INTEGER, error TEXT
    );
    CREATE TABLE IF NOT EXISTS reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, requestId TEXT NOT NULL UNIQUE,
      subject TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, note TEXT NOT NULL,
      beforeState TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS card_actions (
      token TEXT PRIMARY KEY, outboxId INTEGER NOT NULL REFERENCES outbox(id),
      taskId TEXT NOT NULL REFERENCES tasks(id), action TEXT NOT NULL,
      inputVersion INTEGER NOT NULL, expiresAt INTEGER NOT NULL, usedAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS user_profiles (
      channel TEXT NOT NULL, appId TEXT NOT NULL, userId TEXT NOT NULL,
      name TEXT NOT NULL, language TEXT NOT NULL, timezone TEXT NOT NULL,
      version INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      PRIMARY KEY(channel,appId,userId)
    );
    CREATE TABLE IF NOT EXISTS profile_changes (
      channel TEXT NOT NULL, appId TEXT NOT NULL, userId TEXT NOT NULL,
      version INTEGER NOT NULL, fields TEXT NOT NULL, source TEXT NOT NULL,
      sourceRef TEXT, createdAt INTEGER NOT NULL,
      PRIMARY KEY(channel,appId,userId,version)
    );
    CREATE TABLE IF NOT EXISTS run_evidence (
      runId TEXT PRIMARY KEY REFERENCES task_runs(id), report TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runner_jobs (
      runId TEXT PRIMARY KEY REFERENCES task_runs(id), owner TEXT NOT NULL,
      state TEXT NOT NULL, pid INTEGER, runtimePid INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      configRevision TEXT NOT NULL, prompt TEXT NOT NULL, result TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS runner_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT NOT NULL REFERENCES runner_jobs(runId),
      kind TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_waits (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id),
      runId TEXT NOT NULL UNIQUE REFERENCES task_runs(id),
      threadId TEXT NOT NULL, turnId TEXT NOT NULL, callId TEXT NOT NULL,
      question TEXT NOT NULL, inputVersion INTEGER NOT NULL,
      state TEXT NOT NULL, createdAt INTEGER NOT NULL, settledAt INTEGER,
      replyInboxKey TEXT UNIQUE REFERENCES inbox(key), replyVersion INTEGER, choices TEXT
    );
    CREATE TABLE IF NOT EXISTS output_sources (
      inboxKey TEXT NOT NULL REFERENCES inbox(key), kind TEXT NOT NULL, content TEXT NOT NULL,
      PRIMARY KEY(inboxKey,kind)
    );
    CREATE TABLE IF NOT EXISTS run_activity (
      runId TEXT PRIMARY KEY REFERENCES task_runs(id), phase TEXT NOT NULL, updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_progress (
      runId TEXT PRIMARY KEY REFERENCES task_runs(id), report TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message_feedback (
      inboxKey TEXT PRIMARY KEY REFERENCES inbox(key), state TEXT NOT NULL DEFAULT 'pending',
      reactionId TEXT, error TEXT, updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS progress_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, outboxId INTEGER NOT NULL REFERENCES outbox(id),
      version INTEGER NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL,
      content TEXT NOT NULL, createdAt INTEGER NOT NULL, error TEXT, checked INTEGER NOT NULL DEFAULT 0,
      UNIQUE(outboxId,version)
    );
  `);
  const waitColumns = new Set(db.prepare('PRAGMA table_info(task_waits)').all().map(row => row.name));
  if (!waitColumns.has('choices')) db.exec('ALTER TABLE task_waits ADD COLUMN choices TEXT');
  // Native IDs belong to an executor instance. runId already uniquely scopes
  // every wait; a global (thread,turn,call) constraint aliases other profiles.
  const waitSchema = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='task_waits'").get()?.sql ?? '');
  if (waitSchema.includes('UNIQUE(threadId,turnId,callId)')) {
    db.exec(`CREATE TABLE task_waits_scoped (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id),
      runId TEXT NOT NULL UNIQUE REFERENCES task_runs(id),
      threadId TEXT NOT NULL, turnId TEXT NOT NULL, callId TEXT NOT NULL,
      question TEXT NOT NULL, inputVersion INTEGER NOT NULL,
      state TEXT NOT NULL, createdAt INTEGER NOT NULL, settledAt INTEGER,
      replyInboxKey TEXT UNIQUE REFERENCES inbox(key), replyVersion INTEGER, choices TEXT
    );
    INSERT INTO task_waits_scoped(rowid,id,taskId,runId,threadId,turnId,callId,question,inputVersion,state,createdAt,settledAt,replyInboxKey,replyVersion,choices)
      SELECT rowid,id,taskId,runId,threadId,turnId,callId,question,inputVersion,state,createdAt,settledAt,replyInboxKey,replyVersion,choices FROM task_waits;
    DROP TABLE task_waits;
    ALTER TABLE task_waits_scoped RENAME TO task_waits;`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS execution_bindings (subjectId TEXT PRIMARY KEY, selection TEXT NOT NULL);`);
  const outputColumns = new Set((db.prepare('PRAGMA table_info(outbox)').all() as { name: string }[]).map(x => x.name));
  if (!outputColumns.has('payload')) db.exec('ALTER TABLE outbox ADD COLUMN payload TEXT');
  if (!outputColumns.has('mutableProgress')) db.exec('ALTER TABLE outbox ADD COLUMN mutableProgress INTEGER NOT NULL DEFAULT 0');
  if (!outputColumns.has('route')) db.exec('ALTER TABLE outbox ADD COLUMN route TEXT');
  if (!outputColumns.has('sendStartedAt')) db.exec('ALTER TABLE outbox ADD COLUMN sendStartedAt INTEGER');
  if (!outputColumns.has('acceptedAt')) db.exec('ALTER TABLE outbox ADD COLUMN acceptedAt INTEGER');
  const progressColumns = new Set(db.prepare('PRAGMA table_info(progress_updates)').all().map(row => row.name));
  if (!progressColumns.has('revision')) db.exec('ALTER TABLE progress_updates ADD COLUMN revision TEXT');
  migrateScheduling(db);
}

function migrateScheduling(db: DatabaseSync): void {
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
}

/** Query-only indexes: existing rows, delivery UUIDs and execution ownership stay intact. */
function migrateQueryIndexes(db: DatabaseSync): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS task_runs_task_started ON task_runs(taskId,startedAt);
    CREATE INDEX IF NOT EXISTS runner_events_run_seq ON runner_events(runId,seq);
    CREATE INDEX IF NOT EXISTS task_waits_task ON task_waits(taskId);
    CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(id) WHERE state='pending';
    -- Match LIKE's existing case-folding semantics without changing stored keys.
    CREATE INDEX IF NOT EXISTS settings_key_nocase ON settings(key COLLATE NOCASE);
  `);
}

const migrations = [[11, migrateTo11], [12, migrateQueryIndexes]] as const;

function schemaVersion(db: DatabaseSync): number {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (version > SCHEMA_VERSION) throw new Error('数据库版本较新，请使用对应版本的 Namo');
  return version;
}

/** Writable connections only. Read the version again after locking: another process
 * may have completed the same upgrade while this connection was waiting. */
export function migrateSchema(db: DatabaseSync): void {
  const version = schemaVersion(db);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
  if (version === SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const lockedVersion = schemaVersion(db);
    for (const [target, apply] of migrations) {
      if (target <= lockedVersion) continue;
      apply(db);
      db.exec(`PRAGMA user_version=${target}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
