import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson } from './paths.js';

export interface InstalledCodex { version: string; directory: string | null }
export interface CodexInstallation {
  format: 1; configuredBin: string; automatic: boolean;
  active: InstalledCodex | null; previous: InstalledCodex | null;
  latestVersion: string | null; checkedAt: number | null; attemptedAt: number | null;
  state: 'idle' | 'checking' | 'installing' | 'deferred' | 'failed';
  ownerPid: number | null; error: string | null;
}
export const installationRoot = (home: string) => join(home, 'namo-cli');
export function installationState(bin: string, home: string): CodexInstallation {
  const empty: CodexInstallation = { format: 1, configuredBin: bin, automatic: false, active: null, previous: null,
    latestVersion: null, checkedAt: null, attemptedAt: null, state: 'idle', ownerPid: null, error: null };
  const file = join(installationRoot(home), 'state.json');
  if (!existsSync(file)) return empty;
  try {
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw Error();
    const value = JSON.parse(readFileSync(file, 'utf8')) as CodexInstallation;
    if (value.configuredBin !== bin) return empty;
    const validRelease = (v: InstalledCodex | null) => v === null || v && typeof v.version === 'string'
      && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(v.version)
      && (v.directory === null || /^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9-]+$/.test(v.directory));
    if (value.format !== 1 || typeof value.automatic !== 'boolean' || !validRelease(value.active) || !validRelease(value.previous)
      || !['idle','checking','installing','deferred','failed'].includes(value.state)
      || ![value.checkedAt,value.attemptedAt].every(v=>v===null || Number.isSafeInteger(v) && v>=0)
      || value.latestVersion !== null && !/^\d+\.\d+\.\d+$/.test(value.latestVersion)
      || value.error !== null && !/^[a-z_]{1,80}$/.test(value.error)
      || value.ownerPid !== null && (!Number.isSafeInteger(value.ownerPid) || value.ownerPid<=0)) throw Error();
    if (value.ownerPid && ['checking','installing'].includes(value.state)) {
      try { process.kill(value.ownerPid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code==='ESRCH') return {...value,state:'failed',ownerPid:null,error:'update_interrupted'}; }
    }
    return value;
  } catch { throw new Error('update_state_invalid'); }
}
export function saveInstallation(home: string, state: CodexInstallation): void {
  atomicJson(join(installationRoot(home), 'state.json'), state);
}
export function installedBinary(home: string, release: InstalledCodex): string {
  if (!release.directory || !/^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9-]+$/.test(release.directory)) throw Error('update_state_invalid');
  const root = join(installationRoot(home), 'releases', release.directory);
  const binary = join(root, 'bin', 'codex');
  // A damaged managed installation fails closed, rather than silently selecting a different CLI.
  const canonicalRoot=join(realpathSync(join(installationRoot(home),'releases')),release.directory);
  if (realpathSync(root) !== canonicalRoot || !realpathSync(binary).startsWith(canonicalRoot + '/')) throw Error('update_state_invalid');
  return binary;
}
export function resolveCodexBinary(bin: string, home: string): string {
  const state = installationState(bin, home);
  return state.active?.directory ? installedBinary(home, state.active) : bin;
}
