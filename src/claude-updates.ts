import { spawn } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { agentLabel, getAgentRegistry } from './agent-registry.js';
import { findClaudeBinary } from './agents.js';
import { claudeEnvironment, readClaudeCliVersion } from './claude-runtime.js';
import { holdCliMaintenance, processRunning, whileCliIdle } from './cli-maintenance.js';
import type { Config } from './config.js';
import { atomicJson, digest } from './paths.js';
import { acquireLock } from './safety.js';
import type { ClaudeUpdateStatus } from './ui-contract.js';
import { newerVersion } from './version.js';

const releaseVersion = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const DAY = 86_400_000, RETRY = 3_600_000;

export async function fetchLatestClaudeVersion(fetcher = fetch, channel: 'latest' | 'stable' = 'latest'): Promise<string> {
  const response = await fetcher(`https://downloads.claude.ai/claude-code-releases/${channel}`, {
    redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  if (!response.body) throw Error('update_check_failed');
  const reader = response.body.getReader();
  try {
    if (!response.ok) throw Error('update_check_failed');
    let body = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (body.length + value.byteLength > 32) throw Error('update_check_failed');
      body += Buffer.from(value).toString('utf8');
    }
    const version = body.trim();
    if (!releaseVersion.test(version)) throw Error('update_check_failed');
    return version;
  } finally { void reader.cancel().catch(() => {}); }
}

type UpdateRecord = {
  bin: string; automatic: boolean; latestVersion: string | null;
  checkedAt: number | null; lastAutoAt: number | null; failures: number;
  state: ClaudeUpdateStatus['state']; ownerPid: number | null; upgradingFrom: string | null;
};

function emptyRecord(bin: string): UpdateRecord {
  return { bin, automatic: false, latestVersion: null, checkedAt: null, lastAutoAt: null,
    failures: 0, state: 'idle', ownerPid: null, upgradingFrom: null };
}

const stateFile = (config: Config) => join(config.dataDir, 'claude-cli-update.json');

function readRecord(config: Config): UpdateRecord | undefined {
  try {
    const file = stateFile(config);
    if (!lstatSync(file).isFile()) throw Error();
    const state = JSON.parse(readFileSync(file, 'utf8')) as UpdateRecord;
    if (typeof state.bin !== 'string' || typeof state.automatic !== 'boolean'
      || !['idle', 'deferred', 'updating', 'updated', 'unchanged', 'failed'].includes(state.state)
      || ![state.checkedAt, state.lastAutoAt].every(value => value === null || Number.isSafeInteger(value) && value > 0)
      || ![state.latestVersion, state.upgradingFrom].every(value => value === null || typeof value === 'string' && releaseVersion.test(value))
      || !Number.isInteger(state.failures) || state.failures < 0 || state.failures > 5
      || state.ownerPid !== null && (!Number.isSafeInteger(state.ownerPid) || state.ownerPid < 1)
      || state.state === 'updating' && (!state.ownerPid || !state.upgradingFrom)) throw Error();
    if (state.ownerPid && !processRunning(state.ownerPid)) return { ...state, state: 'failed', ownerPid: null, upgradingFrom: null,
      failures: Math.min(state.failures + 1, 5) };
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw Error('update_state_invalid');
  }
}

export class ClaudeUpdates {
  private operation?: Promise<void>;
  private closed = false;

  constructor(private readonly hostHome = homedir(), private readonly latest = fetchLatestClaudeVersion,
    private readonly stable = () => fetchLatestClaudeVersion(fetch, 'stable'), private readonly now = Date.now) {}

  private targets(config: Config) {
    const profiles = getAgentRegistry(config).profiles.filter(profile => profile.adapter === 'claude');
    const configured = profiles.length
      ? profiles.map(profile => ({ profileId: profile.id, label: agentLabel(profile), bin: profile.bin, home: profile.home }))
      : [{ profileId: null, label: 'Claude Code', bin: 'claude', home: join(config.dataDir, 'agents', 'claude') }];
    const seen = new Set<string>();
    return configured.flatMap(target => {
      const executable = findClaudeBinary(target.bin, this.hostHome);
      const path = executable ? resolve(executable) : null;
      const key = path ?? target.bin;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ ...target, path }];
    });
  }

  private nativeLauncher(path: string, version: string): boolean {
    if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) return false;
    const local = join(this.hostHome, '.local');
    const launcher = join(local, 'bin', 'claude');
    try {
      // A copy or a launcher pinned to a particular version would not follow the native update.
      return basename(path) === 'claude' && realpathSync(dirname(launcher)) === realpathSync(dirname(path))
        && lstatSync(path).isSymbolicLink()
        && realpathSync(path) === join(realpathSync(join(local, 'share', 'claude', 'versions')), version);
    } catch { return false; }
  }

  async status(config: Config): Promise<ClaudeUpdateStatus[]> {
    const saved = readRecord(config);
    return Promise.all(this.targets(config).map(async ({ profileId, label, bin, path, home }) => {
      const record = saved?.bin === bin ? saved : undefined;
      const updating = record?.state === 'updating';
      const version = updating ? record.upgradingFrom : path ? await readClaudeCliVersion(path, home).catch(() => undefined) : undefined;
      const updateSupported = updating || !!(path && version && this.nativeLauncher(path, version));
      return { profileId, label, currentVersion: version ?? null, updateSupported, state: record?.state ?? 'idle',
        latestVersion: record?.latestVersion ?? null, checkedAt: record?.checkedAt ?? null, automatic: record?.automatic ?? false,
        updateAvailable: !!(updateSupported && record?.latestVersion && version && newerVersion(record.latestVersion, version)) };
    }));
  }

  private unchanged(config: Config, revision: string): void {
    if (this.closed) throw Error('update_cancelled');
    if (digest(readFileSync(config.file, 'utf8')) !== revision) throw Error('update_config_changed');
  }

  private lock(): () => void {
    try { return acquireLock(join(this.hostHome, '.local', 'share', 'claude', 'namo-update')); }
    catch { throw Error('update_busy'); }
  }

  async action(action: 'check' | 'upgrade' | 'automatic', config: Config, profileId: string | null, revision: string, enabled?: boolean): Promise<ClaudeUpdateStatus[]> {
    this.unchanged(config, revision);
    const target = this.targets(config).find(item => item.profileId === profileId);
    if (!target) throw Error('update_cli_unavailable');
    if (action === 'automatic' && typeof enabled !== 'boolean') throw Error('update_action_invalid');
    const unlock = this.lock();
    let started = false;
    try {
      const saved = readRecord(config);
      const state = saved?.bin === target.bin ? saved : emptyRecord(target.bin);
      if (state.state === 'updating') throw Error('update_busy');
      if (action === 'automatic' && !enabled) {
        if (saved?.bin === target.bin)
          atomicJson(stateFile(config), { ...state, automatic: false, state: 'idle', lastAutoAt: null, failures: 0 });
        return this.status(config);
      }
      const path = target.path;
      if (!path) throw Error('update_cli_unavailable');
      const version = await readClaudeCliVersion(path, target.home).catch(() => undefined);
      this.unchanged(config, revision);
      if (!version || !this.nativeLauncher(path, version)) throw Error('update_cli_unavailable');
      if (action === 'automatic') {
        atomicJson(stateFile(config), { ...state, automatic: true, state: 'idle', lastAutoAt: null, failures: 0 });
      } else if (action === 'check') {
        const latestVersion = await this.latest().catch(() => { throw Error('update_check_failed'); });
        this.unchanged(config, revision);
        atomicJson(stateFile(config), { ...state, latestVersion, checkedAt: this.now(), state: state.state === 'deferred' ? 'deferred' : 'idle' });
      } else if (!state.latestVersion || newerVersion(state.latestVersion, version)) {
        started = this.startUpgrade(config, revision, path, target.home, version, state, unlock, false);
        if (!started) throw Error('update_queue_busy');
      }
      return this.status(config);
    } finally { if (!started) unlock(); }
  }

  async tick(config: Config, revision: string): Promise<void> {
    const initial = readRecord(config);
    if (!initial?.automatic || initial.state === 'updating' || initial.failures >= 5) return;
    if (initial.state !== 'deferred' && initial.lastAutoAt !== null
      && this.now() - initial.lastAutoAt < (initial.failures ? RETRY * 2 ** (initial.failures - 1) : DAY)) return;
    this.unchanged(config, revision);
    const target = this.targets(config).find(item => item.bin === initial.bin);
    if (!target?.path) return;
    const path = target.path, unlock = this.lock();
    let started = false;
    try {
      const state = readRecord(config);
      if (!state?.automatic || state.bin !== initial.bin || state.state === 'updating'
        || state.lastAutoAt !== initial.lastAutoAt || state.state !== initial.state) return;
      const version = await readClaudeCliVersion(path, target.home).catch(() => undefined);
      this.unchanged(config, revision);
      if (!version || !this.nativeLauncher(path, version)) return;
      if (state.state === 'deferred' && whileCliIdle(config, () => {}).busy) return;
      const release = await Promise.all([this.latest(), this.stable()]).catch(() => undefined);
      this.unchanged(config, revision);
      if (!release) {
        atomicJson(stateFile(config), { ...state, state: 'failed', lastAutoAt: this.now(), failures: state.failures + 1 });
        return;
      }
      const now = this.now(), [latestVersion, stableVersion] = release;
      const next = { ...state, latestVersion, checkedAt: now, lastAutoAt: now };
      // The native updater follows the host channel. Both channels must be
      // ahead of the installed version before we run it automatically.
      if (!newerVersion(stableVersion, version) || !newerVersion(latestVersion, version)) {
        atomicJson(stateFile(config), { ...next, state: 'idle', failures: 0 });
        return;
      }
      started = this.startUpgrade(config, revision, path, target.home, version, next, unlock, true);
      if (!started) atomicJson(stateFile(config), { ...next, state: 'deferred' });
    } finally { if (!started) unlock(); }
  }

  private startUpgrade(config: Config, revision: string, path: string, home: string, version: string, state: UpdateRecord,
    unlock: () => void, automatic: boolean): boolean {
    const maintenance = holdCliMaintenance(config);
    if (!maintenance) return false;
    try {
      this.unchanged(config, revision);
      atomicJson(stateFile(config), { ...state, state: 'updating', ownerPid: process.pid, upgradingFrom: version });
      this.operation = this.run(path, maintenance.child).then(async () => {
        const next = await readClaudeCliVersion(path, home);
        if (!next || !this.nativeLauncher(path, next) || automatic && newerVersion(version, next)) throw Error();
        atomicJson(stateFile(config), { ...state, state: next === version ? 'unchanged' : 'updated',
          ownerPid: null, upgradingFrom: null, failures: 0 });
      }).catch(() => {
        atomicJson(stateFile(config), { ...state, state: 'failed', ownerPid: null, upgradingFrom: null,
          failures: automatic ? Math.min(state.failures + 1, 5) : state.failures });
      }).finally(() => {
        this.operation = undefined;
        try { maintenance.release(); } finally { unlock(); }
      });
      void this.operation.catch(() => {});
      return true;
    } catch (error) { maintenance.release(); throw error; }
  }

  private run(path: string, recordPid: (pid: number) => void): Promise<void> {
    return new Promise((done, fail) => {
      // Native updating uses the host user's launcher and release channel.
      // Keep Namo's isolated bot configuration and gateway credentials out of this process.
      const child = spawn(path, ['update'], { cwd: this.hostHome, env: claudeEnvironment(this.hostHome), stdio: 'ignore', detached: true });
      const kill = () => {
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
        }
      };
      const timeout = setTimeout(kill, 120_000);
      let recorded = false;
      child.once('error', () => { clearTimeout(timeout); fail(Error('update_failed')); });
      child.once('close', code => { clearTimeout(timeout); if (recorded && code === 0) done(); else fail(Error('update_failed')); });
      if (child.pid) {
        try { recordPid(child.pid); recorded = true; } catch { kill(); }
      }
    });
  }

  async settled(): Promise<void> { await this.operation; }
  async close(): Promise<void> { this.closed = true; await this.settled(); }
}
