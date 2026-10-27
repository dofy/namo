import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Memories, MEMORY_CONTENT_PREFIX, MEMORY_META_PREFIX, type AutomaticMemoryInput, type MemoryAccess, type MemoryAuthority } from '../src/memory.js';

function fixture(t: TestContext, redact?: (text: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-auto-memory-storage-'));
  const file = join(dir, 'bot.sqlite'), store = new Store(file);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, file, memory: new Memories(store, redact) };
}
function authority(overrides: Partial<MemoryAuthority> = {}): MemoryAuthority {
  return { kind: 'local-owner', authenticated: true, ownerId: 'alice', chatKey: 'dm-alice', chatType: 'p2p', project: 'atlas',
    source: { kind: 'automatic', ref: 'auto-job-one' }, ...overrides };
}
function access(overrides: Partial<MemoryAccess> = {}): MemoryAccess {
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
  const who = access({ ownerId: 'bob', project: 'other', allowedProjects: [] });
  assert.deepEqual(ids(f.memory, who), []);
  assert.deepEqual(ids(f.memory, { ...who, allowedProjects: ['atlas'] }), [overview.id, mislabeled.id].sort());
  const handoff = f.memory.saveHandoff({ scope: { kind: 'chat', ownerId: 'bob', project: 'other', chatKey: 'dm-alice' },
    goal: 'Continue', limitations: [], decisions: [], evidence: [], unfinished: [], dependsOn: [{ id: overview.id, version: overview.version }] },
    authority({ ownerId: 'bob', project: 'other' }));
  assert.ok(!ids(f.memory, who).includes(handoff.id));
});

test('legacy global memories recover project provenance from the source audit after a local correction', t => {
  const f = fixture(t), saved = f.memory.upsertAutomatic(candidate({ project: null }), authority())!;
  f.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('auto-memory:job:auto-job-one', JSON.stringify({ project: 'atlas', state: 'completed' }));
  const meta = JSON.parse(String(f.store.db.prepare('SELECT value FROM settings WHERE key=?').get(MEMORY_META_PREFIX + saved.id)!.value));
  delete meta.resourceProjects;
  meta.source = { kind: 'local-owner', ref: 'legacy-correction' };
  f.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(meta), MEMORY_META_PREFIX + saved.id);
  const who = access({ ownerId: 'bob', allowedProjects: [] });
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
  assert.ok(ids(f.memory,access({ownerId:'bob',chatKey:'other-team',chatType:'group',project:'other'})).includes(handoff.id));
  for(const source of [privateFact,detail])assert.throws(()=>f.memory.saveHandoff({...input,dependsOn:[{id:source.id,version:source.version}]},actor),/visibility/);
  f.memory.correct(shared.id,shared.version,{text:'New shared fact.'},authority());
  assert.ok(!ids(f.memory,access({ownerId:'bob',chatKey:'other-team',chatType:'group',project:'other'})).includes(handoff.id));
});

test('global shared facts survive reopening and are readable by other paired conversation principals', t => {
  const f = fixture(t), saved = f.memory.upsertAutomatic(candidate(), authority())!;
  assert.deepEqual(ids(f.memory, access({ ownerId: 'bob', chatKey: 'dm-bob' })), [saved.id]);
  assert.deepEqual(ids(f.memory, access({ ownerId: 'bob', chatKey: 'team', chatType: 'group', project: 'other' })), [saved.id]);
  assert.throws(() => f.memory.search(access({ authenticated: false })), /not verified/);
  const reopened = new Store(f.file, true);
  try { assert.equal(new Memories(reopened).search(access({ ownerId: 'bob' }))[0]?.text, 'Alice maintains Atlas.'); }
  finally { reopened.close(); }
});

test('private and conversation facts are filtered before private content reaches redaction', t => {
  const visited: string[] = [], f = fixture(t, text => { visited.push(text); return text; });
  const privateFact = f.memory.upsertAutomatic(candidate({ key: 'alice.private', privacy: 'private', text: 'PRIVATE_ALICE_DETAIL' }), authority())!;
  const conversationFact = f.memory.upsertAutomatic(candidate({ key: 'team.detail', privacy: 'chat', text: 'TEAM_DETAIL' }),
    authority({ chatKey: 'team', chatType: 'group' }))!;
  visited.length = 0;
  assert.deepEqual(ids(f.memory, access({ ownerId: 'bob', chatKey: 'team', chatType: 'group' })), [conversationFact.id]);
  assert.ok(!visited.includes('PRIVATE_ALICE_DETAIL'));
  visited.length = 0;
  assert.deepEqual(ids(f.memory, access({ chatKey: 'other-team', chatType: 'group' })), []);
  assert.ok(!visited.includes('PRIVATE_ALICE_DETAIL') && !visited.includes('TEAM_DETAIL'));
  assert.deepEqual(ids(f.memory, access({ project: 'other' })), [privateFact.id]);
  assert.deepEqual(ids(f.memory, access({ ownerId: 'bob', chatKey: 'dm-bob' })), []);
});

test('project detail stays local while relevant global overviews support cross-project discussion', t => {
  const f = fixture(t);
  const detail = f.memory.upsertAutomatic(candidate({ key: 'atlas.table-layout', level: 'local', kind: 'project_knowledge', text: 'Atlas table uses fixed pagination.' }), authority())!;
  const overview = f.memory.upsertAutomatic(candidate({ key: 'atlas.overview', project: 'atlas', kind: 'project_knowledge', text: 'Atlas serves the internal admin tooling.' }), authority())!;
  assert.deepEqual(ids(f.memory, access({ ownerId: 'bob', chatType: 'group', chatKey: 'atlas-team' })), [detail.id, overview.id].sort());
  const elsewhere = access({ ownerId: 'bob', chatKey: 'other-team', chatType: 'group', project: 'other' });
  assert.deepEqual(f.memory.search(elsewhere, { relevantText: 'Investigate billing failures.' }).map(row => row.id), []);
  assert.deepEqual(f.memory.search(elsewhere, { relevantText: 'Compare Atlas with the other project.' }).map(row => row.id), [overview.id]);
  assert.throws(() => f.memory.upsertAutomatic(candidate({ level: 'local', project: 'other' }), authority()), /project does not match/);
});

test('automatic extraction is idempotent, corrects a concept in place, and cannot roll back newer observations', t => {
  const f = fixture(t), first = f.memory.upsertAutomatic(candidate(), authority())!;
  const same = f.memory.upsertAutomatic(candidate({ observedAt: 110, sourceMessageIds: ['message-repeat'] }), authority())!;
  assert.equal(same.id, first.id); assert.equal(same.version, 1);
  const updated = f.memory.upsertAutomatic(candidate({ text: 'Alice now maintains Boreal.', observedAt: 120,
    sourceMessageIds: ['message-correction'], evidence: ['I now maintain Boreal.'] }), authority({ source: { kind: 'automatic', ref: 'auto-job-two' } }))!;
  assert.equal(updated.id, first.id); assert.equal(updated.version, 2);
  assert.equal(f.memory.upsertAutomatic(candidate({ text: 'Stale role.', observedAt: 115 }), authority()), undefined);
  assert.equal(f.memory.search(access())[0]?.text, 'Alice now maintains Boreal.');
  assert.deepEqual(f.memory.history(first.id, access()).map(row => row.action), ['corrected', 'saved']);
});

test('a later repeated fact advances the observation watermark without creating a needless version', t => {
  const f = fixture(t), first = f.memory.upsertAutomatic(candidate({ observedAt: 100 }), authority())!;
  f.memory.upsertAutomatic(candidate({ observedAt: 200, sourceMessageIds: ['newer-confirmation'] }), authority());
  assert.equal(f.memory.upsertAutomatic(candidate({ observedAt: 150, text: 'Out-of-order obsolete role.' }), authority()), undefined);
  const current = f.memory.search(access())[0]!;
  assert.equal(current.id, first.id); assert.equal(current.version, 1); assert.equal(current.text, first.text);
  assert.equal(f.memory.history(first.id, access()).length, 1);
});

test('manual corrections, disabling, and deletion cannot be undone by automatic replay', t => {
  const f = fixture(t), local = authority({ source: { kind: 'local-owner', ref: 'workbench-correction' } });
  const edited = f.memory.upsertAutomatic(candidate({ key: 'manual-edit' }), authority())!;
  f.memory.correct(edited.id, 1, { text: 'Manually corrected fact.' }, local);
  assert.equal(f.memory.upsertAutomatic(candidate({ key: 'manual-edit', text: 'Model overwrite.', observedAt: 200 }), authority()), undefined);
  assert.equal(f.memory.search(access()).find(row => row.id === edited.id)?.text, 'Manually corrected fact.');
  const disabled = f.memory.upsertAutomatic(candidate({ key: 'disabled', text: 'Distinct disabled fact.', evidence: ['This is a distinct disabled fact.'] }), authority())!;
  f.memory.disable(disabled.id, 1, local);
  assert.equal(f.memory.upsertAutomatic(candidate({ key: 'disabled', observedAt: 200 }), authority()), undefined);
  const deleted = f.memory.upsertAutomatic(candidate({ key: 'deleted', text: 'Distinct deleted fact.', evidence: ['This is a distinct deleted fact.'] }), authority())!;
  f.memory.delete(deleted.id, 1, local);
  assert.equal(f.memory.upsertAutomatic(candidate({ key: 'deleted', text: 'Old transcript replay.', observedAt: 200 }), authority()), undefined);
  assert.equal(f.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(MEMORY_CONTENT_PREFIX + deleted.id), undefined);
  assert.equal(JSON.parse(String(f.store.db.prepare('SELECT value FROM settings WHERE key=?').get(MEMORY_META_PREFIX + deleted.id)?.value)).status, 'deleted');
  assert.ok(!ids(f.memory, access()).includes(disabled.id) && !ids(f.memory, access()).includes(deleted.id));
});

test('an automatic correction preserves privacy and automatic forgetting leaves a tombstone', t => {
  const f = fixture(t), secret = f.memory.upsertAutomatic(candidate({ key: 'private-role', privacy: 'private', text: 'Private role A.' }), authority())!;
  const corrected = f.memory.upsertAutomatic(candidate({ key: 'private-role', privacy: 'shared', text: 'Private role B.', observedAt: 200 }), authority())!;
  assert.equal(corrected.id, secret.id); assert.equal(corrected.visibility?.privacy, 'private');
  assert.deepEqual(ids(f.memory, access({ ownerId: 'bob' })), []);
  const scoped = f.memory.upsertAutomatic(candidate({ key: 'chat-only', privacy: 'chat' }), authority({ chatKey: 'team-one', chatType: 'group' }))!;
  const later = f.memory.upsertAutomatic(candidate({ key: 'chat-only', privacy: 'shared', text: 'Updated team context.', observedAt: 200 }),
    authority({ chatKey: 'team-two', chatType: 'group' }))!;
  assert.equal(later.id, scoped.id); assert.deepEqual(later.visibility, { privacy: 'private', chatKey: null });
  assert.ok(!ids(f.memory, access({ ownerId: 'bob', chatKey: 'team-one', chatType: 'group' })).includes(scoped.id));
  assert.equal(f.memory.upsertAutomatic(candidate({ key: 'private-role', operation: 'forget', text: 'Forget that role.', observedAt: 300 }), authority()), undefined);
  assert.equal(f.memory.upsertAutomatic(candidate({ key: 'private-role', text: 'Resurrected.', observedAt: 400 }), authority()), undefined);
  assert.ok(!ids(f.memory, access()).includes(secret.id));
});

test('private person concepts cannot widen or revive by moving from global into a local project scope', t => {
  const f = fixture(t), first = f.memory.upsertAutomatic(candidate({ key: 'person.contact', privacy: 'private', text: 'Alice has a private contact route.',
    evidence: ['My contact route is private.'] }), authority())!;
  const updated = f.memory.upsertAutomatic(candidate({ key: 'person.contact', level: 'local', project: 'atlas', privacy: 'shared',
    text: 'Alice updated her private contact route.', evidence: ['I updated my private contact route.'], observedAt: 200 }), authority())!;
  assert.equal(updated.id, first.id); assert.equal(updated.scope.kind, 'global'); assert.equal(updated.scope.project, null);
  assert.deepEqual(updated.visibility, { privacy: 'private', chatKey: null });
  assert.deepEqual(ids(f.memory, access({ ownerId: 'bob', chatKey: 'atlas-team', chatType: 'group' })), []);
  f.memory.delete(updated.id, updated.version, authority({ source: { kind: 'local-owner', ref: 'explicit-forget' } }));
  assert.equal(f.memory.upsertAutomatic(candidate({ key: 'person.contact', level: 'local', project: 'atlas', privacy: 'shared',
    text: 'Recreated contact data.', evidence: ['An alternative claim about contact data.'], observedAt: 300 }), authority()), undefined);
  assert.deepEqual(ids(f.memory, access()), []);
});

test('a private correction to a group-only fact is never disclosed back into the original group', t => {
  const f = fixture(t);
  const old = f.memory.upsertAutomatic(candidate({ key: 'person.arrangement', privacy: 'chat', text: 'An arrangement discussed in the team.',
    evidence: ['This arrangement is for our team.'] }), authority({ chatKey: 'original-team', chatType: 'group' }))!;
  const privateUpdate = f.memory.upsertAutomatic(candidate({ key: 'person.arrangement', privacy: 'private', text: 'A private correction from Alice.',
    evidence: ['The correction is private.'], observedAt: 200 }), authority())!;
  assert.equal(privateUpdate.id, old.id); assert.deepEqual(privateUpdate.visibility, { privacy: 'private', chatKey: null });
  assert.deepEqual(ids(f.memory, access({ ownerId: 'bob', chatKey: 'original-team', chatType: 'group' })), []);
  assert.equal(f.memory.search(access())[0]?.text, 'A private correction from Alice.');
  const other = f.memory.upsertAutomatic(candidate({ key: 'person.arrangement', privacy: 'chat', text: 'A later correction from a second team.',
    evidence: ['A correction for another team.'], observedAt: 300 }), authority({ chatKey: 'second-team', chatType: 'group' }))!;
  assert.deepEqual(other.visibility, { privacy: 'private', chatKey: null });
  assert.deepEqual(ids(f.memory, access({ ownerId: 'bob', chatKey: 'original-team', chatType: 'group' })), []);
  assert.deepEqual(ids(f.memory, access({ ownerId: 'bob', chatKey: 'second-team', chatType: 'group' })), []);
  assert.equal(f.memory.search(access())[0]?.text, 'A later correction from a second team.');
});

test('deletion fingerprints prevent resurrection under another key using the deleted text or its old evidence', t => {
  const f = fixture(t), original = f.memory.upsertAutomatic(candidate({ key: 'person.deleted-concept', text: 'A fact Alice explicitly removed.',
    evidence: ['This source originally established the removed fact.'] }), authority())!;
  f.memory.delete(original.id, original.version, authority({ source: { kind: 'local-owner', ref: 'forget-source' } }));
  assert.equal(f.memory.upsertAutomatic(candidate({ key: 'person.new-alias', text: 'A fact Alice explicitly removed.',
    evidence: ['A different extraction quote.'], observedAt: 200 }), authority()), undefined);
  assert.equal(f.memory.upsertAutomatic(candidate({ key: 'person.another-alias', text: 'Rephrased resurrection of the removed information.',
    evidence: ['This source originally established the removed fact.'], observedAt: 300 }), authority()), undefined);
  assert.deepEqual(ids(f.memory, access()), []);
});

test('automatic provenance stores bounded evidence hashes rather than original quoted content', t => {
  const f = fixture(t), quote = 'A source statement that belongs only in the original conversation.';
  const saved = f.memory.upsertAutomatic(candidate({ evidence: [quote], sourceMessageIds: ['source-one', 'source-one'] }), authority())!;
  const raw = String(f.store.db.prepare('SELECT value FROM settings WHERE key=?').get(MEMORY_META_PREFIX + saved.id)?.value);
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
  assert.deepEqual(ids(f.memory, access({ ownerId: 'bob' })), []);
  assert.deepEqual(ids(f.memory, access({ chatType: 'group', chatKey: 'team' })), []);
  assert.ok(ids(f.memory, access()).includes(handoff.id));
  f.memory.correct(source.id, source.version, { text: 'Changed legacy preference.' }, local);
  assert.ok(!ids(f.memory, access()).includes(handoff.id));
});
