import sqlite, { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
function syncFile(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function regular(path: string): void { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink()) throw new Error('backup_source_invalid'); }
/** Compare logical data, not SQLite page layout or WAL bytes. No row contents leave this function. */
export function databaseFingerprint(db: DatabaseSync): string {
  const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  const data = tables.map(table => {
    const stmt = db.prepare('SELECT * FROM ' + quote(String(table.name))); stmt.setReadBigInts(true);
    const rows = [...stmt.iterate()].map(row => hash(JSON.stringify(row, (_, v) => typeof v === 'bigint' ? { integer: v.toString() } : v))).sort();
    return { name: table.name, rows };
  });
  return hash(JSON.stringify({ version: db.prepare('PRAGMA user_version').get(), schema, data }));
}
function healthy(db: DatabaseSync): void {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('backup_database_invalid');
}
/** Must own the config lock and (except live-upgrade) receiver lock.
 * Live backups preserve a read snapshot and never restore over newer receipts.
 * Install requires an absent plist; upgrade requires an existing one. */
export async function createUpgradeBackup(c: Config, plist: string, operation: 'upgrade' | 'install' | 'live-upgrade' = 'upgrade'): Promise<string> {
  let directory: string | undefined;
  try {
    if (operation === 'install' && existsSync(plist)) throw new Error('backup_source_changed');
    const root = join(c.dataDir, 'backups');
    if (existsSync(root) && (lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory())) throw new Error('backup_directory_invalid');
    mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
    const id = `${operation}-${Date.now()}-${randomUUID()}`;
    directory = join(root, '.' + id + '.pending'); mkdirSync(directory, { mode: 0o700 });
    const sources = [ [c.file, 'config.json'], [plist, 'launch-agent.plist'],
      [join(c.dataDir, 'service.json'), 'service.json'], [join(c.dataDir, 'active-runtime.json'), 'active-runtime.json'], [join(c.dataDir, 'service-bootstrap.mjs'), 'service-bootstrap.mjs'] ];
    const files: { source: string; name: string; sha256: string }[] = [];
    for (const [source, name] of sources) {
      if (operation === 'install' && name === 'launch-agent.plist') continue;
      if (!existsSync(source) && name !== 'config.json' && name !== 'launch-agent.plist') continue;
      regular(source); const bytes = readFileSync(source), target = join(directory, name);
      writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' }); syncFile(target);
      if (hash(readFileSync(target)) !== hash(bytes)) throw new Error('backup_copy_mismatch');
      files.push({ source, name, sha256: hash(bytes) });
    }
    const database = join(c.dataDir, 'bot.sqlite'), present = existsSync(database);
    let fingerprint: string | undefined;
    if (present) {
      regular(database); if (statSync(database).size === 0) throw new Error('backup_database_empty');
      const source = new DatabaseSync(database, { readOnly: true });
      try {
        // A WAL read snapshot remains consistent while the receiver accepts new messages.
        if (operation === 'live-upgrade') source.exec('BEGIN');
        healthy(source); fingerprint = databaseFingerprint(source);
        const target = join(directory, 'bot.sqlite');
        await sqlite.backup(source, target); regular(target); chmodSync(target, 0o600);
        if (!statSync(target).size) throw new Error('backup_database_empty');
        const copy = new DatabaseSync(target, { readOnly: true });
        try { healthy(copy); if (databaseFingerprint(copy) !== fingerprint) throw new Error('backup_database_mismatch'); }
        finally { copy.close(); }
        if (databaseFingerprint(source) !== fingerprint) throw new Error('backup_source_changed');
        if (operation === 'live-upgrade') source.exec('COMMIT');
        syncFile(target);
      } finally { source.close(); }
    }
    for (const file of files) { regular(file.source); if (hash(readFileSync(file.source)) !== file.sha256) throw new Error('backup_source_changed'); }
    if (existsSync(database) !== present) throw new Error('backup_source_changed');
    if (operation === 'install' && existsSync(plist)) throw new Error('backup_source_changed');
    const manifest = join(directory, 'verified.json');
    writeFileSync(manifest, JSON.stringify({ format: 1, operation, verifiedAt: Date.now(), database: { present, fingerprint }, files }) + '\n', { mode: 0o600, flag: 'wx' });
    syncFile(manifest); syncFile(directory);
    const complete = join(root, id); renameSync(directory, complete); syncFile(root);
    return complete;
  } catch {
    // Retain partial evidence under .pending, but never issue a successful receipt.
    // Raw filesystem/SQLite errors and private paths must not enter CLI logs.
    throw new Error('upgrade_backup_failed');
  }
}
