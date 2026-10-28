import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeFixture } from './helpers.js';
import { Tasks } from '../src/tasks.js';
import { loadConfig } from '../src/config.js';
import { Management } from '../src/management.js';
import { LINEAR_READONLY_URL, assertMcpDelivery, linearRead, mcpRead, parseMcpConnections } from '../src/mcp-connections.js';
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
 const saved=f.manager.save(view.revision,{mcpConnections:[{id:'linear',type:'linear',enabled:true,audience:{...f.config.mcpConnections[0].audience,chatIds:['group1','group2']},projects:['app']}]});
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
test('Linear transport uses fixed read-only URL and calls only discovered tools',async()=>{
 const calls:string[]=[];
 const fakeFetch:typeof fetch=async(input,init)=>{
  assert.equal(String(input),LINEAR_READONLY_URL);assert.equal(init?.redirect,'error');
  const headers=new Headers(init?.headers);assert.equal(headers.get('authorization'),`Bearer ${token}`);
  const body=JSON.parse(String(init?.body));calls.push(body.method);
  if(body.id===undefined)return new Response(null,{status:202});
  let result:unknown={};
  if(body.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}};
  if(body.method==='tools/list')result={tools:[{name:'get_issue',description:'Read an issue',inputSchema:{type:'object',properties:{}}}]};
  if(body.method==='tools/call')result={content:[{type:'text',text:'issue'}]};
  return Response.json({jsonrpc:'2.0',id:body.id,result});
 };
 const connection=parseMcpConnections([{id:'linear',type:'linear',enabled:true,audience:{organization:false,userIds:['alice'],chatIds:[]},projects:[],token}])[0];
 const result=await linearRead(connection,{operation:'call',tool:'get_issue'},new AbortController().signal,fakeFetch);
 assert.match(JSON.stringify(result),/issue/);assert.ok(calls.includes('tools/list'));assert.ok(calls.includes('tools/call'));
 await assert.rejects(linearRead(connection,{operation:'call',tool:'unknown'},new AbortController().signal,fakeFetch),/mcp_tool_not_found/);
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
 assert.deepEqual(result,{connections:[{id:'linear',type:'linear'}]});assert.equal(calls,0);
 const foreign=fixture(t,'p2p','bob','other');
 assert.deepEqual(await mcpRead(foreign.store,foreign.file,foreign.task,{operation:'connections'},signal),{connections:[]});
 f.edit(c=>{c.mcpConnections[0].enabled=false;});
 assert.deepEqual(await mcpRead(f.store,f.file,f.task,{operation:'connections'},signal),{connections:[]});
 await assert.rejects(mcpRead(f.store,f.file,f.task,{operation:'connections',connection:'linear'},signal),/mcp_invalid_request/);
});
