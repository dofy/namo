import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, type Incoming } from '../src/store.js';
import { Engine, pathsOverlap } from '../src/engine.js';
import { Tasks } from '../src/tasks.js';
import { RuntimeError, type RunRequest, type Runtime } from '../src/runtime.js';

const wait = async (fn: () => boolean) => {
  const until = Date.now() + 6000;
  while (!fn()) { if (Date.now() > until) throw new Error('condition_timeout'); await new Promise(r => setTimeout(r, 10)); }
};
function msg(key: string, text = '开发任务', scope = 'chat', owner = 'alice'): Incoming {
  return { key, messageId: key, chatKey: 'chat', chatId: 'chat', senderId: owner, text,
    envelope: { version: 1, type: 'text', kind: 'instruction', scopeKey: scope, materials: [], limitations: [] } };
}
const result = { text: 'answer', threadId: 'thread', turnId: 'turn' };
function setup(t: { after: (fn: () => void | Promise<void>) => void }, runtime?: Runtime, projects = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'namo-tasks-')));
  for (const p of ['one', 'two']) mkdirSync(join(dir, p));
  const store = new Store(join(dir, 'bot.sqlite')); const tasks = new Tasks(store); const prompts: string[] = [];
  const codex = { bin: 'codex', home: join(dir, 'auth'), timeoutMs: 10_000, sandbox: 'workspace-write' as const,
    ...(projects ? { projects: { one: join(dir, 'one'), two: join(dir, 'two') }, defaultProject: 'one' } : {}) };
  const config = { dataDir: dir, concurrency: 3, codex };
  const engine = new Engine(store, runtime ?? { async run(r) { prompts.push(r.prompt); r.onThread('thread'); r.onTurn('turn'); return result; } },
    { async send(_c, _t, uuid) { return uuid; } }, config);
  t.after(async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, tasks, engine, prompts, config };
}

test('legacy database migration preserves rows, settings and session ids and is repeatable', t => {
  const dir = mkdtempSync(join(tmpdir(), 'namo-migrate-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'legacy.sqlite'); const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE inbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT NOT NULL UNIQUE,messageId TEXT NOT NULL,chatKey TEXT NOT NULL,chatId TEXT NOT NULL,senderId TEXT NOT NULL,text TEXT NOT NULL,createdAt INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'queued',cancelRequested INTEGER NOT NULL DEFAULT 0,threadId TEXT,turnId TEXT,error TEXT,finishedAt INTEGER);
    CREATE TABLE sessions(chatKey TEXT PRIMARY KEY,threadId TEXT NOT NULL); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO inbox(key,messageId,chatKey,chatId,senderId,text,createdAt,state) VALUES('old','old','chat','chat','alice','原话',1,'replied');
    INSERT INTO sessions VALUES('chat','legacy-thread'); INSERT INTO settings VALUES('project:chat','one');`);
  old.close();
  for (let i = 0; i < 2; i++) {
    const s = new Store(file);
    assert.equal(s.get('old')?.text, '原话'); assert.equal(s.get('old')?.state, 'replied'); assert.equal(s.get('old')?.envelope, undefined);
    assert.equal(s.thread('chat'), 'legacy-thread'); assert.equal(s.project('chat'), 'one');
    assert.equal(s.db.prepare('PRAGMA user_version').get()?.user_version, 2); s.close();
  }
});

test('future schema is refused before any schema changes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'namo-version-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'future.sqlite'); const db = new DatabaseSync(file); db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => new Store(file), /数据库版本较新/);
  const check = new DatabaseSync(file, { readOnly: true });
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get()?.n, 0); check.close();
});

test('materials wait without inference, keep ownership and scope, and join one explicit task', async t => {
  const { store, tasks, engine, prompts } = setup(t); engine.start();
  engine.accept(msg('material', '/material 参考：不要修改接口'));
  engine.accept(msg('other', '/material 另一话题', 'other-topic'));
  engine.accept(msg('bob', '/material 别人的材料', 'chat', 'bob'));
  assert.equal(prompts.length, 0); assert.equal(store.get('material')?.state, 'material');
  engine.accept(msg('run', '/run 根据材料修复 UI'));
  await wait(() => tasks.list(msg('x'))[0]?.state === 'succeeded');
  assert.equal(prompts.length, 1); const input = JSON.parse(prompts[0]);
  assert.deepEqual(input.messages.map((m: { role: string }) => m.role), ['instruction', 'material']);
  assert.match(prompts[0], /不要修改接口/); assert.doesNotMatch(prompts[0], /另一话题|别人的材料/);
  assert.equal(store.get('material')?.state, 'linked'); assert.equal(store.get('other')?.state, 'material');
});

test('expired materials are retained and produce one notice without opening a task', t => {
  const { store, tasks, engine } = setup(t); engine.accept(msg('m', '/material /cancel'));
  store.db.prepare('UPDATE inbox SET materialUntil=0 WHERE key=?').run('m'); tasks.expireMaterials(); tasks.expireMaterials();
  assert.equal(store.get('m')?.state, 'material_expired'); assert.equal(tasks.list(msg('x')).length, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE inboxKey='m' AND kind='notice'").get()?.n, 1);
});

test('replying to a pending material opens a task with that material rather than rejecting the quote', async t => {
  const f = setup(t); f.engine.accept(msg('material', '/material 需求原文'));
  const instruction = msg('instruction', '照此实现'); instruction.envelope!.parentId = 'material';
  f.engine.accept(instruction); f.engine.start(); await wait(() => f.tasks.list(msg('x'))[0]?.state === 'succeeded');
  assert.match(f.prompts[0], /需求原文/); assert.equal(f.store.get('material')?.taskId, f.store.get('instruction')?.taskId);
});

test('queued amendment is part of the same task and duplicate events never append it twice', async t => {
  const { store, tasks, engine, prompts } = setup(t); engine.accept(msg('first'));
  const task = tasks.list(msg('x'))[0]; const amendment = msg('change', `/amend ${task.id} 只修改前端`);
  engine.accept(amendment); assert.equal(engine.accept(amendment), false);
  assert.equal(tasks.get(task.id)?.inputVersion, 2); assert.equal(tasks.list(msg('x')).length, 1);
  engine.start(); await wait(() => tasks.get(task.id)?.state === 'succeeded');
  assert.equal(prompts.length, 1); assert.match(prompts[0], /只修改前端/);
  assert.equal(store.db.prepare("SELECT dispatch FROM task_messages WHERE inboxKey='change'").get()?.dispatch, 'applied');
});

for (const outcome of ['accepted', 'not_active', 'rejected', 'unknown'] as const) {
  test(`running amendment records ${outcome} and never starts a second model run`, async t => {
    let request: RunRequest | undefined; let complete: ((v: typeof result) => void) | undefined; let calls = 0; const steered: string[] = [];
    const f = setup(t, { run(r) { request = r; calls++; r.onThread('thread'); r.onTurn('turn');
      r.onReady?.({ async steer(text) { steered.push(text); if (outcome === 'unknown') throw new Error('timeout'); return outcome; } });
      return new Promise(resolve => { complete = resolve; }); } });
    f.engine.start(); f.engine.accept(msg('first')); await wait(() => !!request);
    const task = f.tasks.list(msg('x'))[0]; f.engine.accept(msg('change', `/amend ${task.id} 禁止修改后端`));
    await wait(() => f.store.db.prepare("SELECT dispatch FROM task_messages WHERE inboxKey='change'").get()?.dispatch === outcome);
    complete!(result); await wait(() => f.tasks.get(task.id)?.state !== 'running');
    assert.equal(calls, 1); assert.equal(steered.length, 1); assert.match(steered[0], /禁止修改后端/);
    assert.equal(f.tasks.get(task.id)?.state, outcome === 'accepted' ? 'succeeded' : 'needs_attention');
  });
}

test('missing steer capability is visible as unresolved rather than silently consumed', async t => {
  let done: ((v: typeof result) => void) | undefined;
  const f = setup(t, { run() { return new Promise(resolve => { done = resolve; }); } });
  f.engine.start(); f.engine.accept(msg('first')); await wait(() => !!done);
  const task = f.tasks.list(msg('x'))[0]; f.engine.accept(msg('change', `/amend ${task.id} 补充`));
  done!(result); await wait(() => f.tasks.get(task.id)?.state === 'needs_attention');
  assert.equal(f.tasks.revisions(task.id).length, 1);
});

test('different chats sharing a project serialize while an independent project runs', async t => {
  const running: { r: RunRequest; done: (v: typeof result) => void }[] = [];
  const f = setup(t, { run(r) { return new Promise(resolve => running.push({ r, done: resolve })); } }, true);
  f.engine.accept(msg('a'));
  const b = { ...msg('b'), chatKey: 'b', chatId: 'b', envelope: undefined };
  const c = { ...msg('c'), chatKey: 'c', chatId: 'c', envelope: undefined };
  f.engine.accept(b); f.store.setProject('c', 'two'); f.engine.accept(c); f.engine.start();
  await wait(() => running.length === 2);
  assert.deepEqual(running.map(x => x.r.cwd), [join(f.dir, 'one'), join(f.dir, 'two')]);
  running[0].done(result); running[1].done(result); await wait(() => running.length === 3);
  assert.equal(running[2].r.cwd, join(f.dir, 'one')); running[2].done(result);
  await wait(() => f.tasks.owned(f.store.get('b')!.taskId!, b)?.state === 'succeeded');
  assert.ok(pathsOverlap(join(f.dir, 'one'), join(f.dir, 'one', '..hidden')));
  assert.ok(!pathsOverlap(join(f.dir, 'one'), join(f.dir, 'one-more')));
});

test('project and permission snapshots do not follow a changed default or expanded policy', async t => {
  const dirs: string[] = []; const f = setup(t, { async run(r) { dirs.push(r.cwd); return result; } }, true);
  f.engine.accept(msg('first')); f.config.codex.defaultProject = 'two'; f.engine.start();
  await wait(() => f.tasks.list(msg('x'))[0]?.state === 'succeeded'); assert.deepEqual(dirs, [join(f.dir, 'one')]);
  f.engine.accept(msg('blocked')); f.config.codex.sandbox = 'read-only' as 'workspace-write';
  await wait(() => f.tasks.get(f.store.get('blocked')!.taskId!)?.state === 'failed');
  assert.equal(dirs.length, 1);
});

test('materials cannot migrate to a different selected project', async t => {
  const f = setup(t, undefined, true); f.engine.accept(msg('m', '/material 旧项目材料'));
  f.engine.accept(msg('switch', '/project two')); f.engine.accept(msg('new', '新项目开发')); f.engine.start();
  await wait(() => f.tasks.get(f.store.get('new')!.taskId!)?.state === 'succeeded');
  assert.doesNotMatch(f.prompts[0], /旧项目材料/); assert.equal(f.store.get('m')?.state, 'material');
});

test('task references and cancellation require the same verified owner and chat', async t => {
  let started = false;
  const f = setup(t, { run(r) { started = true; return new Promise((_resolve, reject) => r.signal.addEventListener('abort', () => reject(new RuntimeError('cancelled')), { once: true })); } });
  f.engine.start(); f.engine.accept(msg('first')); await wait(() => started); const task = f.tasks.list(msg('x'))[0];
  f.engine.accept(msg('wrong', `/amend ${task.id} 改写目标`, 'chat', 'bob'));
  f.engine.accept(msg('wrong-cancel', `/cancel ${task.id}`, 'chat', 'bob'));
  assert.equal(f.tasks.get(task.id)?.state, 'running'); assert.equal(f.tasks.get(task.id)?.inputVersion, 1);
  const quoted = msg('quoted', '补充'); quoted.envelope!.parentId = 'first';
  f.engine.accept(quoted); assert.equal(f.tasks.get(task.id)?.inputVersion, 2);
  f.engine.accept(msg('stop', `/cancel ${task.id}`)); await wait(() => f.tasks.get(task.id)?.state === 'cancelled');
});

test('topics and new workstreams isolate sessions, explicit same-owner continuation resumes one', async t => {
  const threads: (string | undefined)[] = [];
  const f = setup(t, { async run(r) { threads.push(r.threadId); const threadId = r.threadId ?? `thread-${threads.length}`; r.onThread(threadId); return { ...result, threadId }; } });
  f.engine.start(); f.engine.accept(msg('a', '任务', 'topic-a')); await wait(() => f.tasks.list(msg('x'))[0]?.state === 'succeeded');
  const first = f.tasks.list(msg('x'))[0];
  f.engine.accept(msg('b', '任务', 'topic-b')); await wait(() => f.tasks.list(msg('x'))[0]?.state === 'succeeded');
  f.engine.accept(msg('new', '/new', 'topic-a')); f.engine.accept(msg('c', '任务', 'topic-a'));
  await wait(() => threads.length === 3 && f.tasks.list(msg('x'))[0]?.state === 'succeeded');
  await wait(() => f.store.get('c')?.state === 'replied');
  f.engine.accept(msg('select', `/session ${first.workstreamId}`, 'topic-a')); f.engine.accept(msg('d', '继续', 'topic-a'));
  await wait(() => threads.length === 4); assert.deepEqual(threads, [undefined, undefined, undefined, 'thread-1']);
});

test('restart marks in-flight revisions unknown and executions interrupted without replay', async t => {
  const f = setup(t); f.engine.accept(msg('first')); const task = f.tasks.list(msg('x'))[0]; f.tasks.start(task);
  const m = msg('change', '追加'); f.store.enqueue(m); f.tasks.amend(task, m); f.tasks.dispatch('change', 'submitting');
  f.engine.start(); await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.tasks.get(task.id)?.state, 'interrupted'); assert.equal(f.tasks.revisions(task.id, 'unknown').length, 1);
  assert.equal(f.prompts.length, 0);
});

test('routing failure rolls back acceptance, task and all progress outputs together', t => {
  const f = setup(t);
  f.store.db.exec("CREATE TRIGGER fail_output BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'disk_error'); END");
  assert.throws(() => f.engine.accept(msg('first')), /disk_error/);
  assert.equal(f.store.get('first'), undefined); assert.equal(f.tasks.list(msg('x')).length, 0);
});

test('oversized assembled input leaves materials intact and no partial task or workstream', t => {
  const f = setup(t);
  for (let n = 0; n < 6; n++) f.engine.accept(msg(`m-${n}`, '/material ' + '材料'.repeat(7000)));
  f.engine.accept(msg('run', '/run 开始'));
  assert.equal(f.tasks.list(msg('x')).length, 0); assert.equal(f.tasks.streams(msg('x')).length, 0);
  assert.equal(f.store.get('m-0')?.state, 'material'); assert.equal(f.store.get('run')?.state, 'awaiting_reply');
});

test('a revision between claim and runtime readiness is sent exactly once, outside the frozen prompt', async t => {
  const inputs: string[] = []; const steers: string[] = [];
  const f = setup(t, { async run(r) { inputs.push(r.prompt); r.onReady?.({ async steer(text) { steers.push(text); return 'accepted'; } }); return result; } });
  f.engine.start(); f.engine.accept(msg('first'));
  const task = f.tasks.list(msg('x'))[0]; f.engine.accept(msg('early', `/amend ${task.id} UNIQUE_REVISION`));
  await wait(() => f.tasks.get(task.id)?.state === 'succeeded');
  assert.equal(inputs.length, 1); assert.equal(steers.length, 1); assert.doesNotMatch(inputs[0], /UNIQUE_REVISION/); assert.match(steers[0], /UNIQUE_REVISION/);
});

test('legacy selected project and same-owner session survive the first structured task', async t => {
  const requests: RunRequest[] = []; const f = setup(t, { async run(r) { requests.push(r); return result; } }, true);
  f.store.setProject('chat', 'two'); f.store.bindWorkspace('chat', join(f.dir, 'two')); f.store.saveThread('chat', 'old-session');
  f.engine.start(); f.engine.accept(msg('first')); await wait(() => requests.length === 1);
  assert.equal(requests[0].cwd, join(f.dir, 'two')); assert.equal(requests[0].threadId, 'old-session');
});

test('a cancellation with failed durable acceptance does not interrupt the execution', async t => {
  let started = false; let aborted = false;
  const f = setup(t, { run(r) { started = true; return new Promise((_resolve, reject) => r.signal.addEventListener('abort', () => { aborted = true; reject(new RuntimeError('cancelled')); }, { once: true })); } });
  f.engine.start(); f.engine.accept(msg('first')); await wait(() => started);
  f.store.db.exec("CREATE TRIGGER fail_cancel BEFORE INSERT ON outbox WHEN NEW.inboxKey='stop' BEGIN SELECT RAISE(ABORT,'disk_error'); END");
  assert.throws(() => f.engine.accept(msg('stop', '/cancel')), /disk_error/);
  assert.equal(aborted, false); assert.equal(f.store.get('first')?.cancelRequested, 0);
  f.store.db.exec('DROP TRIGGER fail_cancel'); f.engine.accept(msg('stop', '/cancel')); await wait(() => aborted);
});

test('maintenance prevents claiming tasks and durable local cancellation is observed without a new Feishu message',async t=>{
 let starts=0;const f=setup(t,{run(r){starts++;return new Promise((_resolve,reject)=>r.signal.addEventListener('abort',()=>reject(new RuntimeError('cancelled')),{once:true}));}});
 f.engine.start();f.store.db.prepare("INSERT INTO settings VALUES('maintenance','test')").run();f.engine.accept(msg('held'));
 await new Promise(r=>setTimeout(r,80));assert.equal(starts,0);assert.equal(f.tasks.get(f.store.get('held')!.taskId!)?.state,'queued');
 f.store.db.prepare("DELETE FROM settings WHERE key='maintenance'").run();await wait(()=>starts===1);
 const task=f.tasks.get(f.store.get('held')!.taskId!)!;f.tasks.cancel(task);await wait(()=>f.tasks.get(task.id)?.state==='cancelled');assert.equal(starts,1);
});
