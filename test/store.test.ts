import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Incoming } from '../src/store.js';

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
