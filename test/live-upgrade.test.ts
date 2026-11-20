import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { RuntimeError, type Runtime, type RunResult } from '../src/runtime.js';
import { RuntimeHost, type HostedRuntime } from '../src/runtime-host.js';
import { activeRuntimeId, assertLiveCompatible, confirmLiveTrial, loadLiveFactory, requestLiveUpgrade, watchLiveUpgrades } from '../src/live-upgrade.js';
import { createRuntimeRelease, verifyRuntimeRelease } from '../src/release.js';
import { atomicJson } from '../src/paths.js';
import { initialConfig } from '../src/onboarding.js';
import { loadConfig } from '../src/config.js';
import { createUpgradeBackup } from '../src/upgrade-backup.js';
import { put, writable } from './helpers.js';

const input = (key: string) => ({ key, messageId: key, chatId: 'chat', chatKey: 'chat', senderId: 'alice', text: key });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(condition: () => boolean) {
  const end = Date.now() + 5000;
  while (!condition()) { if (Date.now() > end) throw Error('timeout'); await tick(); }
}
function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-live-upgrade-')), store = new Store(join(dir, 'bot.sqlite'));
  t.after(() => { store.close(); writable(dir); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store };
}

test('live replacement keeps acceptance durable, deduplicates events and dispatches queued chats once', async t => {
  const { dir, store } = fixture(t), executed: string[] = [];
  let finishStop!: () => void, stopping = false;
  const gate = new Promise<void>(resolve => { finishStop = resolve; });
  const make = () => new Engine(store, { async run(request) { executed.push(String(store.db.prepare('SELECT inboxKey FROM tasks WHERE id=?').get(request.taskId!)?.inboxKey)); return { text: 'answer', threadId: 'thread', turnId: String(store.db.prepare('SELECT inboxKey FROM tasks WHERE id=?').get(request.taskId!)?.inboxKey) }; } },
    { async send(_chat, _text, id) { return id; } }, { dataDir: dir, concurrency: 2 });
  const old = make();
  const host = new RuntimeHost(() => ({
    accept: (m, defer) => old.accept(m, defer), acceptCard: e => old.acceptCard(e), start: paused => old.start(paused), resume: () => old.resume(),
    stop: async () => { stopping = true; await old.stop(); await gate; },
  }));
  host.start();
  let committed = false;
  const switchWork = host.replace(make, () => { assert.deepEqual(executed, []); committed = true; });
  await until(() => stopping);
  assert.equal(host.accept(input('one')), true);
  assert.equal(host.accept(input('one')), false);
  assert.equal(host.accept(input('two')), true);
  const reader = new Store(join(dir, 'bot.sqlite'), true);
  assert.equal(reader.get('one')?.state, 'queued'); assert.equal(reader.get('two')?.taskId, null); reader.close();
  assert.equal(host.acceptCard({}).toast.type, 'error');
  await assert.rejects(host.replace(make, () => {}), /busy/);
  finishStop(); await switchWork;
  assert.equal(committed, true);
  await until(() => store.get('two')?.state === 'replied');
  assert.deepEqual(executed, ['one', 'two']);
  await host.stop();
});

test('failed activation restores the previous runtime and preserves arrivals without resending unknown output', async t => {
  const { dir, store } = fixture(t), executed: string[] = [], sent: string[] = [];
  store.enqueue(input('ambiguous')); store.addOutput('ambiguous', 'result', 'already accepted?');
  const out = store.nextOutput()!; store.sending(out.id);
  const make = () => new Engine(store, { async run(request) { executed.push(String(store.db.prepare('SELECT inboxKey FROM tasks WHERE id=?').get(request.taskId!)?.inboxKey)); return { text: 'answer', threadId: 't', turnId: 'u' }; } },
    { async send(_chat, text, id) { sent.push(text); return id; } }, { dataDir: dir, concurrency: 1 });
  const host = new RuntimeHost(make); host.start();
  await assert.rejects(host.replace(make, () => { host.accept(input('during-failure')); throw Error('disk full'); }), /disk full/);
  await until(() => store.get('during-failure')?.state === 'replied');
  assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=?').get(out.id)?.state, 'unknown');
  assert.ok(!sent.includes('already accepted?')); assert.equal(executed.filter(k => k === 'during-failure').length, 1);
  await host.stop();
});

test('unsettled shutdown fails closed while continuing durable acceptance', async t => {
  const { store } = fixture(t); let starts = 0;
  const factory = (): HostedRuntime => ({ accept: m => store.enqueue(m), acceptCard: () => ({ toast: { type: 'info', content: '' } }),
    start: () => { starts++; }, resume: () => { starts++; }, stop: async () => { throw Error('unsettled'); } });
  const host = new RuntimeHost(factory); host.start();
  await assert.rejects(host.replace(factory, () => {}), /runtime_unsettled/);
  assert.equal(host.accept(input('retained')), true); assert.equal(store.get('retained')?.state, 'queued');
  assert.equal(starts, 1); await assert.rejects(host.replace(factory, () => {}), /busy/);
});

test('a failure after pointer commit marks the host unavailable and retains arrivals',async t=>{
 const {store}=fixture(t);const base=():HostedRuntime=>({accept:m=>store.enqueue(m),acceptCard:()=>({toast:{type:'info',content:''}}),start:()=>{},resume:()=>{},stop:async()=>{}});
 const broken=():HostedRuntime=>({...base(),resume:()=>{throw Error('resume_failed');}});
 const host=new RuntimeHost(base);host.start();let committed=false;
 await assert.rejects(host.replace(broken,()=>{committed=true;}),/resume_failed/);
 assert.equal(committed,true);assert.equal(host.available,false);
 assert.equal(host.accept(input('retained-after-failure')),true);assert.equal(store.get('retained-after-failure')?.state,'queued');
 await host.stop();
});

test('an active persistent worker is reattached without starting another model turn', async t => {
  const { dir, store } = fixture(t); let launches = 0, observations = 0, complete!: () => void;
  const result = new Promise<RunResult>(resolve => { complete = () => resolve({ text: 'finished', threadId: 't', turnId: 'u' }); });
  const runtime: Runtime = { persistent: true, async run(request) {
    observations++;
    if (!store.db.prepare('SELECT 1 FROM runner_jobs WHERE runId=?').get(request.runId!)) {
      launches++;
      store.db.prepare("INSERT INTO runner_jobs(runId,owner,state,createdAt,updatedAt,configRevision,prompt) VALUES(?,'owner','running',?,?,'revision','prompt')")
        .run(request.runId!, Date.now(), Date.now());
    }
    return new Promise<RunResult>((resolve, reject) => {
      const abort = () => reject(new RuntimeError('receiver_detached'));
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      void result.then(value => { request.signal.removeEventListener('abort', abort); resolve(value); });
    });
  } };
  const make = () => new Engine(store, runtime, { async send(_chat, _text, id) { return id; } }, { dataDir: dir, concurrency: 1 });
  const host = new RuntimeHost(make); host.start(); host.accept(input('active'));
  await until(() => launches === 1);
  const runId = String(store.db.prepare('SELECT id FROM task_runs').get()?.id);
  const marker = `daily-turn-run:${runId}`;
  store.db.prepare('INSERT INTO settings VALUES(?,?)').run(marker, '2026-01-01');
  await host.replace(make, () => {});
  await until(() => observations === 2);
  assert.equal(launches, 1); assert.equal(store.get('active')?.state, 'running');
  assert.ok(store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(marker));
  complete(); await until(() => store.get('active')?.state === 'replied');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM task_runs').get()?.n, 1);
  assert.equal(store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(marker), undefined);
  await host.stop();
});

test('receiver switch requeues a claim that never created a runner reservation',async t=>{
 const {dir,store}=fixture(t);let attempted=0,dispatched=0;
 const runtime:Runtime={persistent:true,async run(r){attempted++;if(attempted===1)return new Promise((_resolve,reject)=>{
  const stop=()=>reject(new RuntimeError('receiver_detached'));r.signal.addEventListener('abort',stop,{once:true});if(r.signal.aborted)stop();
 });dispatched++;r.onThread('thread');r.onTurn('turn');return {text:'done',threadId:'thread',turnId:'turn'};}};
 const make=()=>new Engine(store,runtime,{async send(_chat,_text,id){return id;}},{dataDir:dir,concurrency:1,codex:{bin:'codex',home:join(dir,'home'),sandbox:'read-only',timeoutMs:10000,dailyTurnLimit:1}});
 const host=new RuntimeHost(make);host.start();host.accept(input('undispatched'));await until(()=>attempted===1);
 const pending=store.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'daily-turn-run:%'").get();
 assert.ok(pending);
 await host.replace(make,()=>{});await until(()=>store.get('undispatched')?.state==='replied');
 assert.equal(dispatched,1);assert.equal(store.db.prepare("SELECT COUNT(*) n FROM task_runs WHERE state='not_started'").get()?.n,1);
 assert.equal(store.db.prepare("SELECT COUNT(*) n FROM settings WHERE key LIKE 'daily-turn-run:%'").get()?.n,0);
 const used=()=>store.db.prepare("SELECT SUM(CAST(value AS INTEGER)) n FROM settings WHERE key LIKE 'daily-turns:%'").get()?.n;
 assert.equal(used(),1);
 // A release from before reservation cleanup could leave a marker on a finished run.
 const finished=store.db.prepare("SELECT id FROM task_runs WHERE state='succeeded'").get();
 assert.ok(finished);
 store.db.prepare('INSERT INTO settings VALUES(?,?)').run(`daily-turn-run:${finished.id}`,pending.value!);
 await host.replace(make,()=>{});
 assert.equal(store.db.prepare("SELECT COUNT(*) n FROM settings WHERE key LIKE 'daily-turn-run:%'").get()?.n,0);
 assert.equal(used(),1);
 await host.stop();
});

test('deferred receipts survive a process restart and regain feedback without a second acceptance', async t => {
  const { dir, store } = fixture(t);
  const runtime = { async run() { return { text: 'done', threadId: 't', turnId: 'u' }; } };
  const sender = { async send(_chat: string, _text: string, id: string) { return id; } };
  const old = new Engine(store, runtime, sender, { dataDir: dir, concurrency: 1 });
  assert.equal(old.accept(input('persisted'), true), true);
  const reopened = new Store(join(dir, 'bot.sqlite'));
  const next = new Engine(reopened, runtime, sender, { dataDir: dir, concurrency: 1 });
  next.start(true);
  assert.equal(reopened.get('persisted')?.taskId,null);
  next.resume();
  assert.ok(reopened.get('persisted')?.taskId);
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM message_feedback').get()?.n, 1);
  await until(() => reopened.get('persisted')?.state === 'replied');
  await next.stop(); reopened.close();
});

test('online backup uses a consistent snapshot without blocking or overwriting newer receipts', async t => {
  const { dir, store } = fixture(t), file = join(dir, 'config.json'), plist = join(dir, 'service.plist');
  const raw = initialConfig(file, file.slice(0, file.lastIndexOf('/'))); raw.dataDir = dir; atomicJson(file, raw); put(plist, 'fixture');
  store.enqueue(input('before'));
  const work = createUpgradeBackup(loadConfig(file), plist, 'live-upgrade');
  store.enqueue(input('during'));
  const backup = await work, copy = new Store(join(backup, 'bot.sqlite'), true);
  assert.ok(copy.get('before')); assert.equal(copy.get('during'), undefined); copy.close();
  assert.ok(store.get('during')); assert.equal(store.get('during')?.state, 'queued');
});

test('an unconfirmed upgrade leaves one durable request and refuses blind resubmission', async t => {
  const { dir } = fixture(t), file = join(dir, 'config.json'), raw = initialConfig(file, file.slice(0, file.lastIndexOf('/')));
  raw.dataDir = dir; atomicJson(file, raw); const config = loadConfig(file);
  await assert.rejects(requestLiveUpgrade(config, 'a'.repeat(64), 'a'.repeat(64), 'b'.repeat(64), 1), /outcome_unconfirmed/);
  const request = readFileSync(join(dir, 'live-upgrade-request.json'), 'utf8');
  await assert.rejects(requestLiveUpgrade(config, 'a'.repeat(64), 'a'.repeat(64), 'b'.repeat(64), 1), /pending/);
  assert.equal(readFileSync(join(dir, 'live-upgrade-request.json'), 'utf8'), request);
});

test('verified runtime updates preserve the receiver pin and recover the active runtime on restart', async t => {
  const { dir, store } = fixture(t), source = join(dir, 'source'), file = join(dir, 'config.json');
  const raw = initialConfig(file, file.slice(0, file.lastIndexOf('/'))); raw.dataDir = dir; atomicJson(file, raw); const config = loadConfig(file);
  cpSync(new URL('../src/', import.meta.url), join(source, 'dist/src'), { recursive: true });
  put(join(source, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', dependencies: {} }));
  put(join(source, 'bin/namo.js'), 'export {};'); put(join(source, 'dist/ui/index.html'), 'fixture');
  put(join(source, 'dist/scripts/smoke-codex.js'), 'export {};'); mkdirSync(join(source, 'assets'));
  put(join(source, 'dist/src/live-runtime.js'), `export const liveRuntimeAbi=1,schemaVersion=${Number(store.db.prepare('PRAGMA user_version').get()?.user_version)};
    export function createLiveRuntime(o){return {accept:m=>o.store.enqueue(m),acceptCard:()=>({toast:{type:'info',content:''}}),start:()=>o.log('new_runtime'),resume:()=>{},stop:async()=>{}};}`);
  const hostRelease = createRuntimeRelease(source, join(dir, 'releases'));
  put(join(source, 'dist/src/presentation.js'), '// presentation changed');
  const target = createRuntimeRelease(source, join(dir, 'releases'));
  assertLiveCompatible(verifyRuntimeRelease(hostRelease.root), verifyRuntimeRelease(target.root));
  const logs: string[] = [], options = { store, config, sender: { async send() { return 'id'; } }, redact: (s: string) => s, log: (event: string) => { logs.push(event); }, onFatal: () => {} };
  const host = new RuntimeHost(await loadLiveFactory(hostRelease, hostRelease, options)); host.start();
  const health: Record<string, unknown> = {};
  const stopWatch = watchLiveUpgrades(config, hostRelease, hostRelease.id, host, options, fields => Object.assign(health, fields));
  try {
    const receipt = await requestLiveUpgrade(config, hostRelease.id, hostRelease.id, target.id, 10_000);
    assert.equal(receipt.state, 'succeeded'); assert.equal(health.releaseId, target.id);
    assert.equal(activeRuntimeId(dir, hostRelease.id), hostRelease.id);
    assert.equal(logs.filter(x => x === 'new_runtime').length, 2);
    assert.equal(typeof await loadLiveFactory(hostRelease, target, options), 'function');
    put(join(source, 'dist/src/engine.js'), '// incompatible durable state writer');
    const incompatibleState=createRuntimeRelease(source,join(dir,'releases'));
    await assert.rejects(loadLiveFactory(hostRelease,incompatibleState,options),/requires_receiver_restart/);
    put(join(source, 'dist/src/feishu.js'), '// incompatible receiver');
    const incompatible = createRuntimeRelease(source, join(dir, 'releases'));
    await assert.rejects(loadLiveFactory(hostRelease, incompatible, options), /requires_receiver_restart/);
    assert.equal(activeRuntimeId(dir, hostRelease.id), hostRelease.id);
    assert.equal(JSON.parse(readFileSync(join(dir, 'active-runtime.json'), 'utf8')).hostId, hostRelease.id);
    await stopWatch();
    const restarted=watchLiveUpgrades(config,hostRelease,hostRelease.id,host,options,()=>{});
    try {await assert.rejects(requestLiveUpgrade(config,hostRelease.id,hostRelease.id,target.id,10_000),/live_upgrade_trial_interrupted/);}
    finally {await restarted();}
    assert.equal(logs.filter(x=>x==='new_runtime').length,2);
    assert.equal(activeRuntimeId(dir,hostRelease.id),hostRelease.id);
    atomicJson(join(dir,'active-runtime.json'),{format:1,hostId:hostRelease.id,id:target.id,trial:true,previous:hostRelease.id});
    assert.equal(confirmLiveTrial(dir,hostRelease.id,target.id),true);
    assert.equal(activeRuntimeId(dir,hostRelease.id),target.id);
  } finally { await stopWatch(); await host.stop(); }
});

test('durable row codecs are part of the live-upgrade ABI', () => {
  const files = readdirSync(new URL('../src/', import.meta.url)).filter(name => name.endsWith('.js'))
    .map(name => ({ path: `dist/src/${name}`, sha256: 'a'.repeat(64), size: 1, mode: 0o644 }));
  const manifest = (changed?: string) => ({ format: 1, id: 'x', entry: 'dist/src/cli.js', worker: 'dist/src/runner-worker.js', packageVersion: '0', runtimeDependencies: [],
    files: files.map(file => file.path === changed ? { ...file, sha256: 'b'.repeat(64) } : file) }) as unknown as Parameters<typeof assertLiveCompatible>[0];
  assert.doesNotThrow(() => assertLiveCompatible(manifest(), manifest('dist/src/runtime.js')));
  for (const name of ['record-table', 'business-storage', 'schema-directory-migration', 'daily-turns'])
    assert.throws(() => assertLiveCompatible(manifest(), manifest(`dist/src/${name}.js`)), /live_upgrade_requires_receiver_restart/);
});

test('database fingerprint ignores physical row order, including case-only ties', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { databaseFingerprint } = await import('../src/upgrade-backup.js');
  const build = (rows: string[]) => { const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (v TEXT COLLATE NOCASE, n INTEGER) STRICT');
    for (const v of rows) db.prepare('INSERT INTO t VALUES(?,1)').run(v); return db; };
  const a = build(['b', 'A', 'a']), b = build(['a', 'b', 'A']), c = build(['a', 'b', 'B']);
  assert.equal(databaseFingerprint(a), databaseFingerprint(b));
  assert.notEqual(databaseFingerprint(a), databaseFingerprint(c));
});

test('upgrade backups keep the newest verified copies and drop old interrupted attempts', async t => {
  const { pruneUpgradeBackups } = await import('../src/upgrade-backup.js');
  const root = mkdtempSync(join(tmpdir(), 'namo-backup-prune-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const day = 24 * 60 * 60_000, now = 100 * day;
  const make = (name: string, verified: boolean) => { mkdirSync(join(root, name)); if (verified) writeFileSync(join(root, name, 'verified.json'), '{}'); };
  for (let i = 1; i <= 7; i++) make(`upgrade-${i * day}-${uuid(i)}`, true);
  make(`live-upgrade-${8 * day}-${uuid(8)}`, true);
  make(`upgrade-${9 * day}-${uuid(9)}`, false);
  make(`.upgrade-${now - 30 * day}-${uuid(10)}.pending`, false);
  make(`.upgrade-${now - day}-${uuid(11)}.pending`, false);
  make('user-notes', false);
  const removed = pruneUpgradeBackups(root, 5, 7 * day, now);
  assert.deepEqual(removed.sort(), [`.upgrade-${now - 30 * day}-${uuid(10)}.pending`, `upgrade-${1 * day}-${uuid(1)}`, `upgrade-${2 * day}-${uuid(2)}`, `upgrade-${3 * day}-${uuid(3)}`].sort());
  const left = readdirSync(root).sort();
  assert.ok(left.includes(`live-upgrade-${8 * day}-${uuid(8)}`) && left.includes(`upgrade-${9 * day}-${uuid(9)}`) && left.includes('user-notes'));
  assert.ok(left.includes(`.upgrade-${now - day}-${uuid(11)}.pending`));
  assert.equal(left.length, 8);
});
