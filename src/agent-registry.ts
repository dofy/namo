import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from './config.js';

export type AgentAdapter = 'codex' | 'claude' | 'cursor';
export interface AgentProfileInput { adapter: AgentAdapter; enabled?: boolean; bin?: string; model?: string; timeoutMs?: number }
export interface AgentRegistryInput { defaultProfile?: string; memoryProfile?: 'codex'; profiles?: Record<string, AgentProfileInput> }
export interface AgentRegistryConfig { defaultProfile: string; memoryProfile: 'codex'; profiles: Record<string, AgentProfileInput> }
export interface AgentSelection { profileId: string; adapter: AgentAdapter; revision: string }
export interface AgentProfile extends AgentSelection { id: string; enabled: boolean; bin: string; home: string; model?: string; timeoutMs: number; available: boolean }
export type AgentConfig = Pick<Config, 'dataDir' | 'codex' | 'agents'>;
export class AgentRegistryError extends Error { constructor(readonly code: string) { super(code); } }
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Kept byte-compatible with pre-registry tasks and native Codex sessions. */
export function legacyPolicyHash(c?: Config['codex']): string {
  return hash(c ? { agent: 'codex', sandbox: c.sandbox, network: c.networkAccess ?? false,
    commits: c.allowLocalCommits ?? false, read: c.readPaths ?? [], deny: c.denyPaths ?? [], home: c.home, bin: c.bin, model: c.model } : {});
}
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
export function parseAgentRegistry(value: unknown, configDir: string): AgentRegistryConfig | undefined {
  if (value === undefined) return;
  if (!object(value) || Object.keys(value).some(k => !['defaultProfile','memoryProfile','profiles'].includes(k))) throw new AgentRegistryError('agent_registry_invalid');
  if (value.memoryProfile !== undefined && value.memoryProfile !== 'codex') throw new AgentRegistryError('memory_agent_not_supported');
  if (value.profiles !== undefined && !object(value.profiles)) throw new AgentRegistryError('agent_profiles_invalid');
  const profiles: Record<string, AgentProfileInput> = {};
  for (const [id, p] of Object.entries(value.profiles ?? {}) as [string, any][]) {
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(id) || ['codex','constructor','prototype','__proto__'].includes(id)) throw new AgentRegistryError('agent_profile_id_invalid');
    if (!object(p) || Object.keys(p).some(k => !['adapter','enabled','bin','model','timeoutMs'].includes(k)) || !['codex','claude','cursor'].includes(p.adapter)) throw new AgentRegistryError('agent_profile_invalid');
    if (p.enabled !== undefined && typeof p.enabled !== 'boolean') throw new AgentRegistryError('agent_enabled_invalid');
    for (const key of ['bin','model']) if (p[key] !== undefined && (typeof p[key] !== 'string' || !p[key].trim() || p[key].length > 4096 || /[\x00-\x1f]/.test(p[key]))) throw new AgentRegistryError('agent_option_invalid');
    if (p.timeoutMs !== undefined && (!Number.isSafeInteger(p.timeoutMs) || p.timeoutMs < 1000 || p.timeoutMs > 7200000)) throw new AgentRegistryError('agent_timeout_invalid');
    profiles[id] = { adapter: p.adapter, enabled: p.enabled !== false,
      ...(p.bin ? { bin: p.bin.includes('/') || p.bin.includes('\\') ? p.bin.startsWith('~/') ? resolve(homedir(),p.bin.slice(2)) : resolve(configDir, p.bin) : p.bin } : {}),
      ...(p.model ? { model: p.model } : {}), ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}) };
  }
  const defaultProfile = value.defaultProfile ?? 'codex';
  if (typeof defaultProfile !== 'string' || (defaultProfile !== 'codex' && !Object.hasOwn(profiles, defaultProfile))) throw new AgentRegistryError('agent_default_missing');
  if (defaultProfile !== 'codex' && (!profiles[defaultProfile].enabled || profiles[defaultProfile].adapter !== 'codex')) throw new AgentRegistryError('agent_default_unavailable');
  return { defaultProfile, memoryProfile: 'codex', profiles };
}
export function getAgentRegistry(c: AgentConfig): { defaultProfile: string; memoryProfile: 'codex'; profiles: AgentProfile[] } {
  const profile = (id: string, p: AgentProfileInput): AgentProfile => {
    const legacy = id === 'codex';
    const v = { id, profileId: id, adapter: p.adapter, enabled: legacy || p.enabled !== false,
      bin: legacy ? c.codex.bin : p.bin ?? ({codex:'codex',claude:'claude',cursor:'agent'}[p.adapter]),
      home: legacy ? c.codex.home : join(c.dataDir, 'agents', id),
      model: legacy ? c.codex.model : p.model, timeoutMs: legacy ? c.codex.timeoutMs : p.timeoutMs ?? c.codex.timeoutMs,
      available: p.adapter === 'codex' };
    // No credentials or inherited environment in the persisted selection fingerprint.
    return { ...v, revision: hash(v) };
  };
  return { defaultProfile: c.agents?.defaultProfile ?? 'codex', memoryProfile: 'codex',
    profiles: [profile('codex',{adapter:'codex'}), ...Object.entries(c.agents?.profiles ?? {}).map(([id,p]) => profile(id,p))] };
}
export function resolveAgent(c: AgentConfig, selection?: AgentSelection): AgentProfile {
  const registry = getAgentRegistry(c), id = selection?.profileId ?? registry.defaultProfile;
  const p = registry.profiles.find(p => p.id === id);
  if (!p || !p.enabled) throw new AgentRegistryError('agent_profile_unavailable');
  if (!p.available) throw new AgentRegistryError('agent_adapter_unavailable');
  if (selection && (selection.adapter !== p.adapter || selection.revision !== p.revision)) throw new AgentRegistryError('agent_configuration_changed');
  return p;
}
export function selectAgent(c: AgentConfig, profileId?: string): AgentSelection {
  const p = profileId === undefined ? resolveAgent(c) : getAgentRegistry(c).profiles.find(p => p.id === profileId);
  if (!p || !p.enabled) throw new AgentRegistryError('agent_profile_unavailable');
  if (!p.available) throw new AgentRegistryError('agent_adapter_unavailable');
  return { profileId: p.id, adapter: p.adapter, revision: p.revision };
}
export function agentCodexConfig(c: AgentConfig, selection?: AgentSelection): Config['codex'] {
  const p = resolveAgent(c, selection);
  if (p.adapter !== 'codex') throw new AgentRegistryError('agent_adapter_unavailable');
  return { ...c.codex, bin: p.bin, home: p.home, model: p.model, timeoutMs: p.timeoutMs };
}
export function selectedPolicyHash(c: AgentConfig, selection: AgentSelection): string {
  const config = agentCodexConfig(c, selection);
  return selection.profileId === 'codex' ? legacyPolicyHash(config) : hash({ selection, policy: legacyPolicyHash(config) });
}
export function agentSessionKey(workstream: string, selection?: AgentSelection): string {
  // Legacy namespace must stay readable; new profiles never consume legacy native IDs.
  return !selection || selection.profileId === 'codex' ? `workstream:${workstream}`
    : `agent:${selection.adapter}:${selection.profileId}:${selection.revision}:workstream:${workstream}`;
}
