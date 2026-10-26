import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync,
  statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ConfigEditor, atomicJson, digest, readJson } from './paths.js';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 256 * 1024;
export const VERIFIED_OPENCLAW_VERSION = '2026.10.6';
const EVIDENCE_MAX_AGE_MS = 5 * 60_000;
const REVIEW_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'AGENTS.md'] as const;

type JsonObject = Record<string, unknown>;
export type MigrationConflictResolution = 'keep-target' | 'use-source';
export type MigrationPhase = 'writing' | 'imported' | 'cutover_pending' | 'cutover_verified' | 'rollback_pending' | 'rolled_back';

export class MigrationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'MigrationError'; }
}

export interface MigrationIssue {
  code: string;
  severity: 'info' | 'warning' | 'manual' | 'unsupported';
  message: string;
  action?: string;
}

export interface OpenClawApplication {
  accountId: string;
  appFingerprint: string;
  appIdHint: string;
  enabled: boolean;
  domain: 'feishu' | 'lark' | 'unsupported';
  connectionMode: 'websocket' | 'webhook' | 'unsupported';
  credential: 'inline' | 'reference' | 'missing';
}

export interface OpenClawCandidate {
  id: string;
  kind: 'assistant' | 'identity' | 'user' | 'memory' | 'instructions';
  name: string;
  bytes: number;
  fingerprint: string;
  scope: 'default-workspace';
  status: 'review-required';
}

export interface OpenClawInspection {
  format: 'openclaw.json.standard-json';
  status: 'supported' | 'manual' | 'unsupported';
  sourceInstanceId: string;
  sourceFingerprint?: string;
  sourceVersion?: string;
  applications: OpenClawApplication[];
  candidates: OpenClawCandidate[];
  issues: MigrationIssue[];
  excluded: readonly ['auth', 'gateways', 'plugins', 'tasks', 'cron', 'sessions', 'chat-history', 'model-providers'];
}

export interface MigrationConflict {
  path: 'feishu.appId' | 'feishu.appSecret' | 'feishu.domain' | 'codex.projects';
  kind: 'different-value' | 'project-name-in-use';
  sensitive: boolean;
  message: string;
}

export interface OpenClawMigrationPreview extends OpenClawInspection {
  status: 'supported';
  accountId: string;
  selectedApplication: OpenClawApplication;
  targetConfigFile: string;
  targetFingerprint: string;
  conflicts: MigrationConflict[];
  proposed: {
    credentialImportable: boolean;
    allowedUserCount: number;
    allowedChatCount: number;
    wildcardPermissionsExcluded: boolean;
    sourceRequireMention: boolean;
    workspaceProjectAvailable: boolean;
    projectName: string;
  };
}

export interface ImportPermissions {
  users?: 'keep-target' | 'use-source';
  chats?: 'keep-target' | 'use-source';
  mention?: 'require' | 'use-source';
}

export interface ImportProject {
  importWorkspace: boolean;
  projectName?: string;
}

export interface ImportOptions {
  conflictResolutions?: Partial<Record<MigrationConflict['path'], MigrationConflictResolution>>;
  permissions?: ImportPermissions;
  project?: ImportProject;
  approvedCandidateIds?: string[];
}

export interface ReceiverEvidence {
  appFingerprint: string;
  receiver: 'openclaw' | 'namo';
  status: 'active' | 'inactive';
  method: 'process-owner-check' | 'health-probe';
  observedAt: number;
}

export interface DeliveryEvidence {
  appFingerprint: string;
  method: 'live-feishu-roundtrip';
  inboundAccepted: true;
  outboundDelivered: true;
  userConfirmed: true;
  observedAt: number;
}

export interface MigrationRecord {
  schemaVersion: 1;
  migrationId: string;
  phase: MigrationPhase;
  source: { instanceId: string; fingerprint: string; version: string; accountId: string };
  target: { configFile: string; beforeFingerprint: string; afterFingerprint: string; appFingerprint: string };
  reviewArtifacts: Array<{ candidateId: string; kind: OpenClawCandidate['kind']; fingerprint: string; file: string; status: 'pending-review' }>;
  excluded: OpenClawInspection['excluded'];
  updatedAt: string;
  cutover?: { startedAt: string; verifiedAt?: string };
  rollback?: { startedAt: string; completedAt?: string };
}

export interface ImportResult {
  status: 'imported' | 'already-imported' | 'resumed';
  stateFile: string;
  record: MigrationRecord;
  needsCredential: boolean;
  pendingReviewCount: number;
}

interface ParsedSource {
  fingerprint: string;
  version: string;
  applications: Array<OpenClawApplication & { appId: string; appSecret?: string; policy: JsonObject }>;
  candidates: Array<OpenClawCandidate & { file: string }>;
  issues: MigrationIssue[];
  workspace?: string;
}

const EXCLUDED = ['auth', 'gateways', 'plugins', 'tasks', 'cron', 'sessions', 'chat-history', 'model-providers'] as const;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim()))];
}

function hint(value: string): string {
  const tail = value.slice(-4);
  return tail ? `…${tail}` : 'configured';
}

function bufferDigest(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }

function expandPath(value: string, relativeTo: string): string {
  return value === '~' ? homedir() : value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : resolve(relativeTo, value);
}

function regularFile(file: string, maximum: number): Buffer {
  if (!existsSync(file)) throw new MigrationError('source_missing', 'OpenClaw source file does not exist. Select the exact source instance and file.');
  const info = lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new MigrationError('source_not_regular', 'OpenClaw source must be an explicitly selected regular file, not a link or directory.');
  if (info.size > maximum) throw new MigrationError('source_too_large', 'OpenClaw source exceeds the bounded migration input size.');
  return readFileSync(file);
}

function candidateKind(name: typeof REVIEW_FILES[number]): OpenClawCandidate['kind'] {
  if (name === 'SOUL.md') return 'assistant';
  if (name === 'IDENTITY.md') return 'identity';
  if (name === 'USER.md') return 'user';
  if (name === 'MEMORY.md') return 'memory';
  return 'instructions';
}

function inspectCandidates(workspaceValue: unknown, sourceFile: string): { workspace?: string; candidates: ParsedSource['candidates']; issues: MigrationIssue[] } {
  if (workspaceValue === undefined) return { candidates: [], issues: [] };
  if (typeof workspaceValue !== 'string' || !workspaceValue.trim()) return { candidates: [], issues: [{ code: 'workspace_invalid', severity: 'manual', message: 'The configured workspace is not a supported path.', action: 'Select review material manually.' }] };
  const expanded = expandPath(workspaceValue, dirname(sourceFile));
  try {
    if (lstatSync(expanded).isSymbolicLink()) throw new Error('linked-workspace');
    const workspace = realpathSync(expanded);
    const info = statSync(workspace);
    if (!info.isDirectory() || workspace === '/' || workspace === homedir()) throw new Error('broad');
    const candidates: ParsedSource['candidates'] = [];
    const issues: MigrationIssue[] = [];
    for (const name of REVIEW_FILES) {
      const file = join(workspace, name);
      if (!existsSync(file)) continue;
      const fileInfo = lstatSync(file);
      if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.size > MAX_CANDIDATE_BYTES) {
        issues.push({ code: 'candidate_skipped', severity: 'manual', message: `${name} was not read because it is a link, non-file, or exceeds 256 KiB.`, action: 'Review it manually.' });
        continue;
      }
      const bytes = readFileSync(file);
      const fingerprint = bufferDigest(bytes);
      candidates.push({ id: digest(`${name}\0${fingerprint}`).slice(0, 24), kind: candidateKind(name), name, bytes: bytes.length, fingerprint, scope: 'default-workspace', status: 'review-required', file });
    }
    return { workspace, candidates, issues };
  } catch {
    return { candidates: [], issues: [{ code: 'workspace_unreadable', severity: 'manual', message: 'The configured workspace could not be safely inspected.', action: 'Confirm the workspace path and review material manually.' }] };
  }
}

function parseSource(sourceFile: string): ParsedSource {
  const bytes = regularFile(sourceFile, MAX_SOURCE_BYTES);
  let raw: JsonObject;
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    const root = object(parsed);
    if (!root) throw new Error('root');
    raw = root;
  } catch {
    throw new MigrationError('unsupported_source_format', 'Only standard-JSON openclaw.json is supported. JSON5 or malformed input requires a reviewed conversion; no source file was changed.');
  }
  const meta = object(raw.meta);
  const version = typeof meta?.lastTouchedVersion === 'string' ? meta.lastTouchedVersion : '';
  if (version !== VERIFIED_OPENCLAW_VERSION) throw new MigrationError('unsupported_source_version', `OpenClaw source version is not the verified ${VERIFIED_OPENCLAW_VERSION} format. Run the matching OpenClaw doctor/backup flow, then retry with a reviewed current-format copy.`);
  const channels = object(raw.channels);
  const feishu = object(channels?.feishu);
  if (!feishu) throw new MigrationError('feishu_source_missing', 'The selected OpenClaw source has no Feishu channel configuration.');
  const applications: ParsedSource['applications'] = [];
  const add = (accountId: string, account: JsonObject) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(accountId) || applications.some(app => app.accountId === accountId)) throw new MigrationError('ambiguous_application', 'OpenClaw Feishu account identifiers are ambiguous or unsupported; select a normalized source before migration.');
    const value = { ...feishu, ...account };
    delete value.accounts;
    const appId = typeof value.appId === 'string' && value.appId === value.appId.trim() && value.appId.length <= 256 ? value.appId : '';
    if (!appId) return;
    const secretValue = value.appSecret;
    const inlineSecret = typeof secretValue === 'string' && secretValue.length > 0 && secretValue.length <= 4096 && !/[\r\n\0]/.test(secretValue);
    const credential: OpenClawApplication['credential'] = inlineSecret ? 'inline' : object(secretValue) ? 'reference' : 'missing';
    const domain: OpenClawApplication['domain'] = value.domain === 'lark' ? 'lark' : value.domain === undefined || value.domain === 'feishu' ? 'feishu' : 'unsupported';
    const connectionMode: OpenClawApplication['connectionMode'] = value.connectionMode === undefined || value.connectionMode === 'websocket' ? 'websocket' : value.connectionMode === 'webhook' ? 'webhook' : 'unsupported';
    const policy = { allowFrom: value.allowFrom, groupAllowFrom: value.groupAllowFrom, groups: value.groups, requireMention: value.requireMention };
    applications.push({ accountId, appId, appSecret: credential === 'inline' ? secretValue as string : undefined,
      appFingerprint: digest(appId), appIdHint: hint(appId), enabled: value.enabled !== false, domain, connectionMode, credential, policy });
  };
  if (typeof feishu.appId === 'string' && feishu.appId.trim()) add('default', {});
  const accounts = object(feishu.accounts);
  for (const [accountId, value] of Object.entries(accounts ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const account = object(value);
    if (account) add(accountId, account);
  }
  if (!applications.length) throw new MigrationError('feishu_application_missing', 'The selected OpenClaw source contains no directly identifiable Feishu application.');
  const agents = object(raw.agents);
  const defaults = object(agents?.defaults);
  const reviewed = inspectCandidates(defaults?.workspace, sourceFile);
  return { fingerprint: bufferDigest(bytes), version, applications, candidates: reviewed.candidates,
    issues: reviewed.issues, workspace: reviewed.workspace };
}

function publicInspection(source: ParsedSource, sourceInstanceId: string): OpenClawInspection {
  const issues = [...source.issues];
  if (source.applications.some(app => app.connectionMode === 'webhook')) issues.push({ code: 'webhook_manual_cutover', severity: 'manual', message: 'Webhook event delivery cannot be switched to Namo by this importer.', action: 'During cutover, use the Feishu console to change this application to long-connection event delivery and retire the old callback/reverse-proxy route.' });
  if (source.applications.some(app => app.credential !== 'inline')) issues.push({ code: 'credential_reference', severity: 'manual', message: 'At least one credential is missing or uses an OpenClaw reference that Namo will not resolve.', action: 'Enter the credential directly into Namo protected local configuration.' });
  issues.push({ code: 'excluded_runtime_state', severity: 'info', message: 'Auth, gateways, plugins, tasks, cron, sessions, chat history, and model providers are never inherited.' });
  return { format: 'openclaw.json.standard-json', status: 'supported', sourceInstanceId, sourceFingerprint: source.fingerprint,
    sourceVersion: source.version, applications: source.applications.map(({ appId: _appId, appSecret: _appSecret, policy: _policy, ...app }) => app),
    candidates: source.candidates.map(({ file: _file, ...candidate }) => candidate), issues, excluded: EXCLUDED };
}

function validateInstanceId(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new MigrationError('invalid_source_selection', 'Select the source instance with a stable letters/numbers/dash identifier.');
}

export function inspectOpenClawSource(input: { sourceFile: string; sourceInstanceId: string }): OpenClawInspection {
  validateInstanceId(input.sourceInstanceId);
  try { return publicInspection(parseSource(resolve(input.sourceFile)), input.sourceInstanceId); }
  catch (error) {
    if (!(error instanceof MigrationError)) throw error;
    return { format: 'openclaw.json.standard-json', status: error.code.startsWith('unsupported_') ? 'unsupported' : 'manual',
      sourceInstanceId: input.sourceInstanceId, applications: [], candidates: [],
      issues: [{ code: error.code, severity: error.code.startsWith('unsupported_') ? 'unsupported' : 'manual', message: error.message }], excluded: EXCLUDED };
  }
}

function targetRaw(file: string): JsonObject | undefined {
  if (!existsSync(file)) return;
  const info = lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_SOURCE_BYTES) throw new MigrationError('target_invalid', 'The Namo target must be a bounded regular configuration file and was not changed.');
  const parsed: unknown = readJson(file);
  const root = object(parsed);
  if (!root) throw new MigrationError('target_invalid', 'The Namo target configuration is not a JSON object and was not changed.');
  if (root.version !== undefined && root.version !== 1 || root.dataDir !== undefined && typeof root.dataDir !== 'string' ||
      root.feishu !== undefined && !object(root.feishu) || root.codex !== undefined && !object(root.codex)) {
    throw new MigrationError('target_invalid', 'The Namo target has an unsupported version or structure and was not changed.');
  }
  const feishu = object(root.feishu);
  const codex = object(root.codex);
  for (const value of [feishu?.appId, feishu?.appSecret, feishu?.appSecretEnv, feishu?.domain]) if (value !== undefined && typeof value !== 'string') throw new MigrationError('target_invalid', 'The Namo target identity fields have unsupported types and were not changed.');
  if (codex?.projects !== undefined && !object(codex.projects)) throw new MigrationError('target_invalid', 'The Namo target projects structure is invalid and was not changed.');
  return root;
}

function fileFingerprint(file: string): string {
  return existsSync(file) ? digest(readFileSync(file, 'utf8')) : 'missing';
}

function sourcePermissions(config: JsonObject): { users: string[]; chats: string[]; wildcard: boolean; requireMention: boolean } {
  const usersRaw = strings(config.allowFrom);
  const chatsRaw = strings(config.groupAllowFrom);
  const groups = object(config.groups);
  for (const [chatId, value] of Object.entries(groups ?? {})) if (chatId !== '*' && object(value)?.enabled !== false) chatsRaw.push(chatId);
  const wildcard = usersRaw.includes('*') || chatsRaw.includes('*') || Object.hasOwn(groups ?? {}, '*');
  return { users: [...new Set(usersRaw.filter(value => value !== '*'))], chats: [...new Set(chatsRaw.filter(value => value !== '*'))], wildcard,
    requireMention: config.requireMention !== false };
}

function conflict(path: MigrationConflict['path'], sensitive: boolean, message: string): MigrationConflict {
  return { path, kind: path === 'codex.projects' ? 'project-name-in-use' : 'different-value', sensitive, message };
}

export function previewOpenClawMigration(input: { sourceFile: string; sourceInstanceId: string; accountId: string; targetConfigFile: string; projectName?: string }): OpenClawMigrationPreview {
  validateInstanceId(input.sourceInstanceId);
  if (!input.accountId) throw new MigrationError('application_selection_required', 'Select one OpenClaw Feishu account explicitly, even when only one is present.');
  const source = parseSource(resolve(input.sourceFile));
  const selected = source.applications.find(app => app.accountId === input.accountId);
  if (!selected) throw new MigrationError('application_selection_invalid', 'The selected Feishu account is not present in this source instance.');
  if (selected.domain === 'unsupported' || selected.connectionMode === 'unsupported') throw new MigrationError('application_unsupported', 'The selected Feishu account uses an unsupported domain or connection mode.');
  const targetFile = resolve(input.targetConfigFile);
  const target = targetRaw(targetFile);
  const targetFeishu = object(target?.feishu);
  const targetCodex = object(target?.codex);
  const conflicts: MigrationConflict[] = [];
  if (typeof targetFeishu?.appId === 'string' && targetFeishu.appId && targetFeishu.appId !== selected.appId) conflicts.push(conflict('feishu.appId', true, 'The target already identifies a different Feishu application.'));
  const targetHasSecret = typeof targetFeishu?.appSecret === 'string' && !!targetFeishu.appSecret || typeof targetFeishu?.appSecretEnv === 'string' && !!targetFeishu.appSecretEnv;
  if (selected.appSecret && targetHasSecret && targetFeishu?.appSecret !== selected.appSecret) conflicts.push(conflict('feishu.appSecret', true, 'The target already has a different protected App Secret or environment reference.'));
  if (typeof targetFeishu?.domain === 'string' && targetFeishu.domain !== selected.domain) conflicts.push(conflict('feishu.domain', false, 'The target Feishu/Lark domain differs from the source.'));
  const permissions = sourcePermissions(selected.policy);
  const projectName = input.projectName ?? 'openclaw';
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(projectName)) throw new MigrationError('project_name_invalid', 'Project name must contain only letters, numbers, underscores, and dashes.');
  const projects = object(targetCodex?.projects);
  if (source.workspace && projects?.[projectName] !== undefined && projects[projectName] !== source.workspace) conflicts.push(conflict('codex.projects', false, `The target project name ${projectName} is already in use.`));
  const inspection = publicInspection(source, input.sourceInstanceId);
  return { ...inspection, status: 'supported', accountId: input.accountId,
    selectedApplication: inspection.applications.find(app => app.accountId === input.accountId)!, targetConfigFile: targetFile,
    targetFingerprint: fileFingerprint(targetFile), conflicts,
    proposed: { credentialImportable: !!selected.appSecret, allowedUserCount: permissions.users.length, allowedChatCount: permissions.chats.length,
      wildcardPermissionsExcluded: permissions.wildcard, sourceRequireMention: permissions.requireMention, workspaceProjectAvailable: !!source.workspace, projectName } };
}

function dataDirectory(target: JsonObject | undefined, targetFile: string): string {
  const configured = target?.dataDir;
  const path = typeof configured === 'string' && configured ? expandPath(configured, dirname(targetFile)) : join(dirname(targetFile), 'data');
  if (path === '/' || path === homedir()) throw new MigrationError('unsafe_data_directory', 'Migration state requires a specific private data directory, not root or the home directory.');
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new MigrationError('unsafe_data_directory', 'Migration data directory must be a real directory, not a link or file.');
  }
  return path;
}

function initialTarget(targetFile: string): JsonObject {
  const dataDir = join(dirname(targetFile), 'data');
  return { version: 1, agent: 'codex', dataDir, concurrency: 1,
    feishu: { appId: '', appSecret: '', allowedUserIds: [], allowedChatIds: [], requireMention: true, domain: 'feishu' },
    codex: { bin: 'codex', home: join(dataDir, 'codex-home'), timeoutMs: 600_000, sandbox: 'read-only', projects: {}, networkAccess: false, readPaths: [], denyPaths: [], allowLocalCommits: false } };
}

function desiredFingerprint(value: unknown): string { return digest(JSON.stringify(value, null, 2) + '\n'); }

function assertConflictChoices(preview: OpenClawMigrationPreview, options: ImportOptions): void {
  for (const item of preview.conflicts) if (!options.conflictResolutions?.[item.path]) throw new MigrationError('conflict_unresolved', `Conflict ${item.path} requires an explicit keep-target or use-source decision.`);
}

function setField(root: JsonObject, section: 'feishu' | 'codex', key: string, value: unknown): void {
  const current = object(root[section]) ?? {};
  current[key] = value; root[section] = current;
}

function applySourceField(root: JsonObject, preview: OpenClawMigrationPreview, options: ImportOptions, path: MigrationConflict['path'], value: unknown): void {
  const hasConflict = preview.conflicts.some(item => item.path === path);
  if (hasConflict && options.conflictResolutions?.[path] === 'keep-target') return;
  const [section, key] = path.split('.') as ['feishu' | 'codex', string];
  setField(root, section, key, value);
}

function recordPath(target: JsonObject | undefined, targetFile: string, migrationId: string): string {
  return join(dataDirectory(target, targetFile), 'migrations', 'openclaw', migrationId, 'state.json');
}

function readRecord(file: string): MigrationRecord | undefined {
  if (!existsSync(file)) return;
  const value: unknown = readJson(file);
  const record = object(value);
  const source = object(record?.source);
  const target = object(record?.target);
  const phases: MigrationPhase[] = ['writing', 'imported', 'cutover_pending', 'cutover_verified', 'rollback_pending', 'rolled_back'];
  if (record?.schemaVersion !== 1 || typeof record.migrationId !== 'string' || !phases.includes(record.phase as MigrationPhase) ||
      !source || typeof source.fingerprint !== 'string' || !target || typeof target.afterFingerprint !== 'string' ||
      typeof target.beforeFingerprint !== 'string' || typeof target.appFingerprint !== 'string' || !Array.isArray(record.reviewArtifacts)) {
    throw new MigrationError('migration_state_invalid', 'Migration state is malformed or unsupported.');
  }
  return value as MigrationRecord;
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new MigrationError('unsafe_migration_directory', 'Migration directory must be a real private directory.');
  chmodSync(path, 0o700);
}

function writeRecord(file: string, record: MigrationRecord): void { privateDirectory(dirname(file)); record.updatedAt = new Date().toISOString(); atomicJson(file, record); }

function assertPreviewFresh(preview: OpenClawMigrationPreview, source: ParsedSource): void {
  if (preview.sourceFingerprint !== source.fingerprint || preview.sourceVersion !== source.version) throw new MigrationError('source_changed', 'OpenClaw source changed after preview. Generate and review a new preview.');
  if (preview.targetFingerprint !== fileFingerprint(preview.targetConfigFile)) throw new MigrationError('target_changed', 'Namo target configuration changed after preview. Generate and review a new preview.');
}

function candidateBytes(source: ParsedSource, candidateId: string): { candidate: ParsedSource['candidates'][number]; bytes: Buffer } {
  const candidate = source.candidates.find(item => item.id === candidateId);
  if (!candidate) throw new MigrationError('candidate_selection_invalid', 'An approved review candidate is not present in this source preview.');
  const bytes = regularFile(candidate.file, MAX_CANDIDATE_BYTES);
  if (bufferDigest(bytes) !== candidate.fingerprint) throw new MigrationError('candidate_changed', `${candidate.name} changed after preview. Review it again before import.`);
  return { candidate, bytes };
}

function reviewedCandidateBytes(source: ParsedSource, preview: OpenClawMigrationPreview, candidateId: string): { candidate: ParsedSource['candidates'][number]; bytes: Buffer } {
  const expected = preview.candidates.find(item => item.id === candidateId);
  if (!expected) throw new MigrationError('candidate_selection_invalid', 'An approved review candidate was not included in the reviewed preview.');
  const current = source.candidates.find(item => item.name === expected.name && item.scope === expected.scope);
  if (!current || current.fingerprint !== expected.fingerprint || current.id !== expected.id) throw new MigrationError('candidate_changed', `${expected.name} changed after preview. Review it again before import.`);
  return candidateBytes(source, current.id);
}

export function readOpenClawCandidate(input: { preview: OpenClawMigrationPreview; sourceFile: string; candidateId: string }): { candidate: OpenClawCandidate; content: string } {
  const source = parseSource(resolve(input.sourceFile));
  if (source.fingerprint !== input.preview.sourceFingerprint) throw new MigrationError('source_changed', 'OpenClaw source changed after preview.');
  const selected = reviewedCandidateBytes(source, input.preview, input.candidateId);
  const { file: _file, ...candidate } = selected.candidate;
  return { candidate, content: selected.bytes.toString('utf8') };
}

export function importOpenClawMigration(preview: OpenClawMigrationPreview, input: { sourceFile: string; options?: ImportOptions }): ImportResult {
  const options = input.options ?? {};
  assertConflictChoices(preview, options);
  const source = parseSource(resolve(input.sourceFile));
  if (preview.sourceFingerprint !== source.fingerprint || preview.sourceVersion !== source.version) throw new MigrationError('source_changed', 'OpenClaw source changed after preview. Generate and review a new preview.');
  const selected = source.applications.find(app => app.accountId === preview.accountId);
  if (!selected || selected.appFingerprint !== preview.selectedApplication.appFingerprint) throw new MigrationError('application_changed', 'Selected application changed after preview.');
  const oldTarget = targetRaw(preview.targetConfigFile);
  const migrationId = digest(`${source.fingerprint}\0${preview.accountId}\0${preview.targetConfigFile}`).slice(0, 24);
  const stateFile = recordPath(oldTarget, preview.targetConfigFile, migrationId);
  const existing = readRecord(stateFile);
  if (existing) {
    if (existing.migrationId !== migrationId || existing.source.fingerprint !== source.fingerprint || existing.target.appFingerprint !== selected.appFingerprint) throw new MigrationError('migration_state_mismatch', 'Existing migration state belongs to different source material.');
    const current = fileFingerprint(preview.targetConfigFile);
    if (current === existing.target.afterFingerprint && existing.phase !== 'writing') return { status: 'already-imported', stateFile, record: existing, needsCredential: !selected.appSecret, pendingReviewCount: existing.reviewArtifacts.length };
    if (current === existing.target.afterFingerprint && existing.phase === 'writing') {
      existing.phase = 'imported'; writeRecord(stateFile, existing);
      return { status: 'resumed', stateFile, record: existing, needsCredential: !selected.appSecret, pendingReviewCount: existing.reviewArtifacts.length };
    }
    if (current !== existing.target.beforeFingerprint) throw new MigrationError('target_changed_during_resume', 'Target changed during an interrupted migration. Review it before resuming.');
  } else assertPreviewFresh(preview, source);
  const next = structuredClone(oldTarget ?? initialTarget(preview.targetConfigFile));
  const permissions = sourcePermissions(selected.policy);
  applySourceField(next, preview, options, 'feishu.appId', selected.appId);
  if (selected.appSecret) {
    applySourceField(next, preview, options, 'feishu.appSecret', selected.appSecret);
    const secretConflict = preview.conflicts.some(item => item.path === 'feishu.appSecret');
    if (!secretConflict || options.conflictResolutions?.['feishu.appSecret'] === 'use-source') delete object(next.feishu)!.appSecretEnv;
  }
  applySourceField(next, preview, options, 'feishu.domain', selected.domain);
  const feishu = object(next.feishu)!;
  if ((options.permissions?.users ?? 'keep-target') === 'use-source') feishu.allowedUserIds = permissions.users;
  else feishu.allowedUserIds = strings(feishu.allowedUserIds);
  if ((options.permissions?.chats ?? 'keep-target') === 'use-source') feishu.allowedChatIds = permissions.chats;
  else feishu.allowedChatIds = strings(feishu.allowedChatIds);
  feishu.requireMention = options.permissions?.mention === 'use-source' ? permissions.requireMention : true;
  if (options.project?.importWorkspace) {
    if (!source.workspace) throw new MigrationError('workspace_unavailable', 'No safe source workspace is available to import as a project.');
    const projectName = options.project.projectName ?? preview.proposed.projectName;
    if (projectName !== preview.proposed.projectName) throw new MigrationError('project_selection_changed', 'Project name changed after preview. Generate and review a new preview.');
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(projectName)) throw new MigrationError('project_name_invalid', 'Project name must contain only letters, numbers, underscores, and dashes.');
    const codex = object(next.codex)!;
    const projects = object(codex.projects) ?? {};
    if (projects[projectName] !== undefined && projects[projectName] !== source.workspace && options.conflictResolutions?.['codex.projects'] !== 'use-source') throw new MigrationError('conflict_unresolved', 'The selected project name is already in use.');
    projects[projectName] = source.workspace; codex.projects = projects;
    if (typeof codex.defaultProject !== 'string' || !codex.defaultProject) codex.defaultProject = projectName;
  }
  const afterFingerprint = oldTarget && JSON.stringify(oldTarget) === JSON.stringify(next) ? fileFingerprint(preview.targetConfigFile) : desiredFingerprint(next);
  if (existing) {
    const current = fileFingerprint(preview.targetConfigFile);
    if (current !== existing.target.beforeFingerprint) throw new MigrationError('target_changed_during_resume', 'Target changed during an interrupted migration. Review it before resuming.');
    if (afterFingerprint !== existing.target.afterFingerprint) throw new MigrationError('resume_plan_changed', 'Import decisions changed after the migration checkpoint. Review and restart the migration instead of changing a resume plan.');
  }
  const approved = [...new Set(options.approvedCandidateIds ?? [])];
  const reviewArtifacts: MigrationRecord['reviewArtifacts'] = [];
  const reviewDir = join(dirname(stateFile), 'review');
  for (const id of approved) {
    const selectedCandidate = reviewedCandidateBytes(source, preview, id);
    privateDirectory(reviewDir);
    const file = join(reviewDir, `${selectedCandidate.candidate.kind}-${selectedCandidate.candidate.fingerprint.slice(0, 16)}-${basename(selectedCandidate.candidate.name)}`);
    if (!existsSync(file)) writeFileSync(file, selectedCandidate.bytes, { mode: 0o600, flag: 'wx' });
    else if (bufferDigest(readFileSync(file)) !== selectedCandidate.candidate.fingerprint) throw new MigrationError('review_artifact_conflict', 'A pending review artifact already exists with different content.');
    chmodSync(file, 0o600);
    reviewArtifacts.push({ candidateId: id, kind: selectedCandidate.candidate.kind, fingerprint: selectedCandidate.candidate.fingerprint, file, status: 'pending-review' });
  }
  if (existing && existing.reviewArtifacts.map(item => item.candidateId).sort().join('\0') !== reviewArtifacts.map(item => item.candidateId).sort().join('\0')) throw new MigrationError('resume_plan_changed', 'Approved review candidates changed after the migration checkpoint.');
  const record: MigrationRecord = existing ?? { schemaVersion: 1, migrationId, phase: 'writing',
    source: { instanceId: preview.sourceInstanceId, fingerprint: source.fingerprint, version: source.version, accountId: preview.accountId },
    target: { configFile: preview.targetConfigFile, beforeFingerprint: preview.targetFingerprint, afterFingerprint, appFingerprint: selected.appFingerprint },
    reviewArtifacts, excluded: EXCLUDED, updatedAt: new Date().toISOString() };
  record.reviewArtifacts = reviewArtifacts; record.target.afterFingerprint = afterFingerprint; record.phase = 'writing'; writeRecord(stateFile, record);
  const editor = new ConfigEditor(preview.targetConfigFile);
  editor.save(next);
  if (fileFingerprint(preview.targetConfigFile) !== afterFingerprint) throw new MigrationError('target_write_unverified', 'Namo configuration write could not be verified; migration remains resumable.');
  record.phase = 'imported'; writeRecord(stateFile, record);
  return { status: existing ? 'resumed' : 'imported', stateFile, record, needsCredential: !selected.appSecret, pendingReviewCount: reviewArtifacts.length };
}

function loadRecord(file: string): MigrationRecord {
  const record = readRecord(resolve(file));
  if (!record || record.schemaVersion !== 1) throw new MigrationError('migration_state_invalid', 'Migration state is missing or unsupported.');
  return record;
}

function exactTarget(record: MigrationRecord, migrationId: string, appFingerprint: string): void {
  if (migrationId !== record.migrationId || appFingerprint !== record.target.appFingerprint) throw new MigrationError('target_confirmation_mismatch', 'Migration or Feishu application confirmation does not match the imported target.');
}

function freshEvidence(record: MigrationRecord, evidence: ReceiverEvidence, receiver: ReceiverEvidence['receiver'], status: ReceiverEvidence['status'], now: number): void {
  const methodValid = evidence.method === 'process-owner-check' || evidence.method === 'health-probe';
  if (evidence.appFingerprint !== record.target.appFingerprint || evidence.receiver !== receiver || evidence.status !== status ||
      !methodValid || !Number.isFinite(evidence.observedAt) || evidence.observedAt > now + 5_000 || now - evidence.observedAt > EVIDENCE_MAX_AGE_MS) {
    throw new MigrationError('receiver_evidence_invalid', `Fresh ${receiver} ${status} evidence for the exact application is required.`);
  }
}

function confirmation(prefix: 'CUTOVER' | 'ROLLBACK', record: MigrationRecord): string { return `${prefix} ${record.target.appFingerprint.slice(0, 12)}`; }

export function cutoverConfirmation(record: MigrationRecord): string { return confirmation('CUTOVER', record); }
export function rollbackConfirmation(record: MigrationRecord): string { return confirmation('ROLLBACK', record); }

export function cutoverManualGate(record: MigrationRecord): string[] {
  const tag = record.target.appFingerprint.slice(0, 12);
  return [
    `Confirm the selected Feishu application fingerprint is ${tag}.`,
    'Drain or explicitly reconcile in-flight OpenClaw work for only this application.',
    'Use OpenClaw-native controls to stop/disable only this application receiver; Namo does not automate this step.',
    'Verify OpenClaw is inactive and Namo is still inactive for the same application, then begin cutover.',
    'Start Namo, re-check that OpenClaw remains inactive, and complete a live Feishu inbound/outbound round trip with user confirmation.',
  ];
}

export function beginCutover(stateFile: string, input: { migrationId: string; appFingerprint: string; confirmation: string; source: ReceiverEvidence; namo: ReceiverEvidence; now?: number }): MigrationRecord {
  const record = loadRecord(stateFile); exactTarget(record, input.migrationId, input.appFingerprint);
  if (record.phase !== 'imported' && record.phase !== 'rolled_back') throw new MigrationError('cutover_phase_invalid', 'Cutover can begin only after import or a completed rollback.');
  if (input.confirmation !== confirmation('CUTOVER', record)) throw new MigrationError('cutover_confirmation_required', 'Type the exact application-specific cutover confirmation.');
  const now = input.now ?? Date.now();
  freshEvidence(record, input.source, 'openclaw', 'inactive', now); freshEvidence(record, input.namo, 'namo', 'inactive', now);
  record.phase = 'cutover_pending'; record.cutover = { startedAt: new Date(now).toISOString() }; writeRecord(resolve(stateFile), record); return record;
}

export function completeCutover(stateFile: string, input: { migrationId: string; appFingerprint: string; source: ReceiverEvidence; namo: ReceiverEvidence; delivery: DeliveryEvidence; now?: number }): MigrationRecord {
  const record = loadRecord(stateFile); exactTarget(record, input.migrationId, input.appFingerprint);
  if (record.phase !== 'cutover_pending') throw new MigrationError('cutover_phase_invalid', 'Cutover verification requires a pending cutover.');
  const now = input.now ?? Date.now();
  freshEvidence(record, input.source, 'openclaw', 'inactive', now); freshEvidence(record, input.namo, 'namo', 'active', now);
  const delivery = input.delivery;
  if (delivery.appFingerprint !== record.target.appFingerprint || delivery.method !== 'live-feishu-roundtrip' || !delivery.inboundAccepted || !delivery.outboundDelivered || !delivery.userConfirmed ||
      !Number.isFinite(delivery.observedAt) || delivery.observedAt > now + 5_000 || now - delivery.observedAt > EVIDENCE_MAX_AGE_MS) throw new MigrationError('delivery_evidence_invalid', 'Fresh live Feishu inbound, delivered reply, and user confirmation evidence are all required.');
  record.phase = 'cutover_verified'; record.cutover = { ...(record.cutover ?? { startedAt: new Date(now).toISOString() }), verifiedAt: new Date(now).toISOString() };
  writeRecord(resolve(stateFile), record); return record;
}

export function beginRollback(stateFile: string, input: { migrationId: string; appFingerprint: string; confirmation: string; source: ReceiverEvidence; namo: ReceiverEvidence; now?: number }): MigrationRecord {
  const record = loadRecord(stateFile); exactTarget(record, input.migrationId, input.appFingerprint);
  if (record.phase !== 'cutover_verified' && record.phase !== 'cutover_pending') throw new MigrationError('rollback_phase_invalid', 'Rollback can begin only during or after cutover.');
  if (input.confirmation !== confirmation('ROLLBACK', record)) throw new MigrationError('rollback_confirmation_required', 'Type the exact application-specific rollback confirmation.');
  const now = input.now ?? Date.now();
  freshEvidence(record, input.namo, 'namo', 'inactive', now); freshEvidence(record, input.source, 'openclaw', 'inactive', now);
  record.phase = 'rollback_pending'; record.rollback = { startedAt: new Date(now).toISOString() }; writeRecord(resolve(stateFile), record); return record;
}

export function completeRollback(stateFile: string, input: { migrationId: string; appFingerprint: string; source: ReceiverEvidence; namo: ReceiverEvidence; now?: number }): MigrationRecord {
  const record = loadRecord(stateFile); exactTarget(record, input.migrationId, input.appFingerprint);
  if (record.phase !== 'rollback_pending') throw new MigrationError('rollback_phase_invalid', 'Rollback completion requires a pending rollback.');
  const now = input.now ?? Date.now();
  freshEvidence(record, input.namo, 'namo', 'inactive', now); freshEvidence(record, input.source, 'openclaw', 'active', now);
  record.phase = 'rolled_back'; record.rollback = { ...(record.rollback ?? { startedAt: new Date(now).toISOString() }), completedAt: new Date(now).toISOString() };
  writeRecord(resolve(stateFile), record); return record;
}
