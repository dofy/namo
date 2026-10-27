import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

export type ProbeStatus = 'supported' | 'unverified' | 'unavailable';

export interface ProbeAssessment {
  status: ProbeStatus;
  evidence: string;
}

export type AgentCapability =
  | 'sessionNew'
  | 'sessionLoad'
  | 'cancel'
  | 'revision'
  | 'userInput'
  | 'permissionRequest'
  | 'externalWait';

export interface AgentProbeReport {
  adapter: 'claude' | 'cursor-acp';
  executable?: string;
  version?: string;
  installed: ProbeAssessment;
  protocol: ProbeAssessment;
  auth: ProbeAssessment;
  processCleanup: ProbeAssessment;
  components?: {
    sdk: ProbeAssessment & { version?: string };
  };
  capabilities: Record<AgentCapability, ProbeAssessment>;
}

export interface CommonProbeOptions {
  bin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  home?: string;
  path?: string;
}

export interface ClaudeProbeOptions extends CommonProbeOptions {
  sdkPackageJson?: string;
  configDir?: string;
}

export interface CursorProbeOptions extends CommonProbeOptions {
  configDir?: string;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const PROBE_ENV_ALLOWLIST = [
  'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'PATHEXT', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP', 'USER',
] as const;

interface CommandResult {
  kind: 'completed' | 'timeout' | 'output_limit' | 'spawn_error';
  exitCode: number | null;
  stdout: string;
  stderrPresent: boolean;
}

interface AcpResult {
  kind: 'initialized' | 'timeout' | 'output_limit' | 'spawn_error' | 'early_exit' | 'malformed_json' | 'protocol_error';
  protocolVersion?: number;
  loadSession?: boolean;
  authMethodCursorLogin?: boolean;
}

const CAPABILITIES: AgentCapability[] = [
  'sessionNew', 'sessionLoad', 'cancel', 'revision', 'userInput', 'permissionRequest', 'externalWait',
];

function assessment(status: ProbeStatus, evidence: string): ProbeAssessment {
  return { status, evidence };
}

function unavailableCapabilities(evidence: string): Record<AgentCapability, ProbeAssessment> {
  return Object.fromEntries(CAPABILITIES.map(id => [id, assessment('unavailable', evidence)])) as Record<AgentCapability, ProbeAssessment>;
}

function unverifiedCapabilities(prefix: string): Record<AgentCapability, ProbeAssessment> {
  return Object.fromEntries(CAPABILITIES.map(id => [id, assessment('unverified', `${prefix}_${id}`)])) as Record<AgentCapability, ProbeAssessment>;
}

function limits(options: CommonProbeOptions): { timeoutMs: number; maxOutputBytes: number } {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? options.timeoutMs! : DEFAULT_PROBE_TIMEOUT_MS;
  const maxOutputBytes = Number.isSafeInteger(options.maxOutputBytes) ? options.maxOutputBytes! : DEFAULT_MAX_OUTPUT_BYTES;
  if (timeoutMs < 50 || timeoutMs > 30_000) throw new Error('probe_timeout_out_of_range');
  if (maxOutputBytes < 1_024 || maxOutputBytes > 1024 * 1024) throw new Error('probe_output_limit_out_of_range');
  return { timeoutMs, maxOutputBytes };
}

function executablePath(bin: string, pathValue: string): string | undefined {
  const candidates = bin.includes('/') || bin.includes('\\')
    ? [resolve(bin)]
    : pathValue.split(delimiter).filter(Boolean).map(part => join(part, process.platform === 'win32' ? `${bin}.exe` : bin));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      // An absent or non-executable candidate is expected during discovery.
    }
  }
  return undefined;
}

function safeEnvironment(options: CommonProbeOptions, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PROBE_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (options.home !== undefined) env.HOME = options.home;
  if (options.path !== undefined) env.PATH = options.path;
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function processCleanupAssessment(): ProbeAssessment {
  return process.platform === 'win32'
    ? assessment('unverified', 'windows_child_only_cleanup')
    : assessment('supported', 'posix_process_group_cleanup');
}

function killProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Fall through when the group is already gone or could not be created.
    }
  }
  if (!child.killed) child.kill('SIGKILL');
}

async function runBounded(
  bin: string,
  args: string[],
  options: CommonProbeOptions,
  extraEnv: Record<string, string | undefined> = {},
  cwd?: string,
): Promise<CommandResult> {
  const { timeoutMs, maxOutputBytes } = limits(options);
  return new Promise(resolveResult => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, args, {
        cwd, env: safeEnvironment(options, extraEnv), shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch {
      resolveResult({ kind: 'spawn_error', exitCode: null, stdout: '', stderrPresent: false });
      return;
    }
    let stdout = Buffer.alloc(0);
    let outputBytes = 0;
    let stderrPresent = false;
    let forced: CommandResult['kind'] | undefined;
    let settled = false;
    let settleTimer: NodeJS.Timeout | undefined;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (settleTimer) clearTimeout(settleTimer);
      resolveResult({ kind: forced ?? 'completed', exitCode: code, stdout: forced ? '' : stdout.toString('utf8'), stderrPresent });
    };
    const stop = (kind: CommandResult['kind']) => {
      if (settled || forced) return;
      forced = kind;
      killProcessTree(child);
      settleTimer = setTimeout(() => settle(null), 250);
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const count = (length: number) => {
      outputBytes += length;
      if (outputBytes > maxOutputBytes) stop('output_limit');
    };
    child.stdout.on('data', (chunk: Buffer) => {
      count(chunk.length);
      if (!forced) stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrPresent ||= chunk.length > 0;
      count(chunk.length);
    });
    child.once('error', () => stop('spawn_error'));
    child.once('close', code => settle(code));
    child.stdin.on('error', () => { /* An early stdin close must not become an uncaught EPIPE. */ });
    child.stdin.end();
  });
}

function parseClaudeVersion(text: string): string | undefined {
  return text.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1];
}

function parseCursorVersion(text: string): string | undefined {
  return text.match(/\b(\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7,40})\b/i)?.[1];
}

function probeSdkPackage(path: string | undefined): ProbeAssessment & { version?: string } {
  if (!path) return { ...assessment('unverified', 'claude_sdk_manifest_not_provided') };
  try {
    if (statSync(path).size > 64 * 1024) return { ...assessment('unavailable', 'claude_sdk_manifest_too_large') };
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; version?: unknown };
    if (manifest.name !== '@anthropic-ai/claude-agent-sdk' || typeof manifest.version !== 'string') {
      return { ...assessment('unavailable', 'claude_sdk_identity_mismatch') };
    }
    const version = parseClaudeVersion(manifest.version);
    return version
      ? { ...assessment('supported', 'claude_sdk_manifest_verified'), version }
      : { ...assessment('unavailable', 'claude_sdk_version_invalid') };
  } catch {
    return { ...assessment('unavailable', 'claude_sdk_manifest_unreadable') };
  }
}

function installedFailure(kind: CommandResult['kind'], prefix: string): ProbeAssessment {
  if (kind === 'timeout') return assessment('unverified', `${prefix}_version_timeout`);
  if (kind === 'output_limit') return assessment('unverified', `${prefix}_version_output_limit`);
  if (kind === 'spawn_error') return assessment('unavailable', `${prefix}_spawn_failed`);
  return assessment('unverified', `${prefix}_identity_unverified`);
}

export async function probeClaudeAgent(options: ClaudeProbeOptions = {}): Promise<AgentProbeReport> {
  limits(options);
  const pathValue = options.path ?? process.env.PATH ?? '';
  const executable = executablePath(options.bin ?? 'claude', pathValue);
  const sdk = probeSdkPackage(options.sdkPackageJson);
  if (!executable) {
    return {
      adapter: 'claude', installed: assessment('unavailable', 'claude_executable_not_found'),
      protocol: assessment('unavailable', 'claude_protocol_not_probed'),
      auth: assessment('unavailable', 'claude_auth_not_probed'), components: { sdk },
      processCleanup: processCleanupAssessment(),
      capabilities: unavailableCapabilities('claude_not_installed'),
    };
  }
  const isolatedRoot = mkdtempSync(join(tmpdir(), 'namo-claude-probe-'));
  const isolatedHome = join(isolatedRoot, 'home');
  const isolatedConfig = join(isolatedRoot, 'config');
  mkdirSync(isolatedHome, { mode: 0o700 });
  mkdirSync(isolatedConfig, { mode: 0o700 });
  const isolatedOptions = { ...options, home: isolatedHome };
  try {
    const claudeEnv = { CLAUDE_CONFIG_DIR: isolatedConfig };
    const versionResult = await runBounded(executable, ['--version'], isolatedOptions, claudeEnv);
    const version = versionResult.kind === 'completed' && versionResult.exitCode === 0 && /Claude Code/i.test(versionResult.stdout)
      ? parseClaudeVersion(versionResult.stdout) : undefined;
    const installed = version
      ? assessment('supported', 'claude_version_verified')
      : installedFailure(versionResult.kind, 'claude');

    let protocol = assessment('unavailable', 'claude_protocol_surface_missing');
    if (version) {
      const help = await runBounded(executable, ['--help'], isolatedOptions, claudeEnv);
      if (help.kind !== 'completed') protocol = assessment('unverified', `claude_help_${help.kind}`);
      else {
        const flags = ['--print', '--input-format', '--output-format', '--resume', '--permission-mode'];
        protocol = flags.every(flag => help.stdout.includes(flag))
          ? assessment('unverified', 'claude_stream_json_surface_detected')
          : assessment('unavailable', 'claude_stream_json_surface_incomplete');
      }
    }

    const dedicatedProfileSelected = options.home !== undefined && options.configDir !== undefined;
    let auth = dedicatedProfileSelected
      ? assessment('unverified', 'claude_auth_not_probed_unverified_identity')
      : assessment('unverified', 'claude_dedicated_profile_not_selected');
    if (version && dedicatedProfileSelected) {
      auth = assessment('unverified', 'claude_auth_status_unrecognized');
      const authResult = await runBounded(executable, ['auth', 'status', '--json'], options,
        { CLAUDE_CONFIG_DIR: options.configDir });
      if (authResult.kind !== 'completed') auth = assessment('unverified', `claude_auth_${authResult.kind}`);
      else {
        try {
          const parsed = JSON.parse(authResult.stdout) as { loggedIn?: unknown };
          auth = parsed.loggedIn === true
            ? authResult.exitCode === 0 ? assessment('supported', 'claude_auth_logged_in') : assessment('unverified', 'claude_auth_status_failed')
            : parsed.loggedIn === false
              ? assessment('unavailable', 'claude_auth_not_logged_in')
              : auth;
        } catch {
          // Never surface the raw status payload.
        }
      }
    }

    const capabilities = unverifiedCapabilities('claude_live_validation_required');
    capabilities.externalWait = assessment('unavailable', 'claude_durable_wait_not_validated');
    return { adapter: 'claude', executable, version, installed, protocol, auth,
      processCleanup: processCleanupAssessment(), components: { sdk }, capabilities };
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

async function runCursorInitialize(bin: string, options: CursorProbeOptions): Promise<AcpResult> {
  const { timeoutMs, maxOutputBytes } = limits(options);
  const root = mkdtempSync(join(tmpdir(), 'namo-cursor-probe-'));
  const isolatedHome = join(root, 'home');
  const isolatedConfig = join(root, 'config');
  mkdirSync(isolatedHome, { mode: 0o700 });
  mkdirSync(isolatedConfig, { mode: 0o700 });
  const isolatedOptions = { ...options, home: isolatedHome };
  try {
    return await new Promise(resolveResult => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(bin, ['acp'], {
          cwd: root,
          env: safeEnvironment(isolatedOptions, { CURSOR_CONFIG_DIR: isolatedConfig }),
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
      } catch {
        resolveResult({ kind: 'spawn_error' });
        return;
      }
      let bytes = 0;
      let buffer = '';
      let forced: AcpResult['kind'] | undefined;
      let response: AcpResult | undefined;
      let settled = false;
      let settleTimer: NodeJS.Timeout | undefined;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (settleTimer) clearTimeout(settleTimer);
        resolveResult(response ?? { kind: forced ?? 'early_exit' });
      };
      const stop = (kind: AcpResult['kind']) => {
        if (forced || response) return;
        forced = kind;
        killProcessTree(child);
        settleTimer = setTimeout(settle, 250);
      };
      const finishResponse = (result: AcpResult) => {
        if (forced || response) return;
        response = result;
        killProcessTree(child);
        settleTimer = setTimeout(settle, 250);
      };
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const count = (length: number) => {
        bytes += length;
        if (bytes > maxOutputBytes) stop('output_limit');
      };
      child.stderr.on('data', (chunk: Buffer) => count(chunk.length));
      child.stdout.on('data', (chunk: Buffer) => {
        count(chunk.length);
        if (forced || response) return;
        buffer += chunk.toString('utf8');
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line) continue;
          let message: { id?: unknown; result?: unknown; error?: unknown };
          try {
            message = JSON.parse(line) as typeof message;
          } catch {
            stop('malformed_json');
            return;
          }
          if (message.id !== 1) continue;
          if (message.error !== undefined) {
            stop('protocol_error');
            return;
          }
          const result = message.result as {
            protocolVersion?: unknown;
            agentCapabilities?: { loadSession?: unknown };
            authMethods?: Array<{ id?: unknown }>;
          } | undefined;
          finishResponse({
            kind: 'initialized',
            protocolVersion: typeof result?.protocolVersion === 'number' ? result.protocolVersion : undefined,
            loadSession: result?.agentCapabilities?.loadSession === true,
            authMethodCursorLogin: result?.authMethods?.some(method => method?.id === 'cursor_login') === true,
          });
          return;
        }
      });
      child.once('error', () => stop('spawn_error'));
      child.once('close', settle);
      child.stdin.on('error', () => stop('early_exit'));
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'namo-compat-probe', version: '0.1.0' },
        },
      })}\n`);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function cursorAuth(text: string, exitCode: number | null): ProbeAssessment {
  text = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  if (/\b(?:unauthenticated|not authenticated|not logged in|logged out|please log in|login required)\b/i.test(text)) {
    return assessment('unavailable', 'cursor_auth_not_logged_in');
  }
  if (exitCode === 0 && /^(?:[✓✔●]\s*)?(?:(?:Status|Authentication):\s*)?(?:(?:You are )?authenticated(?: with Cursor)?(?: as .+)?|(?:You are )?logged in(?: as .+)?)[.!]?\s*$/im.test(text)) return assessment('supported', 'cursor_auth_logged_in');
  return exitCode === 0
    ? assessment('unverified', 'cursor_auth_status_unrecognized')
    : assessment('unavailable', 'cursor_auth_status_failed');
}

export async function probeCursorAcp(options: CursorProbeOptions = {}): Promise<AgentProbeReport> {
  limits(options);
  const pathValue = options.path ?? process.env.PATH ?? '';
  const executable = options.bin
    ? executablePath(options.bin, pathValue)
    : executablePath('agent', pathValue) ?? executablePath('cursor-agent', pathValue);
  if (!executable) {
    return {
      adapter: 'cursor-acp', installed: assessment('unavailable', 'cursor_executable_not_found'),
      protocol: assessment('unavailable', 'cursor_acp_not_probed'),
      auth: assessment('unavailable', 'cursor_auth_not_probed'),
      processCleanup: processCleanupAssessment(),
      capabilities: unavailableCapabilities('cursor_not_installed'),
    };
  }
  const isolatedRoot = mkdtempSync(join(tmpdir(), 'namo-cursor-version-probe-'));
  const isolatedHome = join(isolatedRoot, 'home');
  const isolatedConfig = join(isolatedRoot, 'config');
  mkdirSync(isolatedHome, { mode: 0o700 });
  mkdirSync(isolatedConfig, { mode: 0o700 });
  const isolatedOptions = { ...options, home: isolatedHome, configDir: isolatedConfig };
  try {
    const versionResult = await runBounded(executable, ['--version'], isolatedOptions,
      { CURSOR_CONFIG_DIR: isolatedConfig });
    const version = versionResult.kind === 'completed' && versionResult.exitCode === 0
      ? parseCursorVersion(versionResult.stdout) : undefined;
    const installed = version
      ? assessment('supported', 'cursor_version_verified')
      : installedFailure(versionResult.kind, 'cursor');

    let protocol = assessment('unavailable', 'cursor_acp_not_probed');
    let acp: AcpResult | undefined;
    if (version) {
      acp = await runCursorInitialize(executable, isolatedOptions);
      protocol = acp.kind === 'initialized' && acp.protocolVersion === 1 && acp.authMethodCursorLogin
        ? assessment('supported', 'cursor_acp_initialize_v1')
        : acp.kind === 'timeout' || acp.kind === 'output_limit'
          ? assessment('unverified', `cursor_acp_${acp.kind}`)
          : assessment('unavailable', `cursor_acp_${acp.kind}`);
    }

    const dedicatedProfileSelected = options.home !== undefined && options.configDir !== undefined;
    let auth = dedicatedProfileSelected
      ? assessment('unverified', 'cursor_auth_not_probed_unverified_identity')
      : assessment('unverified', 'cursor_dedicated_profile_not_selected');
    if (version && dedicatedProfileSelected) {
      const status = await runBounded(executable, ['status'], options, { CURSOR_CONFIG_DIR: options.configDir });
      auth = status.kind === 'completed'
        ? cursorAuth(status.stdout, status.exitCode)
        : assessment('unverified', `cursor_auth_${status.kind}`);
    }

    const capabilities = unverifiedCapabilities('cursor_live_validation_required');
    if (acp?.kind === 'initialized' && acp.loadSession) {
      capabilities.sessionLoad = assessment('unverified', 'cursor_acp_load_session_advertised_only');
    }
    capabilities.externalWait = assessment('unavailable', 'cursor_durable_wait_not_validated');
    return { adapter: 'cursor-acp', executable, version, installed, protocol, auth,
      processCleanup: processCleanupAssessment(), capabilities };
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
}
