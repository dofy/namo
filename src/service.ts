import { t as tr } from './locale.js';
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import { validateFeishu } from './config.js';
import { digest, readJson, atomicJson } from './paths.js';
import { probeAgent } from './agents.js';
import { createRuntimeRelease, sourcePackageRoot, verifyRuntimeRelease, type RuntimeRelease } from './release.js';
import { SCHEMA_VERSION } from './store.js';
import { createUpgradeBackup } from './upgrade-backup.js';
import { acquireLock } from './safety.js';

const legacyLabel = 'local.feishu-codex-bot';
const plistFile = (label: string) => join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const domain = () => `gui/${process.getuid!()}`;
interface RegisteredService {
  format: 2; label: string; config: string; node: string; path: string;
  release: RuntimeRelease;
}
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function serviceRecord(c: Config): any | undefined {
  try { return readJson(join(c.dataDir, 'service.json')); } catch { return; }
}
function registeredService(c: Config): RegisteredService {
  const value = serviceRecord(c);
  if (value?.format !== 2 || !/^(local\.feishu-codex-bot|io\.namo\.[a-f0-9]{12})$/.test(value.label)
    || value.config !== c.file || typeof value.node !== 'string' || typeof value.path !== 'string'
    || !value.release || typeof value.release.id !== 'string' || typeof value.release.root !== 'string'
    || typeof value.release.entry !== 'string' || typeof value.release.worker !== 'string' || typeof value.release.manifest !== 'string') {
    throw new Error(tr("service.serviceNotPinnedVerifiableReleaseStopRun"));
  }
  return value as RegisteredService;
}
export function verifyServiceRegistration(c: Config, plist: string): RegisteredService {
  try {
    const record = registeredService(c);
    const expectedRoot = join(c.dataDir, 'releases', record.release.id);
    if (realpathSync(record.release.root) !== realpathSync(expectedRoot)
      || record.release.entry !== join(record.release.root, 'dist/src/cli.js')
      || record.release.worker !== join(record.release.root, 'dist/src/runner-worker.js')
      || record.release.manifest !== join(record.release.root, 'release-manifest.json')) throw new Error('path');
    const manifest = verifyRuntimeRelease(record.release.root, record.release.id);
    const bootstrap = join(c.dataDir, 'service-bootstrap.mjs');
    if (lstatSync(bootstrap).isSymbolicLink() || createHash('sha256').update(readFileSync(bootstrap)).digest('hex')
      !== manifest.files.find(file => file.path === 'dist/src/service-bootstrap.js')?.sha256) throw new Error('bootstrap');
    const installed = readFileSync(plist, 'utf8');
    if (installed !== renderLaunchAgent(c, record.label, record.release.entry, record.node, record.path, record.release)) throw new Error('plist');
    return record;
  } catch { throw new Error(tr("service.invalidServiceRegistrationReleaseSnapshotKeepStopped")); }
}
function normalizedPath(): string {
  return [...new Set((process.env.PATH ?? '').split(':').filter(Boolean).map(p => { try { return realpathSync(p); } catch { return p; } }))].join(':');
}
function registration(c: Config, label: string, release: RuntimeRelease): RegisteredService {
  return { format: 2, label, config: c.file, node: realpathSync(process.execPath), path: normalizedPath(), release };
}
function replacePlist(file: string, content: string, mode = 0o600): void {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error(tr("service.refusingOverwriteSymlinkServiceFile"));
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, { mode, flag: 'wx' });
    const fd = openSync(temp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
  }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } }
export function activeData(data: string): boolean {
  try { const pid = Number(readFileSync(join(data, 'service.lock', 'pid'), 'utf8')); return Number.isSafeInteger(pid) && pid > 0 && processAlive(pid); }
  catch { return false; }
}
export function assertNoLegacyReceiver(appId: string): void {
  if (process.platform !== 'darwin' || !existsSync(plistFile(legacyLabel))) return;
  const state = spawnSync('launchctl', ['print', `${domain()}/${legacyLabel}`], { encoding: 'utf8', timeout: 3000 });
  const pid = Number(state.stdout?.match(/^\s*pid = (\d+)\s*$/m)?.[1]);
  if (!pid || pid === process.pid || !processAlive(pid)) return;
  const p = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :ProgramArguments:4', plistFile(legacyLabel)], { encoding: 'utf8', timeout: 3000 });
  let same = false;
  try { same = readJson(p.stdout.trim()).feishu?.appId === appId; } catch { /* Unknown registrations are not altered. */ }
  if (same) throw new Error(tr("service.olderNamoReceiverRunningFeishuAppStop"));
}
export function serviceLabel(c: Config): string {
  const saved = join(c.dataDir, 'service.json');
  if (existsSync(saved)) {
    const s = readJson(saved);
    if (/^(local\.feishu-codex-bot|io\.namo\.[a-f0-9]{12})$/.test(s.label)) return s.label;
    throw new Error(tr("service.invalidServiceMetadataCheckDataServiceJson"));
  }
  if (process.platform === 'darwin' && existsSync(plistFile(legacyLabel))) {
    // Read only the registered config path, never the environment or secrets.
    const r = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :ProgramArguments', plistFile(legacyLabel)], { encoding: 'utf8', timeout: 3000 });
    if (r.status === 0 && r.stdout.split('\n').some(l => l.trim() === c.file)) return legacyLabel;
  }
  return `io.namo.${digest(c.file).slice(0, 12)}`;
}
export function renderLaunchAgent(c: Config, label: string, cli: string, node: string, path: string, release?: RuntimeRelease): string {
  const args = release ? [node, join(c.dataDir, 'service-bootstrap.mjs'), release.root, release.id, c.file]
    : [node, cli, 'start', '--config', c.file];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(s => `<string>${xml(s)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(dirname(c.file))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string><key>HOME</key><string>${xml(homedir())}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer><key>ExitTimeOut</key><integer>90</integer>
<key>StandardOutPath</key><string>${xml(join(c.dataDir, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(c.dataDir, 'service.error.log'))}</string>
</dict></plist>`;
}
export function releaseUpgradeBlockers(database: string): string[] {
  if (!existsSync(database)) return [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(database, { readOnly: true });
    const schema = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    const compatible = schema === SCHEMA_VERSION;
    if (!compatible) return ['database-schema'];
    const checks: [string, string][] = [
      ['receiver-queue', "SELECT 1 FROM inbox WHERE state IN ('queued','running','waiting','awaiting_reply') LIMIT 1"],
      ['runner', "SELECT 1 FROM runner_jobs WHERE state IN ('starting','running','lost') LIMIT 1"],
      ['wait', "SELECT 1 FROM task_waits WHERE state IN ('requested','open') LIMIT 1"],
      ['outbox', "SELECT 1 FROM outbox WHERE state IN ('pending','sending','deferred') LIMIT 1"],
      ['maintenance', "SELECT 1 FROM settings WHERE key='maintenance' LIMIT 1"],
    ];
    return checks.filter(([, query]) => db!.prepare(query).get()).map(([name]) => name);
  } catch { return ['database-unreadable']; }
  finally { db?.close(); }
}
export function serviceStatus(c: Config, verifyRelease = false): Record<string, unknown> {
  const label = serviceLabel(c);
  let registered = false, pid: number | undefined;
  if (process.platform === 'darwin') {
    const r = spawnSync('launchctl', ['print', `${domain()}/${label}`], { encoding: 'utf8', timeout: 5000 });
    registered = r.status === 0;
    const m = r.stdout?.match(/^\s*pid = (\d+)\s*$/m); if (m) pid = Number(m[1]);
  }
  if (!pid) {
    try { const candidate = Number(readFileSync(join(c.dataDir, 'service.lock', 'pid'), 'utf8')); if (Number.isSafeInteger(candidate) && candidate > 0 && processAlive(candidate)) pid = candidate; }
    catch { /* No foreground owner. */ }
  }
  let health: any;
  try { health = readJson(join(c.dataDir, 'health.json')); } catch { /* Old versions do not write health. */ }
  const live = !!pid && processAlive(pid);
  let installedRelease: string | undefined, releaseVerified: boolean | undefined;
  const saved = serviceRecord(c);
  if (saved?.format === 2 && typeof saved.release?.id === 'string' && /^[a-f0-9]{64}$/.test(saved.release.id)) {
    const releaseId = saved.release.id;
    installedRelease = releaseId;
    if (verifyRelease) {
      try {
        if (realpathSync(saved.release.root) !== realpathSync(join(c.dataDir, 'releases', releaseId))) throw new Error('path');
        verifyRuntimeRelease(saved.release.root, releaseId); releaseVerified = true;
      } catch { releaseVerified = false; }
    }
  }
  const runningRelease = live && health?.pid === pid && typeof health.releaseId === 'string' ? health.releaseId : undefined;
  return { platform: process.platform, supported: process.platform === 'darwin', label, installed: existsSync(plistFile(label)), registered,
    running: live, mode: registered ? 'background' : live ? 'foreground' : 'stopped', pid, connection: live && health?.pid === pid ? health.connection : 'unknown',
    ready: live && health?.pid === pid && health.ready === true, config: c.file,
    release: { installed: installedRelease, running: runningRelease, verified: releaseVerified,
      matches: installedRelease && runningRelease ? installedRelease === runningRelease : undefined } };
}
export async function serviceAction(action: string, c: Config): Promise<Record<string, unknown>> {
  if (action === 'status') return serviceStatus(c, true);
  if (process.platform !== 'darwin') throw new Error(tr("service.backgroundServiceManagementCurrentlySupportsMacosUse"));
  const label = serviceLabel(c), plist = plistFile(label), target = `${domain()}/${label}`;
  let upgradeBackup: string | undefined;
  const finishAction = acquireLock(join(c.dataDir, 'service-action.lock'));
  try {
  if (action === 'install') {
    validateFeishu(c);
    if (existsSync(plist)) throw new Error(tr("service.serviceAlreadyInstalledUseNamoServiceRestart"));
    if (activeData(c.dataDir)) throw new Error(tr("service.foregroundBackgroundInstanceAlreadyUsingConfigurationStop"));
    mkdirSync(c.dataDir, { recursive: true, mode: 0o700 }); mkdirSync(dirname(plist), { recursive: true });
    const finishConfig = acquireLock(join(c.dataDir, 'config-edit.lock'));
    try {
      const finishInstall = acquireLock(c.dataDir);
      try {
        if (existsSync(plist) || serviceStatus(c, false).registered) throw new Error(tr("service.serviceInstallationStateChangedNoSecondReceiver"));
        const blockers = releaseUpgradeBlockers(join(c.dataDir, 'bot.sqlite'));
        if (blockers.length) throw new Error(tr("service.unsettledDataStateServiceNotInstalled", blockers.join(', ')));
        if ((await probeAgent(c)).some(x => x.status === 'fail')) throw new Error(tr("service.agentNotReadyRunNamoDoctorNamo"));
        // Uninstall removes only the plist. Reinstalling or adopting foreground
        // data must not bypass the verified backup required by upgrade.
        if (['bot.sqlite', 'service.json', 'service-bootstrap.mjs'].some(name => existsSync(join(c.dataDir, name)))) {
          upgradeBackup = await createUpgradeBackup(c, plist, 'install');
        }
        if (existsSync(plist) || serviceStatus(c, false).registered || releaseUpgradeBlockers(join(c.dataDir, 'bot.sqlite')).length) throw new Error('install_state_changed');
        const release = createRuntimeRelease(sourcePackageRoot(import.meta.url), join(c.dataDir, 'releases'));
        const record = registration(c, label, release);
        replacePlist(join(c.dataDir, 'service-bootstrap.mjs'), readFileSync(join(release.root, 'dist/src/service-bootstrap.js'), 'utf8'), 0o400);
        writeFileSync(plist, renderLaunchAgent(c, label, release.entry, record.node, record.path, release), { mode: 0o600, flag: 'wx' });
        try { atomicJson(join(c.dataDir, 'service.json'), record); }
        catch (error) { unlinkSync(plist); throw error; }
      } finally { finishInstall(); }
    } finally { finishConfig(); }
    const r = spawnSync('launchctl', ['bootstrap', domain(), plist], { stdio: 'pipe', timeout: 10000 });
    // A timeout or failed command receipt does not prove launchd rejected the
    // registration. Keep both files so status/stop/start can reconcile it without
    // guessing or launching a second receiver.
    if (r.status !== 0) throw new Error(tr("service.launchdStartOutcomeUnconfirmedServiceRegistrationWas"));
  } else if (action === 'upgrade') {
    if (!existsSync(plist)) throw new Error(tr("service.installFirst"));
    const finishUpgrade = acquireLock(join(c.dataDir, 'config-edit.lock'));
    try {
      const state = serviceStatus(c, false);
      if (state.registered || activeData(c.dataDir)) throw new Error(tr("service.safeUpgradeRequiresStoppedServiceRunNamo"));
      const finishReceiver = acquireLock(c.dataDir);
      try {
        if (serviceStatus(c, false).registered) throw new Error(tr("service.serviceStopStateChangedReleaseNotSwitched"));
        const blockers = releaseUpgradeBlockers(join(c.dataDir, 'bot.sqlite'));
        if (blockers.length) throw new Error(tr("service.unsettledStateReleaseNotSwitched", blockers.join(', ')));
        upgradeBackup = await createUpgradeBackup(c, plist);
        if (serviceStatus(c, false).registered || releaseUpgradeBlockers(join(c.dataDir, 'bot.sqlite')).length) throw new Error('upgrade_state_changed');
        const release = createRuntimeRelease(sourcePackageRoot(import.meta.url), join(c.dataDir, 'releases'));
        if (serviceStatus(c, false).registered) throw new Error(tr("service.serviceStopStateChangedReleaseNotSwitched"));
        const record = registration(c, label, release);
        replacePlist(join(c.dataDir, 'service-bootstrap.mjs'), readFileSync(join(release.root, 'dist/src/service-bootstrap.js'), 'utf8'), 0o400);
        atomicJson(join(c.dataDir, 'service.json'), record);
        replacePlist(plist, renderLaunchAgent(c, label, release.entry, record.node, record.path, release));
      } finally { finishReceiver(); }
    } finally { finishUpgrade(); }
  } else if (['stop', 'uninstall', 'restart', 'start'].includes(action)) {
    if (!existsSync(plist)) throw new Error(tr("service.notInstalled"));
    if (action === 'start' || action === 'restart') verifyServiceRegistration(c, plist);
    if (action !== 'start') {
      const state = serviceStatus(c, false);
      if (state.registered) {
        const r = spawnSync('launchctl', ['bootout', target], { stdio: 'pipe', timeout: 10000 });
        if (r.status !== 0) throw new Error(tr("service.serviceStopFailedInstallationFilesWereNot"));
        const end = Date.now() + 30_000;
        while ((serviceStatus(c, false).registered || activeData(c.dataDir)) && Date.now() < end) await new Promise(r => setTimeout(r, 200));
        if (serviceStatus(c, false).registered || activeData(c.dataDir)) throw new Error(tr("service.serviceStillStoppingRunNamoServiceStatus"));
      }
    }
    if (action === 'uninstall') unlinkSync(plist);
    if (action === 'start' || action === 'restart') {
      if (serviceStatus(c, false).registered) throw new Error(tr("service.serviceAlreadyStarted"));
      if (activeData(c.dataDir)) throw new Error(tr("service.foregroundStoppingInstanceStillUsesConfigurationWait"));
      const r = spawnSync('launchctl', ['bootstrap', domain(), plist], { stdio: 'pipe', timeout: 10000 });
      if (r.status !== 0) throw new Error(tr("service.serviceStartFailedRunNamoDoctorCheck"));
    }
  } else throw new Error(tr("service.serviceCommandsInstallStatusStartStopRestart"));
  return { ...serviceStatus(c, true), ...(upgradeBackup ? { backup: { path: upgradeBackup, verified: true } } : {}) };
  } finally { finishAction(); }
}
export async function waitForService(c: Config, timeout = 90_000): Promise<boolean> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (serviceStatus(c, false).ready) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
