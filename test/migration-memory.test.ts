import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Management, ManagementError } from '../src/management.js';
import { MigrationMemory, MigrationMemoryError } from '../src/migration-memory.js';
import { Memories } from '../src/memory.js';
import { digest } from '../src/paths.js';
import { Store } from '../src/store.js';

const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const memoryId = '111111111111111111111111';
const assistantId = '222222222222222222222222';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'namo-migration-memory-')), dataDir = join(root, 'data'), configFile = join(root, 'config.json');
  mkdirSync(dataDir); const appId = 'cli_migration_memory';
  const config = { version: 1, agent: 'codex', dataDir, concurrency: 1,
    feishu: { appId, appSecret: 'TEST_ONLY_PROTECTED_VALUE', allowedUserIds: ['alice'], allowedChatIds: [], requireMention: true, domain: 'feishu' },
    codex: { bin: 'codex', home: join(dataDir, 'codex-home'), sandbox: 'read-only', projects: {}, networkAccess: false, readPaths: [], denyPaths: [], allowLocalCommits: false, timeoutMs: 600000 } };
  writeFileSync(configFile, JSON.stringify(config));
  const migrationId = 'aaaaaaaaaaaaaaaaaaaaaaaa', directory = join(dataDir, 'migrations', 'openclaw', migrationId), review = join(directory, 'review');
  mkdirSync(review, { recursive: true });
  const memoryText = 'Prefer concise migration summaries.\n', assistantText = 'You are a pirate.\n';
  const memoryFile = join(review, `memory-${sha(memoryText).slice(0, 16)}-MEMORY.md`), assistantFile = join(review, `assistant-${sha(assistantText).slice(0, 16)}-SOUL.md`);
  writeFileSync(memoryFile, memoryText); writeFileSync(assistantFile, assistantText);
  const state = { schemaVersion: 1, migrationId, phase: 'imported',
    source: { instanceId: 'openclaw-main', fingerprint: sha('source'), version: '2026.10.6', accountId: 'main' },
    target: { configFile, beforeFingerprint: sha('before'), afterFingerprint: sha('after'), appFingerprint: digest(appId) },
    reviewArtifacts: [
      { candidateId: memoryId, kind: 'memory', fingerprint: sha(memoryText), file: memoryFile, status: 'pending-review' },
      { candidateId: assistantId, kind: 'assistant', fingerprint: sha(assistantText), file: assistantFile, status: 'pending-review' },
    ], excluded: [], updatedAt: new Date().toISOString() };
  const stateFile = join(directory, 'state.json'); writeFileSync(stateFile, JSON.stringify(state));
  const store = new Store(join(dataDir, 'bot.sqlite')); store.bindAccount(appId);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, dataDir, configFile, appId, migrationId, directory, review, memoryFile, assistantFile, memoryText, state, stateFile, store };
}

test('discovery returns only current-config records, verifies artifacts, and does not map identity instructions to memory', t => {
  const f = fixture(t);
  const foreign = join(f.dataDir, 'migrations', 'openclaw', 'bbbbbbbbbbbbbbbbbbbbbbbb'); mkdirSync(join(foreign, 'review'), { recursive: true });
  writeFileSync(join(foreign, 'state.json'), JSON.stringify({ ...f.state, migrationId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    target: { ...f.state.target, configFile: join(f.root, 'another.json') }, reviewArtifacts: [] }));
  const candidates = new MigrationMemory(f.store, { dataDir: f.dataDir, configFile: f.configFile, appId: f.appId }).list();
  assert.equal(candidates.length, 2);
  const memory = candidates.find(item => item.candidateId === memoryId)!;
  assert.equal(memory.eligible, true); assert.equal(memory.memoryKind, 'project_knowledge');
  assert.deepEqual(memory.source, { instanceId: 'openclaw-main', fingerprint: sha('source'), version: '2026.10.6', accountId: 'main' });
  assert.equal(memory.bytes, Buffer.byteLength(f.memoryText)); assert.equal(memory.imports.length, 0);
  const assistant = candidates.find(item => item.candidateId === assistantId)!;
  assert.equal(assistant.eligible, false); assert.equal(assistant.memoryKind, null); assert.match(assistant.reason ?? '', /not memory/i);
  assert.doesNotMatch(JSON.stringify(candidates), /Prefer concise|You are a pirate/);
});

test('import is pending review, explicitly activated, scope-idempotent, and a deletion cannot be resurrected', t => {
  const f = fixture(t), importer = new MigrationMemory(f.store, { dataDir: f.dataDir, configFile: f.configFile, appId: f.appId });
  const candidate = importer.list().find(item => item.candidateId === memoryId)!, ownerScope = { kind: 'owner' as const, ownerId: 'alice', project: null, chatKey: null };
  const authority = { kind: 'local-owner' as const, authenticated: true, ownerId: 'alice' };
  const created = importer.importPending({ migrationId: f.migrationId, candidateId: memoryId, fingerprint: candidate.fingerprint, scope: ownerScope }, authority);
  assert.equal(created.created, true); assert.equal(created.status, 'pending_review');
  const memories = new Memories(f.store), pending = memories.manage(authority).find(item => item.id === created.memoryId)!;
  assert.equal(pending.status, 'pending_review'); assert.equal(pending.usable, false); assert.equal(pending.source.kind, 'migration');
  const active = memories.activatePending(pending.id, pending.version, { ...authority, source: { kind: 'local-owner', ref: 'workbench:review' } });
  assert.equal(active.status, 'active');
  const duplicate = importer.importPending({ migrationId: f.migrationId, candidateId: memoryId, fingerprint: candidate.fingerprint, scope: ownerScope }, authority);
  assert.deepEqual(duplicate, { created: false, memoryId: active.id, status: 'active' });
  const deleted = memories.delete(active.id, active.version, { ...authority, source: { kind: 'local-owner', ref: 'workbench:delete' } });
  assert.equal(deleted.status, 'deleted');
  assert.deepEqual(importer.importPending({ migrationId: f.migrationId, candidateId: memoryId, fingerprint: candidate.fingerprint, scope: ownerScope }, authority),
    { created: false, memoryId: active.id, status: 'deleted' });
  assert.equal(memories.manage(authority).filter(item => item.id === active.id).length, 1);

  const projectScope = { kind: 'project' as const, ownerId: 'alice', project: 'project-one', chatKey: null };
  assert.equal(importer.importPending({ migrationId: f.migrationId, candidateId: memoryId, fingerprint: candidate.fingerprint, scope: projectScope }, authority).created, true);
  assert.throws(() => importer.importPending({ migrationId: f.migrationId, candidateId: memoryId, fingerprint: candidate.fingerprint,
    scope: { ...ownerScope, ownerId: 'bob' } }, authority), (error: unknown) => error instanceof MigrationMemoryError && error.code === 'forbidden');
});

test('changed, linked, oversized, stale-version, and protected artifacts fail closed', t => {
  const changed = fixture(t), changedImporter = new MigrationMemory(changed.store, { dataDir: changed.dataDir, configFile: changed.configFile, appId: changed.appId });
  writeFileSync(changed.memoryFile, 'changed after migration checkpoint');
  assert.throws(() => changedImporter.list(), (error: unknown) => error instanceof MigrationMemoryError && error.code === 'changed');

  const linked = fixture(t); rmSync(linked.memoryFile); const outside = join(linked.root, 'outside.md'); writeFileSync(outside, linked.memoryText); symlinkSync(outside, linked.memoryFile);
  assert.throws(() => new MigrationMemory(linked.store, { dataDir: linked.dataDir, configFile: linked.configFile, appId: linked.appId }).list(),
    (error: unknown) => error instanceof MigrationMemoryError && error.code === 'storage_invalid');

  const oversized = fixture(t); writeFileSync(oversized.memoryFile, Buffer.alloc(256 * 1024 + 1));
  assert.throws(() => new MigrationMemory(oversized.store, { dataDir: oversized.dataDir, configFile: oversized.configFile, appId: oversized.appId }).list(),
    (error: unknown) => error instanceof MigrationMemoryError && error.code === 'storage_invalid');

  const stale = fixture(t); const raw = JSON.parse(readFileSync(stale.stateFile, 'utf8')); raw.source.version = '2026.9.7'; writeFileSync(stale.stateFile, JSON.stringify(raw));
  assert.throws(() => new MigrationMemory(stale.store, { dataDir: stale.dataDir, configFile: stale.configFile, appId: stale.appId }).list(),
    (error: unknown) => error instanceof MigrationMemoryError && error.code === 'storage_invalid');

  const protectedValue = fixture(t), protectedImporter = new MigrationMemory(protectedValue.store,
    { dataDir: protectedValue.dataDir, configFile: protectedValue.configFile, appId: protectedValue.appId }, text => text.replace('PROTECTED', '[redacted]'));
  const state = JSON.parse(readFileSync(protectedValue.stateFile, 'utf8')), text = 'PROTECTED'; writeFileSync(protectedValue.memoryFile, text);
  state.reviewArtifacts[0].fingerprint = sha(text); writeFileSync(protectedValue.stateFile, JSON.stringify(state));
  const candidate = protectedImporter.list().find(item => item.candidateId === memoryId)!;
  assert.throws(() => protectedImporter.importPending({ migrationId: protectedValue.migrationId, candidateId: memoryId, fingerprint: candidate.fingerprint,
    scope: { kind: 'owner', ownerId: 'alice', project: null, chatKey: null } }, { kind: 'local-owner', authenticated: true, ownerId: 'alice' }),
    (error: unknown) => error instanceof MigrationMemoryError && error.code === 'unsupported');
});

test('management exposes candidates and imports only to a selected valid paired-owner scope', t => {
  const f = fixture(t), manager = new Management(f.configFile, { status: () => ({ running: false, installed: true, registered: false, mode: 'stopped' }) });
  const before = manager.memories('alice') as any, candidate = before.imports.find((item: any) => item.candidateId === memoryId);
  assert.equal(candidate.eligible, true);
  const input = { migrationId: f.migrationId, candidateId: memoryId, fingerprint: candidate.fingerprint,
    scope: { kind: 'owner', ownerId: 'alice', project: null, chatKey: null } };
  const imported = manager.memory('import', 'alice', input) as any;
  assert.equal(imported.items[0].status, 'pending_review');
  assert.equal(imported.imports.find((item:any)=>item.candidateId===memoryId).imports[0].memoryId, imported.items[0].id);
  assert.throws(() => manager.memory('import', 'alice', { ...input, scope: { ...input.scope, ownerId: 'mallory' } }),
    (error: unknown) => error instanceof ManagementError && error.status === 403);
  assert.throws(() => manager.memory('import', 'alice', { ...input, fingerprint: sha('changed-selection') }),
    (error: unknown) => error instanceof ManagementError && error.status === 409);
  const activated = manager.memory('activate', 'alice', { id: imported.items[0].id, version: imported.items[0].version }) as any;
  assert.equal(activated.items[0].status, 'active');
});
