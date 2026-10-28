import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverMcpOAuthScopes, beginMcpOAuth, resolveMcpCredential, saveMcpOAuth, isOAuthReference, LEGACY_LINEAR_URL } from '../src/mcp-oauth.js';
const resource='https://mcp.example/mcp',issuer='https://login.example',redirect='http://127.0.0.1:45678/api/mcp-oauth/callback';
function fakeOAuth(expectedScope='read'){
 let registered=0,exchanged=0,refreshed=0;
 const fetcher:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal(init?.redirect,'error');
  if(url.href===resource)return new Response(null,{status:401,headers:{'www-authenticate':'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"'}});
  if(url.pathname.startsWith('/.well-known/oauth-protected-resource'))return Response.json({resource,authorization_servers:[issuer],scopes_supported:['read','write']});
  if(url.pathname.startsWith('/.well-known/'))return Response.json({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',registration_endpoint:issuer+'/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256']});
  if(url.pathname==='/register'){registered++;const body=JSON.parse(String(init?.body));assert.equal(body.scope,expectedScope);assert.deepEqual(body.redirect_uris,[redirect]);return Response.json({client_id:'synthetic-client',client_id_issued_at:1,token_endpoint_auth_method:'none',redirect_uris:[redirect],grant_types:['authorization_code','refresh_token'],response_types:['code']});}
  if(url.pathname==='/token'){
    const body=new URLSearchParams(String(init?.body));
    if(body.get('grant_type')==='authorization_code'){exchanged++;assert.ok(body.get('code_verifier'));assert.equal(body.get('code'),'synthetic-code');return Response.json({access_token:'synthetic_access_1',token_type:'Bearer',expires_in:1,refresh_token:'synthetic_refresh_1',scope:expectedScope});}
    if(body.get('grant_type')==='refresh_token'){refreshed++;await new Promise(resolve=>setTimeout(resolve,40));assert.equal(body.get('refresh_token'),'synthetic_refresh_1');return Response.json({access_token:'synthetic_access_2',token_type:'Bearer',expires_in:3600,refresh_token:'synthetic_refresh_2',scope:expectedScope});}
  }
  throw Error('unexpected OAuth URL');
 };
 return {fetcher,get counts(){return {registered,exchanged,refreshed};}};
}
test('generic OAuth binds resource, issuer and PKCE and refreshes once across concurrent calls',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-oauth-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const fake=fakeOAuth(),flow=await beginMcpOAuth(resource,redirect,'read',fake.fetcher),url=new URL(flow.url);
 assert.equal(url.origin,issuer);assert.equal(url.searchParams.get('scope'),'read');assert.equal(url.searchParams.get('state'),flow.state);
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('redirect_uri'),redirect);
 const record=await flow.finish('synthetic-code');const ref=saveMcpOAuth(dir,record);assert.ok(isOAuthReference(ref));
 const file=join(dir,'mcp-oauth',ref+'.json');assert.equal(statSync(file).mode&0o777,0o600);
 const results=await Promise.all([resolveMcpCredential(dir,ref,resource,new AbortController().signal,fake.fetcher),resolveMcpCredential(dir,ref,resource,new AbortController().signal,fake.fetcher)]);
 assert.deepEqual(results.map(r=>r.token),['synthetic_access_2','synthetic_access_2']);assert.deepEqual(fake.counts,{registered:1,exchanged:1,refreshed:1});
 await assert.rejects(resolveMcpCredential(dir,ref,'https://elsewhere.example/mcp',new AbortController().signal,fake.fetcher),/target_changed/);
 await assert.rejects(resolveMcpCredential(dir,ref,resource,new AbortController().signal,fake.fetcher,'write'),/scope_changed/);
});
test('OAuth rejects invalid callbacks, widened scopes and malicious metadata endpoints',async()=>{
 const fake=fakeOAuth();await assert.rejects(beginMcpOAuth(resource,'http://localhost:45678/api/mcp-oauth/callback','read',fake.fetcher),/mcp_oauth_invalid/);
 const flow=await beginMcpOAuth(resource,redirect,'read',fake.fetcher);await assert.rejects(flow.finish('bad\ncode'),/mcp_oauth_invalid/);
 const elevated:typeof fetch=async(input,init)=>new URL(String(input)).pathname==='/token'?Response.json({access_token:'fake',token_type:'Bearer',expires_in:3600,scope:'read write'}):fake.fetcher(input,init);
 const unsafe=await beginMcpOAuth(resource,redirect,'read',elevated);await assert.rejects(unsafe.finish('synthetic-code'),/mcp_oauth_scope/);
 const malicious:typeof fetch=async(input,init)=>new URL(String(input)).origin===issuer&&new URL(String(input)).pathname.startsWith('/.well-known/')?Response.json({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:'https://evil.example/token',registration_endpoint:issuer+'/register',response_types_supported:['code']}):fake.fetcher(input,init);
 await assert.rejects(beginMcpOAuth(resource,redirect,'read',malicious),/mcp_oauth_origin/);
});
test('OAuth callback is single-use, checks issuer and does not expose tokens',async t=>{
 const {storeFixture}=await import('./helpers.js'),{Management}=await import('../src/management.js'),{McpOAuthFlow}=await import('../src/mcp-oauth-flow.js');
 const {dir}=storeFixture(t,'namo-oauth-flow-'),file=join(dir,'config.json');
 writeFileSync(file,JSON.stringify({dataDir:dir,feishu:{appId:'app',appSecret:'test-secret',allowedUserIds:['alice']},codex:{home:join(dir,'auth')},mcpConnections:[{id:'demo',type:'remote',url:resource,oauthScope:'read',enabled:false,audience:{organization:false,userIds:['alice'],chatIds:[]},projects:[],token:''}]}));
 const manager=new Management(file),revision=manager.config().revision,fake=fakeOAuth();
 const begin:typeof beginMcpOAuth=(url,callback,scope)=>beginMcpOAuth(url,callback,scope,fake.fetcher);
 const flow=new McpOAuthFlow(manager,()=> 'http://127.0.0.1:45678',begin);const started=await flow.begin(revision,'demo');const state=new URL(started.url).searchParams.get('state')!;
 assert.equal(await flow.finish(new URLSearchParams({state:'wrong',code:'synthetic-code'})),false);
 assert.equal(await flow.finish(new URLSearchParams({state,code:'synthetic-code',iss:'https://evil.example'})),false);
 assert.equal(await flow.finish(new URLSearchParams({state,code:'synthetic-code',iss:issuer})),true);
 assert.equal(await flow.finish(new URLSearchParams({state,code:'synthetic-code',iss:issuer})),false);
 assert.doesNotMatch(JSON.stringify(manager.config()),/synthetic_access|synthetic_refresh|oauth_[a-f0-9]/);
 assert.equal(manager.config().mcpConnections[0].credentialSource,'oauth');
});
test('OAuth callback rejects a stale config, leaving prior authorization intact',async t=>{
 const {storeFixture}=await import('./helpers.js'),{Management}=await import('../src/management.js'),{McpOAuthFlow}=await import('../src/mcp-oauth-flow.js');
 const {dir}=storeFixture(t,'namo-oauth-stale-'),file=join(dir,'config.json');
 writeFileSync(file,JSON.stringify({dataDir:dir,feishu:{appId:'app',appSecret:'test-secret',allowedUserIds:['alice']},codex:{home:join(dir,'auth')},mcpConnections:[{id:'demo',type:'remote',url:resource,oauthScope:'read',enabled:false,audience:{organization:false,userIds:['alice'],chatIds:[]},projects:[],token:''}]}));
 const manager=new Management(file),revision=manager.config().revision,fake=fakeOAuth();const flow=new McpOAuthFlow(manager,()=> 'http://127.0.0.1:45678',(url,cb,scope)=>beginMcpOAuth(url,cb,scope,fake.fetcher));
 const started=await flow.begin(revision,'demo'),state=new URL(started.url).searchParams.get('state')!;manager.save(revision,{model:'changed'});
 assert.equal(await flow.finish(new URLSearchParams({state,code:'synthetic-code',iss:issuer})),false);assert.equal(fake.counts.exchanged,0);
});
test('legacy Linear credentials are readable only for their original endpoint',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-old-oauth-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const folder=join(dir,'mcp-oauth');mkdirSync(folder,{mode:0o700});
 const ref='oauth_'+ 'a'.repeat(48),record={client:{client_id:'client',issuer:'https://mcp.linear.app'},tokens:{access_token:'legacy_access',refresh_token:'legacy_refresh',token_type:'Bearer',scope:'read',issuer:'https://mcp.linear.app'},expiresAt:Date.now()+3600000,redirectUrl:redirect};
 writeFileSync(join(folder,ref+'.json'),JSON.stringify(record),{mode:0o600});
 assert.equal((await resolveMcpCredential(dir,ref,LEGACY_LINEAR_URL,new AbortController().signal)).token,'legacy_access');
 await assert.rejects(resolveMcpCredential(dir,ref,resource,new AbortController().signal),/mcp_oauth_invalid/);
});
test('expired legacy credentials migrate on refresh without changing their target',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-old-oauth-refresh-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const folder=join(dir,'mcp-oauth');mkdirSync(folder,{mode:0o700});
 const ref='oauth_'+ 'b'.repeat(48),root='https://mcp.linear.app',record={client:{client_id:'client',issuer:root,token_endpoint_auth_method:'none'},tokens:{access_token:'legacy_access',refresh_token:'legacy_refresh',token_type:'Bearer',scope:'read',issuer:root},expiresAt:Date.now()-1,redirectUrl:redirect};
 writeFileSync(join(folder,ref+'.json'),JSON.stringify(record),{mode:0o600});let refresh=0;
 const fetcher:typeof fetch=async(input,init)=>{const url=new URL(String(input));assert.equal(url.origin,root);
  if(url.pathname==='/mcp/readonly')return new Response(null,{status:401});
  if(url.pathname.startsWith('/.well-known/oauth-protected-resource'))return Response.json({resource:LEGACY_LINEAR_URL,authorization_servers:[root],scopes_supported:['read']});
  if(url.pathname.startsWith('/.well-known/'))return Response.json({issuer:root,authorization_endpoint:root+'/authorize',token_endpoint:root+'/token',registration_endpoint:root+'/register',response_types_supported:['code'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256']});
  if(url.pathname==='/token'){refresh++;assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'),'legacy_refresh');return Response.json({access_token:'legacy_new_access',refresh_token:'legacy_new_refresh',token_type:'Bearer',scope:'read',expires_in:3600});}throw new Error('unexpected');};
 assert.equal((await resolveMcpCredential(dir,ref,LEGACY_LINEAR_URL,new AbortController().signal,fetcher)).token,'legacy_new_access');assert.equal(refresh,1);
 const migrated=JSON.parse((await import('node:fs')).readFileSync(join(folder,ref+'.json'),'utf8'));assert.equal(migrated.serverUrl,LEGACY_LINEAR_URL);assert.equal(migrated.scope,'read');
});
test('authorization server advertised issuer is required at callback',async t=>{
 const {storeFixture}=await import('./helpers.js'),{Management}=await import('../src/management.js'),{McpOAuthFlow}=await import('../src/mcp-oauth-flow.js');
 const {dir}=storeFixture(t,'namo-oauth-iss-'),file=join(dir,'config.json');
 writeFileSync(file,JSON.stringify({dataDir:dir,feishu:{appId:'app',appSecret:'test-secret',allowedUserIds:['alice']},codex:{home:join(dir,'auth')},mcpConnections:[{id:'demo',type:'remote',url:resource,oauthScope:'read',enabled:false,audience:{organization:false,userIds:['alice'],chatIds:[]},projects:[],token:''}]}));
 const fake=fakeOAuth(),fetcher:typeof fetch=async(input,init)=>{const url=new URL(String(input));if(url.origin===issuer&&url.pathname.startsWith('/.well-known/')){const response=await fake.fetcher(input,init);return Response.json({...await response.json(),authorization_response_iss_parameter_supported:true});}return fake.fetcher(input,init);};
 const manager=new Management(file),flow=new McpOAuthFlow(manager,()=> 'http://127.0.0.1:45678',(url,cb,scope)=>beginMcpOAuth(url,cb,scope,fetcher));const started=await flow.begin(manager.config().revision,'demo'),state=new URL(started.url).searchParams.get('state')!;
 assert.equal(await flow.finish(new URLSearchParams({state,code:'synthetic-code'})),false);assert.equal(fake.counts.exchanged,0);
 assert.equal(await flow.finish(new URLSearchParams({state,code:'synthetic-code',iss:issuer})),true);
});
test('refresh responses without a replacement refresh token retain the existing one',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-oauth-rotate-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const fake=fakeOAuth();
 const fetcher:typeof fetch=async(input,init)=>{if(new URL(String(input)).pathname==='/token'&&new URLSearchParams(String(init?.body)).get('grant_type')==='refresh_token')return Response.json({access_token:'new_access',token_type:'Bearer',scope:'read',expires_in:3600});return fake.fetcher(input,init);};
 const flow=await beginMcpOAuth(resource,redirect,'read',fetcher),ref=saveMcpOAuth(dir,await flow.finish('synthetic-code'));
 await resolveMcpCredential(dir,ref,resource,new AbortController().signal,fetcher);
 const saved=JSON.parse((await import('node:fs')).readFileSync(join(dir,'mcp-oauth',ref+'.json'),'utf8'));
 assert.equal(saved.tokens.refresh_token,'synthetic_refresh_1');
});
test('OAuth uses the challenged minimum scope without requesting all advertised scopes',async()=>{
 const fake=fakeOAuth();const fetcher:typeof fetch=(input,init)=>String(input)===resource?Promise.resolve(new Response(null,{status:401,headers:{'www-authenticate':'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource", scope="read"'}})):fake.fetcher(input,init);
 const flow=await beginMcpOAuth(resource,redirect,'',fetcher);assert.equal(new URL(flow.url).searchParams.get('scope'),'read');
});


test('scope discovery exposes advertised choices without registration or automatic selection',async()=>{
 const fake=fakeOAuth(),result=await discoverMcpOAuthScopes(resource,fake.fetcher);
 assert.deepEqual(result.scopes,['read','write']);assert.deepEqual(result.recommended,[]);assert.equal(result.published,true);
 assert.deepEqual(fake.counts,{registered:0,exchanged:0,refreshed:0});
 await assert.rejects(beginMcpOAuth(resource,redirect,'unsupported',fake.fetcher),/mcp_oauth_invalid_scope/);
 assert.equal(fake.counts.registered,0);
});
test('scope discovery distinguishes unpublished permissions and failed discovery',async()=>{
 const fake=fakeOAuth(),unpublished:typeof fetch=async(input,init)=>{const response=await fake.fetcher(input,init);const data=await response.json().catch(()=>null);if(!data)return response;delete data.scopes_supported;return Response.json(data);};
 const result=await discoverMcpOAuthScopes(resource,unpublished);assert.equal(result.published,false);assert.deepEqual(result.scopes,[]);
 await assert.rejects(discoverMcpOAuthScopes(resource,async()=>{throw Error('PRIVATE_REMOTE_ERROR');}),/mcp_oauth_discovery_failed/);
});

test('provider authorization errors are bound to pending state, sanitized and single use',async t=>{
 const {storeFixture}=await import('./helpers.js'),{Management}=await import('../src/management.js'),{McpOAuthFlow}=await import('../src/mcp-oauth-flow.js');
 const {dir}=storeFixture(t,'namo-oauth-error-'),file=join(dir,'config.json');
 writeFileSync(file,JSON.stringify({dataDir:dir,feishu:{appId:'app',appSecret:'test-secret',allowedUserIds:['alice']},codex:{home:join(dir,'auth')},mcpConnections:[{id:'demo',type:'remote',url:resource,oauthScope:'read',enabled:false,audience:{organization:false,userIds:['alice'],chatIds:[]},projects:[],token:''}]}));
 const manager=new Management(file);let exchanged=false;
 const flow=new McpOAuthFlow(manager,()=> 'http://127.0.0.1:45678',async()=>({url:issuer+'/authorize',issuer,state:'test-state',requireIssuer:false,async finish(){exchanged=true;throw Error();}}));
 await flow.begin(manager.config().revision,'demo');
 assert.equal(await flow.finish(new URLSearchParams({state:'test-state',error:'invalid_scope',error_description:'PRIVATE_ERROR'})),false);
 assert.equal(flow.failure,'mcp_oauth_invalid_scope');assert.equal(exchanged,false);
 assert.equal(await flow.finish(new URLSearchParams({state:'test-state',code:'code'})),false);
});

test('reauthorization commits a changed scope and credential atomically only after success',async t=>{
 const {storeFixture}=await import('./helpers.js'),{Management}=await import('../src/management.js'),{McpOAuthFlow}=await import('../src/mcp-oauth-flow.js');
 const {dir}=storeFixture(t,'namo-oauth-draft-'),file=join(dir,'config.json');
 const fake=fakeOAuth(),initial=await beginMcpOAuth(resource,redirect,'read',fake.fetcher),oldRef=saveMcpOAuth(dir,await initial.finish('synthetic-code'));
 writeFileSync(file,JSON.stringify({dataDir:dir,feishu:{appId:'app',appSecret:'test-secret',allowedUserIds:['alice']},codex:{home:join(dir,'auth')},mcpConnections:[{id:'demo',type:'remote',url:resource,oauthScope:'read',enabled:true,audience:{organization:false,userIds:['alice'],chatIds:[]},projects:[],token:oldRef}]}));
 const before=(await import('node:fs')).readFileSync(file,'utf8'),manager=new Management(file),revision=manager.config().revision;
 const draft={id:'demo',type:'remote',url:resource,oauthScope:'read write',enabled:true,audience:{organization:false,userIds:['alice'],chatIds:[]},projects:[]};
 const flow=new McpOAuthFlow(manager,()=> 'http://127.0.0.1:45678',(url,cb,scope)=>beginMcpOAuth(url,cb,scope,fakeOAuth(scope).fetcher));
 const first=await flow.begin(revision,'demo',draft),state=new URL(first.url).searchParams.get('state')!;
 assert.equal((await import('node:fs')).readFileSync(file,'utf8'),before);
 assert.equal(await flow.finish(new URLSearchParams({state,error:'access_denied',iss:issuer})),false);
 assert.equal((await import('node:fs')).readFileSync(file,'utf8'),before);
 const second=await flow.begin(revision,'demo',draft),state2=new URL(second.url).searchParams.get('state')!;
 assert.equal(await flow.finish(new URLSearchParams({state:state2,code:'synthetic-code',iss:issuer})),true);
 const saved=JSON.parse((await import('node:fs')).readFileSync(file,'utf8'));
 assert.equal(saved.mcpConnections[0].oauthScope,'read write');assert.notEqual(saved.mcpConnections[0].token,oldRef);assert.equal(saved.mcpConnections[0].enabled,true);
});

test('cancelled OAuth drafts cannot later replace the saved connection',async t=>{
 const {storeFixture}=await import('./helpers.js'),{Management}=await import('../src/management.js'),{McpOAuthFlow}=await import('../src/mcp-oauth-flow.js');
 const {dir}=storeFixture(t,'namo-oauth-cancel-'),file=join(dir,'config.json');
 writeFileSync(file,JSON.stringify({dataDir:dir,feishu:{appId:'app',appSecret:'test-secret',allowedUserIds:['alice']},codex:{home:join(dir,'auth')},mcpConnections:[]}));
 const before=(await import('node:fs')).readFileSync(file,'utf8'),manager=new Management(file),revision=manager.config().revision;
 const flow=new McpOAuthFlow(manager,()=> 'http://127.0.0.1:45678',(url,cb,scope)=>beginMcpOAuth(url,cb,scope,fakeOAuth().fetcher));
 const draft={id:'new',type:'remote',url:resource,oauthScope:'read',enabled:false,audience:{organization:false,userIds:[],chatIds:[]},projects:[]};
 const started=await flow.begin(revision,'',draft),state=new URL(started.url).searchParams.get('state')!;flow.cancel('');
 assert.equal(await flow.finish(new URLSearchParams({state,code:'synthetic-code',iss:issuer})),false);
 assert.equal((await import('node:fs')).readFileSync(file,'utf8'),before);
 assert.throws(()=>manager.prepareMcpOAuth(revision,'',{...draft,id:'Bad ID'}),/mcp_invalid_config/);
 const inFlight=await flow.begin(revision,'',draft),state2=new URL(inFlight.url).searchParams.get('state')!;
 const finishing=flow.finish(new URLSearchParams({state:state2,code:'synthetic-code',iss:issuer}));flow.cancel('');
 assert.equal(await finishing,false);assert.equal((await import('node:fs')).readFileSync(file,'utf8'),before);
});
