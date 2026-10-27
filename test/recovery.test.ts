import { waitFor } from './helpers.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Incoming } from '../src/store.js';
import { Recovery } from '../src/recovery.js';
import { Tasks } from '../src/tasks.js';
import { Engine, SendError, type Sender } from '../src/engine.js';
import { spawn } from 'node:child_process';
import { Waits } from '../src/waits.js';
import { type Runtime, type RunRequest, type RunResult } from '../src/runtime.js';

const actor={id:'alice',chatKey:'chat'};
const input={key:'input',messageId:'input',chatKey:'chat',chatId:'chat',senderId:'alice',text:'do something'};
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'namo-recovery-'));const s=new Store(join(dir,'bot.sqlite'));t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});s.enqueue(input);s.claim(input.key);s.finish(input.key,'saved result');const o=s.nextOutput()!;s.sending(o.id);s.deliveryFailed(o.id,true,'transport_unknown');return {dir,s,r:new Recovery(s),o};}
function request(r:Recovery,id:number,action:string,note='已核对飞书记录'){const x=r.inspect(`D-${id}`,actor);return {subject:x.subject,stamp:x.stamp,action,note,requestId:'request',acknowledgeDuplicate:true};}

test('legacy delivery confirmation never invents execution success or a platform receipt',t=>{const {s,r,o}=fixture(t);r.resolve(request(r,o.id,'received'),actor);assert.equal(s.db.prepare('SELECT state FROM outbox WHERE id=?').get(o.id)?.state,'confirmed');assert.equal(s.db.prepare('SELECT platformId FROM outbox WHERE id=?').get(o.id)?.platformId,null);assert.equal(s.get(input.key)?.state,'delivery_closed');assert.equal(s.db.prepare('SELECT error FROM inbox WHERE key=?').get(input.key)?.error,'legacy_execution_unverified');assert.equal(s.nextOutput(),undefined);assert.equal(r.list(actor).length,0);});
test('unknown send requires duplicate acknowledgement; retry preserves evidence, changes UUID and is idempotent',t=>{const {s,r,o}=fixture(t);const req=request(r,o.id,'retry');assert.throws(()=>r.resolve({...req,acknowledgeDuplicate:false},actor),/明确确认/);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM reconciliations').get()?.n,0);r.resolve(req,actor);const next=s.nextOutput()!;assert.notEqual(next.uuid,o.uuid);assert.equal(next.content,o.content);assert.deepEqual(r.resolve(req,actor),{duplicate:true});const audit=s.db.prepare('SELECT beforeState FROM reconciliations').get();assert.equal(JSON.parse(String(audit?.beforeState)).uuid,o.uuid);assert.throws(()=>r.resolve({...req,action:'dismiss'},actor),/操作编号/);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM reconciliations').get()?.n,1);});
test('ownership and stale observations cannot resolve an unknown send',t=>{const {s,r,o}=fixture(t),req=request(r,o.id,'received');assert.throws(()=>r.resolve(req,{id:'bob',chatKey:'chat'}),/可访问/);assert.throws(()=>r.resolve(req,{id:'alice',chatKey:'elsewhere'}),/可访问/);s.db.prepare('UPDATE outbox SET error=? WHERE id=?').run('changed',o.id);assert.throws(()=>r.resolve(req,actor),/记录已变化/);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM reconciliations').get()?.n,0);});
test('dismissed segment unblocks later segments but final status is delivery_closed',t=>{const {s,r,o}=fixture(t);s.db.prepare("INSERT INTO outbox(inboxKey,chatId,kind,part,content,uuid,createdAt) VALUES('input','chat','result',1,'second','another',0)").run();assert.equal(s.nextOutput(),undefined);r.resolve(request(r,o.id,'dismiss'),actor);const next=s.nextOutput()!;assert.equal(next.part,1);s.sending(next.id);s.sent(next.id,'receipt');assert.equal(s.get(input.key)?.state,'delivery_closed');});
test('task review retains interrupted state and audit without opening another task',t=>{const {s,r}=fixture(t);s.enqueue({...input,key:'task',messageId:'task'});const tasks=new Tasks(s);const task=tasks.create(s.get('task')!,{cwd:'/tmp',policyHash:'test'});tasks.start(task);s.recover();tasks.recover();const x=r.inspect(task.id,actor);r.resolve({subject:task.id,stamp:x.stamp,action:'reviewed',note:'已核对无外部副作用',requestId:'task-review'},actor);assert.equal(tasks.get(task.id)?.state,'interrupted');assert.equal(r.inspect(task.id,actor).reviewed,true);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM tasks').get()?.n,1);assert.equal(r.list(actor).filter(x=>x.type==='task').length,0);});
test('explicit result retry sends stored output without invoking the model twice',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-retry-engine-')),s=new Store(join(dir,'bot.sqlite'));let modelCalls=0,sends=0;const e=new Engine(s,{async run(){modelCalls++;return {text:'answer',threadId:'t',turnId:'u'};}},{async send(_c,text,id){if(text==='answer'&&sends++===0)throw new SendError(true,'unknown');return id;}},{dataDir:dir,concurrency:1});
 t.after(async()=>{await e.stop();s.close();rmSync(dir,{recursive:true,force:true});});e.start();e.accept(input);await waitFor(()=>s.get(input.key)?.state==='delivery_unknown');const row=s.db.prepare("SELECT id FROM outbox WHERE state='unknown'").get()!;const r=new Recovery(s);r.resolve(request(r,Number(row.id),'retry'),actor);await waitFor(()=>s.get(input.key)?.state==='replied');assert.equal(modelCalls,1);assert.equal(sends,2);
});
test('failed audit transaction leaves delivery untouched',t=>{const {s,r,o}=fixture(t);s.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON reconciliations BEGIN SELECT RAISE(ABORT,'disk_error'); END");assert.throws(()=>r.resolve(request(r,o.id,'retry'),actor),/disk_error/);assert.equal(s.db.prepare('SELECT state FROM outbox WHERE id=?').get(o.id)?.state,'unknown');});

const until = (condition: () => boolean, timeoutMs = 8000) => waitFor(condition, timeoutMs);
const message = (key: string, text: string): Incoming => ({ key, messageId: key, chatId: 'chat', chatKey: 'chat', senderId: 'alice', text });
function waitResult(r: RunRequest): RunResult {
  r.onThread('durable-thread'); r.onTurn('first-turn');
  const request = { threadId: 'durable-thread', turnId: 'first-turn', callId: 'question', question: 'Which branch?' };
  return { text: '', threadId: request.threadId, turnId: request.turnId, waiting: { ...request, id: r.onWait!(request) } };
}
function recoveryCombinationsFixture(t: TestContext, runtime: Runtime, sender?: Sender) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'namo-recovery-combinations-')));
  const project = join(root, 'project'); mkdirSync(project);
  const database = join(root, 'bot.sqlite');
  const config = { dataDir: root, concurrency: 1, codex: { bin: 'unused', home: join(root, 'home'), timeoutMs: 5000,
    sandbox: 'workspace-write' as const, projects: { one: project }, defaultProject: 'one' } };
  let store = new Store(database), engine: Engine;
  const fatals: string[] = [];
  const makeEngine = () => new Engine(store, runtime, sender ?? { async send(_chat, _text, uuid) { return uuid; } },
    config, undefined, undefined, code => fatals.push(code));
  engine = makeEngine();
  t.after(async () => { await engine.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { database, fatals, get store() { return store; }, get engine() { return engine; },
    async reopen(start = true) { await engine.stop(); store.close(); store = new Store(database); engine = makeEngine(); if (start) engine.start(); },
  };
}

test('answer persisted while receiver is offline survives two database reopens and resumes once', async t => {
  const prompts: RunRequest[] = [];
  const f = recoveryCombinationsFixture(t, { async run(r) {
    prompts.push(r);
    if (prompts.length === 1) return waitResult(r);
    assert.equal(r.threadId, 'durable-thread');
    assert.equal(JSON.parse(r.prompt).reply, 'blue');
    assert.doesNotMatch(r.prompt, /ORIGINAL_ACTION/);
    return { text: 'done', threadId: r.threadId!, turnId: 'second-turn' };
  } });
  f.engine.start(); f.engine.accept(message('root', 'ORIGINAL_ACTION'));
  await until(() => new Tasks(f.store).get(f.store.get('root')?.taskId ?? '')?.state === 'waiting');
  const taskId = f.store.get('root')!.taskId!, waitId = new Waits(f.store).current(taskId)!.id;
  await f.reopen(false);
  const answer = message('answer', `/resume ${waitId} blue`);
  assert.equal(f.engine.accept(answer), true);
  assert.equal(new Tasks(f.store).get(taskId)?.state, 'queued');
  await f.reopen();
  assert.equal(f.engine.accept(answer), false);
  await until(() => f.store.get('root')?.state === 'replied');
  assert.equal(prompts.length, 2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_runs WHERE taskId=?').get(taskId)?.n, 2);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM task_messages WHERE role='wait_reply'").get()?.n, 1);
  assert.deepEqual(f.fatals, []);
});

async function answerCancelRace(t: TestContext, order: 'simultaneous' | 'answer-first' | 'cancel-first') {
  let calls = 0;
  const f = recoveryCombinationsFixture(t, { async run(r) { calls++; return waitResult(r); } });
  f.engine.start(); f.engine.accept(message('root', 'ORIGINAL_ACTION'));
  await until(() => new Tasks(f.store).get(f.store.get('root')?.taskId ?? '')?.state === 'waiting');
  const taskId = f.store.get('root')!.taskId!, waitId = new Waits(f.store).current(taskId)!.id;
  await f.engine.stop();
  // Preserve the real resume command in the durable inbox. If cancellation wins,
  // a rejected answer must not be replayed as an unrelated ordinary instruction.
  const answer = message('answer', `/resume ${waitId} blue`); f.store.enqueue(answer);
  const moduleUrl = (name: string) => new URL(`../src/${name}.js`, import.meta.url).href;
  const children = ['answer', 'cancel'].map(action => {
    const code = `import {Store} from ${JSON.stringify(moduleUrl('store'))};
import {Tasks} from ${JSON.stringify(moduleUrl('tasks'))};
import {Waits} from ${JSON.stringify(moduleUrl('waits'))};
const s=new Store(process.argv[1]);
process.send('ready');
process.once('message',()=>{
 let accepted=false;
 try { s.transaction(()=>{
  if(process.argv[2]==='answer') { new Waits(s).answer(new Waits(s).get(process.argv[4]),s.get('answer'),'blue'); accepted=true; }
  else accepted=new Tasks(s).cancel(new Tasks(s).get(process.argv[3]));
 }); } catch {} finally { s.close(); }
 process.send({accepted},()=>process.disconnect());
});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.database, action, taskId, waitId], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let ready!: () => void, result!: (value: boolean) => void;
    const prepared = new Promise<void>((resolve, reject) => {
      ready = resolve; child.once('error', reject);
      child.once('exit', () => reject(new Error('race_child_exited_before_ready')));
    });
    const finished = new Promise<boolean>((resolve, reject) => {
      result = resolve; child.once('error', reject);
      child.once('exit', code => { if (code !== 0) reject(new Error('race_child_failed')); });
    });
    child.on('message', value => { if (value === 'ready') ready(); else result((value as { accepted: boolean }).accepted); });
    return { child, prepared, finished };
  });
  await Promise.all(children.map(c => c.prepared));
  if (order === 'simultaneous') children.forEach(c => c.child.send('go'));
  else {
    const first = order === 'answer-first' ? 0 : 1;
    children[first].child.send('go');
    assert.equal(await children[first].finished, true);
    children[1 - first].child.send('go');
  }
  const [answered, cancelled] = await Promise.all(children.map(c => c.finished));
  if (order !== 'simultaneous') assert.equal(answered, order === 'answer-first');
  assert.equal(cancelled, true);
  await f.reopen();
  f.engine.accept(message('late', `/resume ${waitId} late`));
  await until(() => f.store.get('late')?.state === 'replied');
  assert.equal(new Tasks(f.store).get(taskId)?.state, 'cancelled');
  assert.equal(calls, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_runs WHERE taskId=?').get(taskId)?.n, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE inboxKey='root' AND kind='result'").get()?.n, 1);
  assert.deepEqual(f.fatals, []);
}

test('simultaneous answer and cancellation use independent SQLite writers; acknowledged cancel cannot resume after restart',
  { timeout: 30_000 }, t => answerCancelRace(t, 'simultaneous'));
test('answer committed before cancellation cannot resume or create another task after restart',
  { timeout: 30_000 }, t => answerCancelRace(t, 'answer-first'));
test('cancellation committed before an answer cannot turn the rejected resume command into a new task',
  { timeout: 30_000 }, t => answerCancelRace(t, 'cancel-first'));

test('platform acceptance followed by receipt storage failure stays unknown across restart; explicit retry sends only saved output', async t => {
  let calls = 0;
  const sent: { uuid: string; text: string }[] = [];
  const f = recoveryCombinationsFixture(t, { async run() { calls++; return { text: 'SAVED_RESULT', threadId: 'thread', turnId: 'turn' }; } },
    { async send(_chat, text, uuid) { if (text === 'SAVED_RESULT') sent.push({ uuid, text }); return `platform-${uuid}`; } });
  f.store.db.exec(`CREATE TRIGGER receipt_failure BEFORE UPDATE OF state ON outbox
    WHEN OLD.kind='result' AND NEW.state='sent' BEGIN SELECT RAISE(ABORT,'fixture_receipt_failure'); END`);
  f.engine.start(); f.engine.accept(message('root', 'ORIGINAL_ACTION'));
  await until(() => f.fatals.includes('outbox_storage_error'));
  const original = f.store.db.prepare("SELECT * FROM outbox WHERE inboxKey='root' AND kind='result'").get()!;
  assert.equal(original.state, 'sending'); assert.equal(original.platformId, null);
  assert.equal(sent.length, 1);
  f.store.db.exec('DROP TRIGGER receipt_failure');
  await f.reopen();
  const recovery = new Recovery(f.store), subject = `D-${original.id}`, actor = { id: 'alice', chatKey: 'chat' };
  const issue = recovery.inspect(subject, actor);
  assert.equal(issue.state, 'unknown'); assert.equal(issue.platformReceipt, false);
  assert.equal(f.store.nextOutput(), undefined);
  assert.equal(new Tasks(f.store).get(f.store.get('root')!.taskId!)?.state, 'succeeded');
  const request = { subject, stamp: issue.stamp, action: 'retry', note: 'fixture: duplicate risk accepted', requestId: 'retry', acknowledgeDuplicate: true };
  assert.throws(() => recovery.resolve({ ...request, acknowledgeDuplicate: false }, actor));
  recovery.resolve(request, actor);
  assert.deepEqual(recovery.resolve(request, actor), { duplicate: true });
  await until(() => f.store.get('root')?.state === 'replied');
  assert.equal(calls, 1); assert.equal(sent.length, 2);
  assert.equal(sent[0].text, sent[1].text); assert.notEqual(sent[0].uuid, sent[1].uuid);
  await f.reopen(); await f.engine.pump();
  assert.equal(calls, 1); assert.equal(sent.length, 2);
});

test('lost worker review cannot release a project while runtime descendants outlive their group leader', { skip: process.platform === 'win32' }, async t => {
  const f = recoveryCombinationsFixture(t, { async run() { throw new Error('no inference allowed'); } });
  // The detached runtime leader exits, but its child stays in the same process
  // group. Checking only the recorded PID incorrectly reports this as stopped.
  const leader = spawn(process.execPath, ['--input-type=module', '-e', `
import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
child.unref();process.send({pid:child.pid},()=>process.disconnect());
`], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const group = leader.pid!;
  t.after(() => { try { process.kill(-group, 'SIGKILL'); } catch {} });
  const descendant = await new Promise<number>((resolve, reject) => {
    leader.once('error', reject); leader.once('message', value => resolve((value as { pid: number }).pid));
  });
  await new Promise<void>(resolve => { if (leader.exitCode !== null) resolve(); else leader.once('exit', () => resolve()); });
  assert.throws(() => process.kill(group, 0), { code: 'ESRCH' });
  process.kill(descendant, 0); process.kill(-group, 0);
  f.engine.accept(message('root', 'ORIGINAL_ACTION'));
  const tasks = new Tasks(f.store), task = tasks.get(f.store.get('root')!.taskId!)!, run = tasks.start(task);
  f.store.db.prepare(`INSERT INTO runner_jobs(runId,owner,state,pid,runtimePid,createdAt,updatedAt,configRevision,prompt,error)
    VALUES(?,?,'lost',?,?,0,0,'fixture','fixture','runner_lost')`).run(run, 'fixture-owner', group, group);
  tasks.finish(task, run, 'lost', 'runner_lost');
  const recovery = new Recovery(f.store), issue = recovery.inspect(task.id);
  const request = { subject: task.id, stamp: issue.stamp, action: 'reviewed', note: 'fixture local review', requestId: 'group-review' };
  assert.throws(() => recovery.resolve(request, { id: 'local-owner' }, true), /PID|进程组/);
  assert.equal(f.store.db.prepare('SELECT state FROM runner_jobs WHERE runId=?').get(run)?.state, 'lost');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM reconciliations').get()?.n, 0);
  process.kill(descendant, 0); // Review must not terminate a process for the user.
  process.kill(-group, 'SIGKILL');
  await until(() => { try { process.kill(-group, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; } });
  recovery.resolve(request, { id: 'local-owner' }, true);
  assert.equal(f.store.db.prepare('SELECT state FROM runner_jobs WHERE runId=?').get(run)?.state, 'reviewed');
});
