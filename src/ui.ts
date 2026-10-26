import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Management, ManagementError } from './management.js';
import { RecoveryError } from './recovery.js';
import { uiRoutes } from './ui-contract.js';

const assetRoot = new URL('../ui/', import.meta.url);
// Radix Themes' Table/Select do not forward a nonce to their viewport styles.
// Allow only these two fixed scrollbar rules; dynamic scroll locks use a nonce.
const viewportStyleHashes = [
  'sha256-vGQdhYJbTuF+M8iCn1IZCHpdkiICocWHDq4qnQF4Rjw=',
  'sha256-441zG27rExd4/il+NvIqyL8zFx5XmyNQtE381kSkUJk=',
].map(hash => `'${hash}'`).join(' ');

const equal=(a:string,b:string)=>Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function startUi(manager:Management):Promise<{url:string;entryUrl:string;close:()=>Promise<void>}> {
  try { readFileSync(new URL('index.html',assetRoot)); }
  catch { throw new ManagementError('缺少工作台构建资源。源码开发请运行 pnpm run build；安装包请重新安装'); }
  let bootstrap=randomBytes(32).toString('hex');const bootstrapUntil=Date.now()+300000;
  let session='';let sessionUntil=0,attempts=0,busy=false,origin='',cookieName='';
  async function body(req:IncomingMessage):Promise<any>{
    if(req.headers['content-type']!=='application/json')throw new ManagementError('请求必须使用 JSON');
    let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>65536)throw new ManagementError('请求过大');}
    try{return JSON.parse(data);}catch{throw new ManagementError('请求内容无效');}
  }
  const server=createServer(async(req,res)=>{
    const send=(status:number,value:unknown,type='application/json')=>{res.writeHead(status,{'Content-Type':`${type}; charset=utf-8`});res.end(type==='application/json'?JSON.stringify(value):value as string);};
    const styleNonce=randomBytes(18).toString('base64');
    headers(res,styleNonce);
    if(req.headers.host!==origin.slice('http://'.length)||req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'请求来源无效'});
    let path:string;
    try{path=new URL(req.url??'/',origin).pathname;}catch{return send(400,{error:'请求路径无效'});}
    if(req.method==='GET'&&Object.values(uiRoutes).some(route=>route===path)) {
      try{return send(200,readFileSync(new URL('index.html',assetRoot),'utf8').replace('__NAMO_STYLE_NONCE__',styleNonce),'text/html');}
      catch{return send(503,{error:'工作台正在构建，请稍后刷新'});}
    }
    // Only Vite's public JS/CSS files are served. Never expose arbitrary paths,
    // source maps, configuration, or another directory under dist.
    if(req.method==='GET'&&path.startsWith('/assets/')) {
      if(!/^\/assets\/[A-Za-z0-9_-]+\.(js|css)$/.test(path))return send(404,{error:'资源不存在'});
      try{return send(200,readFileSync(new URL(path.slice(1),assetRoot),'utf8'),path.endsWith('.css')?'text/css':'text/javascript');}
      catch{return send(404,{error:'资源不存在，请刷新页面'});}
    }
    if(req.method==='GET'&&path==='/favicon.ico'){res.writeHead(204);return res.end();}
    if(req.method==='GET'&&path==='/logo.png'){
      try{res.writeHead(200,{'Content-Type':'image/png'});return res.end(readFileSync(new URL('../../assets/namo-logo.png',import.meta.url)));}catch{return res.end();}
    }
    if(req.method!=='GET'&&req.method!=='POST')return send(405,{error:'不支持此操作'});
    if(req.method==='POST'&&req.headers.origin!==origin)return send(403,{error:'请求来源无效'});
    try{
      if(req.method==='POST'&&path==='/api/session'){
        const input=await body(req);attempts++;
        if(attempts>20||Date.now()>bootstrapUntil||!bootstrap||typeof input.code!=='string'||!equal(input.code,bootstrap))return send(401,{error:'本次打开授权已失效，请在终端重新运行 namo ui'});
        bootstrap='';session=randomBytes(32).toString('hex');sessionUntil=Date.now()+7200000;
        res.setHeader('Set-Cookie',`${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200`);return send(200,{ok:true});
      }
      const token=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1)??'';
      if(!session||Date.now()>sessionUntil||!equal(token,session))return send(401,{error:'请从本机终端运行 namo ui 打开已授权页面'});
      if(req.method==='GET'){
        if(path==='/api/state')return send(200,manager.state());
        if(path.startsWith('/api/tasks/'))return send(200,manager.detail(decodeURIComponent(path.slice(11))));
        if(path.startsWith('/api/issues/'))return send(200,manager.issue(decodeURIComponent(path.slice(12))));
        return send(404,{error:'页面不存在'});
      }
      if(busy)return send(409,{error:'上一项操作仍在进行，请稍后再试'});
      busy=true;
      try{
        const input=await body(req);
        if(path==='/api/config')return send(200,manager.save(input.revision,input.patch));
        if(path==='/api/apply')return send(200,await manager.apply(input.revision,input.confirmed===true));
        if(path==='/api/diagnose')return send(200,await manager.diagnose());
        if(path==='/api/profiles')return send(200,manager.saveProfile(input.configRevision,input.userId,input.version,input.patch));
        if(path==='/api/resolve')return send(200,manager.reconcile(input));
        if(path==='/api/cancel')return send(200,manager.cancel(input.id,input.inputVersion,input.requestId));
        return send(404,{error:'操作不存在'});
      } finally{busy=false;}
    }catch(e){return send(e instanceof ManagementError||e instanceof RecoveryError?409:500,{error:e instanceof ManagementError||e instanceof RecoveryError?e.message:'操作未完成，请检查配置与本地服务；没有输出凭据或原始错误'});}
  });
  server.requestTimeout=10000;server.headersTimeout=5000;server.maxHeadersCount=30;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error('ui_listen_failed');
  origin=`http://127.0.0.1:${address.port}`;cookieName=`namo_ui_${address.port}`;
  return {url:origin,entryUrl:`${origin}/#${bootstrap}`,close:async()=>{session='';bootstrap='';server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
function headers(res:ServerResponse,styleNonce:string):void{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}' ${viewportStyleHashes}; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
}
export async function openUi(url:string):Promise<void>{
  if(!['darwin','linux'].includes(process.platform))throw new ManagementError('当前自动打开支持 macOS / Linux；其他平台请使用 CLI');
  await new Promise<void>((resolve,reject)=>{
    const p=spawn(process.platform==='darwin'?'open':'xdg-open',[url],{stdio:'ignore'});
    p.once('error',()=>reject(new ManagementError('无法打开浏览器，请检查本机默认浏览器')));
    p.once('exit',code=>code===0?resolve():reject(new ManagementError('无法打开浏览器，请检查本机默认浏览器')));
  });
}
