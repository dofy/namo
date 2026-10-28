import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { Config } from './config.js';
import { codexEnvironment } from './safety.js';
import { RuntimeError } from './runtime-contract.js';
import { resolveCodexBinary } from './codex-installation.js';
import { readSkillSettings, skillReadDirectories, skillSettingsOverride, SkillAccessError, type SkillAccess, type SkillCatalog } from './skill-access.js';

type Obj = Record<string, any>;

export class Rpc {
  readonly process: ChildProcessWithoutNullStreams;
  private id = 0;
  private pending = new Map<number, { resolve: (v: Obj) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(method: string, params: Obj) => void>();
  private requestListeners = new Set<(method: string, params: Obj, id: string | number) => boolean>();
  private closed = false;
  constructor(bin: string, home: string, sandbox: Config['codex']['sandbox'] = 'read-only', policy?: Config['codex'], extraction = false, skills?: SkillAccess, managed = true) {
    if (managed) bin = resolveCodexBinary(bin, home);
    const access = sandbox === 'workspace-write' ? 'write' : 'read';
    const executable = bin.includes('/') ? resolve(bin)
      : (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, bin)).find(existsSync);
    const files: Record<string, string | Record<string, string>> = {
      ':root': 'deny', ':minimal': 'read',
      ':workspace_roots': sandbox === 'workspace-write' && policy?.allowLocalCommits
        ? { '.': 'write', '.git': 'write' } : access,
    };
    for (const path of policy?.readPaths ?? []) files[path] = 'read';
    // The sandboxed instruction loader re-executes Codex. Standalone installs
    // outside system directories need explicit read/execute access to the
    // launcher and its canonical binary, without granting the rest of HOME.
    if (executable && existsSync(executable)) {
      files[dirname(realpathSync(executable))] = 'read';
      const packageRoot = dirname(dirname(realpathSync(executable)));
      if (existsSync(join(packageRoot, 'codex-package.json'))) {
        for (const resource of ['codex-path','codex-resources']) if (existsSync(join(packageRoot,resource))) files[join(packageRoot,resource)]='read';
      }
    }
    for (const path of policy?.denyPaths ?? []) files[path] = 'deny';
    for (const path of skills?.directories ?? []) files[path] = 'read';
    const filesystem = `{${Object.entries(files).map(([key, value]) => `${JSON.stringify(key)}=${typeof value === 'string' ? JSON.stringify(value)
      : `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(',')}}`}`).join(',')}}`;
    this.process = spawn(executable ? realpathSync(executable) : bin, ['app-server', '--listen', 'stdio://', '-c', 'model_provider="openai"',
      // Do not scan host/ancestor AGENTS.md files. On 0.154 the sandboxed
      // instruction loader also fails on unreadable ancestor paths; the bot
      // supplies its own developer instructions explicitly below.
      '-c', 'project_doc_max_bytes=0',
      '-c', 'default_permissions="feishu-bot"',
      ...(sandbox === 'workspace-write' ? ['-c', 'permissions.feishu-bot.extends=":workspace"'] : []),
      '-c', `permissions.feishu-bot.filesystem=${filesystem}`,
      '-c', `permissions.feishu-bot.network.enabled=${policy?.networkAccess === true}`,
      ...skillSettingsOverride(skills?.settings ?? []),
      ...(extraction ? ['-c','features.shell_tool=false','-c','features.plugins=false','-c','features.apps=false','-c','features.hooks=false',
        '-c','mcp_servers={}','-c','web_search="disabled"'] : [])], {
      env: { ...codexEnvironment(home), npm_config_script_shell: '/bin/sh',
        npm_config_userconfig: '/dev/null', npm_config_cache: join(tmpdir(), 'feishu-codex-bot-npm'),
        pnpm_config_script_shell: '/bin/sh', pnpm_config_npmrc_auth_file: '/dev/null',
        pnpm_config_cache_dir: join(tmpdir(), 'namo-pnpm-cache'),
        pnpm_config_store_dir: join(tmpdir(), 'namo-pnpm-store'),
        pnpm_config_state_dir: join(tmpdir(), 'namo-pnpm-state'),
        NPM_CONFIG_USERCONFIG: '/dev/null', XDG_CONFIG_HOME: join(tmpdir(), 'namo-tool-config'),
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
      stdio: 'pipe', detached: process.platform !== 'win32',
    });
    this.process.stderr.on('data', () => { /* Never forward raw runtime logs or credentials. */ });
    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', line => {
      let message: Obj;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) {
        let handled = false;
        for (const listener of this.requestListeners) {
          try { if (listener(message.method, message.params ?? {}, message.id)) { handled = true; break; } }
          catch { this.respondError(message.id, -32000, 'request_handler_error'); handled = true; break; }
        }
        if (handled) return;
        // This MVP has no remote approval UI. Fail closed instead of hanging or
        // implicitly approving an operation requested by the model.
        if (message.method.endsWith('/requestApproval')) this.write({ id: message.id, result: { decision: 'decline' } });
        else this.write({ id: message.id, error: { code: -32000, message: 'Interactive requests are unavailable in this bot. Explain the blocked step to the user.' } });
      } else if (message.id !== undefined) {
        const p = this.pending.get(message.id);
        if (!p) return;
        clearTimeout(p.timer); this.pending.delete(message.id);
        if (message.error) p.reject(new RuntimeError(`rpc_${message.error.code ?? 'error'}`, String(message.error.message ?? '')));
        else p.resolve(message.result ?? {});
      } else if (message.method) {
        for (const listener of this.listeners) listener(message.method, message.params ?? {});
      }
    });
    const die = () => {
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new RuntimeError('runtime_disconnected')); }
      this.pending.clear();
      for (const listener of this.listeners) listener('transport/closed', {});
    };
    this.process.once('error', die);
    this.process.once('exit', die);
    this.process.stdin.on('error', die);
  }
  private write(value: Obj): void {
    if (!this.closed && !this.process.stdin.destroyed) this.process.stdin.write(`${JSON.stringify(value)}\n`, () => {});
  }
  notify(method: string): void { this.write({ method, params: {} }); }
  respond(id: string | number, result: Obj): void { this.write({ id, result }); }
  respondError(id: string | number, code: number, message: string): void { this.write({ id, error: { code, message } }); }
  request(method: string, params: Obj, timeoutMs = 30_000): Promise<Obj> {
    if (this.closed) return Promise.reject(new RuntimeError('runtime_disconnected'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RuntimeError('rpc_timeout')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  listen(fn: (method: string, params: Obj) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  listenRequests(fn: (method: string, params: Obj, id: string | number) => boolean): () => void {
    this.requestListeners.add(fn); return () => this.requestListeners.delete(fn);
  }
  stop(force = false): void {
    const pid = this.process.pid;
    if (!pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
      else this.process.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch { /* The isolated process group has already exited. */ }
  }
  async close(): Promise<void> {
    this.stop();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.stop(true); resolve(); }, 1500);
      if (this.closed) { clearTimeout(timer); this.stop(true); resolve(); return; }
      this.process.once('exit', () => { clearTimeout(timer); this.stop(true); resolve(); });
    });
  }
}

async function initializedRpc(config: Config['codex'], skills: SkillAccess): Promise<Rpc> {
  const rpc = new Rpc(config.bin, config.home, config.sandbox, config, false, skills);
  try {
    await rpc.request('initialize', { clientInfo: { name: 'namo', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    return rpc;
  } catch (error) { await rpc.close(); throw error; }
}

export async function listCodexModels(config: Config['codex']): Promise<{id:string;name:string;isDefault:boolean}[]> {
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  const rpc = await initializedRpc(config, { settings: readSkillSettings(config.home), directories: [] });
  try {
    const result: {id:string;name:string;isDefault:boolean}[] = [];
    let cursor: string | undefined;
    for (let page=0; page<10; page++) {
      const response = await rpc.request('model/list', {limit:100, ...(cursor ? {cursor} : {})}, 10000);
      if (!Array.isArray(response.data)) throw new RuntimeError('model_catalog_invalid');
      for (const model of response.data) if (model && model.hidden !== true && typeof model.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model.model))
        result.push({id:model.model,name:typeof model.displayName === 'string' ? model.displayName.slice(0,100) : model.model,isDefault:model.isDefault === true});
      if (!response.nextCursor) return result;
      if (typeof response.nextCursor !== 'string' || response.nextCursor === cursor) throw new RuntimeError('model_catalog_invalid');
      cursor=response.nextCursor;
    }
    throw new RuntimeError('model_catalog_too_large');
  } finally { await rpc.close(); }
}

/** Discover without inference, then pin only enabled skill directories for this runtime. */
export async function connectCodex(config: Config['codex'], cwd: string): Promise<Rpc> {
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  let rpc: Rpc | undefined;
  try {
    const settings = readSkillSettings(config.home);
    rpc = await initializedRpc(config, { settings, directories: [] });
    // Remote plugin skills are materialized from the installed catalog on demand.
    // Listing it does not install plugins or import personal MCP configuration.
    try { await rpc.request('plugin/list', { cwds: [cwd], forceRefetch: false }, 5000); }
    catch (error) {
      // A remote catalog outage must not prevent local skills or ordinary tasks.
      // No cached directory is granted unless skills/list actually reports it.
      if (!(error instanceof RuntimeError) || !['rpc_timeout', 'rpc_-32603', 'rpc_-32601'].includes(error.code)) throw error;
    }
    const catalog = await rpc.request('skills/list', { cwds: [cwd], forceReload: true }) as SkillCatalog;
    const directories = skillReadDirectories(catalog, settings, config);
    if (!directories.length) return rpc;
    await rpc.close(); rpc = undefined;
    return await initializedRpc(config, { settings, directories });
  } catch (error) {
    await rpc?.close();
    if (error instanceof SkillAccessError) throw new RuntimeError(error.code);
    throw error;
  }
}

export async function probeRuntime(config: Config['codex']): Promise<{ initialized: true; authenticated: boolean; permissions: true }> {
  const cwd = config.projects?.[config.defaultProject ?? ''] ?? config.home;
  const rpc = await connectCodex(config, cwd);
  try {
    const result = await rpc.request('account/read', { refreshToken: false });
    const profiles = await rpc.request('permissionProfile/list', {});
    if (!profiles.data?.some((p: Obj) => p.id === 'feishu-bot' && p.allowed)) throw new RuntimeError('permission_profile_unavailable');
    return { initialized: true, authenticated: Boolean(result.account), permissions: true };
  } finally { await rpc.close(); }
}
