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
    ['task_runs_task_started', 'SELECT id,inputVersion,state,startedAt,finishedAt,error FROM task_runs WHERE taskId=? ORDER BY startedAt', ['task']],
    ['runner_events_run_seq', 'SELECT kind,createdAt FROM runner_events WHERE runId=? ORDER BY seq DESC LIMIT 100', ['run']],
    ['task_waits_task', "SELECT * FROM task_waits WHERE taskId=? AND state IN ('requested','open') ORDER BY rowid DESC LIMIT 1", ['task']],
    ['outbox_pending', `SELECT o.* FROM outbox o WHERE o.state='pending'
      AND NOT EXISTS (SELECT 1 FROM outbox p WHERE p.inboxKey=o.inboxKey AND p.kind=o.kind AND p.id<o.id AND p.state NOT IN ('sent','confirmed','dismissed'))
      ORDER BY o.id LIMIT 1`, []],
  ];
  for (const [index, query, args] of queries) {
    const plan = store.db.prepare('EXPLAIN QUERY PLAN ' + query).all(...args).map(row => row.detail).join('\n');
    assert.match(plan, new RegExp('USING INDEX ' + index), query);
    assert.doesNotMatch(plan, /USE TEMP B-TREE/, query);
  }
  store.transaction(() => {
    const insert = store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)');
    for (let i = 0; i < 5000; i++) insert.run('history:' + i, 'untouched');
    for (const key of ['memory:meta:one', 'MEMORY:META:two', 'memory:content:one']) insert.run(key, key);
  });
  const query = "SELECT value FROM settings WHERE key LIKE ? ESCAPE '\\' ORDER BY key";
  assert.deepEqual(store.db.prepare(query).all('memory:meta:%').map(row => row.value), ['MEMORY:META:two', 'memory:meta:one']);
  const plan = store.db.prepare('EXPLAIN QUERY PLAN ' + query).all('memory:meta:%').map(row => row.detail).join('\n');
  assert.match(plan, /SEARCH settings USING INDEX settings_key_nocase/);
  assert.doesNotMatch(plan, /SCAN settings/);
});

test('schema 11 gains indexes without rewriting any ledger, and reopening is idempotent', t => {
  const { store, file } = storeFixture(t, 'namo-index-upgrade-'), db = store.db;
  store.enqueue(message('original')); store.enqueue(message('queued', 'another-chat'));
  store.saveThread('workstream:W-one', 'native-thread'); store.bindAccount('fixture-app');
  store.addOutput('original', 'wait:WAIT-one', 'Keep the original question');
  db.exec(`
    INSERT INTO workstreams VALUES('W-one','chat','topic','user','app','/fixture','policy',1);
    INSERT INTO bindings VALUES('topic','user','W-one');
    INSERT INTO tasks(id,inboxKey,workstreamId,ownerId,chatKey,scopeKey,project,cwd,policyHash,state)
      VALUES('N-one','original','W-one','user','chat','topic','app','/fixture','policy','waiting');
    UPDATE inbox SET taskId='N-one',state='waiting',threadId='native-thread',turnId='native-turn' WHERE key='original';
    INSERT INTO task_messages VALUES('N-one','original','instruction',1,'applied');
    INSERT INTO task_runs VALUES('R-one','N-one',1,'waiting','native-thread','native-turn',1,2,NULL);
    INSERT INTO runner_jobs VALUES('R-one','worker-owner','completed',123,NULL,1,2,'config-revision','saved prompt','saved result',NULL);
    INSERT INTO runner_events(runId,kind,createdAt) VALUES('R-one','completed',2);
    INSERT INTO task_waits VALUES('WAIT-one','N-one','R-one','native-thread','native-turn','call','Question?',1,'open',1,NULL,NULL,NULL,'["yes","no"]');
    UPDATE task_waits SET rowid=42;
    UPDATE outbox SET state='unknown',error='transport_unknown',sendStartedAt=2,route='{"messageId":"original","thread":true}';
    INSERT INTO reconciliations(requestId,subject,actor,action,note,beforeState,createdAt)
      VALUES('reconcile-one','D-1','user','reviewed','Keep this audit','{"state":"unknown"}',3);
    INSERT INTO card_actions VALUES('token',1,'N-one','cancel',1,999,NULL);
    INSERT INTO user_profiles VALUES('feishu','fixture-app','user','Name','zh-CN','Asia/Shanghai',1,2);
    INSERT INTO profile_changes VALUES('feishu','fixture-app','user',1,'["name"]','local-owner',NULL,2);
    INSERT INTO run_evidence VALUES('R-one','{"state":"complete","items":[]}');
    INSERT INTO run_activity VALUES('R-one','waiting',2);
    INSERT INTO run_progress VALUES('R-one','{"version":1,"events":[]}');
    INSERT INTO message_feedback VALUES('original','sent','reaction',NULL,2);
    INSERT INTO progress_updates(outboxId,version,state,phase,content,createdAt) VALUES(1,1,'unknown','waiting','progress',2);
    INSERT INTO execution_bindings VALUES('N-one','{"profileId":"codex","adapter":"codex"}');
    INSERT INTO settings VALUES('auto-memory:job:fixture','{"version":1,"state":"pending","attempts":0,"dueAt":10,"leaseUntil":0,"createdAt":1}');
    INSERT INTO settings VALUES('memory:meta:fixture','{ "status": "deleted", "version": 2 }');
    INSERT INTO settings VALUES('artifact:fixture','{"state":"unknown","uuid":"never-resend"}');
    DROP INDEX task_runs_task_started; DROP INDEX runner_events_run_seq; DROP INDEX task_waits_task;
    DROP INDEX outbox_pending; DROP INDEX settings_key_nocase; PRAGMA user_version=11;
  `);
  const ledger = () => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [String(name), db.prepare(`SELECT rowid AS storedRowId,* FROM "${name}" ORDER BY rowid`).all()] as const));
  const before = ledger();
  assert.equal(Object.values(before).every(rows => rows.length > 0), true, 'fixture covers every ledger');
  const readOnly = new Store(file, true);
  try { assert.equal(readOnly.db.prepare('PRAGMA user_version').get()?.user_version, 11); }
  finally { readOnly.close(); }
  let migrated: string | undefined;
  for (let i = 0; i < 2; i++) {
    const reopened = new Store(file);
    try {
      assert.equal(reopened.db.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
      assert.deepEqual(ledger(), before);
      assert.deepEqual(reopened.db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(reopened.db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      const fingerprint = databaseFingerprint(reopened.db);
      if (migrated) assert.equal(fingerprint, migrated);
      migrated = fingerprint;
    } finally { reopened.close(); }
  }
});

test('failed schema initialization rolls back all DDL and data before a clean retry', t => {
  const dir = mkdtempSync(join(tmpdir(), 'namo-migration-rollback-')), file = join(dir, 'db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = new DatabaseSync(file);
  // Collide with the second index, after earlier migrations and the first index ran.
  original.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO settings VALUES('account','fixture-app'); CREATE TABLE runner_events_run_seq(value TEXT)");
  const before = databaseFingerprint(original); original.close();
  assert.throws(() => new Store(file), /already a table named runner_events_run_seq/);
  const inspect = new DatabaseSync(file);
  try {
    assert.equal(databaseFingerprint(inspect), before);
    inspect.exec('DROP TABLE runner_events_run_seq');
  } finally { inspect.close(); }
  const upgraded = new Store(file);
  try {
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
    assert.equal(upgraded.db.prepare("SELECT value FROM settings WHERE key='account'").get()?.value, 'fixture-app');
  } finally { upgraded.close(); }
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

test('schema 10 scheduling migration preserves the ledger and indexes only actionable work', t => {
  const dir = mkdtempSync(join(tmpdir(), 'namo-scheduling-')), file = join(dir, 'db');
  let store = new Store(file);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.db.exec(`DROP TRIGGER background_work_insert; DROP TRIGGER background_work_update;
    DROP TABLE background_work; DROP INDEX outbox_live_progress;
    ALTER TABLE outbox DROP COLUMN progressRetired;
    ALTER TABLE outbox DROP COLUMN sendStartedAt;
    ALTER TABLE outbox DROP COLUMN acceptedAt; PRAGMA user_version=10;`);
  const insert = store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)');
  const job = (state: string) => JSON.stringify({ version: 1, state, attempts: 0, dueAt: 10, leaseUntil: 20, createdAt: 1 });
  store.transaction(() => {
    for (let i = 0; i < 50_000; i++) insert.run('auto-memory:job:history-' + i, job('completed'));
    insert.run('auto-memory:job:pending', job('pending'));
    insert.run('auto-memory:job:running', job('running'));
    insert.run('auto-memory:job:malformed', '{broken');
    insert.run('artifact:pending', JSON.stringify({ state: 'pending', uuid: 'stable-id' }));
    insert.run('artifact:unknown', JSON.stringify({ state: 'unknown', uuid: 'do-not-retry' }));
    insert.run('artifact-intent:pending', JSON.stringify({ state: 'pending' }));
    insert.run('private-setting', 'unchanged');
  });
  const before = store.db.prepare('SELECT key,value FROM settings ORDER BY key').all();
  store.close(); store = new Store(file);
  assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
  assert.doesNotThrow(() => store.db.prepare('SELECT sendStartedAt,acceptedAt FROM outbox').all());
  assert.deepEqual(store.db.prepare('SELECT key,value FROM settings ORDER BY key').all(), before);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM background_work').get()?.n, 4);
  const queue = new BackgroundWork(store);
  assert.equal(queue.ready('memory', 9), false); assert.equal(queue.ready('memory', 10), true);
  assert.deepEqual(queue.records('memory', 10).map(r => r.key), ['auto-memory:job:pending']);
  assert.deepEqual(queue.records('artifact').map(r => r.key), ['artifact:pending']);
  const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM background_work WHERE kind='memory' AND readyAt<=10 LIMIT 1").all();
  assert.match(JSON.stringify(plan), /SEARCH.*background_work_ready/);
  assert.doesNotMatch(JSON.stringify(plan), /SCAN/);

  const finish = () => store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(job('completed'), 'auto-memory:job:pending');
  assert.throws(() => store.transaction(() => { finish(); throw new Error('rollback'); }), /rollback/);
  assert.equal(queue.ready('memory', 10), true);
  finish(); assert.equal(queue.ready('memory', 10), false); assert.equal(queue.ready('memory', 20), true);
  store.db.prepare("DELETE FROM settings WHERE key='artifact:pending'").run();
  assert.deepEqual(queue.records('artifact'), []);
  store.close(); store = new Store(file);
  assert.equal(new BackgroundWork(store).ready('memory', 10), false);
  assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='artifact:unknown'").get()?.value, JSON.stringify({ state: 'unknown', uuid: 'do-not-retry' }));
});
