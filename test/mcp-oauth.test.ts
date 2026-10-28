import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beginLinearOAuth, resolveLinearCredential, saveLinearOAuth, isOAuthReference } from '../src/mcp-oauth.js';
const origin='https://mcp.linear.app',redirect='http://127.0.0.1:45678/api/mcp-oauth/callback';
function fakeOAuth(){
 let registered=0,exchanged=0,refreshed=0;
 const fetcher:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.origin,origin);assert.equal(init?.redirect,'error');
  if(url.pathname.startsWith('/.well-known/oauth-protected-resource'))return Response.json({resource:origin+'/mcp/readonly',authorization_servers:[origin],scopes_supported:['read']});
  if(url.pathname.startsWith('/.well-known/'))return Response.json({issuer:origin,authorization_endpoint:origin+'/authorize',token_endpoint:origin+'/token',registration_endpoint:origin+'/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256']});
  if(url.pathname==='/register'){registered++;const body=JSON.parse(String(init?.body));assert.equal(body.scope,'read');assert.deepEqual(body.redirect_uris,[redirect]);return Response.json({client_id:'synthetic-client',client_id_issued_at:1,token_endpoint_auth_method:'none',redirect_uris:[redirect],grant_types:['authorization_code','refresh_token'],response_types:['code']});}
  if(url.pathname==='/token'){
    const body=new URLSearchParams(String(init?.body));
    if(body.get('grant_type')==='authorization_code'){exchanged++;assert.ok(body.get('code_verifier'));assert.equal(body.get('code'),'synthetic-code');return Response.json({access_token:'synthetic_access_1',token_type:'Bearer',expires_in:1,refresh_token:'synthetic_refresh_1',scope:'read'});}
    if(body.get('grant_type')==='refresh_token'){refreshed++;await new Promise(resolve=>setTimeout(resolve,40));assert.equal(body.get('refresh_token'),'synthetic_refresh_1');return Response.json({access_token:'synthetic_access_2',token_type:'Bearer',expires_in:3600,refresh_token:'synthetic_refresh_2',scope:'read'});}
  }
  throw Error('unexpected OAuth URL');
 };
 return {fetcher,get counts(){return {registered,exchanged,refreshed};}};
}
test('Linear OAuth requests read-only scope, binds PKCE and rotates tokens once across concurrent calls',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-oauth-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const fake=fakeOAuth(),flow=await beginLinearOAuth(redirect,fake.fetcher),url=new URL(flow.url);
 assert.equal(url.origin,origin);assert.equal(url.searchParams.get('scope'),'read');assert.equal(url.searchParams.get('state'),flow.state);
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('redirect_uri'),redirect);
 const record=await flow.finish('synthetic-code');const ref=saveLinearOAuth(dir,record);assert.ok(isOAuthReference(ref));
 const file=join(dir,'mcp-oauth',ref+'.json');assert.equal(statSync(file).mode&0o777,0o600);
 const results=await Promise.all([resolveLinearCredential(dir,ref,new AbortController().signal,fake.fetcher),resolveLinearCredential(dir,ref,new AbortController().signal,fake.fetcher)]);
 assert.deepEqual(results.map(r=>r.token),['synthetic_access_2','synthetic_access_2']);assert.deepEqual(fake.counts,{registered:1,exchanged:1,refreshed:1});
 assert.doesNotMatch(ref,/synthetic/);assert.match(readFileSync(file,'utf8'),/synthetic_refresh_2/);
});
test('OAuth rejects invalid callbacks and excess scopes',async()=>{
 const fake=fakeOAuth();await assert.rejects(beginLinearOAuth('http://localhost:45678/api/mcp-oauth/callback',fake.fetcher),/mcp_oauth_invalid/);
 const flow=await beginLinearOAuth(redirect,fake.fetcher);await assert.rejects(flow.finish('bad\ncode'),/mcp_oauth_invalid/);
 const elevated:typeof fetch=async(input,init)=>{
  if(new URL(String(input)).pathname==='/token')return Response.json({access_token:'fake',token_type:'Bearer',expires_in:3600,scope:'read write'});
  return fake.fetcher(input,init);
 };
 const unsafe=await beginLinearOAuth(redirect,elevated);await assert.rejects(unsafe.finish('synthetic-code'),/mcp_oauth_failed/);
});

test('OAuth callback is single-use, checks state and issuer, and saves only an opaque reference',async t=>{
 const {storeFixture}=await import('./helpers.js');const {Management}=await import('../src/management.js');const {LinearOAuthFlow}=await import('../src/mcp-oauth-flow.js');const {writeFileSync}=await import('node:fs');
 const {dir}=storeFixture(t,'namo-oauth-flow-'),file=join(dir,'config.json');
 writeFileSync(file,JSON.stringify({dataDir:dir,feishu:{appId:'app',appSecret:'test-secret',allowedUserIds:['alice']},codex:{home:join(dir,'auth')},mcpConnections:[{id:'linear',type:'linear',enabled:false,audience:{organization:false,userIds:['alice'],chatIds:[]},projects:[],token:''}]}));
 const manager=new Management(file),revision=manager.config().revision;
 let exchanges=0;const fakeBegin:typeof beginLinearOAuth=async()=>({state:'state-one',url:origin+'/authorize?scope=read',async finish(code){exchanges++;assert.equal(code,'code-one');return {client:{client_id:'synthetic-client',issuer:origin},tokens:{access_token:'private_access',refresh_token:'private_refresh',token_type:'Bearer',scope:'read',issuer:origin},expiresAt:Date.now()+3600000,redirectUrl:redirect};}});
 const flow=new LinearOAuthFlow(manager,()=> 'http://127.0.0.1:45678',fakeBegin);await flow.begin(revision,'linear');
 assert.equal(await flow.finish(new URLSearchParams('state=wrong&code=code-one')),false);
 assert.equal(await flow.finish(new URLSearchParams('state=state-one&code=code-one')),false);
 assert.equal(await flow.finish(new URLSearchParams('state=state-one&code=code-one&iss=https%3A%2F%2Fevil.invalid')),false);
 assert.equal(exchanges,0);
 assert.equal(await flow.finish(new URLSearchParams('state=state-one&code=code-one&iss=https%3A%2F%2Fmcp.linear.app')),true);
 assert.equal(await flow.finish(new URLSearchParams('state=state-one&code=code-one')),false);
 const raw=JSON.parse(readFileSync(file,'utf8'));assert.ok(isOAuthReference(raw.mcpConnections[0].token));
 assert.doesNotMatch(JSON.stringify(manager.config()),/private_access|private_refresh|oauth_[a-f0-9]/);
 assert.equal(manager.config().mcpConnections[0].credentialSource,'oauth');
 assert.equal(exchanges,1);
});

test('OAuth callback refuses configuration changes made while authorization is pending',async t=>{
 const {storeFixture}=await import('./helpers.js');const {Management}=await import('../src/management.js');const {LinearOAuthFlow}=await import('../src/mcp-oauth-flow.js');const {writeFileSync}=await import('node:fs');
 const {dir}=storeFixture(t,'namo-oauth-stale-'),file=join(dir,'config.json');
 writeFileSync(file,JSON.stringify({dataDir:dir,feishu:{appId:'app',appSecret:'test-secret',allowedUserIds:['alice']},codex:{home:join(dir,'auth')},mcpConnections:[{id:'linear',type:'linear',enabled:false,audience:{organization:false,userIds:['alice'],chatIds:[]},projects:[],token:''}]}));
 const manager=new Management(file),revision=manager.config().revision;
 let exchanges=0;const fakeBegin:typeof beginLinearOAuth=async()=>({state:'state-two',url:origin+'/authorize',async finish(){exchanges++;throw Error();}});
 const flow=new LinearOAuthFlow(manager,()=> 'http://127.0.0.1:45678',fakeBegin);await flow.begin(revision,'linear');manager.save(revision,{model:'changed'});
 assert.equal(await flow.finish(new URLSearchParams('state=state-two&code=code&iss=https%3A%2F%2Fmcp.linear.app')),false);assert.equal(exchanges,0);
});

test('authorized MCP calls resolve OAuth references without exposing either token',async t=>{
 const {storeFixture}=await import('./helpers.js');const {Tasks}=await import('../src/tasks.js');const {mcpRead}=await import('../src/mcp-connections.js');const {writeFileSync}=await import('node:fs');
 const {dir,store}=storeFixture(t,'namo-oauth-call-'),file=join(dir,'config.json');
 const record={client:{client_id:'synthetic-client',issuer:origin},tokens:{access_token:'private_access_token',refresh_token:'private_refresh_token',token_type:'Bearer',scope:'read',issuer:origin},expiresAt:Date.now()+3600000,redirectUrl:redirect};
 const ref=saveLinearOAuth(dir,record);
 writeFileSync(file,JSON.stringify({dataDir:dir,feishu:{appId:'app',appSecret:'test-secret',allowedUserIds:['alice']},codex:{home:join(dir,'auth')},mcpConnections:[{id:'linear',type:'linear',enabled:true,audience:{organization:false,userIds:['alice'],chatIds:[]},projects:[],token:ref}]}));
 store.enqueue({key:'input',messageId:'input',chatKey:'chat',chatId:'chat',senderId:'alice',text:'read',envelope:{version:1,type:'text',kind:'instruction',scopeKey:'chat',chatType:'p2p',materials:[],limitations:[]}});
 const task=new Tasks(store).create(store.get('input')!,{cwd:dir,policyHash:'test'});
 const result=await mcpRead(store,file,task,{operation:'call',connection:'linear',tool:'get_issue'},new AbortController().signal,async connection=>{
  assert.equal(connection.token,'private_access_token');return {text:'private_access_token private_refresh_token'};
 });
 assert.doesNotMatch(JSON.stringify(result),/private_access_token|private_refresh_token/);
});
