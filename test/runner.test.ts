import { waitFor } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { Store, type Incoming } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { RunnerRuntime } from '../src/runner.js';
import { Tasks } from '../src/tasks.js';
import { reconcileRunner, processState, runnerJob } from '../src/runner-store.js';
import { Recovery } from '../src/recovery.js';
import { digest } from '../src/paths.js';
import { Management } from '../src/management.js';
import { Cards } from '../src/cards.js';
import { setUserModel } from '../src/model-preferences.js';

const wait = (condition: () => boolean, timeoutMs = 7000) => waitFor(condition, timeoutMs);
const fake = `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {appendFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
let cwd,thread='thread',turn='turn',timer;
process.on('SIGTERM',()=>{if(!cwd||!existsSync(join(cwd,'hold-close')))process.exit(0);appendFileSync(join(cwd,'closing'),'ready');setInterval(()=>{if(existsSync(join(cwd,'exit-now'))){appendFileSync(join(cwd,'exiting'),'ready');process.exit(0);}},5);});
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const done=text=>{clearInterval(timer);send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'command',type:'commandExecution',command:'node --test',cwd,status:'completed',exitCode:0,durationMs:12}}});send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed',items:[{id:'final',type:'agentMessage',phase:'final_answer',text}]}}});};
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 if(m.method==='initialize')return send({id:m.id,result:{}});
 if(m.method==='config/read')return send({id:m.id,result:{config:{}}});
 if(m.method==='model/list')return send({id:m.id,result:{data:[{model:'default-model',isDefault:true}],nextCursor:null}});
 if(m.method==='plugin/list')return send({id:m.id,result:{marketplaces:[]}});
 if(m.method==='skills/list')return send({id:m.id,result:{data:[{cwd:m.params.cwds[0],skills:[],errors:[]}]}});
 if(m.method==='thread/start'||m.method==='thread/resume'){cwd=m.params.cwd;appendFileSync(join(cwd,'model-params'),JSON.stringify({thread:m.params.model})+'\\n');return send({id:m.id,result:{thread:{id:thread}}});}
 if(m.method==='turn/start'){
  appendFileSync(join(cwd,'model-params'),JSON.stringify({turn:m.params.model})+'\\n');
  appendFileSync(join(cwd,'calls'),'turn\\n');send({id:m.id,result:{turn:{id:turn}}});
  send({method:'item/started',params:{threadId:thread,turnId:turn,item:{id:'command',type:'commandExecution',command:'node --test',cwd,status:'inProgress'}}});
  const prompt=JSON.parse(m.params.input[0].text);
  if(prompt.messages[0].text==='instant')return done('saved answer');
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
  const data = join(dir, 'data'), project = join(dir, 'project'); mkdirSync(project); mkdirSync(data);
  const bin = join(dir, 'fake.mjs'); writeFileSync(bin, fake, { mode: 0o700 });
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ dataDir: data, feishu: { appId: 'app', appSecret: 'TEST_PRIVATE_VALUE', allowedUserIds: ['alice'] },
    concurrency: 2, codex: { bin, home: join(data, 'home'), timeoutMs: 12000, sandbox: 'workspace-write', projects: { one: project }, defaultProject: 'one' } }));
  const config = loadConfig(file), store = new Store(join(data, 'bot.sqlite')), tasks = new Tasks(store);
  const engines: Engine[] = [], deliveries: string[] = [];
  const receiver = () => {
    const engine = new Engine(store, new RunnerRuntime(store, config), { async send(_chat, text, uuid) { deliveries.push(text); return uuid; } }, config);
    engines.push(engine); return engine;
  };
  const job = () => store.db.prepare('SELECT * FROM runner_jobs ORDER BY createdAt DESC LIMIT 1').get() as any;
  const calls = () => existsSync(join(project, 'calls')) ? readFileSync(join(project, 'calls'), 'utf8').trim().split('\n').length : 0;
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
  raw.codex.projectAccess = { one: { organization: false, userIds: ['alice'], chatIds: [], permission: 'workspace-write' } };
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

test('saving presentation settings does not cancel an organization worker; revocation still does', async t => {
  const f = fixture(t), input = organization(f), receiver = f.receiver(); receiver.start(); receiver.accept(input);
  await wait(() => f.calls() === 1);
  const manager = new Management(f.file, { status: () => ({ running: false, mode: 'stopped' }) });
  manager.save(manager.config().revision, { progressIntervalMs: 9000 });
  const heartbeat = f.job().updatedAt;
  await wait(() => f.job().state !== 'running' || f.job().updatedAt > heartbeat + 400);
  assert.equal(f.job().state, 'running');
  manager.save(manager.config().revision, { projectAccess: { one: { organization: false, userIds: [], chatIds: [], permission: 'workspace-write' } } });
  await wait(() => f.job().state === 'failed');
  assert.equal(f.calls(), 1); assert.equal(f.job().result, null);
});

test('an unrelated organization grant change does not interrupt or withhold a running task',async t=>{
 const f=fixture(t),input=organization(f),receiver=f.receiver();receiver.start();receiver.accept(input);
 await wait(()=>f.calls()===1);
 const raw=JSON.parse(readFileSync(f.file,'utf8'));raw.codex.projectAccess.one.userIds.push('bob');
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
 const raw=JSON.parse(readFileSync(f.file,'utf8'));raw.codex.projectAccess.one.userIds=[];writeFileSync(f.file,JSON.stringify(raw));
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
  const raw=JSON.parse(readFileSync(f.file,'utf8'));raw.codex.projects.one=join(f.dir,'finished-project');
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
  const raw = JSON.parse(readFileSync(f.file, 'utf8')); raw.concurrency = 1; raw.codex.projects.two = other;
  writeFileSync(f.file, JSON.stringify(raw)); Object.assign(f.config, loadConfig(f.file));
  const first = f.receiver(); first.start(); first.accept(message('a'));
  await wait(() => f.calls() === 1); await first.stop();
  const next = f.receiver(); next.start(); next.accept(message('switch', '/project two', 'other-chat'));
  next.accept(message('b', 'instant', 'other-chat'));
  await new Promise(r => setTimeout(r, 400)); assert.equal(existsSync(join(other, 'calls')), false);
  writeFileSync(join(f.project, 'release'), 'release');
  await wait(() => f.store.get('b')?.state === 'replied');
  assert.equal(readFileSync(join(other, 'calls'), 'utf8').trim(), 'turn');
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
