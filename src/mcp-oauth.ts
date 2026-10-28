import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { atomicJson } from './paths.js';
import { acquireLock } from './safety.js';
import { publicHttpsUrl, publicNetwork } from './mcp-public-network.js';

const REF=/^oauth_[a-f0-9]{48}$/, MAX=262144;
// Only for reading pre-unification credentials; new connections have no provider-specific behavior.
export const LEGACY_LINEAR_URL='https://mcp.linear.app/mcp/readonly';
export class OAuthError extends Error { constructor(readonly code:string){super(code);} }
export interface OAuthRecord {serverUrl:string;issuer:string;scope:string;discovery:OAuthDiscoveryState;client:OAuthClientInformationMixed;tokens:OAuthTokens;expiresAt:number;redirectUrl:string}
const directory=(dataDir:string)=>join(dataDir,'mcp-oauth');
const path=(dataDir:string,ref:string)=>{if(!REF.test(ref))throw new OAuthError('mcp_oauth_invalid');return join(directory(dataDir),ref+'.json');};
function ensureDirectory(dataDir:string,create=false):void {
 const dir=directory(dataDir);if(create)mkdirSync(dir,{recursive:true,mode:0o700});
 const info=lstatSync(dir);if(info.isSymbolicLink()||!info.isDirectory()||(info.mode&0o077)!==0)throw new OAuthError('mcp_oauth_invalid');
}
export const isOAuthReference=(v:string)=>REF.test(v);
const normalize=(value:string)=>new URL(value).href.replace(/\/$/,'');
const same=(a:string,b:string)=>normalize(a)===normalize(b);
function checkScope(requested:string,granted?:string):void {
 if(granted&&requested){const allowed=new Set(requested.split(/\s+/).filter(Boolean));if(granted.split(/\s+/).some(s=>s&&!allowed.has(s)))throw new OAuthError('mcp_oauth_scope');}
}
function checkExpectedScope(expected:string|undefined,actual:string):void {
 if(!expected?.trim())return;
 const requested=new Set(expected.trim().split(/\s+/)),stored=new Set(actual.trim().split(/\s+/));
 if(requested.size!==stored.size||[...requested].some(scope=>!stored.has(scope)))throw new OAuthError('mcp_oauth_scope_changed');
}
function validate(record:OAuthRecord):void {
 if(!record||typeof record!=='object'||typeof record.serverUrl!=='string'||typeof record.issuer!=='string'||typeof record.scope!=='string'
 ||typeof record.client?.client_id!=='string'||typeof record.tokens?.access_token!=='string'||!Number.isSafeInteger(record.expiresAt)||typeof record.redirectUrl!=='string'
 ||!record.discovery?.authorizationServerMetadata||!record.discovery.resourceMetadata||!same(record.client.issuer??'',record.issuer)||!same(record.tokens.issuer??'',record.issuer))throw new OAuthError('mcp_oauth_invalid');
 publicHttpsUrl(record.serverUrl);validateDiscovery(record.serverUrl,record.discovery);checkScope(record.scope,record.tokens.scope);
}
function validateDiscovery(serverUrl:string,state:OAuthDiscoveryState):void {
 const issuer=String(state.authorizationServerUrl),metadata=state.authorizationServerMetadata,resource=state.resourceMetadata;
 if(!metadata||!resource||!Array.isArray(resource.authorization_servers)||!resource.authorization_servers.some(v=>same(v,issuer))||!same(metadata.issuer,issuer))throw new OAuthError('mcp_oauth_metadata');
 const issuerUrl=publicHttpsUrl(issuer);publicHttpsUrl(serverUrl);publicHttpsUrl(resource.resource);
 for(const endpoint of [metadata.authorization_endpoint,metadata.token_endpoint,metadata.registration_endpoint].filter((v):v is string=>!!v)){
   if(publicHttpsUrl(endpoint).origin!==issuerUrl.origin)throw new OAuthError('mcp_oauth_origin');
 }
}
function readRecord(dataDir:string,ref:string):any {
 try {const file=path(dataDir,ref);ensureDirectory(dataDir);const info=lstatSync(file);if(info.isSymbolicLink()||!info.isFile()||(info.mode&0o077)!==0||statSync(file).size>MAX)throw new Error();return JSON.parse(readFileSync(file,'utf8'));}
 catch {throw new OAuthError('mcp_oauth_missing');}
}
function scopedFetch(signal:AbortSignal,fetcher:typeof fetch):typeof fetch {
 return async(input,init)=>{
  publicHttpsUrl(input instanceof Request?input.url:String(input));
  const response=await fetcher(input,{...init,redirect:'error',signal});
  if(!response.body)return response;
  let bytes=0;const stream=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){bytes+=chunk.byteLength;if(bytes>MAX)throw new OAuthError('mcp_oauth_response_too_large');controller.enqueue(chunk);}}));
  return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
 };
}
async function withFetch<T>(signal:AbortSignal,fn:(fetcher:typeof fetch)=>Promise<T>,override?:typeof fetch):Promise<T> {
 const network=override?undefined:publicNetwork();
 try{return await fn(scopedFetch(AbortSignal.any([signal,AbortSignal.timeout(30000)]),override??network!.fetcher));}
 finally{await network?.close().catch(()=>{});}
}
async function discover(serverUrl:string,fetcher:typeof fetch):Promise<{state:OAuthDiscoveryState;challengedScope:string}> {
 const sdk=await import('@modelcontextprotocol/sdk/client/auth.js');
 let resourceMetadataUrl:URL|undefined,challengedScope='';
 try {
  const response=await fetcher(serverUrl,{headers:{Accept:'application/json, text/event-stream'}});
  if(response.status===401){const challenge=sdk.extractWWWAuthenticateParams(response);resourceMetadataUrl=challenge.resourceMetadataUrl;challengedScope=challenge.scope??'';}
  await response.body?.cancel();
 }catch{/* Some services do not support GET; use the well-known locations. */}
 if(challengedScope.length>512||!/^[\x21\x23-\x5b\x5d-\x7e ]*$/.test(challengedScope))throw new OAuthError('mcp_oauth_scope');
 if(resourceMetadataUrl)publicHttpsUrl(resourceMetadataUrl.href);
 const resourceMetadata=await sdk.discoverOAuthProtectedResourceMetadata(serverUrl,{resourceMetadataUrl},fetcher);
 const issuer=resourceMetadata.authorization_servers?.[0];if(!issuer)throw new OAuthError('mcp_oauth_metadata');
 publicHttpsUrl(issuer);
 const metadata=await sdk.discoverAuthorizationServerMetadata(issuer,{fetchFn:fetcher});
 if(!metadata)throw new OAuthError('mcp_oauth_metadata');
 const state:OAuthDiscoveryState={authorizationServerUrl:issuer,authorizationServerMetadata:metadata,resourceMetadata};
 validateDiscovery(serverUrl,state);
 await sdk.selectResourceURL(serverUrl,{} as OAuthClientProvider,resourceMetadata);
 // scopes_supported lists capabilities, not the minimum access the user requested.
 state.resourceMetadata={...resourceMetadata,scopes_supported:undefined};
 return {state,challengedScope};
}
class Provider implements OAuthClientProvider {
 client?:OAuthClientInformationMixed; value?:OAuthTokens; verifier=''; authorizationUrl?:URL; expiresAt=0;
 constructor(readonly serverUrl:string,readonly redirectUrl:string,readonly nonce:string,readonly scope:string,readonly discovery:OAuthDiscoveryState,record?:OAuthRecord){this.client=record?.client;this.value=record?.tokens;this.expiresAt=record?.expiresAt??0;}
 get clientMetadata():OAuthClientMetadata {return {client_name:'Namo',redirect_uris:[this.redirectUrl],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',...(this.scope?{scope:this.scope}:{})};}
 state(){return this.nonce;}
 discoveryState(){return this.discovery;}
 clientInformation(){return this.client;}
 saveClientInformation(info:OAuthClientInformationMixed){if(!same(info.issuer??'',String(this.discovery.authorizationServerUrl)))throw new OAuthError('mcp_oauth_issuer');this.client=info;}
 tokens(){return this.value;}
 saveTokens(tokens:OAuthTokens){
  const scope=tokens.scope??this.value?.scope;checkScope(this.scope,scope);
  if(!same(tokens.issuer??'',String(this.discovery.authorizationServerUrl)))throw new OAuthError('mcp_oauth_issuer');
  const refresh=tokens.refresh_token??this.value?.refresh_token;
  this.value={...tokens,...(scope?{scope}:{}),...(refresh?{refresh_token:refresh}:{})};
  this.expiresAt=Date.now()+Math.max(0,Math.min(typeof tokens.expires_in==='number'?tokens.expires_in:1800,86400))*1000;
 }
 saveCodeVerifier(value:string){this.verifier=value;}
 codeVerifier(){if(!this.verifier)throw new OAuthError('mcp_oauth_invalid');return this.verifier;}
 redirectToAuthorization(url:URL){
  const expected=new URL(this.discovery.authorizationServerMetadata!.authorization_endpoint);
  if(url.origin!==expected.origin||url.pathname!==expected.pathname||url.searchParams.get('state')!==this.nonce
   ||url.searchParams.get('redirect_uri')!==this.redirectUrl||url.searchParams.get('code_challenge_method')!=='S256')throw new OAuthError('mcp_oauth_invalid');
  publicHttpsUrl(url.href);this.authorizationUrl=url;
 }
 record():OAuthRecord {if(!this.client||!this.value)throw new OAuthError('mcp_oauth_invalid');const value={serverUrl:this.serverUrl,issuer:String(this.discovery.authorizationServerUrl),scope:this.scope,discovery:this.discovery,client:this.client,tokens:this.value,expiresAt:this.expiresAt,redirectUrl:this.redirectUrl};validate(value);return value;}
}
export interface OAuthStart {url:string;state:string;issuer:string;requireIssuer:boolean;finish(code:string):Promise<OAuthRecord>}
export async function beginMcpOAuth(serverUrl:string,redirectUrl:string,scope='',fetcher?:typeof fetch):Promise<OAuthStart> {
 const callback=new URL(redirectUrl);publicHttpsUrl(serverUrl);
 if(callback.protocol!=='http:'||callback.hostname!=='127.0.0.1'||!callback.port||callback.pathname!=='/api/mcp-oauth/callback'||callback.search||callback.hash)throw new OAuthError('mcp_oauth_invalid');
 const state=randomBytes(32).toString('hex');
 try {
  const found=await withFetch(AbortSignal.timeout(30000),f=>discover(serverUrl,f),fetcher),discovery=found.state;
  const effectiveScope=scope||found.challengedScope,provider=new Provider(serverUrl,redirectUrl,state,effectiveScope,discovery);
  const {auth}=await import('@modelcontextprotocol/sdk/client/auth.js');
  const result=await withFetch(AbortSignal.timeout(30000),f=>auth(provider,{serverUrl,scope:effectiveScope||undefined,fetchFn:f}),fetcher);
  if(result!=='REDIRECT'||!provider.authorizationUrl)throw new OAuthError('mcp_oauth_invalid');
  const url=provider.authorizationUrl.href,issuer=String(discovery.authorizationServerUrl);
  return {url,state,issuer,requireIssuer:(discovery.authorizationServerMetadata as Record<string,unknown> | undefined)?.authorization_response_iss_parameter_supported===true,async finish(code:string){
   if(typeof code!=='string'||!code||code.length>4096||/[\x00-\x20\x7f]/.test(code))throw new OAuthError('mcp_oauth_invalid');
   try {const result=await withFetch(AbortSignal.timeout(30000),f=>auth(provider,{serverUrl,authorizationCode:code,scope:effectiveScope||undefined,fetchFn:f}),fetcher);if(result!=='AUTHORIZED')throw new Error();return provider.record();}
   catch {throw new OAuthError('mcp_oauth_failed');}
  }};
 } catch {throw new OAuthError('mcp_oauth_failed');}
}
export function saveMcpOAuth(dataDir:string,record:OAuthRecord):string {
 validate(record);const ref='oauth_'+randomBytes(24).toString('hex');ensureDirectory(dataDir,true);atomicJson(path(dataDir,ref),record,true);return ref;
}
export function discardMcpOAuth(dataDir:string,ref:string):void {const file=path(dataDir,ref);if(existsSync(file))unlinkSync(file);}
export async function resolveMcpCredential(dataDir:string,ref:string,serverUrl:string,signal:AbortSignal,fetcher?:typeof fetch,expectedScope?:string):Promise<{token:string;secrets:string[]}> {
 if(!isOAuthReference(ref))return {token:ref,secrets:[ref]};
 let raw=readRecord(dataDir,ref);
 // Legacy Linear credential files did not include the server URL or discovery data.
 if(!raw.serverUrl){
  if(!same(serverUrl,LEGACY_LINEAR_URL)||raw.client?.issuer!=='https://mcp.linear.app'||raw.tokens?.issuer!=='https://mcp.linear.app'||typeof raw.tokens?.access_token!=='string'||!Number.isSafeInteger(raw.expiresAt))throw new OAuthError('mcp_oauth_invalid');
  checkScope('read',raw.tokens.scope);
  checkExpectedScope(expectedScope,'read');
  if(raw.expiresAt-Date.now()>60000)return {token:raw.tokens.access_token,secrets:[raw.tokens.access_token,raw.tokens.refresh_token??'',raw.client.client_secret??'']};
 }
 let release:(()=>void)|undefined;
 if(!raw.serverUrl||raw.expiresAt-Date.now()<=60000){
  const deadline=Date.now()+10000;while(!release){if(signal.aborted||Date.now()>deadline)throw new OAuthError('mcp_oauth_busy');try{release=acquireLock(join(directory(dataDir),ref+'.lock'));}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
  try {
   raw=readRecord(dataDir,ref);
   if(!raw.serverUrl){if(!same(serverUrl,LEGACY_LINEAR_URL)||raw.client?.issuer!=='https://mcp.linear.app'||raw.tokens?.issuer!=='https://mcp.linear.app')throw new OAuthError('mcp_oauth_invalid');checkScope('read',raw.tokens.scope);const discovery=(await withFetch(signal,f=>discover(serverUrl,f),fetcher)).state;raw={...raw,serverUrl,issuer:String(discovery.authorizationServerUrl),scope:'read',discovery};}
   const record=raw as OAuthRecord;validate(record);if(!same(record.serverUrl,serverUrl))throw new OAuthError('mcp_oauth_target_changed');checkExpectedScope(expectedScope,record.scope);
   if(record.expiresAt-Date.now()<=60000){
    if(!record.tokens.refresh_token)throw new OAuthError('mcp_oauth_expired');
    const provider=new Provider(serverUrl,record.redirectUrl,'',record.scope,record.discovery,record);provider.redirectToAuthorization=()=>{throw new OAuthError('mcp_oauth_expired');};
    try {const {auth}=await import('@modelcontextprotocol/sdk/client/auth.js');const result=await withFetch(signal,f=>auth(provider,{serverUrl,scope:record.scope||undefined,fetchFn:f}),fetcher);if(result!=='AUTHORIZED')throw new Error();raw=provider.record();atomicJson(path(dataDir,ref),raw);}
    catch {throw new OAuthError('mcp_oauth_expired');}
   }
  } finally {release();}
 }
 const record=raw as OAuthRecord;validate(record);if(!same(record.serverUrl,serverUrl))throw new OAuthError('mcp_oauth_target_changed');checkExpectedScope(expectedScope,record.scope);
 return {token:record.tokens.access_token,secrets:[record.tokens.access_token,record.tokens.refresh_token??'',record.client.client_secret??'']};
}
