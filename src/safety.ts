import { mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
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
export function acquireLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dir = join(dataDir, 'service.lock');
  try { mkdirSync(dir, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let pid: number;
    try { pid = Number(readFileSync(join(dir, 'pid'), 'utf8')); }
    catch { throw new Error('锁文件未完成写入；请确认旧服务已停止后手动清理 data/service.lock'); }
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('服务锁损坏，拒绝启动');
    try { process.kill(pid, 0); throw new Error('同一个 dataDir 已有服务运行'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
    unlinkSync(join(dir, 'pid'));
    // rmdir rather than recursive deletion: never delete unexpected user data.
    rmdirSync(dir);
    mkdirSync(dir, { mode: 0o700 });
  }
  writeFileSync(join(dir, 'pid'), String(process.pid), { mode: 0o600 });
  return () => { unlinkSync(join(dir, 'pid')); rmdirSync(dir); };
}
