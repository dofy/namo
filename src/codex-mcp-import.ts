import {mcpEndpointKey,type McpEndpoint} from './mcp-endpoint-contract.js';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

/** Only metadata from the personal Codex user config is exposed to the workbench. */
export interface CodexMcpCandidate {
  id:string; transport:'remote'|'stdio'|'unsupported'; host?:string; importable:boolean;
  requiresOwnAuth:boolean; duplicateOf?:string; reason?:'local_process'|'invalid_url'|'url_parameters'|'unknown_transport'|'duplicate_endpoint'|'duplicate_id';
}
export interface CodexMcpCatalog {revision:string;entries:CodexMcpCandidate[]}
const revisionKey=randomBytes(32);
const identifier=/^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export class CodexMcpImportError extends Error {constructor(readonly code:string){super(code);}}
export function personalCodexConfig(home=homedir()):string {return join(home,'.codex','config.toml');}
function read(path:string):{revision:string;servers:Record<string,unknown>} {
  if(!existsSync(path))return {revision:createHmac('sha256',revisionKey).update('missing').digest('hex'),servers:{}};
  try {
    if(statSync(path).size>1048576)throw new Error();
    const contents=readFileSync(path,'utf8'),parsed=parse(contents);
    if(parsed.mcp_servers!==undefined&&!object(parsed.mcp_servers))throw new Error();
    return {revision:createHmac('sha256',revisionKey).update(contents).digest('hex'),servers:(parsed.mcp_servers??{}) as Record<string,unknown>};
  } catch {throw new CodexMcpImportError('codex_mcp_config_invalid');}
}
function classify(id:string,value:unknown):CodexMcpCandidate {
  if(!object(value))return {id,transport:'unsupported',importable:false,requiresOwnAuth:false,reason:'unknown_transport'};
  const requiresOwnAuth=!!(value.bearer_token_env_var||value.env_http_headers||value.http_headers||value.http_headers_helper||value.oauth||value.auth);
  if(typeof value.url==='string') {
    try {
      const url=new URL(value.url);
      if(/[\s\x00-\x1f\x7f]/.test(value.url)||url.protocol!=='https:'||url.username||url.password||url.hash)return {id,transport:'remote',importable:false,requiresOwnAuth,reason:'invalid_url'};
      if(url.search)return {id,transport:'remote',host:url.host,importable:false,requiresOwnAuth,reason:'url_parameters'};
      return {id,transport:'remote',host:url.host,importable:true,requiresOwnAuth};
    } catch {return {id,transport:'remote',importable:false,requiresOwnAuth,reason:'invalid_url'};}
  }
  if(typeof value.command==='string')return {id,transport:'stdio',importable:false,requiresOwnAuth,reason:'local_process'};
  return {id,transport:'unsupported',importable:false,requiresOwnAuth,reason:'unknown_transport'};
}
export function listCodexMcp(path=personalCodexConfig(),existing:readonly McpEndpoint[]=[]):CodexMcpCatalog {
  const {revision,servers}=read(path),ids=new Map(existing.map(value=>[value.id,value.id])),endpoints=new Map(existing.map(value=>[mcpEndpointKey(value.url),value.id]));
  const entries=Object.entries(servers).filter(([id])=>identifier.test(id)).slice(0,200).map(([id,value])=>classify(id,value)).sort((a,b)=>a.id.localeCompare(b.id));
  for(const entry of entries){
    if(!entry.importable)continue;
    const key=mcpEndpointKey(String((servers[entry.id] as Record<string,unknown>).url)),duplicateId=ids.get(entry.id.toLowerCase()),duplicateEndpoint=endpoints.get(key);
    if(duplicateId||duplicateEndpoint){entry.importable=false;entry.duplicateOf=duplicateId??duplicateEndpoint;entry.reason=duplicateId?'duplicate_id':'duplicate_endpoint';}
    else{ids.set(entry.id.toLowerCase(),entry.id);endpoints.set(key,entry.id);}
  }
  return {revision,entries};
}
/** Re-read and validate on import; never accept a browser-supplied URL or copy auth fields. */
export function selectCodexMcp(id:string,revision:string,path=personalCodexConfig()):{id:string;url:string} {
  if(!identifier.test(id)||typeof revision!=='string')throw new CodexMcpImportError('codex_mcp_selection_invalid');
  const source=read(path);if(source.revision!==revision)throw new CodexMcpImportError('codex_mcp_config_changed');
  const candidate=classify(id,source.servers[id]);if(!candidate.importable)throw new CodexMcpImportError('codex_mcp_selection_unsupported');
  const entry=source.servers[id] as Record<string,unknown>;
  return {id,url:String(entry.url)};
}
