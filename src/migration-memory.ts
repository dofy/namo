import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { digest } from './paths.js';
import { VERIFIED_OPENCLAW_VERSION } from './migration.js';
import { Memories, MemoryError, type MemoryKind, type MemoryScope, type MemoryStatus } from './memory.js';
import type { Store } from './store.js';

const STATE_BYTES = 512 * 1024;
const ARTIFACT_BYTES = 256 * 1024;
const BINDING_PREFIX = 'memory:migration-import:v1:';
const hex64 = /^[a-f0-9]{64}$/;
const migrationIdPattern = /^[a-f0-9]{24}$/;
const candidateIdPattern = /^[a-f0-9]{24}$/;
const phases = new Set(['imported', 'cutover_pending', 'cutover_verified', 'rollback_pending', 'rolled_back']);

type CandidateKind = 'assistant' | 'identity' | 'user' | 'memory' | 'instructions' | 'history';
type JsonObject = Record<string, unknown>;

export class MigrationMemoryError extends Error {
  constructor(readonly code: 'invalid' | 'forbidden' | 'missing' | 'changed' | 'storage_invalid' | 'unsupported', message: string) {
    super(message); this.name = 'MigrationMemoryError';
  }
}

export interface MigrationMemoryContext { dataDir: string; configFile: string; appId: string }
export interface MigrationMemoryAuthority { kind: 'local-owner'; authenticated: boolean; ownerId: string }
export interface MigrationMemoryImport {
  scope: MemoryScope;
  memoryId: string;
  status: MemoryStatus;
  importedAt: number;
}
export interface MigrationMemoryCandidate {
  migrationId: string;
  candidateId: string;
  candidateKind: CandidateKind;
  memoryKind: Exclude<MemoryKind, 'handoff'> | null;
  source: { instanceId: string; version: string; accountId: string; fingerprint: string };
  name: string;
  bytes: number;
  fingerprint: string;
  eligible: boolean;
  reason?: string;
  imports: MigrationMemoryImport[];
}
export interface ImportMigrationMemoryInput {
  migrationId: string;
  candidateId: string;
  fingerprint: string;
  scope: MemoryScope;
}
export interface ImportMigrationMemoryResult { created: boolean; memoryId: string; status: MemoryStatus }

interface ReviewArtifact { candidateId: string; kind: CandidateKind; fingerprint: string; file: string; status: 'pending-review' }
interface SafeRecord {
  migrationId: string;
  source: { instanceId: string; fingerprint: string; version: string; accountId: string };
  artifacts: ReviewArtifact[];
  directory: string;
}
interface StoredBinding {
  schema: 1;
  fingerprint: string;
  scope: MemoryScope;
  memoryId: string;
  sourceRef: string;
  importedAt: number;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
function safeLine(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new MigrationMemoryError('storage_invalid', `${label} is invalid`);
  }
  return value;
}
function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function within(root: string, child: string): boolean {
  const value = relative(root, child);
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !value.startsWith('/') && !value.startsWith('\\');
}
function regularBytes(file: string, maximum: number, label: string): Buffer {
  if (!existsSync(file)) throw new MigrationMemoryError('missing', `${label} no longer exists`);
  const info = lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new MigrationMemoryError('storage_invalid', `${label} must be a regular non-linked file`);
  if (info.size > maximum) throw new MigrationMemoryError('storage_invalid', `${label} exceeds its byte limit`);
  return readFileSync(file);
}
function realDirectory(path: string, label: string): string {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new MigrationMemoryError('storage_invalid', `${label} must be a real directory`);
  return realpathSync(path);
}
function memoryKind(kind: CandidateKind): Exclude<MemoryKind, 'handoff'> | null {
  return kind === 'memory' ? 'project_knowledge' : kind === 'user' ? 'user_fact' : kind === 'history' ? 'history_quote' : null;
}
function canonicalScope(scope: MemoryScope): string {
  return JSON.stringify([scope.kind, scope.ownerId, scope.project, scope.chatKey]);
}
function bindingKey(fingerprint: string, scope: MemoryScope): string {
  return `${BINDING_PREFIX}${digest(`${fingerprint}\0${canonicalScope(scope)}`)}`;
}
function parseScope(value: unknown): MemoryScope {
  const scope = object(value);
  if (!scope || !['owner', 'project', 'chat'].includes(String(scope.kind))) throw new MigrationMemoryError('storage_invalid', 'Stored import scope is invalid');
  const ownerId = safeLine(scope.ownerId, 'Stored import owner'), project = scope.project === null ? null : safeLine(scope.project, 'Stored import project', 80),
    chatKey = scope.chatKey === null ? null : safeLine(scope.chatKey, 'Stored import chat');
  if (scope.kind === 'owner' && (project !== null || chatKey !== null)) throw new MigrationMemoryError('storage_invalid', 'Stored owner scope is invalid');
  if (scope.kind === 'project' && (!project || chatKey !== null)) throw new MigrationMemoryError('storage_invalid', 'Stored project scope is invalid');
  if (scope.kind === 'chat' && !chatKey) throw new MigrationMemoryError('storage_invalid', 'Stored chat scope is invalid');
  return { kind: scope.kind as MemoryScope['kind'], ownerId, project, chatKey };
}

export class MigrationMemory {
  private readonly migrationsRoot: string;
  private readonly appFingerprint: string;
  constructor(private store: Store, private context: MigrationMemoryContext, private redact: (text: string) => string = text => text) {
    this.migrationsRoot = resolve(context.dataDir, 'migrations', 'openclaw');
    this.appFingerprint = digest(context.appId);
  }

  list(): MigrationMemoryCandidate[] {
    if (!existsSync(this.migrationsRoot)) return [];
    const dataRoot=realDirectory(resolve(this.context.dataDir),'Migration data directory');
    const migrations=realDirectory(join(dataRoot,'migrations'),'Migration directory');
    const root = realDirectory(join(migrations,'openclaw'), 'Migration root');
    const result: MigrationMemoryCandidate[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !migrationIdPattern.test(entry.name)) continue;
      const record = this.record(join(root, entry.name));
      if (!record) continue;
      for (const artifact of record.artifacts) result.push(this.candidate(record, artifact));
    }
    return result.sort((a, b) => a.source.instanceId.localeCompare(b.source.instanceId) || a.name.localeCompare(b.name));
  }

  importPending(input: ImportMigrationMemoryInput, authority: MigrationMemoryAuthority): ImportMigrationMemoryResult {
    if (!authority || authority.kind !== 'local-owner' || authority.authenticated !== true) throw new MigrationMemoryError('forbidden', 'Migration review requires the authenticated local owner');
    const scope = parseScope(input.scope);
    if (scope.ownerId !== authority.ownerId) throw new MigrationMemoryError('forbidden', 'Migration memory can only be assigned to the selected paired owner');
    if (!migrationIdPattern.test(input.migrationId) || !candidateIdPattern.test(input.candidateId) || !hex64.test(input.fingerprint)) {
      throw new MigrationMemoryError('invalid', 'Migration candidate selection is invalid');
    }
    const candidate = this.list().find(item => item.migrationId === input.migrationId && item.candidateId === input.candidateId);
    if (!candidate) throw new MigrationMemoryError('missing', 'Migration candidate is not available for this configuration');
    if (candidate.fingerprint !== input.fingerprint) throw new MigrationMemoryError('changed', 'Migration candidate changed; refresh and review it again');
    if (!candidate.eligible || !candidate.memoryKind) throw new MigrationMemoryError('unsupported', candidate.reason ?? 'This review material is not eligible for memory import');
    const record = this.record(join(this.migrationsRoot, input.migrationId));
    const artifact = record?.artifacts.find(item => item.candidateId === input.candidateId && item.fingerprint === input.fingerprint);
    if (!record || !artifact) throw new MigrationMemoryError('changed', 'Migration candidate changed; refresh and review it again');
    const bytes = this.artifactBytes(record, artifact), text = this.decode(bytes), key = bindingKey(candidate.fingerprint, scope);
    let redacted: string;
    try { redacted = this.redact(text); } catch { throw new MigrationMemoryError('unsupported', 'Migration review material could not be safely redacted'); }
    if (redacted !== text) throw new MigrationMemoryError('unsupported', 'Migration review material contains protected values and cannot be imported as memory');
    return this.store.transaction(() => {
      const existing = this.binding(key);
      if (existing) {
        if (existing.fingerprint !== candidate.fingerprint || canonicalScope(existing.scope) !== canonicalScope(scope)) throw new MigrationMemoryError('storage_invalid', 'Stored migration binding is inconsistent');
        const item = new Memories(this.store, this.redact).manage({ kind: 'local-owner', authenticated: true, ownerId: authority.ownerId })
          .find(value => value.id === existing.memoryId);
        if (!item) throw new MigrationMemoryError('storage_invalid', 'Imported memory binding points to a missing record');
        return { created: false, memoryId: item.id, status: item.status };
      }
      const sourceRef = `openclaw:${record.source.instanceId}:${artifact.candidateId}:${artifact.fingerprint}`;
      const saved = new Memories(this.store, this.redact).save({ kind: candidate.memoryKind!, scope, text, pendingReview: true }, {
        kind: 'local-owner', authenticated: true, ownerId: authority.ownerId, source: { kind: 'migration', ref: sourceRef },
      });
      const binding: StoredBinding = { schema: 1, fingerprint: candidate.fingerprint, scope, memoryId: saved.id, sourceRef, importedAt: Date.now() };
      this.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(binding));
      return { created: true, memoryId: saved.id, status: saved.status };
    });
  }

  private record(directory: string): SafeRecord | undefined {
    const actualDirectory = realDirectory(directory, 'Migration record directory');
    if (!within(realpathSync(this.migrationsRoot), actualDirectory) || basename(actualDirectory) !== basename(directory)) throw new MigrationMemoryError('storage_invalid', 'Migration record escaped its data directory');
    let state:JsonObject|undefined;
    try { state=object(JSON.parse(regularBytes(join(actualDirectory, 'state.json'), STATE_BYTES, 'Migration state').toString('utf8'))); }
    catch(error){if(error instanceof MigrationMemoryError)throw error;throw new MigrationMemoryError('storage_invalid','Migration state is not valid JSON');}
    const source = object(state?.source), target = object(state?.target);
    if(!state||!source||!target||state.migrationId!==basename(actualDirectory))throw new MigrationMemoryError('storage_invalid','Migration state identity is invalid');
    const targetConfig=resolve(safeLine(target.configFile,'Migration target config')),
      targetApp=safeLine(target.appFingerprint,'Migration target application',64);
    if(targetConfig!==resolve(this.context.configFile)||targetApp!==this.appFingerprint)return;
    if(state.schemaVersion!==1||!phases.has(String(state.phase)))throw new MigrationMemoryError('storage_invalid','Migration state version or phase is unsupported');
    const instanceId = safeLine(source.instanceId, 'Migration source instance', 64), fingerprint = safeLine(source.fingerprint, 'Migration source fingerprint', 64),
      version = safeLine(source.version, 'Migration source version', 32), accountId = safeLine(source.accountId, 'Migration source account', 64);
    if (!hex64.test(fingerprint) || version !== VERIFIED_OPENCLAW_VERSION || !Array.isArray(state.reviewArtifacts)) throw new MigrationMemoryError('storage_invalid', 'Migration state source is unsupported');
    const artifacts = state.reviewArtifacts.map((raw): ReviewArtifact => {
      const value = object(raw);
      if (!value || !candidateIdPattern.test(String(value.candidateId)) || !['assistant', 'identity', 'user', 'memory', 'instructions', 'history'].includes(String(value.kind))
        || !hex64.test(String(value.fingerprint)) || value.status !== 'pending-review') throw new MigrationMemoryError('storage_invalid', 'Migration review artifact metadata is invalid');
      return { candidateId: String(value.candidateId), kind: value.kind as CandidateKind, fingerprint: String(value.fingerprint), file: safeLine(value.file, 'Migration review artifact path', 4096), status: 'pending-review' };
    });
    if(new Set(artifacts.map(item=>item.candidateId)).size!==artifacts.length)throw new MigrationMemoryError('storage_invalid','Migration review candidate identifiers are duplicated');
    return { migrationId: String(state.migrationId), source: { instanceId, fingerprint, version, accountId }, artifacts, directory: actualDirectory };
  }

  private artifactBytes(record: SafeRecord, artifact: ReviewArtifact): Buffer {
    const reviewRoot = realDirectory(join(record.directory, 'review'), 'Migration review directory');
    const file = resolve(artifact.file);
    let parent:string;
    try{parent=realDirectory(dirname(file),'Migration review artifact directory');}
    catch{throw new MigrationMemoryError('storage_invalid','Migration review artifact escaped its review directory');}
    if (!within(record.directory, reviewRoot) || parent !== reviewRoot) throw new MigrationMemoryError('storage_invalid', 'Migration review artifact escaped its review directory');
    const bytes = regularBytes(file, ARTIFACT_BYTES, 'Migration review artifact');
    if (realpathSync(file) !== join(reviewRoot,basename(file)) || hash(bytes) !== artifact.fingerprint) throw new MigrationMemoryError('changed', 'Migration review artifact changed after import');
    return bytes;
  }

  private candidate(record: SafeRecord, artifact: ReviewArtifact): MigrationMemoryCandidate {
    const bytes = this.artifactBytes(record, artifact), kind = memoryKind(artifact.kind);
    return { migrationId: record.migrationId, candidateId: artifact.candidateId, candidateKind: artifact.kind, memoryKind: kind,
      source: { ...record.source }, name: basename(artifact.file), bytes: bytes.byteLength, fingerprint: artifact.fingerprint,
      eligible: kind !== null, ...(kind ? {} : { reason: 'Assistant identity and instruction files require separate manual review and are not memory.' }),
      imports: this.imports(artifact.fingerprint) };
  }

  private decode(bytes: Buffer): string {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new MigrationMemoryError('unsupported', 'Migration review material must be valid UTF-8 text'); }
  }

  private imports(fingerprint: string): MigrationMemoryImport[] {
    const rows = this.store.db.prepare("SELECT value FROM settings WHERE key LIKE ? ESCAPE '\\'").all(`${BINDING_PREFIX}%`) as { value: string }[];
    const memories = new Memories(this.store, this.redact);
    return rows.flatMap(row => {
      const binding = this.parseBinding(row.value);
      if (binding.fingerprint !== fingerprint) return [];
      const item = memories.manage({ kind: 'local-owner', authenticated: true, ownerId: binding.scope.ownerId }).find(value => value.id === binding.memoryId);
      if (!item) throw new MigrationMemoryError('storage_invalid', 'Imported memory binding points to a missing record');
      return [{ scope: binding.scope, memoryId: binding.memoryId, status: item.status, importedAt: binding.importedAt }];
    });
  }

  private binding(key: string): StoredBinding | undefined {
    const row = this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
    return row ? this.parseBinding(row.value) : undefined;
  }

  private parseBinding(raw: string): StoredBinding {
    let value: JsonObject | undefined;
    try { value = object(JSON.parse(raw)); } catch { value = undefined; }
    if (!value || value.schema !== 1 || !hex64.test(String(value.fingerprint)) || !/^M-[A-F0-9]{16}$/.test(String(value.memoryId))
      || !Number.isSafeInteger(value.importedAt) || Number(value.importedAt) < 1) throw new MigrationMemoryError('storage_invalid', 'Stored migration binding is invalid');
    return { schema: 1, fingerprint: String(value.fingerprint), scope: parseScope(value.scope), memoryId: String(value.memoryId),
      sourceRef: safeLine(value.sourceRef, 'Stored migration source'), importedAt: Number(value.importedAt) };
  }
}

export function migrationMemoryStatus(error: unknown): number {
  if (error instanceof MemoryError) return error.code === 'invalid' ? 400 : error.code === 'forbidden' ? 403 : error.code === 'missing' ? 404 : error.code === 'capacity' ? 413 : error.code === 'storage_invalid' ? 503 : 409;
  if (!(error instanceof MigrationMemoryError)) return 500;
  return error.code === 'invalid' ? 400 : error.code === 'forbidden' ? 403 : error.code === 'missing' ? 404 : error.code === 'unsupported' ? 422 : error.code === 'storage_invalid' ? 503 : 409;
}
