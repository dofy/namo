import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeFixture } from './helpers.js';
import { Tasks } from '../src/tasks.js';
import { loadConfig } from '../src/config.js';
import { Management } from '../src/management.js';
import { assertMcpDelivery, mcpRead, parseMcpConnections } from '../src/mcp-connections.js';
const token='lin_test_readonly_123';
const request={connection:'linear',operation:'list'};
function fixture(t:any,chatType:'p2p'|'group'='p2p',sender='alice',tenant='tenant'){
  const {dir,store}=storeFixture(t,'namo-mcp-');const file=join(dir,'config.json');
  const config={dataDir:dir,feishu:{appId:'app',appSecret:'synthetic-feishu-secret',allowedUserIds:['alice'],access:{mode:'organization',tenantKey:'tenant'}},
    codex:{home:join(dir,'auth'),projects:{app:dir},defaultProject:'app',projectAccess:{app:{organization:true,userIds:[],chatIds:[],permission:'read-only'}}},
    mcpConnections:[{id:'linear',type:'linear',enabled:true,audience:{organization:false,userIds:['alice'],chatIds:['group1']},projects:['app'],token}]};
  writeFileSync(file,JSON.stringify(config));
  store.enqueue({key:'input',messageId:'input',chatKey:'app:chat',chatId:chatType==='group'?'group1':'chat',senderId:sender,text:'Linear task',envelope:{version:1,type:'text',kind:'instruction',scopeKey:'app:chat',chatType,tenantKey:tenant,materials:[],limitations:[]}});
  const task=new Tasks(store).create(store.get('input')!,{cwd:dir,policyHash:'test',project:'app'});
  const edit=(fn:(c:any)=>void)=>{const raw=JSON.parse(readFileSync(file,'utf8'));fn(raw);writeFileSync(file,JSON.stringify(raw));};
  return {dir,file,store,task,edit,config,manager:new Management(file)};
}
test('connection validation rejects arbitrary transports and unsafe tokens',()=>{
  const good={id:'linear',type:'linear',enabled:true,audience:{organization:false,userIds:['alice'],chatIds:[]},projects:[],token};
  assert.equal(parseMcpConnections([good])[0].id,'linear');
  for(const item of [{...good,url:'https://evil.invalid'}, {...good,type:'stdio'}, {...good,token:'token\r\nheader'}, {...good,token:''},{...good,id:'../x'}])assert.throws(()=>parseMcpConnections([item]));
  assert.throws(()=>parseMcpConnections([good,good]));
});
test('management saves scoped connection without revealing token and preserves it across edits',t=>{
 const f=fixture(t),view=f.manager.config();assert.doesNotMatch(JSON.stringify(view),new RegExp(token));
 assert.equal(view.mcpConnections[0].credentialConfigured,true);
 const saved=f.manager.save(view.revision,{mcpConnections:[{id:'linear',type:'remote',url:'https://mcp.linear.app/mcp/readonly',oauthScope:'read',enabled:true,audience:{...f.config.mcpConnections[0].audience,chatIds:['group1','group2']},projects:['app']}]});
 assert.equal(loadConfig(f.file).mcpConnections![0].token,token);assert.doesNotMatch(JSON.stringify(saved),new RegExp(token));
 assert.throws(()=>f.manager.save(view.revision,{mcpConnections:[]}),/配置已被|configuration/i);
 const revision=f.manager.config().revision;
 assert.throws(()=>f.manager.save(revision,{mcpConnections:[{id:'linear',type:'linear',enabled:true,audience:f.config.mcpConnections[0].audience,projects:['other']}]}));
 assert.equal(loadConfig(f.file).mcpConnections![0].token,token);
});
test('task identity, chat and project grants are checked before calling and after revocation',async t=>{
 let calls=0;const reader=async()=>{calls++;return {value:'reference '+token};};
 const f=fixture(t),sig=new AbortController().signal;
 const result=await mcpRead(f.store,f.file,f.task,request,sig,reader);assert.doesNotMatch(JSON.stringify(result),new RegExp(token));assert.equal(calls,1);
 assertMcpDelivery(f.store,loadConfig(f.file),f.task);
 f.edit(c=>{c.mcpConnections[0].audience.userIds=[];});
 await assert.rejects(mcpRead(f.store,f.file,f.task,request,sig,reader),/mcp_access/);
 assert.throws(()=>assertMcpDelivery(f.store,loadConfig(f.file),f.task),/mcp_access/);assert.equal(calls,1);
 for(const [type,user,tenant] of [['p2p','bob','tenant'],['p2p','alice','other']] as const){const denied=fixture(t,type,user,tenant);await assert.rejects(mcpRead(denied.store,denied.file,denied.task,request,sig,reader),/mcp_access/);}
 const group=fixture(t,'group','bob');await mcpRead(group.store,group.file,group.task,request,sig,reader);assert.equal(calls,2);
});
test('in-flight result is rejected after permission is revoked',async t=>{
 const f=fixture(t),sig=new AbortController().signal;
 await assert.rejects(mcpRead(f.store,f.file,f.task,request,sig,async()=>{f.edit(c=>{c.mcpConnections[0].enabled=false;});return {data:'private'};}),/mcp_access/);
});
test('applied snapshot prevents new grants before configuration is applied',async t=>{
 const f=fixture(t),applied=loadConfig(f.file);f.edit(c=>{c.mcpConnections[0].audience.organization=true;});
 await assert.rejects(mcpRead(f.store,f.file,f.task,request,new AbortController().signal,async()=>({ok:true}),applied),/mcp_access_changed/);
});
test('project and chat grants do not imply other projects or private users',async t=>{
 const f=fixture(t,'group','bob');const signal=new AbortController().signal;let calls=0;
 f.edit(c=>{c.mcpConnections[0].audience.chatIds=['other-group'];});
 await assert.rejects(mcpRead(f.store,f.file,f.task,request,signal,async()=>{calls++;return {};}),/mcp_access_denied/);
 f.edit(c=>{c.mcpConnections[0].audience.chatIds=['group1'];c.mcpConnections[0].projects=[];c.codex.projectAccess.app.organization=false;});
 await assert.rejects(mcpRead(f.store,f.file,f.task,request,signal,async()=>{calls++;return {};}),/mcp_access_denied/);
 assert.equal(calls,0);
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
 f.edit(c=>{c.mcpConnections.push({id:'private',type:'linear',enabled:true,audience:{organization:false,userIds:['bob'],chatIds:[]},projects:['app'],token:'private_token_123'});});
 const result=await mcpRead(f.store,f.file,f.task,{operation:'connections'},signal,async()=>{calls++;return {};},applied);
 assert.deepEqual(result,{connections:[{id:'linear',type:'remote'}]});assert.equal(calls,0);
 const foreign=fixture(t,'p2p','bob','other');
 assert.deepEqual(await mcpRead(foreign.store,foreign.file,foreign.task,{operation:'connections'},signal),{connections:[]});
 f.edit(c=>{c.mcpConnections[0].enabled=false;});
 assert.deepEqual(await mcpRead(f.store,f.file,f.task,{operation:'connections'},signal),{connections:[]});
 await assert.rejects(mcpRead(f.store,f.file,f.task,{operation:'connections',connection:'linear'},signal),/mcp_invalid_request/);
});

test('remote calls require a bound one-time approval and recheck tool metadata before dispatch',async t=>{
 const f=fixture(t),signal=new AbortController().signal;
 f.edit(c=>{c.mcpConnections=[{id:'remote',type:'remote',url:'https://mcp.example/mcp',enabled:true,audience:{organization:false,userIds:['alice'],chatIds:[]},projects:['app'],token:''}];});
 f.store.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(f.task.id);
 let calls=0;const tool={name:'update',description:'Update',inputSchema:{type:'object'},approvalRequired:true};
 const fake=async(_connection:any,request:any,_signal:AbortSignal,beforeCall?:(tool:unknown)=>void)=>{if(request.operation==='list')return [tool];beforeCall?.(tool);calls++;return {content:[{type:'text',text:'ok'}]};};
 const waiting=mcpRead(f.store,f.file,f.task,{operation:'call',connection:'remote',tool:'update',arguments:{title:'Example'}},signal,undefined,undefined,fake);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
 const id=String(f.store.db.prepare("SELECT key FROM settings WHERE key LIKE 'mcp-approval:%'").get()?.key).slice('mcp-approval:'.length);
 const {mcpApprovalCommand}=await import('../src/mcp-write-approval.js');
 f.store.enqueue({key:'approval',messageId:'approval',chatKey:f.task.chatKey,chatId:'chat',senderId:'alice',text:`/mcp-approve ${id} --confirm`});mcpApprovalCommand(f.store,f.store.get('approval')!);
 const result=await waiting;assert.equal(calls,1);assert.match(JSON.stringify(result),/ok/);
});

test('remote connections accept only public HTTPS endpoints and preserve credentials only for their original target',t=>{
 const f=fixture(t),audience={organization:false,userIds:['alice'],chatIds:[]};
 for(const url of ['http://example.com/mcp','https://127.0.0.1/mcp','https://example.com/mcp?token=private'])assert.throws(()=>parseMcpConnections([{id:'remote',type:'remote',url,enabled:true,audience,projects:[],token:''}]));
 const view=f.manager.config();const saved=f.manager.save(view.revision,{mcpConnections:[{id:'remote',type:'remote',url:'https://example.com/mcp',enabled:true,audience,projects:[],newToken:'secret_token_123'}]});
 assert.doesNotMatch(JSON.stringify(saved),/secret_token_123/);
 assert.throws(()=>f.manager.save(saved.revision,{mcpConnections:[{id:'remote',type:'remote',url:'https://elsewhere.example/mcp',enabled:true,audience,projects:[]}]}),/mcp_credential_target_changed/);
});

test('remote tool changes after approval never reach the remote dispatch',async t=>{
 const f=fixture(t),signal=new AbortController().signal;
 f.edit(c=>{c.mcpConnections=[{id:'remote',type:'remote',url:'https://mcp.example/mcp',enabled:true,audience:{organization:false,userIds:['alice'],chatIds:[]},projects:['app'],token:''}];});
 f.store.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(f.task.id);
 let dispatched=false;const tool={name:'update',description:'original',inputSchema:{type:'object'},approvalRequired:true};
 const fake=async(_connection:any,request:any,_signal:AbortSignal,beforeCall?:(tool:unknown)=>void)=>{if(request.operation==='list')return [tool];beforeCall?.({...tool,description:'changed'});dispatched=true;return {};};
 const waiting=mcpRead(f.store,f.file,f.task,{operation:'call',connection:'remote',tool:'update'},signal,undefined,undefined,fake);
 await new Promise(resolve=>setImmediate(resolve));const id=String(f.store.db.prepare("SELECT key FROM settings WHERE key LIKE 'mcp-approval:%'").get()?.key).slice('mcp-approval:'.length);
 const {mcpApprovalCommand}=await import('../src/mcp-write-approval.js');f.store.enqueue({key:'approval',messageId:'approval',chatKey:f.task.chatKey,chatId:'chat',senderId:'alice',text:`/mcp-approve ${id} --confirm`});mcpApprovalCommand(f.store,f.store.get('approval')!);
 await assert.rejects(waiting,/mcp_tool_changed/);assert.equal(dispatched,false);
});


test('admin can test a disabled connection without enabling task access or invoking tools',async t=>{
 const f=fixture(t);f.edit(c=>{c.mcpConnections[0].enabled=false;});
 let calls=0;
 const manager=new Management(f.file,{mcpReader:async(connection,request)=>{
  calls++;assert.equal(connection.enabled,false);assert.deepEqual(request,{operation:'list'});return [{name:'lookup'}];
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
 const duplicate={...original[0],id:'another',url:'https://MCP.LINEAR.APP:443/mcp/../mcp/readonly',enabled:false};
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
 assert.deepEqual(loadConfig(f.file).mcpConnections!.map(v=>({id:v.id,token:v.token,users:v.audience.userIds})),[{id:'linear',token,users:['alice']},{id:'old-copy',token:'separate_token_123',users:['bob']}]);
 assert.doesNotThrow(()=>f.manager.prepareMcpOAuth(saved.revision,'old-copy',values[1]));
 const removed=f.manager.save(saved.revision,{mcpConnections:[values[0]]});assert.equal(removed.mcpConnections.length,1);
 assert.equal(loadConfig(f.file).mcpConnections![0].token,token);
});

test('endpoint identity preserves distinct environments and path semantics',async()=>{
 const {duplicateMcpEndpoint}=await import('../src/mcp-endpoint-contract.js'),base={id:'first',url:'https://api.example/mcp'};
 for(const url of ['https://staging.example/mcp','https://api.example/MCP','https://api.example/mcp/','https://api.example/mcp/readonly'])assert.equal(duplicateMcpEndpoint([base],{id:'second',url}),undefined);
 assert.equal(duplicateMcpEndpoint([base],{id:'second',url:'https://API.EXAMPLE:443/./mcp'})?.id,'first');
});
