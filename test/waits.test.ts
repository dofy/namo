import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, SendError, type Sender } from '../src/engine.js';
import { RuntimeError, type RunRequest, type RunResult, type Runtime, type WaitRequest } from '../src/runtime.js';
import { Store, SCHEMA_VERSION, type Incoming } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { WaitInputError, Waits } from '../src/waits.js';

const until = async (predicate: () => boolean, timeout = 6000) => {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition_timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

function message(key: string, text = 'ORIGINAL_MARKER', options: {
  chat?: string; scope?: string; owner?: string; parentId?: string;
} = {}): Incoming {
  const chat = options.chat ?? 'chat';
  return { key, messageId: key, chatKey: chat, chatId: chat, senderId: options.owner ?? 'alice', text,
    envelope: { version: 1, type: 'text', kind: 'instruction', scopeKey: options.scope ?? chat,
      parentId: options.parentId, chatType: 'p2p', materials: [], limitations: [] } };
}

function waitingResult(r: RunRequest, index: number, question = `question-${index}`): RunResult {
  const threadId = r.threadId ?? 'thread-one';
  const turnId = `turn-${index}`;
  r.onThread(threadId); r.onTurn(turnId);
  const request: WaitRequest = { threadId, turnId, callId: `call-${index}`, question };
  const id = r.onWait!(request);
  return { text: `partial-${index}`, threadId, turnId, waiting: { ...request, id } };
}

function fixture(t: { after: (fn: () => void | Promise<void>) => void }, runtime: Runtime,
  sender?: Sender, concurrency = 2) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'namo-waits-')));
  const one = join(dir, 'one'), two = join(dir, 'two'); mkdirSync(one); mkdirSync(two);
  const store = new Store(join(dir, 'bot.sqlite')); const tasks = new Tasks(store); const engines: Engine[] = [];
  const config = { dataDir: dir, concurrency, codex: { bin: 'codex', home: join(dir, 'auth'), timeoutMs: 10_000,
    sandbox: 'workspace-write' as const, projects: { one, two }, defaultProject: 'one' } };
  const makeEngine = (nextRuntime: Runtime = runtime) => {
    const engine = new Engine(store, nextRuntime, sender ?? { async send(_chat, _text, uuid) { return `platform-${uuid}`; } }, config);
    engines.push(engine); return engine;
  };
  t.after(async () => {
    for (const engine of engines) await engine.stop();
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { dir, one, two, store, tasks, config, makeEngine };
}

test('schema 5 upgrades with durable waits and optional choices without disturbing existing rows', t => {
  const dir = mkdtempSync(join(tmpdir(), 'namo-wait-schema-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'bot.sqlite'); const created = new Store(file);
  created.enqueue(message('existing'));
  created.db.exec('DROP TABLE task_waits; PRAGMA user_version=5'); created.close();
  const upgraded = new Store(file);
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
  assert.equal(upgraded.get('existing')?.text, 'ORIGINAL_MARKER');
  assert.deepEqual((upgraded.db.prepare('PRAGMA table_info(task_waits)').all() as { name: string }[]).map(row => row.name),
    ['id', 'taskId', 'runId', 'threadId', 'turnId', 'callId', 'question', 'inputVersion', 'state', 'createdAt',
      'settledAt', 'replyInboxKey', 'replyVersion', 'choices']);
  upgraded.close();
});

test('requested wait is persisted before acknowledgement, parks every state, and crash recovery makes an unparked request uncertain', async t => {
  let observedRequested = false; let calls = 0;
  let f: ReturnType<typeof fixture>;
  const runtime: Runtime = { async run(r) {
    calls++;
    const result = waitingResult(r, calls, '请选择 A 或 B');
    const row = f.store.db.prepare('SELECT state,question FROM task_waits WHERE id=?').get(result.waiting!.id);
    observedRequested = row?.state === 'requested' && row.question === '请选择 A 或 B';
    return result;
  } };
  f = fixture(t, runtime); const engine = f.makeEngine(); engine.start(); engine.accept(message('first'));
  await until(() => f.tasks.get(f.store.get('first')!.taskId!)?.state === 'waiting');
  const task = f.tasks.get(f.store.get('first')!.taskId!)!;
  const waiting = new Waits(f.store).current(task.id)!;
  assert.equal(observedRequested, true); assert.equal(waiting.state, 'open');
  assert.equal(f.store.get('first')?.state, 'waiting');
  assert.equal(f.store.db.prepare('SELECT state FROM task_runs WHERE id=?').get(waiting.runId)?.state, 'waiting');
  assert.match(String(f.store.db.prepare('SELECT state FROM outbox WHERE kind=?').get(`wait:${waiting.id}`)?.state),
    /^(pending|sending|sent)$/);

  const manual = message('manual', 'manual crash'); f.store.enqueue(manual);
  const second = f.tasks.create(f.store.get('manual')!, { cwd: f.one, policyHash: task.policyHash, project: 'one' });
  const run = f.tasks.start(second); f.tasks.saveRun(run, 'thread-crash', 'turn-crash');
  const id = new Waits(f.store).request(second.id, run,
    { threadId: 'thread-crash', turnId: 'turn-crash', callId: 'call-crash', question: 'still there?' });
  f.tasks.recover(false);
  assert.equal(new Waits(f.store).get(id)?.state, 'uncertain');
  assert.equal(f.tasks.get(second.id)?.state, 'interrupted');
});

test('waiting releases global and cwd slots but remains a FIFO barrier for the same chat', async t => {
  const starts: string[] = [];
  const runtime: Runtime = { async run(r) {
    const prompt = JSON.parse(r.prompt); const key = prompt.messages?.[0]?.message_id as string;
    starts.push(key);
    if (key === 'waiting') return waitingResult(r, 1);
    r.onThread(`thread-${key}`); r.onTurn(`turn-${key}`);
    return { text: `done-${key}`, threadId: `thread-${key}`, turnId: `turn-${key}` };
  } };
  const f = fixture(t, runtime, undefined, 1); const engine = f.makeEngine();
  engine.accept(message('waiting')); engine.accept(message('same-chat'));
  engine.accept(message('other-chat', 'other task', { chat: 'other-chat' })); engine.start();
  await until(() => f.store.get('other-chat')?.state === 'replied');
  assert.deepEqual(starts, ['waiting', 'other-chat']);
  assert.equal(f.tasks.get(f.store.get('waiting')!.taskId!)?.state, 'waiting');
  assert.equal(f.tasks.get(f.store.get('same-chat')!.taskId!)?.state, 'queued');
});

test('resume enforces owner, chat and topic, rejects stale quotes, and supports multiple cycles on the original thread', async t => {
  const prompts: string[] = []; const threads: (string | undefined)[] = [];
  const runtime: Runtime = { async run(r) {
    prompts.push(r.prompt); threads.push(r.threadId);
    const index = prompts.length;
    if (index < 3) return waitingResult(r, index);
    r.onThread(r.threadId!); r.onTurn('turn-3');
    return { text: 'all done', threadId: r.threadId!, turnId: 'turn-3' };
  } };
  const f = fixture(t, runtime); const engine = f.makeEngine(); engine.start();
  engine.accept(message('first')); await until(() => f.tasks.list(message('lookup'))[0]?.state === 'waiting');
  const task = f.tasks.list(message('lookup'))[0]; const first = new Waits(f.store).current(task.id)!;
  await until(() => !!f.store.db.prepare('SELECT platformId FROM outbox WHERE kind=? AND platformId IS NOT NULL').get(`wait:${first.id}`));
  const firstPlatform = String(f.store.db.prepare('SELECT platformId FROM outbox WHERE kind=?').get(`wait:${first.id}`)?.platformId);

  engine.accept(message('wrong-owner', `/resume ${first.id} stolen`, { owner: 'bob' }));
  engine.accept(message('wrong-chat', `/resume ${first.id} stolen`, { chat: 'elsewhere' }));
  engine.accept(message('wrong-topic', `/resume ${first.id} stolen`, { scope: 'other-topic' }));
  assert.equal(f.tasks.get(task.id)?.inputVersion, 1); assert.equal(prompts.length, 1);

  const reply = message('reply-one', 'answer-one', { parentId: firstPlatform });
  assert.equal(engine.accept(reply), true); assert.equal(engine.accept(reply), false);
  await until(() => {
    const current = new Waits(f.store).current(task.id);
    return current?.id !== first.id && current?.state === 'open';
  });
  const second = new Waits(f.store).current(task.id)!;
  assert.equal(second.state, 'open'); assert.equal(f.tasks.get(task.id)?.inputVersion, 2);

  engine.accept(message('amend-waiting', `/amend ${task.id} should-not-steer`));
  engine.accept(message('switch-waiting', '/project two'));
  engine.accept(message('stale-quote', 'late old answer', { parentId: firstPlatform }));
  await until(() => f.store.get('stale-quote')?.state === 'replied');
  assert.equal(f.tasks.get(task.id)?.inputVersion, 2); assert.equal(f.store.project('chat'), undefined);
  assert.equal(new Waits(f.store).get(first.id)?.state, 'answered'); assert.equal(new Waits(f.store).get(second.id)?.state, 'open');

  engine.accept(message('reply-two', `/resume ${second.id} answer-two`));
  await until(() => f.tasks.get(task.id)?.state === 'succeeded');
  assert.equal(f.tasks.get(task.id)?.inputVersion, 3); assert.deepEqual(threads, [undefined, 'thread-one', 'thread-one']);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE taskId=?').get(task.id)?.n, 3);
  const firstResume = JSON.parse(prompts[1]), secondResume = JSON.parse(prompts[2]);
  assert.equal(firstResume.type, 'task_resume'); assert.equal(firstResume.question, 'question-1'); assert.equal(firstResume.reply, 'answer-one');
  assert.equal(secondResume.type, 'task_resume'); assert.equal(secondResume.question, 'question-2'); assert.equal(secondResume.reply, 'answer-two');
  assert.equal('messages' in firstResume, false); assert.doesNotMatch(prompts[1], /ORIGINAL_MARKER/);
  assert.equal(f.tasks.thread(f.tasks.get(task.id)!), 'thread-one');
});

test('unknown wait delivery is never retried, and cancellation closes the wait without another inference', async t => {
  let calls = 0, waitSends = 0;
  const runtime: Runtime = { async run(r) { calls++; return waitingResult(r, calls, 'delivery question'); } };
  const sender: Sender = { async send(_chat, content, uuid) {
    if (content.includes('delivery question')) { waitSends++; throw new SendError(true, 'transport_timeout'); }
    return uuid;
  } };
  const f = fixture(t, runtime, sender); const engine = f.makeEngine(); engine.start(); engine.accept(message('first'));
  await until(() => f.store.db.prepare("SELECT state FROM outbox WHERE kind LIKE 'wait:%'").get()?.state === 'unknown');
  for (let i = 0; i < 8; i++) await engine.pump();
  assert.equal(waitSends, 1); assert.equal(calls, 1);
  const task = f.tasks.get(f.store.get('first')!.taskId!)!; const wait = new Waits(f.store).current(task.id)!;
  engine.accept(message('cancel', `/cancel ${task.id}`)); await until(() => f.tasks.get(task.id)?.state === 'cancelled');
  assert.equal(new Waits(f.store).get(wait.id)?.state, 'cancelled'); assert.equal(calls, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE inboxKey='first' AND kind='result'").get()?.n, 1);
});

test('a waiting task survives receiver restart and resumes exactly once from the stored reply', async t => {
  const prompts: string[] = []; let calls = 0;
  const runtime: Runtime = { async run(r) {
    prompts.push(r.prompt); calls++;
    if (calls === 1) return waitingResult(r, 1, 'restart question');
    r.onThread(r.threadId!); r.onTurn('turn-2'); return { text: 'resumed', threadId: r.threadId!, turnId: 'turn-2' };
  } };
  const f = fixture(t, runtime); const first = f.makeEngine(); first.start(); first.accept(message('first'));
  await until(() => f.tasks.get(f.store.get('first')!.taskId!)?.state === 'waiting');
  const task = f.tasks.get(f.store.get('first')!.taskId!)!; const wait = new Waits(f.store).current(task.id)!;
  await first.stop();
  const second = f.makeEngine(); second.start(); second.accept(message('resume', `/resume ${wait.id} after restart`));
  await until(() => f.tasks.get(task.id)?.state === 'succeeded');
  assert.equal(calls, 2); assert.equal(JSON.parse(prompts[1]).reply, 'after restart');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE taskId=?').get(task.id)?.n, 2);
});

test('changed resume context fails closed without forking a thread or replaying the original instruction', async t => {
  const prompts: string[] = []; let calls = 0;
  const runtime: Runtime = { async run(r) { prompts.push(r.prompt); calls++; return waitingResult(r, calls, 'context question'); } };
  const f = fixture(t, runtime); const first = f.makeEngine(); first.start(); first.accept(message('first'));
  await until(() => f.tasks.get(f.store.get('first')!.taskId!)?.state === 'waiting');
  const task = f.tasks.get(f.store.get('first')!.taskId!)!; const wait = new Waits(f.store).current(task.id)!;
  await first.stop(); first.accept(message('resume', `/resume ${wait.id} answer`));
  f.store.saveThread(`workstream:${task.workstreamId}`, 'different-thread');
  const second = f.makeEngine(); second.start(); await until(() => f.tasks.get(task.id)?.state === 'failed');
  assert.equal(f.tasks.get(task.id)?.error, 'wait_context_changed'); assert.equal(calls, 1);
  assert.equal(prompts.length, 1); assert.match(prompts[0], /ORIGINAL_MARKER/);
});

test('answer and cancel are serialized, and neither a late answer nor an unresolved revision can open a new run', t => {
  const runtime: Runtime = { async run() { throw new Error('not used'); } };
  const f = fixture(t, runtime); const engine = f.makeEngine(); engine.accept(message('first'));
  const task = f.tasks.get(f.store.get('first')!.taskId!)!; const run = f.tasks.start(task);
  f.tasks.saveRun(run, 'thread-one', 'turn-one');
  const waits = new Waits(f.store); const id = waits.request(task.id, run,
    { threadId: 'thread-one', turnId: 'turn-one', callId: 'call-one', question: 'answer?' });
  waits.park(task, run, { id, threadId: 'thread-one', turnId: 'turn-one', callId: 'call-one', question: 'answer?' });
  assert.equal(f.tasks.cancel(f.tasks.get(task.id)!), true);
  const late = message('late', 'too late'); f.store.enqueue(late);
  assert.throws(() => waits.answer(waits.get(id)!, late, late.text), WaitInputError);
  assert.equal(f.tasks.get(task.id)?.state, 'cancelled'); assert.equal(waits.get(id)?.state, 'cancelled');

  engine.accept(message('answered-first')); const answered = f.tasks.get(f.store.get('answered-first')!.taskId!)!;
  const answeredRun = f.tasks.start(answered); f.tasks.saveRun(answeredRun, 'thread-answer', 'turn-answer');
  const answeredId = waits.request(answered.id, answeredRun,
    { threadId: 'thread-answer', turnId: 'turn-answer', callId: 'call-answer', question: 'answer first?' });
  waits.park(answered, answeredRun,
    { id: answeredId, threadId: 'thread-answer', turnId: 'turn-answer', callId: 'call-answer', question: 'answer first?' });
  const accepted = message('accepted-answer', 'saved answer'); f.store.enqueue(accepted);
  waits.answer(waits.get(answeredId)!, accepted, accepted.text);
  assert.equal(f.tasks.cancel(f.tasks.get(answered.id)!), true);
  assert.equal(f.tasks.get(answered.id)?.state, 'cancelled'); assert.equal(waits.get(answeredId)?.state, 'answered');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE taskId=?').get(answered.id)?.n, 1);

  engine.accept(message('second')); const next = f.tasks.get(f.store.get('second')!.taskId!)!; const nextRun = f.tasks.start(next);
  f.tasks.saveRun(nextRun, 'thread-two', 'turn-two');
  const revision = message('revision', 'unresolved'); f.store.enqueue(revision); f.tasks.amend(next, revision);
  assert.throws(() => waits.request(next.id, nextRun,
    { threadId: 'thread-two', turnId: 'turn-two', callId: 'call-two', question: 'unsafe?' }),
  (error: unknown) => error instanceof RuntimeError && error.code === 'wait_unresolved_revision');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM task_waits WHERE taskId=?').get(next.id)?.n, 0);
  f.tasks.dispatch(revision.key, 'accepted');
  const safe = waits.request(next.id, nextRun,
    { threadId: 'thread-two', turnId: 'turn-two', callId: 'call-safe', question: 'which option?' });
  waits.park(next, nextRun, { id: safe, threadId: 'thread-two', turnId: 'turn-two', callId: 'call-safe', question: 'which option?' });
  const followup = message('audit-answer', 'A'); f.store.enqueue(followup);
  waits.answer(waits.get(safe)!, followup, followup.text);
  f.tasks.start(f.tasks.get(next.id)!);
  assert.equal(f.store.db.prepare('SELECT dispatch FROM task_messages WHERE inboxKey=?').get(revision.key)?.dispatch, 'accepted',
    'resuming must preserve the prior runner receipt rather than rewrite it as a newly applied input');
});
