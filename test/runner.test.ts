import { chatWorkspace } from '../src/safety.js';
import { waitFor } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { Store, type Incoming } from '../src/store.js';
import { RuntimeError, type Runtime } from '../src/runtime.js';
import { requestDirectory, decideDirectory, applyDirectoryRequests, getDirectoryRequest } from '../src/directory-approval.js';
import { Engine } from '../src/engine.js';
import { RunnerRuntime } from '../src/runner.js';
import { Tasks } from '../src/tasks.js';
import { reconcileRunner, processState, runnerJob } from '../src/runner-store.js';
import { Recovery } from '../src/recovery.js';
import { digest } from '../src/paths.js';
import { Management } from '../src/management.js';
import { Cards } from '../src/cards.js';
import { queuedConfiguration, watchConfiguration } from '../src/config-reload.js';
import { RuntimeHost } from '../src/runtime-host.js';
import { setUserModel } from '../src/model-preferences.js';

const wait = (condition: () => boolean, timeoutMs = 7000) => waitFor(condition, timeoutMs);
const fake = `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {appendFileSync,existsSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
let cwd,thread='thread',turn='turn',timer,browserExtra=false;
process.on('SIGTERM',()=>{if(!cwd||!existsSync(join(cwd,'hold-close')))process.exit(0);appendFileSync(join(cwd,'closing'),'ready');setInterval(()=>{if(existsSync(join(cwd,'exit-now'))){appendFileSync(join(cwd,'exiting'),'ready');process.exit(0);}},5);});
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const done=text=>{clearInterval(timer);send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'command',type:'commandExecution',command:'node --test',cwd,status:'completed',exitCode:0,durationMs:12}}});send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed',items:[{id:'final',type:'agentMessage',phase:'final_answer',text}]}}});};
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===99&&!m.method){appendFileSync(join(cwd,'mcp-discovery'),m.result?.contentItems?.[0]?.text??'error');if(browserExtra){send({id:100,method:'item/tool/call',params:{namespace:null,tool:'ego_browser',threadId:thread,turnId:turn,callId:'browser-press',arguments:{operation:'press',selector:'body',key:'Tab'}}});return;}return done('discovered');}if(m.id===100&&!m.method){appendFileSync(join(cwd,'browser-press-result'),m.result?.contentItems?.[0]?.text??'error');return done('browser done');}if(m.id===undefined)return;
 if(m.method==='initialize')return send({id:m.id,result:{}});
 if(m.method==='config/read')return send({id:m.id,result:{config:{features:{plugins:false,apps:false}}}});
 if(m.method==='model/list')return send({id:m.id,result:{data:[{model:'default-model',isDefault:true}],nextCursor:null}});
 if(m.method==='plugin/list')return send({id:m.id,result:{marketplaces:[]}});
 if(m.method==='skills/list')return send({id:m.id,result:{data:[{cwd:m.params.cwds[0],skills:[],errors:[]}]}});
 if(m.method==='thread/start'||m.method==='thread/resume'){cwd=m.params.cwd;appendFileSync(join(cwd,'model-params'),JSON.stringify({thread:m.params.model})+'\\n');if(m.method==='thread/start')appendFileSync(join(cwd,'thread-tools'),JSON.stringify((m.params.dynamicTools??[]).map(x=>x.name))+'\\n');return send({id:m.id,result:{thread:{id:thread}}});}
 if(m.method==='turn/start'){
  appendFileSync(join(cwd,'model-params'),JSON.stringify({turn:m.params.model})+'\\n');
  appendFileSync(join(cwd,'calls'),'turn\\n');send({id:m.id,result:{turn:{id:turn}}});
  send({method:'item/started',params:{threadId:thread,turnId:turn,item:{id:'command',type:'commandExecution',command:'node --test',cwd,status:'inProgress'}}});
  const prompt=JSON.parse(m.params.input[0].text);
  appendFileSync(join(cwd,'task-prompts'),JSON.stringify(prompt)+'\\n');
  const actual=prompt.task?.messages?prompt.task:prompt;
  if(actual.messages[0].text==='image-hold'){
   const root=join(process.env.CODEX_HOME,'generated_images',thread);mkdirSync(root,{recursive:true});
   const savedPath=join(root,'image.png');writeFileSync(savedPath,Buffer.from([137,80,78,71,13,10,26,10,1]));
   send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'image',type:'imageGeneration',status:'completed',savedPath}}});
  }
  if(actual.messages[0].text==='control-check'){send({id:99,method:'item/tool/call',params:{namespace:null,tool:'manage_namo',threadId:thread,turnId:turn,callId:'control-check',arguments:{operation:'tasks'}}});return;}
  if(actual.messages[0].text==='schedule-check'){send({id:99,method:'item/tool/call',params:{namespace:null,tool:'manage_schedule',threadId:thread,turnId:turn,callId:'schedule-check',arguments:{operation:'create',kind:'task',frequency:'daily',time:'2099-01-01T09:00+08:00',content:'搜索项目并汇报'}}});return;}
  if(actual.messages[0].text==='mcp-check'){send({id:99,method:'item/tool/call',params:{namespace:null,tool:'mcp_read',threadId:thread,turnId:turn,callId:'mcp',arguments:{operation:'connections'}}});return;}
  if(actual.messages[0].text==='browser-check'){send({id:99,method:'item/tool/call',params:{namespace:null,tool:'ego_browser',threadId:thread,turnId:turn,callId:'browser',arguments:{operation:'open',url:readFileSync(join(cwd,'browser-url'),'utf8')}}});return;}
  if(actual.messages[0].text==='browser-extra'){browserExtra=true;send({id:99,method:'item/tool/call',params:{namespace:null,tool:'ego_browser',threadId:thread,turnId:turn,callId:'browser',arguments:{operation:'open',url:readFileSync(join(cwd,'browser-url'),'utf8')}}});return;}
  if(actual.messages[0].text==='instant')return done('saved answer');
  timer=setInterval(()=>{if(existsSync(join(cwd,'release')))done('saved answer');},30);return;
 }
 if(m.method==='turn/steer'){const finish=()=>{send({id:m.id,result:{turnId:turn}});done('steered answer');};if(m.params.input[0].text.includes('delayed'))setTimeout(finish,700);else finish();}
});
`;
const message = (key: string, text = 'hold', chat = 'chat'): Incoming => ({
  key, messageId: key, chatKey: chat, chatId: chat, senderId: 'alice', text,
  envelope: { version: 1, type: 'text', kind: 'instruction', scopeKey: chat, chatType: 'p2p', materials: [], limitations: [] },
});
function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'namo-runner-')));
  const data = join(dir, 'data'), project = chatWorkspace(data,'chat:user:alice'),source=join(dir,'source'); mkdirSync(project,{recursive:true});mkdirSync(source);
  const bin = join(dir, 'fake.mjs'); writeFileSync(bin, fake, { mode: 0o700 });
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ dataDir: data, feishu: { appId: 'app', appSecret: 'TEST_PRIVATE_VALUE', allowedUserIds: ['alice'] },
    concurrency: 2, codex: { bin, home: join(data, 'home'), timeoutMs: 12000, sandbox: 'workspace-write', directories: [source] } }));
  const config = loadConfig(file), store = new Store(join(data, 'bot.sqlite')), tasks = new Tasks(store);
  const engines: Engine[] = [], deliveries: string[] = [];
  const receiver = (selectedConfig = config) => {
    const engine = new Engine(store, new RunnerRuntime(store, selectedConfig), { async send(_chat, text, uuid) { deliveries.push(text); return uuid; } }, selectedConfig);
    engines.push(engine); return engine;
  };
  const job = () => store.db.prepare('SELECT * FROM runner_jobs ORDER BY createdAt DESC LIMIT 1').get() as any;
  const calls = () => [...new Set([project,...store.db.prepare('SELECT cwd FROM tasks').all().map(row=>String(row.cwd))])].reduce((n,path)=>n+(existsSync(join(path,'calls'))?readFileSync(join(path,'calls'),'utf8').trim().split('\n').length:0),0);
  t.after(async () => {
    for (const engine of engines) await engine.stop();
    store.db.prepare("UPDATE inbox SET cancelRequested=1 WHERE state='running'").run();
    await wait(() => !store.db.prepare("SELECT 1 FROM runner_jobs WHERE state IN ('starting','running')").get(), 4000).catch(() => {});
    for (const row of store.db.prepare('SELECT pid,runtimePid FROM runner_jobs').all()) {
      if (row.runtimePid) { try { process.kill(-Number(row.runtimePid), 'SIGKILL'); } catch {} }
      if (row.pid) { try { process.kill(Number(row.pid), 'SIGKILL'); } catch {} }
    }
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { dir, data, project, file, config, store, tasks, receiver, deliveries, job, calls };
}

function organization(f: ReturnType<typeof fixture>, github?: object) {
  const raw = JSON.parse(readFileSync(f.file, 'utf8'));
  raw.feishu.access = { mode: 'organization', tenantKey: 'tenant' };

  if (github) raw.github = github;
  writeFileSync(f.file, JSON.stringify(raw)); Object.assign(f.config, loadConfig(f.file));
  const input = message('organization'); input.envelope!.tenantKey = 'tenant'; return input;
}

test('queued task keeps its user model through detached worker startup', async t => {
  const f=fixture(t), identity={channel:'feishu' as const,appId:'app',userId:'alice'}, receiver=f.receiver();
  setUserModel(f.store,identity,'model-one');
  receiver.accept(message('model-task','instant'));
  setUserModel(f.store,identity,'model-two');
  receiver.start();
  await wait(()=>f.store.get('model-task')?.state==='replied');
  const rows=readFileSync(join(f.project,'model-params'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(rows,[{thread:'model-one'},{turn:'model-one'}]);
});

test('new workstreams register MCP discovery even before a connection exists', async t => {
  const f=fixture(t), receiver=f.receiver();
  receiver.start(); receiver.accept(message('no-mcp','instant'));
  await wait(()=>f.store.get('no-mcp')?.state==='replied');
  assert.ok(JSON.parse(readFileSync(join(f.project,'thread-tools'),'utf8').trim()).includes('mcp_read'));
});

test('detached worker executes natural management and schedule calls through the host',async t=>{
 const f=fixture(t),receiver=f.receiver();receiver.start();
 receiver.accept(message('control-natural','control-check'));await wait(()=>f.store.get('control-natural')?.state==='replied');
 const control=JSON.parse(readFileSync(join(f.project,'mcp-discovery'),'utf8'));
 assert.deepEqual(control.result,[]);
 receiver.accept(message('schedule-natural','schedule-check'));await wait(()=>f.store.get('schedule-natural')?.state==='replied');
 const row=f.store.db.prepare('SELECT ownerId,kind,content,intervalMs FROM schedules').get();
 assert.equal(row?.ownerId,'alice');assert.equal(row?.kind,'task');assert.equal(row?.content,'搜索项目并汇报');assert.equal(row?.intervalMs,86400000);
});

test('generated image survives receiver detachment and is delivered once after reattachment', async t => {
  const f=fixture(t),first=f.receiver();first.start();first.accept(message('offline-image','image-hold'));
  await wait(()=>f.calls()===1);await first.stop();writeFileSync(join(f.project,'release'),'yes');
  await wait(()=>f.job()?.state==='completed');let uploads=0,sends=0;
  const receiver=new Engine(f.store,new RunnerRuntime(f.store,f.config),{
    async send(_chat,_text,uuid){return uuid;},async uploadArtifact(){return 'file';},async sendArtifact(){return 'file-receipt';},
    async uploadImage(artifact){uploads++;assert.equal(artifact.size,9);return 'image';},async sendImage(){sends++;return 'image-receipt';},
  },f.config);
  t.after(async()=>{await receiver.stop();});receiver.start();await wait(()=>sends===1);
  for(let i=0;i<4;i++)await receiver.pump();assert.equal(uploads,1);assert.equal(sends,1);assert.equal(f.calls(),1);
});

test('refresh keeps the workstream and supplies bounded history to a fresh thread', async t => {
  const f=fixture(t), receiver=f.receiver(); receiver.start();
  receiver.accept(message('first','instant'));
  await wait(()=>f.store.get('first')?.state==='replied');
  const workstream=f.tasks.binding(message('lookup'))!.id;
  receiver.accept(message('refresh','/refresh'));
  await wait(()=>f.store.get('refresh')?.state==='replied');
  assert.equal(f.tasks.binding(message('lookup'))!.id,workstream);
  receiver.accept(message('second','instant'));
  await wait(()=>f.store.get('second')?.state==='replied');
  const prompts=readFileSync(join(f.project,'task-prompts'),'utf8').trim().split('\n').map(x=>JSON.parse(x));
  assert.equal(prompts[1].prior_context[0].request,'instant');
  assert.match(prompts[1].prior_context[0].result,/^saved answer/);
  assert.equal(f.tasks.binding(message('lookup'))!.id,workstream);
});

test('new runs discover saved MCP grants without restarting the receiver', async t => {
  let watcher:ReturnType<typeof watchConfiguration>|undefined;t.after(async()=>{await watcher?.stop();});
  const f=fixture(t), receiver=new RuntimeHost(()=>f.receiver()); receiver.start();
  watcher=watchConfiguration(f.store,receiver,f.config,digest(readFileSync(f.file,'utf8')),async next=>()=>f.receiver(next),()=>{},()=>{});
  receiver.accept(message('before','instant')); await wait(()=>f.store.get('before')?.state==='replied');
  const raw=JSON.parse(readFileSync(f.file,'utf8'));
  raw.mcpConnections=[{id:'linear',type:'remote',url:'https://mcp.linear.app/mcp',enabled:true,audience:{organization:false,userIds:['alice'],chatIds:[]},projects:[],token:'test_authorized_token'}];
  writeFileSync(f.file,JSON.stringify(raw));
  watcher.observe(); receiver.accept(message('after','mcp-check')); await wait(()=>f.store.get('after')?.state==='replied');
  assert.deepEqual(JSON.parse(readFileSync(join(f.tasks.get(f.store.get('after')!.taskId!)!.cwd,'mcp-discovery'),'utf8')),{connections:[{id:'linear',type:'remote'}]});
});

test('configuration drains accepted tasks with their model and admits deferred requests with the new model', async t=>{
  let watcher:ReturnType<typeof watchConfiguration>|undefined;t.after(async()=>{await watcher?.stop();});
  const f=fixture(t), raw=JSON.parse(readFileSync(f.file,'utf8'));
  raw.codex.model='old-model';writeFileSync(f.file,JSON.stringify(raw));Object.assign(f.config,loadConfig(f.file));
  const host=new RuntimeHost(()=>f.receiver());host.start();
  let applied=false;
  watcher=watchConfiguration(f.store,host,f.config,digest(readFileSync(f.file,'utf8')),async next=>()=>f.receiver(next),()=>{applied=true;},()=>{});
  host.accept(message('running'));await wait(()=>f.calls()===1);
  const originalStream=f.tasks.binding(message('lookup'))!.id;
  host.accept(message('queued','instant'));
  raw.codex.model='new-model';writeFileSync(f.file,JSON.stringify(raw));watcher.observe();
  host.accept(message('deferred','instant'));
  assert.equal(f.store.get('deferred')?.taskId,null);
  assert.equal(applied,false);
  writeFileSync(join(f.project,'release'),'yes');
  await wait(()=>f.store.get('deferred')?.state==='replied');
  assert.equal(f.store.db.prepare("SELECT error FROM inbox WHERE key='deferred'").get()?.error,null,JSON.stringify(f.store.db.prepare('SELECT error FROM runner_jobs').all()));
  const models=[...new Set([f.project,f.tasks.get(f.store.get('deferred')!.taskId!)!.cwd])].map(path=>readFileSync(join(path,'model-params'),'utf8').trim()).join('\n').split('\n').map(x=>JSON.parse(x)).filter(x=>x.turn).map(x=>x.turn);
  assert.deepEqual(models,['old-model','old-model','new-model']);assert.equal(applied,true);
  assert.equal(f.tasks.binding(message('lookup'))!.id,originalStream);
});

test('failed configuration commit retains deferred input and retries without invoking the model twice',async t=>{
  let watcher:ReturnType<typeof watchConfiguration>|undefined;t.after(async()=>{await watcher?.stop();});
  const f=fixture(t),host=new RuntimeHost(()=>f.receiver());host.start();let fail=true,failed=false;
  watcher=watchConfiguration(f.store,host,f.config,digest(readFileSync(f.file,'utf8')),async next=>()=>f.receiver(next),()=>{if(fail)throw Error('test');},state=>{if(state==='error')failed=true;});
  const raw=JSON.parse(readFileSync(f.file,'utf8'));raw.codex.model='next';writeFileSync(f.file,JSON.stringify(raw));watcher.observe();host.accept(message('held','instant'));
  await wait(()=>failed);assert.equal(f.calls(),0);assert.equal(f.store.get('held')?.state,'queued');
  fail=false;await wait(()=>f.store.get('held')?.state==='replied');assert.equal(f.calls(),1);
});

test('cancel remains available while new configuration waits for the old queue',async t=>{
  let watcher:ReturnType<typeof watchConfiguration>|undefined;t.after(async()=>{await watcher?.stop();});
  const f=fixture(t),host=new RuntimeHost(()=>f.receiver());host.start();
  watcher=watchConfiguration(f.store,host,f.config,digest(readFileSync(f.file,'utf8')),async next=>()=>f.receiver(next),()=>{},()=>{});
  host.accept(message('held'));await wait(()=>f.calls()===1);
  const raw=JSON.parse(readFileSync(f.file,'utf8'));raw.codex.model='next';writeFileSync(f.file,JSON.stringify(raw));watcher.observe();
  host.accept(message('later','instant'));host.accept(message('cancel','/cancel'));
  await wait(()=>f.store.get('later')?.state==='replied');assert.equal(f.calls(),2);
});

test('restart recovers the queued configuration from the existing save backup',t=>{
  const f=fixture(t),receiver=f.receiver(),revision=digest(readFileSync(f.file,'utf8'));
  receiver.accept(message('queued','instant'));
  writeFileSync(join(f.data,'health.json'),JSON.stringify({automaticConfiguration:true,configRevision:revision}));
  const manager=new Management(f.file,{status:()=>({running:false,mode:'stopped'})});
  manager.save(manager.config().revision,{model:'next-model'});
  const recovered=queuedConfiguration(loadConfig(f.file));
  assert.equal(recovered.revision,revision);assert.equal(recovered.config.codex.model,undefined);
  assert.equal(loadConfig(f.file).codex.model,'next-model');
});

test('saving presentation settings does not cancel an organization worker; revocation still does', async t => {
  const f = fixture(t), input = organization(f), receiver = f.receiver(); receiver.start(); receiver.accept(input);
  await wait(() => f.calls() === 1);
  const manager = new Management(f.file, { status: () => ({ running: false, mode: 'stopped' }) });
  manager.save(manager.config().revision, { progressIntervalMs: 9000 });
  const heartbeat = f.job().updatedAt;
  await wait(() => f.job().state !== 'running' || f.job().updatedAt > heartbeat + 400);
  assert.equal(f.job().state, 'running');
  manager.save(manager.config().revision, { serviceAccess:{access:{mode:'organization',tenantKey:'revoked'},allowedUserIds:['alice'],allowedChatIds:[]} });
  await wait(() => f.job().state === 'failed');
  assert.equal(f.calls(), 1); assert.equal(f.job().result, null);
});

test('an unrelated organization grant change does not interrupt or withhold a running task',async t=>{
 const f=fixture(t),input=organization(f),receiver=f.receiver();receiver.start();receiver.accept(input);
 await wait(()=>f.calls()===1);
 const raw=JSON.parse(readFileSync(f.file,'utf8'));raw.feishu.allowedUserIds.push('bob');
 writeFileSync(f.file,JSON.stringify(raw));
 const heartbeat=f.job().updatedAt;await wait(()=>f.job().state!=='running'||f.job().updatedAt>heartbeat+400);
 assert.equal(f.job().state,'running');writeFileSync(join(f.project,'release'),'release');
 await wait(()=>f.store.get(input.key)?.state==='replied');
 assert.ok(f.deliveries.some(text=>text.includes('saved answer')));
});

test('environment credentials reach only the trusted worker, including after a presentation save', async t => {
  const f = fixture(t), name = 'NAMO_GITHUB_RUNNER_TEST';
  const previous = process.env[name]; process.env[name] = 'runner-test-credential';
  t.after(async () => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  const input = organization(f, { tokenEnv: name, repositories: ['example/repo'], allowedUserIds: ['alice'] });
  writeFileSync(f.config.codex.bin, fake.replace("appendFileSync(join(cwd,'calls'),'turn\\n');",
    "appendFileSync(join(cwd,'calls'),'turn\\n');appendFileSync(join(cwd,'env-isolated'),String(process.env.NAMO_GITHUB_RUNNER_TEST===undefined));"), { mode: 0o700 });
  const receiver = f.receiver(); receiver.start(); receiver.accept(input);
  await wait(() => f.calls() === 1 || f.job()?.state === 'failed');
  assert.equal(f.job().state, 'running'); assert.equal(f.calls(), 1);
  assert.equal(readFileSync(join(f.project, 'env-isolated'), 'utf8'), 'true');
  writeFileSync(join(f.project, 'release'), 'release');
  await wait(() => f.store.get(input.key)?.state === 'replied');
  assert.equal(f.tasks.get(f.store.get(input.key)!.taskId!)?.state, 'succeeded');
});

test('unapplied execution defaults do not change a queued worker or withhold its result', async t => {
  const f = fixture(t), input = organization(f), receiver = f.receiver();
  receiver.accept(input);
  const manager = new Management(f.file, { status: () => ({ running: false, mode: 'stopped' }) });
  manager.save(manager.config().revision, { model: 'pending-model', timeoutMs: 15000, progressIntervalMs: 9000 });
  receiver.start(); await wait(() => f.calls() === 1 || f.job()?.state === 'failed');
  assert.equal(f.job().state, 'running');
  writeFileSync(join(f.project, 'release'), 'release');
  await wait(() => f.store.get(input.key)?.state === 'replied');
  assert.equal(f.tasks.get(f.store.get(input.key)!.taskId!)?.state, 'succeeded');
  assert.equal(f.config.codex.model, undefined); assert.equal(loadConfig(f.file).codex.model, 'pending-model');
});

test('switching out of organization mode cannot deliver a saved result to a now-unpaired user', async t => {
  const f = fixture(t), input = organization(f), receiver = f.receiver(); receiver.start(); receiver.accept(input);
  await wait(() => f.calls() === 1); await receiver.stop();
  writeFileSync(join(f.project, 'release'), 'release'); await wait(() => f.job().state === 'completed');
  const raw = JSON.parse(readFileSync(f.file, 'utf8')); delete raw.feishu.access; raw.feishu.allowedUserIds = [];
  writeFileSync(f.file, JSON.stringify(raw));
  const next = f.receiver(); next.start();
  await wait(() => !!f.store.db.prepare("SELECT 1 FROM outbox WHERE kind='result' AND state='failed' AND error='access_changed'").get());
  assert.equal(f.deliveries.filter(text => text.includes('saved answer')).length, 0); assert.equal(f.calls(), 1);
});

test('a withheld result emits only a generic notice to an admitted user',async t=>{
 const f=fixture(t),input=organization(f),receiver=f.receiver();receiver.start();receiver.accept(input);
 await wait(()=>f.calls()===1);await receiver.stop();writeFileSync(join(f.project,'release'),'release');
 await wait(()=>f.job().state==='completed');
 const raw=JSON.parse(readFileSync(f.file,'utf8'));raw.codex.directories=[];writeFileSync(f.file,JSON.stringify(raw));
 const next=f.receiver();next.start();
 await wait(()=>f.deliveries.some(text=>text.includes('结果未交付')));
 assert.equal(f.deliveries.some(text=>text.includes('saved answer')),false);
 assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE kind='result'").get()?.state,'failed');
});

test('detached worker finishes offline with delayed feedback; restart consumes one saved result and evidence', async t => {
  const f = fixture(t); f.config.feishu.progressDelayMs=12_000;
  const first = f.receiver(); first.start(); first.accept(message('first'));
  await wait(() => f.calls() === 1 && !!f.job()?.runtimePid);
  const before = f.job(), taskId = f.store.get('first')!.taskId!;
  assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE inboxKey='first' AND kind='progress'").get()?.state,'deferred');
  await first.stop(); assert.equal(f.tasks.get(taskId)?.state, 'running');
  assert.equal(processState(before.pid), 'alive');
  writeFileSync(join(f.project, 'release'), 'release');
  await wait(() => f.job()?.state === 'completed');
  assert.equal(f.tasks.get(taskId)?.state, 'running');
  assert.equal(f.deliveries.filter(x => x.includes('saved answer')).length, 0);
  const second = f.receiver(); second.start(); await wait(() => f.store.get('first')?.state === 'replied');
  assert.equal(f.calls(), 1); assert.equal(f.job().owner, before.owner);
  assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE inboxKey='first' AND kind='progress'").get()?.state,'suppressed');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_runs').get()?.n, 1);
  const detail = f.tasks.detail(f.tasks.get(taskId)!) as any;
  assert.equal(detail.evidence[0].state, 'finished'); assert.equal(detail.evidence[0].items[0].exitCode, 0);
  assert.equal(detail.runners[0].state, 'completed');
  assert.doesNotMatch(JSON.stringify(detail), /TEST_PRIVATE_VALUE|configRevision|prompt|"owner"/);
  assert.equal(f.deliveries.filter(x => x.includes('saved answer')).length, 1);
});

test('reconnected receiver preserves running revisions and cancellation reaches the original worker', async t => {
  const f = fixture(t), first = f.receiver(); first.start(); first.accept(message('a'));
  await wait(() => f.calls() === 1); const pid = f.job().pid;
  await first.stop(); const second = f.receiver(); second.start();
  second.accept(message('cancel', '/cancel'));
  await wait(() => f.tasks.get(f.store.get('a')!.taskId!)?.state === 'cancelled');
  assert.equal(f.job().error, 'cancelled'); assert.equal(f.job().pid, pid); assert.equal(f.calls(), 1);
  const report = JSON.parse(String(f.store.db.prepare('SELECT report FROM run_evidence').get()?.report));
  assert.equal(report.state, 'partial'); assert.equal(report.items[0].status, 'unknown');
});

test('local management cancels a durable worker while receiver is offline', async t => {
  const f = fixture(t), receiver = f.receiver(); receiver.start(); receiver.accept(message('a'));
  await wait(() => f.calls() === 1); const taskId=f.store.get('a')!.taskId!;
  await receiver.stop();
  const manager=new Management(f.file,{status:()=>({running:false,mode:'stopped'})});
  assert.deepEqual(manager.cancel(taskId,1,'offline-cancel'),{duplicate:false});
  assert.deepEqual(manager.cancel(taskId,1,'offline-cancel'),{duplicate:true});
  await wait(()=>f.job().state==='failed');assert.equal(f.job().error,'cancelled');
  const restarted=f.receiver();restarted.start();await wait(()=>f.tasks.get(taskId)?.state==='cancelled');
  assert.equal(f.calls(),1);
});

test('completed worker cannot be cancelled and saved result survives an unavailable project on reattach', async t => {
  const f = fixture(t), receiver = f.receiver(); receiver.start(); receiver.accept(message('a'));
  await wait(()=>f.calls()===1);const taskId=f.store.get('a')!.taskId!;await receiver.stop();
  writeFileSync(join(f.project,'release'),'release');await wait(()=>f.job().state==='completed');
  const manager=new Management(f.file,{status:()=>({running:false,mode:'stopped'})});
  assert.throws(()=>manager.cancel(taskId,1,'late-cancel'),/已结束或失联/);
  // Task archival is deliberately pending while the durable worker is terminal.
  const unstarted=f.receiver();unstarted.accept(message('late-command',`/cancel ${taskId}`));
  const reply=f.store.db.prepare("SELECT content FROM outbox WHERE inboxKey='late-command' AND kind='result'").get();
  assert.match(String(reply?.content),/已结束或失联/);assert.doesNotMatch(String(reply?.content),/已请求停止/);
  assert.equal(f.store.get('a')!.cancelRequested,0);
  renameSync(f.project,join(f.dir,'finished-project'));writeFileSync(f.project,'not a directory now');
  const raw=JSON.parse(readFileSync(f.file,'utf8'));
  writeFileSync(f.file,JSON.stringify(raw));Object.assign(f.config,loadConfig(f.file));
  const next=f.receiver();next.start();await wait(()=>f.store.get('a')?.state==='replied');
  assert.equal(f.tasks.get(taskId)?.state,'succeeded');
  assert.equal(f.deliveries.filter(text=>text.includes('saved answer')).length,1);
});

test('cancellation committed before the final worker transaction wins even after model completion', async t => {
  const f=fixture(t),receiver=f.receiver();receiver.start();receiver.accept(message('a'));
  await wait(()=>f.calls()===1);await receiver.stop();
  writeFileSync(join(f.project,'hold-close'),'hold');writeFileSync(join(f.project,'release'),'release');
  await wait(()=>existsSync(join(f.project,'closing')));
  // Hold the writer lock while the worker exits Codex and reaches its final commit.
  // WAL readers still see the previous cancelRequested=0 until this transaction commits.
  f.store.db.exec('BEGIN IMMEDIATE');
  try {
    assert.equal(f.job().state,'running');
    f.store.db.prepare("UPDATE inbox SET cancelRequested=1 WHERE key='a'").run();
    writeFileSync(join(f.project,'exit-now'),'exit');
    // The worker can be blocked on the SQLite lock and cannot reap the child
    // yet. A zombie PID still responds to signal 0 on macOS.
    await wait(()=>existsSync(join(f.project,'exiting')));
    await new Promise(resolve=>setTimeout(resolve,150));
    f.store.db.exec('COMMIT');
  } catch(e) {f.store.db.exec('ROLLBACK');throw e;}
  await wait(()=>['failed','completed'].includes(f.job().state));
  assert.equal(f.job().state,'failed');assert.equal(f.job().error,'cancelled');assert.equal(f.job().result,null);
  const next=f.receiver();next.start();await wait(()=>f.tasks.get(f.store.get('a')!.taskId!)?.state==='cancelled');
  assert.equal(f.calls(),1);
});

test('stale card cannot cancel a terminal worker before task archival', async t => {
  const f=fixture(t),receiver=f.receiver();receiver.start();receiver.accept(message('a'));
  await wait(()=>f.calls()===1);await receiver.stop();
  f.tasks.progress(Date.now()+12_000);
  const out=f.store.db.prepare("SELECT * FROM outbox WHERE inboxKey='a' AND kind='progress'").get() as any;
  const cards=new Cards(f.store);cards.prepare(out);
  f.store.db.prepare('UPDATE outbox SET platformId=? WHERE id=?').run('platform',out.id);
  const token=f.store.db.prepare("SELECT token FROM card_actions WHERE outboxId=? AND action='cancel'").get(out.id)!.token;
  const event={operator:{open_id:'alice'},context:{open_chat_id:'chat',open_message_id:'platform'},action:{value:{namo:String(token)}}};
  writeFileSync(join(f.project,'release'),'release');await wait(()=>f.job().state==='completed');
  for(const state of ['completed','failed','lost','reviewed']) {
    f.store.db.prepare('UPDATE runner_jobs SET state=? WHERE runId=?').run(state,f.job().runId);
    const reply=cards.accept(event);assert.equal(reply.toast.type,'error');assert.match(reply.toast.content,/已结束或失联/);
    assert.equal(f.store.get('a')!.cancelRequested,0);
  }
  f.store.db.prepare("UPDATE runner_jobs SET state='completed' WHERE runId=?").run(f.job().runId);
});

test('revision accepted after receiver restart is submitted once by the original worker', async t => {
  const f = fixture(t), first = f.receiver(); first.start(); first.accept(message('a'));
  await wait(() => f.calls() === 1); const taskId = f.store.get('a')!.taskId!;
  await first.stop(); const second = f.receiver(); second.start(); second.accept(message('revision', `/amend ${taskId} delayed requirement`));
  await wait(() => f.tasks.revisions(taskId, 'submitting').length === 1);
  await second.stop(); const third = f.receiver(); third.start();
  assert.equal(f.tasks.revisions(taskId, 'submitting').length, 1);
  await wait(() => f.store.get('a')?.state === 'replied');
  assert.equal(f.calls(), 1); assert.equal(f.tasks.revisions(taskId, 'accepted').length, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM runner_events WHERE kind='revision_submitting'").get()?.n, 1);
  assert.equal(f.tasks.get(taskId)?.inputVersion, 2); assert.equal(f.tasks.get(taskId)?.state, 'succeeded');
});

test('SIGKILL of receiver process does not kill worker or create a second model turn', async t => {
  const f = fixture(t);
  const moduleUrl = (name: string) => new URL(`../src/${name}.js`, import.meta.url).href;
  const host = join(f.dir, 'receiver.mjs');
  writeFileSync(host, `import {loadConfig} from ${JSON.stringify(moduleUrl('config'))};
import {Store} from ${JSON.stringify(moduleUrl('store'))};
import {Engine} from ${JSON.stringify(moduleUrl('engine'))};
import {RunnerRuntime} from ${JSON.stringify(moduleUrl('runner'))};
const c=loadConfig(process.argv[2]),s=new Store(c.dataDir+'/bot.sqlite');
const e=new Engine(s,new RunnerRuntime(s,c),{async send(c,t,id){return id;}},c);
e.start();e.accept(${JSON.stringify(message('a'))});`);
  const receiver = spawn(process.execPath, [host, f.file], { stdio: 'ignore' });
  t.after(async () => { if (receiver.exitCode === null && receiver.signalCode === null) receiver.kill('SIGKILL'); });
  await wait(() => f.calls() === 1);
  const job = f.job(); const exited = new Promise<void>(resolve => receiver.once('exit', () => resolve()));
  receiver.kill('SIGKILL'); await exited; assert.equal(processState(job.pid), 'alive');
  const next = f.receiver(); next.start(); writeFileSync(join(f.project, 'release'), 'release');
  await wait(() => f.store.get('a')?.state === 'replied'); assert.equal(f.calls(), 1); assert.equal(f.job().owner, job.owner);
});

test('global limit still counts a surviving worker when next task uses a different project', async t => {
  const f = fixture(t), other = join(f.dir, 'other'); mkdirSync(other);
  const raw = JSON.parse(readFileSync(f.file, 'utf8')); raw.concurrency = 1; raw.codex.directories = [other];
  writeFileSync(f.file, JSON.stringify(raw)); Object.assign(f.config, loadConfig(f.file));
  // Exercise the scheduler's one-slot behavior independently of config bounds.
  f.config.concurrency = 1;
  const first = f.receiver(); first.start(); first.accept(message('a'));
  await wait(() => f.calls() === 1); await first.stop();
  const next = f.receiver(); next.start();
  next.accept(message('b', 'instant', 'other-chat'));
  await new Promise(r => setTimeout(r, 400)); assert.equal(existsSync(join(other, 'calls')), false);
  writeFileSync(join(f.project, 'release'), 'release');
  await wait(() => f.store.get('b')?.state === 'replied');
  const task=f.tasks.get(f.store.get('b')!.taskId!)!;assert.equal(readFileSync(join(task.cwd,'calls'),'utf8').trim(),'turn');
});

test('receiver restart retains project overlap and global capacity reservations', async t => {
  const f = fixture(t), first = f.receiver(); first.start(); first.accept(message('a'));
  await wait(() => f.calls() === 1); await first.stop();
  const second = f.receiver(); second.start(); second.accept(message('b', 'instant', 'different-chat'));
  await new Promise(r => setTimeout(r, 350)); assert.equal(f.calls(), 1); assert.equal(f.tasks.get(f.store.get('b')!.taskId!)?.state, 'queued');
  writeFileSync(join(f.project, 'release'), 'release');
  await wait(() => f.store.get('b')?.state === 'replied'); assert.equal(f.calls(), 2);
});

test('lost owner is never replayed; stale heartbeat alone cannot lose ownership; quarantine requires local process review', async t => {
  const f = fixture(t), first = f.receiver(); first.start(); first.accept(message('a'));
  await wait(() => f.calls() === 1); const job = f.job(), taskId = f.store.get('a')!.taskId!;
  f.store.db.prepare('UPDATE runner_jobs SET updatedAt=0 WHERE runId=?').run(job.runId);
  assert.equal(reconcileRunner(f.store, job.runId, Date.now() + 999999)?.state, 'running');
  process.kill(job.pid, 'SIGKILL'); await wait(() => processState(job.pid) === 'dead');
  await wait(() => f.tasks.get(taskId)?.state === 'interrupted');
  assert.equal(f.job().state, 'lost'); first.accept(message('b', 'instant', 'other'));
  await new Promise(r => setTimeout(r, 300)); assert.equal(f.calls(), 1);
  const recovery = new Recovery(f.store), issue = recovery.inspect(taskId);
  const request = { subject: taskId, stamp: issue.stamp, action: 'reviewed', note: 'checked owned test processes and side effects', requestId: 'review' };
  assert.throws(() => recovery.resolve(request, { id: 'alice', chatKey: 'chat' }), /本机/);
  assert.throws(() => recovery.resolve(request, { id: 'local-owner' }, true), /PID/);
  process.kill(-job.runtimePid, 'SIGKILL'); await wait(() => processState(job.runtimePid) === 'dead');
  recovery.resolve(request, { id: 'local-owner' }, true);
  assert.equal(recovery.inspect(taskId).reviewed, true); assert.equal(f.job().state, 'reviewed');
  await wait(() => f.store.get('b')?.state === 'replied'); assert.equal(f.calls(), 2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_runs WHERE taskId=?').get(taskId)?.n, 1);
});

test('duplicate worker claims fail closed and configuration changes before startup do not execute', async t => {
  const f = fixture(t), first = f.receiver(); first.start(); first.accept(message('a'));
  await wait(() => f.calls() === 1); const job = f.job();
  const worker = fileURLToPath(new URL('../src/runner-worker.js', import.meta.url));
  const duplicate = spawn(process.execPath, [worker, join(f.data, 'bot.sqlite'), f.file, job.runId, job.owner], { stdio: 'ignore' });
  await new Promise<void>(resolve => duplicate.once('exit', () => resolve())); assert.equal(f.calls(), 1);
  first.accept(message('cancel', '/cancel')); await wait(() => f.job()?.state === 'failed');
  await wait(() => f.store.get('a')?.state === 'failed'); await first.stop();
  const next = f.receiver(); next.accept(message('b', 'instant'));
  const task = f.tasks.get(f.store.get('b')!.taskId!)!, run = f.tasks.start(task);
  f.store.db.prepare("INSERT INTO runner_jobs(runId,owner,state,createdAt,updatedAt,configRevision,prompt) VALUES(?,?,'starting',?,?,?,?)")
    .run(run, 'test-owner', Date.now(), Date.now(), 'changed', f.tasks.prompt(task));
  const changed = spawn(process.execPath, [worker, join(f.data, 'bot.sqlite'), f.file, run, 'test-owner'], { stdio: 'ignore' });
  await new Promise<void>(resolve => changed.once('exit', () => resolve()));
  assert.equal(runnerJob(f.store, run)?.error, 'task_configuration_changed'); assert.equal(f.calls(), 1);
});

test('unclaimed start timeout fences late starters without rerunning', async t => {
  const f = fixture(t), receiver = f.receiver(); receiver.accept(message('a'));
  const task = f.tasks.get(f.store.get('a')!.taskId!)!, run = f.tasks.start(task);
  f.store.db.prepare("INSERT INTO runner_jobs(runId,owner,state,createdAt,updatedAt,configRevision,prompt) VALUES(?,?,'starting',0,0,?,?)")
    .run(run, 'late', digest(readFileSync(f.file, 'utf8')), f.tasks.prompt(task));
  assert.equal(reconcileRunner(f.store, run)?.state, 'lost');
  const late = spawn(process.execPath, [fileURLToPath(new URL('../src/runner-worker.js', import.meta.url)), join(f.data, 'bot.sqlite'), f.file, run, 'late'], { stdio: 'ignore' });
  await new Promise<void>(resolve => late.once('exit', () => resolve())); assert.equal(f.calls(), 0);

});

test('worker factory uses the pinned profile binary and isolated home, never the changed default', async t => {
  const f=fixture(t);
  const selectedBin=join(f.dir,'selected.mjs');
  writeFileSync(selectedBin,fake.replace("appendFileSync(join(cwd,'calls'),'turn\\n');", "appendFileSync(join(cwd,'calls'),'turn\\n');appendFileSync(join(cwd,'selected-home'),process.env.CODEX_HOME);"),{mode:0o700});
  const raw=JSON.parse(readFileSync(f.file,'utf8'));
  raw.agents={defaultProfile:'review',profiles:{review:{adapter:'codex',bin:selectedBin}}};writeFileSync(f.file,JSON.stringify(raw));
  Object.assign(f.config,loadConfig(f.file));
  const engine=f.receiver();engine.accept(message('profile','instant'));
  const task=f.tasks.get(f.store.get('profile')!.taskId!)!;
  assert.equal(f.tasks.selection(task.id)?.profileId,'review');
  raw.agents.defaultProfile='codex';writeFileSync(f.file,JSON.stringify(raw));Object.assign(f.config,loadConfig(f.file));
  engine.start();await wait(()=>f.store.get('profile')?.state==='replied');
  assert.equal(f.tasks.get(task.id)?.state,'succeeded');
  assert.equal(readFileSync(join(f.project,'selected-home'),'utf8'),join(f.data,'agents','review'));
  assert.equal(f.calls(),1);
});

test('out-of-band natural intent is classified while the original task is running',async t=>{
 const f=fixture(t);let starts=0,classifications=0;
 const runtime:Runtime={run(r){starts++;return new Promise((_resolve,reject)=>r.signal.addEventListener('abort',()=>reject(new RuntimeError('cancelled')),{once:true}));},
  async classifyControl(input){classifications++;assert.equal(input.text,'别继续刚才那件事了');return {kind:'control',operation:'cancel'};}};
 const receiver=new Engine(f.store,runtime,{async send(_chat,_text,uuid){return uuid;}},f.config);
 t.after(()=>receiver.stop());receiver.start();receiver.accept(message('work-natural','long work'));
 await wait(()=>starts===1);receiver.accept(message('cancel-natural','别继续刚才那件事了'));
 await wait(()=>f.tasks.get(f.store.get('work-natural')!.taskId!)?.state==='cancelled');
 assert.equal(classifications,1);assert.equal(starts,1);assert.equal(f.store.get('cancel-natural')?.text,'别继续刚才那件事了');
});


test('directory approval is owner scoped, durable, and applies once after config reload',t=>{
 const f=fixture(t),m=message('directory-source','需要访问新目录'),newDir=join(f.dir,'new-project');mkdirSync(newDir);
 f.store.enqueue(m);const task=f.tasks.create(f.store.get(m.key)!,{cwd:f.project,policyHash:'p'});f.store.db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(task.id);
 const result=requestDirectory(f.store,f.config,m,task,newDir,'完成尚未开始的文件检查');const id=/DIR-[A-F0-9]{12}/.exec(result)![0];
 assert.equal(loadConfig(f.file).codex.directories?.includes(newDir),false);
 assert.match(decideDirectory(f.store,f.config,id,{...m,senderId:'other'},true),/未找到/);
 const row=f.store.db.prepare('SELECT * FROM outbox WHERE kind=?').get(`directory-approval:${id}`) as any;
 const cards=new Cards(f.store,()=>true,(target,input,yes)=>decideDirectory(f.store,loadConfig(f.file),target,input,yes));
 const payload=cards.prepare(row) as any;const token=payload.elements[1].actions[0].value.namo;
 f.store.db.prepare("UPDATE outbox SET state='sent',platformId='approval-message' WHERE id=?").run(row.id);
 const event={operator:{open_id:'alice'},context:{open_chat_id:'chat',open_message_id:'approval-message'},action:{value:{namo:token}}};
 assert.match(cards.accept({...event,operator:{open_id:'other'}}).toast.content,/无权/);
 assert.match(cards.accept(event).toast.content,/已确认/);assert.match(cards.accept(event).toast.content,/已经处理/);
 let dispatched=0;applyDirectoryRequests(f.store,f.config,()=>{dispatched++;});
 assert.equal(loadConfig(f.file).codex.directories?.includes(newDir),true);assert.equal(getDirectoryRequest(f.store,id)?.state,'saved');assert.equal(dispatched,0);
 applyDirectoryRequests(f.store,loadConfig(f.file),()=>{dispatched++;});applyDirectoryRequests(f.store,loadConfig(f.file),()=>{dispatched++;});
 assert.equal(getDirectoryRequest(f.store,id)?.state,'applied');assert.equal(dispatched,1);
});

test('approved directory is safely reloaded and unfinished work continues once',async t=>{
 const f=fixture(t),newDir=join(f.dir,'approved-folder');mkdirSync(newDir);let watcher:ReturnType<typeof watchConfiguration>|undefined;
 let runs=0;const runtime:Runtime={async run(r){runs++;r.onThread(`test-thread-${runs}`);r.onTurn(`test-turn-${runs}`);
  if(runs===1){const response=r.onControl!({operation:'request_directory',path:newDir,value:'检查该目录中尚未处理的文件'},'request-1') as {result:string};assert.match(response.result,/确认请求/);return {text:response.result,threadId:'test-thread-1',turnId:'test-turn-1'};}
  assert.match(r.prompt,/尚未完成/);return {text:'continued',threadId:`test-thread-${runs}`,turnId:`test-turn-${runs}`};}};
 const host=new RuntimeHost(()=>new Engine(f.store,runtime,{async send(_c,_t,id){return id;}},f.config));
 t.after(async()=>{await watcher?.stop();await host.stop();});host.start();
 watcher=watchConfiguration(f.store,host,f.config,digest(readFileSync(f.file,'utf8')),async next=>()=>new Engine(f.store,runtime,{async send(_c,_t,id){return id;}},next),()=>{},()=>{});
 host.accept(message('directory-integration','请检查目标文件夹'));await wait(()=>f.tasks.get(f.store.get('directory-integration')!.taskId!)?.state==='succeeded');
 const setting=f.store.db.prepare("SELECT key FROM settings WHERE key LIKE 'directory-approval:%'").get();assert.ok(setting);
 const id=String(setting.key).slice('directory-approval:'.length);
 assert.equal(loadConfig(f.file).codex.directories?.includes(newDir),false);
 await wait(()=>!!f.store.db.prepare("SELECT 1 FROM outbox WHERE inboxKey='directory-integration' AND state='sent' AND (kind=? OR kind='result')").get(`directory-approval:${id}`));
 host.accept(message('directory-confirm','可以'));
 await wait(()=>getDirectoryRequest(f.store,id)?.state==='applied',8000);
 await wait(()=>runs===2,8000);assert.equal(loadConfig(f.file).codex.directories?.includes(newDir),true);
 assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM inbox WHERE key=?").get(`directory-continuation:${id}`)?.n,1);
});

test('directory grant rejects unsafe, unauthorized, and stale requests without changing config',t=>{
 const f=fixture(t),m=message('directory-stale','请求访问'),dir=join(f.dir,'project-two');mkdirSync(dir);f.store.enqueue(m);
 const task=f.tasks.create(f.store.get(m.key)!,{cwd:f.project,policyHash:'p'});f.store.db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(task.id);
 assert.throws(()=>requestDirectory(f.store,f.config,{...m,senderId:'outsider'},task,dir,'finish'),/所有者/);
 assert.throws(()=>requestDirectory(f.store,f.config,m,task,'/','finish'));
 const id=/DIR-[A-F0-9]{12}/.exec(requestDirectory(f.store,f.config,m,task,dir,'finish'))![0];
 assert.match(decideDirectory(f.store,f.config,id,m,true),/已确认/);
 const raw=JSON.parse(readFileSync(f.file,'utf8'));raw.codex.model='changed-model';writeFileSync(f.file,JSON.stringify(raw));
 applyDirectoryRequests(f.store,f.config,()=>assert.fail('must not continue'));
 assert.equal(getDirectoryRequest(f.store,id)?.state,'failed');assert.equal(loadConfig(f.file).codex.directories?.includes(dir),false);
});

test('ambiguous natural cancellation never picks between multiple pending tasks',async t=>{
 const f=fixture(t);let starts=0;
 const runtime:Runtime={run(r){starts++;return new Promise((_resolve,reject)=>r.signal.addEventListener('abort',()=>reject(new RuntimeError('cancelled')),{once:true}));},
  async classifyControl(input){return input.text==='another work'?{kind:'task'}:{kind:'control',operation:'cancel',id:input.pending[0].id};}};
 const receiver=new Engine(f.store,runtime,{async send(_c,_text,uuid){return uuid;}},f.config);t.after(()=>receiver.stop());receiver.start();
 receiver.accept(message('work-a','long work'));await wait(()=>starts===1);
 receiver.accept(message('work-b','another work'));await wait(()=>!!f.store.get('work-b')?.taskId);
 receiver.accept(message('ambiguous-cancel','把那个停了'));await wait(()=>!!f.store.db.prepare("SELECT 1 FROM output_sources WHERE inboxKey='ambiguous-cancel' AND kind='result'").get());
 assert.match(String(f.store.db.prepare("SELECT content FROM output_sources WHERE inboxKey='ambiguous-cancel' AND kind='result'").get()?.content),/多个未完成任务/);
 assert.equal(f.tasks.get(f.store.get('work-a')!.taskId!)?.state,'running');assert.equal(f.store.get('work-a')?.cancelRequested,0);
});

test('a generic yes cannot approve an unseen directory request',t=>{
 const f=fixture(t),m=message('unseen-directory','访问目录'),dir=join(f.dir,'unseen');mkdirSync(dir);f.store.enqueue(m);
 const task=f.tasks.create(f.store.get(m.key)!,{cwd:f.project,policyHash:'p'});f.store.db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(task.id);
 const id=/DIR-[A-F0-9]{12}/.exec(requestDirectory(f.store,f.config,m,task,dir,'继续'))![0];
 const receiver=f.receiver();receiver.accept(message('unrelated-yes','可以'));
 assert.equal(getDirectoryRequest(f.store,id)?.state,'pending');assert.equal(loadConfig(f.file).codex.directories?.includes(dir),false);
});

test('approved directory cannot be swapped before configuration is saved',t=>{
 const f=fixture(t),m=message('directory-swapped','请求访问'),dir=join(f.dir,'original');mkdirSync(dir);f.store.enqueue(m);
 const task=f.tasks.create(f.store.get(m.key)!,{cwd:f.project,policyHash:'p'});f.store.db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(task.id);
 const id=/DIR-[A-F0-9]{12}/.exec(requestDirectory(f.store,f.config,m,task,dir,'finish'))![0];decideDirectory(f.store,f.config,id,m,true);
 renameSync(dir,`${dir}-old`);mkdirSync(dir);applyDirectoryRequests(f.store,f.config,()=>assert.fail('must not continue'));
 assert.equal(getDirectoryRequest(f.store,id)?.state,'failed');assert.equal(loadConfig(f.file).codex.directories?.includes(dir),false);
});

test('detached browser worker waits for the owner, survives receiver restart, and resumes once', { skip: process.platform !== 'darwin' || !existsSync(join(process.env.HOME ?? '', '.local/bin/ego-browser')) }, async t => {
  const f=fixture(t), receiver=f.receiver(); receiver.start();
  const server=createServer((_req,res)=>res.end('<title>Namo test page</title><p>Browser fixture</p>')).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));t.after(()=>server.close());
  writeFileSync(join(f.project,'browser-url'),`http://127.0.0.1:${(server.address() as {port:number}).port}/`);
  receiver.accept(message('browser-task','browser-check'));
  await wait(()=>!!f.store.db.prepare("SELECT 1 FROM settings WHERE key LIKE 'mcp-approval:%'").get());
  const row=f.store.db.prepare("SELECT key FROM settings WHERE key LIKE 'mcp-approval:%'").get()!;
  const id=String(row.key).slice('mcp-approval:'.length);
  assert.ok(JSON.parse(readFileSync(join(f.project,'thread-tools'),'utf8').trim()).includes('ego_browser'));
  assert.equal(f.job().state,'running');
  const intruder={...message('browser-intruder',`确认操作 ${id}`),senderId:'mallory'};
  receiver.accept(intruder);
  await wait(()=>f.store.get('browser-intruder')?.state==='replied');
  assert.equal(JSON.parse(String(f.store.db.prepare('SELECT value FROM settings WHERE key=?').get(`mcp-approval:${id}`)?.value)).state,'pending');
  await receiver.stop();
  const resumed=f.receiver();resumed.start();resumed.accept(message('browser-consent',`确认操作 ${id}`));
  await wait(()=>f.store.get('browser-task')?.state==='replied',15000);
  assert.equal(f.job().state,'completed');
  assert.equal(JSON.parse(String(f.store.db.prepare('SELECT value FROM settings WHERE key=?').get(`mcp-approval:${id}`)?.value)).state,'completed');
  assert.match(readFileSync(join(f.project,'mcp-discovery'),'utf8'),/Browser fixture/);
  assert.equal(f.calls(),1);
});

test('additional browser capability needs a second exact approval', { skip: process.platform !== 'darwin' || !existsSync(join(process.env.HOME ?? '', '.local/bin/ego-browser')) }, async t => {
  const f=fixture(t), receiver=f.receiver();receiver.start();
  const server=createServer((_req,res)=>res.end('<title>Namo test page</title><p>Browser fixture</p>')).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));t.after(()=>server.close());
  writeFileSync(join(f.project,'browser-url'),`http://127.0.0.1:${(server.address() as {port:number}).port}/`);
  receiver.accept(message('browser-extra-task','browser-extra'));
  const approvals=()=>f.store.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'mcp-approval:%'").all().map(r=>({id:String(r.key).slice('mcp-approval:'.length),...JSON.parse(String(r.value))}));
  await wait(()=>approvals().length===1);
  receiver.accept(message('browser-extra-first',`确认操作 ${approvals()[0].id}`));
  await wait(()=>approvals().length===2,12000);
  const second=approvals().find(x=>x.tool==='press')!;
  assert.deepEqual(second.arguments,{selector:'body',key:'Tab'});
  assert.equal(second.state,'pending');
  assert.equal(existsSync(join(f.project,'browser-press-result')),false);
  receiver.accept(message('browser-extra-second',`确认操作 ${second.id}`));
  await wait(()=>f.store.get('browser-extra-task')?.state==='replied',12000);
  assert.equal(approvals().find(x=>x.id===second.id).state,'completed');
  assert.match(readFileSync(join(f.project,'browser-press-result'),'utf8'),/Browser fixture/);
});

test('browser tool is unavailable to group chats', { skip: process.platform !== 'darwin' || !existsSync(join(process.env.HOME ?? '', '.local/bin/ego-browser')) }, async t => {
  const f=fixture(t), receiver=f.receiver();receiver.start();
  const group=message('browser-group','instant','group-chat');group.envelope!.chatType='group';
  receiver.accept(group);await wait(()=>f.store.get('browser-group')?.state==='replied');
  const task=f.tasks.get(f.store.get('browser-group')!.taskId!)!;
  assert.equal(JSON.parse(readFileSync(join(task.cwd,'thread-tools'),'utf8').trim()).includes('ego_browser'),false);
});

test('permanent browser grant persists across workers, includes press, and revocation restores confirmation', { skip: process.platform !== 'darwin' || !existsSync(join(process.env.HOME ?? '', '.local/bin/ego-browser')) }, async t => {
 const f=fixture(t), receiver=f.receiver();receiver.start();
 const server=createServer((_req,res)=>res.end('<title>Namo test page</title><p>Browser fixture</p>')).listen(0,'127.0.0.1');
 await new Promise<void>(resolve=>server.once('listening',resolve));t.after(()=>server.close());
 writeFileSync(join(f.project,'browser-url'),`http://127.0.0.1:${(server.address() as {port:number}).port}/`);
 const approvals=()=>f.store.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'mcp-approval:%'").all().map(r=>({id:String(r.key).slice('mcp-approval:'.length),...JSON.parse(String(r.value))}));
 receiver.accept(message('always-first','browser-extra'));await wait(()=>approvals().length===1);
 receiver.accept(message('always-approve',`永久允许 ${approvals()[0].id}`));
 await wait(()=>f.store.get('always-first')?.state==='replied',15000);
 assert.equal(approvals().length,1);assert.equal(approvals()[0].state,'completed');assert.match(readFileSync(join(f.project,'browser-press-result'),'utf8'),/Browser fixture/);
 receiver.accept(message('always-second','browser-extra'));await wait(()=>f.store.get('always-second')?.state==='replied',15000);
 assert.equal(approvals().length,1);
 receiver.accept(message('always-revoke','撤销浏览器永久授权'));await wait(()=>f.store.get('always-revoke')?.state==='replied');
 receiver.accept(message('always-third','browser-check'));await wait(()=>approvals().length===2,15000);
 const pending=approvals().find(a=>a.state==='pending');assert.equal(pending.tool,'task_browser_access');
 receiver.accept(message('always-reject',`拒绝操作 ${pending.id}`));await wait(()=>f.store.get('always-third')?.state==='replied',15000);
});

test('press confirmation can enable the permanent browser option for subsequent tasks', { skip: process.platform !== 'darwin' || !existsSync(join(process.env.HOME ?? '', '.local/bin/ego-browser')) }, async t => {
 const f=fixture(t),receiver=f.receiver();receiver.start();
 const server=createServer((_req,res)=>res.end('<title>Namo test page</title><p>Browser fixture</p>')).listen(0,'127.0.0.1');
 await new Promise<void>(resolve=>server.once('listening',resolve));t.after(()=>server.close());
 writeFileSync(join(f.project,'browser-url'),`http://127.0.0.1:${(server.address() as {port:number}).port}/`);
 const approvals=()=>f.store.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'mcp-approval:%'").all().map(r=>({id:String(r.key).slice('mcp-approval:'.length),...JSON.parse(String(r.value))}));
 receiver.accept(message('press-always-first','browser-extra'));await wait(()=>approvals().length===1);
 receiver.accept(message('press-always-once',`确认操作 ${approvals()[0].id}`));await wait(()=>approvals().length===2,15000);
 const press=approvals().find(a=>a.tool==='press');assert.equal(press.state,'pending');
 receiver.accept(message('press-always-enable',`永久允许 ${press.id}`));await wait(()=>f.store.get('press-always-first')?.state==='replied',15000);
 assert.equal(approvals().find(a=>a.id===press.id).state,'completed');
 receiver.accept(message('press-always-next','browser-check'));await wait(()=>f.store.get('press-always-next')?.state==='replied',15000);
 assert.equal(approvals().length,2);
});
