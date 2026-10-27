import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_MANIFEST = 'release-manifest.json';
export const RELEASE_ENTRY = 'dist/src/cli.js';
export const RELEASE_WORKER = 'dist/src/runner-worker.js';

interface ManifestFile { path: string; bytes: number; mode: number; sha256: string }
export interface ReleaseManifest {
  format: 1;
  id: string;
  entry: typeof RELEASE_ENTRY;
  worker: typeof RELEASE_WORKER;
  packageVersion: string;
  runtimeDependencies: string[];
  files: ManifestFile[];
}
export interface RuntimeRelease { id: string; root: string; entry: string; worker: string; manifest: string }

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const portable = (value: string) => value.split(sep).join('/');
const packageParts = (name: string) => name.split('/');

function copyTree(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  cpSync(source, target, {
    recursive: true,
    dereference: true,
    preserveTimestamps: false,
    filter: (candidate) => {
      const part = relative(source, candidate).split(sep)[0];
      return !part || part !== 'node_modules';
    },
  });
}

function dependencySource(from: string, name: string): string | undefined {
  let cursor = resolve(from);
  for (;;) {
    const candidate = join(cursor, 'node_modules', ...packageParts(name));
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function copyPackage(source: string, target: string, stack = new Set<string>()): void {
  const packageFile = join(source, 'package.json');
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8')) as {
    name?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  const key = realpathSync(source);
  if (stack.has(key)) throw new Error(tr("release.circularReleaseDependency", pkg.name ?? basename(source)));
  stack.add(key);
  copyTree(source, target);
  const required = Object.keys(pkg.dependencies ?? {}).sort();
  const optional = Object.keys(pkg.optionalDependencies ?? {}).sort();
  const peers = Object.keys(pkg.peerDependencies ?? {}).sort();
  for (const name of [...new Set([...required, ...optional, ...peers])]) {
    const found = dependencySource(source, name);
    if (!found) {
      if ((optional.includes(name) && !required.includes(name)) || pkg.peerDependenciesMeta?.[name]?.optional) continue;
      throw new Error(tr("release.missingReleaseDependency", name));
    }
    if (stack.has(realpathSync(found))) continue;
    copyPackage(found, join(target, 'node_modules', ...packageParts(name)), new Set(stack));
  }
}

function filesUnder(root: string, current = root): ManifestFile[] {
  const result: ManifestFile[] = [];
  for (const name of readdirSync(current).sort()) {
    const path = join(current, name);
    const rel = portable(relative(root, path));
    if (rel === RELEASE_MANIFEST) continue;
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error(tr("release.releaseSnapshotsCannotContainSymlinks", rel));
    if (info.isDirectory()) result.push(...filesUnder(root, path));
    else if (info.isFile()) result.push({ path: rel, bytes: info.size, mode: info.mode & 0o777, sha256: hash(readFileSync(path)) });
    else throw new Error(tr("release.unsupportedFileTypeReleaseSnapshot", rel));
  }
  return result;
}

function manifestIdentity(value: Omit<ReleaseManifest, 'id'>): string {
  return hash(JSON.stringify(value));
}

function makeReadOnly(root: string, current = root): void {
  for (const name of readdirSync(current)) {
    const path = join(current, name);
    const info = lstatSync(path);
    if (info.isDirectory()) { makeReadOnly(root, path); chmodSync(path, 0o500); }
    else chmodSync(path, info.mode & 0o111 ? 0o500 : 0o400);
  }
  if (current === root) chmodSync(root, 0o500);
}

function removeStaging(root: string, current = root): void {
  if (!existsSync(current)) return;
  const info = lstatSync(current);
  if (info.isDirectory()) {
    for (const name of readdirSync(current)) removeStaging(root, join(current, name));
    chmodSync(current, 0o700);
  } else chmodSync(current, 0o600);
  if (current === root) rmSync(root, { recursive: true, force: true });
}

export function sourcePackageRoot(moduleUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', '..');
}

export function verifyRuntimeRelease(root: string, expectedId?: string): ReleaseManifest {
  const resolved = realpathSync(root);
  const manifestPath = join(resolved, RELEASE_MANIFEST);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReleaseManifest;
  if (manifest.format !== 1 || !/^[a-f0-9]{64}$/.test(manifest.id)
    || manifest.entry !== RELEASE_ENTRY || manifest.worker !== RELEASE_WORKER
    || !Array.isArray(manifest.files) || !Array.isArray(manifest.runtimeDependencies)) {
    throw new Error(tr("release.invalidReleaseManifest"));
  }
  const { id, ...body } = manifest;
  if (manifestIdentity(body) !== id || (expectedId !== undefined && expectedId !== id) || basename(resolved) !== id) {
    throw new Error(tr("release.releaseSnapshotIdentityMismatch"));
  }
  const actual = filesUnder(resolved);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error(tr("release.releaseSnapshotCorruptedModified"));
  for (const required of [manifest.entry, manifest.worker, 'dist/src/service-bootstrap.js', 'package.json']) {
    if (!manifest.files.some(file => file.path === required)) throw new Error(tr("release.runtimeFileMissingReleaseSnapshot", required));
  }
  return manifest;
}

export function createRuntimeRelease(sourceRoot: string, releasesRoot: string): RuntimeRelease {
  sourceRoot = realpathSync(sourceRoot);
  const pkg = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8')) as {
    version?: string; dependencies?: Record<string, string>;
  };
  const staging = join(releasesRoot, `.staging-${randomUUID()}`);
  mkdirSync(releasesRoot, { recursive: true, mode: 0o700 });
  mkdirSync(staging, { mode: 0o700 });
  try {
    for (const required of ['dist/src', 'dist/scripts', 'dist/ui', 'bin', 'assets', 'package.json']) {
      const source = join(sourceRoot, required);
      if (!existsSync(source)) throw new Error(tr("release.incompleteNamoBuildMissing", required));
      copyTree(source, join(staging, required));
    }
    const dependencies = Object.keys(pkg.dependencies ?? {}).sort();
    for (const name of dependencies) {
      const source = dependencySource(sourceRoot, name);
      if (!source) throw new Error(tr("release.namoRuntimeDependencyMissing", name));
      copyPackage(source, join(staging, 'node_modules', ...packageParts(name)));
    }
    makeReadOnly(staging);
    chmodSync(staging, 0o700);
    const body: Omit<ReleaseManifest, 'id'> = {
      format: 1,
      entry: RELEASE_ENTRY,
      worker: RELEASE_WORKER,
      packageVersion: String(pkg.version ?? ''),
      runtimeDependencies: dependencies,
      files: filesUnder(staging),
    };
    const id = manifestIdentity(body);
    const manifest: ReleaseManifest = { ...body, id };
    writeFileSync(join(staging, RELEASE_MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o400, flag: 'wx' });
    chmodSync(staging, 0o500);
    const target = join(releasesRoot, id);
    if (existsSync(target)) {
      verifyRuntimeRelease(target, id);
      removeStaging(staging);
    } else {
      renameSync(staging, target);
      verifyRuntimeRelease(target, id);
    }
    return { id, root: target, entry: join(target, RELEASE_ENTRY), worker: join(target, RELEASE_WORKER), manifest: join(target, RELEASE_MANIFEST) };
  } catch (error) {
    if (existsSync(staging)) removeStaging(staging);
    throw error;
  }
}

export function currentRuntimeRelease(moduleUrl = import.meta.url): RuntimeRelease | undefined {
  let cursor = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    if (existsSync(join(cursor, RELEASE_MANIFEST))) {
      const manifest = verifyRuntimeRelease(cursor);
      return { id: manifest.id, root: cursor, entry: join(cursor, manifest.entry), worker: join(cursor, manifest.worker), manifest: join(cursor, RELEASE_MANIFEST) };
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
import { t as tr } from './locale.js';
