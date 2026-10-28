import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

/** MCP requests never use ambient proxy settings, private networks, or redirects. */
export function publicAddress(address:string):boolean {
  try { return ipaddr.process(address).range()==='unicast'; } catch { return false; }
}
export function publicHttpsUrl(value:string):URL {
  let url:URL;
  if(/[\s\x00-\x1f\x7f]/.test(value))throw new Error('mcp_invalid_url');
  try { url=new URL(value); } catch { throw new Error('mcp_invalid_url'); }
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||url.hash||!host||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||isIP(host)&&!publicAddress(host))throw new Error('mcp_invalid_url');
  return url;
}
export function publicNetwork(resolver:typeof lookup=lookup):{fetcher:typeof fetch;close:()=>Promise<void>} {
  const agent=new Agent({connect:{lookup(host,options,callback){
    resolver(host,{all:true,verbatim:true},(error,addresses)=>{
      if(error||!addresses.length||addresses.some(item=>!publicAddress(item.address)))return callback(error??Object.assign(new Error('mcp_address_denied'),{code:'ENOTFOUND'}),[]);
      if(options.all)return callback(null,addresses);
      return callback(null,addresses[0]!.address,addresses[0]!.family);
    });
  }}});
  const fetcher:typeof fetch=(input,init)=>{
    publicHttpsUrl(input instanceof Request?input.url:String(input));
    // Node's bundled fetch can use a different dispatcher protocol (notably Node 24).
    // Keep fetch and Agent from the same package; bridge native Request objects explicitly.
    let url=input instanceof URL?input.toString():input;
    let options=init;
    if(input instanceof Request){
      const request=new Request(input,init);
      url=request.url;
      options={method:request.method,headers:[...request.headers],body:request.body,
        signal:request.signal,cache:request.cache,credentials:request.credentials,
        integrity:request.integrity,keepalive:request.keepalive,mode:request.mode,
        referrer:request.referrer,referrerPolicy:request.referrerPolicy};
    }
    // Both expose the Fetch API; their separately declared iterator types differ.
    return undiciFetch(url as string,{...options,duplex:'half',redirect:'error',dispatcher:agent} as UndiciRequestInit) as unknown as Promise<Response>;
  };
  return {fetcher,close:async()=>{await agent.close();}};
}
