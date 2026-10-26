import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface ArtifactBinding {
  taskId: string;
  ownerId: string;
  chatId: string;
  projectRoot: string;
  projectRelativePath: string;
}

export interface ArtifactAuthorization extends ArtifactBinding {
  /** Must be derived from the accepted task instruction, never material text. */
  source: 'task_instruction';
}

export interface ArtifactRequest extends ArtifactBinding {}

export interface ArtifactLimits {
  maxBytes: number;
  maxPathLength: number;
  maxDepth: number;
  maxReadMs: number;
}

export const DEFAULT_ARTIFACT_LIMITS: Readonly<ArtifactLimits> = Object.freeze({
  maxBytes: 20_000_000,
  maxPathLength: 240,
  maxDepth: 20,
  maxReadMs: 2_000,
});

export type ArtifactKind = 'file' | 'image';

export class ArtifactError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ArtifactError'; }
}

type TypeInfo = Readonly<{ kind: ArtifactKind; mime: string; platformFileType: 'stream' | 'pdf' }>;

const TYPES: Readonly<Record<string, TypeInfo>> = Object.freeze({
  '.txt': Object.freeze({ kind: 'file', mime: 'text/plain; charset=utf-8', platformFileType: 'stream' }),
  '.md': Object.freeze({ kind: 'file', mime: 'text/markdown; charset=utf-8', platformFileType: 'stream' }),
  '.markdown': Object.freeze({ kind: 'file', mime: 'text/markdown; charset=utf-8', platformFileType: 'stream' }),
  '.pdf': Object.freeze({ kind: 'file', mime: 'application/pdf', platformFileType: 'pdf' }),
  '.png': Object.freeze({ kind: 'image', mime: 'image/png', platformFileType: 'stream' }),
  '.jpg': Object.freeze({ kind: 'image', mime: 'image/jpeg', platformFileType: 'stream' }),
  '.jpeg': Object.freeze({ kind: 'image', mime: 'image/jpeg', platformFileType: 'stream' }),
  '.gif': Object.freeze({ kind: 'image', mime: 'image/gif', platformFileType: 'stream' }),
  '.webp': Object.freeze({ kind: 'image', mime: 'image/webp', platformFileType: 'stream' }),
});

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const DENIED_COMPONENT = /^(?:\.git|\.codex|\.ssh|\.config|config|data|logs?|auth|credentials?|secrets?)$/i;
const DENIED_NAME = /^(?:\.env(?:\..*)?|config\.local(?:\..*)?|auth(?:entication)?(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?)$/i;

function configuredLimits(input: Partial<ArtifactLimits>): ArtifactLimits {
  const merged = { ...DEFAULT_ARTIFACT_LIMITS, ...input };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new ArtifactError(`invalid_artifact_limit:${key}`);
  }
  return merged;
}

function within(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

function validIdentity(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !CONTROL.test(value);
}

function sameBinding(request: ArtifactRequest, authorization: ArtifactAuthorization): boolean {
  return authorization.source === 'task_instruction'
    && request.taskId === authorization.taskId
    && request.ownerId === authorization.ownerId
    && request.chatId === authorization.chatId
    && request.projectRoot === authorization.projectRoot
    && request.projectRelativePath === authorization.projectRelativePath;
}

function extension(name: string): string {
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index).toLowerCase();
}

function signatureMatches(type: TypeInfo, ext: string, bytes: Buffer): boolean {
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return !text.includes('\0');
    } catch { return false; }
  }
  if (ext === '.pdf') return bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
  if (ext === '.png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === '.jpg' || ext === '.jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (ext === '.gif') return bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (ext === '.webp') return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return type.kind === 'file';
}

function statIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

export interface PreparedArtifact {
  readonly version: 1;
  readonly binding: Readonly<{ taskId: string; ownerId: string; chatId: string }>;
  readonly relativePath: string;
  readonly name: string;
  readonly kind: ArtifactKind;
  readonly mime: string;
  readonly platformFileType: 'stream' | 'pdf';
  readonly size: number;
  readonly sha256: string;
  readPayload(): Buffer;
}

class PreparedArtifactValue implements PreparedArtifact {
  readonly version = 1 as const;
  readonly binding: Readonly<{ taskId: string; ownerId: string; chatId: string }>;
  readonly relativePath: string;
  readonly name: string;
  readonly kind: ArtifactKind;
  readonly mime: string;
  readonly platformFileType: 'stream' | 'pdf';
  readonly size: number;
  readonly sha256: string;
  #payload: Buffer;

  constructor(binding: ArtifactBinding, relativePath: string, type: TypeInfo, payload: Buffer) {
    this.binding = Object.freeze({ taskId: binding.taskId, ownerId: binding.ownerId, chatId: binding.chatId });
    this.relativePath = relativePath;
    this.name = basename(relativePath);
    this.kind = type.kind;
    this.mime = type.mime;
    this.platformFileType = type.platformFileType;
    this.#payload = Buffer.from(payload);
    this.size = this.#payload.byteLength;
    this.sha256 = createHash('sha256').update(this.#payload).digest('hex');
    Object.freeze(this);
  }

  /** Always returns a copy. Delivery code must upload this, never reopen the path. */
  readPayload(): Buffer { return Buffer.from(this.#payload); }
}

/**
 * Validate and freeze a task-authorized project artifact for later delivery.
 * This function performs no network access and does not send anything.
 */
export function prepareArtifact(request: ArtifactRequest, authorization: ArtifactAuthorization,
  options: Partial<ArtifactLimits> = {}): PreparedArtifact {
  const limits = configuredLimits(options);
  if (![request.taskId, request.ownerId, request.chatId].every(validIdentity)) throw new ArtifactError('invalid_artifact_binding');
  if (!sameBinding(request, authorization)) throw new ArtifactError('artifact_not_authorized');
  if (!isAbsolute(request.projectRoot) || CONTROL.test(request.projectRoot)) throw new ArtifactError('invalid_project_root');
  const raw = request.projectRelativePath;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > limits.maxPathLength || CONTROL.test(raw)
    || isAbsolute(raw) || raw.includes('\\')) throw new ArtifactError('invalid_artifact_path');
  const parts = raw.split('/');
  if (parts.length > limits.maxDepth || parts.some(part => !part || part === '.' || part === '..')) throw new ArtifactError('invalid_artifact_path');
  if (parts.some(part => DENIED_COMPONENT.test(part) || DENIED_NAME.test(part))) throw new ArtifactError('artifact_path_denied');
  const type = TYPES[extension(parts.at(-1)!)];
  if (!type) throw new ArtifactError('artifact_type_unsupported');

  let physicalRoot: string;
  try {
    const rootInfo = lstatSync(request.projectRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new ArtifactError('invalid_project_root');
    physicalRoot = realpathSync(request.projectRoot);
    if (dirname(physicalRoot) === physicalRoot) throw new ArtifactError('invalid_project_root');
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError('invalid_project_root');
  }
  const candidate = resolve(physicalRoot, ...parts);
  if (!within(physicalRoot, candidate)) throw new ArtifactError('artifact_outside_project');
  let cursor = physicalRoot, leafIsFile = false;
  try {
    for (const part of parts) {
      cursor = resolve(cursor, part);
      const info = lstatSync(cursor);
      if (info.isSymbolicLink()) throw new ArtifactError('artifact_symlink_denied');
      if (cursor === candidate) leafIsFile = info.isFile();
    }
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError('artifact_missing');
  }
  if (!leafIsFile) throw new ArtifactError('artifact_not_file');
  let resolvedFile: string;
  try { resolvedFile = realpathSync(candidate); } catch { throw new ArtifactError('artifact_missing'); }
  if (!within(physicalRoot, resolvedFile)) throw new ArtifactError('artifact_outside_project');

  const started = Date.now();
  let fd: number | undefined;
  let payload: Buffer;
  let before: ReturnType<typeof fstatSync>;
  try {
    fd = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    before = fstatSync(fd);
    if (!before.isFile()) throw new ArtifactError('artifact_not_file');
    if (before.size <= 0) throw new ArtifactError('artifact_empty');
    if (before.size > limits.maxBytes) throw new ArtifactError('artifact_size_limit');
    payload = readFileSync(fd);
    const after = fstatSync(fd);
    if (!statIdentity(before, after) || payload.byteLength !== before.size) throw new ArtifactError('artifact_changed_during_read');
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError('artifact_read_failed');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (Date.now() - started > limits.maxReadMs) throw new ArtifactError('artifact_read_timeout');
  try {
    if (realpathSync(candidate) !== resolvedFile || realpathSync(request.projectRoot) !== physicalRoot
      || !statIdentity(before!, statSync(candidate))) throw new ArtifactError('artifact_changed_during_read');
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError('artifact_changed_during_read');
  }
  if (!signatureMatches(type, extension(parts.at(-1)!), payload!)) throw new ArtifactError('artifact_type_mismatch');
  const relativePath = parts.join('/');
  return new PreparedArtifactValue(request, relativePath, type, payload!);
}
