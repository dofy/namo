import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { initialConfig } from '../src/onboarding.js';

test('project configuration resolves cwd and enforces service credential exclusions', t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'project'));
  const file = join(root, 'config.json');
  const base = { codex: { projects: { app: './project' }, defaultProject: 'app', networkAccess: true, sandbox: 'workspace-write' } };
  const save = (c: unknown) => writeFileSync(file, JSON.stringify(c));
  save(base); const config = loadConfig(file);
  assert.equal(config.concurrency, 8);
  assert.equal(initialConfig(file).concurrency,8);
  for(const value of [1,2,3]) {save({...base,concurrency:value}); assert.equal(loadConfig(file).concurrency,4);}
  for(const value of [4,8,64]) {save({...base,concurrency:value}); assert.equal(loadConfig(file).concurrency,value);}
  for(const value of [0,65,2.5]) {save({...base,concurrency:value}); assert.throws(()=>loadConfig(file));}
  save(base);
  assert.equal(config.codex.projects?.app, realpathSync(join(root, 'project')));
  assert.equal(config.codex.networkAccess, true);
  assert.equal(config.codex.allowLocalCommits, false);
  assert.ok(config.codex.denyPaths?.includes(file));
  assert.ok(config.codex.denyPaths?.includes(join(root, 'data')));
  save({ codex: { ...base.codex, defaultProject: 'missing' } }); assert.throws(() => loadConfig(file));
  save({ codex: { ...base.codex, projects: { app: homedir() } } }); assert.throws(() => loadConfig(file));
  save({ codex: { ...base.codex, projects: { app: '/' } } }); assert.throws(() => loadConfig(file));
  save({ codex: { ...base.codex, networkAccess: 'true' } }); assert.throws(() => loadConfig(file));
  save({ codex: { ...base.codex, allowLocalCommits: 'true' } }); assert.throws(() => loadConfig(file));
  save({ codex: { ...base.codex, allowLocalCommits: true, sandbox: 'read-only' } }); assert.throws(() => loadConfig(file));
  save({ codex: { ...base.codex, allowLocalCommits: true } }); assert.equal(loadConfig(file).codex.allowLocalCommits, true);
});

test('git approval configuration defaults closed and validates explicit targets without exposing credentials', t => {
  const root = mkdtempSync(join(tmpdir(), 'namo-approval-config-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'config.json'); const save = (value: unknown) => writeFileSync(file, JSON.stringify(value));
  save({}); assert.deepEqual(loadConfig(file).gitApprovals, { gitBin: undefined, sshCommand: undefined, maxTtlMs: 900000, remotes: [] });
  save({ gitApprovals: { gitBin: '/usr/bin/git', maxTtlMs: 60000, remotes: [{ name: 'origin', url: 'https://example.invalid/org/repo.git', transport: 'https', credentialHelpers: ['osxkeychain'] }] } });
  const configured = loadConfig(file).gitApprovals!; assert.equal(configured.gitBin, '/usr/bin/git'); assert.equal(configured.remotes.length, 1); assert.deepEqual(configured.remotes[0]?.credentialHelpers, ['osxkeychain']);
  save({ gitApprovals: { remotes: [{ name: 'origin', url: 'x', transport: 'ext' }] } }); assert.throws(() => loadConfig(file), /remote/);
  save({ gitApprovals: { remotes: [{ name: 'origin', url: 'x', transport: 'https' }, { name: 'origin', url: 'y', transport: 'https' }] } }); assert.throws(() => loadConfig(file), /unique/);
  save({ gitApprovals: { maxTtlMs: 999 } }); assert.throws(() => loadConfig(file), /maxTtlMs/);
});
