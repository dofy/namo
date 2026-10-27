import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalService } from '../src/approval-service.js';
import { ExecFileGitRunner } from '../src/approvals.js';
import type { Config } from '../src/config.js';
import type { Incoming } from '../src/store.js';
import { Store } from '../src/store.js';
import { Tasks, policyHash } from '../src/tasks.js';

const git = existsSync('/usr/bin/git') ? '/usr/bin/git' : realpathSync(execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim());
const revision = 'c'.repeat(64);
const isolatedContexts = new WeakSet<object>();
function isolateGitHome(t: { after(fn: () => void): void }): void {
  if (isolatedContexts.has(t)) return;
  isolatedContexts.add(t);
  const originalGitHome = process.env.HOME;
  const testGitHome = mkdtempSync(join(tmpdir(), 'namo-approval-service-git-home-'));
  process.env.HOME = testGitHome;
  t.after(() => {
    if (originalGitHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalGitHome;
    rmSync(testGitHome, { recursive: true, force: true });
  });
}
function command(cwd: string, args: string[]): string { return execFileSync(git, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function incoming(key: string, text: string, chatType: 'p2p' | 'group' = 'p2p'): Incoming {
  return { key, messageId: `m-${key}`, chatKey: 'chat-owner', chatId: 'chat-owner', senderId: 'ou_owner', text,
    envelope: { version: 1, type: 'message', kind: 'instruction', chatType, scopeKey: 'chat-owner', materials: [], limitations: [] } };
}
function fixture(t: { after(fn: () => void): void }) {
  isolateGitHome(t);
  const root = mkdtempSync(join(tmpdir(), 'namo-approval-service-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), bare = join(root, 'remote.git'), data = join(root, 'data'); mkdirSync(repo); mkdirSync(data);
  command(root, ['init', '--bare', bare]); command(repo, ['init']); command(repo, ['config', 'user.name', 'Test']); command(repo, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(repo, 'file.txt'), 'content\n'); command(repo, ['add', '.']); command(repo, ['commit', '-m', 'service commit']); command(repo, ['branch', '-M', 'main']); command(repo, ['remote', 'add', 'origin', bare]);
  const store = new Store(join(data, 'bot.sqlite')); t.after(() => store.close());
  const config: Config = { file: join(root, 'config.json'), dataDir: data, concurrency: 1, agent: 'codex',
    feishu: { appId: 'cli_test', appSecret: 'test-only', allowedUserIds: ['ou_owner'], allowedChatIds: [], requireMention: true, domain: 'feishu' },
    codex: { bin: 'codex', home: join(data, 'codex-home'), timeoutMs: 600000, sandbox: 'read-only', projects: { app: realpathSync(repo) }, defaultProject: 'app', networkAccess: false, readPaths: [], denyPaths: [], allowLocalCommits: false },
    gitApprovals: { gitBin: git, maxTtlMs: 900000, remotes: [{ name: 'origin', url: bare, transport: 'local-test' }] } };
  const instruction = incoming('instruction', 'make commit'); store.enqueue(instruction);
  const task = new Tasks(store).create(store.get(instruction.key)!, { project: 'app', cwd: realpathSync(repo), policyHash: policyHash(config.codex) });
  store.db.prepare("UPDATE tasks SET state='succeeded',finishedAt=? WHERE id=?").run(Date.now(), task.id); store.db.prepare("UPDATE inbox SET state='replied' WHERE key=?").run(instruction.key);
  let currentRevision = revision;
  const service = new ApprovalService(store, config, revision, () => currentRevision, new ExecFileGitRunner(git)); service.start();
  const dispatch = async (message: Incoming, target = service) => {
    store.enqueue(message); assert.equal(target.handleControl(message), true); await target.idle();
    return (store.db.prepare("SELECT content FROM outbox WHERE inboxKey=? AND kind='result'").get(message.key) as { content: string }).content;
  };
  const send = async (key: string, text: string, chatType: 'p2p' | 'group' = 'p2p') => {
    return dispatch(incoming(key, text, chatType));
  };
  return { root, repo, bare, store, task, config, service, send, dispatch, setCurrentRevision(value: string) { currentRevision = value; } };
}

test('verified private control commands durably request, approve, execute, and report without a model run', async t => {
  const f = fixture(t); const request = JSON.parse(await f.send('request', `/push-request ${f.task.id} origin refs/heads/main`));
  assert.match(request.id, /^AP-[A-F0-9]{12}$/); assert.equal(request.state, 'pending'); assert.equal(request.limitedProtection, true); assert.equal(request.scope.taskId, f.task.id);
  const result = JSON.parse(await f.send('approve', `/push-approve ${request.id} --confirm`));
  assert.equal(result.state, 'succeeded'); assert.equal(command(f.bare, ['rev-parse', 'refs/heads/main']), command(f.repo, ['rev-parse', 'HEAD']));
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM task_runs').get() as { n: number }).n, 0);
  assert.equal(JSON.parse(await f.send('status', `/push-status ${request.id}`)).state, 'succeeded');
  const duplicate = await f.send('approve-again', `/push-approve ${request.id} --confirm`); assert.match(duplicate, /不能重复 push|不是可执行状态/);
});

test('group, malformed, foreign-task, and unconfigured remote commands fail before execution', async t => {
  const f = fixture(t);
  assert.match(await f.send('group', `/push-request ${f.task.id} origin refs/heads/main`, 'group'), /只接受已配对本人的私聊/);
  assert.match(await f.send('bad', `/push-approve AP-123456789ABC`), /用法/);
  const foreign = incoming('foreign-instruction', 'other'); foreign.senderId = 'ou_other'; foreign.chatKey = 'chat-other'; foreign.chatId = 'chat-other'; foreign.envelope!.scopeKey = 'chat-other'; f.store.enqueue(foreign);
  const foreignTask = new Tasks(f.store).create(f.store.get(foreign.key)!, { project: 'app', cwd: realpathSync(f.repo), policyHash: policyHash(f.config.codex) });
  f.store.db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(foreignTask.id);
  assert.match(await f.send('foreign', `/push-request ${foreignTask.id} origin refs/heads/main`), /只能为本人/);
  assert.match(await f.send('missing-remote', `/push-request ${f.task.id} nowhere refs/heads/main`), /administrator-approved target list|预配置/);
  assert.throws(() => command(f.bare, ['rev-parse', 'refs/heads/main']));
});

test('control jobs remain queued until the enclosing acceptance transaction commits', async t => {
  const f = fixture(t), message = incoming('transaction-boundary', `/push-request ${f.task.id} origin refs/heads/main`);
  f.store.transaction(() => {
    f.store.enqueue(message);
    assert.equal(f.service.handleControl(message), true);
    const row = f.store.db.prepare('SELECT state FROM approval_jobs WHERE inboxKey=?').get(message.key)!;
    assert.equal(row.state, 'queued');
  });
  await Promise.resolve();
  await f.service.idle();
  const output = f.store.db.prepare("SELECT content FROM outbox WHERE inboxKey=? AND kind='result'").get(message.key) as { content: string };
  assert.equal(JSON.parse(output.content).state, 'pending');
});

test('current project path and permission policy are revalidated after service restart', async t => {
  const removed = fixture(t); await removed.service.idle();
  const removedConfig = structuredClone(removed.config); removedConfig.codex.projects = { ...(removedConfig.codex.projects ?? {}) }; delete removedConfig.codex.projects.app;
  const removedService = new ApprovalService(removed.store, removedConfig, revision, () => revision, new ExecFileGitRunner(git)); removedService.start();
  assert.match(await removed.dispatch(incoming('removed-project', `/push-request ${removed.task.id} origin refs/heads/main`), removedService), /项目已移除|路径已更改/);

  const moved = fixture(t); await moved.service.idle();
  const otherProject = join(moved.root, 'other-project'); mkdirSync(otherProject);
  const movedConfig = structuredClone(moved.config); movedConfig.codex.projects = { ...(movedConfig.codex.projects ?? {}), app: realpathSync(otherProject) };
  const movedService = new ApprovalService(moved.store, movedConfig, revision, () => revision, new ExecFileGitRunner(git)); movedService.start();
  assert.match(await moved.dispatch(incoming('moved-project', `/push-request ${moved.task.id} origin refs/heads/main`), movedService), /项目已移除|路径已更改/);

  const changed = fixture(t); await changed.service.idle();
  const changedConfig = structuredClone(changed.config); changedConfig.codex.sandbox = 'workspace-write';
  const changedService = new ApprovalService(changed.store, changedConfig, revision, () => revision, new ExecFileGitRunner(git)); changedService.start();
  assert.match(await changed.dispatch(incoming('changed-policy', `/push-request ${changed.task.id} origin refs/heads/main`), changedService), /权限配置已更改/);
});

test('hot configuration is rejected until reload and creates no request', async t => {
  const f = fixture(t); f.setCurrentRevision('d'.repeat(64));
  assert.match(await f.send('hot-config', `/push-request ${f.task.id} origin refs/heads/main`), /重启服务加载最新审批策略/);
  assert.equal((f.store.db.prepare("SELECT COUNT(*) AS n FROM git_approvals").get() as { n: number }).n, 0);
});

test('another paired user cannot trigger an already approved record', async t => {
  const f = fixture(t), request = JSON.parse(await f.send('owner-request', `/push-request ${f.task.id} origin refs/heads/main`));
  f.service.approvals.approve(request.id, { ownerId: 'ou_owner', chatKey: 'chat-owner', authority: 'local-management' });
  f.config.feishu.allowedUserIds.push('ou_other');
  const other = incoming('other-approve', `/push-approve ${request.id} --confirm`); other.senderId = 'ou_other'; other.chatKey = 'chat-other'; other.chatId = 'chat-other'; other.envelope!.scopeKey = 'chat-other';
  assert.match(await f.dispatch(other), /审批不属于当前用户和聊天/);
  assert.equal(f.service.approvals.get(request.id)?.state, 'approved');
  assert.throws(() => command(f.bare, ['rev-parse', 'refs/heads/main']));
});
