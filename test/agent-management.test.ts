import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Management, ManagementError } from '../src/management.js';
import { loadConfig } from '../src/config.js';
import { selectAgent, agentCodexConfig } from '../src/agent-registry.js';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-agent-management-'));
  const data = join(dir, 'data'), project = join(dir, 'project'), file = join(dir, 'config.json');
  mkdirSync(data); mkdirSync(project);
  const raw = { version: 1, agent: 'codex', dataDir: data, custom: { keep: 'untouched' },
    feishu: { appId: 'agent_management', appSecret: 'PRIVATE_AGENT_MANAGEMENT_SECRET', allowedUserIds: ['alice'], allowedChatIds: [] },
    codex: { bin: 'codex', home: join(data, 'codex-home'), projects: { app: project }, defaultProject: 'app', sandbox: 'read-only' },
    agents: { defaultProfile: 'team', memoryProfile: 'codex', profiles: {
      team: { adapter: 'codex', bin: 'codex-team', model: 'gpt-team', timeoutMs: 120000 },
      future: { adapter: 'claude', enabled: false, bin: join(dir, 'missing-claude') },
      cursor: { adapter: 'cursor', enabled: true },
    } }, concurrency: 1 };
  writeFileSync(file, JSON.stringify(raw));
  const manager = new Management(file, { status: () => ({ running: false, installed: true, registered: false, mode: 'stopped' }) });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { data, file, raw, manager };
}

test('management hides retired registry while preserving legacy Codex configuration and inactive entries on disk', t => {
  const f = fixture(t), view = f.manager.config(), before = loadConfig(f.file);
  assert.equal(view.valid, true);
  assert.equal(Object.hasOwn(view, 'agents'), false);
  assert.equal(JSON.stringify(view).includes(f.raw.feishu.appSecret), false);
  assert.deepEqual(Object.keys(before.agents!.profiles), ['team']);
  const selection = selectAgent(before);
  assert.equal(selection.profileId, 'team');
  assert.equal(agentCodexConfig(before, selection).home, join(f.data, 'agents', 'team'));
  f.manager.save(view.revision, { concurrency: 2 });
  const saved = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.deepEqual(saved.agents, f.raw.agents);
  assert.deepEqual(saved.custom, f.raw.custom);
  assert.equal(saved.feishu.appSecret, f.raw.feishu.appSecret);
  assert.deepEqual(selectAgent(loadConfig(f.file)), selection, 'unrelated saves retain native session identity');
});

test('management refuses retired agent registry writes without mutating configuration', t => {
  const f = fixture(t), revision = f.manager.config().revision, before = readFileSync(f.file, 'utf8');
  for (const agents of [null, {}, f.raw.agents, { defaultProfile: 'codex', profiles: {} }]) {
    assert.throws(() => f.manager.save(revision, { agents }), error => error instanceof ManagementError);
    assert.equal(readFileSync(f.file, 'utf8'), before);
  }
});

test('CLI exposes only Codex discovery and rejects removed registry commands without touching config', t => {
  const f = fixture(t), bin = resolve('bin/namo.js'), before = readFileSync(f.file, 'utf8');
  const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args, '--config', f.file], { encoding: 'utf8', env: { ...process.env, NAMO_LANG: 'en' } });
  const list = run('agent', 'list', '--json');
  assert.equal(list.status, 1);
  assert.match(list.stderr, /namo ui/);
  for (const command of ['profiles', 'probe', 'use']) {
    assert.equal(run('agent', command).status, 1);
    assert.equal(run('agent', command, '--profile', 'future').status, 1);
  }
  for (const lang of ['en', 'zh-CN']) {
    const help = run('--help', '--lang', lang);
    assert.equal(help.status, 0, help.stderr);
    assert.doesNotMatch(help.stdout, /agent (profiles|probe|use)|Claude|Cursor/);
  }
  assert.equal(run('login', '--profile', 'future').status, 1);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});
