import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeEvent, type FeishuEvent } from '../src/feishu.js';
import { parseConfig, validateFeishu, type Config } from '../src/config.js';
import { audienceAllows, executionPolicy, projectAllowed } from '../src/access.js';
import { ScopedGitHubAdapter, parseGitHubAccessConfig } from '../src/github-access.js';
import { Store } from '../src/store.js';
import { Tasks, policyHash } from '../src/tasks.js';
import { Management } from '../src/management.js';
import { Engine } from '../src/engine.js';
import { assertReviewDelivery } from '../src/github-review.js';

const f:Config['feishu']={appId:'app',appSecret:'fake',domain:'feishu',allowedUserIds:['legacy'],allowedChatIds:[],requireMention:true,access:{mode:'organization',tenantKey:'tenant'}};
const event=(user='alice',tenant='tenant'):FeishuEvent=>({sender:{sender_type:'user',tenant_key:tenant,sender_id:{open_id:user}},message:{message_id:`message-${user}`,chat_id:'group',chat_type:'group',message_type:'text',content:'{"text":"@bot review PR"}',mentions:[{key:'@bot',id:{open_id:'bot'}}]}});
const member=(user='alice')=>normalizeEvent(event(user),f,'bot')!;
const grant={organization:false,userIds:['alice'],chatIds:['group'],repository:'org/private'};
const github={source:'gh' as const,localGh:{executable:'/usr/bin/gh',configDir:'/tmp/test-gh',login:'service',userId:42},repositories:[],allowedUserIds:[],grants:[grant]};
const target={owner:'org',repo:'private',pullNumber:1,headSha:'a'.repeat(40)};
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'namo-org-')),store=new Store(join(dir,'bot.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return{dir,store};}

test('organization admits unpaired members, rejects outsiders/missing tenant/bots and still requires group mentions',()=>{
  assert.ok(member());assert.equal(member().envelope?.tenantKey,'tenant');
  assert.equal(normalizeEvent(event('x','other'),f,'bot'),undefined);
  const missing=event();delete missing.sender!.tenant_key;assert.equal(normalizeEvent(missing,f,'bot'),undefined);
  const bot=event();bot.sender!.sender_type='app';assert.equal(normalizeEvent(bot,f,'bot'),undefined);
  const silent=event();silent.message!.mentions=[];assert.equal(normalizeEvent(silent,f,'bot'),undefined);
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
test('revoked repository grants block cached review delivery',t=>{
  const{dir,store}=fixture(t);store.enqueue(member());const task=new Tasks(store).create(store.get(member().key)!,{cwd:dir,policyHash:'test'});
  const context={taskId:task.id,ownerId:'alice',chatId:'group'},scope=new ScopedGitHubAdapter(store,github,undefined,undefined,f).authorize(target,context);
  store.db.prepare('INSERT INTO settings VALUES(?,?)').run(`github-review:${task.workstreamId}`,JSON.stringify([{target,context,scope}]));
  const config=parseConfig({feishu:f,github},join(dir,'config.json'));assert.doesNotThrow(()=>assertReviewDelivery(store,config,task));
  assert.throws(()=>assertReviewDelivery(store,{...config,github:{...github,grants:[]}},task),/denied|changed/);
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

test('organization CLI configures admission and a shared repository without pairing each member',async t=>{
  const{dir}=fixture(t),file=join(dir,'config.json');writeFileSync(file,JSON.stringify({dataDir:dir,feishu:{...f,access:undefined,allowedUserIds:[]},codex:{}}));
  const manager=new Management(file,{localGh:async()=>github.localGh});manager.organization=async()=>({tenantKey:'tenant',name:'Fixture organization'});
  const {configureAccess}=await import('../src/access-cli.js'),{configureGitHub}=await import('../src/github-cli.js'),{withLocale}=await import('../src/locale.js');
  const lines:string[]=[];
  await withLocale('en',()=>configureAccess(file,{async confirm(){return true;},async text(){return '';},info(s){lines.push(s);},close(){}},manager));
  assert.equal(manager.config().feishu.access.tenantKey,'tenant');
  const answers=[true,false,true],inputs=['org/private','group',''];
  await withLocale('en',()=>configureGitHub(file,{async confirm(){return answers.shift()!;},async text(){return inputs.shift()!;},info(s){lines.push(s);},close(){}},manager));
  assert.deepEqual(manager.config().github.grants,[{repository:'org/private',organization:false,userIds:[],chatIds:['group']}]);
  assert.doesNotMatch(lines.join('\n'),/[\u4e00-\u9fff]/);
});
