import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Incoming, SCHEMA_VERSION } from '../src/store.js';
import { BackgroundWork } from '../src/background-work.js';

const message = (key: string, chatKey = 'chat'): Incoming => ({ key, chatKey, chatId: chatKey, messageId: key, senderId: 'user', text: 'hi' });

test('changing bot account cannot replay another bot account database', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-store-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'bot.sqlite')); t.after(() => store.close());
  store.bindAccount('app-one'); store.bindAccount('app-one');
  assert.throws(() => store.bindAccount('app-two'), /另一个飞书应用/);
  store.bindAccount('app-one');
});

test('reply and execution state commit atomically when outbox storage fails', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-store-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'bot.sqlite')); t.after(() => store.close());
  store.enqueue(message('a')); store.claim('a');
  store.db.exec("CREATE TRIGGER simulate_disk_error BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'disk_error'); END");
  assert.throws(() => store.finish('a', 'answer'), /disk_error/);
  assert.equal(store.get('a')?.state, 'running'); assert.equal(store.nextOutput(), undefined);
});

test('durable dedup and per-chat serialization survive reopening', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-store-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new Store(join(dir, 'bot.sqlite'));
  assert.equal(store.enqueue(message('a')), true); assert.equal(store.enqueue(message('a')), false);
  store.enqueue(message('b')); store.enqueue(message('c', 'other'));
  store.claim('a'); assert.equal(store.next([])?.key, 'c');
  store.finish('a', 'answer'); assert.equal(store.next([])?.key, 'c');
  const output = store.nextOutput()!; store.sending(output.id);
  store.close(); store = new Store(join(dir, 'bot.sqlite')); t.after(() => store.close());
  assert.deepEqual(store.recover(), { interrupted: 0, unknown: 1 });
  assert.equal(store.get('a')?.state, 'delivery_unknown');
  assert.equal(store.nextOutput(), undefined); assert.equal(store.next([])?.key, 'b');
});

test('crash during execution produces one notice without replaying the task', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-store-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'bot.sqlite')); t.after(() => store.close());
  store.enqueue(message('a')); store.claim('a');
  assert.deepEqual(store.recover(), { interrupted: 1, unknown: 0 });
  assert.deepEqual(store.recover(), { interrupted: 0, unknown: 0 });
  assert.equal(store.next([]), undefined);
  const output = store.nextOutput()!; store.sending(output.id); store.sent(output.id, 'platform-id');
  assert.equal(store.get('a')?.state, 'failed');
});

test('Unicode chunks remain ordered and completion requires every result receipt', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-store-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'bot.sqlite')); t.after(() => store.close());
  store.enqueue(message('a')); store.claim('a'); store.finish('a', '🐱'.repeat(2100));
  const first = store.nextOutput()!; assert.equal(Array.from(first.content).length, 2000);
  assert.equal(store.sending(first.id), true); store.sent(first.id, 'first');
  assert.equal(store.get('a')?.state, 'awaiting_reply');
  const second = store.nextOutput()!; assert.notEqual(first.uuid, second.uuid); assert.equal(Array.from(second.content).length, 100);
  store.sending(second.id); store.sent(second.id, 'second'); assert.equal(store.get('a')?.state, 'replied');
});

test('uncertain progress notification never prevents final answer delivery', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-store-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'bot.sqlite')); t.after(() => store.close());
  store.enqueue(message('a')); store.addOutput('a', 'progress', 'received'); store.claim('a'); store.finish('a', 'answer');
  const progress = store.nextOutput()!; store.sending(progress.id); store.deliveryFailed(progress.id, true, 'timeout');
  assert.equal(store.get('a')?.state, 'awaiting_reply');
  const answer = store.nextOutput()!; assert.equal(answer.kind, 'result'); store.sending(answer.id); store.sent(answer.id, 'ok');
  assert.equal(store.get('a')?.state, 'replied');
});

test('schema 10 scheduling migration preserves the ledger and indexes only actionable work', t => {
  const dir = mkdtempSync(join(tmpdir(), 'namo-scheduling-')), file = join(dir, 'db');
  let store = new Store(file);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.db.exec(`DROP TRIGGER background_work_insert; DROP TRIGGER background_work_update;
    DROP TABLE background_work; DROP INDEX outbox_live_progress;
    ALTER TABLE outbox DROP COLUMN progressRetired; PRAGMA user_version=10;`);
  const insert = store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)');
  const job = (state: string) => JSON.stringify({ version: 1, state, attempts: 0, dueAt: 10, leaseUntil: 20, createdAt: 1 });
  store.transaction(() => {
    for (let i = 0; i < 50_000; i++) insert.run('auto-memory:job:history-' + i, job('completed'));
    insert.run('auto-memory:job:pending', job('pending'));
    insert.run('auto-memory:job:running', job('running'));
    insert.run('auto-memory:job:malformed', '{broken');
    insert.run('artifact:pending', JSON.stringify({ state: 'pending', uuid: 'stable-id' }));
    insert.run('artifact:unknown', JSON.stringify({ state: 'unknown', uuid: 'do-not-retry' }));
    insert.run('artifact-intent:pending', JSON.stringify({ state: 'pending' }));
    insert.run('private-setting', 'unchanged');
  });
  const before = store.db.prepare('SELECT key,value FROM settings ORDER BY key').all();
  store.close(); store = new Store(file);
  assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
  assert.deepEqual(store.db.prepare('SELECT key,value FROM settings ORDER BY key').all(), before);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM background_work').get()?.n, 4);
  const queue = new BackgroundWork(store);
  assert.equal(queue.ready('memory', 9), false); assert.equal(queue.ready('memory', 10), true);
  assert.deepEqual(queue.records('memory', 10).map(r => r.key), ['auto-memory:job:pending']);
  assert.deepEqual(queue.records('artifact').map(r => r.key), ['artifact:pending']);
  const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM background_work WHERE kind='memory' AND readyAt<=10 LIMIT 1").all();
  assert.match(JSON.stringify(plan), /SEARCH.*background_work_ready/);
  assert.doesNotMatch(JSON.stringify(plan), /SCAN/);

  const finish = () => store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(job('completed'), 'auto-memory:job:pending');
  assert.throws(() => store.transaction(() => { finish(); throw new Error('rollback'); }), /rollback/);
  assert.equal(queue.ready('memory', 10), true);
  finish(); assert.equal(queue.ready('memory', 10), false); assert.equal(queue.ready('memory', 20), true);
  store.db.prepare("DELETE FROM settings WHERE key='artifact:pending'").run();
  assert.deepEqual(queue.records('artifact'), []);
  store.close(); store = new Store(file);
  assert.equal(new BackgroundWork(store).ready('memory', 10), false);
  assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='artifact:unknown'").get()?.value, JSON.stringify({ state: 'unknown', uuid: 'do-not-retry' }));
});
