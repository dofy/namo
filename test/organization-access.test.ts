import { storeFixture } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeEvent, type FeishuEvent } from '../src/feishu.js';
import { parseConfig, validateFeishu, type Config } from '../src/config.js';
import { audienceAllows, executionPolicy, taskAuthorizationValid } from '../src/access.js';
import { ScopedGitHubAdapter, parseGitHubAccessConfig } from '../src/github-access.js';
import { type Incoming } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { Management } from '../src/management.js';
import { Engine } from '../src/engine.js';
import { assertReviewDelivery, reviewCoverageBrief } from '../src/github-review.js';
import { selectAgent, selectedPolicyHash, agentCodexConfig } from '../src/agent-registry.js';
import { Memories } from '../src/memory.js';
import { memoryDirectories } from '../src/memory-access.js';
import { setUserModel, userModel } from '../src/model-preferences.js';

const f:Config['feishu']={appId:'app',appSecret:'fake',domain:'feishu',allowedUserIds:['legacy'],allowedChatIds:[],requireMention:true,access:{mode:'organization',tenantKey:'tenant'}};
const event=(user='alice',tenant='tenant'):FeishuEvent=>({sender:{sender_type:'user',tenant_key:tenant,sender_id:{open_id:user}},message:{message_id:`message-${user}`,chat_id:'group',chat_type:'group',message_type:'text',content:'{"text":"@bot review PR"}',mentions:[{key:'@bot',id:{open_id:'bot'}}]}});
const member=(user='alice')=>normalizeEvent(event(user),f,'bot')!;
const grant={organization:false,userIds:['alice'],chatIds:['group'],repository:'org/private'};
const github={source:'gh' as const,localGh:{executable:'/usr/bin/gh',configDir:'/tmp/test-gh',login:'service',userId:42},repositories:[],allowedUserIds:[],grants:[grant]};
const target={owner:'org',repo:'private',pullNumber:1,headSha:'a'.repeat(40)};
function fixture(t:any){const { dir, store } = storeFixture(t, 'namo-org-');return{dir,store};}

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
test('GitHub is shared by admitted members while tenant and task identity remain enforced',t=>{
  const{store,dir}=fixture(t);store.enqueue(member());const task=new Tasks(store).create(store.get(member().key)!,{cwd:dir,policyHash:'test'});
  const context={taskId:task.id,ownerId:'alice',chatId:'group'};
  assert.equal(audienceAllows({...grant,chatIds:[]},member()),false);
  const adapter=new ScopedGitHubAdapter(store,github,undefined,undefined,f);
  assert.match(adapter.authorize(target,context)!,/^[a-f0-9]{64}$/);
  for(const shared of [{...github,grants:[{...grant,chatIds:[]}]},{...github,grants:[]}]) assert.ok(new ScopedGitHubAdapter(store,shared,undefined,undefined,f).authorize(target,context));
  assert.ok(adapter.authorize({...target,repo:'another'},context));
  assert.throws(()=>adapter.authorize(target,{...context,ownerId:'bob'}),/access_denied/);
  assert.throws(()=>new ScopedGitHubAdapter(store,github,undefined,undefined,{...f,access:{mode:'organization',tenantKey:'other'}}).authorize(target,context),/access_denied/);
  assert.throws(()=>parseGitHubAccessConfig({...github,allowedUserIds:['alice']}));
  assert.throws(()=>parseGitHubAccessConfig({...github,grants:[grant,grant]}));
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
test('revoked bot admission blocks cached review delivery',t=>{
  const{dir,store}=fixture(t);store.enqueue(member());const task=new Tasks(store).create(store.get(member().key)!,{cwd:dir,policyHash:'test'});
  const context={taskId:task.id,ownerId:'alice',chatId:'group'},scope=new ScopedGitHubAdapter(store,github,undefined,undefined,f).authorize(target,context);
  store.db.prepare('INSERT INTO settings VALUES(?,?)').run(`github-review:${task.workstreamId}`,JSON.stringify([{target,context,scope}]));
  const config=parseConfig({feishu:f,github},join(dir,'config.json'));assert.doesNotThrow(()=>assertReviewDelivery(store,config,task));
  assert.doesNotThrow(()=>assertReviewDelivery(store,{...config,github:{...github,grants:[]}},task));
  assert.throws(()=>assertReviewDelivery(store,{...config,feishu:{...config.feishu,allowedChatIds:['another']}},task),/denied|changed/);
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

test('shared directories apply to every admitted member, and revocation narrows running tasks',t=>{
 const {dir}=fixture(t),c=parseConfig({dataDir:join(dir,'data'),feishu:f,codex:{directories:[dir]}},join(dir,'config.json'));
 for(const user of ['alice','bob'])assert.equal(executionPolicy(c.codex,f,member(user)).sandbox,'workspace-write');
 const broader={...c,codex:{...c.codex,directories:[...c.codex.directories!,'/another']}};
 assert.equal(taskAuthorizationValid(c,broader,member()),true);
 assert.equal(taskAuthorizationValid(c,{...c,codex:{...c.codex,directories:[]}},member()),false);
 assert.equal(taskAuthorizationValid(c,{...c,feishu:{...f,access:{mode:'organization',tenantKey:'other'}}},member()),false);
 const selection=selectAgent(c,'codex'),chosen=agentCodexConfig(c,selection);
 assert.equal(chosen.sandbox,'workspace-write');assert.equal(selectedPolicyHash(c,selection),selectedPolicyHash({...c,codex:executionPolicy(c.codex,f,member())},selection));
});
test('shared directory knowledge remains shared while private memory stays with its owner',t=>{
 const {dir,store}=fixture(t),c=parseConfig({dataDir:join(dir,'data'),feishu:f,codex:{directories:[dir]}},join(dir,'config.json'));
 const memories=new Memories(store),actor={kind:'local-owner' as const,authenticated:true,ownerId:'alice',directory:c.codex.directories![0],chatKey:'dm',chatType:'p2p' as const,source:{kind:'automatic' as const,ref:'source'}};
 for(const privacy of ['shared','private'] as const)memories.upsertAutomatic({key:privacy,kind:'knowledge',level:'global',privacy,text:privacy,evidence:[privacy],sourceMessageIds:['source'],observedAt:1,directory:c.codex.directories![0]},actor);
 const access=(ownerId:string,chatType:'p2p'|'group')=>({kind:'verified-user' as const,authenticated:true,ownerId,chatType,chatKey:'group',directory:c.codex.directories![0],allowedDirectories:memoryDirectories(c,member(ownerId))});
 assert.deepEqual(memories.search(access('bob','group')).map(x=>x.text),['shared']);
 assert.equal(memories.search(access('alice','p2p')).length,2);
 const foreign:Incoming={...member(),envelope:{...member().envelope!,tenantKey:'other'}};
 assert.deepEqual(memoryDirectories(c,foreign),[]);
});
