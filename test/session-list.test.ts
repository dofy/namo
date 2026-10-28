import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Incoming } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { sessionList } from '../src/session-list.js';
import { richPost } from '../src/richtext.js';

const at = Date.UTC(2026, 9, 28, 8);
const incoming = (key: string, text: string, senderId = 'alice', chatKey = 'chat'): Incoming => ({ key, text, senderId, chatKey, chatId: chatKey, messageId: key });
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-session-list-')), store = new Store(join(dir, 'bot.sqlite')), tasks = new Tasks(store);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let seq = 0;
  const add = (text: string, fresh = true, sender = 'alice', chat = 'chat') => {
    const m = incoming(`m${++seq}`, text, sender, chat); store.enqueue(m);
    store.db.prepare('UPDATE inbox SET createdAt=? WHERE key=?').run(at + seq * 60_000, m.key);
    if (fresh) tasks.reset(m);
    const task = tasks.create(store.get(m.key)!, { cwd: dir, project: 'bot', policyHash: 'policy' });
    store.db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(task.id);
    return task;
  };
  const options = { accessible: () => true, redact: (s: string) => s, timeZone: 'Asia/Shanghai' };
  const list = () => sessionList(store, incoming('list', '/session'), options);
  return { store, tasks, add, list, options };
}

test('session list explains first and latest requests, current binding, time, count and exact resume command', t => {
  const f = fixture(t), first = f.add('/run 检查支付取消流程'), last = f.add('补齐重复提交的回归测试', false);
  const text = f.list();
  assert.match(text, /\*\*1\. 检查支付取消流程 · 当前会话\*\*/);
  assert.match(text, /bot · 2 项任务 · 最近任务已完成/);
  assert.match(text, /最近：补齐重复提交的回归测试/);
  assert.match(text, /最近活动：2026\/10\/28 16:02/);
  assert.ok(text.includes(`/session ${first.workstreamId}`));
  assert.equal(first.workstreamId, last.workstreamId);
  assert.match(text, /不会重跑旧任务/);
  assert.match(text, /正在等待补充.*\/tasks/);
  assert.equal((text.match(/继续此会话：/g) ?? []).length, 1);
  const post = JSON.stringify(richPost(text));
  assert.ok(post.includes('检查支付取消流程'));
  assert.ok(post.includes(`/session ${first.workstreamId}`));
});

test('recent activity includes amended input and current session stays visible beyond ten newer sessions', t => {
  const f = fixture(t), old = f.add('旧会话主题'), middle = f.add('新增补充的会话');
  for (let i = 0; i < 11; i++) f.add(`后来创建 ${i}`);
  const amendment = incoming('amendment', '后续补充');f.store.enqueue(amendment);
  f.store.db.prepare('UPDATE inbox SET createdAt=? WHERE key=?').run(at + 3600000, amendment.key);
  f.store.db.prepare("INSERT INTO task_messages(taskId,inboxKey,role,version) VALUES(?,?,'revision',2)").run(middle.id, amendment.key);
  f.tasks.selectStream(incoming('list','/session'), old.workstreamId);
  const text = f.list();
  assert.match(text, /\*\*1\. 旧会话主题 · 当前会话\*\*/);
  assert.match(text, /\*\*2\. 新增补充的会话\*\*/);
  assert.match(text, /2026\/10\/28 17:00/);
  assert.equal((text.match(/继续此会话：/g) ?? []).length, 10);
  assert.equal(f.tasks.binding(incoming('list','/session'))?.id, old.workstreamId);
});

test('session previews stay within owner/chat and omit content whose delivery access was revoked', t => {
  const f = fixture(t); f.add('本人的内容'); f.add('其他用户秘密', true, 'bob'); f.add('私聊秘密', true, 'alice', 'other');
  const denied = f.add('已撤权内容');
  const text = sessionList(f.store, incoming('list','/session'), { ...f.options, accessible: task => task.id !== denied.id });
  assert.match(text, /本人的内容/);
  assert.doesNotMatch(text, /其他用户秘密|私聊秘密|已撤权内容/);
  assert.ok(!text.includes(denied.workstreamId));
});

test('excerpts are redacted before truncation and neutralize Markdown and control characters', t => {
  const f = fixture(t), secret = 'secret-' + 'x'.repeat(200);
  f.add('**标题**\n\u202e' + secret + '😀'.repeat(100));
  const text = sessionList(f.store, incoming('list','/session'), { ...f.options, redact: value => value.replace(secret, '[已隐藏]') });
  assert.doesNotMatch(text, /secret-|xxxxx|\u202e|\ufffd/);
  assert.ok(text.includes('\\*\\*标题\\*\\*'));
  assert.ok(text.includes('\\[已隐藏\\]'));
  assert.match(text, /…/);
  assert.ok(text.length < 1200);
});

test('empty lists and attachment-only requests have useful fallbacks without invented summaries', t => {
  const f = fixture(t);
  assert.match(f.list(), /尚无可用会话.*直接发送任务/);
  f.add('   ');
  assert.match(f.list(), /无文字请求（可能包含附件）/);
});
