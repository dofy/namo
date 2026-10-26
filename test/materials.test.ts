import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandMaterial, type MaterialReadAdapter, type MaterialAdapterMessage } from '../src/materials.js';

const source = { appId: 'app', chatId: 'chat', ownerId: 'alice', messageId: 'outer' };

function adapter(messages: readonly MaterialAdapterMessage[] = []) {
  const messageCalls: unknown[] = [], resourceCalls: unknown[] = [];
  const value: MaterialReadAdapter = {
    async readMessage(request) { messageCalls.push(request); return messages; },
    async readResource(request) {
      resourceCalls.push(request);
      return { bytes: Buffer.from('# Notes\nhello'), contentType: 'text/markdown; charset=utf-8', fileName: 'notes.md' };
    },
  };
  return { value, messageCalls, resourceCalls };
}

test('bounded merge-forward expansion preserves authors and hierarchy while treating content as untrusted', async () => {
  const fixture = adapter([
    { messageId: 'outer', chatId: 'chat', type: 'merge_forward', author: { id: 'alice', name: 'Alice' } },
    { messageId: 'one', parentMessageId: 'outer', chatId: 'chat', type: 'text', body: JSON.stringify({ text: 'first' }),
      author: { id: 'bob', name: 'Bob' }, sentAt: 100 },
    { messageId: 'nested', parentMessageId: 'outer', chatId: 'chat', type: 'merge_forward', author: { id: 'carol' } },
    { messageId: 'two', parentMessageId: 'nested', chatId: 'chat', type: 'post', body: JSON.stringify({
      zh_cn: { title: '标题', content: [[{ tag: 'text', text: '正文' }, { tag: 'at', user_name: 'Dave' }]] },
    }), author: { id: 'dave', name: 'Dave' } },
    { messageId: 'child-file', parentMessageId: 'outer', chatId: 'chat', type: 'file', body: '{}' },
  ]);
  const result = await expandMaterial(source, { type: 'merge_forward' }, fixture.value);
  assert.equal(result.state, 'parsed');
  assert.equal(result.nodes.length, 5);
  assert.deepEqual(result.nodes.find(node => node.id === 'one'), {
    id: 'one', parentId: 'outer', depth: 1, type: 'text', author: { id: 'bob', name: 'Bob' }, sentAt: 100,
    untrusted: true, state: 'parsed', stages: ['received', 'accessed', 'parsed'], text: 'first',
  });
  assert.equal(result.nodes.find(node => node.id === 'two')?.depth, 2);
  assert.match(result.nodes.find(node => node.id === 'two')?.text ?? '', /标题\n正文\[@Dave\]/);
  assert.equal(result.nodes.find(node => node.id === 'child-file')?.state, 'unsupported');
  assert.equal(result.nodes.find(node => node.id === 'child-file')?.error, 'forwarded_resource_not_accessible');
  assert.equal(fixture.messageCalls.length, 1);
  assert.deepEqual((fixture.messageCalls[0] as any).messageId, 'outer');
  assert.equal(fixture.resourceCalls.length, 0);
  assert.ok(result.limitations.every(line => !/授权.*已获得/.test(line)));
});

test('direct UTF-8 Markdown resource is read only through its original message and exposes explicit stages', async () => {
  const fixture = adapter();
  const result = await expandMaterial(source, { type: 'file', resourceKey: 'file-key', name: 'notes.md' }, fixture.value);
  assert.equal(result.state, 'parsed');
  assert.equal(result.nodes[0].text, '# Notes\nhello');
  assert.deepEqual(result.nodes[0].stages, ['received', 'accessed', 'parsed']);
  assert.deepEqual(fixture.resourceCalls[0], {
    messageId: 'outer', fileKey: 'file-key', kind: 'file', chatId: 'chat', maxBytes: 1_000_000,
    deadlineMs: (fixture.resourceCalls[0] as any).deadlineMs,
  });
});

test('unsupported types and unverified image handoff never access resources', async () => {
  const fixture = adapter();
  const image = await expandMaterial(source, { type: 'image', resourceKey: 'image-key' }, fixture.value);
  assert.equal(image.state, 'unsupported');
  assert.equal(image.nodes[0].error, 'image_runtime_handoff_not_verified');
  const pdf = await expandMaterial(source, { type: 'file', resourceKey: 'file-key', name: 'report.pdf' }, fixture.value);
  assert.equal(pdf.state, 'unsupported');
  assert.equal(pdf.nodes[0].error, 'unsupported_file_type');
  assert.equal(fixture.messageCalls.length, 0);
  assert.equal(fixture.resourceCalls.length, 0);
});

test('message, nesting, text, chat, UTF-8 and resource byte limits fail closed', async () => {
  const many = adapter([
    { messageId: 'outer', chatId: 'chat', type: 'merge_forward' },
    { messageId: 'a', parentMessageId: 'outer', chatId: 'chat', type: 'text', body: '{"text":"a"}' },
    { messageId: 'b', parentMessageId: 'outer', chatId: 'chat', type: 'text', body: '{"text":"b"}' },
  ]);
  const limited = await expandMaterial(source, { type: 'merge_forward' }, many.value, { maxMessages: 2 });
  assert.equal(limited.truncated, true); assert.equal(limited.state, 'failed');
  assert.equal(limited.nodes.at(-1)?.error, 'material_message_limit');

  const crossed = adapter([{ messageId: 'outer', chatId: 'other', type: 'merge_forward' }]);
  assert.equal((await expandMaterial(source, { type: 'merge_forward' }, crossed.value)).nodes[0].error, 'forward_chat_mismatch');

  const deep = adapter([
    { messageId: 'outer', chatId: 'chat', type: 'merge_forward' },
    { messageId: 'nested', parentMessageId: 'outer', chatId: 'chat', type: 'merge_forward' },
    { messageId: 'too-deep', parentMessageId: 'nested', chatId: 'chat', type: 'text', body: '{"text":"hidden"}' },
  ]);
  assert.equal((await expandMaterial(source, { type: 'merge_forward' }, deep.value, { maxDepth: 1 }))
    .nodes.find(node => node.id === 'too-deep')?.error, 'material_depth_limit');

  const badUtf8 = adapter();
  badUtf8.value.readResource = async () => ({ bytes: Uint8Array.from([0xc3, 0x28]), fileName: 'notes.md', contentType: 'text/markdown' });
  assert.equal((await expandMaterial(source, { type: 'file', resourceKey: 'key', name: 'notes.md' }, badUtf8.value)).nodes[0].error, 'invalid_utf8');

  const large = adapter();
  large.value.readResource = async () => ({ bytes: Buffer.alloc(10), fileName: 'notes.txt' });
  assert.equal((await expandMaterial(source, { type: 'file', resourceKey: 'key', name: 'notes.txt' }, large.value,
    { maxResourceBytes: 5 })).nodes[0].error, 'resource_size_limit');
});

test('adapter timeout is terminal and source metadata is validated before access', async () => {
  const fixture = adapter();
  fixture.value.readMessage = async () => await new Promise<never>(() => {});
  const timed = await expandMaterial(source, { type: 'merge_forward' }, fixture.value, { timeoutMs: 5 });
  assert.equal(timed.nodes[0].error, 'material_timeout');
  await assert.rejects(() => expandMaterial({ ...source, chatId: 'bad\nchat' }, { type: 'merge_forward' }, fixture.value), /invalid_material_source/);
});
