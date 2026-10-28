import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, join, posix, resolve } from 'node:path';
import { createGunzip } from 'node:zlib';

export interface CodexRelease { version: string; target: string; url: string; sha256: string }
export class CodexUpdateError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CodexUpdateError'; }
}
const origin = 'https://releases.openai.com/codex';
const stable = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const targets = new Set(['aarch64-apple-darwin', 'x86_64-apple-darwin', 'aarch64-unknown-linux-musl', 'x86_64-unknown-linux-musl']);
const fail = (code: string): never => { throw new CodexUpdateError(code); };

export function targetTriple(platform: string = process.platform, arch: string = process.arch): string | null {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null;
  return cpu && (platform === 'darwin' ? `${cpu}-apple-darwin` : platform === 'linux' ? `${cpu}-unknown-linux-musl` : null);
}
export function parseStableRelease(value: unknown, target = targetTriple()): CodexRelease {
  if (!target || !targets.has(target)) return fail('codex_platform_unsupported');
  if (!value || typeof value !== 'object') return fail('codex_metadata_invalid');
  const data = value as { tag_name?: unknown; assets?: unknown };
  const version = typeof data.tag_name === 'string' && data.tag_name.startsWith('rust-v') ? data.tag_name.slice(6) : '';
  if (!stable.test(version) || !Array.isArray(data.assets) || data.assets.length > 1000) return fail('codex_metadata_invalid');
  const name = `codex-package-${target}.tar.gz`, url = `${origin}/releases/${version}/${name}`;
  const assets = data.assets.filter((asset: any) => asset && asset.name === name);
  if (assets.length !== 1 || typeof assets[0].digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(assets[0].digest)
    || assets[0].browser_download_url !== url) return fail('codex_metadata_invalid');
  return { version, target, url, sha256: assets[0].digest.slice(7) };
}

export interface NetworkOptions { fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal }
function checkCancelled(signal?: AbortSignal): void { if (signal?.aborted) fail('codex_update_cancelled'); }
async function download(url: string, limit: number, timeout: number, fetcher: typeof fetch, consume: (chunk: Uint8Array) => Promise<void>, signal?: AbortSignal): Promise<void> {
  checkCancelled(signal);
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => { abort = () => {
    controller.abort(); void reader?.cancel().catch(() => {});
    reject(new CodexUpdateError('codex_update_cancelled'));
  }; });
  signal?.addEventListener('abort', abort, { once: true });
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new CodexUpdateError('codex_download_timeout'));
  }, timeout); });
  try {
    await Promise.race([deadline, cancelled, (async () => {
      const response = await fetcher(url, { signal: controller.signal, redirect: 'error', headers: { accept: 'application/octet-stream' } });
      checkCancelled(signal);
      if (controller.signal.aborted) fail('codex_download_timeout');
      const body = response.body;
      if (!response.ok || !body) return fail('codex_download_failed');
      const size = response.headers.get('content-length');
      if (size && (!/^\d+$/.test(size) || Number(size) > limit)) fail('codex_download_too_large');
      reader = body.getReader();
      let bytes = 0;
      for (;;) {
        const { value, done } = await reader.read();
        checkCancelled(signal);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) fail('codex_download_too_large');
        if (controller.signal.aborted) fail('codex_download_timeout');
        await consume(value);
      }
    })()]);
  } catch (error) {
    checkCancelled(signal);
    if (error instanceof CodexUpdateError) throw error;
    fail(controller.signal.aborted ? 'codex_download_timeout' : 'codex_download_failed');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort();
    void reader?.cancel().catch(() => {});
  }
}

export async function fetchStableRelease(options: NetworkOptions = {}): Promise<CodexRelease> {
  const chunks: Buffer[] = [];
  await download(`${origin}/channels/latest`, 1024 * 1024, options.timeoutMs ?? 20_000, options.fetch ?? fetch,
    async chunk => { chunks.push(Buffer.from(chunk)); }, options.signal);
  checkCancelled(options.signal);
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail('codex_metadata_invalid'); }
  return parseStableRelease(value);
}

function archivePath(value: string): string {
  if (!value || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || /^[a-z]:/i.test(value)
    || value.split('/').includes('..')) return fail('codex_archive_invalid');
  const path = posix.normalize(value).replace(/\/$/, '');
  if (path === '.') return '';
  return path;
}
function octal(field: Buffer): number {
  const text = field.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(text)) return fail('codex_archive_invalid');
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value > 2 * 1024 ** 3) return fail('codex_archive_invalid');
  return value;
}
function paxFields(body: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  for (let cursor = 0; cursor < body.length;) {
    const space = body.indexOf(32, cursor);
    const length = Number(body.subarray(cursor, space).toString('ascii'));
    if (space < cursor || !Number.isInteger(length) || length <= space - cursor + 2 || cursor + length > body.length
      || body[cursor + length - 1] !== 10) return fail('codex_archive_invalid');
    const text = body.subarray(space + 1, cursor + length - 1).toString('utf8'), equals = text.indexOf('=');
    const key = text.slice(0, equals), value = text.slice(equals + 1);
    if (equals < 1 || !['path', 'linkpath', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(key)) return fail('codex_archive_invalid');
    result[key] = value; cursor += length;
  }
  return result;
}

/** Check all members before tar can write anything, including later link ancestors. */
export async function validateCodexArchive(file: string, signal?: AbortSignal): Promise<void> {
  checkCancelled(signal);
  const source = createReadStream(file), stream = source.pipe(createGunzip());
  source.on('error', error => stream.destroy(error));
  const abort = () => { stream.destroy(new CodexUpdateError('codex_update_cancelled')); source.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  const entries = new Map<string, { type: string; link: string }>();
  let buffer = Buffer.alloc(0), remaining = 0, expanded = 0, zeros = 0, extension = '', extensionSize = 0;
  let extensionBody: Buffer[] = [], nextName: string | undefined, nextLink: string | undefined;
  let pax: Record<string, string> = {};
  try {
    for await (const chunk of stream) {
      checkCancelled(signal);
      expanded += chunk.length;
      if (expanded > 2 * 1024 ** 3) fail('codex_archive_invalid');
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (remaining) {
          const count = Math.min(remaining, buffer.length);
          if (extension) {
            const take = Math.min(extensionSize, count);
            extensionBody.push(buffer.subarray(0, take)); extensionSize -= take;
          }
          buffer = buffer.subarray(count); remaining -= count;
          if (!remaining && extension) {
            const body = Buffer.concat(extensionBody);
            if (extension === 'x') pax = paxFields(body);
            else if (extension === 'L') nextName = body.toString('utf8').replace(/\0$/, '');
            else nextLink = body.toString('utf8').replace(/\0$/, '');
            extension = ''; extensionBody = [];
          }
          continue;
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512); buffer = buffer.subarray(512);
        if (header.every((byte: number) => byte === 0)) { zeros++; continue; }
        if (zeros || entries.size > 100_000) fail('codex_archive_invalid');
        let checksum = 0;
        for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
        if (checksum !== octal(header.subarray(148, 156))) fail('codex_archive_invalid');
        const text = (start: number, end: number) => header.subarray(start, end).toString('utf8').replace(/\0.*$/, '');
        const size = octal(header.subarray(124, 136)), type = text(156, 157) || '0';
        remaining = Math.ceil(size / 512) * 512;
        if (['x', 'L', 'K'].includes(type)) {
          if (!size || size > 65536 || extension || (type === 'x' && Object.keys(pax).length)) fail('codex_archive_invalid');
          extension = type; extensionSize = size; continue;
        }
        if (!['0', '1', '2', '5'].includes(type) || type !== '0' && size !== 0
          || pax.size !== undefined && Number(pax.size) !== size) fail('codex_archive_invalid');
        if (pax.path !== undefined && nextName !== undefined || pax.linkpath !== undefined && nextLink !== undefined) fail('codex_archive_invalid');
        const prefix = text(345, 500), name = archivePath(pax.path ?? nextName ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100)));
        const link = pax.linkpath ?? nextLink ?? text(157, 257);
        pax = {}; nextName = undefined; nextLink = undefined;
        if (!name) { if (type !== '5') fail('codex_archive_invalid'); continue; }
        const previous = entries.get(name);
        if (previous && (type !== '5' || previous.type !== '5')) fail('codex_archive_invalid');
        if (type === '2') {
          if (!link || link.startsWith('/') || link.includes('\\') || /[\x00-\x1f\x7f]/.test(link) || /^[a-z]:/i.test(link)) fail('codex_archive_invalid');
          const target = posix.normalize(posix.join(posix.dirname(name), link));
          if (target === '..' || target.startsWith('../')) fail('codex_archive_invalid');
        } else if (type === '1') archivePath(link);
        entries.set(name, { type, link });
      }
    }
    checkCancelled(signal);
    if (remaining || buffer.length || zeros < 2 || extension || nextName || nextLink || Object.keys(pax).length) fail('codex_archive_invalid');
    for (const [name, entry] of entries) {
      for (let parent = posix.dirname(name); parent !== '.'; parent = posix.dirname(parent)) {
        const ancestor = entries.get(parent);
        if (ancestor && ancestor.type !== '5') fail('codex_archive_invalid');
      }
      if (entry.type === '1' && entries.get(archivePath(entry.link))?.type !== '0') fail('codex_archive_invalid');
    }
  } catch (error) {
    checkCancelled(signal);
    if (error instanceof CodexUpdateError) throw error;
    fail('codex_archive_invalid');
  } finally { signal?.removeEventListener('abort', abort); stream.destroy(); source.destroy(); }
}

function cleanEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), CODEX_HOME: home };
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
async function command(bin: string, args: string[], home: string, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
  checkCancelled(signal);
  return new Promise((resolveResult, reject) => {
    let output = '', finished = false;
    const child = spawn(bin, args, { env: cleanEnvironment(home), stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    const finish = (result: string | null, error?: CodexUpdateError) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (child.pid) { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ } }
      if (error) reject(error); else resolveResult(result);
    };
    const abort = () => finish(null, new CodexUpdateError('codex_update_cancelled'));
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 4096) finish(null); });
    child.once('error', () => finish(null));
    child.once('close', code => finish(code === 0 ? output : null));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export async function readCodexVersion(bin: string, home: string, timeoutMs = 5000): Promise<string | null> {
  try {
    const candidates = bin.includes('/') || bin.includes('\\') ? [resolve(bin)] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, bin));
    let executable: string | undefined;
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) { executable = await realpath(candidate); break; }
      } catch { /* Try the next entry in the caller's configured search path. */ }
    }
    if (!executable) return null;
    const result = await command(executable, ['--version'], home, timeoutMs);
    return result?.trim().match(/^codex-cli (\d+\.\d+\.\d+(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)?)$/)?.[1] ?? null;
  } catch { return null; }
}

export async function installCodexRelease(release: CodexRelease, destination: string, options: NetworkOptions = {}): Promise<string> {
  checkCancelled(options.signal);
  if (!release || typeof release !== 'object') return fail('codex_metadata_invalid');
  const expected = parseStableRelease({ tag_name: `rust-v${release.version}`, assets: [{ name: `codex-package-${release.target}.tar.gz`, digest: `sha256:${release.sha256}`, browser_download_url: release.url }] }, release.target);
  if (expected.target !== targetTriple()) return fail('codex_platform_unsupported');
  let temporary: string | undefined;
  try {
    const parent = await realpath(dirname(resolve(destination))), final = join(parent, basename(destination));
    try {
      const stat = await lstat(final);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(final)).length) fail('codex_destination_not_empty');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    temporary = await mkdtemp(join(parent, '.namo-codex-'));
    checkCancelled(options.signal);
    const archive = join(temporary, 'package.tar.gz'), stage = join(temporary, 'package'), probeHome = join(temporary, 'probe-home');
    await mkdir(stage, { mode: 0o700 }); await mkdir(probeHome, { mode: 0o700 });
    const file = await open(archive, 'wx', 0o600), digest = createHash('sha256');
    try {
      await download(release.url, 512 * 1024 ** 2, options.timeoutMs ?? 180_000, options.fetch ?? fetch, async chunk => {
        digest.update(chunk);
        for (let offset = 0; offset < chunk.length;) { const result = await file.write(chunk, offset, chunk.length - offset); offset += result.bytesWritten; }
      }, options.signal);
    } finally { await file.close(); }
    if (digest.digest('hex') !== release.sha256) fail('codex_checksum_mismatch');
    await validateCodexArchive(archive, options.signal);
    if (await command('/usr/bin/tar', ['--no-same-owner', '--no-same-permissions', '-xzf', archive, '-C', stage], probeHome, 60_000, options.signal) === null) fail('codex_archive_invalid');
    const normalize = async (directory: string): Promise<void> => {
      checkCancelled(options.signal);
      await chmod(directory, 0o700);
      for (const name of await readdir(directory)) {
        checkCancelled(options.signal);
        const path = join(directory, name), stat = await lstat(path);
        if (stat.isDirectory()) await normalize(path);
        else if (stat.isFile()) await chmod(path, stat.mode & 0o111 ? 0o700 : 0o600);
        else if (stat.isSymbolicLink()) {
          const target = await realpath(path);
          if (!target.startsWith(`${stage}/`)) fail('codex_archive_invalid');
        } else fail('codex_archive_invalid');
      }
    };
    await normalize(stage);
    const bin = join(stage, 'bin/codex');
    for (const required of ['bin/codex', 'bin/codex-code-mode-host', 'codex-path/rg', 'codex-package.json', ...(process.platform === 'linux' ? ['codex-resources/bwrap'] : [])]) {
      if (!(await lstat(await realpath(join(stage, required)))).isFile()) fail('codex_package_incomplete');
    }
    if ((await command(bin, ['--version'], probeHome, 5000, options.signal))?.trim() !== `codex-cli ${release.version}`) fail('codex_version_mismatch');
    checkCancelled(options.signal);
    await rename(stage, final);
    if (options.signal?.aborted) { await rm(final, { recursive: true, force: true }); fail('codex_update_cancelled'); }
    return join(final, 'bin/codex');
  } catch (error) {
    checkCancelled(options.signal);
    if (error instanceof CodexUpdateError) throw error;
    return fail('codex_install_failed');
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {}); }
}
