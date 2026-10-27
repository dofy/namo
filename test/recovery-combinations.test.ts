import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Engine, type Sender } from '../src/engine.js';
import { Store, type Incoming } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { Waits } from '../src/waits.js';
import { Recovery } from '../src/recovery.js';
import type { Runtime, RunRequest, RunResult } from '../src/runtime.js';

const until = async (fn: () => boolean) => {
  const end = Date.now() + 8000;
  while (!fn()) { if (Date.now() > end) throw new Error('condition_timeout'); await new Promise(r => setTimeout(r, 10)); }
};
const message = (key: string, text: string): Incoming => ({ key, messageId: key, chatId: 'chat', chatKey: 'chat', senderId: 'alice', text });
function waitResult(r: RunRequest): RunResult {
  r.onThread('durable-thread'); r.onTurn('first-turn');
  const request = { threadId: 'durable-thread', turnId: 'first-turn', callId: 'question', question: 'Which branch?' };
  return { text: '', threadId: request.threadId, turnId: request.turnId, waiting: { ...request, id: r.onWait!(request) } };
}
function fixture(t: TestContext, runtime: Runtime, sender?: Sender) {
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
  const f = fixture(t, { async run(r) {
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

test('simultaneous answer and cancellation use independent SQLite writers; acknowledged cancel cannot resume after restart', { timeout: 30_000 }, async t => {
  let calls = 0;
  const f = fixture(t, { async run(r) { calls++; return waitResult(r); } });
  f.engine.start(); f.engine.accept(message('root', 'ORIGINAL_ACTION'));
  await until(() => new Tasks(f.store).get(f.store.get('root')?.taskId ?? '')?.state === 'waiting');
  const taskId = f.store.get('root')!.taskId!, waitId = new Waits(f.store).current(taskId)!.id;
  await f.engine.stop();
  // Persist the real resume command. A bare unlinked "blue" is a new task if
  // cancellation wins, which would test routing a new instruction, not resume.
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
  children.forEach(c => c.child.send('go'));
  const [, cancelled] = await Promise.all(children.map(c => c.finished));
  assert.equal(cancelled, true);
  await f.reopen();
  f.engine.accept(message('late', `/resume ${waitId} late`));
  await until(() => f.store.get('late')?.state === 'replied');
  assert.equal(new Tasks(f.store).get(taskId)?.state, 'cancelled');
  assert.equal(calls, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_runs WHERE taskId=?').get(taskId)?.n, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE inboxKey='root' AND kind='result'").get()?.n, 1);
  assert.deepEqual(f.fatals, []);
});

test('platform acceptance followed by receipt storage failure stays unknown across restart; explicit retry sends only saved output', async t => {
  let calls = 0;
  const sent: { uuid: string; text: string }[] = [];
  const f = fixture(t, { async run() { calls++; return { text: 'SAVED_RESULT', threadId: 'thread', turnId: 'turn' }; } },
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
  const f = fixture(t, { async run() { throw new Error('no inference allowed'); } });
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
