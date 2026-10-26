import { existsSync, mkdirSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateFeishu } from '../src/config.js';
import { codexEnvironment } from '../src/safety.js';

if (process.platform !== 'darwin') throw new Error('此脚本仅支持 macOS launchd；其它平台直接 pnpm start');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const label = 'local.feishu-codex-bot';
const file = join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const domain = `gui/${process.getuid!()}`;
const mode = process.argv[2] ?? 'install';
if (mode === 'uninstall') {
  spawnSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  if (existsSync(file)) unlinkSync(file);
  console.log('已卸载自动启动；数据和配置保留。');
} else if (mode === 'install') {
  const config = loadConfig(join(root, 'config.local.json'));
  validateFeishu(config);
  const auth = spawnSync(config.codex.bin, ['login', 'status'], { env: codexEnvironment(config.codex.home), stdio: 'pipe', timeout: 15_000 });
  if (auth.status !== 0) throw new Error('请先 pnpm run login');
  if (existsSync(file)) throw new Error('服务配置已存在；先 service:uninstall 再安装');
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(file), { recursive: true });
  const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const stablePath = [...new Set((process.env.PATH ?? '').split(':').filter(Boolean).map(p => { try { return realpathSync(p); } catch { return p; } }))].join(':');
  const args = [realpathSync(process.execPath), join(root, 'dist/src/cli.js'), 'start', '--config', config.file];
  writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(s => `<string>${xml(s)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(stablePath)}</string><key>HOME</key><string>${xml(homedir())}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>90</integer>
<key>StandardOutPath</key><string>${xml(join(config.dataDir, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(config.dataDir, 'service.error.log'))}</string>
</dict></plist>`, { mode: 0o600 });
  const result = spawnSync('launchctl', ['bootstrap', domain, file], { stdio: 'inherit' });
  if (result.status !== 0) { unlinkSync(file); process.exitCode = 1; }
  else console.log('已安装本项目的 launchd 服务。请确认 OpenClaw 的同应用接收端已停用。');
} else throw new Error('命令：install / uninstall');
