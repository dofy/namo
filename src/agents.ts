import { agentCodexConfig, resolveAgent, selectAgent, type AgentProfile, type AgentSelection } from './agent-registry.js';
import { t as tr } from './locale.js';
import { accessSync, constants, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { Config } from './config.js';
import { CodexRuntime, probeRuntime, RuntimeError, type Runtime } from './runtime.js';
import { codexEnvironment } from './safety.js';
import { resolveCodexBinary } from './codex-installation.js';
import { homedir } from 'node:os';
import { CLAUDE_MIN_VERSION, ClaudeRuntime, claudeAuthenticated, claudeEnvironment, claudeVersion, prepareClaudeHome } from './claude-runtime.js';

export interface AgentInfo { id: string; kind: 'local-cli' | 'gateway'; supported: boolean; path?: string; version?: string; installed: boolean; }
export interface Check { id: string; status: 'ok' | 'warn' | 'fail'; message: string; next?: string; }
export function findExecutable(bin: string, path = process.env.PATH ?? ''): string | undefined {
  const candidates = bin.includes('/') || bin.includes('\\') ? [resolve(bin)] : path.split(delimiter).flatMap(p => process.platform === 'win32' ? [join(p, `${bin}.exe`), join(p, `${bin}.cmd`), join(p, bin)] : [join(p, bin)]);
  return candidates.find(p => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } });
}
export function detectAgents(codexBin = 'codex'): AgentInfo[] {
  return ([['codex', findExecutable(codexBin)], ['claude', findClaudeBinary('claude')]] as const).map(([id, path]) => {
    // Discovery must not execute an arbitrary PATH command or inherit host
    // credentials. Codex diagnostics own bounded protocol and account checks.
    return { id, kind: 'local-cli', supported: true, path: path ? realpathSync(path) : undefined, installed: !!path };
  });
}
export function findClaudeBinary(bin: string): string | undefined {
  return findExecutable(bin) ?? (bin === 'claude' ? findExecutable(join(homedir(), '.local', 'bin', 'claude')) : undefined);
}
export function agentLabel(profile: Pick<AgentProfile,'adapter'|'id'>): string {
  const name = profile.adapter === 'claude' ? 'Claude Code' : 'Codex';
  return (profile.adapter === 'claude' && profile.id === 'claude') || profile.id === 'codex' ? name : `${name} (${profile.id})`;
}
export function runtimeFor(config: Config, profile?: string | AgentSelection): Runtime {
  const selection = typeof profile === 'string' ? selectAgent(config, profile) : profile;
  const agent = resolveAgent(config, selection);
  if (agent.adapter === 'claude') return new ClaudeRuntime(config, agent, findClaudeBinary(agent.bin));
  return new CodexRuntime({...agentCodexConfig(config, selection), managedMcp:!!config.mcpConnections?.length});
}
export async function probeAgent(source: Config, profileId?: string): Promise<Check[]> {
  let agent: AgentProfile;
  try { agent = resolveAgent(source, selectAgent(source, profileId)); }
  catch { return [{id:'agent.profile',status:'fail',message:tr("agents.selectedExecutorUnavailableDisabledMissingNoFallback")}]; }
  if (agent.adapter === 'claude') return probeClaude(source, agent);
  const c = {...source, codex: agentCodexConfig(source, agent)};
  const checks: Check[] = [];
  const path = findExecutable(resolveCodexBinary(c.codex.bin,c.codex.home));
  if (!path) return [{ id: 'agent.binary', status: 'fail', message: tr("agents.codexExecutableNotFound"), next: tr("agents.installOfficialCodexSetItsFullPath") }];
  checks.push({ id: 'agent.binary', status: 'ok', message: `Codex：${realpathSync(path)}` });
  if (!existsSync(c.codex.home)) return [...checks, { id: 'agent.auth', status: 'fail', message: tr("agents.namosIsolatedCodexEnvironmentNotCreatedSigned"), next: tr("agents.runNamoLoginPersonalCodexCredentialsNot") }];
  try {
    const p = await probeRuntime(c.codex);
    checks.push({ id: 'agent.protocol', status: 'ok', message: tr("agents.appServerInitializationAccountRequestedPermissionSettings") });
    checks.push({ id: 'agent.auth', status: p.authenticated ? 'ok' : 'fail', message: p.authenticated ? tr("agents.codexSignedIn") : tr("agents.codexNotSignedIn"), next: p.authenticated ? undefined : tr("agents.runNamoLogin") });
  } catch (e) {
    checks.push({ id: 'agent.protocol', status: 'fail', message: tr("agents.appServerProbeFailed", e instanceof RuntimeError ? e.code : 'probe_failed'), next: tr("agents.runCodexVersionCheckInstallationProtocolBaseline") });
  }
  checks.push({id:'agent.directories',status:(c.codex.directories??[]).every(existsSync)?'ok':'fail',message:tr('directories.paths')});
  return checks;
}
async function probeClaude(config: Config, agent: AgentProfile): Promise<Check[]> {
  const bin = findClaudeBinary(agent.bin);
  if (!bin) return [{ id: 'agent.binary', status: 'fail', message: tr('claude.binaryMissing') }];
  const version = await claudeVersion(bin, agent.home).catch(() => undefined);
  if (!version) return [{ id: 'agent.binary', status: 'fail', message: tr('claude.versionRequired', CLAUDE_MIN_VERSION) }];
  const binary: Check = { id: 'agent.binary', status: 'ok', message: `Claude Code ${version}` };
  if (agent.gateway) return [binary, { id: 'agent.auth', status: 'ok', message: tr('claude.gatewayConfigured') }];
  const authenticated = await claudeAuthenticated(bin, config.dataDir, agent.home).catch(() => false);
  return [
    binary,
    { id: 'agent.auth', status: authenticated ? 'ok' : 'fail', message: tr(authenticated ? 'claude.signedIn' : 'claude.loginRequired'),
      next: authenticated ? undefined : `namo login --profile ${agent.id}` },
  ];
}
export async function loginAgent(source: Config, profileId?: string, deviceAuth = false): Promise<void> {
  const agent = resolveAgent(source, selectAgent(source, profileId));
  if (agent.adapter === 'claude') {
    if (deviceAuth) throw new Error(tr('claude.deviceAuthUnsupported'));
    if (agent.gateway) throw new Error(tr('claude.gatewayLoginNotRequired'));
    const bin = findClaudeBinary(agent.bin);
    if (!bin) throw new Error(tr('claude.binaryMissing'));
    if (!await claudeVersion(bin, agent.home).catch(() => undefined)) throw new Error(tr('claude.versionRequired', CLAUDE_MIN_VERSION));
    prepareClaudeHome(source.dataDir, agent.home);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ['auth', 'login'], { cwd: agent.home, env: claudeEnvironment(agent.home), stdio: 'inherit' });
      const failed = () => reject(new Error(tr('claude.loginRequired')));
      child.once('error', failed);
      child.once('exit', code => code === 0 ? resolve() : failed());
    });
    return;
  }
  const c = {...source, codex:agentCodexConfig(source, agent)};
  const path = findExecutable(resolveCodexBinary(c.codex.bin,c.codex.home)); if (!path) throw new Error(tr("agents.codexNotFoundInstallOfficialCodexCli"));
  mkdirSync(c.codex.home, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    const p = spawn(path, deviceAuth ? ['login', '--device-auth'] : ['login'], { env: codexEnvironment(c.codex.home), stdio: 'inherit' });
    p.once('error', () => reject(new Error(tr("agents.codexLoginProcessCouldNotStart"))));
    p.once('exit', code => code === 0 ? resolve() : reject(new Error(tr("agents.codexLoginIncompleteRunNamoLoginAgain"))));
  });
}
export async function liveAgentTest(c: Config, profileId?: string): Promise<boolean> {
  const cwd = join(c.dataDir, 'workspaces', 'health');
  mkdirSync(cwd,{recursive:true,mode:0o700});
  const result = await runtimeFor(c, profileId).run({ cwd, prompt: 'Do not call tools. Reply with exactly NAMO_AGENT_OK.', signal: new AbortController().signal, onThread() {}, onTurn() {} });
  return result.text === 'NAMO_AGENT_OK';
}
export function toolchainPaths(): string[] {
  const paths = new Set<string>();
  const node = realpathSync(process.execPath);
  if (process.platform === 'darwin' && node.startsWith('/opt/homebrew/')) paths.add('/opt/homebrew');
  else if (!node.startsWith('/usr/')) paths.add(dirname(dirname(node)));
  return [...paths];
}
