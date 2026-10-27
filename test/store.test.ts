import { migrateSchema } from '../src/schema-migrations.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, type Incoming, SCHEMA_VERSION } from '../src/store.js';
import { BackgroundWork } from '../src/background-work.js';
import { storeFixture } from './helpers.js';
import { databaseFingerprint } from '../src/upgrade-backup.js';

const message = (key: string, chatKey = 'chat'): Incoming => ({ key, chatKey, chatId: chatKey, messageId: key, senderId: 'user', text: 'hi' });

test('changing bot account cannot replay another bot account database', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-store-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'bot.sqlite')); t.after(() => store.close());
  store.bindAccount('app-one'); store.bindAccount('app-one');
  assert.throws(() => store.bindAccount('app-two'), /另一个飞书应用/);
  store.bindAccount('app-one');
});

test('reply and execution state commit atomically when outbox storage fails', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-store-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'bot.sqlite')); t.after(() => store.close());
  store.enqueue(message('a')); store.claim('a');
  store.db.exec("CREATE TRIGGER simulate_disk_error BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'disk_error'); END");
  assert.throws(() => store.finish('a', 'answer'), /disk_error/);
  assert.equal(store.get('a')?.state, 'running'); assert.equal(store.nextOutput(), undefined);
});

test('durable dedup and per-chat serialization survive reopening', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-store-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new Store(join(dir, 'bot.sqlite'));
  assert.equal(store.enqueue(message('a')), true); assert.equal(store.enqueue(message('a')), false);
  store.enqueue(message('b')); store.enqueue(message('c', 'other'));
  store.claim('a'); assert.equal(store.next([])?.key, 'c');
  store.finish('a', 'answer'); assert.equal(store.next([])?.key, 'c');
  const output = store.nextOutput()!; store.sending(output.id);
  store.close(); store = new Store(join(dir, 'bot.sqlite')); t.after(() => store.close());
  assert.deepEqual(store.recover(), { interrupted: 0, unknown: 1 });
  assert.equal(store.get('a')?.state, 'delivery_unknown');
  assert.equal(store.nextOutput(), undefined); assert.equal(store.next([])?.key, 'b');
});

test('crash during execution produces one notice without replaying the task', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-store-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'bot.sqlite')); t.after(() => store.close());
  store.enqueue(message('a')); store.claim('a');
  assert.deepEqual(store.recover(), { interrupted: 1, unknown: 0 });
  assert.deepEqual(store.recover(), { interrupted: 0, unknown: 0 });
  assert.equal(store.next([]), undefined);
  const output = store.nextOutput()!; store.sending(output.id); store.sent(output.id, 'platform-id');
  assert.equal(store.get('a')?.state, 'failed');
});

test('Unicode chunks remain ordered and completion requires every result receipt', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-store-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'bot.sqlite')); t.after(() => store.close());
  store.enqueue(message('a')); store.claim('a'); store.finish('a', '🐱'.repeat(2100));
  const first = store.nextOutput()!; assert.equal(Array.from(first.content).length, 2000);
  assert.equal(store.sending(first.id), true); store.sent(first.id, 'first');
  assert.equal(store.get('a')?.state, 'awaiting_reply');
  const second = store.nextOutput()!; assert.notEqual(first.uuid, second.uuid); assert.equal(Array.from(second.content).length, 100);
  store.sending(second.id); store.sent(second.id, 'second'); assert.equal(store.get('a')?.state, 'replied');
});

test('uncertain progress notification never prevents final answer delivery', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-store-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'bot.sqlite')); t.after(() => store.close());
  store.enqueue(message('a')); store.addOutput('a', 'progress', 'received'); store.claim('a'); store.finish('a', 'answer');
  const progress = store.nextOutput()!; store.sending(progress.id); store.deliveryFailed(progress.id, true, 'timeout');
  assert.equal(store.get('a')?.state, 'awaiting_reply');
  const answer = store.nextOutput()!; assert.equal(answer.kind, 'result'); store.sending(answer.id); store.sent(answer.id, 'ok');
  assert.equal(store.get('a')?.state, 'replied');
});

test('task history, runner events, waits and pending deliveries use bounded indexes', t => {
  const { store } = storeFixture(t, 'namo-query-indexes-');
  const queries: [string, string, string[]][] = [
    ['approval_jobs_queue', "SELECT inboxKey FROM approval_jobs WHERE state='queued' ORDER BY createdAt,inboxKey LIMIT 1", []],
    ['git_approvals_created', 'SELECT id FROM git_approvals ORDER BY createdAt DESC,id LIMIT 50', []],
    ['external_waits_task', 'SELECT id FROM external_waits WHERE taskId=? ORDER BY id', ['task']],
    ['external_waits_state', "SELECT id FROM external_waits WHERE state='open' ORDER BY expiresAt,id", []],
    ['artifact_deliveries_task', 'SELECT id FROM artifact_deliveries WHERE taskId=? ORDER BY createdAt', ['task']],
    ['memories_owner', "SELECT id FROM memories WHERE ownerId=? AND status='active'", ['owner']],
    ['task_runs_task_started', 'SELECT id,inputVersion,state,startedAt,finishedAt,error FROM task_runs WHERE taskId=? ORDER BY startedAt', ['task']],
    ['runner_events_run_seq', 'SELECT kind,createdAt FROM runner_events WHERE runId=? ORDER BY seq DESC LIMIT 100', ['run']],
    ['task_waits_task', "SELECT * FROM task_waits WHERE taskId=? AND state IN ('requested','open') ORDER BY rowid DESC LIMIT 1", ['task']],
    ['outbox_pending', `SELECT o.* FROM outbox o WHERE o.state='pending'
      AND NOT EXISTS (SELECT 1 FROM outbox p WHERE p.inboxKey=o.inboxKey AND p.kind=o.kind AND p.id<o.id AND p.state NOT IN ('sent','confirmed','dismissed'))
      ORDER BY o.id LIMIT 1`, []],
  ];
  for (const [index, query, args] of queries) {
    const plan = store.db.prepare('EXPLAIN QUERY PLAN ' + query).all(...args).map(row => row.detail).join('\n');
    assert.match(plan, new RegExp('USING (?:COVERING )?INDEX ' + index), query);
    assert.doesNotMatch(plan, /USE TEMP B-TREE/, query);
  }
  store.transaction(() => {
    const insert = store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)');
    for (let i = 0; i < 5000; i++) insert.run('history:' + i, 'untouched');
    for (const key of ['cache:entry:one', 'CACHE:ENTRY:two', 'cache:other:one']) insert.run(key, key);
  });
  const query = "SELECT value FROM settings WHERE key LIKE ? ESCAPE '\\' ORDER BY key";
  assert.deepEqual(store.db.prepare(query).all('cache:entry:%').map(row => row.value), ['CACHE:ENTRY:two', 'cache:entry:one']);
  const plan = store.db.prepare('EXPLAIN QUERY PLAN ' + query).all('cache:entry:%').map(row => row.detail).join('\n');
  assert.match(plan, /SEARCH settings USING INDEX settings_key_nocase/);
  assert.doesNotMatch(plan, /SCAN settings/);
});

test('opening the current schema does not contend with an existing writer or expose its uncommitted data', t => {
  const { store, file } = storeFixture(t, 'namo-schema-current-');
  store.transaction(() => {
    store.db.prepare('INSERT INTO settings VALUES(?,?)').run('uncommitted', 'private');
    const reader = new Store(file);
    try { assert.equal(reader.db.prepare("SELECT value FROM settings WHERE key='uncommitted'").get(), undefined); }
    finally { reader.close(); }
  });
  assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='uncommitted'").get()?.value, 'private');
});


test('retired schemas are rejected without changing data; a fresh baseline reopens identically', t => {
  const {store,file} = storeFixture(t,'namo-baseline-');
  store.enqueue(message('keep')); store.bindAccount('app');
  const baseline = databaseFingerprint(store.db);
  const reopened = new Store(file); assert.equal(databaseFingerprint(reopened.db),baseline); reopened.close();
  for (const version of [0,1,6,11,12]) {
    store.db.exec(`PRAGMA user_version=${version}`);
    const before = databaseFingerprint(store.db);
    assert.throws(()=>new Store(file),/旧测试库不再支持/);
    assert.equal(databaseFingerprint(store.db),before);
  }
  store.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('fresh schema DDL is atomic and retryable after a failed initialization', t => {
  const db = new DatabaseSync(':memory:'); t.after(()=>db.close());
  const exec = db.exec.bind(db);
  const mocked = t.mock.method(db,'exec',(sql:string)=>{
    if (sql.includes('CREATE TABLE memories')) { exec('CREATE TABLE partial(value TEXT)'); throw new Error('injected DDL failure'); }
    return exec(sql);
  });
  assert.throws(()=>migrateSchema(db),/injected DDL failure/); mocked.mock.restore();
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,0);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='partial'").get(),undefined);
  migrateSchema(db);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,SCHEMA_VERSION);
});

test('native queue indexes exclude terminal history and enforce leases, states and references', t => {
  const {store}=storeFixture(t,'namo-native-queues-');
  const insert=store.db.prepare(`INSERT INTO memory_jobs(id,sourceKey,ownerId,chatKey,chatType,state,attempts,createdAt,dueAt,leaseUntil,lease)
    VALUES(?,'source-key','owner','chat','p2p',?,0,1,10,?,?)`);
  store.transaction(()=>{
    for(let i=0;i<5000;i++)insert.run('history-'+i,'completed',0,null);
    insert.run('pending','pending',0,null);insert.run('running','running',20,'lease');
  });
  const queue=new BackgroundWork(store);
  assert.equal(queue.ready('memory',9),false);assert.equal(queue.ready('memory',10),true);
  const query="SELECT 1 FROM memory_jobs WHERE (state='pending' AND attempts<3 AND dueAt<=?) OR (state='running' AND leaseUntil<=?) LIMIT 1";
  const plan=JSON.stringify(store.db.prepare('EXPLAIN QUERY PLAN '+query).all(10,10));
  assert.match(plan,/memory_jobs_pending/);assert.match(plan,/memory_jobs_running/);assert.doesNotMatch(plan,/SCAN memory_jobs/);
  const finish=()=>store.db.prepare("UPDATE memory_jobs SET state='completed' WHERE id='pending'").run();
  assert.throws(()=>store.transaction(()=>{finish();throw new Error('rollback');}),/rollback/);
  assert.equal(queue.ready('memory',10),true);finish();assert.equal(queue.ready('memory',10),false);
  assert.equal(queue.ready('memory',20),true);
  assert.throws(()=>insert.run('bad','running',20,null),/CHECK constraint/);
  assert.throws(()=>insert.run('bad','nonsense',0,null),/CHECK constraint/);
  assert.throws(()=>store.db.prepare("INSERT INTO memory_job_messages(jobId,inboxKey) VALUES('pending','missing')").run(),/FOREIGN KEY/);
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='background_work' OR type='trigger'").get(),undefined);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM settings').get()?.n,0);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
