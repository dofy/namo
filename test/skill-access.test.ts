import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readSkillSettings, skillReadDirectories, skillSettingsOverride, SkillAccessError, type SkillCatalog } from '../src/skill-access.js';
import { connectCodex } from '../src/runtime.js';
import type { Config } from '../src/config.js';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-skills-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const user = join(dir, 'user'), personal = join(user, '.codex'), home = join(dir, 'data', 'codex-home');
  mkdirSync(personal, { recursive: true }); mkdirSync(home, { recursive: true });
  const skill = (root: string) => { mkdirSync(root, { recursive: true }); const path = join(root, 'SKILL.md'); writeFileSync(path, '---\nname: fixture\ndescription: test\n---\n'); return realpathSync(path); };
  const policy: Config['codex'] = { bin: 'codex', home, sandbox: 'read-only', timeoutMs: 1000,
    denyPaths: [dirname(home), home], explicitDenyPaths: [] };
  const catalog = (skills: { path: string; enabled: boolean }[]): SkillCatalog => ({ data: [{ cwd: dir, skills, errors: [] }] });
  return { dir, user, personal, home, skill, policy, catalog };
}

test('only per-skill settings are merged, personal opt-outs survive bot opt-ins and aliases', t => {
  const f = fixture(t), path = f.skill(join(f.personal, 'skills', 'disabled'));
  const alias = join(f.user, '.agents', 'skills', 'disabled'); mkdirSync(dirname(alias), { recursive: true }); symlinkSync(dirname(path), alias);
  const original = `[mcp_servers.private]\nurl = "https://example.invalid/?secret=PRIVATE_TEST"\n[[skills.config]]\npath = ${JSON.stringify(join(alias, 'SKILL.md'))}\nenabled = false\n`;
  writeFileSync(join(f.personal, 'config.toml'), original);
  writeFileSync(join(f.home, 'config.toml'), `[[skills.config]]\npath = ${JSON.stringify(dirname(path))}\nenabled = true\n`);
  const settings = readSkillSettings(f.home, f.personal);
  assert.deepEqual(settings, [{ path, enabled: false }]);
  assert.equal(skillSettingsOverride(settings).join(' ').includes('PRIVATE_TEST'), false);
  assert.equal(readFileSync(join(f.personal, 'config.toml'), 'utf8'), original);
});

test('malformed settings fail closed without exposing config or TOML parser details', t => {
  const f = fixture(t);
  for (const content of ['private = "PRIVATE_SECRET', '[skills]\nconfig = "PRIVATE_SECRET"', '[[skills.config]]\npath = 4']) {
    writeFileSync(join(f.personal, 'config.toml'), content);
    assert.throws(() => readSkillSettings(f.home, f.personal), error => error instanceof SkillAccessError
      && error.message === 'skills_settings_invalid' && !String(error).includes('PRIVATE_SECRET'));
  }
});

test('only enabled canonical skill leaves are readable, including isolated system and plugin skills', t => {
  const f = fixture(t), shared = f.skill(join(f.personal, 'skills', 'shared'));
  const alias = join(f.user, '.agents', 'skills', 'alias'); mkdirSync(dirname(alias), { recursive: true }); symlinkSync(dirname(shared), alias);
  const system = f.skill(join(f.home, 'skills', '.system', 'system'));
  const plugin = f.skill(join(f.home, 'plugins', 'cache', 'market', 'plugin', 'v1', 'skills', 'leaf'));
  const disabled = f.skill(join(f.personal, 'skills', 'disabled'));
  const entries = [shared, join(alias, 'SKILL.md'), system, plugin, disabled].map(path => ({ path, enabled: true }));
  assert.deepEqual(skillReadDirectories(f.catalog(entries), [{ path: disabled, enabled: false }], f.policy, f.user),
    [dirname(shared), dirname(system), dirname(plugin)].sort());
});

test('discovery cannot grant HOME, state/cache parents, credential aliases, or explicitly denied skills', t => {
  const f = fixture(t), broad = [f.user, f.personal, f.home, join(f.home, 'plugins', 'cache'), join(f.user, '.agents', 'skills')].map(f.skill);
  const direct = f.skill(join(f.user, 'Documents'));
  const privateSkill = f.skill(join(dirname(f.home), 'private'));
  const denied = f.skill(join(f.personal, 'skills', 'denied'));
  const auth = join(f.home, 'auth.json'); writeFileSync(auth, 'PRIVATE_AUTH');
  const alias = join(f.personal, 'skills', 'credential-alias', 'SKILL.md'); mkdirSync(dirname(alias), { recursive: true }); symlinkSync(auth, alias);
  const policy = { ...f.policy, explicitDenyPaths: [dirname(denied)], denyPaths: [...f.policy.denyPaths!, dirname(denied)] };
  assert.deepEqual(skillReadDirectories(f.catalog([...broad, direct, privateSkill, denied, alias].map(path => ({ path, enabled: true }))), [], policy, f.user), []);
  assert.deepEqual(skillReadDirectories({ data: [{ cwd: f.dir, skills: [], errors: [{}] }] }, [], policy, f.user), []);
  assert.throws(() => skillReadDirectories({ data: null } as unknown as SkillCatalog, [], policy, f.user), SkillAccessError);
});

test('the runtime uses the discovered leaf grant and passes opt-outs to the official process', async t => {
  const f = fixture(t), enabled = f.skill(join(f.dir, 'installed-skills', 'enabled')), disabled = f.skill(join(f.dir, 'installed-skills', 'disabled'));
  writeFileSync(join(f.home, 'config.toml'), `[[skills.config]]\npath = ${JSON.stringify(disabled)}\nenabled = false\n`);
  const bin = join(f.dir, 'codex.mjs');
  writeFileSync(bin, `#!${process.execPath}
import {createInterface} from 'node:readline';
const send=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 if(m.method==='plugin/list')return process.stdout.write(JSON.stringify({id:m.id,error:{code:-32603,message:'catalog offline'}})+'\\n');
 if(m.method==='skills/list')return send(m.id,{data:[{cwd:m.params.cwds[0],skills:${JSON.stringify([{ path: enabled, enabled: true }, { path: disabled, enabled: true }])},errors:[]}]});
 if(m.method==='command/exec')return send(m.id,{exitCode:0,stdout:JSON.stringify(process.argv.slice(2)),stderr:''});
 send(m.id,{});
});`, { mode: 0o700 });
  const rpc = await connectCodex({ ...f.policy, bin }, f.dir);
  try {
    const result = await rpc.request('command/exec', { command: ['/bin/true'] });
    const args: string[] = JSON.parse(result.stdout);
    const filesystem = args.find(v => v.startsWith('permissions.feishu-bot.filesystem='))!;
    assert.ok(filesystem.includes(`${JSON.stringify(dirname(enabled))}="read"`));
    assert.equal(filesystem.includes(JSON.stringify(dirname(disabled))), false);
    assert.ok(args.some(v => v.startsWith('skills.config=') && v.includes(JSON.stringify(disabled)) && v.includes('enabled=false')));
    assert.equal(args.some(v => v.includes('mcp_servers.private')), false);
  } finally { await rpc.close(); }
});
