import type {McpConnectionPatch} from './ui-contract.js';
import type { Management } from './management.js';
import { beginMcpOAuth, saveMcpOAuth, discardMcpOAuth, oauthFailureCode, type OAuthStart } from './mcp-oauth.js';

interface Pending {revision:string;id:string;createdAt:number;flow:OAuthStart;draft?:McpConnectionPatch;exchanging?:boolean}
/** OAuth state and PKCE verifier exist only in the authenticated local UI process. */
export class McpOAuthFlow {
 private pending=new Map<string,Pending>();
 failure='mcp_oauth_failed';
 constructor(private manager:Management,private origin:()=>string,private beginOAuth:typeof beginMcpOAuth=beginMcpOAuth){}
 clear():void {this.pending.clear();}
 cancel(id:unknown):void {if(typeof id!=='string')return;for(const [key,value] of this.pending)if(value.id===id)this.pending.delete(key);}
 async begin(revision:unknown,id:unknown,draft?:unknown):Promise<{url:string;issuer:string}> {
  if(typeof revision!=='string'||typeof id!=='string')throw new Error('mcp_oauth_invalid');
  const connection=this.manager.prepareMcpOAuth(revision,id,draft);
  const now=Date.now();for(const [key,value] of this.pending)if(now-value.createdAt>600000)this.pending.delete(key);
  if(this.pending.size>=10)throw new Error('mcp_oauth_busy');
  const flow=await this.beginOAuth(connection.url,this.origin()+'/api/mcp-oauth/callback',connection.oauthScope??'');
  if(this.manager.config().revision!==revision)throw new Error('mcp_config_changed');
  this.cancel(id);
  this.pending.set(flow.state,{revision,id,createdAt:now,flow,...(draft!==undefined?{draft:connection}:{})});
  return {url:flow.url,issuer:flow.issuer};
 }
 async finish(query:URLSearchParams):Promise<boolean> {
  this.failure='mcp_oauth_callback_invalid';
  const states=query.getAll('state'),codes=query.getAll('code'),issuers=query.getAll('iss');
  if(states.length!==1||issuers.length>1)return false;
  const pending=this.pending.get(states[0]);if(!pending||pending.exchanging)return false;
  if(pending.flow.requireIssuer&&issuers.length!==1||issuers.length===1&&issuers[0]!==pending.flow.issuer)return false;
  if(query.has('error')){this.pending.delete(states[0]);const code=query.get('error');this.failure=code&&['invalid_scope','access_denied','invalid_client','invalid_request'].includes(code)?'mcp_oauth_'+code:'mcp_oauth_failed';return false;}
  if(codes.length!==1)return false;
  if(Date.now()-pending.createdAt>600000){this.failure='mcp_oauth_expired';return false;}
  if(this.manager.config().revision!==pending.revision){this.failure='mcp_config_changed';return false;}
  pending.exchanging=true;
  let ref:string|undefined;
  try {const record=await pending.flow.finish(codes[0]);if(this.pending.get(states[0])!==pending||Date.now()-pending.createdAt>600000)throw new Error('mcp_oauth_cancelled');ref=saveMcpOAuth(this.manager.dataDir,record);this.manager.saveMcpOAuth(pending.revision,pending.id,ref,pending.draft);return true;}
  catch(error) {this.failure=oauthFailureCode(error);if(ref)discardMcpOAuth(this.manager.dataDir,ref);return false;}
  finally{this.pending.delete(states[0]);}
 }
}
