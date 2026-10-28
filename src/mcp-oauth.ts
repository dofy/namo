import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { atomicJson } from './paths.js';
import { acquireLock } from './safety.js';
import { LINEAR_READONLY_URL } from './mcp-connections.js';

const ROOT='https://mcp.linear.app', METADATA=new URL(ROOT+'/.well-known/oauth-protected-resource/mcp/readonly');
const REF=/^oauth_[a-f0-9]{48}$/;
const MAX=262144;
export class OAuthError extends Error { constructor(readonly code:string){super(code);} }
interface OAuthRecord {client:OAuthClientInformationMixed;tokens:OAuthTokens;expiresAt:number;redirectUrl:string}
const directory=(dataDir:string)=>join(dataDir,'mcp-oauth');
const path=(dataDir:string,ref:string)=>{if(!REF.test(ref))throw new OAuthError('mcp_oauth_invalid');return join(directory(dataDir),ref+'.json');};
function ensureDirectory(dataDir:string,create=false):void {
 const dir=directory(dataDir);if(create)mkdirSync(dir,{recursive:true,mode:0o700});
 const info=lstatSync(dir);if(info.isSymbolicLink()||!info.isDirectory()||(info.mode&0o077)!==0)throw new OAuthError('mcp_oauth_invalid');
}
export const isOAuthReference=(v:string)=>REF.test(v);
function validate(record:OAuthRecord):void {
 if(!record||typeof record!=='object'||typeof record.client?.client_id!=='string'||record.client.issuer!==ROOT
   ||typeof record.tokens?.access_token!=='string'||record.tokens.issuer!==ROOT||!Number.isSafeInteger(record.expiresAt)
   ||typeof record.redirectUrl!=='string'||record.tokens.scope!==undefined&&record.tokens.scope.split(/[ ,]+/).filter(Boolean).some(s=>s!=='read'))throw new OAuthError('mcp_oauth_invalid');
}
function load(dataDir:string,ref:string):OAuthRecord {
 const file=path(dataDir,ref);try {ensureDirectory(dataDir);const info=lstatSync(file);if(info.isSymbolicLink()||!info.isFile()||(info.mode&0o077)!==0||statSync(file).size>MAX)throw new Error();const record=JSON.parse(readFileSync(file,'utf8')) as OAuthRecord;validate(record);return record;}
 catch {throw new OAuthError('mcp_oauth_missing');}
}
function scopedFetch(signal:AbortSignal,fetcher:typeof fetch=fetch):typeof fetch {
 return async(input,init)=>{
  const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  if(target.origin!==ROOT||target.username||target.password)throw new OAuthError('mcp_oauth_origin');
  const response=await fetcher(input,{...init,redirect:'error',signal});
  if(!response.body)return response;
  let bytes=0;const stream=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){bytes+=chunk.byteLength;if(bytes>MAX)throw new OAuthError('mcp_oauth_response_too_large');controller.enqueue(chunk);}}));
  return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
 };
}
class Provider implements OAuthClientProvider {
 client?:OAuthClientInformationMixed; value?:OAuthTokens; verifier=''; authorizationUrl?:URL; expiresAt=0;
 constructor(readonly redirectUrl:string,readonly nonce:string,record?:OAuthRecord){this.client=record?.client;this.value=record?.tokens;this.expiresAt=record?.expiresAt??0;}
 get clientMetadata():OAuthClientMetadata {return {client_name:'Namo',redirect_uris:[this.redirectUrl],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',scope:'read'};}
 state(){return this.nonce;}
 clientInformation(){return this.client;}
 saveClientInformation(info:OAuthClientInformationMixed){this.client=info;}
 tokens(){return this.value;}
 saveTokens(tokens:OAuthTokens){
  const scope=tokens.scope??this.value?.scope;
  if(scope!==undefined&&scope.split(/[ ,]+/).filter(Boolean).some(s=>s!=='read'))throw new OAuthError('mcp_oauth_scope');
  this.value={...tokens,...(scope?{scope}:{}),issuer:tokens.issuer??ROOT};
  this.expiresAt=Date.now()+Math.max(0,Math.min(typeof tokens.expires_in==='number'?tokens.expires_in:1800,86400))*1000;
 }
 saveCodeVerifier(value:string){this.verifier=value;}
 codeVerifier(){if(!this.verifier)throw new OAuthError('mcp_oauth_invalid');return this.verifier;}
 redirectToAuthorization(url:URL){
  if(url.origin!==ROOT||url.pathname!=='/authorize'||url.searchParams.get('scope')!=='read'||url.searchParams.get('state')!==this.nonce
   ||url.searchParams.get('redirect_uri')!==this.redirectUrl||url.searchParams.get('code_challenge_method')!=='S256')throw new OAuthError('mcp_oauth_invalid');
  this.authorizationUrl=url;
 }
 record():OAuthRecord {if(!this.client||!this.value)throw new OAuthError('mcp_oauth_invalid');const value={client:this.client,tokens:this.value,expiresAt:this.expiresAt,redirectUrl:this.redirectUrl};validate(value);return value;}
}
export interface OAuthStart { url:string; state:string; finish(code:string):Promise<OAuthRecord> }
export async function beginLinearOAuth(redirectUrl:string,fetcher:typeof fetch=fetch):Promise<OAuthStart> {
 const callback=new URL(redirectUrl);
 if(callback.protocol!=='http:'||callback.hostname!=='127.0.0.1'||!callback.port||callback.pathname!=='/api/mcp-oauth/callback'||callback.search||callback.hash)throw new OAuthError('mcp_oauth_invalid');
 const state=randomBytes(32).toString('hex'),provider=new Provider(redirectUrl,state),signal=AbortSignal.timeout(30000);
 try {
  const {auth}=await import('@modelcontextprotocol/sdk/client/auth.js');
  const result=await auth(provider,{serverUrl:LINEAR_READONLY_URL,scope:'read',resourceMetadataUrl:METADATA,fetchFn:scopedFetch(signal,fetcher)});
  if(result!=='REDIRECT'||!provider.authorizationUrl)throw new OAuthError('mcp_oauth_invalid');
  const url=provider.authorizationUrl.href;
  return {url,state,async finish(code:string){
   if(typeof code!=='string'||!code||code.length>4096||/[\x00-\x20\x7f]/.test(code))throw new OAuthError('mcp_oauth_invalid');
   try {const result=await auth(provider,{serverUrl:LINEAR_READONLY_URL,authorizationCode:code,scope:'read',resourceMetadataUrl:METADATA,fetchFn:scopedFetch(AbortSignal.timeout(30000),fetcher)});if(result!=='AUTHORIZED')throw new OAuthError('mcp_oauth_invalid');return provider.record();}
   catch {throw new OAuthError('mcp_oauth_failed');}
  }};
 } catch {throw new OAuthError('mcp_oauth_failed');}
}
export function saveLinearOAuth(dataDir:string,record:OAuthRecord):string {
 validate(record);const ref='oauth_'+randomBytes(24).toString('hex');ensureDirectory(dataDir,true);atomicJson(path(dataDir,ref),record,true);return ref;
}
export function discardLinearOAuth(dataDir:string,ref:string):void {const file=path(dataDir,ref);if(existsSync(file))unlinkSync(file);}
export async function resolveLinearCredential(dataDir:string,ref:string,signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<{token:string;secrets:string[]}> {
 if(!isOAuthReference(ref))return {token:ref,secrets:[ref]};
 let record=load(dataDir,ref);
 if(record.expiresAt-Date.now()<=60000) {
  let release:(()=>void)|undefined;const deadline=Date.now()+10000;
  while(!release) {if(signal.aborted||Date.now()>deadline)throw new OAuthError('mcp_oauth_busy');try{release=acquireLock(join(directory(dataDir),ref+'.lock'));}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
  try {
   record=load(dataDir,ref);
   if(record.expiresAt-Date.now()<=60000){
    if(!record.tokens.refresh_token)throw new OAuthError('mcp_oauth_expired');
    const provider=new Provider(record.redirectUrl,'',record);provider.redirectToAuthorization=()=>{throw new OAuthError('mcp_oauth_expired');};
    try {const {auth}=await import('@modelcontextprotocol/sdk/client/auth.js');const result=await auth(provider,{serverUrl:LINEAR_READONLY_URL,scope:'read',resourceMetadataUrl:METADATA,fetchFn:scopedFetch(AbortSignal.any([signal,AbortSignal.timeout(30000)]),fetcher)});if(result!=='AUTHORIZED')throw new Error();record=provider.record();atomicJson(path(dataDir,ref),record);}
    catch {throw new OAuthError('mcp_oauth_expired');}
   }
  } finally {release();}
 }
 return {token:record.tokens.access_token,secrets:[record.tokens.access_token,record.tokens.refresh_token??'',record.client.client_secret??'']};
}
