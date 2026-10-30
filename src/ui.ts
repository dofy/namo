import { currentLocale, t as tr, withLocale } from './locale.js';
import { parseLocale } from './i18n.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Management, ManagementError } from './management.js';
import { RecoveryError } from './recovery.js';
import { uiRoutes } from './ui-contract.js';
import { McpOAuthFlow } from './mcp-oauth-flow.js';
import { BrowseError } from './browse.js';
import { THEME_COOKIE, parseThemePreference } from './theme-contract.js';

const assetRoot = new URL('../ui/', import.meta.url);
// Radix Themes' Table/Select do not forward a nonce to their viewport styles.
// Allow only these two fixed scrollbar rules; dynamic scroll locks use a nonce.
const viewportStyleHashes = [
  'sha256-vGQdhYJbTuF+M8iCn1IZCHpdkiICocWHDq4qnQF4Rjw=',
  'sha256-441zG27rExd4/il+NvIqyL8zFx5XmyNQtE381kSkUJk=',
].map(hash => `'${hash}'`).join(' ');

const equal=(a:string,b:string)=>Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
/** All displayed strings come from the bundled locale catalog, never callback input. */
function oauthResultPage(state:'preparing'|'success'|'failed',reason:string,nonce:string,theme:'auto'|'light'|'dark'):string {
  const preparing=state==='preparing',ok=state==='success';
  const title=tr(preparing?'mcp.opening':ok?'mcp.resultSuccessTitle':'mcp.resultFailureTitle');
  const body=preparing?tr('mcp.openingHelp'):ok?tr('mcp.resultSuccess'):reason;
  return `<!doctype html><html lang="${currentLocale()}" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Namo</title>
<style nonce="${nonce}">
:root{--canvas:#f6f8fa;--surface:#fff;--border:#dce3e9;--text:#22252a;--muted:#526270;--soft:#e6ebef;--status-bg:${ok?'#e3f4ec':'#fff0e5'};--status-text:${ok?'#258356':'#ae550d'}}
html[data-theme="dark"]{color-scheme:dark;--canvas:#11171c;--surface:#1b232a;--border:#394751;--text:#eef1f3;--muted:#aebac3;--soft:#303b44;--status-bg:${ok?'#1c3a2d':'#49321f'};--status-text:${ok?'#84d0af':'#ffb36b'}}
@media(prefers-color-scheme:dark){html[data-theme="auto"]{color-scheme:dark;--canvas:#11171c;--surface:#1b232a;--border:#394751;--text:#eef1f3;--muted:#aebac3;--soft:#303b44;--status-bg:${ok?'#1c3a2d':'#49321f'};--status-text:${ok?'#84d0af':'#ffb36b'}}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--canvas);color:var(--text);font:15px/1.65 system-ui,-apple-system,"PingFang SC",sans-serif;display:grid;place-items:center;padding:24px}
main{width:min(100%,520px)}.brand{display:flex;align-items:center;gap:12px;margin-bottom:24px;color:var(--muted);font-size:13px}.brand img{width:40px;height:44px;object-fit:contain}.brand strong{display:block;color:var(--text);font-size:18px;line-height:1.2}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:32px;box-shadow:0 12px 40px #202c3810}.icon{display:grid;place-items:center;width:44px;height:44px;border-radius:12px;font-size:24px;font-weight:700;background:var(--status-bg);color:var(--status-text)}.spinner{width:20px;height:20px;border:2px solid #f5c695;border-top-color:var(--status-text);border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}}h1{font-size:23px;line-height:1.3;margin:20px 0 10px}p{margin:0;color:var(--muted);overflow-wrap:anywhere}.foot{margin-top:24px;padding-top:20px;border-top:1px solid var(--soft);font-size:13px;color:var(--muted)}@media(max-width:480px){.panel{padding:24px}}
</style></head><body><main><div class="brand"><img src="/logo.png" alt=""><div><strong>Namo</strong>MCP</div></div><section class="panel"${preparing?' role="status"':''}><div class="icon" aria-hidden="true">${preparing?'<span class="spinner"></span>':ok?'✓':'!'}</div><h1>${title}</h1><p>${body}</p>${preparing?'':`<p class="foot">${tr('mcp.resultFootnote')}</p>`}</section></main></body></html>`;
}
export async function startUi(manager:Management):Promise<{url:string;entryUrl:string;close:()=>Promise<void>}> {
  try { readFileSync(new URL('index.html',assetRoot)); }
  catch { throw new ManagementError(tr("ui.workbenchAssetsMissingSourceDevelopmentRunPnpm")); }
  let bootstrap=randomBytes(32).toString('hex');const bootstrapUntil=Date.now()+300000;
  let session='';let sessionUntil=0,attempts=0,busy=false,origin='',cookieName='';
  const oauth=new McpOAuthFlow(manager,()=>origin);
  async function body(req:IncomingMessage):Promise<any>{
    if(req.headers['content-type']!=='application/json')throw new ManagementError(tr("ui.requestMustUseJson"));
    let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>65536)throw new ManagementError(tr("ui.requestTooLarge"));}
    try{return JSON.parse(data);}catch{throw new ManagementError(tr("common.invalidRequestBody"));}
  }
  const server=createServer((req,res)=>withLocale(parseLocale(req.headers['accept-language']?.split(',')[0]?.split(';')[0]) ?? 'en', async()=>{
    const send=(status:number,value:unknown,type='application/json')=>{res.writeHead(status,{'Content-Type':`${type}; charset=utf-8`});res.end(type==='application/json'?JSON.stringify(value):value as string);};
    const styleNonce=randomBytes(18).toString('base64');
    headers(res,styleNonce);
    if(req.headers.host!==origin.slice('http://'.length))return send(403,{error:tr("ui.invalidRequestOrigin")});
    let path:string;
    try{path=new URL(req.url??'/',origin).pathname;}catch{return send(400,{error:tr("ui.invalidRequestPath")});}
    const themeCookie=(req.headers.cookie??'').split(';').map(part=>part.trim()).find(part=>part.startsWith(`${THEME_COOKIE}=`))?.slice(THEME_COOKIE.length+1);
    const theme=parseThemePreference(themeCookie);
    if(req.method==='GET'&&path==='/api/mcp-oauth/callback'){
      let ok=false;try{ok=await oauth.finish(new URL(req.url??'/',origin).searchParams);}catch{/* Invalid or expired callback; never expose raw OAuth errors. */}
      res.writeHead(303,{'Location':ok?'/oauth-complete?status=success':'/oauth-complete?status=failed&reason='+encodeURIComponent(oauth.failure)});return res.end();
    }
    if(req.method==='GET'&&path==='/oauth-preparing') {
      const locale=parseLocale(new URL(req.url??'/',origin).searchParams.get('lang')??undefined)??currentLocale();
      return withLocale(locale,()=>send(200,oauthResultPage('preparing','',styleNonce,theme),'text/html'));
    }
    if(req.method==='GET'&&path==='/oauth-complete'){
      const parameters=new URL(req.url??'/',origin).searchParams;
      const ok=parameters.get('status')==='success';
      const reasons:Record<string,string>={mcp_oauth_invalid_scope:tr('mcp.resultInvalidScope'),mcp_oauth_access_denied:tr('mcp.resultDenied'),mcp_oauth_invalid_grant:tr('mcp.resultInvalidGrant'),mcp_oauth_scope:tr('mcp.resultScopeMismatch'),mcp_oauth_callback_invalid:tr('mcp.resultInvalidCallback'),mcp_oauth_invalid_client:tr('mcp.resultInvalidClient'),mcp_config_changed:tr('mcp.resultConfigChanged'),mcp_oauth_expired:tr('mcp.resultExpired')};
      const key=parameters.get('reason')??'';
      const reason=Object.hasOwn(reasons,key)?reasons[key]:tr('mcp.resultDefaultError');
      return send(200,oauthResultPage(ok?'success':'failed',reason,styleNonce,theme),'text/html');
    }
    if(req.headers['sec-fetch-site']==='cross-site')return send(403,{error:tr("ui.invalidRequestOrigin")});
    if(req.method==='GET'&&Object.values(uiRoutes).some(route=>route===path)) {
      try{return send(200,readFileSync(new URL('index.html',assetRoot),'utf8').replace('__NAMO_STYLE_NONCE__',styleNonce).replace('<html lang="en">',`<html lang="en" data-theme="${theme}">`),'text/html');}
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
        if(path==='/api/codex-mcp')return send(200,manager.codexMcpCatalog());
        if(path==='/api/models')return send(200,await manager.models());
        if(path==='/api/codex-update')return send(200,await manager.codexUpdate());
        if(path==='/api/tasks')return send(200,manager.browse('tasks',new URL(req.url!,origin).searchParams));
        if(path==='/api/schedules')return send(200,manager.browse('schedules',new URL(req.url!,origin).searchParams));
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
        if(path==='/api/mcp-oauth-start'){try{return send(200,await oauth.begin(input.revision,input.id,input.draft));}catch(error){const code=error instanceof Error&&/^mcp_[a-z_]+$/.test(error.message)?error.message:'mcp_oauth_failed';return send(400,{error:code});}}
        if(path==='/api/mcp-oauth-cancel'){oauth.cancel(input.id);return send(200,{ok:true});}
        if(path==='/api/codex-mcp-import')return send(200,manager.importCodexMcp(input.revision,input.sourceRevision,input.ids));
        if(path==='/api/mcp-oauth-scopes')return send(200,await manager.mcpOAuthScopes(input.revision,input.url));
        if(path==='/api/mcp-test')return send(200,await manager.testMcp(input.revision,input.id));
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
  return {url:origin,entryUrl:`${origin}/#${bootstrap}`,close:async()=>{session='';bootstrap='';oauth.clear();server.closeAllConnections();await manager.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
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
