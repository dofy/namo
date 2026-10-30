import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, chmodSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Incoming } from '../src/store.js';
import { Management, ManagementError } from '../src/management.js';
import { startUi } from '../src/ui.js';
import { digest, atomicJson } from '../src/paths.js';
import { Tasks, policyHash } from '../src/tasks.js';
import { request as httpRequest } from 'node:http';
import { Profiles } from '../src/profiles.js';
import { execFileSync } from 'node:child_process';
import { initialConfig } from '../src/onboarding.js';
import { loadConfig } from '../src/config.js';
import { serviceLogs } from '../src/management-operations.js';

function fixture(t:any,deps:any={}){
 const dir=mkdtempSync(join(tmpdir(),'namo-ui-')),data=join(dir,'data'),project=join(dir,'project'),file=join(dir,'config.json');mkdirSync(data);mkdirSync(project);
 const raw={version:1,agent:'codex',dataDir:data,custom:{keep:'untouched'},feishu:{appId:'cli_test',appSecret:'PRIVATE_TEST_SECRET_7381',allowedUserIds:['alice'],allowedChatIds:[],extraSecret:'PRIVATE_EXTRA_991'},codex:{bin:'codex',home:join(data,'auth'),projects:{app:project},defaultProject:'app',sandbox:'workspace-write',networkAccess:false,allowLocalCommits:true,denyPaths:[],readPaths:[],timeoutMs:600000},concurrency:1};
 writeFileSync(file,JSON.stringify(raw));const s=new Store(join(data,'bot.sqlite'));s.close();const manager=new Management(file,{status:()=>({running:false,installed:true,registered:false,mode:'stopped'}),diagnose:async()=>[{id:'test',status:'ok',message:'isolated diagnostic'}],...deps});
 t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,data,project,file,raw,manager};
}

test('model defaults are confirmed only for the matching running configuration', t=>{
 let running=true;
 const f=fixture(t,{status:()=>({running,pid:process.pid})});
 const write=(model:string,agents?:unknown)=>writeFileSync(f.file,JSON.stringify({...f.raw,codex:{...f.raw.codex,model},...(agents?{agents}:{})}));
 const apply=()=>writeFileSync(join(f.data,'health.json'),JSON.stringify({pid:process.pid,configRevision:digest(readFileSync(f.file,'utf8'))}));
 write('service-model');apply();
 assert.deepEqual(f.manager.config().activeModelDefault,{model:'service-model',profile:'codex'});
 write('pending-model');
 assert.equal(f.manager.config().application,'pending');
 assert.equal(f.manager.config().activeModelDefault,undefined);
 apply();assert.equal(f.manager.config().activeModelDefault.model,'pending-model');
 write('');apply();assert.deepEqual(f.manager.config().activeModelDefault,{model:'',profile:'codex'});
 write('base-model',{defaultProfile:'special',profiles:{special:{adapter:'codex',model:'profile-model'}}});apply();
 assert.deepEqual(f.manager.config().activeModelDefault,{model:'profile-model',profile:'special'});
 writeFileSync(join(f.data,'health.json'),JSON.stringify({pid:process.pid+1,configRevision:digest(readFileSync(f.file,'utf8'))}));
 assert.equal(f.manager.config().application,'unknown');assert.equal(f.manager.config().activeModelDefault,undefined);
 apply();running=false;assert.equal(f.manager.config().application,'stopped');assert.equal(f.manager.config().activeModelDefault,undefined);
});

test('local GitHub connection probes before saving, binds one paired owner and never accepts browser-supplied executable paths',async t=>{
 const local={executable:'/usr/bin/gh',configDir:'/tmp/gh-fixture',login:'owner',userId:42};let probes=0;
 const f=fixture(t,{localGh:async()=>{probes++;return local;}}),initial=f.manager.config();
 const patch={github:{source:'gh',repositories:[],allowedUserIds:['alice']}};
 assert.throws(()=>f.manager.save(initial.revision,patch),/GitHub 配置无效/);
 await assert.rejects(f.manager.saveGitHub(initial.revision,{github:{...patch.github,allowedUserIds:['alice','bob']}}));assert.equal(probes,0);
 const saved=await f.manager.saveGitHub(initial.revision,patch);assert.equal(saved.github.localGh.login,'owner');
 const raw=JSON.parse(readFileSync(f.file,'utf8'));assert.deepEqual(raw.github,{...patch.github,localGh:local});assert.equal(raw.github.token,undefined);
 assert.equal(raw.custom.keep,'untouched');assert.doesNotMatch(JSON.stringify(saved.github),/executable|configDir/);
 await assert.rejects(f.manager.saveGitHub(initial.revision,patch));assert.equal(probes,1);
 assert.throws(()=>f.manager.save(saved.revision,{github:{...patch.github,localGh:local}}));
 const disabled=f.manager.save(saved.revision,{github:{source:'anonymous',repositories:[],allowedUserIds:[]}});
 assert.equal(disabled.github.credentialConfigured,false);assert.equal(JSON.parse(readFileSync(f.file,'utf8')).github.localGh,undefined);
});

test('failed local GitHub discovery and concurrent edits preserve configuration',async t=>{
 const f=fixture(t,{localGh:async()=>{throw Error('raw secret-bearing child error');}}),before=readFileSync(f.file,'utf8');
 const patch={github:{source:'gh',repositories:[],allowedUserIds:['alice']}};
 await assert.rejects(f.manager.saveGitHub(f.manager.config().revision,patch),e=>{assert.doesNotMatch(String(e),/raw secret/);return true;});
 assert.equal(readFileSync(f.file,'utf8'),before);
 const race=fixture(t,{localGh:async()=>{race.manager.save(race.manager.config().revision,{model:'concurrent-edit'});return {executable:'/usr/bin/gh',configDir:'/tmp/gh-fixture',login:'owner',userId:42};}});
 await assert.rejects(race.manager.saveGitHub(race.manager.config().revision,patch),/配置已被/);
 assert.equal(race.manager.config().values.model,'concurrent-edit');assert.equal(race.manager.config().github.credentialConfigured,false);
});
test('HTTP localizes application errors per request while preserving user task text', async t => {
 const f=fixture(t),ui=await startUi(f.manager);t.after(()=>ui.close());
 const login=await fetch(ui.url+'/api/session',{method:'POST',headers:{Origin:ui.url,'Content-Type':'application/json'},body:JSON.stringify({code:new URL(ui.entryUrl).hash.slice(1)})});
 const cookie=login.headers.get('set-cookie')!;
 const s=new Store(join(f.data,'bot.sqlite'));s.enqueue({key:'locale-task',messageId:'locale-task',chatKey:'chat',chatId:'chat',senderId:'alice',text:'保留我的原文 {0} English'});const task=new Tasks(s).create(s.get('locale-task')!,{cwd:f.project,policyHash:'p'});s.close();
 for(const language of ['en','zh-CN']){
  const headers={Cookie:cookie,'Accept-Language':language};
  const invalid=await fetch(ui.url+'/api/tasks?pageSize=17',{headers});assert.equal(invalid.status,400);
  const error=(await invalid.json()) as {error:string};assert.match(error.error,language==='en'?/Page size/:/每页/);
  const detail=await (await fetch(ui.url+'/api/tasks/'+task.id,{headers})).json() as {title:string};assert.equal(detail.title,'保留我的原文 {0} English');
 }
});
test('configuration projection excludes credentials and preserves unknown fields on save',t=>{const f=fixture(t),before=f.manager.config();assert.doesNotMatch(JSON.stringify(f.manager.state()),/PRIVATE_TEST_SECRET|PRIVATE_EXTRA/);const saved=f.manager.save(before.revision,{model:'test-model'});const raw=JSON.parse(readFileSync(f.file,'utf8'));assert.equal(raw.custom.keep,'untouched');assert.equal(raw.feishu.extraSecret,f.raw.feishu.extraSecret);assert.equal(raw.feishu.appSecret,f.raw.feishu.appSecret);assert.equal(saved.values.model,'test-model');assert.equal(readdirSync(join(f.data,'config-backups')).length,1);assert.throws(()=>f.manager.save(before.revision,{model:'stale'}),/配置已被/);});
test('user model saves are scoped to paired users and reject stale edits',t=>{
 const f=fixture(t),rev=f.manager.config().revision;
 assert.equal(f.manager.saveUserModel(rev,'alice','','model-one'),'model-one');
 assert.equal(f.manager.profiles().entries.find(p=>p.userId==='alice')?.defaultModel,'model-one');
 assert.throws(()=>f.manager.saveUserModel(rev,'alice','','model-two'),/变化/);
 assert.throws(()=>f.manager.saveUserModel(rev,'stranger','','model-two'));
 assert.throws(()=>f.manager.saveUserModel(rev,'alice','model-one','../invalid'));
 assert.equal(f.manager.saveUserModel(rev,'alice','model-one',''),'');
});
test('user model HTTP endpoint requires the local session and origin',async t=>{
 const f=fixture(t),ui=await startUi(f.manager);t.after(()=>ui.close());
 const revision=f.manager.config().revision, body=JSON.stringify({configRevision:revision,userId:'alice',expected:'',model:'model-one'});
 const post=(cookie='',origin=ui.url)=>fetch(ui.url+'/api/user-model',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(cookie?{Cookie:cookie}:{})},body});
 assert.equal((await post()).status,401);
 const login=await fetch(ui.url+'/api/session',{method:'POST',headers:{Origin:ui.url,'Content-Type':'application/json'},body:JSON.stringify({code:new URL(ui.entryUrl).hash.slice(1)})});
 const cookie=login.headers.get('set-cookie')!;
 assert.equal((await post(cookie,'https://attacker.invalid')).status,403);
 assert.equal((await post(cookie)).status,200);
 assert.equal((await post(cookie)).status,409);
});
test('invalid configuration and unapproved fields cannot overwrite saved configuration',t=>{const f=fixture(t),before=readFileSync(f.file,'utf8'),revision=f.manager.config().revision;assert.throws(()=>f.manager.save(revision,{projects:{app:'/missing-namo-project'}}),/校验/);assert.throws(()=>f.manager.save(revision,{dataDir:'/tmp'}),/不允许/);assert.throws(()=>f.manager.save(revision,{sandbox:'danger-full-access'}),/校验/);assert.equal(readFileSync(f.file,'utf8'),before);});
test('UI can repair an invalid project path without changing identity or data directory',t=>{const f=fixture(t);writeFileSync(f.file,JSON.stringify({...f.raw,codex:{...f.raw.codex,projects:{app:'/not-a-project'}}}));assert.equal(f.manager.config().valid,false);f.manager.save(f.manager.config().revision,{projects:{app:f.project}});assert.equal(f.manager.config().valid,true);assert.equal(JSON.parse(readFileSync(f.file,'utf8')).feishu.appId,f.raw.feishu.appId);});
test('reading old schema does not migrate it and management writes fail closed',t=>{const f=fixture(t),s=new Store(join(f.data,'bot.sqlite'));s.db.exec('DROP TABLE reconciliations; DROP TABLE card_actions; PRAGMA user_version=1');s.close();const before=readFileSync(join(f.data,'bot.sqlite'));const state=f.manager.state();assert.equal(state.database.schema,1);assert.equal(state.recoveryAvailable,false);for(const read of [()=>f.manager.approvals(),()=>f.manager.detail('N-AAAAAAAAAAAA'),()=>f.manager.browse('tasks'),()=>f.manager.memories()])assert.throws(read,/数据库版本不兼容/);assert.throws(()=>f.manager.cancel('N-AAAAAAAAAAAA',1,'id'),/数据库版本不兼容/);assert.deepEqual(readFileSync(join(f.data,'bot.sqlite')),before);});
test('apply requires confirmation, known running version, current revision and an idle queue',async t=>{
 let actions=0;const f=fixture(t,{status:()=>({running:true,installed:true,registered:true,mode:'background',pid:process.pid}),action:async()=>{actions++;return {};},wait:async()=>true});const rev=f.manager.config().revision;
 await assert.rejects(()=>f.manager.apply(rev,false),/明确确认/);await assert.rejects(()=>f.manager.apply(rev,true),/在线版本/);
 writeFileSync(join(f.data,'health.json'),JSON.stringify({pid:process.pid,managementVersion:2,configRevision:rev}));await assert.rejects(()=>f.manager.apply('stale',true),/配置已变化/);
 const s=new Store(join(f.data,'bot.sqlite'));s.enqueue({key:'busy',messageId:'busy',chatKey:'chat',chatId:'chat',senderId:'alice',text:'task'});await assert.rejects(()=>f.manager.apply(rev,true),/在途/);assert.equal(actions,0);assert.equal(s.db.prepare("SELECT 1 FROM settings WHERE key='maintenance'").get(),undefined);s.close();
});
test('idle apply pauses scheduling and releases maintenance on successful restart',async t=>{
 let actions=0;const f=fixture(t,{status:()=>({running:true,installed:true,registered:true,mode:'background',pid:process.pid}),action:async()=>{actions++;const s=new Store(join(f.data,'bot.sqlite'));assert.ok(s.db.prepare("SELECT 1 FROM settings WHERE key='maintenance'").get());s.close();return {};},wait:async()=>true});const rev=f.manager.config().revision;writeFileSync(join(f.data,'health.json'),JSON.stringify({pid:process.pid,managementVersion:2,configRevision:rev}));assert.equal((await f.manager.apply(rev,true)).ready,true);assert.equal(actions,1);const s=new Store(join(f.data,'bot.sqlite'));assert.equal(s.db.prepare("SELECT 1 FROM settings WHERE key='maintenance'").get(),undefined);s.close();
});
test('local cancel is conditional and idempotent, preserving one cancellation result',t=>{const f=fixture(t),s=new Store(join(f.data,'bot.sqlite'));s.enqueue({key:'task',messageId:'task',chatKey:'chat',chatId:'chat',senderId:'alice',text:'task'});const task=new Tasks(s).create(s.get('task')!,{cwd:f.project,policyHash:'p'});assert.throws(()=>f.manager.cancel(task.id,2,'stale'),/已变化/);f.manager.cancel(task.id,1,'first');assert.deepEqual(f.manager.cancel(task.id,1,'first'),{duplicate:true});assert.equal(new Tasks(s).get(task.id)?.state,'cancelled');assert.equal(s.db.prepare("SELECT COUNT(*) n FROM outbox WHERE kind='result'").get()?.n,1);s.close();});
test('HTTP UI requires one-time bootstrap, cookie and exact origin; credentials never reach state',async t=>{
 const f=fixture(t),ui=await startUi(f.manager);t.after(()=>ui.close());const origin=ui.url,code=ui.entryUrl.split('#')[1];const post=(path:string,body:any,cookie='',source=origin)=>fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:source,...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
 const malformed=await new Promise<number|undefined>((resolve,reject)=>{const request=httpRequest(origin,{path:'http://[',headers:{Host:new URL(origin).host}},response=>{response.resume();response.once('end',()=>resolve(response.statusCode));});request.once('error',reject);request.end();});assert.equal(malformed,400);
 assert.equal((await fetch(origin+'/api/state')).status,401);const html=await fetch(origin);assert.match(html.headers.get('content-security-policy')??'',/frame-ancestors 'none'/);assert.doesNotMatch(await html.text(),/PRIVATE_TEST_SECRET/);
 assert.equal((await post('/api/session',{code},'','https://attacker.invalid')).status,403);const login=await post('/api/session',{code});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!;assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.equal((await post('/api/session',{code})).status,401);
 const state=await fetch(origin+'/api/state',{headers:{Cookie:cookie}});const text=await state.text();assert.equal(state.status,200);assert.doesNotMatch(text,/PRIVATE_TEST_SECRET|PRIVATE_EXTRA/);const revision=JSON.parse(text).config.revision;
 assert.equal((await post('/api/config',{revision,patch:{model:'attack'}},cookie,'https://attacker.invalid')).status,403);assert.equal(digest(readFileSync(f.file,'utf8')),revision);
 const saved=await post('/api/config',{revision,patch:{model:'safe'}},cookie);assert.equal(saved.status,200);assert.equal(JSON.parse(readFileSync(f.file,'utf8')).codex.model,'safe');
 assert.equal((await fetch(origin+'/api/state',{headers:{Cookie:cookie,'Sec-Fetch-Site':'cross-site'}})).status,403);
 const diagnostic=await post('/api/diagnose',{},cookie);assert.equal(diagnostic.status,200);assert.match(await diagnostic.text(),/isolated diagnostic/);
});

test('failed service application clears maintenance and releases the edit lock',async t=>{
 const f=fixture(t,{status:()=>({running:true,installed:true,registered:true,mode:'background',pid:process.pid}),action:async()=>{throw Error('service failed');},wait:async()=>false});
 const rev=f.manager.config().revision;writeFileSync(join(f.data,'health.json'),JSON.stringify({pid:process.pid,managementVersion:2,configRevision:rev}));await assert.rejects(()=>f.manager.apply(rev,true),/service failed/);
 const s=new Store(join(f.data,'bot.sqlite'));assert.equal(s.db.prepare("SELECT 1 FROM settings WHERE key='maintenance'").get(),undefined);s.close();assert.equal(f.manager.save(rev,{model:'still-editable'}).values.model,'still-editable');
});

test('UI serves bundled assets with strict CSP and never exposes source files or private paths',async t=>{
 const f=fixture(t),ui=await startUi(f.manager);t.after(()=>ui.close());
 const response=await fetch(ui.url),html=await response.text(),csp=response.headers.get('content-security-policy')!;
 const nonce=html.match(/name="namo-style-nonce" content="([A-Za-z0-9+/=]+)"/)?.[1];assert.ok(nonce);assert.ok(csp.includes(`'nonce-${nonce}'`));assert.doesNotMatch(csp,/unsafe-inline|unsafe-eval/);
 assert.doesNotMatch(html,/__NAMO_STYLE_NONCE__|PRIVATE_TEST_SECRET|PRIVATE_EXTRA/);assert.match(html,/type="module"/);
 const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(m=>m[1]);assert.equal(assets.length,4);
 assert.match(csp,/font-src 'self'/);assert.match(html,/rel="icon" type="image\/png" href="\/favicon.png"/);
 for(const path of assets){const asset=await fetch(ui.url+path);assert.equal(asset.status,200);
  if(path.endsWith('.woff2')){assert.equal(asset.headers.get('content-type'),'font/woff2');assert.equal(Buffer.from(await asset.arrayBuffer()).subarray(0,4).toString(),'wOF2');}
  else{assert.match(asset.headers.get('content-type')!,path.endsWith('.css')?/text\/css/:/text\/javascript/);assert.ok((await asset.text()).length>100);}}
 const favicon=await fetch(ui.url+'/favicon.png');assert.equal(favicon.status,200);assert.equal(favicon.headers.get('content-type'),'image/png');assert.deepEqual([...new Uint8Array(await favicon.arrayBuffer()).subarray(0,8)],[137,80,78,71,13,10,26,10]);
 const fallback=await fetch(ui.url+'/favicon.ico',{redirect:'manual'});assert.equal(fallback.status,302);assert.equal(fallback.headers.get('location'),'/favicon.png');
 for(const path of ['/assets/config.local.json','/assets/index.js.map','/assets/%2e%2e%2fconfig.local.json','/assets/missing.js','/assets/missing.woff2'])assert.equal((await fetch(ui.url+path)).status,404);
 assert.equal((await fetch(ui.url+'/src/management.ts')).status,401);assert.equal((await fetch(ui.url+'/api/state')).status,401);
 for(const path of ['/tasks','/sessions','/settings','/profiles','/connections','/changelog']){
  const page=await fetch(ui.url+path),content=await page.text();assert.equal(page.status,200);assert.match(page.headers.get('content-type')!,/text\/html/);
  const pageNonce=content.match(/name="namo-style-nonce" content="([A-Za-z0-9+/=]+)"/)?.[1];assert.ok(pageNonce);assert.ok(page.headers.get('content-security-policy')!.includes(`'nonce-${pageNonce}'`));
  assert.match(content,/type="module"/);assert.doesNotMatch(content,/__NAMO_STYLE_NONCE__|PRIVATE_TEST_SECRET|PRIVATE_EXTRA/);
 }
 const login=await fetch(ui.url+'/api/session',{method:'POST',headers:{Origin:ui.url,'Content-Type':'application/json'},body:JSON.stringify({code:new URL(ui.entryUrl).hash.slice(1)})}),cookie=login.headers.get('set-cookie')!;
 for(const path of ['/settings/missing','/missing','/api/missing','/src/management.ts'])assert.equal((await fetch(ui.url+path,{headers:{Cookie:cookie}})).status,404);
 const second=await (await fetch(ui.url)).text();assert.ok(!second.includes(nonce));
});

test('profile management uses configured identity and cannot change pairing, permissions or config',t=>{
 const f=fixture(t),before=readFileSync(f.file,'utf8'),state=f.manager.profiles();
 assert.equal(state.available,true);assert.equal(state.entries[0].userId,'alice');assert.equal(state.entries[0].version,0);
 const saved=f.manager.saveProfile(state.configRevision,'alice',0,{name:'小七',language:'zh-cn',timezone:'UTC'});
 assert.equal(saved.language,'zh-CN');assert.equal(saved.changes[0].source,'local-owner');
 assert.equal(readFileSync(f.file,'utf8'),before);
 assert.throws(()=>f.manager.saveProfile(state.configRevision,'unknown',0,{name:'x'}),/已配对/);
 assert.throws(()=>f.manager.saveProfile(state.configRevision,'alice',1,{allowedUserIds:['attacker']}),/只能修改/);
 assert.throws(()=>f.manager.saveProfile(state.configRevision,'alice',1,{name:f.raw.feishu.appSecret}),/凭据/);
 assert.throws(()=>f.manager.saveProfile(state.configRevision,'alice',0,{name:'stale'}),/已被修改/);
 assert.equal(f.manager.profiles().entries[0].name,'小七');
 f.manager.save(f.manager.config().revision,{model:'changed'});
 assert.throws(()=>f.manager.saveProfile(state.configRevision,'alice',1,{name:'wrong-config'}),/应用配置已变化/);
});

test('profile UI reads old schemas without migrating and refuses data from another app',t=>{
 const f=fixture(t),s=new Store(join(f.data,'bot.sqlite'));s.bindAccount('another-app');s.close();
 assert.equal(f.manager.profiles().available,false);assert.deepEqual(f.manager.profiles().entries,[]);
 assert.throws(()=>f.manager.saveProfile(f.manager.config().revision,'alice',0,{name:'x'}),/不匹配/);
 const old=new Store(join(f.data,'bot.sqlite'));old.db.exec('DROP TABLE user_profiles; DROP TABLE profile_changes; PRAGMA user_version=2');old.close();
 const before=readFileSync(join(f.data,'bot.sqlite'));assert.equal(f.manager.profiles().available,false);
 assert.throws(()=>f.manager.saveProfile(f.manager.config().revision,'alice',0,{name:'x'}),/数据库版本不兼容/);
 assert.deepEqual(readFileSync(join(f.data,'bot.sqlite')),before);
});

test('profile endpoint retains authentication, origin and conflict guards',async t=>{
 const f=fixture(t),ui=await startUi(f.manager);t.after(()=>ui.close());const rev=f.manager.config().revision;
 const post=(path:string,input:unknown,cookie='',origin=ui.url)=>fetch(ui.url+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(input)});
 const patch={configRevision:rev,userId:'alice',version:0,patch:{name:'小七'}};
 assert.equal((await post('/api/profiles',patch)).status,401);
 const login=await post('/api/session',{code:new URL(ui.entryUrl).hash.slice(1)}),cookie=login.headers.get('set-cookie')!;
 assert.equal((await post('/api/profiles',patch,cookie,'https://attacker.invalid')).status,403);
 assert.equal((await post('/api/profiles',patch,cookie)).status,200);
 assert.equal((await post('/api/profiles',{...patch,patch:{name:'stale'}},cookie)).status,409);
 assert.equal(f.manager.profiles().entries[0].name,'小七');
});

const githubCredential = 'management-fixture-private-token-52941';
const githubScope = {repositories:['octo-org/private-app'],allowedUserIds:['alice']};

test('GitHub credential saves preserve empty values, scope and unrelated settings; clearing is explicit',t=>{
 const f=fixture(t),initial=f.manager.config();
 assert.equal(initial.github.credentialConfigured,false);
 const saved=f.manager.save(initial.revision,{github:githubScope,newGithubToken:githubCredential});
 assert.deepEqual(saved.github,{...githubScope,credentialConfigured:true,credentialSource:'token'});
 assert.equal(JSON.parse(readFileSync(f.file,'utf8')).github.token,githubCredential);
 assert.equal(JSON.parse(readFileSync(f.file,'utf8')).custom.keep,'untouched');
 assert.equal(JSON.parse(readFileSync(f.file,'utf8')).feishu.appSecret,f.raw.feishu.appSecret);
 assert.equal(JSON.stringify(saved).includes(githubCredential),false);
 const unchanged=f.manager.save(saved.revision,{github:githubScope,newGithubToken:'',model:'new-model'});
 assert.equal(JSON.parse(readFileSync(f.file,'utf8')).github.token,githubCredential);
 assert.equal(unchanged.github.credentialConfigured,true);
 const beforeConflict=readFileSync(f.file,'utf8');
 assert.throws(()=>f.manager.save(initial.revision,{newGithubToken:'stale-fixture-token'}),error=>error instanceof ManagementError&&error.status===409);
 assert.equal(readFileSync(f.file,'utf8'),beforeConflict);
 const cleared=f.manager.save(unchanged.revision,{newGithubToken:'',clearGithubToken:true});
 assert.deepEqual(cleared.github,{...githubScope,credentialConfigured:false,credentialSource:'none'});
 const raw=JSON.parse(readFileSync(f.file,'utf8'));
 assert.equal(Object.hasOwn(raw.github,'token'),false);assert.equal(Object.hasOwn(raw.github,'tokenEnv'),false);
 assert.deepEqual(raw.github.repositories,githubScope.repositories);assert.deepEqual(raw.github.allowedUserIds,['alice']);
});

test('GitHub environment credentials can be retained, replaced or cleared without exposing the resolved value',t=>{
 const envName='NAMO_GITHUB_MANAGEMENT_TEST',previous=process.env[envName],envCredential='environment-fixture-token-88425';
 process.env[envName]=envCredential;
 t.after(()=>{if(previous===undefined)delete process.env[envName];else process.env[envName]=previous;});
 const f=fixture(t);writeFileSync(f.file,JSON.stringify({...f.raw,github:{...githubScope,tokenEnv:envName}}));
 const initial=f.manager.config();
 assert.deepEqual(initial.github,{...githubScope,credentialConfigured:true,credentialSource:'environment',tokenEnv:envName});
 assert.equal(JSON.stringify(f.manager.state()).includes(envCredential),false);
 const retained=f.manager.save(initial.revision,{newGithubToken:''});
 assert.equal(retained.github.credentialSource,'environment');
 assert.equal(JSON.parse(readFileSync(f.file,'utf8')).github.tokenEnv,envName);
 const replaced=f.manager.save(retained.revision,{newGithubToken:githubCredential});
 const raw=JSON.parse(readFileSync(f.file,'utf8'));
 assert.equal(raw.github.token,githubCredential);assert.equal(Object.hasOwn(raw.github,'tokenEnv'),false);
 assert.equal(replaced.github.credentialSource,'token');assert.equal(JSON.stringify(replaced).includes(githubCredential),false);
 writeFileSync(f.file,JSON.stringify({...raw,github:{...githubScope,tokenEnv:envName}}));
 const cleared=f.manager.save(f.manager.config().revision,{clearGithubToken:true});
 assert.equal(cleared.github.credentialConfigured,false);assert.equal(cleared.github.credentialSource,'none');
 assert.equal(Object.hasOwn(JSON.parse(readFileSync(f.file,'utf8')).github,'tokenEnv'),false);
 assert.equal(process.env[envName],envCredential,'clearing configuration never mutates the environment');
});

test('GitHub configuration HTTP saves reject stale revisions and unpaired users without echoing credentials',async t=>{
 const f=fixture(t),ui=await startUi(f.manager);t.after(()=>ui.close());
 const post=(path:string,body:unknown,cookie='')=>fetch(ui.url+path,{method:'POST',headers:{Origin:ui.url,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
 const login=await post('/api/session',{code:new URL(ui.entryUrl).hash.slice(1)}),cookie=login.headers.get('set-cookie')!;
 const revision=f.manager.config().revision;
 const saved=await post('/api/config',{revision,patch:{github:githubScope,newGithubToken:githubCredential}},cookie);
 assert.equal(saved.status,200);assert.equal((await saved.text()).includes(githubCredential),false);
 const before=readFileSync(f.file,'utf8'),current=f.manager.config().revision;
 const stale=await post('/api/config',{revision,patch:{clearGithubToken:true}},cookie);
 assert.equal(stale.status,409);assert.equal((await stale.text()).includes(githubCredential),false);
 for(const patch of [
  {github:{...githubScope,allowedUserIds:['unpaired-user']},newGithubToken:githubCredential},
  {github:{...githubScope,token:githubCredential}},
  {newGithubToken:githubCredential+'\ninvalid'},
  {newGithubToken:githubCredential,clearGithubToken:true},
 ]){
  const rejected=await post('/api/config',{revision:current,patch},cookie);
  assert.ok(rejected.status>=400&&rejected.status<500);
  assert.equal((await rejected.text()).includes(githubCredential),false);
  assert.equal(readFileSync(f.file,'utf8'),before);
 }
 const state=await fetch(ui.url+'/api/state',{headers:{Cookie:cookie}});
 assert.equal(state.status,200);assert.equal((await state.text()).includes(githubCredential),false);
});

test('configured GitHub credentials are redacted from historical task errors, diagnostics and profiles',async t=>{
 const f=fixture(t,{diagnose:async()=>[{id:'fixture',status:'fail',message:`failure ${githubCredential}`,next:githubCredential}]});
 f.manager.save(f.manager.config().revision,{github:githubScope,newGithubToken:githubCredential});
 const s=new Store(join(f.data,'bot.sqlite'));
 s.enqueue({key:'github-history',messageId:'github-history',chatKey:'chat',chatId:'chat',senderId:'alice',text:`Check ${githubCredential}`});
 const task=new Tasks(s).create(s.get('github-history')!,{cwd:f.project,policyHash:'p'});
 s.db.prepare("UPDATE tasks SET state='failed',error=? WHERE id=?").run(githubCredential,task.id);
 s.db.prepare("UPDATE inbox SET state='delivery_unknown',error=? WHERE key='github-history'").run(githubCredential);
 s.addOutput('github-history','result',`private result ${githubCredential}`);
 s.db.prepare("UPDATE outbox SET state='unknown',error=? WHERE inboxKey='github-history'").run(githubCredential);
 new Profiles(s,{channel:'feishu',appId:f.raw.feishu.appId,userId:'alice'}).update(0,{name:githubCredential},{source:'local-owner'});
 s.close();
 const outputs=[f.manager.state(),f.manager.detail(task.id),f.manager.profiles(),await f.manager.diagnose()];
 for(const output of outputs)assert.equal(JSON.stringify(output).includes(githubCredential),false);
 assert.throws(()=>f.manager.saveProfile(f.manager.config().revision,'alice',1,{name:githubCredential}),error=>{
  assert.ok(error instanceof ManagementError);assert.match(error.message,/凭据/);assert.equal(error.message.includes(githubCredential),false);return true;
 });
});

const git = existsSync('/usr/bin/git') ? '/usr/bin/git' : realpathSync(execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim());
function command(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string { return execFileSync(git, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim(); }

test('workbench approvals retain exact targets, confirmation, stale-state rejection and one-time execution', async t => {
  const root = mkdtempSync(join(tmpdir(), 'namo-approval-ui-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const testEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', NAMO_LANG: 'en' };
  // The HTTP server runs in-process; isolate real Git from personal filters/helpers.
  const testGit = join(root, 'git-isolated');
  writeFileSync(testGit, '#!/bin/sh\nexec /usr/bin/env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null ' + JSON.stringify(git) + ' \"$@\"\n'); chmodSync(testGit, 0o700);
  const repo = join(root, 'repo'), bare = join(root, 'remote.git'); mkdirSync(repo);
  command(root, ['init', '--bare', bare], testEnv); command(repo, ['init'], testEnv); command(repo, ['config', 'user.name', 'Test'], testEnv); command(repo, ['config', 'user.email', 'test@example.invalid'], testEnv);
  writeFileSync(join(repo, 'file.txt'), 'ui\n'); command(repo, ['add', '.'], testEnv); command(repo, ['commit', '-m', 'ui commit'], testEnv); command(repo, ['remote', 'add', 'origin', bare], testEnv);
  const file = join(root, 'config.json'), raw = initialConfig(file); raw.feishu.appId = 'cli_test'; raw.feishu.appSecret = 'test-only'; raw.feishu.allowedUserIds = ['ou_owner'];
  raw.codex.projects = { app: realpathSync(repo) }; raw.codex.defaultProject = 'app'; raw.gitApprovals = { gitBin: testGit, maxTtlMs: 900000, remotes: [{ name: 'origin', url: bare, transport: 'local-test' }] }; atomicJson(file, raw);
  const store = new Store(join(raw.dataDir, 'bot.sqlite')); const message: Incoming = { key: 'instruction', messageId: 'm1', chatKey: 'chat', chatId: 'chat', senderId: 'ou_owner', text: 'work' };
  store.enqueue(message); const task = new Tasks(store).create(store.get(message.key)!, { project: 'app', cwd: realpathSync(repo), policyHash: policyHash(loadConfig(file).codex) }); store.db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(task.id); store.close();
  const manager=new Management(file,{status:()=>({running:false,mode:'stopped'})});
  const ui=await startUi(manager);t.after(()=>ui.close());
  const headers={Origin:ui.url,'Content-Type':'application/json','Accept-Language':'en'};
  assert.equal((await fetch(ui.url+'/api/approvals')).status,401);
  const login=await fetch(ui.url+'/api/session',{method:'POST',headers,body:JSON.stringify({code:new URL(ui.entryUrl).hash.slice(1)})});
  const cookie=login.headers.get('set-cookie')!;
  const get=async()=>await (await fetch(ui.url+'/api/approvals',{headers:{Cookie:cookie}})).json() as any;
  const post=(input:object,origin=ui.url)=>fetch(ui.url+'/api/approvals',{method:'POST',headers:{...headers,Origin:origin,Cookie:cookie},body:JSON.stringify(input)});
  const view=await get();assert.equal(view.configured,true);assert.deepEqual(view.remotes,['origin']);assert.deepEqual(view.items,[]);
  const request={action:'request',taskId:task.id,remote:'origin',ref:'refs/heads/main',configRevision:view.configRevision,confirmed:true};
  const response=await post(request);assert.equal(response.status,200,await response.clone().text());const preview=await response.json() as any;
  assert.equal(preview.taskId,task.id);assert.equal(preview.remote,'origin');assert.equal('url' in preview,false);
  assert.equal(preview.headSha,command(repo,['rev-parse','HEAD'],testEnv));
  const action=(name:string,record:any,confirmed:unknown=true)=>({action:name,id:record.id,revision:record.revision,configRevision:manager.config().revision,confirmed});
  assert.equal((await post(action('approve',preview,false))).status,400);
  assert.equal((await post(action('approve',preview,'true'))).status,400);
  assert.equal((await post({...action('approve',preview),revision:999})).status,409);
  assert.equal((await post(action('approve',preview),'https://attacker.invalid')).status,403);
  const approvedResponse=await post(action('approve',preview));assert.equal(approvedResponse.status,200);const approved=await approvedResponse.json() as any;
  assert.equal(approved.state,'approved');
  assert.equal((await post(action('execute',approved,false))).status,400);
  const executed=await post(action('execute',approved));assert.equal(executed.status,200,await executed.clone().text());assert.equal((await executed.json() as any).state,'succeeded');
  assert.equal(command(bare,['rev-parse','refs/heads/main'],testEnv),command(repo,['rev-parse','HEAD'],testEnv));
  assert.equal((await post(action('execute',approved))).status,409);
  const before=readFileSync(join(raw.dataDir,'bot.sqlite'));
  assert.equal((await get()).items[0].state,'succeeded');
  assert.deepEqual(readFileSync(join(raw.dataDir,'bot.sqlite')),before,'queries do not mutate approval records');
  raw.codex.sandbox='workspace-write';atomicJson(file,raw);
  const changed=await post({...request,configRevision:manager.config().revision});assert.equal(changed.status,409);
  assert.match(await changed.text(),/permissions changed/i);
  assert.equal((await post(request)).status,409,'configuration revisions remain binding');
});

test('logs are bounded, redacted and never follow symlinks', t => {
  const root=mkdtempSync(join(tmpdir(),'namo-logs-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const redact=(text:string)=>text.replaceAll('TEST_SECRET','[redacted]');
  assert.equal(serviceLogs(root,redact)[0].status,'missing');
  writeFileSync(join(root,'service.log'),'old\n'.repeat(30000)+'TEST_SECRET\nlatest\n');
  const secret=join(root,'private');writeFileSync(secret,'DO_NOT_READ');symlinkSync(secret,join(root,'service.error.log'));
  const logs=serviceLogs(root,redact);
  assert.equal(logs[0].truncated,true);assert.equal(logs[0].text.split('\n').length,80);assert.match(logs[0].text,/\[redacted\]\nlatest$/);
  assert.equal(logs[1].status,'unavailable');assert.doesNotMatch(JSON.stringify(logs),/TEST_SECRET|DO_NOT_READ/);
});

test('workbench logs, source inspection and optional inference share local authorization', async t => {
  const root=mkdtempSync(join(tmpdir(),'namo-operations-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=join(root,'config.json'),raw=initialConfig(file);raw.feishu.appId='operations';raw.feishu.appSecret='FAKE_RUNTIME_SECRET';atomicJson(file,raw);mkdirSync(raw.dataDir,{recursive:true});
  writeFileSync(join(raw.dataDir,'service.log'),'FAKE_RUNTIME_SECRET logged');
  const source=join(root,'openclaw.json');writeFileSync(source,JSON.stringify({meta:{lastTouchedVersion:'2026.10.6'},channels:{feishu:{appId:'fixture_1234',appSecret:'FAKE_SOURCE_SECRET'}}}));
  const modes:boolean[]=[];
  const manager=new Management(file,{status:()=>({running:false}),diagnose:async(_file,live)=>{modes.push(!!live);return [{id:'test',status:'ok',message:'fixture'}];}});
  const ui=await startUi(manager);t.after(()=>ui.close());
  assert.equal((await fetch(ui.url+'/api/logs')).status,401);
  const headers={Origin:ui.url,'Content-Type':'application/json'};
  const login=await fetch(ui.url+'/api/session',{method:'POST',headers,body:JSON.stringify({code:new URL(ui.entryUrl).hash.slice(1)})});
  const cookie=login.headers.get('set-cookie')!;
  const post=(path:string,input:object,origin=ui.url)=>fetch(ui.url+path,{method:'POST',headers:{...headers,Cookie:cookie,Origin:origin},body:JSON.stringify(input)});
  const logs=await fetch(ui.url+'/api/logs?path='+encodeURIComponent(source),{headers:{Cookie:cookie}});
  assert.equal(logs.status,200);assert.doesNotMatch(await logs.text(),/FAKE_RUNTIME_SECRET|FAKE_SOURCE_SECRET/);
  assert.equal((await post('/api/diagnose',{live:true})).status,400);assert.deepEqual(modes,[]);
  assert.equal((await post('/api/diagnose',{})).status,200);
  assert.equal((await post('/api/diagnose',{live:true,confirmed:true})).status,200);assert.deepEqual(modes,[false,true]);
  const before=readFileSync(file,'utf8');
  assert.equal((await post('/api/migration-inspect',{sourceFile:source,sourceInstanceId:'fixture'},'https://attacker.invalid')).status,403);
  const inspected=await post('/api/migration-inspect',{sourceFile:source,sourceInstanceId:'fixture'});
  assert.equal(inspected.status,200);const text=await inspected.text();assert.doesNotMatch(text,/FAKE_SOURCE_SECRET|fixture_1234/);assert.equal(JSON.parse(text).applications.length,1);
  assert.equal(readFileSync(file,'utf8'),before);assert.equal((await post('/api/migration-inspect',{sourceFile:'relative',sourceInstanceId:'fixture'})).status,400);
});

test('CLI update controls require local authentication, exact origin, and current configuration',async t=>{
 const f=fixture(t),fake=join(f.dir,'fake-codex');
 writeFileSync(fake,'#!/bin/sh\nprintf "codex-cli 0.154.0\\n"\n',{mode:0o700});
 writeFileSync(f.file,JSON.stringify({...f.raw,codex:{...f.raw.codex,bin:fake}}));
 const ui=await startUi(f.manager);t.after(()=>ui.close());
 const revision=f.manager.config().revision;
 const post=(body:any,cookie='',origin=ui.url)=>fetch(ui.url+'/api/codex-update',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
 assert.equal((await fetch(ui.url+'/api/codex-update')).status,401);
 assert.equal((await post({action:'automatic',enabled:true,configRevision:revision})).status,401);
 const login=await fetch(ui.url+'/api/session',{method:'POST',headers:{Origin:ui.url,'Content-Type':'application/json'},body:JSON.stringify({code:new URL(ui.entryUrl).hash.slice(1)})});
 const cookie=login.headers.get('set-cookie')!;
 assert.equal((await post({action:'automatic',enabled:true,configRevision:revision},cookie,'https://attacker.invalid')).status,403);
 assert.equal((await post({action:'automatic',enabled:true,configRevision:'stale'},cookie)).status,409);
 const enabled=await post({action:'automatic',enabled:true,configRevision:revision},cookie);
 assert.equal(enabled.status,200);assert.equal((await enabled.json() as any).automatic,true);
 const status=await fetch(ui.url+'/api/codex-update',{headers:{Cookie:cookie}}),value=await status.json() as any;
 assert.equal(value.currentVersion,'0.154.0');assert.equal(value.managed,false);
 assert.doesNotMatch(JSON.stringify(value),/PRIVATE_TEST_SECRET|PRIVATE_EXTRA|fake-codex/);
 assert.equal((await post({action:'automatic',enabled:'yes',configRevision:revision},cookie)).status,409);
 assert.equal((await post({action:'exec',configRevision:revision},cookie)).status,409);
 assert.equal((await post({action:'automatic',enabled:false,configRevision:revision},cookie)).status,200);
});

test('scheduled task list is authenticated, paginated, redacted and read-only',async t=>{
 const f=fixture(t);assert.deepEqual(f.manager.browse('schedules'),{items:[],total:0,page:1,pageSize:25,pages:1});
 const s=new Store(join(f.data,'bot.sqlite'));
 s.enqueue({key:'schedule-source',messageId:'msg',chatKey:'chat',chatId:'chat',senderId:'alice',text:'create'});
 for(let n=0;n<54;n++)s.db.prepare('INSERT INTO schedules VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(`S-${String(n).padStart(12,'0')}`,'alice','chat','chat','schedule-source',n%2?'task':'reminder',`item ${n} PRIVATE_TEST_SECRET_7381`,n%2?86400000:null,200000+n,n===53?'deleted':n===52?'paused':'active',null,100000+n);
 s.close();
 const ui=await startUi(f.manager);t.after(()=>ui.close());
 assert.equal((await fetch(ui.url+'/api/schedules')).status,401);
 const login=await fetch(ui.url+'/api/session',{method:'POST',headers:{Origin:ui.url,'Content-Type':'application/json'},body:JSON.stringify({code:new URL(ui.entryUrl).hash.slice(1)})});
 const headers={Cookie:login.headers.get('set-cookie')!};
 const first=await (await fetch(ui.url+'/api/schedules?page=1&pageSize=25',{headers})).json() as any;
 assert.equal(first.total,53);assert.equal(first.items.length,25);assert.equal(first.items[0].state,'paused');
 assert.doesNotMatch(JSON.stringify(first),/PRIVATE_TEST_SECRET_7381|sourceKey|chatKey|binding/);
 const third=await (await fetch(ui.url+'/api/schedules?page=3&pageSize=25',{headers})).json() as any;
 assert.equal(third.items.length,3);assert.equal(new Set([...first.items,...third.items].map((x:any)=>x.id)).size,28);
 assert.equal((await fetch(ui.url+'/api/schedules?pageSize=101',{headers})).status,400);
 const after=new Store(join(f.data,'bot.sqlite'),true);assert.equal(after.db.prepare("SELECT COUNT(*) n FROM schedules WHERE state='paused'").get()?.n,1);after.close();
});

test('MCP authorization result pages are localized, nonce-styled and do not reflect input',async t=>{
 const f=fixture(t),ui=await startUi(f.manager);t.after(()=>ui.close());
 for(const language of ['zh-CN','en']){
  const headers={'Accept-Language':language};
  const response=await fetch(ui.url+'/oauth-complete?status=success',{headers});const html=await response.text();
  assert.match(html,language==='en'?/Authorization complete/:/授权完成/);
  const nonce=/style nonce="([^"]+)"/.exec(html)?.[1];assert.ok(nonce);assert.ok(response.headers.get('content-security-policy')?.includes(`'nonce-${nonce}'`));
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  const failed=await (await fetch(ui.url+'/oauth-complete?status=failed&reason=mcp_oauth_scope',{headers})).text();
  assert.match(failed,language==='en'?/outside the requested scope/:/超出请求范围/);
  const untrusted=await (await fetch(ui.url+'/oauth-complete?reason=%3Cscript%3Ealert(1)%3C%2Fscript%3E',{headers})).text();
  assert.doesNotMatch(untrusted,/<script>|alert\(1\)/);
  const prototype=await (await fetch(ui.url+'/oauth-complete?reason=constructor',{headers})).text();assert.doesNotMatch(prototype,/function Object/);
 }
});
