import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Incoming } from '../src/store.js';
import { Engine, SendError } from '../src/engine.js';
import { Tasks, PROGRESS_DELAY_MS } from '../src/tasks.js';
import { RuntimeError, type Runtime, type RunRequest, type RunResult } from '../src/runtime.js';
import { evidenceBrief, taskStatus } from '../src/presentation.js';
import { readEvidence } from '../src/evidence.js';

const answer = { text: 'pong，在。', threadId: 'thread', turnId: 'turn' };
const message = (key: string, text = 'ping', senderId = 'alice'): Incoming => ({ key, messageId: key, chatKey: 'chat', chatId: 'chat', senderId, text });
const wait = async (f: () => boolean) => { const end = Date.now() + 5000; while (!f()) { if (Date.now() > end) throw Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };
function fixture(t: { after(f: () => Promise<void>): void }, runtime: Runtime = { async run() { return answer; } }, failProgress = false) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-presentation-')), store = new Store(join(dir, 'bot.sqlite'));
  const texts: string[] = [], cards: any[] = [], tasks = new Tasks(store);
  const engine = new Engine(store, runtime, {
    async send(_c, text, uuid) { texts.push(text); return uuid; },
    async sendCard(_c, card, uuid) { cards.push(card); if (failProgress && cards.length === 1) throw new SendError(true, 'timeout'); return uuid; },
  }, { dataDir: dir, concurrency: 1, feishu: { cards: true } });
  t.after(async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const age = (key: string) => store.db.prepare("UPDATE outbox SET createdAt=? WHERE inboxKey=? AND kind='progress'").run(Date.now() - PROGRESS_DELAY_MS - 1, key);
  return { store, tasks, engine, texts, cards, age };
}
function held() {
  let request: RunRequest | undefined, resolve: ((r: RunResult) => void) | undefined;
  const runtime: Runtime = { run(r) { request = r; return new Promise((yes, no) => { resolve = yes; r.signal.addEventListener('abort', () => no(new RuntimeError('cancelled')), { once: true }); }); } };
  return { runtime, started: () => !!request, finish: () => resolve!(answer) };
}

test('quick conversation sends one plain answer while retaining task and run records', async t => {
  const f = fixture(t); f.engine.start(); f.engine.accept(message('ping'));
  await wait(() => f.store.get('ping')?.state === 'replied');
  assert.deepEqual(f.texts, ['pong，在。']); assert.equal(f.cards.length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM tasks').get()?.n, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_runs').get()?.n, 1);
  assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE kind='progress'").get()?.state, 'suppressed');
  assert.equal(JSON.parse(String(f.store.db.prepare("SELECT payload FROM outbox WHERE kind='result'").get()?.payload)).noCard, true);
  assert.equal(f.engine.accept(message('ping')), false);
});

test('long task gets one compact progress card and completion does not resend it', async t => {
  const hold = held(), f = fixture(t, hold.runtime); f.engine.start(); f.engine.accept(message('slow'));
  await wait(hold.started); assert.equal(f.cards.length, 0);
  f.age('slow'); await f.engine.pump(); await wait(() => f.cards.length === 1);
  const visible = JSON.stringify(f.cards[0]);
  assert.match(visible, /正在处理/); assert.match(visible, /停止任务/);
  assert.doesNotMatch(visible, /N-[A-F0-9]{12}|W-[A-F0-9]{12}|输入版本|接收记录|\/amend/);
  hold.finish(); await wait(() => f.store.get('slow')?.state === 'replied');
  await f.engine.pump(); assert.equal(f.cards.length, 1); assert.deepEqual(f.texts, [answer.text]);
});

test('queued task reports waiting, and never-sent progress is suppressed on cancellation', async t => {
  const hold = held(), f = fixture(t, hold.runtime); f.engine.start(); f.engine.accept(message('active'));
  await wait(hold.started); f.engine.accept(message('queued')); f.age('queued');
  await f.engine.pump(); await wait(() => f.cards.some(card=>/排队中|正在排队/.test(JSON.stringify(card))));
  f.engine.accept(message('queued-two')); f.age('queued-two'); f.tasks.progress();
  const task = f.tasks.get(f.store.get('queued-two')!.taskId!)!;
  assert.equal(f.tasks.cancel(task), true);
  assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE inboxKey='queued-two' AND kind='progress'").get()?.state, 'suppressed');
  hold.finish();
  // The second task also enters the controllable runtime; cancel it during cleanup.
  await wait(() => f.store.get('active')?.state === 'replied');
});

test('completion suppresses a ready but unsent progress prompt before final delivery', async t => {
  const hold = held(), f = fixture(t, hold.runtime); f.engine.start(); f.engine.accept(message('race'));
  await wait(hold.started); f.age('race'); f.tasks.progress();
  assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE kind='progress'").get()?.state, 'pending');
  hold.finish(); await wait(() => f.store.get('race')?.state === 'replied');
  assert.equal(f.cards.length, 0); assert.deepEqual(f.texts, [answer.text]);
  assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE kind='progress'").get()?.state, 'suppressed');
});

test('unknown progress send remains unknown after completion and is not retried', async t => {
  const hold = held(), f = fixture(t, hold.runtime, true); f.engine.start(); f.engine.accept(message('unknown'));
  await wait(hold.started); f.age('unknown'); await f.engine.pump();
  await wait(() => f.store.db.prepare("SELECT state FROM outbox WHERE kind='progress'").get()?.state === 'unknown');
  hold.finish(); await wait(() => f.store.get('unknown')?.state === 'replied');
  assert.equal(f.cards.length, 1); assert.equal(f.texts.length, 1);
  assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE kind='progress'").get()?.state, 'unknown');
});

test('result card keeps the answer and actionable failures; details keep evidence without raw JSON', async t => {
  let runs = 0;
  const f = fixture(t, { async run(r) {
    runs++; r.onEvidence?.({ id: 'one', kind: 'command', label: 'pnpm test', status: 'completed', exitCode: 0 });
    r.onEvidence?.({ id: 'two', kind: 'command', label: 'node（参数未保存）', status: 'failed', exitCode: 7 });
    return { ...answer, text: '文件已处理。' };
  } });
  f.engine.start(); f.engine.accept(message('work')); await wait(() => f.store.get('work')?.state === 'replied');
  assert.equal(f.cards.length, 1); const card = JSON.stringify(f.cards[0]);
  assert.match(card, /文件已处理。/); assert.match(card, /1 项操作失败/);
  assert.doesNotMatch(card, /工作线|输入版本|退出码|N-[A-F0-9]{12}|检查通过/);
  const token = f.store.db.prepare("SELECT a.token,o.platformId FROM card_actions a JOIN outbox o ON o.id=a.outboxId WHERE a.action='details'").get()!;
  const event = { operator: { open_id: 'alice' }, context: { open_chat_id: 'chat', open_message_id: String(token.platformId) }, action: { value: { namo: String(token.token) } } };
  assert.equal(f.engine.acceptCard({ ...event, operator: { open_id: 'bob' } }).toast.type, 'error');
  assert.equal(f.engine.acceptCard(event).toast.type, 'info');
  await wait(() => f.texts.length > 0);
  assert.match(f.texts.join(''), /退出码 7/); assert.match(f.texts.join(''), /平台已接受，未确认是否已读/);
  assert.doesNotMatch(f.texts.join(''), /"runId"|"inputVersion"|"runners"|"owner"/);
  f.engine.acceptCard(event); assert.equal(runs, 1);
  const task = f.tasks.get(f.store.get('work')!.taskId!)!;
  assert.equal(readEvidence(f.store, task.id)[0].items[1].exitCode, 7);
});

test('status and latest-task commands are readable and preserve ownership', async t => {
  const f = fixture(t); f.engine.start(); f.engine.accept(message('owned')); await wait(() => f.store.get('owned')?.state === 'replied');
  const id = f.store.get('owned')!.taskId!;
  f.engine.accept(message('status', '/status')); f.engine.accept(message('latest', '/task'));
  f.engine.accept(message('denied', `/task ${id}`, 'bob'));
  await wait(() => f.store.get('denied')?.state === 'replied');
  assert.match(f.texts.join('\n'), /服务可用/); assert.match(f.texts.join('\n'), /未找到可访问/);
  const latest = f.store.db.prepare("SELECT content FROM outbox WHERE inboxKey='latest'").get()!;
  assert.match(String(latest.content), /已完成/); assert.doesNotMatch(String(latest.content), /workstream|inputVersion|"execution"/);
});

test('detail distinguishes mixed delivery states and empty evidence never invents validation', t => {
  const f = fixture(t); f.engine.accept(message('task')); const task = f.tasks.get(f.store.get('task')!.taskId!)!;
  f.tasks.start(task); f.store.addOutput(task.inboxKey, 'result', 'x'.repeat(2100));
  f.store.db.prepare("UPDATE outbox SET state='sent' WHERE kind='result' AND part=0").run();
  assert.match(taskStatus(f.store, task), /等待发送/);
  f.store.db.prepare("UPDATE outbox SET state='unknown' WHERE kind='result' AND part=1").run();
  assert.match(taskStatus(f.store, task), /发送结果不明/);
  assert.equal(evidenceBrief({ version: 1, runId: 'run', state: 'finished', truncated: false, items: [], git: { status: 'unchanged', before: 'same', after: 'same' } }), '');
});

test('latest task is scoped to its owner and topic even after many newer tasks elsewhere', t => {
  const f = fixture(t);
  const scoped = (key: string, scope: string, owner = 'alice') => ({ ...message(key, 'task', owner),
    envelope: { version: 1 as const, type: 'text', kind: 'instruction' as const, scopeKey: scope, materials: [], limitations: [] } });
  f.engine.accept(scoped('original', 'topic-one'));
  for (let n = 0; n < 11; n++) f.engine.accept(scoped(`other-${n}`, 'topic-two'));
  f.engine.accept(scoped('other-owner', 'topic-one', 'bob'));
  f.engine.accept({ ...scoped('query', 'topic-one'), text: '/task' });
  const reply = String(f.store.db.prepare("SELECT content FROM outbox WHERE inboxKey='query' AND kind='result'").get()?.content);
  assert.match(reply, new RegExp(f.store.get('original')!.taskId!));
  assert.doesNotMatch(reply, new RegExp(f.store.get('other-owner')!.taskId!));
});
