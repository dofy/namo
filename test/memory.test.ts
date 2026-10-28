import { storeFixture, seedRun } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memories, MemoryError, MEMORY_LIMITS, composeMemoryPrompt, type MemoryAccess, type MemoryAuthority, type MemoryScope, type AutomaticMemoryInput } from '../src/memory.js';
import { Store, type Incoming } from '../src/store.js';
import { memoryCommand } from '../src/memory-commands.js';

function fixture(t: any, redact?: (text: string) => string | undefined) {
  const { dir, file, store } = storeFixture(t, 'namo-memory-');
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
  const f = fixture(t), before = f.store.db.prepare("SELECT COUNT(*) AS n FROM memories").get()?.n;
  assert.throws(() => f.memory.save({ kind: 'preference', scope: ownerScope(), text: 'x'.repeat(MEMORY_LIMITS.entryChars + 1) }, local()), /1-3000/);
  assert.throws(() => f.memory.save({ kind: 'preference', scope: ownerScope(), text: 'future', expiresAt: Date.now() + MEMORY_LIMITS.maxExpiryMs + 10_000 }, local()), /retention/);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM memories").get()?.n, before);
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
  assert.equal(f.store.db.prepare('SELECT 1 FROM memory_contents WHERE memoryId=?').get(saved.id), undefined);
  assert.throws(() => f.memory.correct(saved.id, 4, { text: 'resurrect' }, local()), /cannot be restored/);
  const replacement = f.memory.save({ kind: 'preference', scope: ownerScope(), text: 'new explicit memory' }, local());
  assert.notEqual(replacement.id, saved.id); assert.deepEqual(f.memory.search(access()).map(item => item.id), [replacement.id]);
  assert.equal(f.store.db.prepare('SELECT status FROM memories WHERE id=?').get(saved.id)?.status, 'deleted');
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
  assert.ok(f.store.db.prepare('SELECT 1 FROM memory_contents WHERE memoryId=?').get(current.id), 'handoff content may remain but is unreachable');
});

test('snapshots are bounded, immutable, metadata-only, and never rebuilt for the same run', t => {
  const f = fixture(t);
  for (let index = 0; index < 5; index++) f.memory.save({ kind: 'preference', scope: ownerScope(), text: `snapshot item ${index}` }, local('alice', `source-${index}`));
  seedRun(f.store, 'run-one'); seedRun(f.store, 'run-two');
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

function authority(overrides: Partial<MemoryAuthority> = {}): MemoryAuthority {
  return { kind: 'local-owner', authenticated: true, ownerId: 'alice', chatKey: 'dm-alice', chatType: 'p2p', project: 'atlas',
    source: { kind: 'automatic', ref: 'auto-job-one' }, ...overrides };
}
function automaticMemoryStorageAccess(overrides: Partial<MemoryAccess> = {}): MemoryAccess {
  return { kind: 'verified-user', authenticated: true, ownerId: 'alice', chatKey: 'dm-alice', chatType: 'p2p', project: 'atlas', ...overrides };
}
function candidate(overrides: Partial<AutomaticMemoryInput> = {}): AutomaticMemoryInput {
  return { key: 'person.alice.role', kind: 'user_fact', level: 'global', privacy: 'shared', text: 'Alice maintains Atlas.',
    sourceMessageIds: ['message-one'], evidence: ['I maintain Atlas.'], observedAt: 100, ...overrides };
}
const ids = (memory: Memories, who: MemoryAccess) => memory.search(who, { limit: 20 }).map(row => row.id).sort();

test('organization project ACL limits shared overviews, model misclassification, and derived handoffs', t => {
  const f = fixture(t);
  const overview = f.memory.upsertAutomatic(candidate({ kind: 'project_knowledge', project: 'atlas' }), authority())!;
  const mislabeled = f.memory.upsertAutomatic(candidate({ key: 'other', kind: 'user_fact', project: null }), authority())!;
  const who = automaticMemoryStorageAccess({ ownerId: 'bob', project: 'other', allowedProjects: [] });
  assert.deepEqual(ids(f.memory, who), []);
  assert.deepEqual(ids(f.memory, { ...who, allowedProjects: ['atlas'] }), [overview.id, mislabeled.id].sort());
  const handoff = f.memory.saveHandoff({ scope: { kind: 'chat', ownerId: 'bob', project: 'other', chatKey: 'dm-alice' },
    goal: 'Continue', limitations: [], decisions: [], evidence: [], unfinished: [], dependsOn: [{ id: overview.id, version: overview.version }] },
    authority({ ownerId: 'bob', project: 'other' }));
  assert.ok(!ids(f.memory, who).includes(handoff.id));
});

test('global memories retain host-owned project provenance after a local correction', t => {
  const f = fixture(t), saved = f.memory.upsertAutomatic(candidate({ project: null }), authority())!;
  const who = automaticMemoryStorageAccess({ ownerId: 'bob', allowedProjects: [] });
  assert.deepEqual(ids(f.memory, who), []);
  assert.deepEqual(ids(f.memory, { ...who, allowedProjects: ['atlas'] }), [saved.id]);
  f.memory.correct(saved.id, saved.version, { text: 'Corrected overview.' }, authority({ source: { kind: 'local-owner', ref: 'current-correction' } }));
  assert.deepEqual(ids(f.memory, who), []);
  assert.deepEqual(f.memory.manage({ kind: 'local-owner', authenticated: true, ownerId: 'alice' })[0]?.resourceProjects, ['atlas']);
});

test('handoffs can depend on shared global facts without carrying private or another project details', t => {
  const f=fixture(t);
  const shared=f.memory.upsertAutomatic(candidate(),authority())!;
  const privateFact=f.memory.upsertAutomatic(candidate({key:'person.private',privacy:'private',text:'Private source.',evidence:['A private fact.']}),authority())!;
  const detail=f.memory.upsertAutomatic(candidate({key:'project.detail',kind:'project_knowledge',level:'local',text:'Atlas specific detail.',evidence:['Atlas details.']}),authority())!;
  const scope={kind:'chat' as const,ownerId:'bob',project:'other',chatKey:'other-team'};
  const input={scope,goal:'Coordinate projects',limitations:[],decisions:[],evidence:[],unfinished:[],dependsOn:[{id:shared.id,version:shared.version}]};
  const actor=authority({ownerId:'bob',chatKey:'other-team',chatType:'group',project:'other'});
  const handoff=f.memory.saveHandoff(input,actor);
  assert.ok(ids(f.memory,automaticMemoryStorageAccess({ownerId:'bob',chatKey:'other-team',chatType:'group',project:'other'})).includes(handoff.id));
  for(const source of [privateFact,detail])assert.throws(()=>f.memory.saveHandoff({...input,dependsOn:[{id:source.id,version:source.version}]},actor),/visibility/);
  f.memory.correct(shared.id,shared.version,{text:'New shared fact.'},authority());
  assert.ok(!ids(f.memory,automaticMemoryStorageAccess({ownerId:'bob',chatKey:'other-team',chatType:'group',project:'other'})).includes(handoff.id));
});

test('global shared facts survive reopening and are readable by other paired conversation principals', t => {
  const f = fixture(t), saved = f.memory.upsertAutomatic(candidate(), authority())!;
  assert.deepEqual(ids(f.memory, automaticMemoryStorageAccess({ ownerId: 'bob', chatKey: 'dm-bob' })), [saved.id]);
  assert.deepEqual(ids(f.memory, automaticMemoryStorageAccess({ ownerId: 'bob', chatKey: 'team', chatType: 'group', project: 'other' })), [saved.id]);
  assert.throws(() => f.memory.search(automaticMemoryStorageAccess({ authenticated: false })), /not verified/);
  const reopened = new Store(f.file, true);
  try { assert.equal(new Memories(reopened).search(automaticMemoryStorageAccess({ ownerId: 'bob' }))[0]?.text, 'Alice maintains Atlas.'); }
  finally { reopened.close(); }
});

test('private and conversation facts are filtered before private content reaches redaction', t => {
  const visited: string[] = [], f = fixture(t, text => { visited.push(text); return text; });
  const privateFact = f.memory.upsertAutomatic(candidate({ key: 'alice.private', privacy: 'private', text: 'PRIVATE_ALICE_DETAIL' }), authority())!;
  const conversationFact = f.memory.upsertAutomatic(candidate({ key: 'team.detail', privacy: 'chat', text: 'TEAM_DETAIL' }),
    authority({ chatKey: 'team', chatType: 'group' }))!;
  visited.length = 0;
  assert.deepEqual(ids(f.memory, automaticMemoryStorageAccess({ ownerId: 'bob', chatKey: 'team', chatType: 'group' })), [conversationFact.id]);
  assert.ok(!visited.includes('PRIVATE_ALICE_DETAIL'));
  visited.length = 0;
  assert.deepEqual(ids(f.memory, automaticMemoryStorageAccess({ chatKey: 'other-team', chatType: 'group' })), []);
  assert.ok(!visited.includes('PRIVATE_ALICE_DETAIL') && !visited.includes('TEAM_DETAIL'));
  assert.deepEqual(ids(f.memory, automaticMemoryStorageAccess({ project: 'other' })), [privateFact.id]);
  assert.deepEqual(ids(f.memory, automaticMemoryStorageAccess({ ownerId: 'bob', chatKey: 'dm-bob' })), []);
});

test('project detail stays local while relevant global overviews support cross-project discussion', t => {
  const f = fixture(t);
  const detail = f.memory.upsertAutomatic(candidate({ key: 'atlas.table-layout', level: 'local', kind: 'project_knowledge', text: 'Atlas table uses fixed pagination.' }), authority())!;
  const overview = f.memory.upsertAutomatic(candidate({ key: 'atlas.overview', project: 'atlas', kind: 'project_knowledge', text: 'Atlas serves the internal admin tooling.' }), authority())!;
  assert.deepEqual(ids(f.memory, automaticMemoryStorageAccess({ ownerId: 'bob', chatType: 'group', chatKey: 'atlas-team' })), [detail.id, overview.id].sort());
  const elsewhere = automaticMemoryStorageAccess({ ownerId: 'bob', chatKey: 'other-team', chatType: 'group', project: 'other' });
  assert.deepEqual(f.memory.search(elsewhere, { relevantText: 'Investigate billing failures.' }).map(row => row.id), []);
  assert.deepEqual(f.memory.search(elsewhere, { relevantText: 'Compare Atlas with the other project.' }).map(row => row.id), [overview.id]);
  assert.throws(() => f.memory.upsertAutomatic(candidate({ level: 'local', project: 'other' }), authority()), /project does not match/);
});

test('cross-project relevance recognizes Chinese phrases and keeps empty context distinct from omitted context', t => {
  const f = fixture(t);
  const overview = f.memory.upsertAutomatic(candidate({ key: 'atlas.cn', project: 'atlas', kind: 'project_knowledge', text: '负责订单处理和支付。' }), authority())!;
  const elsewhere = automaticMemoryStorageAccess({ ownerId: 'bob', chatKey: 'other-team', chatType: 'group', project: 'other' });
  assert.deepEqual(f.memory.search(elsewhere, { relevantText: '检查订单处理流程' }).map(row => row.id), [overview.id]);
  assert.deepEqual(f.memory.search(elsewhere, { relevantText: '' }).map(row => row.id), []);
  assert.deepEqual(f.memory.search(elsewhere).map(row => row.id), [overview.id]);
});

test('automatic extraction is idempotent, corrects a concept in place, and cannot roll back newer observations', t => {
  const f = fixture(t), first = f.memory.upsertAutomatic(candidate(), authority())!;
  const same = f.memory.upsertAutomatic(candidate({ observedAt: 110, sourceMessageIds: ['message-repeat'] }), authority())!;
  assert.equal(same.id, first.id); assert.equal(same.version, 1);
  const updated = f.memory.upsertAutomatic(candidate({ text: 'Alice now maintains Boreal.', observedAt: 120,
    sourceMessageIds: ['message-correction'], evidence: ['I now maintain Boreal.'] }), authority({ source: { kind: 'automatic', ref: 'auto-job-two' } }))!;
  assert.equal(updated.id, first.id); assert.equal(updated.version, 2);
  assert.equal(f.memory.upsertAutomatic(candidate({ text: 'Stale role.', observedAt: 115 }), authority()), undefined);
  assert.equal(f.memory.search(automaticMemoryStorageAccess())[0]?.text, 'Alice now maintains Boreal.');
  assert.deepEqual(f.memory.history(first.id, automaticMemoryStorageAccess()).map(row => row.action), ['corrected', 'saved']);
});

test('a later repeated fact advances the observation watermark without creating a needless version', t => {
  const f = fixture(t), first = f.memory.upsertAutomatic(candidate({ observedAt: 100 }), authority())!;
  f.memory.upsertAutomatic(candidate({ observedAt: 200, sourceMessageIds: ['newer-confirmation'] }), authority());
  assert.equal(f.memory.upsertAutomatic(candidate({ observedAt: 150, text: 'Out-of-order obsolete role.' }), authority()), undefined);
  const current = f.memory.search(automaticMemoryStorageAccess())[0]!;
  assert.equal(current.id, first.id); assert.equal(current.version, 1); assert.equal(current.text, first.text);
  assert.equal(f.memory.history(first.id, automaticMemoryStorageAccess()).length, 1);
});

test('manual corrections, disabling, and deletion cannot be undone by automatic replay', t => {
  const f = fixture(t), local = authority({ source: { kind: 'local-owner', ref: 'workbench-correction' } });
  const edited = f.memory.upsertAutomatic(candidate({ key: 'manual-edit' }), authority())!;
  f.memory.correct(edited.id, 1, { text: 'Manually corrected fact.' }, local);
  assert.equal(f.memory.upsertAutomatic(candidate({ key: 'manual-edit', text: 'Model overwrite.', observedAt: 200 }), authority()), undefined);
  assert.equal(f.memory.search(automaticMemoryStorageAccess()).find(row => row.id === edited.id)?.text, 'Manually corrected fact.');
  const disabled = f.memory.upsertAutomatic(candidate({ key: 'disabled', text: 'Distinct disabled fact.', evidence: ['This is a distinct disabled fact.'] }), authority())!;
  f.memory.disable(disabled.id, 1, local);
  assert.equal(f.memory.upsertAutomatic(candidate({ key: 'disabled', observedAt: 200 }), authority()), undefined);
  const deleted = f.memory.upsertAutomatic(candidate({ key: 'deleted', text: 'Distinct deleted fact.', evidence: ['This is a distinct deleted fact.'] }), authority())!;
  f.memory.delete(deleted.id, 1, local);
  assert.equal(f.memory.upsertAutomatic(candidate({ key: 'deleted', text: 'Old transcript replay.', observedAt: 200 }), authority()), undefined);
  assert.equal(f.store.db.prepare('SELECT 1 FROM memory_contents WHERE memoryId=?').get(deleted.id), undefined);
  assert.equal(f.store.db.prepare('SELECT status FROM memories WHERE id=?').get(deleted.id)?.status, 'deleted');
  assert.ok(!ids(f.memory, automaticMemoryStorageAccess()).includes(disabled.id) && !ids(f.memory, automaticMemoryStorageAccess()).includes(deleted.id));
});

test('an automatic correction preserves privacy and automatic forgetting leaves a tombstone', t => {
  const f = fixture(t), secret = f.memory.upsertAutomatic(candidate({ key: 'private-role', privacy: 'private', text: 'Private role A.' }), authority())!;
  const corrected = f.memory.upsertAutomatic(candidate({ key: 'private-role', privacy: 'shared', text: 'Private role B.', observedAt: 200 }), authority())!;
  assert.equal(corrected.id, secret.id); assert.equal(corrected.visibility?.privacy, 'private');
  assert.deepEqual(ids(f.memory, automaticMemoryStorageAccess({ ownerId: 'bob' })), []);
  const scoped = f.memory.upsertAutomatic(candidate({ key: 'chat-only', privacy: 'chat' }), authority({ chatKey: 'team-one', chatType: 'group' }))!;
  const later = f.memory.upsertAutomatic(candidate({ key: 'chat-only', privacy: 'shared', text: 'Updated team context.', observedAt: 200 }),
    authority({ chatKey: 'team-two', chatType: 'group' }))!;
  assert.equal(later.id, scoped.id); assert.deepEqual(later.visibility, { privacy: 'private', chatKey: null });
  assert.ok(!ids(f.memory, automaticMemoryStorageAccess({ ownerId: 'bob', chatKey: 'team-one', chatType: 'group' })).includes(scoped.id));
  assert.equal(f.memory.upsertAutomatic(candidate({ key: 'private-role', operation: 'forget', text: 'Forget that role.', observedAt: 300 }), authority()), undefined);
  assert.equal(f.memory.upsertAutomatic(candidate({ key: 'private-role', text: 'Resurrected.', observedAt: 400 }), authority()), undefined);
  assert.ok(!ids(f.memory, automaticMemoryStorageAccess()).includes(secret.id));
});

test('private person concepts cannot widen or revive by moving from global into a local project scope', t => {
  const f = fixture(t), first = f.memory.upsertAutomatic(candidate({ key: 'person.contact', privacy: 'private', text: 'Alice has a private contact route.',
    evidence: ['My contact route is private.'] }), authority())!;
  const updated = f.memory.upsertAutomatic(candidate({ key: 'person.contact', level: 'local', project: 'atlas', privacy: 'shared',
    text: 'Alice updated her private contact route.', evidence: ['I updated my private contact route.'], observedAt: 200 }), authority())!;
  assert.equal(updated.id, first.id); assert.equal(updated.scope.kind, 'global'); assert.equal(updated.scope.project, null);
  assert.deepEqual(updated.visibility, { privacy: 'private', chatKey: null });
  assert.deepEqual(ids(f.memory, automaticMemoryStorageAccess({ ownerId: 'bob', chatKey: 'atlas-team', chatType: 'group' })), []);
  f.memory.delete(updated.id, updated.version, authority({ source: { kind: 'local-owner', ref: 'explicit-forget' } }));
  assert.equal(f.memory.upsertAutomatic(candidate({ key: 'person.contact', level: 'local', project: 'atlas', privacy: 'shared',
    text: 'Recreated contact data.', evidence: ['An alternative claim about contact data.'], observedAt: 300 }), authority()), undefined);
  assert.deepEqual(ids(f.memory, automaticMemoryStorageAccess()), []);
});

test('a private correction to a group-only fact is never disclosed back into the original group', t => {
  const f = fixture(t);
  const old = f.memory.upsertAutomatic(candidate({ key: 'person.arrangement', privacy: 'chat', text: 'An arrangement discussed in the team.',
    evidence: ['This arrangement is for our team.'] }), authority({ chatKey: 'original-team', chatType: 'group' }))!;
  const privateUpdate = f.memory.upsertAutomatic(candidate({ key: 'person.arrangement', privacy: 'private', text: 'A private correction from Alice.',
    evidence: ['The correction is private.'], observedAt: 200 }), authority())!;
  assert.equal(privateUpdate.id, old.id); assert.deepEqual(privateUpdate.visibility, { privacy: 'private', chatKey: null });
  assert.deepEqual(ids(f.memory, automaticMemoryStorageAccess({ ownerId: 'bob', chatKey: 'original-team', chatType: 'group' })), []);
  assert.equal(f.memory.search(automaticMemoryStorageAccess())[0]?.text, 'A private correction from Alice.');
  const other = f.memory.upsertAutomatic(candidate({ key: 'person.arrangement', privacy: 'chat', text: 'A later correction from a second team.',
    evidence: ['A correction for another team.'], observedAt: 300 }), authority({ chatKey: 'second-team', chatType: 'group' }))!;
  assert.deepEqual(other.visibility, { privacy: 'private', chatKey: null });
  assert.deepEqual(ids(f.memory, automaticMemoryStorageAccess({ ownerId: 'bob', chatKey: 'original-team', chatType: 'group' })), []);
  assert.deepEqual(ids(f.memory, automaticMemoryStorageAccess({ ownerId: 'bob', chatKey: 'second-team', chatType: 'group' })), []);
  assert.equal(f.memory.search(automaticMemoryStorageAccess())[0]?.text, 'A later correction from a second team.');
});

test('deletion fingerprints prevent resurrection under another key using the deleted text or its old evidence', t => {
  const f = fixture(t), original = f.memory.upsertAutomatic(candidate({ key: 'person.deleted-concept', text: 'A fact Alice explicitly removed.',
    evidence: ['This source originally established the removed fact.'] }), authority())!;
  f.memory.delete(original.id, original.version, authority({ source: { kind: 'local-owner', ref: 'forget-source' } }));
  assert.equal(f.memory.upsertAutomatic(candidate({ key: 'person.new-alias', text: 'A fact Alice explicitly removed.',
    evidence: ['A different extraction quote.'], observedAt: 200 }), authority()), undefined);
  assert.equal(f.memory.upsertAutomatic(candidate({ key: 'person.another-alias', text: 'Rephrased resurrection of the removed information.',
    evidence: ['This source originally established the removed fact.'], observedAt: 300 }), authority()), undefined);
  assert.deepEqual(ids(f.memory, automaticMemoryStorageAccess()), []);
});

test('automatic provenance stores bounded evidence hashes rather than original quoted content', t => {
  const f = fixture(t), quote = 'A source statement that belongs only in the original conversation.';
  const saved = f.memory.upsertAutomatic(candidate({ evidence: [quote], sourceMessageIds: ['source-one', 'source-one'] }), authority())!;
  const raw = String(f.store.db.prepare('SELECT automatic FROM memories WHERE id=?').get(saved.id)?.automatic);
  assert.doesNotMatch(raw, /A source statement/);
  assert.deepEqual(saved.automatic?.sourceMessageIds, ['source-one']);
  assert.match(saved.automatic!.evidence[0]!, /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => f.memory.upsertAutomatic(candidate(), authority({ authenticated: false })), /authenticated/);
  assert.throws(() => f.memory.upsertAutomatic(candidate(), authority({ source: { kind: 'message', ref: 'untrusted-path' } })), /verified host/);
});

test('legacy owner memories remain private and legacy handoffs still invalidate with their source', t => {
  const f = fixture(t), local = authority({ source: { kind: 'local-owner', ref: 'legacy-setup' } });
  const scope = { kind: 'owner' as const, ownerId: 'alice', project: null, chatKey: null };
  const source = f.memory.save({ kind: 'preference', scope, text: 'Legacy private preference.' }, local);
  const handoff = f.memory.saveHandoff({ scope, goal: 'Continue private work', limitations: [], decisions: [], evidence: [], unfinished: [],
    dependsOn: [{ id: source.id, version: source.version }] }, local);
  assert.deepEqual(ids(f.memory, automaticMemoryStorageAccess({ ownerId: 'bob' })), []);
  assert.deepEqual(ids(f.memory, automaticMemoryStorageAccess({ chatType: 'group', chatKey: 'team' })), []);
  assert.ok(ids(f.memory, automaticMemoryStorageAccess()).includes(handoff.id));
  f.memory.correct(source.id, source.version, { text: 'Changed legacy preference.' }, local);
  assert.ok(!ids(f.memory, automaticMemoryStorageAccess()).includes(handoff.id));
});

const message=(text:string):Incoming=>({key:'app:original',messageId:'original',chatKey:'app:chat',chatId:'chat',senderId:'owner',text,envelope:{version:1,type:'text',kind:'instruction',chatType:'p2p',scopeKey:'app:chat',materials:[],limitations:[]}});
test('private commands can disable and forget owned automatic memories without reclassifying their audience', t => {
  const f = fixture(t), actor = authority({ ownerId: 'owner', chatKey: 'app:chat' });
  const run = (text: string) => memoryCommand(f.store, message(text), ['owner'], 'atlas', x => x, ['atlas'])!;
  for (const level of ['global', 'local'] as const) for (const privacy of ['shared', 'private'] as const) {
    const text = `Durable ${level} ${privacy} project fact.`, input = candidate({ key: `project.${level}.${privacy}`, level, privacy, text, evidence: [text] });
    const saved = f.memory.upsertAutomatic(input, actor)!;
    assert.match(run(`/memory-correct ${saved.id} 1 unclassified content`), /未完成/);
    assert.match(run(`/memory-disable ${saved.id} 1`), /v2/);
    const disabled = f.memory.manage({ ...actor, allowedProjects: ['atlas'] }).find(row => row.id === saved.id)!;
    assert.equal(disabled.status, 'disabled'); assert.deepEqual(disabled.visibility, saved.visibility);
    assert.match(run(`/forget ${saved.id} 1`), /未完成/);
    assert.match(run(`/forget ${saved.id} 2`), /v3/);
    assert.equal(f.store.db.prepare('SELECT 1 FROM memory_contents WHERE memoryId=?').get(saved.id), undefined);
    assert.equal(f.memory.upsertAutomatic({ ...input, observedAt: 200 }, actor), undefined, 'deletion must prevent automatic resurrection');
    assert.deepEqual(f.memory.history(saved.id, actor).map(row => row.action), ['deleted', 'disabled', 'saved']);
  }
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('automatic memory removal rejects other owners, groups, revoked projects and inaccessible chat scopes', t => {
  const f = fixture(t), actor = authority({ ownerId: 'owner', chatKey: 'app:chat' });
  const saved = f.memory.upsertAutomatic(candidate({ level: 'local' }), actor)!;
  const command = message(`/forget ${saved.id} 1`);
  for (const [incoming, project, allowed] of [
    [{ ...command, senderId: 'bob' }, 'atlas', ['atlas']],
    [{ ...command, envelope: { ...command.envelope!, chatType: 'group' as const } }, 'atlas', ['atlas']],
    [command, 'other', ['atlas', 'other']],
    [command, 'atlas', []],
  ] as const) {
    assert.match(memoryCommand(f.store, incoming, ['owner', 'bob'], project, x => x, allowed)!, /未完成|只接受/);
    assert.equal(f.store.db.prepare('SELECT status FROM memories WHERE id=?').get(saved.id)?.status, 'active');
  }
  const global = f.memory.upsertAutomatic(candidate({ key: 'project.global', text: 'Atlas overview.', evidence: ['Atlas overview.'] }), actor)!;
  assert.match(memoryCommand(f.store, message(`/forget ${global.id} 1`), ['owner'], 'atlas', x => x, [])!, /未完成/);
  const chat = f.memory.upsertAutomatic(candidate({ key: 'project.chat', privacy: 'chat', text: 'Chat-specific fact.', evidence: ['Chat-specific fact.'] }), actor)!;
  assert.match(memoryCommand(f.store, { ...message(`/forget ${chat.id} 1`), chatKey: 'another-chat' }, ['owner'], 'atlas', x => x, ['atlas'])!, /未完成/);
});

test('explicit private memory commands preserve ownership, version conflicts and deletion',t=>{
 const root=mkdtempSync(join(tmpdir(),'namo-memory-command-')),store=new Store(join(root,'db'));t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const run=(text:string)=>memoryCommand(store,message(text),['owner'],'project',x=>x)!;
 assert.match(run('/remember owner concise answers'),/已保存/);const list=run('/memories');assert.match(list,/concise answers/);const id=list.match(/`(M-[A-F0-9]{16})`/)?.[1];assert.ok(id);
 assert.match(run(`/memory-correct ${id} 1 precise answers`),/v2/);assert.match(run(`/forget ${id} 1`),/未完成/);assert.match(run(`/forget ${id} 2`),/v3/);assert.doesNotMatch(run('/memories'),/precise answers/);
 const group=message('/remember owner injected');group.envelope!.chatType='group';assert.match(memoryCommand(store,group,['owner'],'project',x=>x)!,/只接受/);
 const quote=message('/remember owner injected');quote.envelope!.parentId='quoted';assert.match(memoryCommand(store,quote,['owner'],'project',x=>x)!,/引用/);
});
test('pending controls are isolated by owner and topic without changing chat scheduling',t=>{
 const root=mkdtempSync(join(tmpdir(),'namo-scope-')),store=new Store(join(root,'db'));t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});const m=message('work');store.enqueue(m);store.claim(m.key);
 assert.equal(store.hasPending(m.chatKey,'other','owner',m.chatKey),true);assert.equal(store.hasPending(m.chatKey,'other','bob',m.chatKey),false);assert.equal(store.hasPending(m.chatKey,'other','owner',m.chatKey+':thread:other'),false);assert.equal(store.hasPending(m.chatKey,'other'),true);
});

test('memory metadata, body version and audit commit together; invalid references cannot be persisted', t => {
  const f = fixture(t), saved = f.memory.save({kind:'preference',scope:ownerScope(),text:'Original'},local());
  assert.throws(()=>f.store.db.prepare('UPDATE memory_contents SET version=99 WHERE memoryId=?').run(saved.id),/FOREIGN KEY/);
  assert.throws(()=>f.memory.snapshot('missing-run',access()),/FOREIGN KEY/);
  f.store.db.exec("CREATE TEMP TRIGGER fail_memory_audit BEFORE INSERT ON memory_changes BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
  assert.throws(()=>f.memory.correct(saved.id,1,{text:'Uncommitted'},local()),/audit unavailable/);
  const visible=f.memory.search(access());
  assert.equal(visible[0]?.version,1); assert.equal(visible[0]?.text,'Original');
  assert.equal(f.memory.history(saved.id,access()).length,1);
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
