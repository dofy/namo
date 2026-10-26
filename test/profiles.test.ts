import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION } from '../src/store.js';
import { Profiles } from '../src/profiles.js';
import { Engine } from '../src/engine.js';
import { normalizeEvent } from '../src/feishu.js';
import { Tasks } from '../src/tasks.js';
import type { ProfileIdentity } from '../src/ui-contract.js';

const identity: ProfileIdentity = { channel: 'feishu', appId: 'app', userId: 'alice' };
const owner = { source: 'local-owner' as const };
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-profiles-')), file = join(dir, 'bot.sqlite');
  const store = new Store(file); t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, store, profiles: new Profiles(store, identity) };
}
const feishu = { appId: 'app', domain: 'feishu' as const, allowedUserIds: ['alice', 'bob'], allowedChatIds: [], requireMention: false, appSecret: '' };
function message(id: string, text: string, user = 'alice', chatType = 'p2p', extra = {}) {
  return normalizeEvent({ sender: { sender_type: 'user', sender_id: { open_id: user } }, message: {
    message_id: id, chat_id: chatType === 'p2p' ? `dm-${user}` : 'group', chat_type: chatType, message_type: 'text', content: JSON.stringify({ text }), ...extra,
  } }, feishu, 'bot')!;
}
function engine(t: any) {
  const f = fixture(t); let calls = 0;
  const e = new Engine(f.store, { async run() { calls++; throw Error('must not infer'); } }, { async send(_c, _s, id) { return id; } }, { dataDir: f.dir, concurrency: 1, feishu });
  t.after(() => e.stop());
  const reply = (id: string) => f.store.db.prepare("SELECT content FROM outbox WHERE inboxKey=? AND kind='result'").all(`app:${id}`).map(r => r.content).join('');
  return { ...f, e, reply, calls: () => calls };
}

test('profiles are isolated by channel, app and sender and survive reopening and new sessions', t => {
  const f = fixture(t); const p = f.profiles.update(0, { name: '小七', language: 'zh-cn', timezone: 'Asia/Shanghai' }, owner);
  assert.equal(p.language, 'zh-CN'); assert.equal(p.version, 1);
  for (const other of [{ ...identity, channel: 'lark' as const }, { ...identity, appId: 'other' }, { ...identity, userId: 'bob' }]) assert.equal(new Profiles(f.store, other).get().version, 0);
  f.store.saveThread('chat', 'old'); f.store.clearThread('chat');
  const second = new Store(f.file); try { assert.deepEqual(new Profiles(second, identity).get(), p); } finally { second.close(); }
  f.store.bindAccount('app'); assert.throws(() => new Profiles(f.store, { ...identity, appId: 'other' }), /不匹配/);
});

test('profile conflicts never overwrite newer values; clear keeps a version tombstone and metadata-only history', t => {
  const f = fixture(t), second = new Store(f.file);
  try {
    const other = new Profiles(second, identity); assert.equal(other.get().version, 0);
    f.profiles.update(0, { name: '私有称呼', language: 'en-US' }, owner);
    assert.throws(() => other.update(0, { timezone: 'UTC' }, owner), /已被修改/);
    assert.equal(other.get().timezone, '');
    assert.equal(other.update(1, { name: '私有称呼' }, owner).version, 1);
    const cleared = other.update(1, { name: '', language: '', timezone: '' }, owner);
    assert.equal(cleared.version, 2); assert.equal(cleared.name, '');
    assert.doesNotMatch(JSON.stringify(cleared.changes), /私有称呼|en-US/);
    assert.throws(() => f.profiles.update(0, { name: 'stale' }, owner), /已被修改/);
    assert.equal(cleared.changes.length, 2);
  } finally { second.close(); }
});

test('profile fields validate length, locale, timezone, controls and reject permission fields', t => {
  const f = fixture(t);
  for (const patch of [{ name: '字'.repeat(81) }, { name: 'a\nb' }, { name: 'a\u202eb' }, { language: 'not_a_locale' }, { timezone: 'Mars/Base' }, { allowLocalCommits: true }, {}, null]) {
    assert.throws(() => f.profiles.update(0, patch, owner)); assert.equal(f.profiles.get().version, 0);
  }
  assert.throws(() => f.profiles.update(NaN, { name: 'x' }, owner), /版本/);
  assert.equal(f.profiles.update(0, { name: '🦊'.repeat(80), language: 'en-US', timezone: 'UTC' }, owner).version, 1);
});

test('profile and audit writes roll back together on storage failure', t => {
  const f = fixture(t);
  f.store.db.exec("CREATE TRIGGER reject_profile_audit BEFORE INSERT ON profile_changes BEGIN SELECT RAISE(ABORT,'audit_failed'); END");
  assert.throws(() => f.profiles.update(0, { name: 'rollback' }, owner), /audit_failed/);
  assert.equal(f.profiles.get().version, 0);
});

test('schema 2 migration preserves every old table and is repeatable', t => {
  const f = fixture(t); f.store.bindAccount('app'); f.store.enqueue(message('old', 'keep'));
  f.store.db.exec('DROP TABLE user_profiles; DROP TABLE profile_changes; PRAGMA user_version=2');
  const snapshot = () => Object.fromEntries(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('user_profiles','profile_changes') ORDER BY name").all()
    .map(({ name }) => [name, f.store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  const before = snapshot();
  for (let i = 0; i < 2; i++) { const s = new Store(f.file); assert.equal(s.db.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION); s.close(); assert.deepEqual(snapshot(), before); }
  assert.equal(f.store.db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('private self-service is durable and duplicate commands do not repeat profile edits', t => {
  const f = engine(t), m = message('set', '/profile set 0 name 小七');
  assert.equal(f.e.accept(m), true); assert.equal(f.e.accept(m), false);
  assert.equal(f.profiles.get().version, 1); assert.equal(f.profiles.get().changes[0].sourceRef, m.key);
  assert.match(f.reply('set'), /档案已保存/);
  f.e.accept(message('read', '/profile')); assert.match(f.reply('read'), /小七/);
  f.e.accept(message('stale', '/profile set 0 language en-US')); assert.match(f.reply('stale'), /已被修改/);
  f.e.accept(message('new', '/new')); assert.equal(f.profiles.get().name, '小七');
  f.e.accept(message('clear', '/profile clear 1')); assert.equal(f.profiles.get().name, '');
  assert.equal(f.calls(), 0); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.n, 0);
});

test('group, unknown chat type, quotes and rich text cannot reveal or edit a private profile', t => {
  const f = engine(t); f.profiles.update(0, { name: 'private-name' }, owner);
  for (const [id, type, extra] of [['group', 'group', {}], ['unknown', 'unknown', {}], ['quote', 'p2p', { parent_id: 'quoted' }],
    ['rich', 'p2p', { message_type: 'post', content: JSON.stringify({ content: [[{ tag: 'text', text: '/profile set 1 name changed' }]] }) }]] as const) {
    f.e.accept(message(id, '/profile set 1 name changed', 'alice', type, extra));
    assert.doesNotMatch(f.reply(id), /private-name/); assert.equal(f.profiles.get().name, 'private-name');
  }
  f.e.accept(message('bob', '/profile', 'bob')); assert.doesNotMatch(f.reply('bob'), /private-name/);
  f.e.accept(message('spoof', '/profile set 0 userId alice', 'bob')); assert.match(f.reply('spoof'), /只能修改/);
  assert.equal(new Profiles(f.store, { ...identity, userId: 'bob' }).get().version, 0);
  assert.equal(f.calls(), 0);
});

test('self provenance cannot target another sender and material commands never edit profiles', t => {
  const f = engine(t), m = message('alice', '/profile set 0 name alice'); f.store.enqueue(m);
  assert.throws(() => new Profiles(f.store, { ...identity, userId: 'bob' }).update(0, { name: 'forged' }, { source: 'self', sourceRef: m.key }), /本人/);
  f.e.accept(message('material', '/material /profile set 0 name spoofed'));
  assert.equal(f.profiles.get().version, 0);
  f.profiles.update(0, { name: 'private-name', timezone: 'Asia/Tokyo' }, owner);
  f.e.accept(message('run', '/run reply hello'));
  const tasks = new Tasks(f.store), task = tasks.list(message('lookup', ''))[0];
  assert.ok(task); assert.doesNotMatch(tasks.prompt(task), /private-name|Asia\/Tokyo/);
});

test('profile command receipt failure rolls back inbox acceptance and profile mutation', t => {
  const f = engine(t);
  f.store.db.exec("CREATE TRIGGER reject_profile_reply BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'receipt_failed'); END");
  assert.throws(() => f.e.accept(message('write', '/profile set 0 name rollback')), /receipt_failed/);
  assert.equal(f.profiles.get().version, 0); assert.equal(f.store.get('app:write'), undefined);
});
