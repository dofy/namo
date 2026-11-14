import { createServer } from 'node:http';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { t as tr } from './locale.js';

/** A public, static site; no application config, data or filesystem browsing. */
export async function startDocs(): Promise<{url:string;close:()=>Promise<void>}> {
  const root=resolve(fileURLToPath(new URL('../../docs-site/',import.meta.url)));
  const entries:Record<string,[string,string]>={
    '/':['index.html','text/html; charset=utf-8'], '/index.html':['index.html','text/html; charset=utf-8'],
    '/style.css':['style.css','text/css; charset=utf-8'], '/main.js':['main.js','text/javascript; charset=utf-8'],
    '/content.js':['content.js','text/javascript; charset=utf-8'], '/assets/namo-logo.png':['assets/namo-logo.png','image/png'],
  };
  const files=new Map<string,{data:Buffer;type:string}>();
  try {
    if(realpathSync(root)!==root)throw Error();
    for(const [route,[path,type]] of Object.entries(entries)) {
      const absolute=join(root,path);
      if(realpathSync(absolute)!==absolute)throw Error();
      const fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
      try {if(!fstatSync(fd).isFile())throw Error();files.set(route,{data:readFileSync(fd),type});} finally {closeSync(fd);}
    }
  } catch { throw new Error(tr('docs.assetsMissing')); }
  let origin='';
  const server=createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    if(req.headers.host!==origin.slice('http://'.length) || (req.headers.origin && req.headers.origin!==origin)) {res.writeHead(403).end();return;}
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{Allow:'GET, HEAD'}).end();return;}
    let path:string;try{path=new URL(req.url??'/',origin).pathname;}catch{res.writeHead(400).end();return;}
    const file=files.get(path);if(!file){res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':file.type,'Content-Length':file.data.length});res.end(req.method==='HEAD'?undefined:file.data);
  });
  server.requestTimeout=10000;server.headersTimeout=5000;server.maxHeadersCount=30;
  await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});
  const address=server.address();if(!address||typeof address==='string')throw Error('docs_listen_failed');
  origin=`http://127.0.0.1:${address.port}`;
  return {url:origin,close:async()=>{server.closeAllConnections();await new Promise<void>((accept,reject)=>server.close(e=>e?reject(e):accept()));}};
}
