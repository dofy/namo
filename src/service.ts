import { existsSync, readFileSync, realpathSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { Config } from './config.js';
import { validateFeishu } from './config.js';
import { digest, readJson, atomicJson } from './paths.js';
import { probeAgent } from './agents.js';

const legacyLabel = 'local.feishu-codex-bot';
const plistFile = (label: string) => join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const domain = () => `gui/${process.getuid!()}`;
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
  if (same) throw new Error('同一飞书应用已有旧 Namo 接收端运行。请先停止它；初始化没有启动第二个连接或修改旧服务');
}
export function serviceLabel(c: Config): string {
  const saved = join(c.dataDir, 'service.json');
  if (existsSync(saved)) {
    const s = readJson(saved);
    if (/^(local\.feishu-codex-bot|io\.namo\.[a-f0-9]{12})$/.test(s.label)) return s.label;
    throw new Error('服务元数据无效，请检查 data/service.json');
  }
  if (process.platform === 'darwin' && existsSync(plistFile(legacyLabel))) {
    // Read only the registered config path, never the environment or secrets.
    const r = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :ProgramArguments', plistFile(legacyLabel)], { encoding: 'utf8', timeout: 3000 });
    if (r.status === 0 && r.stdout.split('\n').some(l => l.trim() === c.file)) return legacyLabel;
  }
  return `io.namo.${digest(c.file).slice(0, 12)}`;
}
export function renderLaunchAgent(c: Config, label: string, cli: string, node: string, path: string): string {
  const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const args = [node, cli, 'start', '--config', c.file];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(s => `<string>${x(s)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${x(dirname(c.file))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${x(path)}</string><key>HOME</key><string>${x(homedir())}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer><key>ExitTimeOut</key><integer>90</integer>
<key>StandardOutPath</key><string>${x(join(c.dataDir, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${x(join(c.dataDir, 'service.error.log'))}</string>
</dict></plist>`;
}
export function serviceStatus(c: Config): Record<string, unknown> {
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
  return { platform: process.platform, supported: process.platform === 'darwin', label, installed: existsSync(plistFile(label)), registered,
    running: live, mode: registered ? 'background' : live ? 'foreground' : 'stopped', pid, connection: live && health?.pid === pid ? health.connection : 'unknown',
    ready: live && health?.pid === pid && health.ready === true, config: c.file };
}
export async function serviceAction(action: string, c: Config): Promise<Record<string, unknown>> {
  if (action === 'status') return serviceStatus(c);
  if (process.platform !== 'darwin') throw new Error('首版后台服务管理仅支持 macOS；此平台请使用 namo start 前台运行或自行配置系统服务');
  const label = serviceLabel(c), plist = plistFile(label), target = `${domain()}/${label}`;
  const cli = realpathSync(fileURLToPath(new URL('./cli.js', import.meta.url)));
  if (action === 'install') {
    validateFeishu(c);
    if ((await probeAgent(c)).some(x => x.status === 'fail')) throw new Error('Agent 尚未就绪，请先运行 namo doctor 和 namo login');
    if (/\/(?:_npx|dlx)\//.test(cli)) throw new Error('后台服务不能绑定 npx/dlx 临时缓存。请先持久安装 Namo，再运行 namo service install');
    if (existsSync(plist)) throw new Error('服务已安装；使用 namo service restart，或先 uninstall 后重新安装');
    if (activeData(c.dataDir)) throw new Error('当前配置已有前台或后台实例，请先停止它');
    mkdirSync(c.dataDir, { recursive: true, mode: 0o700 }); mkdirSync(dirname(plist), { recursive: true });
    const path = [...new Set((process.env.PATH ?? '').split(':').filter(Boolean).map(p => { try { return realpathSync(p); } catch { return p; } }))].join(':');
    writeFileSync(plist, renderLaunchAgent(c, label, cli, realpathSync(process.execPath), path), { mode: 0o600, flag: 'wx' });
    const r = spawnSync('launchctl', ['bootstrap', domain(), plist], { stdio: 'pipe', timeout: 10000 });
    if (r.status !== 0) { unlinkSync(plist); throw new Error('launchd 安装失败，请确认处于 macOS 桌面登录会话'); }
    atomicJson(join(c.dataDir, 'service.json'), { label, cli, config: c.file });
  } else if (['stop', 'uninstall', 'restart', 'start'].includes(action)) {
    if (!existsSync(plist)) throw new Error('服务未安装，请运行 namo service install');
    atomicJson(join(c.dataDir, 'service.json'), { label, cli, config: c.file });
    if (action !== 'start') {
      const state = serviceStatus(c);
      if (state.registered) {
        const r = spawnSync('launchctl', ['bootout', target], { stdio: 'pipe', timeout: 10000 });
        if (r.status !== 0) throw new Error('服务停止失败，未修改安装文件');
        const end = Date.now() + 30_000;
        while ((serviceStatus(c).registered || activeData(c.dataDir)) && Date.now() < end) await new Promise(r => setTimeout(r, 200));
        if (serviceStatus(c).registered || activeData(c.dataDir)) throw new Error('服务仍在停止中，稍后运行 namo service status；没有强制终止或删除数据');
      }
    }
    if (action === 'uninstall') unlinkSync(plist);
    if (action === 'start' || action === 'restart') {
      if (serviceStatus(c).registered) throw new Error('服务已启动');
      if (activeData(c.dataDir)) throw new Error('当前配置仍有前台实例或正在停止的实例，请先等待它退出');
      const r = spawnSync('launchctl', ['bootstrap', domain(), plist], { stdio: 'pipe', timeout: 10000 });
      if (r.status !== 0) throw new Error('服务启动失败，请运行 namo doctor 检查配置');
    }
  } else throw new Error('服务命令：install / status / start / stop / restart / uninstall');
  return serviceStatus(c);
}
export async function waitForService(c: Config, timeout = 90_000): Promise<boolean> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (serviceStatus(c).ready) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
