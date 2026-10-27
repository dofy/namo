import type { DatabaseSync } from 'node:sqlite';
import { CORE_SCHEMA, BUSINESS_SCHEMA } from './schema.js';

export const SCHEMA_VERSION = 13;

export function assertSchemaVersion(version: number): void {
  if (version > SCHEMA_VERSION) throw new Error('数据库版本较新，请使用对应版本的 Namo');
  if (version !== SCHEMA_VERSION) throw new Error('数据库结构已重构，旧测试库不再支持；停止服务后备份并移走 bot.sqlite 及其 -wal/-shm 文件，再启动以创建新库。配置和 Codex 登录无需删除。');
}

/** Fresh development baseline. Never erase or silently reinterpret an existing database.
 * Future released schema changes belong here as explicit, transactional migrations. */
export function migrateSchema(db: DatabaseSync): void {
  const version = () => Number(db.prepare('PRAGMA user_version').get()?.user_version);
  const empty = () => !db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
  if (version() !== 0 || !empty()) assertSchemaVersion(version());
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
  if (version() === SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (version() === 0 && empty()) {
      db.exec(CORE_SCHEMA + BUSINESS_SCHEMA);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    } else assertSchemaVersion(version());
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
