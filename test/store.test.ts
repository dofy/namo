import { migrateSchema } from '../src/schema-migrations.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, type Incoming, SCHEMA_VERSION } from '../src/store.js';
import { BackgroundWork } from '../src/background-work.js';
import { storeFixture, legacyDatabase } from './helpers.js';
import { databaseFingerprint } from '../src/upgrade-backup.js';

test('schema 14 migration snapshots task directories and preserves conversation identity',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-schema14-')),file=join(dir,'db');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const db=await legacyDatabase(file,14);
 db.exec(`INSERT INTO inbox(key,messageId,chatKey,chatId,senderId,text,createdAt) VALUES('i','m','c','c','u','historical text',1);
 INSERT INTO workstreams VALUES('w','c','c','u','old','/old/workspace','policy',1);
 INSERT INTO tasks(id,inboxKey,workstreamId,ownerId,chatKey,scopeKey,project,cwd,policyHash) VALUES('t','i','w','u','c','c','old','/old/workspace','policy');
 INSERT INTO sessions VALUES('workstream:w','native-thread');`);
 migrateSchema(db);assert.equal(db.prepare('pragma user_version').get()?.user_version,SCHEMA_VERSION);
 assert.equal(db.prepare('select text from inbox').get()?.text,'historical text');assert.equal(db.prepare('select threadId from sessions').get()?.threadId,'native-thread');
 assert.equal(db.prepare('select path from task_directories').get()?.path,'/old/workspace');
 assert.deepEqual(db.prepare('pragma foreign_key_check').all(),[]);migrateSchema(db);db.close();
});

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

test('schema 16 preserves memory bodies, privacy, versions, lineage and imports while removing named resources',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'namo-schema16-')),file=join(dir,'db');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=await legacyDatabase(file);
  db.exec(`INSERT INTO inbox(key,messageId,chatKey,chatId,senderId,text,createdAt,state) VALUES('i','m','c','c','alice','keep original conversation',1,'replied');
    INSERT INTO workstreams VALUES('w','c','c','alice','source','/shared/source','policy',1);
    INSERT INTO tasks(id,inboxKey,workstreamId,ownerId,chatKey,scopeKey,project,cwd,policyHash,state) VALUES('t','i','w','alice','c','c','source','/shared/source','policy','succeeded');
    INSERT INTO task_directories VALUES('t','/shared/source');
    INSERT INTO task_runs(id,taskId,inputVersion,state,startedAt) VALUES('run','t',1,'succeeded',1);
    INSERT INTO sessions VALUES('workstream:w','native-thread');
    INSERT INTO outbox(inboxKey,chatId,kind,part,content,uuid,state,createdAt) VALUES('i','c','result',0,'keep original reply','uuid','sent',1);`);
  const {Memories}=await import('../src/memory.js');
  const ids=['M-AAAAAAAAAAAAAAAA','M-BBBBBBBBBBBBBBBB','M-CCCCCCCCCCCCCCCC','M-DDDDDDDDDDDDDDDD'];
  for(const [index,id] of ids.entries()) {
    const scope=index===0?'project':index===1||index===2?'local':'chat',name=index===2?'missing':'source';
    const privacy=index===1?'shared':index===2?'private':'chat';
    db.prepare(`INSERT INTO memories(id,version,kind,status,scopeKind,ownerId,project,chatKey,sourceKind,sourceRef,dependsOn,resourceProjects,visibility,contentChars,createdAt,updatedAt)
      VALUES(?,3,'project_knowledge','active',?,'alice',?,?,'message','source',?,?,?,5,1,2)`).run(id,scope,name,scope==='chat'?'c':null,JSON.stringify(index===3?[{id:ids[0],version:3}]:[]),JSON.stringify([name]),scope==='local'?JSON.stringify({privacy,chatKey:null}):null);
    db.prepare('INSERT INTO memory_contents VALUES(?,3,?)').run(id,'body'+index);
    db.prepare("INSERT INTO memory_changes VALUES(?,3,'corrected','message','source',2)").run(id);
  }
  db.prepare("UPDATE memories SET kind='handoff' WHERE id=?").run(ids[3]);
  db.prepare('INSERT INTO memory_snapshots VALUES(?,1,0,?)').run('run',JSON.stringify(ids.map(id=>({id,version:3}))));
  db.prepare('INSERT INTO settings VALUES(?,?)').run('memory:migration-import:v1:old',JSON.stringify({schema:1,fingerprint:'f'.repeat(64),scope:{kind:'project',ownerId:'alice',project:'source',chatKey:null},memoryId:ids[0],sourceRef:'legacy-import',importedAt:1}));
  db.prepare('INSERT INTO settings VALUES(?,?)').run('material-project:i',JSON.stringify({project:'source',cwd:'/shared/source',policyHash:'policy'}));
  db.prepare('INSERT INTO settings VALUES(?,?)').run('mcp-read-scope:w',JSON.stringify([{taskId:'t',id:'linear',scope:'saved-scope',version:2}]));
  const before={inbox:db.prepare('SELECT * FROM inbox').all(),outbox:db.prepare('SELECT * FROM outbox').all(),contents:db.prepare('SELECT * FROM memory_contents ORDER BY memoryId').all(),changes:db.prepare('SELECT * FROM memory_changes ORDER BY memoryId').all(),snapshots:db.prepare('SELECT * FROM memory_snapshots').all()};
  // A corrupt foreign-key graph must roll back the entire schema, never leave a partial migration.
  db.exec('PRAGMA foreign_keys=OFF');
  db.prepare("INSERT INTO memory_changes VALUES('missing',1,'saved','message','source',1)").run();
  assert.throws(()=>migrateSchema(db),/migration_foreign_key_violation/);
  assert.equal(db.prepare('pragma user_version').get()?.user_version,15);
  assert.ok(db.prepare('pragma table_info(tasks)').all().some(row=>row.name==='project'));
  db.prepare("DELETE FROM memory_changes WHERE memoryId='missing'").run();
  migrateSchema(db);
  assert.deepEqual({inbox:db.prepare('SELECT * FROM inbox').all(),outbox:db.prepare('SELECT * FROM outbox').all(),contents:db.prepare('SELECT * FROM memory_contents ORDER BY memoryId').all(),changes:db.prepare('SELECT * FROM memory_changes ORDER BY memoryId').all(),snapshots:db.prepare('SELECT * FROM memory_snapshots').all()},before);
  for(const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all())assert.equal(db.prepare(`PRAGMA table_info(${row.name})`).all().some(column=>/project/i.test(String(column.name))),false);
  assert.deepEqual(db.prepare('pragma foreign_key_check').all(),[]);assert.equal(db.prepare('pragma integrity_check').get()?.integrity_check,'ok');
  const importRow=db.prepare("SELECT key,value FROM settings WHERE key LIKE 'memory:migration-import:v1:%'").get()!;
  assert.notEqual(importRow.key,'memory:migration-import:v1:old');assert.equal(JSON.parse(String(importRow.value)).scope.directory,'/shared/source');
  assert.equal(JSON.parse(String(db.prepare("SELECT value FROM settings WHERE key='mcp-read-scope:w'").get()!.value))[0].legacyContext,'source');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='material-project:i'").get(),undefined);
  const stable=databaseFingerprint(db);migrateSchema(db);assert.deepEqual(databaseFingerprint(db),stable);db.close();
  const store=new Store(file);t.after(()=>store.close());const memories=new Memories(store);
  const access={kind:'verified-user' as const,authenticated:true,ownerId:'bob',chatType:'group' as const,chatKey:'other',allowedDirectories:['/shared/source']};
  assert.deepEqual(memories.search(access).map(row=>row.id),[ids[1]]);
  const owner=memories.manage({kind:'local-owner',authenticated:true,ownerId:'alice'});
  assert.equal(owner.length,4);assert.ok(owner.every(row=>row.version===3)&&owner.filter(row=>row.kind==='knowledge').length===3);
  assert.equal(owner.find(row=>row.id===ids[2])?.visibility?.privacy,'private');
  assert.equal(owner.find(row=>row.id===ids[2])?.scope.kind,'global');
});

test('directory migration preserves imports when multiple old scopes converge',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'namo-schema16-imports-')),file=join(dir,'db');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=await legacyDatabase(file);t.after(()=>db.close());
  for(const [index,name] of ['one','two'].entries()) {
    db.prepare('INSERT INTO workstreams VALUES(?,?,?,?,?,?,?,1)').run('w'+index,'c','c','alice',name,'/shared/source','policy');
    const id='M-'+(index?'B':'A').repeat(16);
    db.prepare(`INSERT INTO memories(id,version,kind,status,scopeKind,ownerId,project,sourceKind,sourceRef,dependsOn,resourceProjects,contentChars,createdAt,updatedAt)
      VALUES(?,1,'project_knowledge','active','project','alice',?,'migration','ref','[]','[]',4,1,1)`).run(id,name);
    db.prepare('INSERT INTO memory_contents VALUES(?,1,?)').run(id,'keep');
    db.prepare('INSERT INTO settings VALUES(?,?)').run('memory:migration-import:v1:'+name,JSON.stringify({schema:1,fingerprint:'f'.repeat(64),scope:{kind:'project',ownerId:'alice',project:name,chatKey:null},memoryId:id,sourceRef:'ref',importedAt:1}));
  }
  migrateSchema(db);
  const imports=db.prepare("SELECT key,value FROM settings WHERE key LIKE 'memory:migration-import:v1:%' ORDER BY key").all();
  assert.equal(imports.length,2);assert.equal(new Set(imports.map(row=>JSON.parse(String(row.value)).memoryId)).size,2);
  assert.ok(imports.every(row=>JSON.parse(String(row.value)).scope.directory==='/shared/source'));
  assert.equal(db.prepare('SELECT count(*) n FROM memory_contents').get()?.n,2);
  const stable=databaseFingerprint(db);migrateSchema(db);assert.deepEqual(databaseFingerprint(db),stable);
});
