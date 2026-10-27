import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { Store, type Incoming } from '../src/store.js';
import { Memories } from '../src/memory.js';
import { AUTO_MEMORY_JOB_PREFIX, type AutoMemoryInput } from '../src/auto-memory.js';
import type { Runtime } from '../src/runtime.js';
import type { Config } from '../src/config.js';

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('automatic_memory_engine_condition_timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function message(key: string, overrides: Partial<Incoming> = {}): Incoming {
  return { key, messageId: key, senderId: 'alice', chatKey: 'alice-dm', chatId: 'alice-dm', text: 'I prefer concise answers.',
    envelope: { version: 1, type: 'text', kind: 'instruction', chatType: 'p2p', scopeKey: 'alice-dm', materials: [], limitations: [] }, ...overrides };
}
function jobs(store: Store): { key: string; value: any }[] {
  return store.db.prepare('SELECT key,value FROM settings WHERE key LIKE ?').all(AUTO_MEMORY_JOB_PREFIX + '%')
    .map(row => ({ key: String(row.key), value: JSON.parse(String(row.value)) }));
}
function forceDue(store: Store) {
  for (const row of jobs(store)) if (row.value.state === 'pending') {
    row.value.dueAt = 0;
    store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(row.value), row.key);
  }
}
function fixture(t: TestContext, runtime: Runtime, concurrency = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-auto-memory-engine-')), file = join(dir, 'bot.sqlite');
  mkdirSync(join(dir, 'project'));
  const codex: Config['codex'] = { bin: 'fixture-codex', home: join(dir, 'home'), sandbox: 'read-only', timeoutMs: 1000,
    projects: { atlas: realpathSync(join(dir, 'project')) }, defaultProject: 'atlas' };
  const config = { dataDir: dir, concurrency, codex,
    feishu: { appId: 'fixture-app', appSecret: '', domain: 'feishu' as const, allowedUserIds: ['alice'], allowedChatIds: [], requireMention: true } };
  const store = new Store(file), sent: string[] = [], fatal: string[] = [];
  const engine = new Engine(store, runtime, { async send(_chat, text, uuid) { sent.push(text); return uuid; } }, config,
    text => text, () => {}, code => fatal.push(code));
  t.after(async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, store, engine, config, sent, fatal };
}

test('accepted conversation automatically queues extraction with verified owner, chat and project while preserving the task reply', async t => {
  let runCalls = 0, extracted: AutoMemoryInput | undefined;
  const f = fixture(t, {
    async run(request) { runCalls++; request.onThread('user-thread'); request.onTurn('user-turn'); return { text: 'Normal task answer.', threadId: 'user-thread', turnId: 'user-turn' }; },
    async extractMemory(input) {
      extracted = input;
      return { memories: [{ key: 'person.concise', kind: 'preference', level: 'global', privacy: 'shared', text: 'Alice prefers concise answers.',
        project: null, evidence: [{ messageId: input.messages[0]!.messageId, quote: 'I prefer concise answers.' }] }] };
    },
  });
  assert.equal(f.engine.accept(message('first')), true);
  assert.equal(f.engine.accept(message('first')), false);
  assert.equal(jobs(f.store).length, 1);
  f.engine.start();
  await waitFor(() => f.store.get('first')?.state === 'replied');
  assert.equal(runCalls, 1); assert.ok(f.sent.some(text => text.includes('Normal task answer.')));
  forceDue(f.store); await f.engine.pump();
  await waitFor(() => jobs(f.store).some(row => row.value.state === 'completed'));
  assert.equal(extracted?.ownerId, 'alice'); assert.equal(extracted?.chatKey, 'alice-dm');
  assert.equal(extracted?.chatType, 'p2p'); assert.equal(extracted?.project, 'atlas');
  assert.deepEqual(extracted?.messages, [{ messageId: 'first', text: 'I prefer concise answers.' }]);
  assert.equal(new Memories(f.store).search({ kind: 'verified-user', authenticated: true, ownerId: 'alice', chatKey: 'alice-dm', chatType: 'p2p', project: 'atlas' })[0]?.text,
    'Alice prefers concise answers.');
  assert.deepEqual(f.fatal, []);
});

test('extraction failure never changes a succeeded task or reruns its main model', async t => {
  let mainCalls = 0, extractionCalls = 0;
  const f = fixture(t, {
    async run(request) { mainCalls++; request.onThread('thread'); request.onTurn('turn'); return { text: 'User-visible answer.', threadId: 'thread', turnId: 'turn' }; },
    async extractMemory() { extractionCalls++; throw new Error('isolated extractor failure'); },
  });
  f.engine.accept(message('failure-isolated')); f.engine.start();
  await waitFor(() => f.store.get('failure-isolated')?.state === 'replied');
  forceDue(f.store); await f.engine.pump();
  await waitFor(() => jobs(f.store).some(row => row.value.state === 'pending' && row.value.attempts === 1));
  assert.equal(mainCalls, 1); assert.equal(extractionCalls, 1);
  assert.equal(f.store.get('failure-isolated')?.state, 'replied');
  assert.equal(f.store.db.prepare('SELECT state FROM tasks WHERE inboxKey=?').get('failure-isolated')?.state, 'succeeded');
  assert.ok(f.sent.some(text => text.includes('User-visible answer.'))); assert.deepEqual(f.fatal, []);
});

test('a new foreground task aborts background extraction before acquiring its sole concurrency slot', async t => {
  let live = 0, maxLive = 0, mainCalls = 0, extractionCalls = 0, aborted = 0;
  let extractionActive = false;
  const f = fixture(t, {
    async run(request) {
      mainCalls++; assert.equal(extractionActive, false, 'foreground execution overlapped the extractor');
      live++; maxLive = Math.max(maxLive, live);
      request.onThread('thread-' + mainCalls); request.onTurn('turn-' + mainCalls);
      await new Promise(resolve => setTimeout(resolve, 20)); live--;
      return { text: 'Foreground answer ' + mainCalls, threadId: 'thread-' + mainCalls, turnId: 'turn-' + mainCalls };
    },
    async extractMemory(_input, signal) {
      extractionCalls++;
      if (extractionCalls !== 1) return { memories: [] };
      extractionActive = true; live++; maxLive = Math.max(maxLive, live);
      try {
        await new Promise<never>((_resolve, reject) => {
          const cancel = () => { aborted++; reject(new Error('foreground preempted extraction')); };
          if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
        });
      } finally { extractionActive = false; live--; }
    },
  });
  f.engine.accept(message('first-task')); f.engine.start();
  await waitFor(() => f.store.get('first-task')?.state === 'replied');
  forceDue(f.store); await f.engine.pump(); await waitFor(() => extractionActive);
  f.engine.accept(message('second-task', { text: 'Investigate the next issue.' }));
  await waitFor(() => f.store.get('second-task')?.state === 'replied');
  assert.equal(aborted, 1); assert.equal(mainCalls, 2); assert.equal(maxLive, 1); assert.deepEqual(f.fatal, []);
});

test('a restarted receiver consumes persisted extraction work without repeating an already finished user task', async t => {
  let mainCalls = 0, extractionCalls = 0;
  const runtime: Runtime = {
    async run(request) { mainCalls++; request.onThread('saved-thread'); request.onTurn('saved-turn'); return { text: 'Persisted normal answer.', threadId: 'saved-thread', turnId: 'saved-turn' }; },
    async extractMemory() { extractionCalls++; return { memories: [] }; },
  };
  const f = fixture(t, runtime);
  f.engine.accept(message('persisted')); f.engine.start();
  await waitFor(() => f.store.get('persisted')?.state === 'replied');
  await f.engine.stop();
  assert.equal(mainCalls, 1); assert.equal(extractionCalls, 0);
  const reopened = new Store(f.file);
  const second = new Engine(reopened, runtime, { async send(_chat, _text, uuid) { return uuid; } }, f.config);
  try {
    forceDue(reopened); second.start();
    await waitFor(() => jobs(reopened).some(row => row.value.state === 'completed'));
    assert.equal(extractionCalls, 1); assert.equal(mainCalls, 1);
    assert.equal(reopened.get('persisted')?.state, 'replied');
  } finally { await second.stop(); reopened.close(); }
});

test('unpaired sources do not create automatic extraction jobs', async t => {
  const f = fixture(t, {
    async run() { throw new Error('test does not start foreground work'); },
    async extractMemory() { throw new Error('unpaired input must not reach extraction'); },
  });
  f.engine.accept(message('unknown-user', { senderId: 'unpaired' }));
  assert.equal(jobs(f.store).length, 0);
});

test('a queued task blocked by an active project does not repeatedly abort extraction in the other slot', async t => {
  let mainCalls = 0, extractionCalls = 0, extractionAborts = 0, extractionActive = false;
  let releaseFirst: (() => void) | undefined;
  const f = fixture(t, {
    async run(request) {
      const call = ++mainCalls; request.onThread('project-thread-' + call); request.onTurn('project-turn-' + call);
      if (call === 1) await new Promise<void>((resolve, reject) => {
        releaseFirst = resolve;
        request.signal.addEventListener('abort', () => reject(new Error('test-cleanup')), { once: true });
      });
      return { text: 'Project result ' + call, threadId: 'project-thread-' + call, turnId: 'project-turn-' + call };
    },
    async extractMemory(_input, signal) {
      extractionCalls++; extractionActive = true;
      try { await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => {
        extractionAborts++; reject(new Error('extract-aborted'));
      }, { once: true })); }
      finally { extractionActive = false; }
    },
  }, 2);
  const first = message('project-first', { chatKey: 'chat-a', chatId: 'chat-a',
    envelope: { version: 1, type: 'text', kind: 'instruction', chatType: 'p2p', scopeKey: 'chat-a', materials: [], limitations: [] } });
  const second = message('project-second', { chatKey: 'chat-b', chatId: 'chat-b',
    envelope: { version: 1, type: 'text', kind: 'instruction', chatType: 'p2p', scopeKey: 'chat-b', materials: [], limitations: [] } });
  f.engine.accept(first); f.engine.start(); await waitFor(() => mainCalls === 1);
  forceDue(f.store); await f.engine.pump(); await waitFor(() => extractionActive);
  f.engine.accept(second);
  for (let i = 0; i < 5; i++) { await f.engine.pump(); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(mainCalls, 1, 'same-project work must remain blocked despite its distinct chat');
  assert.equal(f.store.db.prepare('SELECT state FROM tasks WHERE inboxKey=?').get('project-second')?.state, 'queued');
  assert.equal(extractionCalls, 1); assert.equal(extractionAborts, 0); assert.equal(extractionActive, true);
  releaseFirst!(); await waitFor(() => mainCalls === 2);
  assert.equal(extractionAborts, 0, 'the released foreground slot is enough for the newly unblocked task');
  assert.deepEqual(f.fatal, []);
});

test('a ready foreground task uses a spare slot without preempting an active extraction', async t => {
  let mainCalls = 0, extractionActive = false, extractionAborts = 0, secondRanAlongsideExtraction = false;
  const f = fixture(t, {
    async run(request) {
      const call = ++mainCalls; request.onThread('spare-thread-' + call); request.onTurn('spare-turn-' + call);
      if (call === 2) secondRanAlongsideExtraction = extractionActive;
      return { text: 'Spare slot result ' + call, threadId: 'spare-thread-' + call, turnId: 'spare-turn-' + call };
    },
    async extractMemory(_input, signal) {
      extractionActive = true;
      try { await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => {
        extractionAborts++; reject(new Error('extract-aborted'));
      }, { once: true })); }
      finally { extractionActive = false; }
    },
  }, 2);
  f.engine.accept(message('spare-first')); f.engine.start();
  await waitFor(() => f.store.get('spare-first')?.state === 'replied');
  forceDue(f.store); await f.engine.pump(); await waitFor(() => extractionActive);
  f.engine.accept(message('spare-second'));
  await waitFor(() => mainCalls === 2);
  assert.equal(secondRanAlongsideExtraction, true); assert.equal(extractionAborts, 0); assert.equal(extractionActive, true);
  assert.deepEqual(f.fatal, []);
});
