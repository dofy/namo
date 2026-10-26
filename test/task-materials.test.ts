import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import type { MaterialDescriptor, MaterialExpansion, MaterialNode, MaterialReadAdapter } from '../src/materials.js';
import { taskMaterials, type TaskMaterialLimits } from '../src/task-materials.js';

function fixture(t: { after(fn: () => void): void }, materials: MaterialDescriptor[]) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-task-materials-')), store = new Store(join(dir, 'db.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
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
