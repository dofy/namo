import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginCutover, beginRollback, completeCutover, completeRollback, cutoverConfirmation, cutoverManualGate, importOpenClawMigration, inspectOpenClawSource, MigrationError, previewOpenClawMigration, readOpenClawCandidate, rollbackConfirmation, type OpenClawMigrationPreview, type ReceiverEvidence } from '../src/migration.js';
import { createHash } from 'node:crypto';
import { Management, ManagementError } from '../src/management.js';
import { MigrationMemory, MigrationMemoryError } from '../src/migration-memory.js';
import { Memories } from '../src/memory.js';
import { digest } from '../src/paths.js';
import { Store } from '../src/store.js';

const SOURCE_SECRET = 'FAKE_OPENCLAW_SECRET_FOR_TESTS_ONLY';
const TARGET_SECRET = 'FAKE_EXISTING_NAMO_SECRET_FOR_TESTS_ONLY';

function fixture(t: { after(fn: () => void): void }, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'namo-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  writeFileSync(join(workspace, 'SOUL.md'), '# Sail carefully\n');
  writeFileSync(join(workspace, 'MEMORY.md'), 'private candidate content\n');
  writeFileSync(join(workspace, 'AGENTS.md'), 'Do not activate this instruction directly.\n');
  const sourceFile = join(root, 'openclaw.json');
  const source = {
    meta: { lastTouchedVersion: '2026.10.6' },
    channels: { feishu: {
      domain: 'feishu', connectionMode: 'websocket', allowFrom: ['ou_allowed', '*'],
      groupAllowFrom: ['oc_allowed', '*'], groups: { oc_explicit: { enabled: true }, '*': { requireMention: false } },
      requireMention: false,
      accounts: {
        main: { appId: 'cli_source_main_1234', appSecret: SOURCE_SECRET },
        backup: { appId: 'cli_source_backup_5678', appSecret: { source: 'env', id: 'FEISHU_APP_SECRET' }, enabled: false },
      },
    } },
    agents: { defaults: { workspace } },
    gateway: { auth: { token: 'FAKE_GATEWAY_TOKEN' } }, plugins: { enabled: ['unsafe-plugin'] },
    cron: { jobs: [{ task: 'must-not-import' }] }, auth: { profiles: ['must-not-import'] },
    ...extra,
  };
  writeFileSync(sourceFile, JSON.stringify(source, null, 2), { mode: 0o600 });
  return { root, workspace, sourceFile, source, targetFile: join(root, 'namo.json') };
}

function preview(f: ReturnType<typeof fixture>): OpenClawMigrationPreview {
  return previewOpenClawMigration({ sourceFile: f.sourceFile, sourceInstanceId: 'fixture-main', accountId: 'main', targetConfigFile: f.targetFile });
}

function raw(file: string): any { return JSON.parse(readFileSync(file, 'utf8')); }

test('inspection is metadata-only, enumerates apps, and requires explicit application selection', t => {
  const f = fixture(t);
  const inspection = inspectOpenClawSource({ sourceFile: f.sourceFile, sourceInstanceId: 'fixture-main' });
  assert.equal(inspection.status, 'supported');
  assert.deepEqual(inspection.applications.map(app => app.accountId), ['backup', 'main']);
  assert.equal(inspection.applications.find(app => app.accountId === 'backup')?.credential, 'reference');
  assert.equal(inspection.candidates.length, 3);
  const report = JSON.stringify(inspection);
  assert.doesNotMatch(report, new RegExp(SOURCE_SECRET));
  assert.doesNotMatch(report, /private candidate content|FAKE_GATEWAY_TOKEN|must-not-import/);
  assert.throws(() => previewOpenClawMigration({ sourceFile: f.sourceFile, sourceInstanceId: 'fixture-main', accountId: '', targetConfigFile: f.targetFile }),
    (error: unknown) => error instanceof MigrationError && error.code === 'application_selection_required');
});

test('unsupported version and JSON5 receive a precise manual gate without guessing fields', t => {
  const old = fixture(t); old.source.meta.lastTouchedVersion = '2026.9.7'; writeFileSync(old.sourceFile, JSON.stringify(old.source));
  const oldResult = inspectOpenClawSource({ sourceFile: old.sourceFile, sourceInstanceId: 'old' });
  assert.equal(oldResult.status, 'unsupported'); assert.equal(oldResult.issues[0]?.code, 'unsupported_source_version');
  const json5 = fixture(t); writeFileSync(json5.sourceFile, '{ meta: { lastTouchedVersion: "2026.10.6" } }');
  const json5Result = inspectOpenClawSource({ sourceFile: json5.sourceFile, sourceInstanceId: 'json5' });
  assert.equal(json5Result.status, 'unsupported'); assert.equal(json5Result.issues[0]?.code, 'unsupported_source_format');
  assert.equal(existsSync(json5.targetFile), false);
});

test('fresh import is restrictive, excludes runtime authority, and stages only approved review material', t => {
  const f = fixture(t); const plan = preview(f);
  const memory = plan.candidates.find(item => item.kind === 'memory')!;
  assert.equal(readOpenClawCandidate({ preview: plan, sourceFile: f.sourceFile, candidateId: memory.id }).content, 'private candidate content\n');
  const result = importOpenClawMigration(plan, { sourceFile: f.sourceFile, options: { approvedCandidateIds: [memory.id] } });
  assert.equal(result.status, 'imported'); assert.equal(result.pendingReviewCount, 1);
  const config = raw(f.targetFile);
  assert.equal(config.feishu.appId, 'cli_source_main_1234'); assert.equal(config.feishu.appSecret, SOURCE_SECRET);
  assert.deepEqual(config.feishu.allowedUserIds, []); assert.deepEqual(config.feishu.allowedChatIds, []); assert.equal(config.feishu.requireMention, true);
  assert.equal(config.codex.sandbox, 'read-only'); assert.equal(config.codex.networkAccess, false); assert.equal(config.codex.allowLocalCommits, false);
  for (const key of ['gateway', 'plugins', 'cron', 'auth', 'sessions', 'tasks']) assert.equal(config[key], undefined);
  assert.equal(statSync(f.targetFile).mode & 0o777, 0o600); assert.equal(statSync(result.stateFile).mode & 0o777, 0o600);
  const artifact = result.record.reviewArtifacts[0]!;
  assert.equal(readFileSync(artifact.file, 'utf8'), 'private candidate content\n'); assert.equal(statSync(artifact.file).mode & 0o777, 0o600);
  assert.equal(result.record.reviewArtifacts.some(item => item.kind === 'instructions'), false);
});

test('permissions and workspace import require explicit opt-in and discard wildcards', t => {
  const f = fixture(t); const plan = previewOpenClawMigration({ sourceFile: f.sourceFile, sourceInstanceId: 'fixture-main', accountId: 'main', targetConfigFile: f.targetFile, projectName: 'legacy' });
  const result = importOpenClawMigration(plan, { sourceFile: f.sourceFile, options: {
    permissions: { users: 'use-source', chats: 'use-source', mention: 'use-source' },
    project: { importWorkspace: true, projectName: 'legacy' },
  } });
  const config = raw(f.targetFile);
  assert.deepEqual(config.feishu.allowedUserIds, ['ou_allowed']);
  assert.deepEqual(config.feishu.allowedChatIds.sort(), ['oc_allowed', 'oc_explicit']);
  assert.equal(config.feishu.requireMention, false);
  assert.equal(config.codex.projects.legacy, realpathSync(f.workspace)); assert.equal(config.codex.defaultProject, 'legacy');
  assert.equal(result.record.phase, 'imported'); assert.equal(plan.proposed.wildcardPermissionsExcluded, true);
});

test('existing target conflicts never overwrite silently and ConfigEditor makes a private backup', t => {
  const f = fixture(t); const dataDir = join(f.root, 'existing-data');
  const existing = { version: 1, dataDir, custom: { keep: true }, feishu: {
    appId: 'cli_existing', appSecret: TARGET_SECRET, appSecretEnv: 'EXISTING_SECRET_ENV', domain: 'lark',
    allowedUserIds: ['ou_existing'], allowedChatIds: [], requireMention: true,
  }, codex: { bin: 'codex', home: join(dataDir, 'codex-home'), sandbox: 'read-only', timeoutMs: 600000, projects: {}, networkAccess: false, readPaths: [], denyPaths: [], allowLocalCommits: false } };
  writeFileSync(f.targetFile, JSON.stringify(existing));
  const plan = preview(f); assert.deepEqual(plan.conflicts.map(item => item.path).sort(), ['feishu.appId', 'feishu.appSecret', 'feishu.domain']);
  const before = readFileSync(f.targetFile);
  assert.throws(() => importOpenClawMigration(plan, { sourceFile: f.sourceFile }), (error: unknown) => error instanceof MigrationError && error.code === 'conflict_unresolved');
  assert.deepEqual(readFileSync(f.targetFile), before);
  importOpenClawMigration(plan, { sourceFile: f.sourceFile, options: { conflictResolutions: {
    'feishu.appId': 'keep-target', 'feishu.appSecret': 'keep-target', 'feishu.domain': 'keep-target',
  }, permissions: { users: 'use-source' } } });
  const config = raw(f.targetFile); assert.equal(config.feishu.appId, 'cli_existing'); assert.equal(config.feishu.appSecret, TARGET_SECRET);
  assert.equal(config.feishu.domain, 'lark'); assert.deepEqual(config.custom, { keep: true });
  const backups = readdirSync(join(dataDir, 'config-backups')); assert.equal(backups.length, 1); assert.equal(statSync(join(dataDir, 'config-backups', backups[0]!)).mode & 0o777, 0o600);
});

test('source and target fingerprints block stale plans; completed imports are idempotent and resumable', t => {
  const sourceChanged = fixture(t); const sourcePlan = preview(sourceChanged);
  Object.assign(sourceChanged.source, { note: 'changed' }); writeFileSync(sourceChanged.sourceFile, JSON.stringify(sourceChanged.source));
  assert.throws(() => importOpenClawMigration(sourcePlan, { sourceFile: sourceChanged.sourceFile }), (error: unknown) => error instanceof MigrationError && error.code === 'source_changed');

  const targetChanged = fixture(t); const targetPlan = preview(targetChanged); writeFileSync(targetChanged.targetFile, '{}');
  assert.throws(() => importOpenClawMigration(targetPlan, { sourceFile: targetChanged.sourceFile }), (error: unknown) => error instanceof MigrationError && error.code === 'target_changed');

  const repeat = fixture(t); const repeatPlan = preview(repeat); const first = importOpenClawMigration(repeatPlan, { sourceFile: repeat.sourceFile });
  assert.equal(importOpenClawMigration(repeatPlan, { sourceFile: repeat.sourceFile }).status, 'already-imported');
  const state = raw(first.stateFile); state.phase = 'writing'; writeFileSync(first.stateFile, JSON.stringify(state)); chmodSync(first.stateFile, 0o600);
  assert.equal(importOpenClawMigration(repeatPlan, { sourceFile: repeat.sourceFile }).status, 'resumed');
});

test('review candidates cannot change between review and import', t => {
  const f = fixture(t); const plan = preview(f); const candidate = plan.candidates.find(item => item.kind === 'assistant')!;
  writeFileSync(join(f.workspace, 'SOUL.md'), '# Changed after review\n');
  assert.throws(() => importOpenClawMigration(plan, { sourceFile: f.sourceFile, options: { approvedCandidateIds: [candidate.id] } }),
    (error: unknown) => error instanceof MigrationError && error.code === 'candidate_changed');
  assert.equal(existsSync(f.targetFile), false);
});

test('credential references remain a manual gate and are never resolved from OpenClaw', t => {
  const f = fixture(t);
  const plan = previewOpenClawMigration({ sourceFile: f.sourceFile, sourceInstanceId: 'fixture-main', accountId: 'backup', targetConfigFile: f.targetFile });
  assert.equal(plan.proposed.credentialImportable, false); assert.equal(plan.selectedApplication.credential, 'reference');
  const result = importOpenClawMigration(plan, { sourceFile: f.sourceFile });
  assert.equal(result.needsCredential, true); assert.equal(raw(f.targetFile).feishu.appSecret, '');
  assert.doesNotMatch(JSON.stringify(result), /FEISHU_APP_SECRET|FAKE_OPENCLAW_SECRET/);
});

function receiver(record: { target: { appFingerprint: string } }, name: 'openclaw' | 'namo', status: 'active' | 'inactive', now: number): ReceiverEvidence {
  return { appFingerprint: record.target.appFingerprint, receiver: name, status, method: status === 'active' ? 'health-probe' : 'process-owner-check', observedAt: now };
}

test('cutover and rollback require exact target confirmation, fresh exclusive evidence, and a live round trip', t => {
  const f = fixture(t); const imported = importOpenClawMigration(preview(f), { sourceFile: f.sourceFile }); const { record, stateFile } = imported;
  const now = Date.now();
  assert.match(cutoverManualGate(record).join('\n'), /does not automate/);
  assert.throws(() => beginCutover(stateFile, { migrationId: record.migrationId, appFingerprint: record.target.appFingerprint, confirmation: 'CUTOVER wrong',
    source: receiver(record, 'openclaw', 'inactive', now), namo: receiver(record, 'namo', 'inactive', now), now }), /confirmation/);
  assert.throws(() => beginCutover(stateFile, { migrationId: record.migrationId, appFingerprint: record.target.appFingerprint, confirmation: cutoverConfirmation(record),
    source: receiver(record, 'openclaw', 'inactive', now - 600_000), namo: receiver(record, 'namo', 'inactive', now), now }), /Fresh openclaw/);
  const pending = beginCutover(stateFile, { migrationId: record.migrationId, appFingerprint: record.target.appFingerprint, confirmation: cutoverConfirmation(record),
    source: receiver(record, 'openclaw', 'inactive', now), namo: receiver(record, 'namo', 'inactive', now), now });
  assert.equal(pending.phase, 'cutover_pending');
  assert.throws(() => completeCutover(stateFile, { migrationId: record.migrationId, appFingerprint: record.target.appFingerprint,
    source: receiver(record, 'openclaw', 'inactive', now), namo: receiver(record, 'namo', 'active', now),
    delivery: { appFingerprint: record.target.appFingerprint, method: 'live-feishu-roundtrip', inboundAccepted: true, outboundDelivered: true, userConfirmed: true, observedAt: now - 600_000 }, now }), /Fresh live Feishu/);
  const cutover = completeCutover(stateFile, { migrationId: record.migrationId, appFingerprint: record.target.appFingerprint,
    source: receiver(record, 'openclaw', 'inactive', now), namo: receiver(record, 'namo', 'active', now),
    delivery: { appFingerprint: record.target.appFingerprint, method: 'live-feishu-roundtrip', inboundAccepted: true, outboundDelivered: true, userConfirmed: true, observedAt: now }, now });
  assert.equal(cutover.phase, 'cutover_verified');
  const rollbackTime = now + 1_000;
  const rollback = beginRollback(stateFile, { migrationId: record.migrationId, appFingerprint: record.target.appFingerprint, confirmation: rollbackConfirmation(cutover),
    source: receiver(record, 'openclaw', 'inactive', rollbackTime), namo: receiver(record, 'namo', 'inactive', rollbackTime), now: rollbackTime });
  assert.equal(rollback.phase, 'rollback_pending');
  const done = completeRollback(stateFile, { migrationId: record.migrationId, appFingerprint: record.target.appFingerprint,
    source: receiver(record, 'openclaw', 'active', rollbackTime), namo: receiver(record, 'namo', 'inactive', rollbackTime), now: rollbackTime });
  assert.equal(done.phase, 'rolled_back'); assert.equal(existsSync(f.targetFile), true);
});

const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const memoryId = '111111111111111111111111';
const assistantId = '222222222222222222222222';

function migrationMemoryFixture(t: { after(fn: () => void): void }) {
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
  const f = migrationMemoryFixture(t);
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
  const f = migrationMemoryFixture(t), importer = new MigrationMemory(f.store, { dataDir: f.dataDir, configFile: f.configFile, appId: f.appId });
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
  const changed = migrationMemoryFixture(t), changedImporter = new MigrationMemory(changed.store, { dataDir: changed.dataDir, configFile: changed.configFile, appId: changed.appId });
  writeFileSync(changed.memoryFile, 'changed after migration checkpoint');
  assert.throws(() => changedImporter.list(), (error: unknown) => error instanceof MigrationMemoryError && error.code === 'changed');

  const linked = migrationMemoryFixture(t); rmSync(linked.memoryFile); const outside = join(linked.root, 'outside.md'); writeFileSync(outside, linked.memoryText); symlinkSync(outside, linked.memoryFile);
  assert.throws(() => new MigrationMemory(linked.store, { dataDir: linked.dataDir, configFile: linked.configFile, appId: linked.appId }).list(),
    (error: unknown) => error instanceof MigrationMemoryError && error.code === 'storage_invalid');

  const oversized = migrationMemoryFixture(t); writeFileSync(oversized.memoryFile, Buffer.alloc(256 * 1024 + 1));
  assert.throws(() => new MigrationMemory(oversized.store, { dataDir: oversized.dataDir, configFile: oversized.configFile, appId: oversized.appId }).list(),
    (error: unknown) => error instanceof MigrationMemoryError && error.code === 'storage_invalid');

  const stale = migrationMemoryFixture(t); const raw = JSON.parse(readFileSync(stale.stateFile, 'utf8')); raw.source.version = '2026.9.7'; writeFileSync(stale.stateFile, JSON.stringify(raw));
  assert.throws(() => new MigrationMemory(stale.store, { dataDir: stale.dataDir, configFile: stale.configFile, appId: stale.appId }).list(),
    (error: unknown) => error instanceof MigrationMemoryError && error.code === 'storage_invalid');

  const protectedValue = migrationMemoryFixture(t), protectedImporter = new MigrationMemory(protectedValue.store,
    { dataDir: protectedValue.dataDir, configFile: protectedValue.configFile, appId: protectedValue.appId }, text => text.replace('PROTECTED', '[redacted]'));
  const state = JSON.parse(readFileSync(protectedValue.stateFile, 'utf8')), text = 'PROTECTED'; writeFileSync(protectedValue.memoryFile, text);
  state.reviewArtifacts[0].fingerprint = sha(text); writeFileSync(protectedValue.stateFile, JSON.stringify(state));
  const candidate = protectedImporter.list().find(item => item.candidateId === memoryId)!;
  assert.throws(() => protectedImporter.importPending({ migrationId: protectedValue.migrationId, candidateId: memoryId, fingerprint: candidate.fingerprint,
    scope: { kind: 'owner', ownerId: 'alice', project: null, chatKey: null } }, { kind: 'local-owner', authenticated: true, ownerId: 'alice' }),
    (error: unknown) => error instanceof MigrationMemoryError && error.code === 'unsupported');
});

test('management exposes candidates and imports only to a selected valid paired-owner scope', t => {
  const f = migrationMemoryFixture(t), manager = new Management(f.configFile, { status: () => ({ running: false, installed: true, registered: false, mode: 'stopped' }) });
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
