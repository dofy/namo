import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Management, ManagementError } from '../src/management.js';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { startUi } from '../src/ui.js';
import { memoryJobs } from '../src/business-storage.js';
import type { Job } from '../src/auto-memory.js';
import type { MemoryViewState } from '../src/ui-contract.js';

function fixture(t: any) {
  const root=mkdtempSync(join(tmpdir(),'namo-management-memory-')),data=join(root,'data'),one=join(root,'one'),two=join(root,'two'),file=join(root,'config.json');
  mkdirSync(data);mkdirSync(one);mkdirSync(two);
  const raw={version:1,agent:'codex',dataDir:data,feishu:{appId:'cli_memory',appSecret:'PRIVATE_MEMORY_SECRET_12345',allowedUserIds:['alice','bob'],allowedChatIds:[]},
    codex:{bin:'codex',home:join(data,'auth'),projects:{one,two},defaultProject:'one',sandbox:'workspace-write',networkAccess:false,allowLocalCommits:false,denyPaths:[],readPaths:[],timeoutMs:600000},concurrency:1};
  writeFileSync(file,JSON.stringify(raw));
  const store=new Store(join(data,'bot.sqlite'));store.bindAccount('cli_memory');
  const message={key:'cli_memory:group-message',messageId:'group-message',chatKey:'cli_memory:group-one',chatId:'group-one',senderId:'alice',text:'task',
    envelope:{version:1 as const,type:'text',kind:'instruction' as const,chatType:'group' as const,scopeKey:'cli_memory:group-one',materials:[],limitations:[]}};
  store.enqueue(message);new Tasks(store).create(store.get(message.key)!,{project:'one',cwd:one,policyHash:'p'});store.close();
  const manager=new Management(file,{status:()=>({running:false,installed:true,registered:false,mode:'stopped'})});
  t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,data,one,two,file,raw,manager};
}

test('management exposes only paired owners and known project/chat scopes',t=>{
  const f=fixture(t),state=f.manager.memories() as any;
  assert.equal(state.ownerId,'alice');assert.deepEqual(state.owners.map((owner:any)=>owner.id),['alice','bob']);
  assert.deepEqual(state.projects,['one','two']);assert.deepEqual(state.chats,[{chatKey:'cli_memory:group-one',project:'one'}]);
  assert.throws(()=>f.manager.memories('mallory'),(error:unknown)=>error instanceof ManagementError&&error.status===403);
  for(const scope of [
    {kind:'owner',ownerId:'bob',project:null,chatKey:null},
    {kind:'project',ownerId:'alice',project:'unknown',chatKey:null},
    {kind:'chat',ownerId:'alice',project:'one',chatKey:'unknown-chat'},
  ])assert.throws(()=>f.manager.memory('save','alice',{kind:'preference',scope,text:'no'}),(error:unknown)=>error instanceof ManagementError&&error.status===403);
});

test('memory extraction status is bounded, owner scoped and excludes source data and raw errors', t => {
  const f=fixture(t),store=new Store(join(f.data,'bot.sqlite'));
  const save=(id:string,patch:Partial<Job>={})=>memoryJobs(store.db).save({
    version:1,id,sourceKey:'PRIVATE_SOURCE',ownerId:'alice',chatKey:'PRIVATE_CHAT',chatType:'p2p',project:'one',
    inboxKeys:[],state:'completed',attempts:1,createdAt:Number(id)||1000,dueAt:0,leaseUntil:0,lease:null,accepted:0,rejected:0,...patch,
  });
  for(let i=1;i<=25;i++)save(String(i));
  save('pending',{state:'pending',attempts:0,accepted:undefined,rejected:undefined});
  save('retry',{state:'pending',attempts:1,error:'timeout',dueAt:Date.now()+5000});
  save('running',{state:'running',attempts:1,lease:'PRIVATE_LEASE',leaseUntil:Date.now()+120000});
  save('failed',{state:'failed',attempts:3,error:'extraction_failed'});
  store.db.prepare("UPDATE memory_jobs SET error=? WHERE id='failed'").run(f.raw.feishu.appSecret+' PRIVATE_SDK_ERROR');
  save('bob',{ownerId:'bob',state:'failed',attempts:3});
  const before=JSON.stringify(store.db.prepare('SELECT * FROM memory_jobs ORDER BY id').all());
  const state=f.manager.memories('alice') as MemoryViewState;
  assert.deepEqual([state.extraction.pending,state.extraction.running,state.extraction.failed],[2,1,1]);
  assert.equal(state.extraction.recent.length,20);assert.equal(state.extraction.hasMore,true);assert.equal(state.extraction.maxAttempts,3);
  assert.equal(state.extraction.recent.find(job=>job.id==='failed')?.error,'extraction_failed');
  assert.equal(state.extraction.recent.find(job=>job.id==='retry')?.error,'timeout');
  assert.ok(!state.extraction.recent.some(job=>job.id==='bob'));
  assert.doesNotMatch(JSON.stringify(state.extraction),/PRIVATE_|sourceKey|chatKey|inboxKeys|"lease"/);
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM memory_jobs ORDER BY id').all()),before,'reading status never retries or modifies jobs');
  const bob=(f.manager.memories('bob') as MemoryViewState).extraction;
  assert.equal(bob.recent.length,1);assert.equal(bob.failed,1);assert.equal(bob.pending,0);
  const changed=f.manager.memory('save','alice',{kind:'preference',scope:{kind:'owner',ownerId:'alice',project:null,chatKey:null},text:'Concise answers'}) as MemoryViewState;
  assert.deepEqual(changed.extraction,state.extraction,'mutation responses preserve extraction status');
  store.close();
});

test('management memory save, correct, disable, delete and version conflicts are owner scoped',t=>{
  const f=fixture(t),scope={kind:'project',ownerId:'alice',project:'one',chatKey:null};
  let state=f.manager.memory('save','alice',{kind:'project_knowledge',scope,text:'Use API version one'}) as any;
  const saved=state.items[0];assert.equal(saved.version,1);assert.equal(saved.text,'Use API version one');
  state=f.manager.memory('correct','alice',{id:saved.id,version:1,text:'Use API version two'}) as any;
  assert.equal(state.items[0].version,2);assert.equal(state.items[0].text,'Use API version two');
  assert.throws(()=>f.manager.memory('correct','alice',{id:saved.id,version:1,text:'stale'}),(error:unknown)=>error instanceof ManagementError&&error.status===409);
  assert.throws(()=>f.manager.memory('correct','bob',{id:saved.id,version:2,text:'cross user'}),(error:unknown)=>error instanceof ManagementError&&error.status===403);
  state=f.manager.memory('disable','alice',{id:saved.id,version:2}) as any;assert.equal(state.items[0].status,'disabled');
  state=f.manager.memory('delete','alice',{id:saved.id,version:3}) as any;assert.equal(state.items[0].status,'deleted');assert.equal(state.items[0].text,null);
});

test('management rejects credentials and assistant errors retain HTTP-relevant status',t=>{
  const f=fixture(t),scope={kind:'owner',ownerId:'alice',project:null,chatKey:null};
  assert.throws(()=>f.manager.memory('save','alice',{kind:'preference',scope,text:`keep ${f.raw.feishu.appSecret}`}),(error:unknown)=>error instanceof ManagementError&&error.status===400);
  const current=(f.manager.state() as any).assistant;assert.equal(current.active,false);
  assert.throws(()=>f.manager.assistant('save',0,{name:''}),(error:unknown)=>error instanceof ManagementError&&error.status===400);
  const saved=f.manager.assistant('reset',0,undefined) as any;assert.equal(saved.version,1);
  assert.throws(()=>f.manager.assistant('reset',0,undefined),(error:unknown)=>error instanceof ManagementError&&error.status===409);
});

test('message feedback and progress settings default safely and save under feishu',t=>{
  const f=fixture(t),before=f.manager.config();
  assert.equal(before.values.reactions,true);assert.equal(before.values.progressUpdates,true);assert.equal(before.values.progressDelayMs,200);
  assert.equal(before.values.progressIntervalMs,5000);assert.equal(before.values.progressHeartbeatMs,30000);
  const saved=f.manager.save(before.revision,{reactions:false,progressUpdates:false,progressDelayMs:1000,progressIntervalMs:60000,progressHeartbeatMs:300000});
  assert.equal(saved.values.reactions,false);assert.equal(saved.values.progressUpdates,false);
  const raw=JSON.parse(readFileSync(f.file,'utf8'));assert.equal(raw.feishu.reactions,false);assert.equal(raw.feishu.progressDelayMs,1000);
  assert.equal(raw.codex.reactions,undefined);assert.equal(raw.codex.progressHeartbeatMs,undefined);
  assert.throws(()=>f.manager.save(saved.revision,{progressDelayMs:-1}),/校验/);
});

test('memory HTTP API keeps loopback auth, origin, owner and version guards',async t=>{
  const f=fixture(t),ui=await startUi(f.manager);t.after(()=>ui.close());
  const post=(input:unknown,cookie='',origin=ui.url)=>fetch(ui.url+'/api/memories',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(input)});
  const save={action:'save',ownerId:'alice',input:{kind:'preference',scope:{kind:'owner',ownerId:'alice',project:null,chatKey:null},text:'Keep answers short'}};
  assert.equal((await post(save)).status,401);
  const login=await fetch(ui.url+'/api/session',{method:'POST',headers:{Origin:ui.url,'Content-Type':'application/json'},body:JSON.stringify({code:new URL(ui.entryUrl).hash.slice(1)})}),cookie=login.headers.get('set-cookie')!;
  assert.equal((await post(save,cookie,'https://attacker.invalid')).status,403);
  const created=await post(save,cookie);assert.equal(created.status,200);const state=await created.json() as any,id=state.items[0].id;
  assert.equal((await fetch(`${ui.url}/api/memories?ownerId=mallory`,{headers:{Cookie:cookie}})).status,403);
  assert.equal((await post({action:'correct',ownerId:'alice',input:{id,version:0,text:'bad version'}},cookie)).status,400);
  assert.equal((await post({action:'correct',ownerId:'alice',input:{id,version:1,text:'new value'}},cookie)).status,200);
  assert.equal((await post({action:'correct',ownerId:'alice',input:{id,version:1,text:'stale'}},cookie)).status,409);
});

test('assistant HTTP API keeps owner-session authorization, validation, and optimistic versions',async t=>{
  const f=fixture(t),ui=await startUi(f.manager);t.after(()=>ui.close());
  const post=(input:unknown,cookie='',origin=ui.url)=>fetch(ui.url+'/api/assistant',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(input)});
  assert.equal((await post({action:'reset',version:0})).status,401);
  const login=await fetch(ui.url+'/api/session',{method:'POST',headers:{Origin:ui.url,'Content-Type':'application/json'},body:JSON.stringify({code:new URL(ui.entryUrl).hash.slice(1)})}),cookie=login.headers.get('set-cookie')!;
  assert.equal((await post({action:'reset',version:0},cookie,'https://attacker.invalid')).status,403);
  assert.equal((await post({action:'save',version:0,values:{name:''}},cookie)).status,400);
  assert.equal((await post({action:'reset',version:0},cookie)).status,200);
  assert.equal((await post({action:'reset',version:0},cookie)).status,409);
});
