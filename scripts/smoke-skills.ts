import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { connectCodex, RuntimeError } from '../src/runtime.js';

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

/** No inference, Feishu receiver, credential output, or changes to configuration. */
async function main(): Promise<void> {
  if (process.platform === 'win32') throw new Error('posix_probe_required');
  const config = loadConfig();
  const cwd = config.codex.projects?.[config.codex.defaultProject ?? ''] ?? process.cwd();
  const rpc = await connectCodex(config.codex, cwd);
  try {
    await rpc.request('plugin/list', { cwds: [cwd], forceRefetch: false });
    const catalog = await rpc.request('skills/list', { cwds: [cwd], forceReload: true });
    const skills = catalog.data.flatMap((entry: { skills: { name: string; path: string; enabled: boolean }[] }) => entry.skills);
    const enabled = skills.filter((s: { enabled: boolean }) => s.enabled);
    const disabled = skills.filter((s: { enabled: boolean }) => !s.enabled);
    const controls = [config.file, join(config.codex.home, 'auth.json'), join(config.codex.home, 'config.toml'),
      join(homedir(), '.codex', 'config.toml'), join(homedir(), '.ssh', 'config')].filter(existsSync);
    const parents = [homedir(), join(homedir(), '.codex'), config.codex.home].filter(existsSync);
    const commands: string[] = [];
    const read = (path: string, label: string, index: number) => commands.push(
      `if head -c 1 ${quote(path)} >/dev/null 2>/dev/null; then printf '${label}-read ${index}\\n'; else printf '${label}-blocked ${index}\\n'; fi`);
    enabled.forEach((s: { path: string }, i: number) => read(s.path, 'skill', i));
    disabled.forEach((s: { path: string }, i: number) => read(s.path, 'disabled', i));
    controls.forEach((path, i) => read(path, 'protected', i));
    parents.forEach((path, i) => commands.push(
      `if ls ${quote(path)} >/dev/null 2>/dev/null; then printf 'parent-read ${i}\\n'; else printf 'parent-blocked ${i}\\n'; fi`));
    const nonce = randomUUID();
    enabled.forEach((s: { path: string }, i: number) => {
      const marker = quote(join(dirname(s.path), `.namo-readonly-probe-${nonce}-${i}`));
      // Only a fresh, empty marker is attempted; a successful unexpected create
      // is removed immediately. Never open an existing skill file for writing.
      commands.push(`if (set -C; : > ${marker}) 2>/dev/null; then rm -f ${marker}; printf 'write-allowed ${i}\\n'; else printf 'write-blocked ${i}\\n'; fi`);
    });
    const result = await rpc.request('command/exec', { command: ['/bin/sh', '-c', commands.join('\n')], cwd,
      permissionProfile: 'feishu-bot', timeoutMs: 20000, outputBytesCap: 65536 });
    const lines: string[] = result.stdout.split('\n').filter(Boolean);
    const count = (prefix: string) => lines.filter(line => line.startsWith(prefix + ' ')).length;
    const unreadableSkillNames = lines.filter(line => line.startsWith('skill-blocked '))
      .map(line => enabled[Number(line.split(' ')[1])].name);
    const report = { inferenceTurnsStarted: 0, enabledSkills: enabled.length, readableSkills: count('skill-read'), unreadableSkillNames,
      disabledSkillNames: disabled.map((s: { name: string }) => s.name), disabledReadsBlocked: count('disabled-blocked'),
      skillWritesBlocked: count('write-blocked'), protectedReadsBlocked: count('protected-blocked'), protectedReadChecks: controls.length,
      parentListingsBlocked: count('parent-blocked'), parentListingChecks: parents.length };
    console.log(JSON.stringify(report));
    if (result.exitCode !== 0 || !enabled.length || report.readableSkills !== enabled.length
      || report.disabledReadsBlocked !== disabled.length || report.skillWritesBlocked !== enabled.length
      || report.protectedReadsBlocked !== controls.length || report.parentListingsBlocked !== parents.length) process.exitCode = 1;
  } finally { await rpc.close(); }
}

void main().catch(error => {
  console.error(JSON.stringify({ error: error instanceof RuntimeError ? error.code : 'skills_probe_failed' }));
  process.exitCode = 1;
});
