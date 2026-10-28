import type { Management } from './management.js';
import { beginLinearOAuth, saveLinearOAuth, discardLinearOAuth, type OAuthStart } from './mcp-oauth.js';

interface Pending {revision:string;id:string;createdAt:number;flow:OAuthStart}
/** OAuth state and PKCE verifier exist only in the authenticated local UI process. */
export class LinearOAuthFlow {
 private pending=new Map<string,Pending>();
 constructor(private manager:Management,private origin:()=>string,private beginOAuth:typeof beginLinearOAuth=beginLinearOAuth){}
 clear():void {this.pending.clear();}
 async begin(revision:unknown,id:unknown):Promise<{url:string}> {
  if(typeof revision!=='string'||typeof id!=='string')throw new Error('mcp_oauth_invalid');
  const config=this.manager.config();
  if(config.revision!==revision||!config.mcpConnections.some((c:{id:string;type:string})=>c.id===id&&c.type==='linear'))throw new Error('mcp_config_changed');
  const now=Date.now();for(const [key,value] of this.pending)if(now-value.createdAt>600000)this.pending.delete(key);
  if(this.pending.size>=10)throw new Error('mcp_oauth_busy');
  const flow=await this.beginOAuth(this.origin()+'/api/mcp-oauth/callback');
  if(this.manager.config().revision!==revision)throw new Error('mcp_config_changed');
  this.pending.set(flow.state,{revision,id,createdAt:now,flow});
  return {url:flow.url};
 }
 async finish(query:URLSearchParams):Promise<boolean> {
  const states=query.getAll('state'),codes=query.getAll('code'),issuers=query.getAll('iss');
  if(states.length!==1||codes.length!==1||issuers.length!==1||issuers[0]!=='https://mcp.linear.app')return false;
  const pending=this.pending.get(states[0]);if(!pending)return false;
  this.pending.delete(states[0]);
  if(Date.now()-pending.createdAt>600000||this.manager.config().revision!==pending.revision)return false;
  let ref:string|undefined;
  try {const record=await pending.flow.finish(codes[0]);ref=saveLinearOAuth(this.manager.dataDir,record);this.manager.saveMcpOAuth(pending.revision,pending.id,ref);return true;}
  catch {if(ref)discardLinearOAuth(this.manager.dataDir,ref);return false;}
 }
}
