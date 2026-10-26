import { accessSync, constants, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import type { Config } from './config.js';
import { CodexRuntime, probeRuntime, RuntimeError, type Runtime } from './runtime.js';
import { codexEnvironment } from './safety.js';

export interface AgentInfo { id: string; kind: 'local-cli' | 'gateway'; supported: boolean; path?: string; version?: string; installed: boolean; }
export interface Check { id: string; status: 'ok' | 'warn' | 'fail'; message: string; next?: string; }
export function findExecutable(bin: string, path = process.env.PATH ?? ''): string | undefined {
  const candidates = bin.includes('/') || bin.includes('\\') ? [resolve(bin)] : path.split(delimiter).flatMap(p => process.platform === 'win32' ? [join(p, `${bin}.exe`), join(p, `${bin}.cmd`), join(p, bin)] : [join(p, bin)]);
  return candidates.find(p => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } });
}
export function detectAgents(codexBin = 'codex'): AgentInfo[] {
  return [{ id: 'codex', bin: codexBin, kind: 'local-cli' as const, supported: true },
    { id: 'claude', bin: 'claude', kind: 'local-cli' as const, supported: false },
    { id: 'openclaw', bin: 'openclaw', kind: 'gateway' as const, supported: false }].map(a => {
    const path = findExecutable(a.bin);
    let version: string | undefined;
    if (path) {
      const r = spawnSync(path, ['--version'], { timeout: 5000, encoding: 'utf8', maxBuffer: 64_000 });
      // Never echo arbitrary program output (a broken wrapper can print env).
      version = `${r.stdout ?? ''} ${r.stderr ?? ''}`.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
    }
    return { id: a.id, kind: a.kind, supported: a.supported, path: path ? realpathSync(path) : undefined, version, installed: !!path };
  });
}
export function runtimeFor(config: Config): Runtime {
  if (config.agent !== 'codex') throw new Error('当前版本仅支持 Codex 执行后端');
  return new CodexRuntime(config.codex);
}
export async function probeAgent(c: Config): Promise<Check[]> {
  const checks: Check[] = [];
  const path = findExecutable(c.codex.bin);
  if (!path) return [{ id: 'agent.binary', status: 'fail', message: '未找到 Codex 可执行文件', next: '安装官方 Codex，或通过 namo init 指定完整路径：https://learn.chatgpt.com/docs/cli' }];
  checks.push({ id: 'agent.binary', status: 'ok', message: `Codex：${realpathSync(path)}` });
  if (!existsSync(c.codex.home)) return [...checks, { id: 'agent.auth', status: 'fail', message: 'Namo 专用 Codex 环境尚未创建或登录', next: '运行 namo login；不会复制个人 Codex 凭据' }];
  try {
    const p = await probeRuntime(c.codex);
    checks.push({ id: 'agent.protocol', status: 'ok', message: 'app-server 初始化、账号与指定权限配置均可用' });
    checks.push({ id: 'agent.auth', status: p.authenticated ? 'ok' : 'fail', message: p.authenticated ? 'Namo 专用 Codex 账号已登录' : 'Namo 专用 Codex 账号未登录', next: p.authenticated ? undefined : '运行 namo login' });
  } catch (e) {
    checks.push({ id: 'agent.protocol', status: 'fail', message: `app-server 探测失败（${e instanceof RuntimeError ? e.code : 'probe_failed'}）`, next: '运行 codex --version 并检查安装；当前协议基线为 0.154.0，不会自动放宽权限或切换模型入口' });
  }
  if (c.codex.defaultProject) {
    const cwd = c.codex.projects?.[c.codex.defaultProject];
    checks.push({ id: 'agent.project', status: cwd && existsSync(cwd) ? 'ok' : 'fail', message: cwd ? `工作目录：${cwd}` : '默认项目不存在' });
  } else checks.push({ id: 'agent.project', status: 'warn', message: '未配置项目，将使用隔离会话目录', next: '运行 namo init 选择项目' });
  return checks;
}
export async function loginAgent(c: Config): Promise<void> {
  const path = findExecutable(c.codex.bin); if (!path) throw new Error('未找到 Codex，请先安装官方 Codex CLI');
  mkdirSync(c.codex.home, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    const p = spawn(path, ['login'], { env: codexEnvironment(c.codex.home), stdio: 'inherit' });
    p.once('error', () => reject(new Error('Codex 登录进程无法启动')));
    p.once('exit', code => code === 0 ? resolve() : reject(new Error('Codex 登录未完成，可重新运行 namo login')));
  });
}
export async function liveAgentTest(c: Config): Promise<boolean> {
  const cwd = c.codex.defaultProject && c.codex.projects?.[c.codex.defaultProject] || join(c.dataDir, 'workspaces', 'health');
  const result = await runtimeFor(c).run({ cwd, prompt: 'Do not call tools. Reply with exactly NAMO_AGENT_OK.', signal: new AbortController().signal, onThread() {}, onTurn() {} });
  return result.text === 'NAMO_AGENT_OK';
}
export function toolchainPaths(): string[] {
  const paths = new Set<string>();
  const node = realpathSync(process.execPath);
  if (process.platform === 'darwin' && node.startsWith('/opt/homebrew/')) paths.add('/opt/homebrew');
  else if (!node.startsWith('/usr/')) paths.add(dirname(dirname(node)));
  return [...paths];
}
