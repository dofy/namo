import { test } from 'node:test';import assert from 'node:assert/strict';import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync } from 'node:fs';import { tmpdir } from 'node:os';import { join } from 'node:path';
import { Store } from '../src/store.js';import { Management } from '../src/management.js';import { startUi } from '../src/ui.js';import { digest } from '../src/paths.js';import { Tasks } from '../src/tasks.js';import { request as httpRequest } from 'node:http';
function fixture(t:any,deps:any={}){
 const dir=mkdtempSync(join(tmpdir(),'namo-ui-')),data=join(dir,'data'),project=join(dir,'project'),file=join(dir,'config.json');mkdirSync(data);mkdirSync(project);
 const raw={version:1,agent:'codex',dataDir:data,custom:{keep:'untouched'},feishu:{appId:'cli_test',appSecret:'PRIVATE_TEST_SECRET_7381',allowedUserIds:['alice'],allowedChatIds:[],extraSecret:'PRIVATE_EXTRA_991'},codex:{bin:'codex',home:join(data,'auth'),projects:{app:project},defaultProject:'app',sandbox:'workspace-write',networkAccess:false,allowLocalCommits:true,denyPaths:[],readPaths:[],timeoutMs:600000},concurrency:1};
 writeFileSync(file,JSON.stringify(raw));const s=new Store(join(data,'bot.sqlite'));s.close();const manager=new Management(file,{status:()=>({running:false,installed:true,registered:false,mode:'stopped'}),diagnose:async()=>[{id:'test',status:'ok',message:'isolated diagnostic'}],...deps});
 t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,data,project,file,raw,manager};
}
test('configuration projection excludes credentials and preserves unknown fields on save',t=>{const f=fixture(t),before=f.manager.config();assert.doesNotMatch(JSON.stringify(f.manager.state()),/PRIVATE_TEST_SECRET|PRIVATE_EXTRA/);const saved=f.manager.save(before.revision,{model:'test-model'});const raw=JSON.parse(readFileSync(f.file,'utf8'));assert.equal(raw.custom.keep,'untouched');assert.equal(raw.feishu.extraSecret,f.raw.feishu.extraSecret);assert.equal(raw.feishu.appSecret,f.raw.feishu.appSecret);assert.equal(saved.values.model,'test-model');assert.equal(readdirSync(join(f.data,'config-backups')).length,1);assert.throws(()=>f.manager.save(before.revision,{model:'stale'}),/配置已被/);});
test('invalid configuration and unapproved fields cannot overwrite saved configuration',t=>{const f=fixture(t),before=readFileSync(f.file,'utf8'),revision=f.manager.config().revision;assert.throws(()=>f.manager.save(revision,{projects:{app:'/missing-namo-project'}}),/校验/);assert.throws(()=>f.manager.save(revision,{dataDir:'/tmp'}),/不允许/);assert.throws(()=>f.manager.save(revision,{sandbox:'danger-full-access'}),/校验/);assert.equal(readFileSync(f.file,'utf8'),before);});
test('UI can repair an invalid project path without changing identity or data directory',t=>{const f=fixture(t);writeFileSync(f.file,JSON.stringify({...f.raw,codex:{...f.raw.codex,projects:{app:'/not-a-project'}}}));assert.equal(f.manager.config().valid,false);f.manager.save(f.manager.config().revision,{projects:{app:f.project}});assert.equal(f.manager.config().valid,true);assert.equal(JSON.parse(readFileSync(f.file,'utf8')).feishu.appId,f.raw.feishu.appId);});
test('reading old schema does not migrate it and management writes fail closed',t=>{const f=fixture(t),s=new Store(join(f.data,'bot.sqlite'));s.db.exec('DROP TABLE reconciliations; DROP TABLE card_actions; PRAGMA user_version=1');s.close();const before=readFileSync(join(f.data,'bot.sqlite'));const state=f.manager.state();assert.equal(state.database.schema,1);assert.equal(state.recoveryAvailable,false);assert.throws(()=>f.manager.cancel('N-AAAAAAAAAAAA',1,'id'),/尚未升级/);assert.deepEqual(readFileSync(join(f.data,'bot.sqlite')),before);});
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
 const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(m=>m[1]);assert.equal(assets.length,2);
 for(const path of assets){const asset=await fetch(ui.url+path);assert.equal(asset.status,200);assert.match(asset.headers.get('content-type')!,path.endsWith('.css')?/text\/css/:/text\/javascript/);assert.ok((await asset.text()).length>100);}
 for(const path of ['/assets/config.local.json','/assets/index.js.map','/assets/%2e%2e%2fconfig.local.json','/assets/missing.js'])assert.equal((await fetch(ui.url+path)).status,404);
 assert.equal((await fetch(ui.url+'/src/management.ts')).status,401);assert.equal((await fetch(ui.url+'/api/state')).status,401);
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
 assert.throws(()=>f.manager.saveProfile(f.manager.config().revision,'alice',0,{name:'x'}),/尚未升级/);
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
