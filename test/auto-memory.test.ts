import { memoryJobs } from '../src/business-storage.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Incoming } from '../src/store.js';
import { Memories } from '../src/memory.js';
import { AutoMemories, type AutoMemoryCandidate, type AutoMemoryInput, type AutoMemoryOptions } from '../src/auto-memory.js';
import { RuntimeError } from '../src/runtime-contract.js';

function fixture(t: any, extract: AutoMemoryOptions['extract'], redact = (text: string) => text) {
  const root = mkdtempSync(join(tmpdir(), 'namo-auto-memory-')), file = join(root, 'db.sqlite'), store = new Store(file);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const options = { allowedUsers: ['alice', 'bob'], redact, extract }, queue = new AutoMemories(store, options);
  const memory = new Memories(store, redact);
  const items = () => memory.manage({ kind: 'local-owner', authenticated: true, ownerId: 'alice' });
  return { store, file, options, queue, memory, items };
}
function message(id: string, text: string, extra: Partial<Incoming> = {}): Incoming {
  return { key: 'app:' + id, messageId: id, chatKey: 'app:alice', chatId: 'alice', senderId: 'alice', text,
    createdAt: Date.now() - 1000,
    envelope: { version: 1, type: 'text', kind: 'instruction', chatType: 'p2p', scopeKey: 'app:alice', materials: [], limitations: [] }, ...extra };
}
function candidate(messageId: string, quote: string, extra: Partial<AutoMemoryCandidate> = {}): AutoMemoryCandidate {
  return { key: 'person:alice:language', kind: 'preference', level: 'global', privacy: 'shared',
    text: 'Alice prefers Chinese answers.', evidence: [{ messageId, quote }], ...extra };
}
function jobs(store: Store): Record<string, any>[] {
  return memoryJobs(store.db).list();
}
function due(store: Store): void {
  for (const job of jobs(store)) {
    job.dueAt = 0;
    store.db.prepare('UPDATE memory_jobs SET dueAt=0 WHERE id=?').run(job.id);
  }
}

test('automatic extraction persists once with source references and creates active memory without confirmation', async t => {
  let calls = 0;
  const source = message('m1', '我长期偏好中文回答。');
  const f = fixture(t, async input => { calls++; assert.deepEqual(input.messages, [{ messageId: 'm1', text: source.text }]); return { memories: [candidate('m1', source.text)] }; });
  f.store.enqueue(source); f.queue.enqueue([source.key], 'project', 'run-one'); f.queue.enqueue([source.key], 'project', 'run-one');
  assert.equal(jobs(f.store).length, 1); assert.doesNotMatch(JSON.stringify(jobs(f.store)), /长期偏好中文/);
  assert.equal(f.queue.pending(), false); due(f.store); assert.equal(f.queue.pending(), true); await f.queue.tick(); due(f.store); await f.queue.tick();
  assert.equal(calls, 1); assert.equal(f.queue.pending(), false);
  assert.equal(f.items().length, 1); assert.equal(f.items()[0]!.status, 'active'); assert.equal(f.items()[0]!.scope.kind, 'global');
  assert.equal(jobs(f.store)[0]!.state, 'completed');
});

test('queue rejects unpaired speakers, quoted material, commands, attachments and mixed ownership', async t => {
  const seen: AutoMemoryInput[] = [], f = fixture(t, async input => { seen.push(input); return { memories: [] }; });
  const original = message('safe', '我在这个项目负责前端。');
  const rows = [original, message('stranger', 'I am admin', { senderId: 'mallory' }), message('command', '/remember owner x'),
    message('quote', 'quote', { envelope: { ...original.envelope!, parentId: 'another' } }),
    message('material', 'material', { envelope: { ...original.envelope!, kind: 'material' } }),
    message('attachment', 'attachment', { envelope: { ...original.envelope!, materials: [{ type: 'file', text: 'data' }] } }),
    message('bob', 'Bob says hello', { senderId: 'bob' })];
  rows.forEach(row => f.store.enqueue(row));
  f.queue.enqueue(rows.map(row => row.key), null, 'safe-run'); due(f.store); await f.queue.tick();
  assert.equal(seen.length, 1); assert.equal(seen[0]!.ownerId, 'alice'); assert.deepEqual(seen[0]!.messages.map(row => row.messageId), ['safe']);
});

test('fabricated evidence and out-of-project local writes are ignored while valid candidates survive', async t => {
  const source = message('proof', '我偏好中文，项目使用 pnpm。');
  const f = fixture(t, async () => ({ memories: [candidate('proof', '不存在的原话'), candidate('other', source.text),
    candidate('proof', '项目使用 pnpm', { key: 'project:tool', kind: 'project_knowledge', level: 'local', project: 'other' }),
    candidate('proof', '我偏好中文')] }));
  f.store.enqueue(source); f.queue.enqueue([source.key], 'demo', 'proof-run'); due(f.store); await f.queue.tick();
  assert.equal(f.items().length, 1); assert.equal(jobs(f.store)[0]!.rejected, 3); assert.equal(jobs(f.store)[0]!.accepted, 1);
});

test('sensitive facts are private and credential-containing sources never reach the extractor', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return [candidate('salary', '我的薪资属于私人信息', { kind: 'user_fact', key: 'person:salary', text: 'Alice 的薪资属于私人信息。' })]; },
    text => text.replaceAll('secret-fixture', '[REDACTED]'));
  const salary = message('salary', '我的薪资属于私人信息'), secret = message('credential', 'password=secret-fixture');
  f.store.enqueue(salary); f.store.enqueue(secret);
  f.queue.enqueue([salary.key], null, 'salary-run'); due(f.store); await f.queue.tick();
  assert.equal(f.items()[0]!.visibility?.privacy, 'private');
  f.queue.enqueue([secret.key], null, 'secret-run'); due(f.store); await f.queue.tick(); assert.equal(calls, 1);
});

test('temporary and uncertain suggestions do not become durable memory', async t => {
  const temporary = message('temporary', '这次请用英文回答'), uncertain = message('uncertain', '我可能更喜欢英文');
  const f = fixture(t, async () => [candidate('temporary', temporary.text), candidate('uncertain', uncertain.text)]);
  f.store.enqueue(temporary); f.store.enqueue(uncertain); f.queue.enqueue([temporary.key, uncertain.key], null, 'temporary-run');
  due(f.store); await f.queue.tick(); assert.equal(f.items().length, 0); assert.equal(jobs(f.store)[0]!.rejected, 2);
});

test('failed extraction survives reopen and retries without replaying the user task or source text', async t => {
  let calls = 0;
  const source = message('retry', '我长期偏好中文回答'), f = fixture(t, async () => {
    if (++calls === 1) throw Error('provider failed with private details');
    return [candidate('retry', source.text)];
  });
  f.store.enqueue(source); f.queue.enqueue([source.key], null, 'retry-run'); due(f.store); await f.queue.tick();
  assert.equal(jobs(f.store)[0]!.state, 'pending'); assert.equal(jobs(f.store)[0]!.attempts, 1);
  assert.doesNotMatch(JSON.stringify(jobs(f.store)), /private details|长期偏好中文/);
  const second = new Store(f.file);
  try { due(second); await new AutoMemories(second, f.options).tick(); } finally { second.close(); }
  assert.equal(calls, 2); assert.equal(f.items().length, 1); assert.equal(jobs(f.store)[0]!.state, 'completed');
  assert.equal(f.store.get(source.key)!.state, 'queued', 'extraction never claims or executes the user task');
});

test('lease excludes a concurrent worker, and retry budget terminates repeated extraction failures', async t => {
  let release: (value: unknown) => void = () => {}, calls = 0;
  const f = fixture(t, async () => { calls++; return new Promise(resolve => { release = resolve; }); });
  const source = message('lease', '长期偏好中文'); f.store.enqueue(source); f.queue.enqueue([source.key], null, 'lease-run');
  due(f.store); const running = f.queue.tick();
  await new AutoMemories(f.store, f.options).tick(); assert.equal(calls, 1);
  release({ memories: [] }); await running;
  const failing = new AutoMemories(f.store, { ...f.options, extract: async () => { throw Error('failed'); } });
  failing.enqueue([source.key], null, 'failed-run');
  for (let index = 0; index < 3; index++) { due(f.store); await failing.tick(); }
  assert.equal(jobs(f.store).find(job => job.sourceKey === 'failed-run')!.state, 'failed'); assert.equal(failing.pending(), false);
});

test('explicit correction updates one automatic memory and an explicitly deleted concept stays deleted', async t => {
  let selected: AutoMemoryCandidate;
  const f = fixture(t, async () => [selected]);
  const first = message('first', '我长期偏好中文回答', { createdAt: Date.now() - 3000 });
  selected = candidate('first', first.text);
  f.store.enqueue(first); f.queue.enqueue([first.key], null, 'first-run'); due(f.store); await f.queue.tick();
  const second = message('second', '以后改为英文回答', { createdAt: Date.now() - 2000 });
  selected = candidate('second', second.text, { text: 'Alice prefers English answers.' });
  f.store.enqueue(second); f.queue.enqueue([second.key], null, 'second-run'); due(f.store); await f.queue.tick();
  assert.equal(f.items().length, 1); assert.equal(f.items()[0]!.text, 'Alice prefers English answers.'); assert.equal(f.items()[0]!.version, 2);
  f.memory.delete(f.items()[0]!.id, 2, { kind: 'local-owner', authenticated: true, ownerId: 'alice', source: { kind: 'local-owner', ref: 'delete' } });
  f.queue.enqueue([second.key], null, 'late-reextraction'); due(f.store); await f.queue.tick();
  assert.equal(f.items().length, 1); assert.equal(f.items()[0]!.status, 'deleted'); assert.equal(f.items()[0]!.text, null);
});

test('receiver cancellation releases extraction for retry and last-attempt expired leases become terminal', async t => {
  let started: () => void = () => {};
  const ready = new Promise<void>(resolve => { started = resolve; });
  const f = fixture(t, async (_, signal) => { started(); return new Promise((_, reject) => {
    if (signal.aborted) reject(Error('aborted'));
    else signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  }); });
  const source = message('abort', '我长期偏好中文回答'); f.store.enqueue(source); f.queue.enqueue([source.key], null, 'abort-run');
  due(f.store); const controller = new AbortController(), running = f.queue.tick(controller.signal);
  await ready; controller.abort(); await running;
  assert.equal(jobs(f.store)[0]!.state, 'pending'); assert.equal(jobs(f.store)[0]!.attempts, 0);
  assert.equal(jobs(f.store)[0]!.error, undefined, 'foreground preemption is not an extraction failure');
  const stuck = jobs(f.store)[0]!;
  stuck.state = 'running'; stuck.attempts = 3; stuck.leaseUntil = 1; stuck.lease = 'dead-worker';
  memoryJobs(f.store.db).save(stuck as any);
  assert.equal(f.queue.pending(), true); due(f.store); await f.queue.tick();
  assert.equal(jobs(f.store)[0]!.state, 'failed'); assert.equal(f.queue.pending(), false);
});

test('extraction failures retain only safe categories and a successful retry clears the failure', async t => {
  for(const [error,expected] of [
    [new RuntimeError('memory_extraction_timeout'),'timeout'],
    [new RuntimeError('memory_extraction_disconnected'),'connection_failed'],
    [new RuntimeError('memory_extraction_tool_rejected'),'tool_rejected'],
    [new SyntaxError('PRIVATE_OUTPUT'),'invalid_output'],
    [new Error('PRIVATE_SDK_TOKEN'),'extraction_failed'],
  ] as const) {
    let fails=true;
    const f=fixture(t,async()=>{if(fails)throw error;return {memories:[]};});
    const source=message('status','A normal conversation.');f.store.enqueue(source);f.queue.enqueue([source.key],null,'status');
    due(f.store);await f.queue.tick();
    const retry=jobs(f.store)[0]!;
    assert.equal(retry.state,'pending');assert.equal(retry.attempts,1);assert.equal(retry.error,expected);assert.ok(retry.dueAt>Date.now());
    assert.doesNotMatch(JSON.stringify(retry),/PRIVATE_/);
    fails=false;due(f.store);await f.queue.tick();
    const done=jobs(f.store)[0]!;
    assert.equal(done.state,'completed');assert.equal(done.attempts,2);assert.equal(done.accepted,0);assert.equal(done.rejected,0);assert.equal(done.error,undefined);
  }
});

test('model-supplied ownership and missing source evidence cannot authorize a memory write', async t => {
  const source = message('spoof', '我长期偏好中文回答');
  const f = fixture(t, async () => ({ memories: [
    { ...candidate('spoof', source.text), ownerId: 'bob' },
    { ...candidate('spoof', source.text), evidence: [] },
    { ...candidate('spoof', source.text), evidence: [{ messageId: 'spoof', quote: source.text, ownerId: 'alice' }] },
  ] }));
  f.store.enqueue(source); f.queue.enqueue([source.key], null, 'spoof-run'); due(f.store); await f.queue.tick();
  assert.equal(f.items().length, 0); assert.equal(jobs(f.store)[0]!.rejected, 3);
});

test('short bursts debounce into one bounded extraction and merged run aliases stay idempotent', async t => {
  const seen: AutoMemoryInput[] = [], f = fixture(t, async input => { seen.push(input); return { memories: [] }; });
  const one = message('burst-one', '我负责前端'), two = message('burst-two', '项目使用 React');
  f.store.enqueue(one); f.store.enqueue(two);
  f.queue.enqueue([one.key], 'demo', 'burst-run-one'); f.queue.enqueue([two.key], 'demo', 'burst-run-two');
  assert.equal(jobs(f.store).length, 1); assert.equal(jobs(f.store)[0]!.inboxKeys.length, 2);
  assert.equal(f.queue.pending(), false); await f.queue.tick(); assert.equal(seen.length, 0);
  due(f.store); await f.queue.tick();
  assert.deepEqual(seen[0]!.messages.map(row => row.messageId), ['burst-one', 'burst-two']);
  f.queue.enqueue([two.key], 'demo', 'burst-run-two'); assert.equal(jobs(f.store).length, 1);
  for (let index = 0; index < 25; index++) {
    const row = message('bounded-' + index, '长期项目约定 ' + index); f.store.enqueue(row); f.queue.enqueue([row.key], 'demo', 'bounded-run-' + index);
  }
  assert.ok(jobs(f.store).every(job => job.inboxKeys.length <= 24));
  assert.equal(jobs(f.store).filter(job => job.state === 'pending').length, 2);
});

test('group topic roots are eligible while explicit quote parents remain excluded', async t => {
  const seen: AutoMemoryInput[] = [], f = fixture(t, async input => { seen.push(input); return []; });
  const root = message('group-root', '我负责这个项目的前端', { chatKey: 'app:group', chatId: 'group' });
  root.envelope = { ...root.envelope!, chatType: 'group', rootId: 'topic-root', threadId: 'topic-one' };
  const quote = message('group-quote', '别人的转述', { chatKey: 'app:group', chatId: 'group', envelope: { ...root.envelope, parentId: 'quoted-message' } });
  f.store.enqueue(root); f.store.enqueue(quote); f.queue.enqueue([root.key, quote.key], 'demo', 'group-run'); due(f.store); await f.queue.tick();
  assert.deepEqual(seen[0]!.messages.map(row => row.messageId), ['group-root']); assert.equal(seen[0]!.chatType, 'group');
});

test('credential assignments are excluded while contact facts become private and generic security topics remain eligible', async t => {
  const seen: AutoMemoryInput[] = [], f = fixture(t, async input => {
    seen.push(input); return input.messages.filter(row => row.messageId === 'email').map(row => candidate(row.messageId, row.text, {
      kind: 'user_fact', key: 'person:contact', text: '联系邮箱 alice@example.test',
    }));
  });
  const rows = [message('password', 'password = dummy-example-value'), message('token', 'api_key: dummy-example-value'),
    message('secret', '密钥是dummy-example-value'), message('safe-topic', '项目采用密码管理工具'),
    message('email', '我的邮箱是 alice@example.test')];
  rows.forEach(row => f.store.enqueue(row)); f.queue.enqueue(rows.map(row => row.key), null, 'credential-run'); due(f.store); await f.queue.tick();
  assert.deepEqual(seen[0]!.messages.map(row => row.messageId), ['safe-topic', 'email']);
  assert.equal(f.items()[0]!.visibility?.privacy, 'private');
  const clean = message('clean', '我负责项目维护'); f.store.enqueue(clean);
  const injected = new AutoMemories(f.store, { ...f.options, extract: async () => [candidate('clean', clean.text, { text: 'token=dummy-example-value' })] });
  injected.enqueue([clean.key], null, 'injected-secret-run'); due(f.store); await injected.tick();
  assert.equal(f.items().length, 1);
});

test('model evidence bounds match the durable memory API', async t => {
  const source = message('bounded-evidence', 'a'.repeat(1100));
  const f = fixture(t, async () => [candidate(source.messageId, source.text),
    candidate(source.messageId, 'a', { key: 'x'.repeat(161) }),
    candidate(source.messageId, 'a', { evidence: Array.from({ length: 9 }, () => ({ messageId: source.messageId, quote: 'a' })) }),
  ]);
  f.store.enqueue(source); f.queue.enqueue([source.key], null, 'bounded-evidence-run'); due(f.store); await f.queue.tick();
  assert.equal(f.items().length, 0); assert.equal(jobs(f.store)[0]!.rejected, 3);
});

test('memory capacity is reported when an automatic candidate cannot be saved',async t=>{
 const source=message('capacity','这是新的长期偏好');const f=fixture(t,async()=>[candidate('capacity',source.text,{key:'new:concept'})]);
 const authority={kind:'local-owner' as const,authenticated:true,ownerId:'alice',chatKey:'app:alice',chatType:'p2p' as const,project:null,source:{kind:'automatic' as const,ref:'seed'}};
 for(let i=0;i<40;i++)f.memory.upsertAutomatic({key:`seed:${i}`,kind:'user_fact',level:'global',privacy:'shared',text:`seed ${i}`,sourceMessageIds:['seed'],evidence:['evidence'],observedAt:Date.now()-3000},authority);
 f.store.enqueue(source);f.queue.enqueue([source.key],null,'capacity-run');due(f.store);await f.queue.tick();
 assert.equal(jobs(f.store)[0]!.error,'capacity');assert.equal(jobs(f.store)[0]!.accepted,0);assert.equal(f.items().length,40);
});

test('extraction receives only its owner records and deleted concept keys without old content or evidence', async t => {
  const seen: AutoMemoryInput[] = [], f = fixture(t, async input => { seen.push(input); return []; });
  const authority = (ownerId: string) => ({ kind: 'local-owner' as const, authenticated: true, ownerId,
    chatKey: 'app:' + ownerId, chatType: 'p2p' as const, project: null, source: { kind: 'automatic' as const, ref: 'seed-' + ownerId } });
  const seed = (key: string, text: string, ownerId = 'alice') => f.memory.upsertAutomatic({
    key, kind: 'user_fact', level: 'global', privacy: 'shared', text, sourceMessageIds: ['seed-message'],
    evidence: ['ORIGINAL-PRIVATE-EVIDENCE'], observedAt: Date.now() - 3000,
  }, authority(ownerId))!;
  const deleted = seed('concept:deleted', 'DELETED-OLD-BODY'), disabled = seed('concept:disabled', 'DISABLED-OLD-BODY');
  seed('concept:active', 'ALICE-ACTIVE-BODY'); seed('concept:bob', 'BOB-SHARED-BODY', 'bob');
  const local = { kind: 'local-owner' as const, authenticated: true, ownerId: 'alice', source: { kind: 'local-owner' as const, ref: 'management' } };
  f.memory.delete(deleted.id, deleted.version, local); f.memory.disable(disabled.id, disabled.version, local);
  const source = message('lookup', '我负责项目维护'); f.store.enqueue(source);
  f.queue.enqueue([source.key], null, 'lookup-run'); due(f.store); await f.queue.tick();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.existing.map(record => [record.ownerId, record.text]), [['alice', 'ALICE-ACTIVE-BODY']]);
  assert.deepEqual(new Set(seen[0]!.blocked?.map(record => record.key)), new Set(['concept:deleted', 'concept:disabled']));
  assert.ok(seen[0]!.blocked!.every(record => Object.keys(record).sort().join(',') === 'key,level,project'));
  assert.doesNotMatch(JSON.stringify(seen[0]), /DELETED-OLD-BODY|DISABLED-OLD-BODY|ORIGINAL-PRIVATE-EVIDENCE|BOB-SHARED-BODY/);
});

test('abort retains the queue scheduling slot and lease until extractor cleanup actually settles', async t => {
  let started: () => void = () => {}, beginCleanup: () => void = () => {}, calls = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const cleaning = new Promise<void>(resolve => { beginCleanup = resolve; });
  let cleaned = false, settled = false;
  const f = fixture(t, async (_, signal) => {
    calls++; started();
    return new Promise((_, reject) => signal.addEventListener('abort', () => {
      beginCleanup();
      setTimeout(() => { cleaned = true; reject(Error('cancelled after cleanup')); }, 30);
    }, { once: true }));
  });
  const source = message('cleanup', '我负责项目维护'); f.store.enqueue(source); f.queue.enqueue([source.key], null, 'cleanup-run'); due(f.store);
  const controller = new AbortController();
  const running = f.queue.tick(controller.signal).then(() => { settled = true; });
  await ready; controller.abort(); await cleaning;
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(settled, false); assert.equal(cleaned, false); assert.equal(jobs(f.store)[0]!.state, 'running');
  await f.queue.tick(); assert.equal(calls, 1);
  await running;
  assert.equal(cleaned, true); assert.equal(jobs(f.store)[0]!.state, 'pending');
});


test('organization authorization admits unpaired members and rechecks extraction before saving', async t => {
  let authorized = true, calls = 0;
  const source = message('org-memory', '我长期偏好中文回答。');
  const f = fixture(t, async () => []);
  const queue = new AutoMemories(f.store, { ...f.options, allowedUsers: [], authorize: () => authorized,
    extract: async () => { calls++; authorized = false; return [candidate(source.messageId, source.text)]; } });
  f.store.enqueue(source); queue.enqueue([source.key], null, 'org-extract');
  assert.equal(jobs(f.store).length, 1); due(f.store); await queue.tick();
  assert.equal(calls, 1); assert.equal(f.items().length, 0); assert.equal(jobs(f.store)[0]!.state, 'completed');
  queue.enqueue([source.key], null, 'revoked-extract'); assert.equal(jobs(f.store).length, 1);
});
