import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Incoming } from '../src/store.js';
import { parseConfig } from '../src/config.js';
import { Memories } from '../src/memory.js';
import { memoryProjects } from '../src/memory-access.js';
import { memoryCommand } from '../src/memory-commands.js';
import { buildTaskRunPrompt } from '../src/task-context.js';
import { Tasks } from '../src/tasks.js';

test('organization memory ACL reaches prompts and commands, distinguishes group grants and revocation', t => {
  const dir = mkdtempSync(join(tmpdir(), 'namo-memory-acl-')), store = new Store(join(dir, 'db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = parseConfig({ feishu: { appId: 'app', access: { mode: 'organization', tenantKey: 'tenant' } },
    codex: { projects: { atlas: dir }, defaultProject: 'atlas', projectAccess: {
      atlas: { organization: false, userIds: ['alice'], chatIds: ['authorized-team'], permission: 'read-only' } } } }, join(dir, 'config.json'));
  const memory = new Memories(store);
  const saved = memory.upsertAutomatic({ key: 'atlas.overview', kind: 'project_knowledge', level: 'global', privacy: 'shared',
    project: 'atlas', text: 'ATLAS_RESOURCE_ONLY', evidence: ['Atlas overview'], sourceMessageIds: ['source'], observedAt: 1 },
    { kind: 'local-owner', authenticated: true, ownerId: 'alice', project: 'atlas', chatKey: 'alice', chatType: 'p2p', source: { kind: 'automatic', ref: 'seed' } })!;
  const input = (id: string, user: string, chat = user, group = false): Incoming => ({ key: id, messageId: id, chatId: chat,
    chatKey: 'app:' + chat, senderId: user, text: 'atlas overview', envelope: { version: 1, type: 'text', kind: 'instruction',
      scopeKey: 'app:' + chat, chatType: group ? 'group' : 'p2p', tenantKey: 'tenant', materials: [], limitations: [] } });
  for (const [m, permitted] of [[input('bob', 'bob'), false], [input('alice', 'alice'), true],
    [input('private-grant-in-group', 'alice', 'other-team', true), false], [input('group-grant', 'bob', 'authorized-team', true), true]] as const) {
    store.enqueue(m); const tasks = new Tasks(store), task = tasks.create(store.get(m.key)!, { cwd: dir, policyHash: 'fixture' });
    const prompt = buildTaskRunPrompt(store, task, store.get(m.key)!, config, tasks.start(task));
    assert.equal(prompt.includes('ATLAS_RESOURCE_ONLY'), permitted);
  }
  const m = input('command', 'bob'); m.text = '/memories';
  assert.doesNotMatch(memoryCommand(store, m, ['bob'], null, s => s, memoryProjects(config, m))!, /ATLAS_RESOURCE_ONLY/);
  config.codex.projectAccess!.atlas.userIds = [];
  const who = input('revoked', 'alice');
  assert.deepEqual(memory.search({ kind: 'verified-user', authenticated: true, ownerId: 'alice', chatType: 'p2p', chatKey: who.chatKey,
    allowedProjects: memoryProjects(config, who) }).map(r => r.id), []);
  assert.equal(memory.manage({ kind: 'local-owner', authenticated: true, ownerId: 'alice' })[0]?.id, saved.id);
});
