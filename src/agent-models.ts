import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import { getAgentRegistry, type AgentConfig, type AgentProfile } from './agent-registry.js';
import { atomicText } from './paths.js';
import { pathsOverlap } from './path-policy.js';
import { acquireLock } from './safety.js';

export class AgentModelError extends Error {}

export function isModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,127}$/.test(value);
}

function modelFile(agent: AgentProfile): string {
  return agent.adapter === 'claude' ? join(agent.home, '.claude', 'settings.json') : join(agent.home, 'config.toml');
}

function readFile(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error();
    return readFileSync(fd, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new AgentModelError('无法安全读取 Agent 的隔离配置。');
  } finally { if (fd !== undefined) closeSync(fd); }
}

function settings(agent: AgentProfile, raw: string): Record<string, unknown> {
  try {
    const value = agent.adapter === 'claude' ? JSON.parse(raw) : parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)
      && (!Object.hasOwn(value, 'model') || value.model === '' || isModelId(value.model))) return value;
  } catch { /* The original settings file remains untouched. */ }
  throw new AgentModelError('Agent 的隔离配置或模型 ID 格式无效。');
}

function legacyMarker(agent: AgentProfile): string { return join(agent.home, '.namo-model-migrated'); }

export function readAgentModel(agent: AgentProfile): string | undefined {
  const raw = readFile(modelFile(agent));
  const configured = raw === undefined ? undefined : settings(agent, raw).model as string | undefined;
  return configured || (readFile(legacyMarker(agent)) === undefined && isModelId(agent.model) ? agent.model : undefined);
}

function codexSettings(raw: string, original: Record<string, unknown>, model: string): string {
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const expected = { ...original };
  delete expected.model;
  if (model) expected.model = model;
  const line = model ? 'model = ' + JSON.stringify(model) + newline : '';
  if (!Object.hasOwn(original, 'model')) return line + raw;
  // Locate the top-level assignment by comparing the complete parsed document.
  // The same key can also occur in tables or inside a multiline string.
  for (const match of raw.matchAll(/^[\t ]*(?:model|"model"|'model')[\t ]*=[\t ]*(?:"(?:\\.|[^"\r\n])*"|'[^'\r\n]*')[\t ]*(#[^\r\n]*)?(?:\r?\n|$)/gm)) {
    const comment = match[1] ? match[1] + newline : '';
    const candidate = raw.slice(0, match.index) + comment + line + raw.slice(match.index + match[0].length);
    try { if (isDeepStrictEqual({ ...parse(candidate) }, expected)) return candidate; } catch { /* Try the next matching key. */ }
  }
  throw new AgentModelError('无法安全定位 Codex 配置中的 model 字段。');
}

function nativeDirectory(agent: AgentProfile): void {
  const parent = dirname(modelFile(agent));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!lstatSync(agent.home).isDirectory() || !lstatSync(parent).isDirectory()
    || ['.codex', '.claude'].some(name => {
      const personal = join(homedir(), name);
      try { return pathsOverlap(realpathSync(parent), realpathSync(personal)); }
      catch { return pathsOverlap(realpathSync(parent), personal); }
    })) throw new AgentModelError('模型只能写入 Namo 隔离的 Agent 配置目录。');
}

function writeModel(agent: AgentProfile, model: string): void {
  const file = modelFile(agent);
  const previous = readFile(file);
  const raw = previous ?? (agent.adapter === 'claude' ? '{}' : '');
  const original = settings(agent, raw);
  if (original.model === (model || undefined)) return;
  nativeDirectory(agent);
  let next: string;
  if (agent.adapter === 'codex') next = codexSettings(raw, original, model);
  else {
    if (model) original.model = model;
    else delete original.model;
    next = JSON.stringify(original, null, 2) + '\n';
  }
  if (readFile(file) !== previous) throw new AgentModelError('隔离配置已被修改，请刷新后重试。');
  atomicText(file, next);
}

export function saveAgentModel(config: AgentConfig, agent: AgentProfile, value: unknown, expected?: string, verify?: () => void): string {
  if (value !== '' && !isModelId(value)) throw new AgentModelError('请输入有效的模型 ID，留空可恢复运行时默认。');
  const unlock = acquireLock(join(config.dataDir, 'config-edit.lock'));
  try {
    verify?.();
    if (expected !== undefined && (readAgentModel(agent) ?? '') !== expected) throw new AgentModelError('模型已被修改，请刷新后重试。');
    writeModel(agent, value);
    if (readFile(legacyMarker(agent)) === undefined) {
      nativeDirectory(agent);
      atomicText(legacyMarker(agent), '1\n', true);
    }
    return value;
  } finally { unlock(); }
}

export function migrateAgentModels(config: AgentConfig, onFailure?: (profile: string) => void): void {
  for (const agent of getAgentRegistry(config).profiles) {
    if (!agent.enabled) continue;
    try {
      if (readFile(legacyMarker(agent)) !== undefined) continue;
      // Keep explicit native values. The marker prevents a later reset from
      // restoring the legacy setting while old configuration backups exist.
      const model = readAgentModel(agent) ?? '';
      saveAgentModel(config, agent, model, model);
    } catch (error) {
      if (!onFailure) throw error;
      onFailure(agent.id);
    }
  }
}
