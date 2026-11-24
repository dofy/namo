import { isModelId, readAgentModel } from './agent-models.js';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { evidenceItem } from './evidence.js';
import type { AgentProfile, ClaudeGateway } from './agent-registry.js';
import type { AutoMemoryInput } from './auto-memory.js';
import type { Config } from './config.js';
import { verifyImageInput } from './image-inputs.js';
import { pathsOverlap } from './path-policy.js';
import { MEMORY_EXTRACTION_INSTRUCTIONS, MEMORY_OUTPUT_SCHEMA } from './memory-extractor.js';
import { RuntimeError, type Runtime, type RunRequest, type RunResult } from './runtime-contract.js';
import { codexEnvironment } from './safety.js';

const cli = promisify(execFile);
export const CLAUDE_MIN_VERSION = '2.1.330';
const nativeSession = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const maxOutputLine = 2_000_000;
const maxTranscriptTailBytes = 4_000_000;
const memorySystemPrompt = MEMORY_EXTRACTION_INSTRUCTIONS
  + '\nReturn one JSON object matching this schema, with no Markdown fences: ' + JSON.stringify(MEMORY_OUTPUT_SCHEMA);

export function claudeEnvironment(home: string, gateway?: ClaudeGateway): NodeJS.ProcessEnv {
  const { CODEX_HOME: _unused, ...env } = codexEnvironment(home);
  return { ...env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), DISABLE_AUTOUPDATER: '1',
    ...(gateway ? {
      ANTHROPIC_BASE_URL: gateway.baseUrl,
      [gateway.auth === 'bearer' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY']: gateway.secret,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    } : {}) };
}

export function prepareClaudeHome(dataDir: string, home: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (existsSync(home) && !privateClaudeHome(dataDir, home)) throw new RuntimeError('claude_home_invalid');
  mkdirSync(join(home, '.claude'), { recursive: true, mode: 0o700 });
  if (!privateClaudeHome(dataDir, home)) throw new RuntimeError('claude_home_invalid');
}

function privateClaudeHome(dataDir: string, home: string): boolean {
  const child = relative(dataDir, home);
  if (!child || child === '..' || child.startsWith('../') || isAbsolute(child)) return false;
  return lstatSync(home).isDirectory() && realpathSync(home) === join(realpathSync(dataDir), child)
    && (!existsSync(join(home, '.claude')) || lstatSync(join(home, '.claude')).isDirectory());
}

export async function claudeVersion(bin: string, home: string): Promise<string | undefined> {
  const { stdout } = await cli(bin, ['--version'], { env: claudeEnvironment(home), timeout: 5000, maxBuffer: 16_384 });
  const version = /^(\d+)\.(\d+)\.(\d+) \(Claude Code\)\s*$/.exec(stdout);
  if (!version) return;
  const [, major, minor, patch] = version.map(Number);
  return major > 2 || major === 2 && (minor > 1 || minor === 1 && patch >= 330) ? version[0].trim().split(' ')[0] : undefined;
}

export async function claudeAuthenticated(bin: string, dataDir: string, home: string): Promise<boolean> {
  if (!existsSync(home) || !privateClaudeHome(dataDir, home)) return false;
  const { stdout } = await cli(bin, ['auth', 'status', '--json'], { cwd: home, env: claudeEnvironment(home), timeout: 5000, maxBuffer: 16_384 });
  return JSON.parse(stdout).loggedIn === true;
}

function filePolicy(c: Config, home: string, cwd: string) {
  if (process.platform === 'win32') throw new RuntimeError('claude_platform_unsupported');
  const canonical = (path: string) => existsSync(path) ? realpathSync(path) : path;
  const dataDir = canonical(c.dataDir);
  const privateRoots = [dataDir, canonical(c.codex.home), canonical(home)];
  const directories = c.codex.directories ?? [];
  if (directories.some(dir => privateRoots.some(root => pathsOverlap(dir, root))))
    throw new RuntimeError('claude_directory_overlaps_private_storage');
  const denied = [...new Set([c.file, ...(c.codex.denyPaths ?? [])].filter(Boolean).map(canonical))];
  const deny: string[] = [];
  for (const path of denied) {
    if (path !== dataDir && pathsOverlap(path, cwd) && !relative(path, cwd).startsWith('../'))
      throw new RuntimeError('claude_workspace_denied');
    if (![cwd, ...directories].some(dir => pathsOverlap(dir, path)) || path === dataDir) continue;
    // Claude permission paths are glob patterns. Fail closed if this path
    // cannot be expressed as a literal rule of the documented syntax.
    if (/[\[\]{}*?!(),\\\u0000-\u001f]/u.test(path)) throw new RuntimeError('claude_deny_path_unsupported');
    for (const tool of ['Read', 'Edit']) deny.push(`${tool}(/${path})`, `${tool}(/${path}/**)`);
  }
  return { directories, deny, sandboxDenied: denied, privateRoots };
}

function commandSandbox(policy: ReturnType<typeof filePolicy>, cwd: string, networkAccess: boolean) {
  const realHome = realpathSync(homedir());
  const toolchainRoot = dirname(dirname(realpathSync(process.execPath)));
  const protectedPaths = [...new Set([...policy.privateRoots, ...policy.sandboxDenied])];
  const toolchain = toolchainRoot.startsWith(realHome + '/') && !protectedPaths.some(path => pathsOverlap(path, toolchainRoot))
    ? [toolchainRoot] : [];
  const allowRead = [...new Set([realpathSync(cwd), ...policy.directories, ...toolchain])];
  const denyRead = [...new Set([realHome, ...protectedPaths])];
  // Treat configured paths as literals. A pattern in an allow path could
  // reopen files outside the corresponding directory grant.
  if ([...allowRead, ...denyRead].some(path => /[\[\]{}*?!(),\\\u0000-\u001f]/u.test(path)))
    throw new RuntimeError('claude_sandbox_path_unsupported');
  return {
    enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
    filesystem: {
      allowRead, denyRead, allowWrite: policy.directories,
      // The task's private cwd can live under dataDir. All other writes are
      // limited to the working directories and the sandbox's temporary area.
      denyWrite: protectedPaths.filter(path => path !== policy.privateRoots[0]),
    },
    network: { allowedDomains: networkAccess ? ['*'] : [], strictAllowlist: true,
      allowAllUnixSockets: false, allowLocalBinding: false },
  };
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch { /* The group may already have exited. */ }
}

// Claude can carry a rejected prompt into subsequent requests. Use its native
// resume checkpoint only when everything after a completed reply consists of
// rejected turns that never used tools. The on-disk history stays intact.
function refusalCheckpoint(home: string, cwd: string, sessionId: string): string | undefined {
  let fd: number | undefined;
  try {
    const project = realpathSync(cwd).replace(/[^a-zA-Z0-9-]/g, '-');
    const file = join(realpathSync(home), '.claude', 'projects', project, `${sessionId}.jsonl`);
    if (realpathSync(file) !== file) return;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || !stat.size) return;
    const bytes = Buffer.allocUnsafe(Math.min(stat.size, maxTranscriptTailBytes));
    const offset = stat.size - bytes.length;
    if (readSync(fd, bytes, 0, bytes.length, offset) !== bytes.length) return;
    const lines = bytes.toString('utf8').split('\n');
    if (offset) lines.shift();

    let checkpoint: string | undefined;
    let awaitingReply = false;
    let refused = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.sessionId !== sessionId || entry.isSidechain === true) continue;
      if (entry.type === 'assistant' && entry.isApiErrorMessage !== true && entry.message?.stop_reason === 'end_turn'
        && typeof entry.uuid === 'string' && nativeSession.test(entry.uuid)) {
        checkpoint = entry.uuid;
        awaitingReply = false;
        refused = false;
      } else if (checkpoint && entry.type === 'user') {
        const content = entry.message?.content;
        if (entry.isCompactSummary === true || (Array.isArray(content) && content.some(block => block?.type === 'tool_result'))) checkpoint = undefined;
        else if (entry.isMeta !== true) {
          if (awaitingReply) checkpoint = undefined;
          awaitingReply = true;
        }
      } else if (checkpoint && entry.type === 'assistant') {
        const content = entry.message?.content;
        if (!awaitingReply || entry.message?.stop_reason !== 'refusal'
          || (Array.isArray(content) && content.some(block => block?.type === 'tool_use'))) checkpoint = undefined;
        else if (entry.isApiErrorMessage === true) {
          awaitingReply = false;
          refused = true;
        }
      } else if (entry.type === 'system' && entry.subtype === 'compact_boundary') checkpoint = undefined;
    }
    return refused && !awaitingReply ? checkpoint : undefined;
  } catch { /* An unrecognized or missing transcript leaves native resume in control. */ }
  finally { if (fd !== undefined) closeSync(fd); }
}

export class ClaudeRuntime implements Runtime {
  constructor(private readonly config: Config, private readonly profile: AgentProfile, private readonly bin?: string) {}

  run(r: RunRequest): Promise<RunResult> { return this.execute(r, false); }

  async extractMemory(input: AutoMemoryInput, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new RuntimeError('cancelled');
    const cwd = await mkdtemp(join(tmpdir(), 'namo-claude-memory-'));
    try {
      const { text } = await this.execute({ cwd, prompt: JSON.stringify(input), signal, onThread() {}, onTurn() {} }, true);
      if (text.length > 30_000) throw new RuntimeError('memory_extraction_invalid');
      return JSON.parse(text);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  private async execute(r: RunRequest, extracting: boolean): Promise<RunResult> {
    if (r.signal.aborted) throw new RuntimeError('cancelled');
    if (!this.bin) throw new RuntimeError('claude_binary_missing');
    const gateway = this.config.agents?.profiles[this.profile.id]?.gateway;
    if (this.profile.gateway && !gateway) throw new RuntimeError('claude_gateway_unavailable');
    if (gateway) prepareClaudeHome(this.config.dataDir, this.profile.home);
    else if (!existsSync(this.profile.home) || !privateClaudeHome(this.config.dataDir, this.profile.home))
      throw new RuntimeError('claude_login_required');
    const threadId = r.threadId ?? randomUUID(), turnId = randomUUID();
    if (!nativeSession.test(threadId)) throw new RuntimeError('claude_session_invalid');
    const policy = extracting ? undefined : filePolicy(this.config, this.profile.home, r.cwd);
    const directories = policy?.directories ?? [];
    const commandTools = r.taskId && policy;
    const model = r.model === undefined ? readAgentModel(this.profile) : r.model;
    const settings = {
      disableAllHooks: true,
      permissions: {
        deny: policy?.deny ?? [], blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true,
        ...(commandTools ? { allow: ['Bash'] } : {}),
      },
      ...(commandTools ? { sandbox: commandSandbox(policy, r.cwd, this.config.codex.networkAccess === true) } : {}),
    };
    const args = ['--print', '--restricted', '--safe-mode', '--no-chrome', '--strict-mcp-config',
      '--permission-mode', extracting ? 'dontAsk' : 'acceptEdits', '--permission-prompts', 'none',
      '--tools', commandTools ? 'Read,Glob,Grep,Edit,Write,Bash' : '', '--disallowed-tools', 'mcp__*', '--settings', JSON.stringify(settings),
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      r.threadId ? '--resume' : '--session-id', threadId];
    const checkpoint = gateway && r.threadId ? refusalCheckpoint(this.profile.home, r.cwd, threadId) : undefined;
    if (checkpoint) args.push('--resume-session-at', checkpoint);
    if (model) args.push('--model', model);
    if (directories.length) args.push('--add-dir', ...directories);
    if (extracting) args.push('--no-session-persistence', '--disable-slash-commands', '--system-prompt', memorySystemPrompt);

    const content: unknown[] = [{ type: 'text', text: r.prompt }];
    for (const image of r.images ?? []) {
      const bytes = verifyImageInput(this.config.dataDir, image);
      content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: bytes.toString('base64') } });
    }
    const input = JSON.stringify({ type: 'user', session_id: threadId, parent_tool_use_id: null, message: { role: 'user', content } }) + '\n';
    return new Promise<RunResult>((resolve, reject) => {
      const env = claudeEnvironment(this.profile.home, gateway);
      if (extracting) env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      if (commandTools) {
        env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
        env.GIT_CONFIG_GLOBAL = '/dev/null';
        env.GIT_CONFIG_NOSYSTEM = '1';
        env.GIT_TERMINAL_PROMPT = '0';
      }
      const child = spawn(this.bin!, args, { cwd: r.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
      const decoder = new StringDecoder('utf8');
      const commands = new Map<string, NonNullable<ReturnType<typeof evidenceItem>>>();
      let buffered = '', result: { text: string; failed: boolean } | undefined;
      let refused = false;
      let failure: RuntimeError | undefined, killTimer: NodeJS.Timeout | undefined;
      const stop = (error: RuntimeError) => {
        if (failure) return;
        failure = error;
        terminate(child, 'SIGTERM');
        killTimer = setTimeout(() => terminate(child, 'SIGKILL'), 1000);
      };
      const cancel = () => stop(new RuntimeError('cancelled'));
      const timeout = extracting ? setTimeout(() => stop(new RuntimeError('memory_extraction_timeout')), Math.min(this.profile.timeoutMs, 55_000))
        : setTimeout(() => stop(new RuntimeError('turn_timeout')), this.profile.timeoutMs);
      r.signal.addEventListener('abort', cancel, { once: true });
      child.once('spawn', () => {
        try { r.onProcess?.(child.pid!); }
        catch { stop(new RuntimeError('claude_runtime_callback_failed')); }
      });
      child.once('error', () => stop(new RuntimeError('claude_spawn_failed')));
      child.stdin.on('error', () => { /* Exit status and the result record determine the outcome. */ });
      child.stdout.on('error', () => stop(new RuntimeError('claude_protocol_failed')));
      child.stdout.on('data', (chunk: Buffer) => {
        if (failure) return;
        buffered += decoder.write(chunk);
        try {
          for (let next = buffered.indexOf('\n'); next !== -1; next = buffered.indexOf('\n')) {
            if (next > maxOutputLine) throw new RuntimeError('claude_output_limit');
            consume(buffered.slice(0, next));
            buffered = buffered.slice(next + 1);
          }
          if (buffered.length > maxOutputLine) throw new RuntimeError('claude_output_limit');
        } catch (error) { stop(error instanceof RuntimeError ? error : new RuntimeError('claude_protocol_failed')); }
      });
      function consume(line: string): void {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event.type === 'system' && event.subtype === 'init') {
          if (event.session_id !== threadId) throw new RuntimeError('claude_session_mismatch');
          r.onActivity?.('working');
          if (isModelId(event.model)) { r.onModel?.(event.model); r.onRuntimeModel?.(event.model); }
        } else if (event.type === 'assistant') {
          // The CLI surfaces streaming refusals here even when its result envelope calls them invalid requests.
          if (event.message?.stop_reason === 'refusal') refused = true;
          const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
          const tool = blocks.some((item: { type?: string } | null) => item?.type === 'tool_use' || item?.type === 'server_tool_use');
          if (extracting && tool) throw new RuntimeError('memory_extraction_tool_rejected');
          r.onActivity?.(tool ? 'tool' : 'answering');
          if (commandTools && r.onEvidence && !event.isReplay) {
            for (const item of blocks) {
              if (item?.type !== 'tool_use' || item.name !== 'Bash') continue;
              const command = evidenceItem({ id: item.id, type: 'commandExecution', status: 'inProgress',
                command: item.input?.command });
              if (!command) continue;
              // Claude's Bash process can change its working directory between calls.
              delete command.cwd;
              if (commands.size < 60) commands.set(item.id, command);
              r.onEvidence(command);
            }
          }
        } else if (event.type === 'user' && !event.isReplay && commands.size && Array.isArray(event.message?.content)) {
          for (const item of event.message.content) {
            if (item?.type !== 'tool_result') continue;
            const command = commands.get(item.tool_use_id);
            if (!command) continue;
            commands.delete(item.tool_use_id);
            r.onEvidence?.({ ...command, status: item.is_error === true ? 'failed' : 'completed' });
          }
        } else if (event.type === 'result') {
          if (event.session_id !== threadId) throw new RuntimeError('claude_session_mismatch');
          if (result) throw new RuntimeError('claude_protocol_failed');
          result = { failed: event.is_error !== false || event.subtype !== 'success',
            text: typeof event.result === 'string' ? event.result : '' };
        }
      }
      child.once('close', code => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        r.signal.removeEventListener('abort', cancel);
        if (failure) return reject(failure);
        try {
          consume(buffered + decoder.end());
          if (refused) throw new RuntimeError('claude_response_refused');
          if (code !== 0 || !result || result.failed || !result.text.trim()) throw new RuntimeError('claude_turn_failed');
          r.onThread(threadId);
          r.onTurn(turnId);
          resolve({ threadId, turnId, text: result.text });
        } catch (error) { reject(error instanceof RuntimeError ? error : new RuntimeError('claude_protocol_failed')); }
      });
      if (r.signal.aborted) cancel();
      child.stdin.end(input);
    });
  }
}
