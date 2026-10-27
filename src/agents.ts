import { probeClaudeAgent, probeCursorAcp, type AgentProbeReport } from './agent-probes.js';
import { agentCodexConfig, selectAgent, getAgentRegistry, type AgentSelection } from './agent-registry.js';
import { t as tr } from './locale.js';
import { accessSync, constants, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
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
    { id: 'cursor', bin: findExecutable('agent') ? 'agent' : 'cursor-agent', kind: 'local-cli' as const, supported: false },
    { id: 'claude', bin: 'claude', kind: 'local-cli' as const, supported: false },
    { id: 'openclaw', bin: 'openclaw', kind: 'gateway' as const, supported: false }].map(a => {
    const path = findExecutable(a.bin);
    // Discovery must not execute an arbitrary PATH command or inherit host
    // credentials. Explicit profile probes own bounded protocol/version checks.
    return { id: a.id, kind: a.kind, supported: a.supported, path: path ? realpathSync(path) : undefined, installed: !!path };
  });
}
export function runtimeFor(config: Config, profile?: string | AgentSelection): Runtime {
  return new CodexRuntime(agentCodexConfig(config, typeof profile === 'string' ? selectAgent(config, profile) : profile));
}
export async function probeAgent(source: Config, profileId?: string): Promise<Check[]> {
  let c: Config;
  try { c = {...source, codex: agentCodexConfig(source, selectAgent(source, profileId))}; }
  catch { return [{id:'agent.profile',status:'fail',message:tr("agents.selectedExecutorUnavailableDisabledMissingNoFallback")}]; }
  const checks: Check[] = [];
  const path = findExecutable(c.codex.bin);
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
  if (c.codex.defaultProject) {
    const cwd = c.codex.projects?.[c.codex.defaultProject];
    checks.push({ id: 'agent.project', status: cwd && existsSync(cwd) ? 'ok' : 'fail', message: cwd ? tr("cli.workingDirectory", cwd) : tr("agents.defaultProjectNotFound") });
  } else checks.push({ id: 'agent.project', status: 'warn', message: tr("agents.noProjectConfiguredUsingIsolatedSessionDirectory"), next: tr("agents.runNamoInitSelectProject") });
  return checks;
}
export async function loginAgent(source: Config, profileId?: string): Promise<void> {
  const c = {...source, codex:agentCodexConfig(source, selectAgent(source, profileId))};
  const path = findExecutable(c.codex.bin); if (!path) throw new Error(tr("agents.codexNotFoundInstallOfficialCodexCli"));
  mkdirSync(c.codex.home, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    const p = spawn(path, ['login'], { env: codexEnvironment(c.codex.home), stdio: 'inherit' });
    p.once('error', () => reject(new Error(tr("agents.codexLoginProcessCouldNotStart"))));
    p.once('exit', code => code === 0 ? resolve() : reject(new Error(tr("agents.codexLoginIncompleteRunNamoLoginAgain"))));
  });
}
export async function liveAgentTest(c: Config, profileId?: string): Promise<boolean> {
  const cwd = c.codex.defaultProject && c.codex.projects?.[c.codex.defaultProject] || join(c.dataDir, 'workspaces', 'health');
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

/** Discovery and authentication evidence never enables an unimplemented runtime. */
export async function probeAgentProfile(c: Config, profileId?: string): Promise<{profileId:string;adapter:string;checks?:Check[];report?:AgentProbeReport}> {
  const registry=getAgentRegistry(c), profile=registry.profiles.find(p=>p.id===(profileId??registry.defaultProfile));
  if(!profile)throw new Error('agent_profile_unavailable');
  if(profile.adapter==='codex')return {profileId:profile.id,adapter:profile.adapter,checks:await probeAgent(c,profile.id)};
  const options={bin:profile.bin,home:profile.home,configDir:join(profile.home,'config')};
  return {profileId:profile.id,adapter:profile.adapter,report:profile.adapter==='claude'?await probeClaudeAgent(options):await probeCursorAcp(options)};
}
