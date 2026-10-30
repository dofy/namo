import { storeFixture } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { loadConfig, parseConfig } from '../src/config.js';
import { executionPolicy } from '../src/access.js';
import { githubApi, assertGitHubApiDelivery } from '../src/github-api.js';
import { ScopedGitHubAdapter, parseGitHubAccessConfig, publicGitHubAccess } from '../src/github-access.js';
import { Management } from '../src/management.js';
import { awaitMcpApproval, mcpApprovalCommand } from '../src/mcp-write-approval.js';

const credential='synthetic-github-account-token';
const autoApprove:typeof awaitMcpApproval=async()=>()=>{};
function fixture(t:any,chatType:'p2p'|'group'='p2p',owner='alice',tenant='tenant'){
  const { dir, store } = storeFixture(t, 'namo-github-simple-');
  const file = join(dir, 'config.json');
  writeFileSync(file,JSON.stringify({dataDir:dir,feishu:{appId:'app',appSecret:'synthetic-feishu',allowedUserIds:['alice'],access:{mode:'organization',tenantKey:'tenant'}},
    codex:{home:join(dir,'auth'),sandbox:'workspace-write',networkAccess:true,allowLocalCommits:true,projects:{app:dir},defaultProject:'app',projectAccess:{app:{organization:true,userIds:[],chatIds:[],permission:'workspace-write'}}},
    github:{mode:'simple',ownerUserId:'alice',token:credential,repositories:[],allowedUserIds:[],...(chatType==='group'?{grants:[{repository:'org/repo',organization:false,userIds:[],chatIds:['chat']}]}:{})}}));
  store.enqueue({key:'input',messageId:'input',chatKey:'app:chat',chatId:'chat',senderId:owner,text:'GitHub task',envelope:{version:1,type:'text',kind:'instruction',scopeKey:'app:chat',chatType,tenantKey:tenant,materials:[],limitations:[]}});
  const task=new Tasks(store).create(store.get('input')!,{cwd:dir,policyHash:'test'});
  const edit=(fn:(c:any)=>void)=>{const c=JSON.parse(readFileSync(file,'utf8'));fn(c);writeFileSync(file,JSON.stringify(c));};
  return {dir,file,store,task,edit,call:(args:unknown,fetcher:typeof fetch,signal=new AbortController().signal)=>githubApi(store,file,task,args,signal,{fetch:fetcher,approve:autoApprove})};
}
const get={requestId:'read',method:'GET',endpoint:'/repos/org/repo/pulls?per_page=10'};
const post={requestId:'comment-1',method:'POST',endpoint:'/repos/org/repo/issues/1/comments',body:{body:'requested comment'}};

test('owner GitHub writes require a bound one-time approval before dispatch',async t=>{
 const f=fixture(t);new Tasks(f.store).start(f.task);let calls=0;
 const pending=githubApi(f.store,f.file,f.task,post,new AbortController().signal,{fetch:async()=>{calls++;return Response.json({ok:true});}});
 await new Promise(resolve=>setImmediate(resolve));
 const row=f.store.db.prepare("SELECT key FROM settings WHERE key LIKE 'mcp-approval:%'").get();assert.ok(row);assert.equal(calls,0);
 const id=String(row.key).slice('mcp-approval:'.length),cmd=(key:string,senderId:string)=>{
  const original=f.store.get('input')!;f.store.enqueue({...original,key,messageId:key,senderId,text:`/mcp-approve ${id} --confirm`});
  mcpApprovalCommand(f.store,f.store.get(key)!);
 };
 cmd('bad','bob');assert.equal(calls,0);cmd('approved','alice');
 assert.equal((await pending as any).state,'completed');assert.equal(calls,1);
 assert.equal(JSON.parse(String(f.store.db.prepare('SELECT value FROM settings WHERE key=?').get(`mcp-approval:${id}`)!.value)).state,'completed');
});
test('revoking GitHub access while approval is pending prevents dispatch',async t=>{
 const f=fixture(t);new Tasks(f.store).start(f.task);let calls=0;
 const pending=githubApi(f.store,f.file,f.task,post,new AbortController().signal,{fetch:async()=>{calls++;return Response.json({ok:true});}});
 await new Promise(resolve=>setImmediate(resolve));
 const row=f.store.db.prepare("SELECT key FROM settings WHERE key LIKE 'mcp-approval:%'").get()!;const id=String(row.key).slice('mcp-approval:'.length);
 f.edit(c=>{c.feishu.allowedChatIds=['other'];});
 const original=f.store.get('input')!;f.store.enqueue({...original,key:'approval',messageId:'approval',text:`/mcp-approve ${id} --confirm`});mcpApprovalCommand(f.store,f.store.get('approval')!);
 await assert.rejects(pending,/mcp_approval_changed/);assert.equal(calls,0);
});

test('scheduled owner tasks may read but cannot dispatch writes, including GraphQL',async t=>{
  const f=fixture(t); const original=f.store.get('input')!;
  f.store.enqueue({...original,key:'schedule:S-1:123',messageId:'scheduled'});
  f.store.db.prepare('UPDATE tasks SET inboxKey=? WHERE id=?').run('schedule:S-1:123',f.task.id);
  const task={...f.task,inboxKey:'schedule:S-1:123'}; let calls=0;
  const call=(args:unknown)=>githubApi(f.store,f.file,task,args,new AbortController().signal,{fetch:async()=>{calls++;return Response.json({ok:true});}});
  await call(get);
  for(const args of [post,{...post,endpoint:'/graphql'}]) await assert.rejects(call(args),/github_scheduled_write_denied/);
  assert.equal(calls,1);
});

test('simple scopes require one paired owner and never silently replace legacy grants',t=>{
  const f=fixture(t),c=loadConfig(f.file);
  assert.equal(publicGitHubAccess(c.github).mode,'simple');
  assert.doesNotMatch(JSON.stringify(publicGitHubAccess(c.github)),new RegExp(credential));
  for(const github of [{...c.github,ownerUserId:'*'},{...c.github,ownerUserId:undefined},{...c.github,repositories:['org/repo']},{...c.github,allowedUserIds:['alice']},{...c.github,source:'anonymous'}])assert.throws(()=>parseGitHubAccessConfig(github));
  const raw=JSON.parse(readFileSync(f.file,'utf8'));raw.github.ownerUserId='bob';assert.throws(()=>parseConfig(raw,f.file),/github_owner_not_paired/);
  const legacy=parseGitHubAccessConfig({source:'gh',localGh:{executable:'/usr/bin/gh',configDir:'/tmp/gh',login:'owner',userId:42},repositories:[],allowedUserIds:['alice']});
  assert.equal(legacy?.mode,undefined);
});

test('groups may read only explicitly granted repositories, but cannot write or query account data',async t=>{
  const f=fixture(t,'group','bob');let requests=0;
  const fetcher:typeof fetch=async(url,options)=>{requests++;assert.equal(options?.method,'GET');assert.equal(options?.redirect,'error');assert.ok(String(url).startsWith('https://api.github.com/repos/'));return Response.json({title:'reference only'});};
  assert.equal((await f.call(get,fetcher) as any).state,'completed');
  const savedScope=String(f.store.db.prepare('SELECT value FROM settings WHERE key=?').get(`github-api-scope:${f.task.workstreamId}`)?.value);
  assert.doesNotMatch(savedScope,/per_page/);
  const c=loadConfig(f.file),adapter=new ScopedGitHubAdapter(f.store,c.github,fetcher,undefined,c.feishu);
  assert.ok(adapter.authorize({owner:'org',repo:'repo',pullNumber:7,headSha:'a'.repeat(40)},{taskId:f.task.id,ownerId:'bob',chatId:'chat'}));
  assert.throws(()=>adapter.authorize({owner:'any',repo:'private',pullNumber:7,headSha:'a'.repeat(40)},{taskId:f.task.id,ownerId:'bob',chatId:'chat'}),/access_denied/);
  await assert.rejects(f.call({...get,endpoint:'/repos/any/private/contents/file'},fetcher),/access_denied/);
  for(const args of [post,{...post,method:'PATCH'},{...post,method:'PUT'},{...post,method:'DELETE'},{...post,endpoint:'/graphql'},{...get,endpoint:'/user'},{...get,endpoint:'/orgs/org/members'}])await assert.rejects(f.call(args,fetcher),/github_read_only/);
  assertGitHubApiDelivery(f.store,c,f.task);
  f.edit(c=>{c.github.grants.push({repository:'other/repo',organization:false,userIds:[],chatIds:['other']});});
  assert.doesNotThrow(()=>assertGitHubApiDelivery(f.store,loadConfig(f.file),f.task));
  f.edit(c=>{c.github.grants=[];});
  assert.throws(()=>assertGitHubApiDelivery(f.store,loadConfig(f.file),f.task),/access_denied|access_changed/);
  assert.equal(requests,1);
  const policy=executionPolicy(c.codex,c.feishu,f.store.get('input')!,'app',c.github);
  assert.equal(policy.sandbox,'read-only');assert.equal(policy.networkAccess,false);assert.equal(policy.allowLocalCommits,false);
});

test('only the bound owner private chat can use the credential; spoofed identity and foreign organizations fail before HTTP',async t=>{
  let requests=0;const fetcher:typeof fetch=async()=>{requests++;return Response.json({ok:true});};
  for(const [type,user,tenant] of [['p2p','bob','tenant'],['p2p','alice','foreign'],['group','bob','foreign']] as const){const f=fixture(t,type,user,tenant);await assert.rejects(f.call(get,fetcher),/github_access_denied/);}
  const f=fixture(t);f.store.db.prepare("UPDATE tasks SET ownerId='bob' WHERE id=?").run(f.task.id);
  await assert.rejects(f.call(post,fetcher),/github_access_denied/);assert.equal(requests,0);
});

test('legacy GitHub receipt migrates only while its original authorization still matches',t=>{
 const f=fixture(t,'group','bob'),c=loadConfig(f.file),target={owner:'org',repo:'repo',pullNumber:1,headSha:'0'.repeat(40)};
 const scope=new ScopedGitHubAdapter(f.store,c.github,undefined,undefined,c.feishu).authorize(target,{taskId:f.task.id,ownerId:'bob',chatId:'chat'});
 const key=`github-api-scope:${f.task.workstreamId}`;
 f.store.db.prepare('INSERT INTO settings VALUES(?,?)').run(key,JSON.stringify([{taskId:f.task.id,scope,endpoint:get.endpoint}]));
 assertGitHubApiDelivery(f.store,c,f.task);
 assert.equal(JSON.parse(String(f.store.db.prepare('SELECT value FROM settings WHERE key=?').get(key)!.value))[0].scopeVersion,2);
 f.edit(c=>{c.github.grants.push({repository:'other/repo',organization:false,userIds:[],chatIds:['other']});});
 assert.doesNotThrow(()=>assertGitHubApiDelivery(f.store,loadConfig(f.file),f.task));
});

test('owner writes execute once, redact secrets and reuse persisted receipts without HTTP',async t=>{
  const f=fixture(t);let writes=0;
  const fetcher:typeof fetch=async(_url,options)=>{writes++;assert.equal(options?.method,'POST');assert.deepEqual(JSON.parse(String(options?.body)),post.body);return Response.json({id:123,body:credential,token:'fresh-secret',nested:{private_key:'hidden'}},{status:201});};
  const first=await f.call(post,fetcher),second=await f.call(post,fetcher);
  assert.deepEqual(second,first);assert.equal(writes,1);assert.doesNotMatch(JSON.stringify(first),/synthetic-github-account-token|fresh-secret|hidden/);
  await assert.rejects(f.call({...post,body:{body:'different'}},fetcher),/request_conflict/);
  assertGitHubApiDelivery(f.store,loadConfig(f.file),f.task);
  f.edit(c=>{c.feishu.allowedUserIds.push('bob');c.github.ownerUserId='bob';});
  await assert.rejects(f.call(post,fetcher),/access_denied/);
  assert.throws(()=>assertGitHubApiDelivery(f.store,loadConfig(f.file),f.task),/access_denied|access_changed/);assert.equal(writes,1);
});

test('unknown writes survive a new connection and block both repeated and renamed requests',async t=>{
  const f=fixture(t);let calls=0;const failing:typeof fetch=async()=>{calls++;throw Error('private transport error '+credential);};
  const result=await f.call(post,failing) as any;assert.equal(result.state,'unknown');
  const another=new Store(join(f.dir,'bot.sqlite'));
  try{assert.equal((await githubApi(another,f.file,f.task,post,new AbortController().signal,{fetch:failing,approve:autoApprove}) as any).state,'unknown');}finally{another.close();}
  await assert.rejects(f.call({...post,requestId:'new-id'},failing),/github_api_unknown_write/);assert.equal(calls,1);
  assert.equal((await f.call(get,async()=>Response.json({id:1})) as any).state,'completed');
});

test('concurrent duplicate writes share one reservation, and group cannot use an owner receipt',async t=>{
  const f=fixture(t);let release!:()=>void;const barrier=new Promise<void>(r=>{release=r;});let calls=0;
  const pending=f.call(post,async()=>{calls++;await barrier;return Response.json({id:1});});
  await new Promise(r=>setTimeout(r,5));assert.equal((await f.call(post,async()=>{throw Error('duplicate');}) as any).state,'unknown');
  release();await pending;assert.equal(calls,1);
  const row=f.store.get('input')!;row.envelope!.chatType='group';f.store.db.prepare('UPDATE inbox SET envelope=? WHERE key=?').run(JSON.stringify(row.envelope),'input');
  await assert.rejects(f.call(post,async()=>{throw Error('must not fetch');}),/github_read_only/);
});

test('ambiguous HTTP failures are not retried, and accepted writes with oversized responses remain accepted',async t=>{
  for(const status of [408,500,502]){
    const f=fixture(t);let calls=0;const fetcher:typeof fetch=async()=>{calls++;return new Response('private upstream body',{status});};
    assert.equal((await f.call(post,fetcher) as any).state,'unknown');
    await assert.rejects(f.call({...post,requestId:'retry'},fetcher),/unknown_write/);assert.equal(calls,1);
  }
  const f=fixture(t);let calls=0;const fetcher:typeof fetch=async()=>{calls++;return new Response('x'.repeat(262145),{status:201});};
  const result=await f.call(post,fetcher) as any;assert.equal(result.state,'completed');assert.equal(result.status,201);
  assert.deepEqual(await f.call(post,fetcher),result);assert.equal(calls,1);
});

test('owner can use REST writes and GraphQL; bad URLs, redirects and cancelled calls cannot bypass the host boundary',async t=>{
  const f=fixture(t);let calls=0;
  const fetcher:typeof fetch=async(_url,options)=>{calls++;assert.equal(options?.redirect,'error');return new Response(null,{status:204});};
  for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await f.call({...post,requestId:method,method},fetcher) as any).state,'completed');
  assert.equal((await f.call({...post,requestId:'graphql',endpoint:'/graphql',body:{query:'mutation { fixture }'}},fetcher) as any).state,'completed');
  for(const endpoint of ['https://evil.test','//evil.test','/repos/x/../user','/repos/x/%2e%2e/user','/repos/x/%252e%252e/user','/repos/x/y#fragment','/repos/x/y\\z'])await assert.rejects(f.call({...get,endpoint},fetcher),/invalid_request/);
  const abort=new AbortController();abort.abort();await assert.rejects(f.call({...post,requestId:'cancel'},fetcher,abort.signal),/cancelled/);assert.equal(calls,5);
});

test('authorization is rechecked after account discovery and before private results are returned',async t=>{
  const f=fixture(t);f.edit(c=>{delete c.github.token;c.github.source='gh';c.github.localGh={executable:'/usr/bin/gh',configDir:'/tmp/gh',login:'owner',userId:42};});
  let requests=0;
  const fetcher:typeof fetch=async()=>{requests++;f.edit(c=>{c.feishu.allowedChatIds=['different'];});return Response.json({id:42,login:'owner'});};
  await assert.rejects(githubApi(f.store,f.file,f.task,post,new AbortController().signal,{fetch:fetcher,token:async()=>credential,approve:autoApprove}),/access_denied|access_changed/);assert.equal(requests,1);
  const read=fixture(t);
  await assert.rejects(read.call(get,async()=>{read.edit(c=>{c.feishu.allowedChatIds=['different'];});return Response.json({body:'private'});}),/access_denied|access_changed/);
});

test('local owner configuration replaces grant lists explicitly while preserving credentials and unrelated settings',async t=>{
  const f=fixture(t),local={executable:'/usr/bin/gh',configDir:'/tmp/gh',login:'owner',userId:42};
  f.edit(c=>{c.github={source:'gh',localGh:local,repositories:[],allowedUserIds:[],grants:[{repository:'org/repo',organization:false,userIds:['alice'],chatIds:['chat']}]};});
  const manager=new Management(f.file,{localGh:async()=>local}),before=manager.config();
  const patch={github:{source:'gh',mode:'simple',ownerUserId:'alice',repositories:[],allowedUserIds:[]}};
  const saved=await manager.saveGitHub(before.revision,patch);assert.equal(saved.github.ownerUserId,'alice');assert.equal(saved.github.grants,undefined);
  assert.equal(loadConfig(f.file).codex.networkAccess,true);assert.equal(loadConfig(f.file).feishu.appSecret,'synthetic-feishu');
  await assert.rejects(manager.saveGitHub(saved.revision,{github:{...patch.github,ownerUserId:'bob'}}));
});

test('saving existing simple GitHub settings preserves a configured group repository allowlist',async t=>{
 const f=fixture(t,'group','bob'),manager=new Management(f.file),before=manager.config();
 const grants=structuredClone(before.github.grants);
 await manager.saveGitHub(before.revision,{github:{mode:'simple',source:'token',ownerUserId:'alice',repositories:[],allowedUserIds:[]}});
 assert.deepEqual(loadConfig(f.file).github?.grants,grants);
});
