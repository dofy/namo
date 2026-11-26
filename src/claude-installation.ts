import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { agentLabel, getAgentRegistry } from './agent-registry.js';
import { findClaudeBinary } from './agents.js';
import type { Config } from './config.js';

export function claudeUpdateTargets(config: Config, hostHome: string) {
  const profiles = getAgentRegistry(config).profiles.filter(profile => profile.adapter === 'claude');
  const configured = profiles.length
    ? profiles.map(profile => ({ profileId: profile.id, label: agentLabel(profile), bin: profile.bin, home: profile.home }))
    : [{ profileId: null, label: 'Claude Code', bin: 'claude', home: join(config.dataDir, 'agents', 'claude') }];
  const seen = new Set<string>();
  return configured.flatMap(target => {
    const executable = findClaudeBinary(target.bin, hostHome);
    const path = executable ? resolve(executable) : null;
    const key = path ?? target.bin;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...target, path }];
  });
}

export function isNativeClaudeLauncher(path: string, version: string, hostHome: string): boolean {
  if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) return false;
  const local = join(hostHome, '.local');
  const launcher = join(local, 'bin', 'claude');
  try {
    // A copy or a launcher pinned to a particular version would not follow the native update.
    return basename(path) === 'claude' && realpathSync(dirname(launcher)) === realpathSync(dirname(path))
      && lstatSync(path).isSymbolicLink()
      && realpathSync(path) === join(realpathSync(join(local, 'share', 'claude', 'versions')), version);
  } catch { return false; }
}

export function matchesClaudeTarget(target: { bin: string; path: string | null }, configuredBin: string, hostHome: string): boolean {
  if (configuredBin === target.bin || configuredBin === target.path) return true;
  const executable = target.path && findClaudeBinary(configuredBin, hostHome);
  return !!executable && resolve(executable) === target.path;
}
