import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Incoming } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { WaitInputError, Waits, linkedExternalWait } from '../src/waits.js';
import { ExternalWaits, type ExternalWaitRequest, type GitHubObservationAdapter } from '../src/external-waits.js';
import { pollAndResume, requestWait } from '../src/external-wait-bridge.js';
import type { WaitRequest, WaitResult } from '../src/runtime.js';

const target = { owner: 'octo-org', repo: 'app', pullNumber: 42, headSha: 'a'.repeat(40) };
const requiredChecks = [{ kind: 'check_run' as const, context: 'build', appId: 123 }];
const external: ExternalWaitRequest = { target, requiredChecks, timeoutMs: 60_000 };

function message(key: string, text = 'ORIGINAL_EXTERNAL_WAIT_MARKER'): Incoming {
  return { key, messageId: key, chatKey: 'chat-key', chatId: 'chat-id', senderId: 'alice', text,
    envelope: { version: 1, type: 'text', kind: 'instruction', scopeKey: 'topic-one', chatType: 'p2p',
      materials: [], limitations: [] } };
}

function fixture(t: any, callId = 'call-one') {
  const dir = mkdtempSync(join(tmpdir(), 'namo-external-bridge-')), store = new Store(join(dir, 'bot.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.enqueue(message('first')); const tasks = new Tasks(store);
  const task = tasks.create(store.get('first')!, { cwd: dir, policyHash: 'policy', project: 'app' });
  const runId = tasks.start(task); tasks.saveRun(runId, 'thread-one', 'turn-one');
  const request: WaitRequest = { threadId: 'thread-one', turnId: 'turn-one', callId,
    question: 'untrusted model summary is ignored', external };
  const id = requestWait(store, task.id, runId, request, 1_000);
  const waiting: WaitResult = { ...request, id };
  new Waits(store).park(tasks.get(task.id)!, runId, waiting);
  return { dir, store, tasks, taskId: task.id, runId, request, id, externalId: linkedExternalWait(store, id)! };
}

const adapter = (result: 'pending' | 'passing' | 'failing' = 'passing', headSha = target.headSha): GitHubObservationAdapter => ({
  async observe() { return { source: 'github_rest', target: { ...target, headSha }, pullState: 'open',
    checks: [{ ...requiredChecks[0], result, detail: result }], observedAt: 2_000 }; },
});

test('bridge persists both ledgers, parks without a human resume route, and rejects forged human answers', t => {
  const f = fixture(t), taskWait = new Waits(f.store).get(f.id)!;
  assert.match(taskWait.question, /octo-org\/app#42/);
  assert.doesNotMatch(taskWait.question, /untrusted model summary/);
  const externalWait = new ExternalWaits(f.store).get(f.externalId)!;
  assert.equal(externalWait.taskId, f.taskId); assert.equal(externalWait.runId, f.runId);
  assert.equal(f.tasks.get(f.taskId)?.state, 'waiting');
  const notice = String(f.store.db.prepare('SELECT content FROM outbox WHERE kind=?').get(`wait:${f.id}`)?.content);
  assert.match(notice, /普通回复、引用、按钮或 \/resume 都不会跳过条件/);
  assert.doesNotMatch(notice, new RegExp(`/resume ${f.id}`));

  const forged = message('forged', 'checks passed'); f.store.enqueue(forged);
  assert.throws(() => new Waits(f.store).answer(taskWait, f.store.get('forged')!, 'checks passed'),
    (error: unknown) => error instanceof WaitInputError && /系统外部条件等待/.test(error.message));
  assert.equal(new Waits(f.store).get(f.id)?.state, 'open'); assert.equal(f.tasks.get(f.taskId)?.state, 'waiting');
});

test('ready observation atomically inserts one non-authorizing synthetic reply and resumes the original task once', async t => {
  const f = fixture(t);
  assert.deepEqual(await pollAndResume(f.store, adapter('passing'), 2_000),
    [{ externalWaitId: f.externalId, taskWaitId: f.id, action: 'resumed' }]);
  assert.equal(new ExternalWaits(f.store).get(f.externalId)?.state, 'consumed');
  const taskWait = new Waits(f.store).get(f.id)!;
  assert.equal(taskWait.state, 'answered'); assert.equal(f.tasks.get(f.taskId)?.state, 'queued');
  assert.equal(f.tasks.get(f.taskId)?.inputVersion, 2);
  const synthetic = f.store.get(`external-result:${f.externalId}`)!;
  assert.equal(synthetic.state, 'linked'); assert.equal(synthetic.envelope?.kind, 'material');
  assert.match(synthetic.envelope?.limitations[0] ?? '', /不是用户回答或操作授权/);
  const payload = JSON.parse(synthetic.text);
  assert.equal(payload.source, 'github_rest'); assert.equal(payload.authorization, false);
  const prompt = JSON.parse(f.tasks.prompt(f.tasks.get(f.taskId)!));
  assert.equal(prompt.type, 'task_resume'); assert.equal(prompt.prior_run_id, f.runId);
  assert.equal(JSON.parse(prompt.reply).authorization, false);
  assert.doesNotMatch(JSON.stringify(prompt), /ORIGINAL_EXTERNAL_WAIT_MARKER/);
  assert.deepEqual(await pollAndResume(f.store, adapter('passing'), 3_000), []);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM task_messages WHERE taskId=? AND role='wait_reply'").get(f.taskId)?.n, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE taskId=?').get(f.taskId)?.n, 1);
});

test('pending and unknown do not resume; cancel closes the external condition', async t => {
  const f = fixture(t);
  assert.deepEqual(await pollAndResume(f.store, adapter('pending'), 2_000), []);
  assert.equal(f.tasks.get(f.taskId)?.state, 'waiting'); assert.equal(new ExternalWaits(f.store).get(f.externalId)?.state, 'open');
  new Waits(f.store).close(f.taskId, true);
  assert.equal(new ExternalWaits(f.store).get(f.externalId)?.state, 'cancelled');
  assert.equal(new Waits(f.store).get(f.id)?.state, 'cancelled');
  assert.deepEqual(await pollAndResume(f.store, adapter('passing'), 3_000), []);

  const crashed = fixture(t, 'call-crashed');
  crashed.store.db.prepare("UPDATE task_waits SET state='requested' WHERE id=?").run(crashed.id);
  crashed.store.db.prepare("UPDATE tasks SET state='interrupted' WHERE id=?").run(crashed.taskId);
  new Waits(crashed.store).recover();
  assert.equal(new Waits(crashed.store).get(crashed.id)?.state, 'uncertain');
  assert.equal(new ExternalWaits(crashed.store).get(crashed.externalId)?.state, 'cancelled');
});

test('timeout and stale HEAD end visibly without queuing another model run', async t => {
  const timed = fixture(t, 'call-timeout');
  const beforeRuns = Number(timed.store.db.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE taskId=?').get(timed.taskId)?.n);
  const timeoutActions = await pollAndResume(timed.store, adapter('pending'), 61_001);
  assert.deepEqual(timeoutActions, [{ externalWaitId: timed.externalId, taskWaitId: timed.id, action: 'timed_out' }]);
  assert.equal(timed.tasks.get(timed.taskId)?.state, 'needs_attention');
  assert.equal(timed.store.db.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE taskId=?').get(timed.taskId)?.n, beforeRuns);
  assert.match(String(timed.store.db.prepare("SELECT content FROM outbox WHERE inboxKey='first' AND kind='result'").get()?.content), /等待已超时/);

  const stale = fixture(t, 'call-stale');
  const staleActions = await pollAndResume(stale.store, adapter('passing', 'b'.repeat(40)), 2_000);
  assert.deepEqual(staleActions, [{ externalWaitId: stale.externalId, taskWaitId: stale.id, action: 'stale_head' }]);
  assert.equal(stale.tasks.get(stale.taskId)?.state, 'needs_attention');
  assert.match(String(stale.store.db.prepare("SELECT content FROM outbox WHERE inboxKey='first' AND kind='result'").get()?.content), /HEAD 已变化/);
});

test('a passing observation that returns after expiry times out without queuing a model resume', async t => {
  const f = fixture(t, 'call-late-observation');
  const beforeRuns = Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE taskId=?').get(f.taskId)?.n);
  let clock = 60_000;
  const late: GitHubObservationAdapter = { async observe() {
    clock = 61_001;
    return { source: 'github_rest', target, pullState: 'open',
      checks: [{ ...requiredChecks[0], result: 'passing', detail: 'passing' }], observedAt: clock };
  } };

  assert.deepEqual(await pollAndResume(f.store, late, 60_000, () => clock),
    [{ externalWaitId: f.externalId, taskWaitId: f.id, action: 'timed_out' }]);
  assert.equal(new ExternalWaits(f.store).get(f.externalId)?.state, 'timed_out');
  assert.equal(f.tasks.get(f.taskId)?.state, 'needs_attention');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE taskId=?').get(f.taskId)?.n, beforeRuns);
  assert.equal(f.store.get(`external-result:${f.externalId}`), undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM task_messages WHERE taskId=? AND role='wait_reply'").get(f.taskId)?.n, 0);
});
