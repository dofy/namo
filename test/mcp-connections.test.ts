import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { storeFixture } from './helpers.js';
import { Tasks } from '../src/tasks.js';
import { loadConfig } from '../src/config.js';
import { Management } from '../src/management.js';
import { assertMcpDelivery, mcpRead, parseMcpConnections } from '../src/mcp-connections.js';
import { authorizationRevision } from '../src/runtime-config.js';
const token='lin_test_readonly_123';
const request={connection:'linear',operation:'list'};
test('shared directory mode makes authorized MCPs discoverable to any admitted group member without an enable switch',async t=>{
  const f=fixture(t,'group','bob');f.edit(c=>{c.codex.directories=[];c.mcpConnections[0].enabled=false;c.mcpConnections[0].audience={organization:false,userIds:[],chatIds:[]};});
  const discovered=await mcpRead(f.store,f.file,f.task,{operation:'connections'},new AbortController().signal);
  assert.match(JSON.stringify(discovered),/linear/);
  f.edit(c=>{c.mcpConnections[0].token='';});
  assert.doesNotMatch(JSON.stringify(await mcpRead(f.store,f.file,f.task,{operation:'connections'},new AbortController().signal)),/linear/);
});
test('authorized members execute reads and writes directly in private and group chats without approval',async t=>{
 for(const chat of ['p2p','group'] as const)for(const readOnly of [true,false]) {
  const f=fixture(t,chat,'bob');f.store.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(f.task.id);let calls=0;
  const tool={name:readOnly?'get_issue':'update_issue',inputSchema:{type:'object' as const},annotations:{readOnlyHint:readOnly}};
  const result=await mcpRead(f.store,f.file,f.task,{connection:'linear',operation:'call',tool:tool.name,arguments:{}},new AbortController().signal,async(_c,r,_s,before)=>{
    if(r.operation==='list')return[tool];before?.(tool);calls++;return{content:[{type:'text',text:'done'}]};
  });
  assert.equal(calls,1);assert.match(JSON.stringify(result),/done/);
  assert.equal(f.store.db.prepare("SELECT 1 FROM settings WHERE key LIKE 'mcp-approval:%'").get(),undefined);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()?.n,0);
  assert.equal(JSON.parse(String(f.store.db.prepare("SELECT value FROM settings WHERE key LIKE 'mcp-operation:%'").get()!.value)).state,'completed');
 }
});
function fixture(t:any,chatType:'p2p'|'group'='p2p',sender='alice',tenant='tenant'){
  const {dir,store}=storeFixture(t,'namo-mcp-');const file=join(dir,'config.json');
  const config={dataDir:dir,feishu:{appId:'app',appSecret:'synthetic-feishu-secret',allowedUserIds:['alice'],access:{mode:'organization',tenantKey:'tenant'}},
    codex:{home:join(dir,'auth'),directories: []},
    mcpConnections:[{id:'linear',type:'linear',ownerUserId:'alice',token}]};
  writeFileSync(file,JSON.stringify(config));
  store.enqueue({key:'input',messageId:'input',chatKey:'app:chat',chatId:chatType==='group'?'group1':'chat',senderId:sender,text:'Linear task',envelope:{version:1,type:'text',kind:'instruction',scopeKey:'app:chat',chatType,tenantKey:tenant,materials:[],limitations:[]}});
  const task=new Tasks(store).create(store.get('input')!,{cwd:dir,policyHash:'test'});
  const edit=(fn:(c:any)=>void)=>{const raw=JSON.parse(readFileSync(file,'utf8'));fn(raw);writeFileSync(file,JSON.stringify(raw));};
  return {dir,file,store,task,edit,config,manager:new Management(file)};
}
test('editing MCP connections does not change the global task authorization revision',t=>{
 const f=fixture(t),before=authorizationRevision(loadConfig(f.file));
 f.edit(c=>{c.mcpConnections.push({...c.mcpConnections[0],id:'disabled',type:'remote',enabled:false,url:'https://other.example/mcp'});});
 assert.equal(authorizationRevision(loadConfig(f.file)),before);
});
test('connection validation rejects arbitrary transports and unsafe tokens',()=>{
  const good={id:'linear',type:'linear',token};
  assert.equal(parseMcpConnections([good])[0].id,'linear');
  for(const item of [{...good,url:'https://evil.invalid'}, {...good,type:'stdio'}, {...good,token:'token\r\nheader'}, {...good,id:'../x'}])assert.throws(()=>parseMcpConnections([item]));
  assert.throws(()=>parseMcpConnections([good,good]));
});
test('management saves scoped connection without revealing token and preserves it across edits',t=>{
 const f=fixture(t),view=f.manager.config();assert.doesNotMatch(JSON.stringify(view),new RegExp(token));
 assert.equal(view.mcpConnections[0].credentialConfigured,true);
 const saved=f.manager.save(view.revision,{mcpConnections:[{id:'linear',type:'remote',url:'https://mcp.linear.app/mcp/readonly',oauthScope:'read'}]});
 assert.equal(loadConfig(f.file).mcpConnections![0].token,token);assert.doesNotMatch(JSON.stringify(saved),new RegExp(token));
 assert.throws(()=>f.manager.save(view.revision,{mcpConnections:[]}),/配置已被|configuration/i);
 const revision=f.manager.config().revision;
 assert.throws(()=>f.manager.save(revision,{mcpConnections:[{id:'linear',type:'linear',}]}));
 assert.equal(loadConfig(f.file).mcpConnections![0].token,token);
});
test('task identity, chat and project grants are checked before calling and after revocation',async t=>{
 let calls=0;const reader=async()=>{calls++;return {value:'reference '+token};};
 const f=fixture(t),sig=new AbortController().signal;
 const result=await mcpRead(f.store,f.file,f.task,request,sig,reader);assert.doesNotMatch(JSON.stringify(result),new RegExp(token));assert.equal(calls,1);
 assertMcpDelivery(f.store,loadConfig(f.file),f.task);
 f.edit(c=>{c.mcpConnections[0].token='';});
 await assert.rejects(mcpRead(f.store,f.file,f.task,request,sig,reader),/mcp_access/);
 assert.throws(()=>assertMcpDelivery(f.store,loadConfig(f.file),f.task),/mcp_access/);assert.equal(calls,1);
 for(const [type,user,tenant] of [['p2p','alice','other']] as const){const denied=fixture(t,type,user,tenant);await assert.rejects(mcpRead(denied.store,denied.file,denied.task,request,sig,reader),/mcp_access/);}
 const group=fixture(t,'group','bob');await mcpRead(group.store,group.file,group.task,request,sig,reader);assert.equal(calls,2);
});
test('in-flight result is rejected after permission is revoked',async t=>{
 const f=fixture(t),sig=new AbortController().signal;
 await assert.rejects(mcpRead(f.store,f.file,f.task,request,sig,async()=>{f.edit(c=>{c.mcpConnections[0].token='';});return {data:'private'};}),/mcp_access/);
});
test('unrelated audience changes preserve prior MCP reads and repeated tasks share a receipt',async t=>{
 const f=fixture(t),signal=new AbortController().signal,reader=async()=>({data:'reference'}),tasks=new Tasks(f.store);
 await mcpRead(f.store,f.file,f.task,request,signal,reader);
 f.edit(c=>{c.feishu.allowedUserIds.push('bob');});
 assert.doesNotThrow(()=>assertMcpDelivery(f.store,loadConfig(f.file),f.task));
 for(let i=0;i<205;i++){
  const original=f.store.get('input')!,key=`next-${i}`;
  f.store.enqueue({...original,key,messageId:key});
  const task=tasks.create(f.store.get(key)!,{cwd:f.dir,policyHash:'test'});
  assert.equal(task.workstreamId,f.task.workstreamId);
  await mcpRead(f.store,f.file,task,request,signal,reader);
 }
 const row=f.store.db.prepare('SELECT value FROM settings WHERE key=?').get(`mcp-read-scope:${f.task.workstreamId}`)!;
 assert.equal(JSON.parse(String(row.value)).length,1);
 f.edit(c=>{c.mcpConnections[0].token='different_token_123';});
 assert.throws(()=>assertMcpDelivery(f.store,loadConfig(f.file),f.task),/mcp_access_changed/);
});
test('legacy MCP receipts migrate only after their original scope is verified',t=>{
 const f=fixture(t),c=loadConfig(f.file),m=f.store.get('input')!,connection=c.mcpConnections![0];
 const scope=createHash('sha256').update(JSON.stringify({connection,appId:c.feishu.appId,access:c.feishu.access,allowedUsers:c.feishu.allowedUserIds,allowedChats:c.feishu.allowedChatIds,taskId:f.task.id,owner:f.task.ownerId,chat:m.chatId,})).digest('hex');
 const key=`mcp-read-scope:${f.task.workstreamId}`;
 f.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify([{taskId:f.task.id,id:'linear',scope}]));
 assert.doesNotThrow(()=>assertMcpDelivery(f.store,c,f.task));
 assert.equal(JSON.parse(String(f.store.db.prepare('SELECT value FROM settings WHERE key=?').get(key)!.value))[0].version,3);
 f.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify([{taskId:f.task.id,id:'linear',scope:'0'.repeat(64)}]),key);
 assert.throws(()=>assertMcpDelivery(f.store,c,f.task),/mcp_access_changed/);
 assert.equal(JSON.parse(String(f.store.db.prepare('SELECT value FROM settings WHERE key=?').get(key)!.value))[0].version,undefined);
});
test('applied snapshot prevents new grants before configuration is applied',async t=>{
 const f=fixture(t);f.edit(c=>{c.mcpConnections[0].token='';});const applied=loadConfig(f.file);f.edit(c=>{c.mcpConnections[0].token=token;});
 await assert.rejects(mcpRead(f.store,f.file,f.task,request,new AbortController().signal,async()=>({ok:true}),applied),/mcp_access/);
});
test('managed runtime refuses unmanaged MCP servers and disabled feature overrides',async t=>{
 const {mkdtempSync,mkdirSync,rmSync,writeFileSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {connectCodex}=await import('../src/codex-connection.js');
 const dir=mkdtempSync(join(tmpdir(),'namo-mcp-rpc-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const bin=join(dir,'codex.mjs'),home=join(dir,'home');mkdirSync(home);
 writeFileSync(bin,`#!${process.execPath}
import {createInterface} from 'node:readline';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==='config/read')result={config:{features:{plugins:!process.argv.includes('features.plugins=false'),apps:!process.argv.includes('features.apps=false')},mcp_servers:existsSync(join(process.env.CODEX_HOME,'bad'))?{other:{enabled:true}}:{}}};
if(m.method==='skills/list')result={data:[{cwd:m.params.cwds[0],skills:[]}]};
process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`,{mode:0o700});
 const config={bin,home,sandbox:'read-only' as const,timeoutMs:10000,managedMcp:true,denyPaths:[],readPaths:[]};
 const rpc=await connectCodex(config,dir);await rpc.close();
 writeFileSync(join(home,'bad'),'1');
 await assert.rejects(connectCodex(config,dir),/mcp_unmanaged_servers/);
});

test('connection discovery exposes only currently authorized, applied connection IDs',async t=>{
 const f=fixture(t),signal=new AbortController().signal,applied=loadConfig(f.file);let calls=0;
 f.edit(c=>{c.mcpConnections.push({id:'private',type:'linear',token:'private_token_123'});});
 const result=await mcpRead(f.store,f.file,f.task,{operation:'connections'},signal,async()=>{calls++;return {};},applied);
 assert.deepEqual(result,{connections:[{id:'linear',type:'remote'}]});assert.equal(calls,0);
 const foreign=fixture(t,'p2p','bob','other');
 assert.deepEqual(await mcpRead(foreign.store,foreign.file,foreign.task,{operation:'connections'},signal),{connections:[]});
 f.edit(c=>{c.mcpConnections=[];});
 assert.deepEqual(await mcpRead(f.store,f.file,f.task,{operation:'connections'},signal),{connections:[]});
 await assert.rejects(mcpRead(f.store,f.file,f.task,{operation:'connections',connection:'linear'},signal),/mcp_invalid_request/);
});

test('revocation, cancellation and completed tasks stop direct calls immediately before dispatch',async t=>{
 for(const change of ['revoke','cancel','complete','abort']) {
  const f=fixture(t),controller=new AbortController();f.store.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(f.task.id);
  const tool={name:'update',inputSchema:{type:'object'}};let calls=0;
  await assert.rejects(mcpRead(f.store,f.file,f.task,{operation:'call',connection:'linear',tool:'update'},controller.signal,async(_c,r,_s,before)=>{
    if(r.operation==='list')return[tool];
    if(change==='revoke')f.edit(c=>{c.mcpConnections[0].token='';});
    if(change==='cancel')f.store.db.prepare('UPDATE inbox SET cancelRequested=1 WHERE key=?').run(f.task.inboxKey);
    if(change==='complete')f.store.db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(f.task.id);
    if(change==='abort')controller.abort();
    before?.(tool);calls++;return{};
  }),/mcp_(access|cancelled)/);
  assert.equal(calls,0);
 }
});

test('an uncertain direct call records its outcome and cannot be dispatched again in the same task',async t=>{
 const f=fixture(t);f.store.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(f.task.id);
 const tool={name:'update',inputSchema:{type:'object'}};let calls=0;
 const reader=async(_c:any,r:any,_s:AbortSignal,before?:(tool:unknown)=>void)=>{if(r.operation==='list')return[tool];before?.(tool);calls++;throw Error('connection lost');};
 const call=()=>mcpRead(f.store,f.file,f.task,{operation:'call',connection:'linear',tool:'update',arguments:{title:'Example'}},new AbortController().signal,reader);
 await assert.rejects(call(),/mcp_operation_outcome_unknown/);
 await assert.rejects(call(),/mcp_operation_outcome_unknown/);assert.equal(calls,1);
 const receipt=String(f.store.db.prepare("SELECT value FROM settings WHERE key LIKE 'mcp-operation:%'").get()!.value);
 assert.equal(JSON.parse(receipt).state,'unknown');assert.doesNotMatch(receipt,/Example|lin_test/);
});

test('remote connections accept only public HTTPS endpoints and preserve credentials only for their original target',t=>{
 const f=fixture(t);
 for(const url of ['http://example.com/mcp','https://127.0.0.1/mcp','https://example.com/mcp?token=private'])assert.throws(()=>parseMcpConnections([{id:'remote',type:'remote',url,token:''}]));
 const view=f.manager.config();const saved=f.manager.save(view.revision,{mcpConnections:[{id:'remote',type:'remote',url:'https://example.com/mcp',newToken:'secret_token_123'}]});
 assert.doesNotMatch(JSON.stringify(saved),/secret_token_123/);
 assert.throws(()=>f.manager.save(saved.revision,{mcpConnections:[{id:'remote',type:'remote',url:'https://elsewhere.example/mcp'}]}),/mcp_credential_target_changed/);
});

test('tool definition changes never reach the direct remote dispatch',async t=>{
 const f=fixture(t),signal=new AbortController().signal;
 f.edit(c=>{c.mcpConnections=[{id:'remote',type:'remote',ownerUserId:'alice',url:'https://mcp.example/mcp',token:'remote_token_123'}];});
 f.store.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(f.task.id);
 let dispatched=false;const tool={name:'update',description:'original',inputSchema:{type:'object'},approvalRequired:false};
 const fake=async(_connection:any,request:any,_signal:AbortSignal,beforeCall?:(tool:unknown)=>void)=>{if(request.operation==='list')return [tool];beforeCall?.({...tool,description:'changed'});dispatched=true;return {};};
 await assert.rejects(mcpRead(f.store,f.file,f.task,{operation:'call',connection:'remote',tool:'update'},signal,undefined,undefined,fake),/mcp_tool_changed/);
 assert.equal(dispatched,false);assert.equal(f.store.db.prepare("SELECT 1 FROM settings WHERE key LIKE 'mcp-operation:%'").get(),undefined);

});


test('admin can test a disabled connection without enabling task access or invoking tools',async t=>{
 const f=fixture(t);f.edit(c=>{c.mcpConnections[0].token='';});
 let calls=0;
 const manager=new Management(f.file,{mcpReader:async(connection,request)=>{
  calls++;assert.equal(connection.token,'');assert.deepEqual(request,{operation:'list'});return [{name:'lookup'}];
 }});t.after(()=>manager.close());
 const before=readFileSync(f.file,'utf8'),revision=manager.config().revision;
 assert.deepEqual(await manager.testMcp(revision,'linear'),{toolCount:1});assert.equal(calls,1);
 assert.equal(readFileSync(f.file,'utf8'),before);
 assert.deepEqual(await mcpRead(f.store,f.file,f.task,{operation:'connections'},new AbortController().signal),{connections:[]});
 await assert.rejects(manager.testMcp(revision,'missing'),/mcp_connection_not_found/);
 await assert.rejects(manager.testMcp('stale','linear'),/mcp_config_changed/);assert.equal(calls,1);
});

test('management rejects duplicate endpoints for add, edit and OAuth before saving credentials',async t=>{
 const f=fixture(t),view=f.manager.config(),original=view.mcpConnections.map(({credentialConfigured:_configured,credentialSource:_source,...v}:any)=>v);
 const before=readFileSync(f.file,'utf8');
 // URL normalization accounts for host case, the default port and dot segments.
 const duplicate={...original[0],id:'another',url:'https://MCP.LINEAR.APP:443/mcp/../mcp/readonly'};
 assert.throws(()=>f.manager.save(view.revision,{mcpConnections:[...original,duplicate]}),/mcp_duplicate_endpoint/);
 const {McpOAuthFlow}=await import('../src/mcp-oauth-flow.js');let networkCalls=0;
 const flow=new McpOAuthFlow(f.manager,()=> 'http://127.0.0.1:45678',async()=>{networkCalls++;throw new Error('unexpected_oauth_network');});
 await assert.rejects(flow.begin(view.revision,'',duplicate),/mcp_duplicate_endpoint/);assert.equal(networkCalls,0);
 assert.throws(()=>f.manager.saveMcpOAuth(view.revision,'','oauth_'+'a'.repeat(48),duplicate),/mcp_duplicate_endpoint/);
 assert.equal(readFileSync(f.file,'utf8'),before);
 const other={...duplicate,url:'https://mcp.linear.app/mcp'};
 const saved=f.manager.save(view.revision,{mcpConnections:[...original,other]});
 const {credentialConfigured:_configured,credentialSource:_source,...existing}=saved.mcpConnections[1];
 assert.throws(()=>f.manager.save(saved.revision,{mcpConnections:[original[0],{...existing,url:original[0].url}]}),/mcp_duplicate_endpoint/);
 assert.throws(()=>f.manager.prepareMcpOAuth(saved.revision,'another',{...existing,url:original[0].url}),/mcp_duplicate_endpoint/);
});

test('existing duplicate connections retain independent credentials and grants and can be removed',t=>{
 const f=fixture(t);
 f.edit(c=>{c.mcpConnections.push({...c.mcpConnections[0],id:'old-copy',enabled:false,token:'separate_token_123',audience:{organization:false,userIds:['bob'],chatIds:[]}});});
 const view=f.manager.config(),values=view.mcpConnections.map(({credentialConfigured:_configured,credentialSource:_source,...v}:any)=>v);
 assert.equal(loadConfig(f.file).mcpConnections!.length,2);
 const saved=f.manager.save(view.revision,{mcpConnections:values});
 assert.deepEqual(loadConfig(f.file).mcpConnections!.map(v=>({id:v.id,token:v.token})),[{id:'linear',token},{id:'old-copy',token:'separate_token_123'}]);
 assert.doesNotThrow(()=>f.manager.prepareMcpOAuth(saved.revision,'old-copy',values[1]));
 const removed=f.manager.save(saved.revision,{mcpConnections:[values[0]]});assert.equal(removed.mcpConnections.length,1);
 assert.equal(loadConfig(f.file).mcpConnections![0].token,token);
});

test('endpoint identity preserves distinct environments and path semantics',async()=>{
 const {duplicateMcpEndpoint}=await import('../src/mcp-endpoint-contract.js'),base={id:'first',url:'https://api.example/mcp'};
 for(const url of ['https://staging.example/mcp','https://api.example/MCP','https://api.example/mcp/','https://api.example/mcp/readonly'])assert.equal(duplicateMcpEndpoint([base],{id:'second',url}),undefined);
 assert.equal(duplicateMcpEndpoint([base],{id:'second',url:'https://API.EXAMPLE:443/./mcp'})?.id,'first');
});

test('v15 receipt keeps its original identity check across directory migration and still rejects revocation',t=>{
  const f=fixture(t),c=loadConfig(f.file),m=f.store.get('input')!,resource=c.mcpConnections![0];
  const key=`mcp-read-scope:${f.task.workstreamId}`,legacyContext='old-label';
  const scope=createHash('sha256').update(JSON.stringify({resource,appId:c.feishu.appId,tenant:m.envelope?.tenantKey,owner:f.task.ownerId,chat:m.chatId,project:legacyContext})).digest('hex');
  const original=JSON.stringify([{taskId:f.task.id,id:'linear',scope,version:2,legacyContext}]);
  f.store.db.prepare('INSERT INTO settings VALUES(?,?)').run(key,original);
  const revoked=structuredClone(c);revoked.mcpConnections![0].token='';
  assert.throws(()=>assertMcpDelivery(f.store,revoked,f.task),/mcp_access/);
  assert.equal(f.store.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value,original);
  assert.doesNotThrow(()=>assertMcpDelivery(f.store,c,f.task));
  const receipt=JSON.parse(String(f.store.db.prepare('SELECT value FROM settings WHERE key=?').get(key)!.value))[0];
  assert.equal(receipt.version,3);assert.equal('legacyContext' in receipt,false);
  assert.notEqual(receipt.scope,scope);assert.doesNotThrow(()=>assertMcpDelivery(f.store,c,f.task));
});

test('direct dispatch rejects leaked credentials, missing tools and failed durable recording',async t=>{
 for(const mode of ['secret','missing','storage']) {
  const f=fixture(t);f.store.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(f.task.id);
  if(mode==='storage')f.store.db.exec("CREATE TRIGGER fail_operation BEFORE INSERT ON settings WHEN NEW.key LIKE 'mcp-operation:%' BEGIN SELECT RAISE(ABORT,'operation_storage_failed'); END");
  const tool={name:'write',inputSchema:{type:'object'}};let calls=0;
  await assert.rejects(mcpRead(f.store,f.file,f.task,{operation:'call',connection:'linear',tool:'write',arguments:{value:mode==='secret'?token:'safe'}},new AbortController().signal,async(_c,r,_s,before)=>{
    if(r.operation==='list')return mode==='missing'?[]:[tool];before?.(tool);calls++;return{};
  }),mode==='secret'?/mcp_secret_in_arguments/:mode==='missing'?/mcp_tool_not_found/:/operation_storage_failed/);
  assert.equal(calls,0);
 }
});

test('legacy executing and unknown MCP records block repeat dispatch after an upgrade',async t=>{
 const {beginMcpOperation}=await import('../src/mcp-operation.js');
 for(const state of ['executing','unknown']){
  const f=fixture(t),url='https://mcp.linear.app/mcp',args={id:'issue',title:'requested change'};
  const prior={taskId:'old-task',connection:'linear',url,tool:'update_issue',arguments:args,state};
  f.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('mcp-approval:MA-OLD',JSON.stringify(prior));
  assert.throws(()=>beginMcpOperation(f.store,f.task,'linear',url,'update_issue',args),/mcp_operation_outcome_unknown/);
  assert.equal(f.store.db.prepare("SELECT 1 FROM settings WHERE key LIKE 'mcp-operation:%'").get(),undefined);
 }
});
