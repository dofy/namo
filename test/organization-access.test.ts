import { storeFixture } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeEvent, type FeishuEvent } from '../src/feishu.js';
import { parseConfig, validateFeishu, type Config } from '../src/config.js';
import { audienceAllows, executionPolicy, projectAllowed, taskAuthorizationValid } from '../src/access.js';
import { ScopedGitHubAdapter, parseGitHubAccessConfig } from '../src/github-access.js';
import { Store, type Incoming } from '../src/store.js';
import { Tasks, policyHash } from '../src/tasks.js';
import { Management } from '../src/management.js';
import { Engine } from '../src/engine.js';
import { assertReviewDelivery, reviewCoverageBrief } from '../src/github-review.js';
import { selectAgent, selectedPolicyHash, agentCodexConfig } from '../src/agent-registry.js';
import { Memories } from '../src/memory.js';
import { memoryProjects } from '../src/memory-access.js';
import { memoryCommand } from '../src/memory-commands.js';
import { buildTaskRunPrompt } from '../src/task-context.js';
import { setUserModel, userModel } from '../src/model-preferences.js';

const f:Config['feishu']={appId:'app',appSecret:'fake',domain:'feishu',allowedUserIds:['legacy'],allowedChatIds:[],requireMention:true,access:{mode:'organization',tenantKey:'tenant'}};
const event=(user='alice',tenant='tenant'):FeishuEvent=>({sender:{sender_type:'user',tenant_key:tenant,sender_id:{open_id:user}},message:{message_id:`message-${user}`,chat_id:'group',chat_type:'group',message_type:'text',content:'{"text":"@bot review PR"}',mentions:[{key:'@bot',id:{open_id:'bot'}}]}});
const member=(user='alice')=>normalizeEvent(event(user),f,'bot')!;
const grant={organization:false,userIds:['alice'],chatIds:['group'],repository:'org/private'};
const github={source:'gh' as const,localGh:{executable:'/usr/bin/gh',configDir:'/tmp/test-gh',login:'service',userId:42},repositories:[],allowedUserIds:[],grants:[grant]};
const target={owner:'org',repo:'private',pullNumber:1,headSha:'a'.repeat(40)};
function fixture(t:any){const { dir, store } = storeFixture(t, 'namo-org-');return{dir,store};}

test('task reauthorization ignores unrelated grants but rejects revocation and changes to its execution policy',t=>{
 const {dir}=fixture(t),c=parseConfig({dataDir:dir,feishu:f,codex:{projects:{app:dir},defaultProject:'app',projectAccess:{app:{organization:false,userIds:[],chatIds:['group'],permission:'read-only'}}}},join(dir,'config.json'));
 const cwd=c.codex.projects!.app;const other=structuredClone(c);other.codex.projects!.other=cwd;other.codex.projectAccess!.other={organization:true,userIds:[],chatIds:[],permission:'read-only'};
 assert.equal(taskAuthorizationValid(c,other,member(),'app',cwd),true);
 const revoked=structuredClone(other);revoked.codex.projectAccess!.app.chatIds=[];
 assert.equal(taskAuthorizationValid(c,revoked,member(),'app',cwd),false);
 const changed=structuredClone(other);changed.codex.projectAccess!.app.permission='workspace-write';
 assert.equal(taskAuthorizationValid(c,changed,member(),'app',cwd),true);
 assert.equal(taskAuthorizationValid(changed,c,member(),'app',cwd),false);
 const tenant=structuredClone(other);tenant.feishu.access!.tenantKey='other';
 assert.equal(taskAuthorizationValid(c,tenant,member(),'app',cwd),false);
});

test('organization admits unpaired members, rejects outsiders/missing tenant/bots and still requires group mentions',()=>{
  assert.ok(member());assert.equal(member().envelope?.tenantKey,'tenant');
  assert.equal(normalizeEvent(event('x','other'),f,'bot'),undefined);
  const missing=event();delete missing.sender!.tenant_key;assert.equal(normalizeEvent(missing,f,'bot'),undefined);
  const bot=event();bot.sender!.sender_type='app';assert.equal(normalizeEvent(bot,f,'bot'),undefined);
  const silent=event();silent.message!.mentions=[];assert.equal(normalizeEvent(silent,f,'bot'),undefined);
  const forwarded=event();forwarded.message!.mentions=[];forwarded.message!.message_type='merge_forward';forwarded.message!.content='{}';
  const material=normalizeEvent(forwarded,f,'bot');assert.equal(material?.envelope?.kind,'material');assert.equal(material?.envelope?.materials[0]?.type,'merge_forward');
  assert.equal(normalizeEvent(event(),{...f,allowedChatIds:['other']},'bot'),undefined);
  assert.equal(normalizeEvent(event(),{...f,access:undefined},'bot'),undefined);
  validateFeishu(parseConfig({feishu:{...f,allowedUserIds:[]}},'/tmp/namo-test/config.json'));
});
test('private member grants do not permit group disclosure and resource grants do not bypass tenant admission',t=>{
  const{store,dir}=fixture(t);store.enqueue(member());const task=new Tasks(store).create(store.get(member().key)!,{cwd:dir,policyHash:'test'});
  const context={taskId:task.id,ownerId:'alice',chatId:'group'};
  assert.equal(audienceAllows({...grant,chatIds:[]},member()),false);
  const adapter=new ScopedGitHubAdapter(store,github,undefined,undefined,f);
  assert.match(adapter.authorize(target,context)!,/^[a-f0-9]{64}$/);
  for(const denied of [{...github,grants:[{...grant,chatIds:[]}]},{...github,grants:[]}]) assert.throws(()=>new ScopedGitHubAdapter(store,denied,undefined,undefined,f).authorize(target,context),/access_denied/);
  assert.throws(()=>adapter.authorize({...target,repo:'another'},context),/access_denied/);
  assert.throws(()=>adapter.authorize(target,{...context,ownerId:'bob'}),/access_denied/);
  assert.throws(()=>new ScopedGitHubAdapter(store,github,undefined,undefined,{...f,access:{mode:'organization',tenantKey:'other'}}).authorize(target,context),/access_denied/);
  assert.throws(()=>parseGitHubAccessConfig({...github,allowedUserIds:['alice']}));
  assert.throws(()=>parseGitHubAccessConfig({...github,grants:[grant,grant]}));
});
test('organization projects default deny; authorized execution drops global networking, commits and extra host reads',t=>{
  const{dir}=fixture(t);const config=parseConfig({feishu:f,codex:{projects:{app:dir},defaultProject:'app',sandbox:'workspace-write',networkAccess:true,allowLocalCommits:true,readPaths:[dir]}},join(dir,'config.json'));
  assert.equal(projectAllowed(config.codex,f,member(),'app'),false);
  assert.throws(()=>executionPolicy(config.codex,f,member(),'app'),/denied/);
  const isolated=executionPolicy(config.codex,f,member());assert.equal(isolated.sandbox,'read-only');assert.equal(isolated.networkAccess,false);assert.equal(isolated.allowLocalCommits,false);assert.deepEqual(isolated.readPaths,[]);
  const shared={...config.codex,projectAccess:{app:{...grant,permission:'read-only' as const}}};
  assert.equal(executionPolicy(shared,f,member(),'app').sandbox,'read-only');
  assert.notEqual(policyHash(isolated),policyHash(executionPolicy(shared,f,member())));
  assert.equal(executionPolicy(config.codex,{...f,access:undefined},member()),config.codex);
});
test('two organization members in one group get separate workspaces and model sessions',t=>{
  const{dir,store}=fixture(t);const config=parseConfig({dataDir:dir,feishu:f,codex:{}},join(dir,'config.json'));
  writeFileSync(config.file,JSON.stringify({dataDir:dir,feishu:f,codex:{}}));
  const engine=new Engine(store,{async run(){throw Error('not started');}},{async send(){return 'id';}},config);
  engine.accept(member('alice'));engine.accept(member('bob'));
  const rows=store.db.prepare('SELECT ownerId,cwd,workstreamId FROM tasks ORDER BY ownerId').all();
  assert.equal(rows.length,2);assert.notEqual(rows[0].cwd,rows[1].cwd);assert.notEqual(rows[0].workstreamId,rows[1].workstreamId);
  assert.equal(new Tasks(store).owned(String(store.db.prepare('SELECT id FROM tasks WHERE ownerId=?').get('alice')!.id),member('bob')),undefined);
});
test('organization model allowlist rejects arbitrary selections and group tasks use the service default',t=>{
 const {dir,store}=fixture(t),file=join(dir,'config.json');
 const raw={dataDir:dir,feishu:f,codex:{model:'service-model',allowedModels:['allowed-model']}};writeFileSync(file,JSON.stringify(raw));
 const c=parseConfig(raw,file),engine=new Engine(store,{async run(){throw Error('not started');}},{async send(){return 'id';}},c);
 const identity={channel:'feishu' as const,appId:'app',userId:'alice'};setUserModel(store,identity,'old-model');
 const dm={...member(),key:'model-denied',messageId:'model-denied',chatId:'dm',chatKey:'app:dm',text:'/model arbitrary',envelope:{...member().envelope!,chatType:'p2p' as const,scopeKey:'app:dm'}};
 engine.accept(dm);assert.equal(userModel(store,identity),'old-model');
 assert.match(String(store.db.prepare("SELECT content FROM outbox WHERE inboxKey='model-denied' AND kind='result'").get()?.content),/未在服务允许列表/);
 engine.accept({...dm,key:'model-allowed',messageId:'model-allowed',text:'/model allowed-model'});assert.equal(userModel(store,identity),'allowed-model');
 const group=member();engine.accept(group);const task=new Tasks(store).get(store.get(group.key)!.taskId!)!;
 assert.equal(new Tasks(store).model(task.id),'service-model');
});
test('revoked repository grants block cached review delivery',t=>{
  const{dir,store}=fixture(t);store.enqueue(member());const task=new Tasks(store).create(store.get(member().key)!,{cwd:dir,policyHash:'test'});
  const context={taskId:task.id,ownerId:'alice',chatId:'group'},scope=new ScopedGitHubAdapter(store,github,undefined,undefined,f).authorize(target,context);
  store.db.prepare('INSERT INTO settings VALUES(?,?)').run(`github-review:${task.workstreamId}`,JSON.stringify([{target,context,scope}]));
  const config=parseConfig({feishu:f,github},join(dir,'config.json'));assert.doesNotThrow(()=>assertReviewDelivery(store,config,task));
  assert.throws(()=>assertReviewDelivery(store,{...config,github:{...github,grants:[]}},task),/denied|changed/);
});
test('review coverage reports reads as evidence, not as completed review',t=>{
  const {store}=fixture(t);
  assert.equal(reviewCoverageBrief(store,'task'),'');
  store.db.prepare('INSERT INTO settings VALUES(?,?)').run('github-review-coverage:task',JSON.stringify({headSha:'a'.repeat(40),baseSha:'b'.repeat(40),totalFiles:86,completedFiles:31,incompleteFiles:2,next:{index:31,offset:0},fileListLimited:false}));
  const text=reviewCoverageBrief(store,'task');
  assert.match(text,/31\/86/);assert.match(text,/2 个补丁/);assert.match(text,/仍有内容未读取/);assert.match(text,/读取不等于已审查/);
});
test('management saves shared credentials without a paired owner, detects revision conflicts and exposes no credentials',async t=>{
  const{dir}=fixture(t),file=join(dir,'config.json');writeFileSync(file,JSON.stringify({dataDir:dir,feishu:f,codex:{}}));
  const manager=new Management(file,{localGh:async()=>github.localGh});
  const before=manager.config();const saved=await manager.saveGitHub(before.revision,{github:{source:'gh',repositories:[],allowedUserIds:[],grants:[grant]}});
  assert.deepEqual(saved.github.grants,[grant]);assert.equal(saved.github.localGh.login,'service');assert.doesNotMatch(JSON.stringify(saved),/test-gh/);
  await assert.rejects(manager.saveGitHub(before.revision,{github:{source:'gh',repositories:[],allowedUserIds:[],grants:[]}}));
  manager.save(saved.revision,{serviceAccess:{access:null,allowedUserIds:['legacy'],allowedChatIds:[]}});
  assert.equal(manager.config().feishu.access,null);
});

test('organization policies remain binding across agent profile selection',t=>{
  const{dir}=fixture(t),file=join(dir,'config.json');
  const c=parseConfig({dataDir:dir,feishu:f,codex:{networkAccess:true,readPaths:[dir]},agents:{profiles:{review:{adapter:'codex',enabled:true,model:'test-model'}}}},file);
  const selection=selectAgent(c,'review'),policy=executionPolicy(c.codex,f,member(),undefined,github),effective={...c,codex:policy};
  const chosen=agentCodexConfig(effective,selection);
  assert.equal(chosen.sandbox,'read-only');assert.equal(chosen.networkAccess,false);assert.deepEqual(chosen.readPaths,[]);
  assert.equal(chosen.accessScope,policy.accessScope);
  assert.notEqual(selectedPolicyHash(effective,selection),selectedPolicyHash(c,selection));
  const revoked={...c,codex:executionPolicy(c.codex,f,member(),undefined,{...github,grants:[]})};
  assert.notEqual(selectedPolicyHash(effective,selection),selectedPolicyHash(revoked,selection));
});

test('a revoked legacy project gives a safe new-session path without inheriting its workspace or thread',t=>{
  const{dir,store}=fixture(t),file=join(dir,'config.json');
  const raw={dataDir:dir,feishu:f,codex:{projects:{host:dir},defaultProject:'host'}};
  writeFileSync(file,JSON.stringify(raw));const config=parseConfig(raw,file),tasks=new Tasks(store);
  const original=member();store.enqueue(original);const old=tasks.create(store.get(original.key)!,{project:'host',cwd:dir,policyHash:'legacy'});
  store.saveThread(tasks.sessionKey(old),'legacy-private-thread');
  store.db.prepare("UPDATE tasks SET state='succeeded',finishedAt=? WHERE id=?").run(Date.now(),old.id);
  store.db.prepare("UPDATE inbox SET state='replied' WHERE key=?").run(original.key);
  const engine=new Engine(store,{async run(){throw Error('not started');}},{async send(){return 'id';}},config);
  const next=(id:string,text:string)=>({...member(),key:id,messageId:id,text});
  const denied=next('denied','review PR');engine.accept(denied);
  assert.equal(store.get(denied.key)?.taskId,null);
  assert.match(String(store.db.prepare('SELECT content FROM outbox WHERE inboxKey=?').get(denied.key)?.content),/发送 \/new 开启隔离会话/);
  assert.equal(tasks.binding(denied)?.id,old.workstreamId);
  engine.accept(next('new','/new'));const fresh=next('review','review PR');engine.accept(fresh);
  const current=tasks.get(store.get(fresh.key)!.taskId!)!;
  assert.ok(current);assert.equal(current.project,null);assert.notEqual(current.cwd,old.cwd);assert.notEqual(current.workstreamId,old.workstreamId);
  assert.equal(tasks.thread(current),undefined);assert.equal(tasks.thread(old),'legacy-private-thread');
});

test('organization memory ACL reaches prompts and commands, distinguishes group grants and revocation', t => {
  const dir = mkdtempSync(join(tmpdir(), 'namo-memory-acl-')), store = new Store(join(dir, 'db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = parseConfig({ feishu: { appId: 'app', access: { mode: 'organization', tenantKey: 'tenant' } },
    codex: { projects: { atlas: dir }, defaultProject: 'atlas', projectAccess: {
      atlas: { organization: false, userIds: ['alice'], chatIds: ['authorized-team'], permission: 'read-only' } } } }, join(dir, 'config.json'));
  const memory = new Memories(store);
  const saved = memory.upsertAutomatic({ key: 'atlas.overview', kind: 'project_knowledge', level: 'global', privacy: 'shared',
    project: 'atlas', text: 'ATLAS_RESOURCE_ONLY', evidence: ['Atlas overview'], sourceMessageIds: ['source'], observedAt: 1 },
    { kind: 'local-owner', authenticated: true, ownerId: 'alice', project: 'atlas', chatKey: 'alice', chatType: 'p2p', source: { kind: 'automatic', ref: 'seed' } })!;
  const input = (id: string, user: string, chat = user, group = false): Incoming => ({ key: id, messageId: id, chatId: chat,
    chatKey: 'app:' + chat, senderId: user, text: 'atlas overview', envelope: { version: 1, type: 'text', kind: 'instruction',
      scopeKey: 'app:' + chat, chatType: group ? 'group' : 'p2p', tenantKey: 'tenant', materials: [], limitations: [] } });
  for (const [m, permitted] of [[input('bob', 'bob'), false], [input('alice', 'alice'), true],
    [input('private-grant-in-group', 'alice', 'other-team', true), false], [input('group-grant', 'bob', 'authorized-team', true), true]] as const) {
    store.enqueue(m); const tasks = new Tasks(store), task = tasks.create(store.get(m.key)!, { cwd: dir, policyHash: 'fixture' });
    const prompt = buildTaskRunPrompt(store, task, store.get(m.key)!, config, tasks.start(task));
    assert.equal(prompt.includes('ATLAS_RESOURCE_ONLY'), permitted);
  }
  const m = input('command', 'bob'); m.text = '/memories';
  assert.doesNotMatch(memoryCommand(store, m, ['bob'], null, s => s, memoryProjects(config, m))!, /ATLAS_RESOURCE_ONLY/);
  config.codex.projectAccess!.atlas.userIds = [];
  const who = input('revoked', 'alice');
  assert.deepEqual(memory.search({ kind: 'verified-user', authenticated: true, ownerId: 'alice', chatType: 'p2p', chatKey: who.chatKey,
    allowedProjects: memoryProjects(config, who) }).map(r => r.id), []);
  assert.equal(memory.manage({ kind: 'local-owner', authenticated: true, ownerId: 'alice' })[0]?.id, saved.id);
});
