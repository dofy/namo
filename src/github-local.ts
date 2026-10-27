import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

/** Explicit host login selection. Configuration never contains its credential. */
export interface LocalGhConfig { executable: string; configDir: string; login: string; userId: number }
export class LocalGhError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'LocalGhError'; }
}
export function parseLocalGh(value: unknown): LocalGhConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LocalGhError('github_local_invalid');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['executable','configDir','login','userId'].includes(k))
    || typeof v.login !== 'string' || !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(v.login)
    || !Number.isSafeInteger(v.userId) || Number(v.userId) < 1
    || [v.executable,v.configDir].some(p => typeof p !== 'string' || !isAbsolute(p) || /[\x00-\x1f\x7f]/.test(p)))
    throw new LocalGhError('github_local_invalid');
  return { executable: String(v.executable), configDir: String(v.configDir), login: v.login, userId: Number(v.userId) };
}

// Ambient tokens, debug flags, proxies and project config cannot override the
// selected login. This environment is never forwarded to the model.
export function localGhEnvironment(config: Pick<LocalGhConfig,'executable'|'configDir'>): NodeJS.ProcessEnv {
  return { HOME: homedir(), PATH: [dirname(config.executable),'/usr/bin','/bin'].join(delimiter),
    GH_CONFIG_DIR: config.configDir, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', NO_COLOR: '1', TERM: 'dumb' };
}
export type GhExecutor = (config: Pick<LocalGhConfig,'executable'|'configDir'>, args: readonly string[], deadlineMs: number) => Promise<string>;
export const executeGh: GhExecutor = (config, args, deadlineMs) => new Promise((resolveOutput, reject) => {
  const timeout = Math.min(15_000, deadlineMs - Date.now());
  if (timeout <= 0) { reject(new LocalGhError('github_local_timeout')); return; }
  execFile(config.executable, [...args], { env: localGhEnvironment(config), timeout, maxBuffer: 64_000,
    encoding: 'utf8', windowsHide: true, killSignal: 'SIGKILL' }, (error, stdout) => {
    // Child errors contain stderr/arguments: never return or log them.
    if (error) reject(new LocalGhError('github_local_unavailable'));
    else resolveOutput(stdout);
  });
});

export async function discoverLocalGh(executor: GhExecutor = executeGh): Promise<LocalGhConfig> {
  const executable = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(p => resolve(p, process.platform === 'win32' ? 'gh.exe' : 'gh'))
    .find(p => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } });
  if (!executable) throw new LocalGhError('github_local_missing');
  const configDir = resolve(process.env.GH_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(),'.config'),'gh'));
  const output = await executor({ executable, configDir }, ['api','--hostname','github.com','--method','GET','user','--jq','{login,id}'], Date.now()+15_000);
  try { const account = JSON.parse(output); return parseLocalGh({ executable, configDir, login: account.login, userId: account.id }); }
  catch { throw new LocalGhError('github_local_unavailable'); }
}

/** Captured in service memory only; never saved, logged, or sent to the model. */
export async function localGhToken(config: LocalGhConfig, deadlineMs: number, executor: GhExecutor = executeGh): Promise<string> {
  const selected = parseLocalGh(config);
  const result = (await executor(selected, ['auth','token','--hostname','github.com','--user',selected.login], deadlineMs)).trim();
  if (!/^[\x21-\x7e]{1,4096}$/.test(result)) throw new LocalGhError('github_local_unavailable');
  return result;
}
