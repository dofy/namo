import { readFileSync } from 'node:fs';
import type { Config } from './config.js';
import { digest } from './paths.js';
import { codexEnvironment } from './safety.js';

/** The host worker resolves service credentials; the model still gets codexEnvironment only. */
export function workerEnvironment(config: Config): NodeJS.ProcessEnv {
  const raw = JSON.parse(readFileSync(config.file, 'utf8'));
  const env = codexEnvironment(config.codex.home);
  for (const name of [raw.feishu?.appSecret ? undefined : raw.feishu?.appSecretEnv ?? 'FEISHU_APP_SECRET', config.github?.tokenEnv, raw.github?.tokenEnv]) {
    if (typeof name === 'string' && Object.hasOwn(process.env, name)) env[name] = process.env[name];
  }
  return env;
}

/** Only the parent-owned pipe is accepted; snapshots never enter argv, logs or persistent storage. */
export async function readWorkerSnapshot(): Promise<string> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk); bytes += buffer.length;
    if (bytes > 1_048_576) throw new Error('worker_snapshot_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Presentation and execution defaults are applied on restart. Revocation is immediate. */
export function authorizationRevision(c: Config): string {
  const { token: _token, tokenEnv: _env, ...github } = c.github ?? {};
  return digest(JSON.stringify({
    appId: c.feishu.appId, domain: c.feishu.domain, access: c.feishu.access,
    users: c.feishu.allowedUserIds, chats: c.feishu.allowedChatIds,
    projects: c.codex.projects, projectAccess: c.codex.projectAccess,
    sandbox: c.codex.sandbox, network: c.codex.networkAccess, commits: c.codex.allowLocalCommits,
    read: c.codex.readPaths, deny: c.codex.denyPaths, github,
  }));
}
