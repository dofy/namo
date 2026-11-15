import { t as tr } from './locale.js';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const chatWorkspace = (dataDir: string, chatKey: string) => join(dataDir, 'workspaces', createHash('sha256').update(chatKey).digest('hex').slice(0, 24));

export function makeRedactor(values: string[] = []): (text: string) => string {
  const secrets = values.filter(x => x.length >= 6).sort((a, b) => b.length - a.length);
  return (text: string) => {
    for (const value of secrets) text = text.split(value).join('[REDACTED]');
    return text
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[REDACTED]');
  };
}

// Deliberately excludes Feishu credentials, third-party provider configuration,
// and inherited tool credentials. Codex uses its own isolated official login.
export function codexEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, CODEX_HOME: home };
}

// Atomic mkdir is the singleton lock. A stale PID is reclaimed only after ESRCH;
// unknown process state keeps the lock. There are no active leases to steal.
// Reclaim runs under a second mkdir guard and re-reads the PID inside it, so
// two starters that both saw the same dead PID cannot both win.
export function acquireLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dir = join(dataDir, 'service.lock');
  try { mkdirSync(dir, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = lockOwner(dir);
    const guard = `${dir}.reclaim`;
    try { mkdirSync(guard, { mode: 0o700 }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // A guard left by a crash is never removed automatically.
      let age = 0; try { age = Date.now() - statSync(guard).mtimeMs; } catch { /* Gone: another starter finished. */ }
      if (age > 60_000) throw new Error(tr("safety.lockReclaimInterrupted", guard));
      throw new Error(tr("safety.serviceAlreadyRunningDatadir"));
    }
    try {
      if (lockOwner(dir) !== pid) throw new Error(tr("safety.serviceAlreadyRunningDatadir"));
      unlinkSync(join(dir, 'pid'));
      // rmdir rather than recursive deletion: never delete unexpected user data.
      rmdirSync(dir);
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(join(dir, 'pid'), String(process.pid), { mode: 0o600 });
    } finally { rmdirSync(guard); }
    return () => { unlinkSync(join(dir, 'pid')); rmdirSync(dir); };
  }
  writeFileSync(join(dir, 'pid'), String(process.pid), { mode: 0o600 });
  return () => { unlinkSync(join(dir, 'pid')); rmdirSync(dir); };
}
/** Returns the dead PID recorded in a lock, or throws when the lock is live or unreadable. */
function lockOwner(dir: string): number {
  let pid: number;
  try { pid = Number(readFileSync(join(dir, 'pid'), 'utf8')); }
  catch { throw new Error(tr("safety.lockFileIncompleteConfirmOldServiceStopped")); }
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(tr("safety.invalidServiceLockRefusingStart"));
  try { process.kill(pid, 0); throw new Error(tr("safety.serviceAlreadyRunningDatadir")); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
  }
  return pid;
}
