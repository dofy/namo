import type { DatabaseSync } from 'node:sqlite';
import { migrateDirectorySchema } from './schema-directory-migration.js';
import { CORE_SCHEMA, BUSINESS_SCHEMA } from './schema.js';

export const SCHEMA_VERSION = 16;

export function assertSchemaVersion(version: number): void {
  if (version > SCHEMA_VERSION) throw new Error('数据库版本较新，请使用对应版本的 Namo');
  if (version !== SCHEMA_VERSION) throw new Error('数据库结构已重构，旧测试库不再支持；停止服务后备份并移走 bot.sqlite 及其 -wal/-shm 文件，再启动以创建新库。配置和 Codex 登录无需删除。');
}

/** Fresh development baseline. Never erase or silently reinterpret an existing database.
 * Future released schema changes belong here as explicit, transactional migrations. */
export function migrateSchema(db: DatabaseSync): void {
  const version = () => Number(db.prepare('PRAGMA user_version').get()?.user_version);
  const empty = () => !db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
  if (![13,14,15].includes(version()) && (version() !== 0 || !empty())) assertSchemaVersion(version());
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
  if (version() === SCHEMA_VERSION) return;
  // Rebuilding CHECK constraints requires foreign keys off outside the transaction.
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
    if (version() === 0 && empty()) {
      db.exec(CORE_SCHEMA + BUSINESS_SCHEMA);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    } else if (version() === 13) {
      db.exec(`CREATE TABLE schedules (
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, chatKey TEXT NOT NULL, scopeKey TEXT NOT NULL,
        sourceKey TEXT NOT NULL REFERENCES inbox(key), kind TEXT NOT NULL, content TEXT NOT NULL,
        intervalMs INTEGER, nextAt INTEGER NOT NULL, state TEXT NOT NULL, binding TEXT,
        createdAt INTEGER NOT NULL
      ); CREATE INDEX schedules_due ON schedules(state,nextAt); PRAGMA user_version=14`);
    } else if(![14,15].includes(version()))assertSchemaVersion(version());
    if(version()===14)db.exec(`CREATE TABLE task_directories (
      taskId TEXT NOT NULL REFERENCES tasks(id), path TEXT NOT NULL, PRIMARY KEY(taskId,path)
    ) STRICT; INSERT INTO task_directories(taskId,path) SELECT id,cwd FROM tasks; PRAGMA user_version=15`);
    if(version()===15)migrateDirectorySchema(db);
    if(db.prepare('PRAGMA foreign_key_check').get())throw Error('migration_foreign_key_violation');
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {db.exec('PRAGMA foreign_keys=ON');}
}
