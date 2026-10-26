import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

test('project configuration resolves cwd and enforces service credential exclusions', t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'project'));
  const file = join(root, 'config.json');
  const base = { codex: { projects: { app: './project' }, defaultProject: 'app', networkAccess: true, sandbox: 'workspace-write' } };
  const save = (c: unknown) => writeFileSync(file, JSON.stringify(c));
  save(base); const config = loadConfig(file);
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
