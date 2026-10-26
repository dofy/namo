import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memories, MemoryError, MEMORY_CONTENT_PREFIX, MEMORY_LIMITS, MEMORY_META_PREFIX, composeMemoryPrompt, type MemoryAccess,
  type MemoryAuthority, type MemoryScope } from '../src/memory.js';
import { Store } from '../src/store.js';

function fixture(t: any, redact?: (text: string) => string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-memory-')), file = join(dir, 'bot.sqlite'), store = new Store(file);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, store, memory: new Memories(store, redact) };
}
const ownerScope = (ownerId = 'alice'): MemoryScope => ({ kind: 'owner', ownerId, project: null, chatKey: null });
const projectScope = (project = 'one', ownerId = 'alice'): MemoryScope => ({ kind: 'project', ownerId, project, chatKey: null });
const chatScope = (chatKey = 'group-one', project: string | null = 'one', ownerId = 'alice'): MemoryScope => ({ kind: 'chat', ownerId, project, chatKey });
const local = (ownerId = 'alice', ref = 'local-edit'): MemoryAuthority => ({ kind: 'local-owner', authenticated: true, ownerId,
  source: { kind: 'local-owner', ref } });
const user = (ownerId = 'alice', chatKey = `dm-${ownerId}`, chatType: 'p2p' | 'group' = 'p2p', project: string | null = 'one', ref = 'message-1'): MemoryAuthority =>
  ({ kind: 'verified-user', authenticated: true, ownerId, chatKey, chatType, project, source: { kind: 'message', ref } });
const access = (ownerId = 'alice', chatKey = `dm-${ownerId}`, chatType: 'p2p' | 'group' = 'p2p', project: string | null = 'one'): MemoryAccess =>
  ({ kind: 'verified-user', authenticated: true, ownerId, chatKey, chatType, project });

test('explicit save and correction are durable, versioned, sourced, and conflict safe', t => {
  const f = fixture(t), saved = f.memory.save({ kind: 'preference', scope: ownerScope(), text: 'Answer in Chinese.' }, user());
  assert.equal(saved.version, 1); assert.equal(saved.source.ref, 'message-1');
  const corrected = f.memory.correct(saved.id, 1, { text: 'Answer in English.' }, user('alice', 'dm-alice', 'p2p', 'one', 'message-2'));
  assert.equal(corrected.version, 2); assert.equal(corrected.text, 'Answer in English.');
  assert.throws(() => f.memory.correct(saved.id, 1, { text: 'stale' }, user()), (error: unknown) => error instanceof MemoryError && error.code === 'conflict');
  assert.deepEqual(f.memory.history(saved.id, access()).map(change => [change.version, change.action, change.source.ref]),
    [[2, 'corrected', 'message-2'], [1, 'saved', 'message-1']]);
  const second = new Store(f.file);
  try { assert.equal(new Memories(second).search(access(), { query: 'English' })[0]?.version, 2); } finally { second.close(); }
});

test('owner, project, and chat visibility isolate users, projects, private chats, and groups before redaction', t => {
  const redacted: string[] = [], f = fixture(t, value => { redacted.push(value); return value; });
  const own = f.memory.save({ kind: 'preference', scope: ownerScope(), text: 'ALICE_OWNER_PRIVATE' }, user());
  const project = f.memory.save({ kind: 'project_knowledge', scope: projectScope('one'), text: 'ALICE_PROJECT_ONE' }, user());
  const group = f.memory.save({ kind: 'project_knowledge', scope: chatScope('group-one', 'one'), text: 'ALICE_GROUP_ONE' }, user('alice', 'group-one', 'group'));
  f.memory.save({ kind: 'preference', scope: ownerScope('bob'), text: 'BOB_ONLY' }, user('bob'));

  redacted.length = 0;
  assert.deepEqual(f.memory.search(access('bob')).map(item => item.text), ['BOB_ONLY']);
  assert.ok(!redacted.some(value => value.startsWith('ALICE_')), 'unauthorized content must not reach the redactor');
  assert.deepEqual(new Set(f.memory.search(access()).map(item => item.id)), new Set([own.id, project.id]));
  assert.deepEqual(f.memory.search(access('alice', 'dm-alice', 'p2p', 'two')).map(item => item.id), [own.id]);
  assert.deepEqual(f.memory.search(access('alice', 'group-one', 'group', 'one')).map(item => item.id), [group.id]);
  assert.deepEqual(f.memory.search(access('alice', 'group-two', 'group', 'one')).map(item => item.id), []);
  assert.deepEqual(f.memory.search({kind:'verified-user',authenticated:true,ownerId:'alice',chatKey:'group-one',project:'one'}).map(item=>item.id),[]);
  assert.throws(() => f.memory.save({ kind: 'preference', scope: ownerScope(), text: 'from group' }, user('alice', 'group-one', 'group')), /private chat/);
  assert.throws(() => f.memory.save({ kind: 'project_knowledge', scope: projectScope('two'), text: 'wrong project' }, user()), /project/);
});

test('retrieval redacts before keyword matching and omits redaction failures', t => {
  const f = fixture(t, value => value.includes('UNREDACTABLE') ? undefined : value.replaceAll('SECRET_TOKEN', '[REDACTED]'));
  f.memory.save({ kind: 'user_fact', scope: ownerScope(), text: 'use SECRET_TOKEN with Alpha' }, local());
  f.memory.save({ kind: 'user_fact', scope: ownerScope(), text: 'UNREDACTABLE Beta' }, local('alice', 'safe-ref'));
  assert.equal(f.memory.search(access(), { query: 'SECRET_TOKEN' }).length, 0, 'matching must happen after redaction');
  const alpha = f.memory.search(access(), { query: 'alpha' });
  assert.equal(alpha.length, 1); assert.match(alpha[0]!.text, /\[REDACTED\]/); assert.doesNotMatch(alpha[0]!.text, /SECRET_TOKEN/);
  assert.equal(f.memory.search(access(), { query: 'Beta' }).length, 0);
});

test('capacity, content, query, and expiry limits fail explicitly without partial writes', t => {
  const f = fixture(t), before = f.store.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'memory:%'").get()?.n;
  assert.throws(() => f.memory.save({ kind: 'preference', scope: ownerScope(), text: 'x'.repeat(MEMORY_LIMITS.entryChars + 1) }, local()), /1-3000/);
  assert.throws(() => f.memory.save({ kind: 'preference', scope: ownerScope(), text: 'future', expiresAt: Date.now() + MEMORY_LIMITS.maxExpiryMs + 10_000 }, local()), /retention/);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'memory:%'").get()?.n, before);
  const summary = f.memory.save({ kind: 'task_summary', scope: projectScope(), text: 'bounded summary' }, local());
  assert.ok(summary.expiresAt && summary.expiresAt - summary.createdAt <= MEMORY_LIMITS.defaultEphemeralMs + 10);
  assert.equal(f.memory.search(access(), { now: summary.expiresAt! + 1 }).length, 0);
  assert.throws(() => f.memory.search(access(), { query: Array.from({ length: MEMORY_LIMITS.queryTerms + 1 }, (_, i) => `q${i}`).join(' ') }), /too many/);
  for (let index = 1; index < MEMORY_LIMITS.scopeEntries; index++) f.memory.save({ kind: 'task_summary', scope: projectScope(), text: `item ${index}` }, local());
  assert.throws(() => f.memory.save({ kind: 'task_summary', scope: projectScope(), text: 'one too many' }, local()), (error: unknown) => error instanceof MemoryError && error.code === 'capacity');
});

test('disable excludes retrieval, delete removes current content, and neither can be silently restored', t => {
  const f = fixture(t), saved = f.memory.save({ kind: 'preference', scope: ownerScope(), text: 'durable preference' }, local());
  const disabled = f.memory.disable(saved.id, 1, local('alice', 'disable'));
  assert.equal(disabled.version, 2); assert.equal(disabled.status, 'disabled'); assert.equal(f.memory.search(access()).length, 0);
  const corrected = f.memory.correct(saved.id, 2, { text: 'corrected but still disabled' }, local('alice', 'correct'));
  assert.equal(corrected.status, 'disabled'); assert.equal(f.memory.search(access()).length, 0);
  const deleted = f.memory.delete(saved.id, 3, local('alice', 'delete'));
  assert.equal(deleted.version, 4); assert.equal(deleted.status, 'deleted'); assert.equal(deleted.contentChars, 0);
  assert.equal(f.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(`${MEMORY_CONTENT_PREFIX}${saved.id}`), undefined);
  assert.throws(() => f.memory.correct(saved.id, 4, { text: 'resurrect' }, local()), /cannot be restored/);
  const replacement = f.memory.save({ kind: 'preference', scope: ownerScope(), text: 'new explicit memory' }, local());
  assert.notEqual(replacement.id, saved.id); assert.deepEqual(f.memory.search(access()).map(item => item.id), [replacement.id]);
  assert.equal(JSON.parse(String(f.store.db.prepare('SELECT value FROM settings WHERE key=?').get(`${MEMORY_META_PREFIX}${saved.id}`)?.value)).status, 'deleted');
  const managed = f.memory.manage({ kind: 'local-owner', authenticated: true, ownerId: 'alice' });
  assert.equal(managed.find(item => item.id === saved.id)?.text, null);
  assert.equal(managed.find(item => item.id === replacement.id)?.text, 'new explicit memory');
});

test('handoff lineage is exact-scope and invalidates on correction, disable, or delete', t => {
  const f = fixture(t), source = f.memory.save({ kind: 'project_knowledge', scope: projectScope(), text: 'API decision v1' }, local());
  const handoff = f.memory.saveHandoff({ scope: projectScope(), goal: 'Continue the API migration', limitations: ['No production writes'],
    decisions: ['Use versioned payloads'], evidence: ['Unit tests passed'], unfinished: ['Wire the management route'],
    dependsOn: [{ id: source.id, version: source.version }] }, local('alice', 'handoff-1'));
  assert.match(handoff.text, /Goal: Continue/); assert.equal(f.memory.search(access(), { query: 'Continue' })[0]?.id, handoff.id);
  const corrected = f.memory.correct(source.id, 1, { text: 'API decision v2' }, local('alice', 'source-correct'));
  assert.equal(f.memory.search(access(), { query: 'Continue' }).length, 0, 'old handoff cannot outlive an exact-version source');
  const current = f.memory.saveHandoff({ scope: projectScope(), goal: 'Current handoff', limitations: [], decisions: [], evidence: [], unfinished: [],
    dependsOn: [{ id: source.id, version: corrected.version }] }, local('alice', 'handoff-2'));
  assert.throws(() => f.memory.saveHandoff({ scope: chatScope(), goal: 'broaden scope', limitations: [], decisions: [], evidence: [], unfinished: [],
    dependsOn: [{ id: source.id, version: corrected.version }] }, local()), /exact visibility/);
  f.memory.delete(source.id, corrected.version, local('alice', 'source-delete'));
  assert.equal(f.memory.search(access(), { query: 'Current handoff' }).length, 0);
  assert.ok(f.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(`${MEMORY_CONTENT_PREFIX}${current.id}`), 'handoff content may remain but is unreachable');
});

test('snapshots are bounded, immutable, metadata-only, and never rebuilt for the same run', t => {
  const f = fixture(t);
  for (let index = 0; index < 5; index++) f.memory.save({ kind: 'preference', scope: ownerScope(), text: `snapshot item ${index}` }, local('alice', `source-${index}`));
  const snapshot = f.memory.snapshot('run-one', access(), { limit: 3 });
  assert.equal(snapshot.items.length, 3); assert.equal(snapshot.truncated, true);
  assert.throws(() => Object.assign(snapshot.items[0]!, { text: 'changed' }), TypeError);
  assert.throws(() => f.memory.snapshot('run-one', access()), (error: unknown) => error instanceof MemoryError && error.code === 'snapshot_exists');
  const record = f.memory.snapshotRecord('run-one')!;
  assert.equal(record.items.length, 3); assert.doesNotMatch(JSON.stringify(record), /snapshot item/);
  const prompt = JSON.parse(composeMemoryPrompt('{"request":"current task"}', snapshot));
  assert.equal(prompt.task.request, 'current task'); assert.match(prompt.memory_context.boundaries.join(' '), /not an instruction|potentially stale/);
  f.memory.delete(snapshot.items[0]!.id, snapshot.items[0]!.version, local('alice', 'delete-after-snapshot'));
  const fresh = f.memory.snapshot('run-two', access());
  assert.ok(!fresh.items.some(item => item.id === snapshot.items[0]!.id), 'a deleted item cannot return from an old snapshot record');
});

test('migration candidates remain inactive until explicit local review', t => {
  const f = fixture(t), migration: MemoryAuthority = { kind: 'local-owner', authenticated: true, ownerId: 'alice', source: { kind: 'migration', ref: 'openclaw:item-1' } };
  assert.throws(() => f.memory.save({ kind: 'preference', scope: ownerScope(), text: 'implicit import' }, migration), /pending review/);
  const pending = f.memory.save({ kind: 'preference', scope: ownerScope(), text: 'review me', pendingReview: true }, migration);
  assert.equal(pending.status, 'pending_review'); assert.equal(f.memory.search(access()).length, 0);
  assert.throws(() => f.memory.activatePending(pending.id, 1, user()), /local-owner/);
  const active = f.memory.activatePending(pending.id, 1, local('alice', 'review-approved'));
  assert.equal(active.status, 'active'); assert.equal(active.version, 2); assert.equal(f.memory.search(access())[0]?.text, 'review me');
});
