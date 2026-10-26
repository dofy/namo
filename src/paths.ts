import { t as tr } from './locale.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, openSync, closeSync, fsyncSync, unlinkSync, lstatSync, linkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

export function userHome(env = process.env, platform = process.platform): string {
  if (env.NAMO_HOME) return resolve(env.NAMO_HOME);
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Namo');
  if (platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Namo');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'namo');
}
export function configFile(explicit?: string, cwd = process.cwd(), env = process.env): string {
  if (explicit) return resolve(explicit);
  if (env.NAMO_CONFIG) return resolve(env.NAMO_CONFIG);
  const legacy = join(cwd, 'config.local.json');
  return existsSync(legacy) ? legacy : join(userHome(env), 'config.json');
}
export function readJson(file: string): any { return JSON.parse(readFileSync(file, 'utf8')); }
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function atomicJson(file: string, value: unknown, exclusive = false): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error(tr("拒绝覆盖符号链接配置，请指定真实配置文件"));
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    const fd = openSync(temp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    if (exclusive) linkSync(temp, file);
    else renameSync(temp, file);
    chmodSync(file, 0o600);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
export class ConfigEditor {
  private fingerprint?: string;
  private backedUp = false;
  value: any;
  constructor(readonly file: string) {
    if (existsSync(file)) { const s = readFileSync(file, 'utf8'); this.fingerprint = digest(s); this.value = JSON.parse(s); }
  }
  save(next: any): void {
    if (this.fingerprint !== undefined) {
      const current = readFileSync(this.file, 'utf8');
      if (digest(current) !== this.fingerprint) throw new Error(tr("配置被其他程序修改，请退出并重新运行 namo init"));
      if (JSON.stringify(this.value) === JSON.stringify(next)) return;
      if (!this.backedUp) {
        const configured = this.value?.dataDir ?? './data';
        const data = configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : resolve(dirname(this.file), configured);
        const backup = join(data, 'config-backups', `${Date.now()}-${randomUUID()}.json`);
        mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
        writeFileSync(backup, current, { mode: 0o600, flag: 'wx' }); this.backedUp = true;
      }
    }
    atomicJson(this.file, next, this.fingerprint === undefined);
    this.fingerprint = digest(readFileSync(this.file, 'utf8')); this.value = structuredClone(next);
  }
}
export function receiverDir(appId: string): string { return join(userHome(), 'receivers', digest(appId).slice(0, 24)); }
