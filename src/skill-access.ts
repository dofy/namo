import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'smol-toml';
import type { Config } from './config.js';

export interface SkillSetting { path: string; enabled: boolean }
export interface SkillCatalog { data: { cwd: string; skills: { path: string; enabled: boolean }[]; errors?: unknown[] }[] }
export interface SkillAccess { settings: SkillSetting[]; directories: string[] }
export class SkillAccessError extends Error {
  constructor(readonly code: string) { super(code); }
}

const within = (parent: string, child: string): boolean => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
const canonical = (path: string): string => existsSync(path) ? realpathSync(path) : resolve(path);

/** Read only per-skill preferences; never import providers, credentials, MCP, or plugins. */
export function readSkillSettings(codexHome: string, personalHome = join(homedir(), '.codex')): SkillSetting[] {
  const merged = new Map<string, SkillSetting>();
  for (const home of new Set([personalHome, codexHome])) {
    const file = join(home, 'config.toml');
    if (!existsSync(file)) continue;
    try {
      if (statSync(file).size > 1024 * 1024) throw new Error();
      const parsed = parse(readFileSync(file, 'utf8'));
      const skills = parsed.skills;
      if (skills === undefined) continue;
      if (!skills || typeof skills !== 'object' || Array.isArray(skills)) throw new Error();
      const rules = (skills as Record<string, unknown>).config;
      if (rules === undefined) continue;
      if (!Array.isArray(rules)) throw new Error();
      for (const rule of rules) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)
          || typeof rule.path !== 'string' || !rule.path.trim()
          || (rule.enabled !== undefined && typeof rule.enabled !== 'boolean')) throw new Error();
        const expanded = rule.path.startsWith('~/') ? join(homedir(), rule.path.slice(2)) : resolve(home, rule.path);
        const path = canonical(basename(expanded) === 'SKILL.md' ? expanded : join(expanded, 'SKILL.md'));
        // A personal opt-out must not be silently re-enabled by the bot's config.
        const enabled = rule.enabled !== false && merged.get(path)?.enabled !== false;
        merged.set(path, { path, enabled });
      }
    } catch { throw new SkillAccessError('skills_settings_invalid'); }
  }
  return [...merged.values()];
}

export function skillSettingsOverride(settings: readonly SkillSetting[]): string[] {
  return settings.length ? ['-c', `skills.config=[${settings.map(s => `{path=${JSON.stringify(s.path)},enabled=${s.enabled}}`).join(',')}]`] : [];
}

/** The catalog is discovery evidence, never permission to open a parent directory. */
export function skillReadDirectories(catalog: SkillCatalog, settings: readonly SkillSetting[], policy: Config['codex'], userHome = homedir()): string[] {
  if (!Array.isArray(catalog.data)) throw new SkillAccessError('skills_catalog_invalid');
  const home = canonical(policy.home), user = canonical(userHome);
  const disabled = new Set(settings.filter(s => !s.enabled).map(s => canonical(s.path)));
  const explicitDenies = (policy.explicitDenyPaths ?? []).map(canonical);
  const denies = (policy.denyPaths ?? []).map(canonical);
  const skillAreas = [join(home, 'skills'), join(home, 'plugins', 'cache')].map(canonical);
  const directories = new Set<string>();
  for (const entry of catalog.data) {
    if (!Array.isArray(entry.skills)) throw new SkillAccessError('skills_catalog_invalid');
    for (const skill of entry.skills) {
      if (skill.enabled !== true || typeof skill.path !== 'string' || !isAbsolute(skill.path)) continue;
      try {
        const path = realpathSync(skill.path), dir = dirname(path);
        if (basename(path) !== 'SKILL.md' || !statSync(path).isFile() || disabled.has(path)) continue;
        // Reject root/HOME, state roots, generic skill/cache parents, and aliases
        // that resolve to any of those. Only an individual skill's assets are read.
        if (within(dir, user) || within(dir, home) || dirname(dir) === user
          || ['skills', '.system', 'plugins', 'cache', '.agents', '.codex'].includes(basename(dir))) continue;
        if (explicitDenies.some(p => within(p, dir) || within(dir, p))) continue;
        const inOwnSkillArea = skillAreas.some(p => p !== dir && within(p, dir));
        if (denies.some(p => (within(p, dir) || within(dir, p))
          && !(inOwnSkillArea && within(p, home)))) continue;
        directories.add(dir);
      } catch { /* A removed or invalid skill never widens access. */ }
    }
  }
  return [...directories].sort();
}
