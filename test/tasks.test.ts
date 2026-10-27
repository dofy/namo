import { storeFixture, waitFor } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION, type Incoming } from '../src/store.js';
import { Engine, pathsOverlap } from '../src/engine.js';
import { Tasks } from '../src/tasks.js';
import { RuntimeError, type RunRequest, type Runtime } from '../src/runtime.js';
import { type MaterialDescriptor, type MaterialExpansion, type MaterialNode, type MaterialReadAdapter } from '../src/materials.js';
import { taskMaterials, type TaskMaterialLimits } from '../src/task-materials.js';

const wait = (condition: () => boolean, timeoutMs = 6000) => waitFor(condition, timeoutMs);
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
    assert.equal(s.db.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION); s.close();
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

test('running image amendments are rejected visibly without changing the task or steering text alone', async t => {
  let done: ((v:typeof result)=>void)|undefined,steers=0;
  const f=setup(t,{run(r){r.onReady?.({async steer(){steers++;return 'accepted';}});return new Promise(resolve=>{done=resolve;});}});
  f.engine.start();f.engine.accept(msg('first'));await wait(()=>!!done);
  const task=f.tasks.list(msg('x'))[0],amendment=msg('image-change',`/amend ${task.id} 看图片`);
  amendment.envelope!.materials=[{type:'image',resourceKey:'image-key'}];f.engine.accept(amendment);
  assert.equal(f.tasks.get(task.id)?.inputVersion,1);assert.equal(f.store.get(amendment.key)?.taskId,null);
  assert.equal(steers,0);assert.match(String(f.store.db.prepare("SELECT content FROM outbox WHERE inboxKey=? AND kind='result'").get(amendment.key)?.content),/暂不支持追加附件/);
  done!(result);await wait(()=>f.tasks.get(task.id)?.state==='succeeded');
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

function fixture(t: { after(fn: () => void): void }, materials: MaterialDescriptor[]) {
  const { dir, store } = storeFixture(t, 'namo-task-materials-');
  store.enqueue({ key: 'message', messageId: 'om-message', chatKey: 'app:chat', chatId: 'chat', senderId: 'alice', text: 'task',
    envelope: { version: 1, type: 'text', kind: 'instruction', scopeKey: 'app:chat', materials, limitations: [] } });
  const tasks = new Tasks(store), task = tasks.create(store.get('message')!, { cwd: dir, policyHash: 'policy' });
  return { store, task };
}

const limits = (overrides: Partial<TaskMaterialLimits> = {}): Partial<TaskMaterialLimits> => ({
  maxDescriptors: 8, maxResources: 4, maxTextChars: 64_000, maxResourceBytes: 1_000_000,
  timeoutMs: 1_000, maxSerializedChars: 100_000, ...overrides,
});

function cachedFile(text: string): MaterialExpansion {
  return { source: { appId: 'app', chatId: 'chat', ownerId: 'alice', messageId: 'om-message' }, state: 'parsed',
    nodes: [{ id: 'om-message', depth: 0, type: 'file', state: 'parsed', stages: ['received', 'accessed', 'parsed'],
      untrusted: true, text, bytes: Buffer.byteLength(text) }], limitations: ['cached'], truncated: false };
}

test('cached and newly read files share one resource and byte budget', async t => {
  const descriptors = Array.from({ length: 5 }, (_, index) => ({ type: 'file', resourceKey: `file-${index}`, name: `${index}.txt` }));
  const f = fixture(t, descriptors);
  f.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('material:message:0', JSON.stringify(cachedFile('cache')));
  let reads = 0;
  const adapter: MaterialReadAdapter = { async readMessage() { return []; }, async readResource(request) {
    reads++; assert.ok(request.maxBytes <= 20); return { bytes: Buffer.from('data'), fileName: 'read.txt' };
  } };
  const result = await taskMaterials(f.store, f.task, 'app', adapter, value => value,
    limits({ maxResourceBytes: 20 }));
  assert.equal(reads, 3, 'the parsed cache consumes the first of four resource slots');
  assert.equal(result.length, 5);
  assert.equal(result.at(-1)?.nodes[0].error, 'material_resource_count_limit');
  assert.equal(result.at(-1)?.truncated, true);
  assert.equal(result.flatMap(item => item.nodes).reduce((sum, node) => sum + (node.bytes ?? 0), 0), 17);
});

test('empty and failed file reads still consume the shared resource budget', async t => {
  const descriptors = Array.from({ length: 8 }, (_, index) => ({ type: 'file', resourceKey: `empty-${index}`, name: `${index}.txt` }));
  const empty = fixture(t, descriptors);
  let emptyReads = 0;
  const emptyResult = await taskMaterials(empty.store, empty.task, 'app', {
    async readMessage() { return []; }, async readResource() { emptyReads++; return { bytes: Buffer.alloc(0), fileName: 'empty.txt' }; },
  }, value => value, limits());
  assert.equal(emptyReads, 4);
  assert.equal(emptyResult.filter(item => item.nodes.some(node => node.bytes === 0)).length, 4);
  assert.equal(emptyResult.at(-1)?.nodes[0].error, 'material_resource_count_limit');
  assert.equal(emptyResult.at(-1)?.truncated, true);

  const failed = fixture(t, descriptors);
  let failedReads = 0;
  const failedResult = await taskMaterials(failed.store, failed.task, 'app', {
    async readMessage() { return []; }, async readResource() { failedReads++; throw new Error('read failed'); },
  }, value => value, limits());
  assert.equal(failedReads, 4);
  assert.equal(failedResult.at(-1)?.nodes[0].error, 'material_resource_count_limit');

  const unsupported = fixture(t, Array.from({ length: 8 }, (_, index) => ({
    type: 'file', resourceKey: `unsupported-${index}`, name: `${index}.zip`,
  })));
  let unsupportedReads = 0;
  const unsupportedResult = await taskMaterials(unsupported.store, unsupported.task, 'app', {
    async readMessage() { return []; }, async readResource() { unsupportedReads++; throw new Error('must_not_read'); },
  }, value => value, limits());
  assert.equal(unsupportedReads, 0);
  assert.equal(unsupportedResult.filter(item => item.nodes[0]?.error === 'unsupported_file_type').length, 4);
  assert.equal(unsupportedResult.at(-1)?.nodes[0].error, 'material_resource_count_limit');
});

test('aggregate byte budget is passed to the adapter and stops later reads', async t => {
  const f = fixture(t, Array.from({ length: 4 }, (_, index) => ({ type: 'file', resourceKey: `file-${index}`, name: `${index}.txt` })));
  f.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('material:message:0', JSON.stringify(cachedFile('12345')));
  const allowances: number[] = [];
  const adapter: MaterialReadAdapter = { async readMessage() { return []; }, async readResource(request) {
    allowances.push(request.maxBytes);
    return { bytes: Buffer.from('6789'), fileName: 'read.txt' };
  } };
  const result = await taskMaterials(f.store, f.task, 'app', adapter, value => value,
    limits({ maxResourceBytes: 10 }));
  assert.deepEqual(allowances, [5, 1]);
  assert.equal(result.at(-1)?.nodes[0].error, 'resource_size_limit');
  assert.equal(result.at(-1)?.truncated, true);
  assert.ok(result.at(-1)?.limitations.some(value => value.includes('累计字节上限')));
});

test('all nodes from merged forwards share the task text budget', async t => {
  const f = fixture(t, [{ type: 'merge_forward' }, { type: 'merge_forward' }]);
  let calls = 0;
  const adapter: MaterialReadAdapter = { async readResource() { throw new Error('not_used'); }, async readMessage() {
    calls++; return [
      { messageId: 'om-message', chatId: 'chat', type: 'merge_forward' },
      { messageId: `a-${calls}`, parentMessageId: 'om-message', chatId: 'chat', type: 'text', body: JSON.stringify({ text: 'aaa' }) },
      { messageId: `b-${calls}`, parentMessageId: 'om-message', chatId: 'chat', type: 'text', body: JSON.stringify({ text: 'bbbb' }) },
    ];
  } };
  const result = await taskMaterials(f.store, f.task, 'app', adapter, value => value, limits({ maxTextChars: 10 }));
  assert.equal(calls, 2);
  assert.equal(result.flatMap(item => item.nodes).reduce((sum, node) => sum + (node.text?.length ?? 0), 0), 10);
  assert.equal(result[1].truncated, true);
  assert.ok(result[1].limitations.some(value => value.includes('累计文本上限')));
});

test('all resource nodes in one cached forward count toward the shared resource limit', async t => {
  const f = fixture(t, [{ type: 'merge_forward' }]);
  const resourceNodes: MaterialNode[] = Array.from({ length: 3 }, (_, index) => ({ id: `file-${index}`, parentId: 'om-message', depth: 1, type: 'file',
    state: 'parsed', stages: ['received', 'accessed', 'parsed'], untrusted: true, text: `f${index}`, bytes: 2 }));
  const expansion: MaterialExpansion = { source: { appId: 'app', chatId: 'chat', ownerId: 'alice', messageId: 'om-message' }, state: 'parsed',
    nodes: [{ id: 'om-message', depth: 0, type: 'merge_forward', state: 'parsed', stages: ['received', 'accessed', 'parsed'], untrusted: true },
      ...resourceNodes],
    limitations: ['cached future-compatible expansion'], truncated: false };
  f.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('material:message:0', JSON.stringify(expansion));
  const adapter: MaterialReadAdapter = { async readMessage() { throw new Error('cache_must_be_used'); }, async readResource() { throw new Error('cache_must_be_used'); } };
  const result = await taskMaterials(f.store, f.task, 'app', adapter, value => value, limits({ maxResources: 2 }));
  assert.equal(result[0].nodes.filter(node => node.bytes).length, 2);
  assert.equal(result[0].nodes.at(-1)?.error, 'material_resource_count_limit');
  assert.equal(result[0].truncated, true);
});

test('descriptor overflow is explicit instead of silently slicing message materials', async t => {
  const f = fixture(t, Array.from({ length: 11 }, (_, index) => ({ type: `unsupported-${index}` })));
  const adapter: MaterialReadAdapter = { async readMessage() { throw new Error('not_used'); }, async readResource() { throw new Error('not_used'); } };
  const result = await taskMaterials(f.store, f.task, 'app', adapter, value => value, limits());
  assert.equal(result.length, 9);
  assert.equal(result.at(-1)?.nodes[0].error, 'material_descriptor_limit');
  assert.equal(result.at(-1)?.truncated, true);
  assert.ok(result.at(-1)?.limitations.some(value => value.includes('其余 3 个未访问')));
});

test('one absolute deadline is shared by every descriptor', async t => {
  const f = fixture(t, [{ type: 'merge_forward' }, { type: 'merge_forward' }, { type: 'merge_forward' }]);
  let calls = 0;
  const adapter: MaterialReadAdapter = { async readResource() { throw new Error('not_used'); }, async readMessage() {
    calls++;
    if (calls === 1) { await new Promise(resolve => setTimeout(resolve, 20)); return [{ messageId: 'om-message', chatId: 'chat', type: 'merge_forward' }]; }
    return await new Promise<never>(() => {});
  } };
  const started = Date.now();
  const result = await taskMaterials(f.store, f.task, 'app', adapter, value => value, limits({ timeoutMs: 40 }));
  assert.ok(Date.now() - started < 150);
  assert.equal(calls, 2);
  assert.ok(result.some(item => item.nodes.some(node => node.error === 'material_timeout' || node.error === 'material_total_timeout')));
  assert.ok(result.some(item => item.truncated && item.limitations.some(value => value.includes('共享读取时限'))));
});

test('serialized prompt allowance rejects a whole material with an explicit marker', async t => {
  const f = fixture(t, [{ type: 'text', text: 'x'.repeat(1_000) }]);
  const adapter: MaterialReadAdapter = { async readMessage() { throw new Error('not_used'); }, async readResource() { throw new Error('not_used'); } };
  const result = await taskMaterials(f.store, f.task, 'app', adapter, value => value, limits({ maxSerializedChars: 600 }));
  assert.equal(result.length, 1);
  assert.equal(result[0].nodes[0].error, 'material_prompt_limit');
  assert.equal(result[0].truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /x{20}/);
  assert.ok(JSON.stringify(result).length <= 600);
});
