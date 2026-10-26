import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { acquireLock, makeRedactor } from './safety.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { FeishuTransport } from './feishu.js';
import { configFile, atomicJson, receiverDir, digest } from './paths.js';
import { Management } from './management.js';
import { randomUUID } from 'node:crypto';
import { detectAgents, loginAgent, probeAgent, liveAgentTest } from './agents.js';
import { RunnerRuntime } from './runner.js';
import { doctor } from './doctor.js';
import { TerminalPrompter, Cancelled } from './prompts.js';
import { onboard } from './onboarding.js';
import { serviceAction, serviceStatus, assertNoLegacyReceiver } from './service.js';

process.umask(0o077);
const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('-') && (i === 0 || args[i - 1] !== '--config'));
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} 需要一个路径`);
  return args[i + 1];
}
const HELP = `Namo · 飞书连接本地 Agent（首版支持 Codex）

用法：namo <命令> [--config 路径]
  init                 可恢复的交互初始化、飞书引导和用户配对
  doctor [--live]       分层诊断；--live 会调用模型并使用账号额度
  agent list           探测本机执行器，标明尚未支持的后端
  agent test --live     真实 Codex 响应测试（会使用账号额度）
  login                登录 Namo 独立的官方 Codex 环境
  start                前台接收（Ctrl+C 停止接收，已开工任务继续）
  status               消息队列和后台服务状态
  logs                 最近 80 行日志（自动脱敏）
  service <操作>       install / status / start / stop / restart / uninstall
  ui                   打开仅本机可访问的管理界面（Ctrl+C 关闭）
  issues               列出待核对异常
  issue <编号>         查看异常与核对版本
  resolve <编号> <版本> <动作> <依据> --confirm
                       received / retry / dismiss / reviewed；不会重跑模型
  config path          显示当前配置文件位置

--json 可用于 doctor / agent list / status。未指定配置时优先使用
NAMO_CONFIG、当前目录已有 config.local.json，再使用系统用户目录。
首版后台服务管理仅支持 macOS；其他平台可使用前台模式。
初始化不会自动安装 Agent、迁移 OpenClaw 或发布应用。`;
function finish(code: number): void { process.exitCode = code; setTimeout(() => process.exit(code), 250).unref(); }
let redact = makeRedactor();
async function main(): Promise<void> {
  const command = positional[0] ?? 'help';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config') { flag('--config'); i++; continue; }
    if (args[i].startsWith('-') && !['--help', '-h', '--version', '-v', '--json', '--live', '--confirm'].includes(args[i])) throw new Error('未知选项，运行 namo --help 查看用法');
  }
  if (args.includes('--version') || args.includes('-v')) { console.log(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version); return; }
  if (args.includes('--help') || args.includes('-h') || ['help', '-h', '--help'].includes(command)) { console.log(HELP); return; }
  if (command!=='resolve'&&positional.length > (['agent', 'service', 'config','issue'].includes(command) ? 2 : 1)) throw new Error('命令参数过多，运行 namo --help 查看用法');
  const known = ['ui','issues','issue','resolve','init', 'doctor', 'agent', 'login', 'start', 'status', 'logs', 'service', 'config', 'check'];
  if (!known.includes(command)) throw new Error(`未知命令：${command}。运行 namo --help`);
  const file = configFile(flag('--config'));
  if (command === 'config') { if (positional[1] !== 'path') throw new Error('用法：namo config path'); console.log(file); return; }
  if (command === 'init') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('namo init 需要交互终端。请在本机终端运行；不要通过管道输入凭据。自动化诊断可使用 namo doctor --json');
    const ui = new TerminalPrompter();
    try { const r = await onboard(file, ui); if (!r.configured) process.exitCode = 1; }
    finally { ui.close(); }
    return;
  }
  if (command === 'agent' && positional[1] === 'list') {
    const infos = detectAgents();
    if (args.includes('--json')) console.log(JSON.stringify(infos, null, 2));
    else for (const a of infos) console.log(`${a.id}: ${a.installed ? `已安装 ${a.version ?? '版本未知'}` : '未找到'} · ${a.kind} · ${a.supported ? '可用后端' : '尚未接入'}${a.path ? `\n  ${a.path}` : ''}`);
    return;
  }
  if (command === 'doctor' || command === 'check') {
    const checks = await doctor(file, args.includes('--live'));
    if (args.includes('--json')) console.log(JSON.stringify(checks, null, 2));
    else for (const c of checks) console.log(`${c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗'} ${c.message}${c.next ? `\n  ${c.next}` : ''}`);
    if (checks.some(c => c.status === 'fail')) process.exitCode = 1;
    return;
  }
  if (!existsSync(file)) throw new Error('尚无配置，请先运行 namo init，或通过 --config 指定现有配置');
  if(command==='ui') {
    const {startUi,openUi}=await import('./ui.js');const ui=await startUi(new Management(file));
    try{await openUi(ui.entryUrl);}catch(e){await ui.close();throw e;}
    console.log(`Namo 本地工作台已打开：${ui.url}\n仅本机可访问；关闭此进程会使页面授权失效。没有启动飞书接收端。`);
    let stopping=false;const close=async()=>{if(stopping)return;stopping=true;await ui.close();finish(0);};
    process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());return;
  }
  if(['issues','issue','resolve'].includes(command)) {
    const manager=new Management(file);
    if(command==='issues'){const state=manager.state();console.log(JSON.stringify({available:state.recoveryAvailable,issues:state.database.issues},null,2));}
    else if(command==='issue')console.log(JSON.stringify(manager.issue(positional[1]??''),null,2));
    else {
      if(!args.includes('--confirm')||positional.length<5)throw new Error('先用 issue 查看并核对；resolve 需要编号、版本、动作、核对依据和 --confirm。retry 可能重复发送，但不会重跑模型');
      console.log(JSON.stringify(manager.reconcile({subject:positional[1],stamp:positional[2],action:positional[3],note:positional.slice(4).join(' '),requestId:randomUUID(),acknowledgeDuplicate:positional[3]==='retry'})));
    }return;
  }
  const configRevision=digest(readFileSync(file,'utf8'));
  const config = loadConfig(file); redact = makeRedactor([config.feishu.appSecret]);
  if(configRevision!==digest(readFileSync(file,'utf8')))throw new Error('配置正在修改，请重试');
  if (command === 'login') { await loginAgent(config); return; }
  if (command === 'agent') {
    if (positional[1] !== 'test' || !args.includes('--live')) throw new Error('真实测试请使用 namo agent test --live（会使用账号额度）');
    const ok = await liveAgentTest(config); console.log(JSON.stringify({ modelTurnVerified: ok })); if (!ok) process.exitCode = 1; return;
  }
  if (command === 'service') { console.log(JSON.stringify(await serviceAction(positional[1] ?? 'status', config), null, 2)); return; }
  if (command === 'logs') {
    for (const name of ['service.log', 'service.error.log']) {
      const path = join(config.dataDir, name);
      if (existsSync(path)) console.log(redact(readFileSync(path, 'utf8').trim().split('\n').slice(-80).join('\n')));
    }
    return;
  }
  const dbFile = join(config.dataDir, 'bot.sqlite');
  if (command === 'status') {
    let queue: unknown = '服务尚未创建消息数据库';
    if (existsSync(dbFile)) { const store = new Store(dbFile, true); try { queue = store.status(); } finally { store.close(); } }
    console.log(JSON.stringify({ service: serviceStatus(config), queue }, null, 2)); return;
  }
  const { validateFeishu } = await import('./config.js'); validateFeishu(config);
  if ((await probeAgent(config)).some(c => c.status === 'fail')) throw new Error('Agent 尚未就绪，请运行 namo doctor 或 namo login');
  const release = acquireLock(config.dataDir);
  let releaseReceiver: (() => void) | undefined;
  let store: Store | undefined, engine: Engine | undefined, transport: FeishuTransport | undefined;
  let closing: Promise<void> | undefined;
  let health: Record<string, unknown> = { pid: process.pid, startedAt: new Date().toISOString(), ready: false, connection: 'connecting',configRevision,managementVersion:2 };
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    if (['ready', 'stopped', 'feishu_connected', 'feishu_reconnecting', 'feishu_reconnected', 'feishu_connection_failed', 'feishu_startup_timeout'].includes(event)) {
      const connection = event === 'ready' || ['feishu_connected', 'feishu_reconnected'].includes(event) ? 'connected'
        : event === 'feishu_reconnecting' ? 'reconnecting' : event === 'stopped' ? 'stopped' : 'failed';
      health = { ...health, connection, ready: event === 'ready' || event === 'feishu_reconnected', updatedAt: new Date().toISOString() };
      atomicJson(join(config.dataDir, 'health.json'), health);
    }
    console.log(redact(JSON.stringify({ time: new Date().toISOString(), event, ...fields })));
  };
  const close = () => closing ??= (async () => {
    transport?.close();
    try { await engine?.stop(); } finally { try { store?.close(); } finally { releaseReceiver?.(); release(); } }
    log('stopped');
  })();
  const stop = async (code: number) => { try { await close(); finish(code); } catch { console.error('服务关闭失败'); finish(1); } };
  process.once('SIGINT', () => void stop(0)); process.once('SIGTERM', () => void stop(0));
  try {
    mkdirSync(config.codex.home, { recursive: true, mode: 0o700 });
    assertNoLegacyReceiver(config.feishu.appId);
    releaseReceiver = acquireLock(receiverDir(config.feishu.appId));
    store = new Store(dbFile); store.bindAccount(config.feishu.appId);
    transport = new FeishuTransport(config.feishu, log);
    engine = new Engine(store, new RunnerRuntime(store, config), transport, config, redact, log, () => void stop(1));
    const service = engine;
    await transport.connect(m => { service.accept(m); },event=>service.acceptCard(event)); if (closing) return;
    engine.start(); log('ready', { dataDir: config.dataDir, concurrency: config.concurrency });
  } catch (e) { await close(); throw e; }
}
main().then(() => { if (!['start','ui'].includes(positional[0]) || args.includes('--help') || args.includes('--version') || args.includes('-h') || args.includes('-v')) finish(Number(process.exitCode ?? 0)); }).catch(e => {
  const message = e instanceof Cancelled ? e.message : e instanceof SyntaxError ? '配置 JSON 格式错误；未输出配置正文' : e instanceof Error ? e.message : '操作未完成';
  console.error(redact(message.slice(0, 500))); finish(e instanceof Cancelled ? 130 : 1);
});
