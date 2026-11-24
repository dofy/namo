import { storeFixture, waitFor } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/store.js';
import { Profiles } from '../src/profiles.js';
import { Engine } from '../src/engine.js';
import { normalizeEvent } from '../src/feishu.js';
import { Tasks } from '../src/tasks.js';
import { readFileSync } from 'node:fs';
import type { ProfileIdentity } from '../src/ui-contract.js';

const identity: ProfileIdentity = { channel: 'feishu', appId: 'app', userId: 'alice' };
const owner = { source: 'local-owner' as const };
function fixture(t: any) {
  const { dir, file, store } = storeFixture(t, 'namo-profiles-');
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
  const e = new Engine(f.store, { async run() { calls++; throw Error('must not infer'); } }, { async send(_c, _s, id) { return id; } }, { dataDir: f.dir, concurrency: 1, feishu, codex:{bin:'codex',home:f.dir+'/codex-home',sandbox:'read-only',timeoutMs:1000} });
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

test('model commands update the isolated Agent model and new tasks keep their selected value', t => {
  const f=engine(t), file=f.dir+'/codex-home/config.toml';
  f.e.accept(message('choose','/model model-one'));
  assert.match(readFileSync(file,'utf8'),/model = "model-one"/);
  f.e.accept(message('first','do a task'));
  const first=f.store.get('app:first')!.taskId!;
  f.e.accept(message('change','/model model-two'));
  f.e.accept(message('second','another task'));
  const second=f.store.get('app:second')!.taskId!;
  assert.equal(new Tasks(f.store).model(first),'model-one');
  assert.equal(new Tasks(f.store).model(second),'model-two');
  f.e.accept(message('group','/model attack','alice','group'));
  f.e.accept(message('quote','/model attack','alice','p2p',{parent_id:'other'}));
  assert.match(readFileSync(file,'utf8'),/model = "model-two"/);
  f.e.accept(message('reset','/model default'));
  assert.ok(f.reply('reset').includes('**新任务模型**  跟随 Codex 运行时默认'));
  f.e.accept(message('invalid','/model ../bad'));
  assert.doesNotMatch(readFileSync(file,'utf8'),/model\s*=/);
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

test('/model reads and writes the selected Agent in isolation without inference', async t => {
  const f=fixture(t), posts: any[]=[];
  const codex={bin:'codex',home:f.dir,sandbox:'read-only' as const,timeoutMs:1000,model:'gpt-6.2-sol'};
  const agents={defaultProfile:'codex',profiles:{claude:{adapter:'claude' as const,enabled:true,model:'sonnet'}}};
  const e=new Engine(f.store,{async run(){throw Error('unexpected inference');}},
    {async send(_chat,_text,id){return id;},async sendPost(_chat,post,id){posts.push(post);return id;}},
    {dataDir:f.dir,concurrency:1,feishu,codex,agents});
  t.after(()=>e.stop());
  (e as any).modelCatalog={models:[{id:'gpt-6.2-sol',isDefault:true},{id:'gpt-6.1-terra',isDefault:false}],start:()=>{},refresh:async()=>{},stop:async()=>{}};
  e.start();
  const send = async (id: string, text: string) => {
    e.accept(message(id, text));
    await waitFor(() => f.store.get(`app:${id}`)?.state === 'replied');
  };
  await send('select-pretty','/model gpt-6.1-terra');
  await send('read-pretty','/model');
  await send('switch-agent','/agent claude');
  await send('set-claude','/model router/sonnet[1m]');
  await send('read-claude','/model');
  const content=(id:string)=>String(f.store.db.prepare("SELECT content FROM outbox WHERE inboxKey=? AND kind='result'").get(`app:${id}`)?.content);
  const codexStatus=content('read-pretty');
  assert.ok(codexStatus.includes('**当前 Agent**  Codex'));
  assert.ok(codexStatus.includes('**新任务模型**  `gpt-6.1-terra`'));
  assert.ok(codexStatus.includes('**最近任务模型**  暂无记录'));
  assert.ok(codexStatus.includes('- `gpt-6.1-terra` · 当前'));
  assert.ok(codexStatus.includes('`/model default`'));
  const claudeStatus=content('read-claude');
  assert.ok(claudeStatus.includes('**当前 Agent**  Claude Code'));
  assert.ok(claudeStatus.includes('**新任务模型**  `router/sonnet[1m]`'));
  assert.equal(JSON.parse(readFileSync(f.dir+'/agents/claude/.claude/settings.json','utf8')).model,'router/sonnet[1m]');
  assert.match(readFileSync(f.dir+'/config.toml','utf8'),/gpt-6.1-terra/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.n,0);
  assert.ok(posts.some(post=>post.zh_cn.content[0][0].text===codexStatus));
});

test('help explains natural language controls without requiring commands', t => {
  const f=engine(t);f.e.accept(message('help-readable','/help'));
  const help=f.reply('help-readable');
  assert.match(help,/直接说出你的要求/);
  assert.match(help,/定时任务/);
  assert.doesNotMatch(help,/\/(?:task|resume|model|push)/);
  assert.equal(f.calls(),0);
});
