import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.js';
import { SCHEMA_VERSION } from './store.js';

/** Check for idle and reserve maintenance in the same transaction as task claims. */
export function whileCliIdle<T>(config: Pick<Config, 'dataDir'>, run: (db?: DatabaseSync) => T): { busy: true } | { busy: false; value: T } {
  const file = join(config.dataDir, 'bot.sqlite');
  if (!existsSync(file)) return { busy: false, value: run() };
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) !== SCHEMA_VERSION) throw Error('update_database_incompatible');
    clearStaleCliMaintenance(db);
    const busy = [
      "SELECT 1 FROM inbox WHERE state IN ('queued','running','waiting','awaiting_reply') LIMIT 1",
      "SELECT 1 FROM runner_jobs WHERE state IN ('starting','running','lost') LIMIT 1",
      "SELECT 1 FROM memory_jobs WHERE state='running' LIMIT 1",
      "SELECT 1 FROM settings WHERE key='maintenance' LIMIT 1",
    ].some(sql => !!db.prepare(sql).get());
    if (busy) { db.exec('ROLLBACK'); return { busy: true }; }
    const value = run(db);
    db.exec('COMMIT');
    return { busy: false, value };
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}

export function processRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export function clearStaleCliMaintenance(db: DatabaseSync): void {
  const row = db.prepare("SELECT value FROM settings WHERE key='maintenance' AND value LIKE 'cli-update:%'").get();
  if (!row) return;
  const match = /^cli-update:(\d+):(\d+):[a-f0-9-]+$/.exec(String(row.value));
  if (!match) return;
  if (match.slice(1, 3).map(Number).some(pid => Number.isSafeInteger(pid) && pid > 0 && processRunning(pid))) return;
  db.prepare("DELETE FROM settings WHERE key='maintenance' AND value=?").run(String(row.value));
}

export function holdCliMaintenance(config: Pick<Config, 'dataDir'>) {
  const token = randomUUID(), file = join(config.dataDir, 'bot.sqlite');
  let value = `cli-update:${process.pid}:0:${token}`;
  const reservation = whileCliIdle(config, db => {
    // Keep a durable guard even when the configured receiver has never been started.
    if (!db) throw Error('update_database_unavailable');
    db.prepare("INSERT INTO settings VALUES('maintenance', ?)").run(value);
  });
  if (reservation.busy) return;
  const write = (run: (db: DatabaseSync) => void) => {
    const db = new DatabaseSync(file);
    try { db.exec('PRAGMA busy_timeout=5000'); run(db); }
    finally { db.close(); }
  };
  return {
    child(pid: number) {
      const next = `cli-update:${process.pid}:${pid}:${token}`;
      write(db => {
        const changed = db.prepare("UPDATE settings SET value=? WHERE key='maintenance' AND value=?").run(next, value);
        if (changed.changes !== 1) throw Error('update_queue_busy');
      });
      value = next;
    },
    release() { write(db => db.prepare("DELETE FROM settings WHERE key='maintenance' AND value=?").run(value)); },
  };
}
