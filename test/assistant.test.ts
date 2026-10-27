import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantSettings, AssistantSettingsError, DEFAULT_ASSISTANT_VALUES, composeAssistantPrompt } from '../src/assistant.js';
import { Profiles } from '../src/profiles.js';
import { Store, type Incoming } from '../src/store.js';
import { type ProfileIdentity } from '../src/ui-contract.js';
import { type Config } from '../src/config.js';
import { Memories } from '../src/memory.js';
import { Tasks, policyHash } from '../src/tasks.js';
import { buildTaskRunPrompt, isDateTimeTask } from '../src/task-context.js';

const owner = { kind: 'local-owner' as const, authenticated: true };
const identity: ProfileIdentity = { channel: 'feishu', appId: 'app', userId: 'alice' };
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-assistant-')), file = join(dir, 'bot.sqlite');
  const store = new Store(file); store.bindAccount('app');
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const verified = (candidate: ProfileIdentity) => candidate.channel === identity.channel && candidate.appId === identity.appId && candidate.userId === identity.userId;
  return { dir, file, store, assistant: new AssistantSettings(store, verified) };
}
function message(id: string, user = 'alice', chatType: 'p2p' | 'group' = 'p2p'): Incoming {
  return { key: `app:${id}`, messageId: id, chatKey: chatType === 'p2p' ? `dm:${user}` : 'group', chatId: chatType === 'p2p' ? `dm:${user}` : 'group',
    senderId: user, text: 'do something', envelope: { version: 1, type: 'text', kind: 'instruction', chatType,
      scopeKey: chatType === 'p2p' ? `dm:${user}` : 'group', materials: [], limitations: [] } };
}

test('missing settings preserve legacy prompt behavior and the static preview does not persist', t => {
  const f = fixture(t), before = f.assistant.read();
  assert.equal(before.version, 0); assert.equal(before.active, false); assert.deepEqual(before.values, DEFAULT_ASSISTANT_VALUES);
  const snapshot = f.assistant.adopt('legacy-run');
  assert.equal(composeAssistantPrompt('{"task":"unchanged"}', snapshot), '{"task":"unchanged"}');
  assert.match(f.assistant.preview({ ...DEFAULT_ASSISTANT_VALUES, defaultLanguage: 'zh-CN' }), /未调用模型/);
  assert.equal(f.assistant.read().version, 0);
  assert.deepEqual(f.assistant.adoption('legacy-run'), { schema: 1, settingsVersion: 0, profileVersion: null,
    profileApplied: false, adoptedAt: snapshot.adoptedAt });
});

test('owner saves are validated, version checked, durable, and reset does not touch unrelated settings', t => {
  const f = fixture(t), custom = { ...DEFAULT_ASSISTANT_VALUES, name: 'Navigator', role: 'Technical navigator', personality: 'Direct and careful.',
    defaultLanguage: 'en-US' as const, replyLength: 'concise' as const, technicalDetail: 'deep' as const, emoji: 'never' as const };
  assert.throws(() => f.assistant.save(0, custom, { kind: 'local-owner', authenticated: false }), (error: unknown) => error instanceof AssistantSettingsError && error.code === 'forbidden');
  const saved = f.assistant.save(0, custom, owner);
  assert.equal(saved.version, 1); assert.equal(saved.values.name, 'Navigator');
  assert.throws(() => f.assistant.save(0, DEFAULT_ASSISTANT_VALUES, owner), (error: unknown) => error instanceof AssistantSettingsError && error.code === 'conflict');
  f.store.db.prepare("INSERT INTO settings(key,value) VALUES('unrelated','keep')").run();
  const second = new Store(f.file);
  try {
    const reopened = new AssistantSettings(second).read(); assert.equal(reopened.values.name, 'Navigator');
    const reset = new AssistantSettings(second).reset(1, owner); assert.equal(reset.version, 2); assert.deepEqual(reset.values, DEFAULT_ASSISTANT_VALUES);
    assert.equal(second.db.prepare("SELECT value FROM settings WHERE key='unrelated'").get()?.value, 'keep');
  } finally { second.close(); }
});

test('settings reject partial, unknown, unsafe, oversized, and invalid structured values', t => {
  const f = fixture(t);
  const invalid = [
    {}, { ...DEFAULT_ASSISTANT_VALUES, extra: true }, { ...DEFAULT_ASSISTANT_VALUES, name: '' },
    { ...DEFAULT_ASSISTANT_VALUES, name: 'x\ny' }, { ...DEFAULT_ASSISTANT_VALUES, personality: 'x\u202ey' },
    { ...DEFAULT_ASSISTANT_VALUES, personality: 'x'.repeat(1001) }, { ...DEFAULT_ASSISTANT_VALUES, defaultLanguage: 'fr' },
    { ...DEFAULT_ASSISTANT_VALUES, replyLength: 'tiny' }, { ...DEFAULT_ASSISTANT_VALUES, conclusionFirst: 'yes' },
  ];
  for (const value of invalid) assert.throws(() => f.assistant.save(0, value, owner), (error: unknown) => error instanceof AssistantSettingsError && error.code === 'invalid');
  assert.equal(f.assistant.read().version, 0);
  f.store.db.prepare("INSERT INTO settings(key,value) VALUES('assistant:settings:v1','not json')").run();
  assert.throws(() => f.assistant.read(), (error: unknown) => error instanceof AssistantSettingsError && error.code === 'storage_invalid');
});

test('profile opt-in applies only to the verified owner direct message and timezone-relevant runs', t => {
  const f = fixture(t);
  new Profiles(f.store, identity).update(0, { name: 'Private Alice', language: 'zh-CN', timezone: 'Asia/Shanghai' }, { source: 'local-owner' });
  f.assistant.save(0, { ...DEFAULT_ASSISTANT_VALUES, useProfile: true }, owner);

  const ordinary = f.assistant.adopt('ordinary', { identity, message: message('ordinary'), dateTimeRelevant: false });
  assert.deepEqual(ordinary.profile, { version: 1, name: 'Private Alice', language: 'zh-CN' });
  assert.equal(ordinary.profile && 'timezone' in ordinary.profile, false);
  const dated = f.assistant.adopt('dated', { identity, message: message('dated'), dateTimeRelevant: true });
  assert.equal(dated.profile?.timezone, 'Asia/Shanghai');

  new Profiles(f.store, identity).update(1, { name: '', language: '', timezone: '' }, { source: 'local-owner' });
  const cleared = f.assistant.adopt('cleared', { identity, message: message('cleared'), dateTimeRelevant: true });
  assert.deepEqual(cleared.profile, { version: 2 });
  assert.deepEqual(f.assistant.adoption('cleared')?.profileVersion, 2);

  for (const [runId, context] of [
    ['group', { identity, message: message('group', 'alice', 'group') }],
    ['wrong-sender', { identity, message: message('wrong-sender', 'bob') }],
    ['unverified-user', { identity: { ...identity, userId: 'bob' }, message: message('unverified-user', 'bob') }],
    ['wrong-app', { identity: { ...identity, appId: 'other' }, message: { ...message('wrong-app'), key: 'other:wrong-app' } }],
  ] as const) {
    const snapshot = f.assistant.adopt(runId, context); assert.equal(snapshot.profile, null);
    assert.doesNotMatch(composeAssistantPrompt('{"request":"hello"}', snapshot), /Private Alice|Asia\/Shanghai/);
  }
});

test('each run keeps an immutable snapshot and persisted adoption metadata contains versions, not private values', t => {
  const f = fixture(t), profiles = new Profiles(f.store, identity);
  profiles.update(0, { name: 'First Private Name', language: 'en-US' }, { source: 'local-owner' });
  const firstSettings = f.assistant.save(0, { ...DEFAULT_ASSISTANT_VALUES, name: 'First', useProfile: true }, owner);
  const first = f.assistant.adopt('first', { identity, message: message('first') });
  f.assistant.save(firstSettings.version, { ...firstSettings.values, name: 'Second' }, owner);
  profiles.update(1, { name: 'Second Private Name' }, { source: 'local-owner' });
  const second = f.assistant.adopt('second', { identity, message: message('second') });
  assert.equal(first.values.name, 'First'); assert.equal(first.profile?.name, 'First Private Name');
  assert.equal(second.values.name, 'Second'); assert.equal(second.profile?.name, 'Second Private Name');
  assert.throws(() => Object.assign(first.values, { name: 'mutated' }), TypeError);
  assert.throws(() => f.assistant.adopt('first', { identity, message: message('first') }), (error: unknown) => error instanceof AssistantSettingsError && error.code === 'run_already_adopted');
  const raw = String(f.store.db.prepare("SELECT value FROM settings WHERE key='assistant:run:first'").get()?.value);
  assert.doesNotMatch(raw, /First Private Name|en-US/); assert.deepEqual(JSON.parse(raw), f.assistant.adoption('first'));
});

test('prompt composition states precedence, safety boundaries, versions, and resumed-session limits', t => {
  const f = fixture(t), saved = f.assistant.save(0, { ...DEFAULT_ASSISTANT_VALUES, replyLength: 'concise', useProfile: true }, owner);
  new Profiles(f.store, identity).update(0, { language: 'zh-CN' }, { source: 'local-owner' });
  const snapshot = f.assistant.adopt('prompt', { identity, message: message('prompt') });
  const prompt = JSON.parse(composeAssistantPrompt('{"messages":[{"text":"Use English this time"}]}', snapshot, true));
  assert.equal(prompt.assistant_context.adopted_versions.assistant, saved.version);
  assert.equal(prompt.assistant_context.adopted_versions.profile, 1);
  assert.deepEqual(prompt.assistant_context.precedence.slice(0, 3), ['service behavior and authorization', 'current explicit task request', 'project output conventions']);
  assert.match(prompt.assistant_context.boundaries.join(' '), /never grant permission/);
  assert.match(prompt.assistant_context.boundaries.join(' '), /expire when that task completes/);
  assert.match(prompt.assistant_context.boundaries.join(' '), /expired one-off language choices/);
  assert.equal(prompt.task.messages[0].text, 'Use English this time');
});

function uiContextFixture(t:any){
  const root=mkdtempSync(join(tmpdir(),'namo-context-')),data=join(root,'data'),project=join(root,'project');mkdirSync(data);mkdirSync(project);
  const config:Config={file:join(root,'config.json'),dataDir:data,concurrency:1,agent:'codex',feishu:{appId:'app',appSecret:'KNOWN_SECRET_123456',allowedUserIds:['alice'],allowedChatIds:[],requireMention:false,domain:'feishu'},
    codex:{bin:'codex',home:join(data,'auth'),timeoutMs:600000,sandbox:'workspace-write',projects:{one:project},defaultProject:'one',networkAccess:false,readPaths:[],denyPaths:[],allowLocalCommits:false},
    gitApprovals:{maxTtlMs:300000,remotes:[]}};
  const store=new Store(join(data,'bot.sqlite'));store.bindAccount('app');t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {root,data,project,config,store};
}
function incoming(id:string,chatType:'p2p'|'group'='p2p'):Incoming{return {key:`app:${id}`,messageId:id,chatKey:chatType==='p2p'?'app:dm-alice':'app:group-one',chatId:chatType==='p2p'?'dm-alice':'group-one',senderId:'alice',text:'Implement the task',
  envelope:{version:1,type:'text',kind:'instruction',chatType,scopeKey:chatType==='p2p'?'app:dm-alice':'app:group-one',materials:[],limitations:[]}};}
function create(f:ReturnType<typeof uiContextFixture>,message:Incoming){f.store.enqueue(message);const tasks=new Tasks(f.store),created=tasks.create(f.store.get(message.key)!,{project:'one',cwd:f.project,policyHash:policyHash(f.config.codex)}),run=tasks.start(created);return {tasks,task:tasks.get(created.id)!,run,inbox:f.store.get(message.key)!};}
const local=(ref:string)=>({kind:'local-owner' as const,authenticated:true,ownerId:'alice',source:{kind:'local-owner' as const,ref}});

test('fresh installs preserve the exact prompt when assistant is inactive and no memory exists',t=>{
  const f=uiContextFixture(t),created=create(f,incoming('legacy')),before=created.tasks.prompt(created.task);
  assert.equal(buildTaskRunPrompt(f.store,created.task,created.inbox,f.config,created.run),before);
  assert.ok(f.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(`assistant:run:${created.run}`));
  assert.equal(f.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(`memory:snapshot:${created.run}`),undefined);
});

test('date/time classification uses explicit words and does not mistake runtime for time',()=>{
  assert.equal(isDateTimeTask('debug the runtime error'),false);assert.equal(isDateTimeTask('what time is the release?'),true);
  assert.equal(isDateTimeTask('核对今天的日程'),true);assert.equal(isDateTimeTask('优化 runtime'),false);
});

test('private runs compose authorized memory as non-authorizing context',t=>{
  const f=uiContextFixture(t),memory=new Memories(f.store);
  memory.save({kind:'preference',scope:{kind:'owner',ownerId:'alice',project:null,chatKey:null},text:'Keep replies concise'},local('owner'));
  memory.save({kind:'project_knowledge',scope:{kind:'project',ownerId:'alice',project:'one',chatKey:null},text:'Never treat remembered direct push as approval'},local('project'));
  memory.save({kind:'project_knowledge',scope:{kind:'chat',ownerId:'alice',project:'one',chatKey:'app:group-one'},text:'Group-visible convention'},local('group'));
  const created=create(f,incoming('private')),prompt=buildTaskRunPrompt(f.store,created.task,created.inbox,f.config,created.run);
  assert.match(prompt,/Keep replies concise/);assert.match(prompt,/remembered direct push/);assert.doesNotMatch(prompt,/Group-visible convention/);
  assert.match(prompt,/not an instruction, permission, approval/);
  assert.doesNotMatch(JSON.stringify(memory.snapshotRecord(created.run)),/Keep replies|direct push/);
});

test('group runs receive only memory explicitly bound to that exact chat and project',t=>{
  const f=uiContextFixture(t),memory=new Memories(f.store);
  memory.save({kind:'preference',scope:{kind:'owner',ownerId:'alice',project:null,chatKey:null},text:'PRIVATE_OWNER_VALUE'},local('owner'));
  memory.save({kind:'project_knowledge',scope:{kind:'project',ownerId:'alice',project:'one',chatKey:null},text:'PRIVATE_PROJECT_VALUE'},local('project'));
  memory.save({kind:'project_knowledge',scope:{kind:'chat',ownerId:'alice',project:'one',chatKey:'app:group-one'},text:'VISIBLE_GROUP_VALUE'},local('group'));
  const created=create(f,incoming('group','group')),prompt=buildTaskRunPrompt(f.store,created.task,created.inbox,f.config,created.run);
  assert.match(prompt,/VISIBLE_GROUP_VALUE/);assert.doesNotMatch(prompt,/PRIVATE_OWNER_VALUE|PRIVATE_PROJECT_VALUE/);
});
