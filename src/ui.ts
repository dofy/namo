import { t as tr, withLocale } from './locale.js';
import { parseLocale } from './i18n.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Management, ManagementError } from './management.js';
import { RecoveryError } from './recovery.js';
import { uiRoutes } from './ui-contract.js';
import { BrowseError } from './browse.js';

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
  catch { throw new ManagementError(tr("ui.workbenchAssetsMissingSourceDevelopmentRunPnpm")); }
  let bootstrap=randomBytes(32).toString('hex');const bootstrapUntil=Date.now()+300000;
  let session='';let sessionUntil=0,attempts=0,busy=false,origin='',cookieName='';
  async function body(req:IncomingMessage):Promise<any>{
    if(req.headers['content-type']!=='application/json')throw new ManagementError(tr("ui.requestMustUseJson"));
    let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>65536)throw new ManagementError(tr("ui.requestTooLarge"));}
    try{return JSON.parse(data);}catch{throw new ManagementError(tr("common.invalidRequestBody"));}
  }
  const server=createServer((req,res)=>withLocale(parseLocale(req.headers['accept-language']?.split(',')[0]?.split(';')[0]) ?? 'en', async()=>{
    const send=(status:number,value:unknown,type='application/json')=>{res.writeHead(status,{'Content-Type':`${type}; charset=utf-8`});res.end(type==='application/json'?JSON.stringify(value):value as string);};
    const styleNonce=randomBytes(18).toString('base64');
    headers(res,styleNonce);
    if(req.headers.host!==origin.slice('http://'.length)||req.headers['sec-fetch-site']==='cross-site')return send(403,{error:tr("ui.invalidRequestOrigin")});
    let path:string;
    try{path=new URL(req.url??'/',origin).pathname;}catch{return send(400,{error:tr("ui.invalidRequestPath")});}
    if(req.method==='GET'&&Object.values(uiRoutes).some(route=>route===path)) {
      try{return send(200,readFileSync(new URL('index.html',assetRoot),'utf8').replace('__NAMO_STYLE_NONCE__',styleNonce),'text/html');}
      catch{return send(503,{error:tr("ui.workbenchBuildingRefreshShortly")});}
    }
    // Only Vite's public JS/CSS/font files are served. Never expose arbitrary paths,
    // source maps, configuration, or another directory under dist.
    if(req.method==='GET'&&path.startsWith('/assets/')) {
      if(!/^\/assets\/[A-Za-z0-9_-]+\.(js|css|woff2)$/.test(path))return send(404,{error:tr("ui.resourceNotFound")});
      if(path.endsWith('.woff2')) {
        try{const font=readFileSync(new URL(path.slice(1),assetRoot));res.writeHead(200,{'Content-Type':'font/woff2'});return res.end(font);}
        catch{return send(404,{error:tr("ui.resourceNotFoundRefreshPage")});}
      }
      try{return send(200,readFileSync(new URL(path.slice(1),assetRoot),'utf8'),path.endsWith('.css')?'text/css':'text/javascript');}
      catch{return send(404,{error:tr("ui.resourceNotFoundRefreshPage")});}
    }
    if(req.method==='GET'&&path==='/favicon.ico'){res.writeHead(302,{'Location':'/favicon.png'});return res.end();}
    if(req.method==='GET'&&(path==='/logo.png'||path==='/favicon.png')){
      try{res.writeHead(200,{'Content-Type':'image/png'});return res.end(readFileSync(new URL('../../assets/namo-logo.png',import.meta.url)));}catch{return res.end();}
    }
    if(req.method!=='GET'&&req.method!=='POST')return send(405,{error:tr("ui.operationNotSupported")});
    if(req.method==='POST'&&req.headers.origin!==origin)return send(403,{error:tr("ui.invalidRequestOrigin")});
    try{
      if(req.method==='POST'&&path==='/api/session'){
        const input=await body(req);attempts++;
        if(attempts>20||Date.now()>bootstrapUntil||!bootstrap||typeof input.code!=='string'||!equal(input.code,bootstrap))return send(401,{error:tr("ui.launchAuthorizationExpiredRunNamoUiAgain")});
        bootstrap='';session=randomBytes(32).toString('hex');sessionUntil=Date.now()+7200000;
        res.setHeader('Set-Cookie',`${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200`);return send(200,{ok:true});
      }
      const token=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1)??'';
      if(!session||Date.now()>sessionUntil||!equal(token,session))return send(401,{error:tr("ui.runNamoUiLocalTerminalOpenAuthorized")});
      if(req.method==='GET'){
        if(path==='/api/logs')return send(200,manager.logs());
        if(path==='/api/approvals')return send(200,manager.approvals());
        if(path==='/api/state')return send(200,manager.state());
        if(path==='/api/models')return send(200,await manager.models());
        if(path==='/api/codex-update')return send(200,await manager.codexUpdate());
        if(path==='/api/tasks')return send(200,manager.browse('tasks',new URL(req.url!,origin).searchParams));
        if(path==='/api/sessions')return send(200,manager.browse('sessions',new URL(req.url!,origin).searchParams));
        if(path==='/api/dashboard')return send(200,manager.browse('dashboard'));
        if(path==='/api/browse-options')return send(200,manager.browse('options'));
        if(path==='/api/memories')return send(200,manager.memories(new URL(req.url!,origin).searchParams.get('ownerId')??undefined));
        if(path.startsWith('/api/tasks/'))return send(200,manager.detail(decodeURIComponent(path.slice(11))));
        if(path.startsWith('/api/issues/'))return send(200,manager.issue(decodeURIComponent(path.slice(12))));
        return send(404,{error:tr("ui.pageNotFound")});
      }
      if(busy)return send(409,{error:tr("ui.previousActionStillRunningTryAgainShortly")});
      busy=true;
      try{
        const input=await body(req);
        if(path==='/api/assistant')return send(200,manager.assistant(input.action,input.version,input.values));
        if(path==='/api/memories')return send(200,manager.memory(input.action,input.ownerId,input.input));
        if(path==='/api/organization')return send(200,await manager.organization());
        if(path==='/api/config')return send(200,await manager.saveGitHub(input.revision,input.patch));
        if(path==='/api/apply')return send(200,await manager.apply(input.revision,input.confirmed===true));
        if(path==='/api/diagnose')return send(200,await manager.diagnose(input.live===true,input.confirmed===true));
        if(path==='/api/migration-inspect')return send(200,manager.inspectMigration(input));
        if(path==='/api/approvals')return send(200,await manager.approval(input));
        if(path==='/api/profiles')return send(200,manager.saveProfile(input.configRevision,input.userId,input.version,input.patch));
        if(path==='/api/user-model')return send(200,{model:manager.saveUserModel(input.configRevision,input.userId,input.expected,input.model)});
        if(path==='/api/codex-update')return send(200,await manager.codexUpdate(input));
        if(path==='/api/resolve')return send(200,manager.reconcile(input));
        if(path==='/api/cancel')return send(200,manager.cancel(input.id,input.inputVersion,input.requestId));
        return send(404,{error:tr("common.actionNotFound")});
      } finally{busy=false;}
    }catch(e){return send(e instanceof BrowseError?400:e instanceof ManagementError?e.status:e instanceof RecoveryError?409:500,{error:e instanceof BrowseError||e instanceof ManagementError||e instanceof RecoveryError?e.message:tr("ui.actionIncompleteCheckConfigurationLocalServiceCredentials")});}
  }));
  server.requestTimeout=10000;server.headersTimeout=5000;server.maxHeadersCount=30;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error('ui_listen_failed');
  origin=`http://127.0.0.1:${address.port}`;cookieName=`namo_ui_${address.port}`;
  return {url:origin,entryUrl:`${origin}/#${bootstrap}`,close:async()=>{session='';bootstrap='';server.closeAllConnections();await manager.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
function headers(res:ServerResponse,styleNonce:string):void{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}' ${viewportStyleHashes}; font-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
}
export async function openUi(url:string):Promise<void>{
  if(!['darwin','linux'].includes(process.platform))throw new ManagementError(tr("ui.automaticBrowserOpeningSupportsMacosLinuxUse"));
  await new Promise<void>((resolve,reject)=>{
    const p=spawn(process.platform==='darwin'?'open':'xdg-open',[url],{stdio:'ignore'});
    p.once('error',()=>reject(new ManagementError(tr("ui.couldNotOpenBrowserCheckLocalDefault"))));
    p.once('exit',code=>code===0?resolve():reject(new ManagementError(tr("ui.couldNotOpenBrowserCheckLocalDefault"))));
  });
}
