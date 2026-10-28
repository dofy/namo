import { test } from 'node:test';
import assert from 'node:assert/strict';
import {publicAddress,publicHttpsUrl,publicNetwork} from '../src/mcp-public-network.js';

test('public MCP network rejects local, private, mapped, and reserved addresses',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.1.1','0.0.0.0','::1','fc00::1','fe80::1','::ffff:127.0.0.1','192.0.2.1'])assert.equal(publicAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','2606:4700:4700::1111'])assert.equal(publicAddress(ip),true,ip);
 for(const value of ['http://example.com','https://127.0.0.1','https://[::1]','https://localhost','https://x.local','https://user:pass@example.com','https://example.com/#fragment'])assert.throws(()=>publicHttpsUrl(value),value);
 assert.equal(publicHttpsUrl('https://example.com/mcp').hostname,'example.com');
});


test('DNS is checked at connection time and mixed public/private answers fail closed',async()=>{
 let lookedUp=false;
 const resolver=((_host:unknown,_options:unknown,callback:(error:null,addresses:{address:string;family:number}[])=>void)=>{lookedUp=true;callback(null,[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]);}) as typeof import('node:dns').lookup;
 const network=publicNetwork(resolver);
 try{
  for(const input of ['https://public.example/mcp',new URL('https://public.example/mcp'),new Request('https://public.example/mcp',{method:'POST',body:'{}'})]){
   lookedUp=false;
   await assert.rejects(network.fetcher(input),error=>error instanceof TypeError&&error.cause instanceof Error&&error.cause.message==='mcp_address_denied');
   assert.equal(lookedUp,true);
  }
 }finally{await network.close();}
});
