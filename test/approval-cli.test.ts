import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { atomicJson } from '../src/paths.js';
import { initialConfig } from '../src/onboarding.js';
import { loadConfig } from '../src/config.js';
import { Store, type Incoming } from '../src/store.js';
import { Tasks, policyHash } from '../src/tasks.js';

const git = existsSync('/usr/bin/git') ? '/usr/bin/git' : realpathSync(execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim());
const bin = resolve('bin/namo.js');
function command(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string { return execFileSync(git, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim(); }

test('local approval CLI exposes scoped JSON and requires confirmation before approve and execute', t => {
  const root = mkdtempSync(join(tmpdir(), 'namo-approval-cli-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const testGitHome = mkdtempSync(join(tmpdir(), 'namo-approval-cli-git-home-')); t.after(() => rmSync(testGitHome, { recursive: true, force: true }));
  const testEnv = { ...process.env, HOME: testGitHome, NAMO_LANG: 'en' };
  const repo = join(root, 'repo'), bare = join(root, 'remote.git'); mkdirSync(repo);
  command(root, ['init', '--bare', bare], testEnv); command(repo, ['init'], testEnv); command(repo, ['config', 'user.name', 'Test'], testEnv); command(repo, ['config', 'user.email', 'test@example.invalid'], testEnv);
  writeFileSync(join(repo, 'file.txt'), 'cli\n'); command(repo, ['add', '.'], testEnv); command(repo, ['commit', '-m', 'cli commit'], testEnv); command(repo, ['remote', 'add', 'origin', bare], testEnv);
  const file = join(root, 'config.json'), raw = initialConfig(file); raw.feishu.appId = 'cli_test'; raw.feishu.appSecret = 'test-only'; raw.feishu.allowedUserIds = ['ou_owner'];
  raw.codex.projects = { app: realpathSync(repo) }; raw.codex.defaultProject = 'app'; raw.gitApprovals = { gitBin: git, maxTtlMs: 900000, remotes: [{ name: 'origin', url: bare, transport: 'local-test' }] }; atomicJson(file, raw);
  const store = new Store(join(raw.dataDir, 'bot.sqlite')); const message: Incoming = { key: 'instruction', messageId: 'm1', chatKey: 'chat', chatId: 'chat', senderId: 'ou_owner', text: 'work' };
  store.enqueue(message); const task = new Tasks(store).create(store.get(message.key)!, { project: 'app', cwd: realpathSync(repo), policyHash: policyHash(loadConfig(file).codex) }); store.db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(task.id); store.close();
  const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args, '--config', file], { cwd: root, encoding: 'utf8', env: testEnv });
  const requested = run('approval', 'request', task.id, 'origin', 'refs/heads/main'); assert.equal(requested.status, 0, requested.stderr); const preview = JSON.parse(requested.stdout);
  assert.equal(preview.scope.taskId, task.id); assert.equal(preview.limitedProtection, true); assert.equal(preview.target.remote, 'origin'); assert.equal('url' in preview.target, false);
  assert.equal(run('approval', 'approve', preview.id).status, 1);
  assert.equal(run('approval', 'approve', preview.id, '--confirm').status, 0);
  assert.equal(run('approval', 'execute', preview.id).status, 1);
  const executed = run('approval', 'execute', preview.id, '--confirm'); assert.equal(executed.status, 0, executed.stderr); assert.equal(JSON.parse(executed.stdout).state, 'succeeded');
  assert.equal(command(bare, ['rev-parse', 'refs/heads/main'], testEnv), command(repo, ['rev-parse', 'HEAD'], testEnv));
  raw.codex.projects = {}; delete raw.codex.defaultProject; atomicJson(file, raw);
  const removed = run('approval', 'request', task.id, 'origin', 'refs/heads/main'); assert.equal(removed.status, 1); assert.match(removed.stderr, /project was removed|path changed|项目已移除|路径已更改/i);
  const otherProject = join(root, 'other-project'); mkdirSync(otherProject); raw.codex.projects = { app: realpathSync(otherProject) }; raw.codex.defaultProject = 'app'; atomicJson(file, raw);
  const moved = run('approval', 'request', task.id, 'origin', 'refs/heads/main'); assert.equal(moved.status, 1); assert.match(moved.stderr, /project was removed|path changed|项目已移除|路径已更改/i);
  raw.codex.projects = { app: realpathSync(repo) }; raw.codex.defaultProject = 'app'; raw.codex.sandbox = 'workspace-write'; atomicJson(file, raw);
  const changed = run('approval', 'request', task.id, 'origin', 'refs/heads/main'); assert.equal(changed.status, 1); assert.match(changed.stderr, /permissions changed|权限配置已更改/i);
});

test('migrate inspect is a noninteractive metadata-only dry run', t => {
  const root = mkdtempSync(join(tmpdir(), 'namo-migrate-inspect-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'openclaw.json'); writeFileSync(source, JSON.stringify({ meta: { lastTouchedVersion: '2026.10.6' }, channels: { feishu: { appId: 'cli_fixture_1234', appSecret: 'FAKE_SOURCE_SECRET' } } }));
  const result = spawnSync(process.execPath, [bin, 'migrate', 'inspect', source, 'fixture', '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, NAMO_HOME: root, NAMO_LANG: 'en' } });
  assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout); assert.equal(report.status, 'supported'); assert.equal(report.applications.length, 1);
  assert.doesNotMatch(result.stdout, /FAKE_SOURCE_SECRET|cli_fixture_1234/);
});
