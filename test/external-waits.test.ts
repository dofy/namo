import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Incoming } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { ExternalWaitError, ExternalWaits, GitHubRestAdapter, externalWaitToolRegistration,
  type CheckObservation, type ExternalWaitContext, type GitHubObservation, type GitHubObservationAdapter,
  type GitHubTarget, type RequiredCheck } from '../src/external-waits.js';

const target: GitHubTarget = { owner: 'octo-org', repo: 'app', pullNumber: 42, headSha: 'a'.repeat(40) };
const checks: RequiredCheck[] = [
  { kind: 'check_run', context: 'build', appId: 123 },
  { kind: 'commit_status', context: 'security/scan' },
];

function input(key = 'input'): Incoming {
  return { key, messageId: key, chatKey: 'chat-key', chatId: 'chat-id', senderId: 'alice', text: 'wait for checks',
    envelope: { version: 1, type: 'text', kind: 'instruction', scopeKey: 'chat-key', chatType: 'p2p', materials: [], limitations: [] } };
}

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-external-wait-')), file = join(dir, 'bot.sqlite');
  const store = new Store(file), tasks = new Tasks(store); store.enqueue(input());
  const task = tasks.create(store.get('input')!, { cwd: dir, policyHash: 'policy', project: 'app' });
  const runId = tasks.start(task); tasks.saveRun(runId, 'thread-one', 'turn-one');
  const context: ExternalWaitContext = { taskId: task.id, runId, threadId: 'thread-one', turnId: 'turn-one',
    callId: 'call-one', ownerId: 'alice', chatId: 'chat-id' };
  let active = store;
  t.after(() => { try { active.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, tasks, task, runId, context, get store() { return active; }, replace(next: Store) { active = next; } };
}

const observation = (results: CheckObservation[], patch: Partial<GitHubObservation> = {}): GitHubObservation => ({
  source: 'github_rest', target, pullState: 'open', checks: results, observedAt: Date.now(), ...patch,
});
const all = (result: CheckObservation['result']): CheckObservation[] => [
  { ...checks[0], result, detail: result }, { ...checks[1], result, detail: result },
];

test('dynamic tool binds trusted task/run/owner/chat and persists exact target and checks', t => {
  const f = fixture(t), waits = new ExternalWaits(f.store), tool = externalWaitToolRegistration(waits, f.context);
  const result = tool.handle({ owner: target.owner, repo: target.repo, pull_number: target.pullNumber, head_sha: target.headSha,
    required_checks: [{ kind: 'check_run', context: 'build', app_id: 123 },
      { kind: 'commit_status', context: 'security/scan' }], timeout_minutes: 30 }, 1_000);
  assert.match(result.wait_id, /^EXT-[A-F0-9]{16}$/);
  const wait = waits.get(result.wait_id)!;
  assert.deepEqual(wait.target, target); assert.deepEqual(wait.requiredChecks, checks);
  assert.equal(wait.ownerId, 'alice'); assert.equal(wait.chatId, 'chat-id'); assert.equal(wait.taskId, f.task.id);
  assert.equal(wait.expiresAt, 1_801_000); assert.equal(wait.state, 'open');
  const replay = tool.handle({ owner: target.owner, repo: target.repo, pull_number: target.pullNumber, head_sha: target.headSha,
    required_checks: [{ kind: 'check_run', context: 'build', app_id: 123 },
      { kind: 'commit_status', context: 'security/scan' }], timeout_minutes: 30 }, 2_000);
  assert.equal(replay.wait_id, result.wait_id); assert.equal(waits.list(f.task.id).length, 1);
  assert.throws(() => tool.handle({ owner: target.owner, repo: target.repo, pull_number: 42, head_sha: target.headSha,
    required_checks: [], timeout_minutes: 1 }), ExternalWaitError);
  const wrong = externalWaitToolRegistration(waits, { ...f.context, ownerId: 'mallory', callId: 'call-two' });
  assert.throws(() => wrong.handle({ owner: target.owner, repo: target.repo, pull_number: 42, head_sha: target.headSha,
    required_checks: [{ kind: 'commit_status', context: 'ci' }], timeout_minutes: 2 }), /external_wait_identity_mismatch/);
});

test('pending, missing and unknown observations never wake; terminal exact checks wake once', async t => {
  const f = fixture(t), waits = new ExternalWaits(f.store);
  const wait = waits.request(f.context, { target, requiredChecks: checks, timeoutMs: 120_000 }, 10_000);
  let next = observation([{ ...checks[0], result: 'pending', detail: 'queued' },
    { ...checks[1], result: 'unknown', detail: 'missing' }], { observedAt: 11_000 });
  const adapter: GitHubObservationAdapter = { async observe() { return next; } };
  const first = await waits.poll(wait.id, adapter, 11_000);
  assert.equal(first?.state, 'open'); assert.equal(first?.revision, 1);
  next = { ...next, observedAt: 12_000 };
  const duplicate = await waits.poll(wait.id, adapter, 12_000);
  assert.equal(duplicate?.state, 'open'); assert.equal(duplicate?.revision, 1);
  next = observation(all('passing'), { pullState: 'unknown', observedAt: 12_500 });
  assert.equal((await waits.poll(wait.id, adapter, 12_500))?.state, 'open');
  next = observation([{ ...checks[0], result: 'passing', detail: 'success' },
    { ...checks[1], result: 'failing', detail: 'failure' }], { observedAt: 13_000 });
  assert.equal((await waits.poll(wait.id, adapter, 13_000))?.state, 'ready');
  assert.equal(waits.ready().length, 1);
  let callbackCount = 0;
  const consumed = waits.consume(wait.id, { taskId: f.task.id, ownerId: 'alice', chatId: 'chat-id' }, payload => {
    callbackCount++; assert.equal(payload.authorization, false); assert.equal(payload.source, 'github_rest');
    assert.match(payload.note, /不是用户回答或操作授权/);
    f.store.db.prepare("INSERT INTO settings(key,value) VALUES('resume-marker',?)").run(payload.waitId);
    return payload.waitId;
  }, 14_000);
  assert.equal(consumed, wait.id); assert.equal(callbackCount, 1); assert.equal(waits.get(wait.id)?.state, 'consumed');
  assert.equal(waits.consume(wait.id, { taskId: f.task.id, ownerId: 'alice', chatId: 'chat-id' }, () => callbackCount++), undefined);
  assert.equal(callbackCount, 1);
});

test('an observation or ready consume crossing the absolute expiry becomes timed out', async t => {
  const f = fixture(t), waits = new ExternalWaits(f.store);
  const late = waits.request(f.context, { target, requiredChecks: checks, timeoutMs: 60_000 }, 1_000);
  let clock = 60_000;
  const lateAdapter: GitHubObservationAdapter = { async observe() {
    clock = 61_001;
    return observation(all('passing'), { observedAt: clock });
  } };
  const lateResult = await waits.poll(late.id, lateAdapter, 60_000, () => clock);
  assert.equal(lateResult?.state, 'timed_out');
  assert.equal(waits.ready().length, 0);

  const ready = waits.request({ ...f.context, callId: 'consume-after-expiry' },
    { target, requiredChecks: checks, timeoutMs: 60_000 }, 2_000);
  await waits.poll(ready.id, { async observe() { return observation(all('passing'), { observedAt: 3_000 }); } }, 3_000);
  assert.equal(waits.get(ready.id)?.state, 'ready');
  let callbacks = 0;
  assert.equal(waits.consume(ready.id, { taskId: f.task.id, ownerId: 'alice', chatId: 'chat-id' }, () => callbacks++, 62_001), undefined);
  assert.equal(callbacks, 0);
  assert.equal(waits.get(ready.id)?.state, 'timed_out');
});

test('pollOpen refreshes time between sequential waits and does not poll later expired entries', async t => {
  const f = fixture(t), waits = new ExternalWaits(f.store);
  const first = waits.request(f.context, { target, requiredChecks: checks, timeoutMs: 60_000 }, 1_000);
  const item = input('deadline-second'); f.store.enqueue(item);
  const secondTask = f.tasks.create(f.store.get(item.key)!, { cwd: f.dir, policyHash: 'policy', project: 'app' });
  const secondRun = f.tasks.start(secondTask); f.tasks.saveRun(secondRun, 'deadline-thread', 'deadline-turn');
  const second = waits.request({ taskId: secondTask.id, runId: secondRun, threadId: 'deadline-thread', turnId: 'deadline-turn',
    callId: 'deadline-call', ownerId: 'alice', chatId: 'chat-id' }, { target: { ...target, pullNumber: 43 },
    requiredChecks: checks, timeoutMs: 60_000 }, 1_000);
  let clock = 60_000, calls = 0;
  const lateAdapter: GitHubObservationAdapter = { async observe(observedTarget) {
    calls++; clock = 61_001;
    return observation(all('passing'), { target: { ...observedTarget }, observedAt: clock });
  } };

  await waits.pollOpen(lateAdapter, 60_000, 4, () => clock);
  assert.equal(calls, 1);
  assert.equal(waits.get(first.id)?.state, 'timed_out');
  assert.equal(waits.get(second.id)?.state, 'timed_out');
  assert.equal(waits.ready().length, 0);
});

test('consume callback and state transition are atomic, and ready/open waits survive restart', async t => {
  const f = fixture(t), waits = new ExternalWaits(f.store);
  const wait = waits.request(f.context, { target, requiredChecks: checks, timeoutMs: 120_000 }, 10_000);
  const adapter: GitHubObservationAdapter = { async observe() { return observation(all('passing'), { observedAt: 20_000 }); } };
  await waits.poll(wait.id, adapter, 20_000); assert.equal(waits.get(wait.id)?.state, 'ready');
  assert.throws(() => waits.consume(wait.id, { taskId: f.task.id, ownerId: 'alice', chatId: 'chat-id' }, () => {
    f.store.db.prepare("INSERT INTO settings(key,value) VALUES('must-rollback','x')").run(); throw new Error('queue failed');
  }, 21_000), /queue failed/);
  assert.equal(waits.get(wait.id)?.state, 'ready');
  assert.equal(f.store.db.prepare("SELECT 1 FROM settings WHERE key='must-rollback'").get(), undefined);
  f.store.close(); const reopened = new Store(f.file); f.replace(reopened);
  const recovered = new ExternalWaits(reopened);
  assert.equal(recovered.ready()[0]?.id, wait.id);
  recovered.consume(wait.id, { taskId: f.task.id, ownerId: 'alice', chatId: 'chat-id' }, payload => {
    reopened.db.prepare("INSERT INTO settings(key,value) VALUES('durable-resume',?)").run(JSON.stringify(payload));
  }, 22_000);
  reopened.close(); const twice = new Store(f.file); f.replace(twice);
  assert.equal(new ExternalWaits(twice).get(wait.id)?.state, 'consumed');
  assert.equal(twice.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key='durable-resume'").get()?.n, 1);
});

test('pollOpen fairly rotates more than one batch of pending waits across restart', async t => {
  const f = fixture(t), waits = new ExternalWaits(f.store);
  const waitIds: string[] = [], pullNumbers: number[] = [];
  for (let index = 0; index < 6; index++) {
    let context: ExternalWaitContext;
    if (index === 0) context = { ...f.context, callId: `fair-call-${index}` };
    else {
      const item = input(`fair-input-${index}`); f.store.enqueue(item);
      const task = f.tasks.create(f.store.get(item.key)!, { cwd: f.dir, policyHash: 'policy', project: 'app' });
      const runId = f.tasks.start(task); f.tasks.saveRun(runId, `fair-thread-${index}`, `fair-turn-${index}`);
      context = { taskId: task.id, runId, threadId: `fair-thread-${index}`, turnId: `fair-turn-${index}`,
        callId: `fair-call-${index}`, ownerId: 'alice', chatId: 'chat-id' };
    }
    const wait = waits.request(context, { target: { ...target, pullNumber: 100 + index },
      requiredChecks: [checks[1]], timeoutMs: 60_000 }, 100);
    waitIds.push(wait.id);
  }
  const adapter: GitHubObservationAdapter = { async observe(observedTarget, requiredChecks) {
    pullNumbers.push(observedTarget.pullNumber);
    return { source: 'github_rest', target: { ...observedTarget }, pullState: 'open', observedAt: 1_000,
      checks: requiredChecks.map(check => ({ ...check, result: 'pending' as const, detail: 'pending' })) };
  } };

  await waits.pollOpen(adapter, 1_000, 4);
  assert.equal(pullNumbers.length, 4);
  const firstBatch = new Set(pullNumbers);
  for (const id of waitIds) assert.equal(waits.get(id)?.lastPolledAt === 1_000, firstBatch.has(waits.get(id)!.target.pullNumber));

  f.store.close(); const reopened = new Store(f.file); f.replace(reopened);
  const recovered = new ExternalWaits(reopened);
  // Simulate a restart and a non-advancing wall clock; the persisted cursor
  // still advances monotonically and selects both never-polled waits first.
  await recovered.pollOpen(adapter, 1_000, 4);

  assert.equal(pullNumbers.length, 8);
  assert.deepEqual(new Set(pullNumbers), new Set([100, 101, 102, 103, 104, 105]));
  assert.ok(pullNumbers.slice(4).filter(number => !firstBatch.has(number)).length >= 2);
  assert.ok(waitIds.some(id => recovered.get(id)?.lastPolledAt === 1_001));
  assert.equal(recovered.ready().length, 0);
  for (const id of waitIds) assert.equal(recovered.get(id)?.state, 'open');
});

test('stale HEAD, late duplicate polls, cancellation, timeout and read failures never create a ready wake', async t => {
  const f = fixture(t), waits = new ExternalWaits(f.store);
  const first = waits.request(f.context, { target, requiredChecks: checks, timeoutMs: 60_000 }, 1_000);
  const stale: GitHubObservationAdapter = { async observe() { return observation([], {
    target: { ...target, headSha: 'b'.repeat(40) }, observedAt: 2_000,
  }); } };
  assert.equal((await waits.poll(first.id, stale, 2_000))?.state, 'stale_head');
  assert.equal(waits.ready().length, 0);
  assert.equal((await waits.poll(first.id, { async observe() { return observation(all('passing')); } }, 3_000))?.state, 'stale_head');

  const second = waits.request({ ...f.context, callId: 'call-two' }, { target, requiredChecks: checks, timeoutMs: 60_000 }, 4_000);
  let releasePassing!: (value: GitHubObservation) => void, releasePending!: (value: GitHubObservation) => void;
  const passing = new Promise<GitHubObservation>(resolve => { releasePassing = resolve; });
  const pending = new Promise<GitHubObservation>(resolve => { releasePending = resolve; });
  const p1 = waits.poll(second.id, { observe: async () => passing }, 5_000);
  const p2 = waits.poll(second.id, { observe: async () => pending }, 5_000);
  releasePassing(observation(all('passing'), { observedAt: 5_000 })); await p1;
  releasePending(observation(all('pending'), { observedAt: 4_500 })); await p2;
  assert.equal(waits.get(second.id)?.state, 'ready');

  assert.equal(waits.cancel(second.id, { taskId: f.task.id, ownerId: 'alice', chatId: 'chat-id' }, 6_000), true);
  assert.equal(waits.get(second.id)?.state, 'cancelled');
  const third = waits.request({ ...f.context, callId: 'call-three' }, { target, requiredChecks: checks, timeoutMs: 60_000 }, 7_000);
  await waits.poll(third.id, { async observe() { throw new Error('PRIVATE NETWORK DETAIL'); } }, 8_000);
  assert.equal(waits.get(third.id)?.state, 'open'); assert.equal(waits.get(third.id)?.lastError, 'github_read_unknown');
  assert.deepEqual(waits.expire(67_001), [third.id]); assert.equal(waits.get(third.id)?.state, 'timed_out');
  assert.equal(waits.ready().length, 0);
});

test('GitHub REST adapter uses fixed read-only endpoints, injected token, exact SHA and verifies HEAD twice', async () => {
  const calls: { url: string; init?: RequestInit }[] = []; let pullCalls = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url); calls.push({ url: value, init });
    let body: unknown;
    if (value.endsWith('/pulls/42')) { pullCalls++; body = { state: 'open', head: { sha: target.headSha } }; }
    else if (value.includes('/check-runs?')) body = { check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'neutral', app: { id: 123 } }] };
    else if (value.includes('/status?')) body = { statuses: [{ context: 'security/scan', state: 'failure' }] };
    else return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const adapter = new GitHubRestAdapter({ token: 'IN_MEMORY_TOKEN', fetch: fetcher });
  const value = await adapter.observe(target, checks, Date.now() + 5_000);
  assert.equal(pullCalls, 2); assert.deepEqual(value.checks.map(check => check.result), ['passing', 'failing']);
  assert.ok(calls.every(call => call.url.startsWith('https://api.github.com/repos/octo-org/app/')));
  assert.ok(calls.some(call => call.url.includes(`/commits/${target.headSha}/check-runs?check_name=build&app_id=123`)));
  assert.ok(calls.some(call => call.url.includes(`/commits/${target.headSha}/status?per_page=100`)));
  assert.ok(calls.every(call => new Headers(call.init?.headers).get('Authorization') === 'Bearer IN_MEMORY_TOKEN'));
  assert.ok(calls.every(call => call.init?.method === 'GET' && call.init.redirect === 'error'));
});

test('GitHub adapter fails closed on changed HEAD, ambiguous checks, public access and HTTP errors', async () => {
  let pull = 0; const calls: RequestInit[] = [];
  const changing = new GitHubRestAdapter({ fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {}); const value = String(url); let body: unknown;
    if (value.endsWith('/pulls/42')) body = { state: 'open', head: { sha: ++pull === 1 ? target.headSha : 'b'.repeat(40) } };
    else if (value.includes('/check-runs?')) body = { check_runs: [
      { name: 'build', status: 'completed', conclusion: 'success', app: { id: 123 } },
      { name: 'build', status: 'completed', conclusion: 'success', app: { id: 123 } },
    ] };
    else body = { statuses: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch });
  const value = await changing.observe(target, checks, Date.now() + 5_000);
  assert.equal(value.target.headSha, 'b'.repeat(40)); assert.equal(value.checks.length, 0);
  assert.ok(calls.every(init => !new Headers(init.headers).has('Authorization')));

  const failed = new GitHubRestAdapter({ fetch: (async () => new Response('{"private":"detail"}', { status: 500 })) as typeof fetch });
  await assert.rejects(() => failed.observe(target, checks, Date.now() + 5_000), /github_read_failed/);
  const oversized = new GitHubRestAdapter({ maxResponseBytes: 5,
    fetch: (async () => new Response('{"head":{"sha":"too-large"}}', { status: 200 })) as typeof fetch });
  await assert.rejects(() => oversized.observe(target, checks, Date.now() + 5_000), /github_response_too_large/);
});
