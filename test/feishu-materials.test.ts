import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeishuTransport } from '../src/feishu.js';
import { expandMaterial } from '../src/materials.js';

test('official SDK flat merge-forward shape maps upper_message_id into the preserved hierarchy without network access', async () => {
  const calls: unknown[] = [];
  const transport = new FeishuTransport({ appId: 'app', appSecret: 'not-used', allowedUserIds: ['alice'], allowedChatIds: ['chat'],
    requireMention: true, domain: 'feishu' }, () => {});
  const fakeClient = { im: { message: { async get(request: unknown) {
    calls.push(request);
    return { code: 0, data: { items: [
      { message_id: 'outer', chat_id: 'chat', msg_type: 'merge_forward', body: { content: '{}' }, sender: { id: 'alice' } },
      { message_id: 'child', upper_message_id: 'outer', parent_id: 'ignored-sdk-parent', chat_id: 'chat', msg_type: 'text',
        body: { content: JSON.stringify({ text: 'child text' }) }, sender: { id: 'bob' }, create_time: '100' },
      { message_id: 'nested', upper_message_id: 'outer', chat_id: 'chat', msg_type: 'merge_forward', body: { content: '{}' }, sender: { id: 'carol' } },
      { message_id: 'grandchild', upper_message_id: 'nested', chat_id: 'chat', msg_type: 'text',
        body: { content: JSON.stringify({ text: 'grandchild text' }) }, sender: { id: 'dave' }, create_time: '101' },
    ] } };
  } } } };
  (transport as unknown as { client: unknown }).client = fakeClient;

  const result = await expandMaterial({ appId: 'app', chatId: 'chat', ownerId: 'alice', messageId: 'outer' },
    { type: 'merge_forward' }, transport.materials);

  assert.deepEqual(calls, [{ path: { message_id: 'outer' } }]);
  assert.equal(result.state, 'parsed');
  assert.deepEqual(result.nodes.map(node => ({ id: node.id, parentId: node.parentId, depth: node.depth, author: node.author?.id, text: node.text })), [
    { id: 'outer', parentId: undefined, depth: 0, author: 'alice', text: undefined },
    { id: 'child', parentId: 'outer', depth: 1, author: 'bob', text: 'child text' },
    { id: 'nested', parentId: 'outer', depth: 1, author: 'carol', text: undefined },
    { id: 'grandchild', parentId: 'nested', depth: 2, author: 'dave', text: 'grandchild text' },
  ]);
});
