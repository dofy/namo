import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beginCutover, beginRollback, completeCutover, completeRollback, cutoverConfirmation,
  cutoverManualGate, importOpenClawMigration, inspectOpenClawSource, MigrationError,
  previewOpenClawMigration, readOpenClawCandidate, rollbackConfirmation,
  type OpenClawMigrationPreview, type ReceiverEvidence,
} from '../src/migration.js';

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
