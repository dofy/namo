import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, validateFeishu } from './config.js';
import { acquireLock, codexEnvironment, makeRedactor } from './safety.js';
import { Store } from './store.js';
import { CodexRuntime } from './runtime.js';
import { Engine } from './engine.js';
import { FeishuTransport } from './feishu.js';

process.umask(0o077);
const args = process.argv.slice(2);
const command = args[0] ?? 'start';
const flag = args.indexOf('--config');
const file = flag >= 0 ? args[flag + 1] : 'config.local.json';

// SDK-owned keepalive timers must not retain a fully closed service. Give
// stdout/stderr a chance to flush, then let launchd restart failed instances.
function finish(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 250).unref();
}

async function main(): Promise<void> {
  const config = loadConfig(file);
  const redact = makeRedactor([config.feishu.appSecret]);
  const log = (event: string, fields: Record<string, unknown> = {}) => console.log(redact(JSON.stringify({ time: new Date().toISOString(), event, ...fields })));
  mkdirSync(config.codex.home, { recursive: true, mode: 0o700 });
  if (command === 'login') {
    const child = spawn(config.codex.bin, ['login'], { env: codexEnvironment(config.codex.home), stdio: 'inherit' });
    child.on('error', () => { console.error('无法启动 Codex CLI'); process.exitCode = 1; });
    await new Promise<void>(resolve => child.on('exit', code => { process.exitCode = code ?? 1; resolve(); }));
    return;
  }
  const probe = () => spawnSync(config.codex.bin, ['login', 'status'], { env: codexEnvironment(config.codex.home), stdio: 'pipe', timeout: 15_000 });
  if (command === 'check') {
    const auth = probe();
    let feishu = 'ready';
    try { validateFeishu(config); } catch (e) { feishu = (e as Error).message; }
    console.log(JSON.stringify({ node: process.version, codexLoggedIn: auth.status === 0,
      codexHome: config.codex.home, feishuConfig: feishu, dataDir: config.dataDir,
      next: auth.status === 0 ? '配置完成后 npm start' : '先运行 npm run login 完成 bot 专用 Codex 登录' }, null, 2));
    if (auth.status !== 0 || feishu !== 'ready') process.exitCode = 1;
    return;
  }
  const dbFile = join(config.dataDir, 'bot.sqlite');
  if (command === 'status') {
    if (!existsSync(dbFile)) { console.log('服务尚未创建消息数据库。'); return; }
    const store = new Store(dbFile, true); console.log(JSON.stringify(store.status(), null, 2)); store.close(); return;
  }
  if (command !== 'start') throw new Error('命令：start / check / login / status [--config 路径]');
  validateFeishu(config);
  if (probe().status !== 0) throw new Error('bot 的 Codex 尚未登录，请先运行 npm run login');
  const release = acquireLock(config.dataDir);
  let store: Store | undefined;
  let engine: Engine | undefined;
  let transport: FeishuTransport | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    transport?.close();
    try { await engine?.stop(); } finally { try { store?.close(); } finally { release(); } }
    log('stopped');
  })();
  const stop = async (code: number) => {
    try { await close(); finish(code); }
    catch { console.error('服务关闭失败'); finish(1); }
  };
  process.once('SIGINT', () => { void stop(0); });
  process.once('SIGTERM', () => { void stop(0); });
  try {
    store = new Store(dbFile);
    store.bindAccount(config.feishu.appId);
    transport = new FeishuTransport(config.feishu, log);
    engine = new Engine(store, new CodexRuntime(config.codex), transport, config, redact, log,
      () => { void stop(1); });
    const service = engine;
    // Recover queued work only after transport is ready; otherwise a transient
    // startup network failure could consume pending outputs before connection.
    await transport.connect(message => { service.accept(message); });
    if (closing) return;
    engine.start();
    log('ready', { dataDir: config.dataDir, concurrency: config.concurrency });
  } catch (e) { await close(); throw e; }
}

main().catch(error => {
  // Runtime SDK errors may contain credentials; only our own known messages
  // escape the service. Never print an arbitrary error object or stack.
  const text = error instanceof SyntaxError ? '配置 JSON 格式错误' : error instanceof Error ? error.message : '启动失败';
  console.error(makeRedactor()(text.slice(0, 500)));
  finish(1);
});
