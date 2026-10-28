import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { CodexUpdateError, fetchStableRelease, installCodexRelease, parseStableRelease, readCodexVersion, targetTriple, validateCodexArchive, type CodexRelease } from '../src/codex-distribution.js';

const version = '0.165.0', target = targetTriple()!;
const release = (archive: Buffer): CodexRelease => ({ version, target,
  url: `https://releases.openai.com/codex/releases/${version}/codex-package-${target}.tar.gz`, sha256: createHash('sha256').update(archive).digest('hex') });
const metadata = (digest = 'a'.repeat(64)) => ({ tag_name: `rust-v${version}`, assets: [{ name: `codex-package-${target}.tar.gz`, digest: `sha256:${digest}`,
  browser_download_url: `https://releases.openai.com/codex/releases/${version}/codex-package-${target}.tar.gz` }] });
const serve = (body: Buffer | string, headers?: Record<string, string>) => (async () => new Response(typeof body === 'string' ? body : new Uint8Array(body), { headers })) as typeof fetch;
const code = (expected: string) => (error: unknown) => error instanceof CodexUpdateError && error.code === expected && error.message === expected;
function temporary(t: { after(fn: () => void): void }): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'namo-codex-distribution-')));
  t.after(() => rmSync(path, { recursive: true, force: true })); return path;
}
interface Entry { name: string; body?: string | Buffer; type?: string; link?: string; mode?: number }
function tar(entries: Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? ''), header = Buffer.alloc(512);
    const octal = (value: number, at: number, size: number) => header.write(value.toString(8).padStart(size - 1, '0') + '\0', at, size, 'ascii');
    header.write(entry.name, 0, 100); octal(entry.mode ?? 0o755, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(body.length, 124, 12); octal(0, 136, 12); header.fill(32, 148, 156);
    header.write(entry.type ?? '0', 156, 1); header.write(entry.link ?? '', 157, 100); header.write('ustar\0', 257);
    header.write('00', 263); octal(header.reduce((sum, byte) => sum + byte, 0), 148, 8);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
function packageArchive(actualVersion = version, versionScript?: string): Buffer {
  return tar([
    { name: 'bin/codex', body: versionScript ?? `#!/bin/sh\nprintf 'codex-cli ${actualVersion}\\n'\n`, mode: 0o777 },
    { name: 'bin/codex-code-mode-host', body: '#!/bin/sh\nexit 0\n' },
    { name: 'codex-path/rg', body: '#!/bin/sh\nexit 0\n' },
    { name: 'codex-resources/bwrap', body: '#!/bin/sh\nexit 0\n' },
    { name: 'codex-package.json', body: JSON.stringify({ version: actualVersion, target }), mode: 0o666 },
    { name: 'codex-resources/support.txt', body: 'preserved helper resource', mode: 0o644 },
  ]);
}

test('stable metadata requires one exact official asset for the supported platform', () => {
  assert.equal(targetTriple('darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.equal(targetTriple('linux', 'x64'), 'x86_64-unknown-linux-musl');
  assert.equal(targetTriple('win32', 'x64'), null); assert.equal(targetTriple('darwin', 'riscv64'), null);
  assert.equal(parseStableRelease(metadata()).version, version);
  for (const tag of ['rust-v0.165.0-alpha.1', '0.165.0', 'rust-v../0.165.0', 'rust-v00.165.0']) {
    assert.throws(() => parseStableRelease({ ...metadata(), tag_name: tag }), code('codex_metadata_invalid'));
  }
  for (const url of ['https://example.com/codex.tar.gz', `https://releases.openai.com.evil.test/${version}`, 'file:///tmp/codex']) {
    const input = metadata(); input.assets[0].browser_download_url = url;
    assert.throws(() => parseStableRelease(input), code('codex_metadata_invalid'));
  }
  const duplicate = metadata(); duplicate.assets.push(duplicate.assets[0]);
  assert.throws(() => parseStableRelease(duplicate), code('codex_metadata_invalid'));
  assert.throws(() => parseStableRelease(metadata('invalid')), code('codex_metadata_invalid'));
});

test('metadata download bounds bytes, time and errors without exposing response contents', async () => {
  let requested = '';
  const result = await fetchStableRelease({ fetch: (async (url, init) => {
    requested = String(url); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    return new Response(JSON.stringify(metadata()));
  }) as typeof fetch });
  assert.equal(requested, 'https://releases.openai.com/codex/channels/latest'); assert.equal(result.version, version);
  await assert.rejects(fetchStableRelease({ fetch: serve('not JSON with secret') }), code('codex_metadata_invalid'));
  await assert.rejects(fetchStableRelease({ fetch: serve('x'.repeat(1024 * 1024 + 1)) }), code('codex_download_too_large'));
  await assert.rejects(fetchStableRelease({ fetch: serve('{}', { 'content-length': '1048577' }) }), code('codex_download_too_large'));
  await assert.rejects(fetchStableRelease({ timeoutMs: 10, fetch: (() => new Promise(() => {})) as typeof fetch }), code('codex_download_timeout'));
  await assert.rejects(fetchStableRelease({ fetch: (async () => { throw new Error('credential-bearing raw network error'); }) as typeof fetch }), code('codex_download_failed'));
});

test('archive validation rejects traversal, escaping links, link ancestors, duplicates and special files', async t => {
  const root = temporary(t), archive = join(root, 'package.tar.gz');
  const unsafe: Entry[][] = [
    [{ name: '../escape', body: 'bad' }], [{ name: '/tmp/escape', body: 'bad' }], [{ name: 'C:/escape', body: 'bad' }],
    [{ name: 'safe\\escape', body: 'bad' }], [{ name: 'safe', type: '2', link: '../outside' }],
    [{ name: 'bin', type: '2', link: 'elsewhere' }, { name: 'bin/codex', body: 'bad' }],
    [{ name: 'bin/codex', body: 'bad' }, { name: 'bin', type: '2', link: 'elsewhere' }],
    [{ name: 'same', body: 'one' }, { name: 'same', body: 'two' }],
    [{ name: 'device', type: '3' }], [{ name: 'pipe', type: '6' }], [{ name: 'hardlink', type: '1', link: '../outside' }],
    [{ name: 'long-name', type: 'L', body: '../outside\0' }, { name: 'safe', body: 'bad' }],
    [{ name: 'pax', type: 'x', body: '19 path=../outside\n' }, { name: 'safe', body: 'bad' }],
  ];
  for (const entries of unsafe) {
    writeFileSync(archive, tar(entries)); await assert.rejects(validateCodexArchive(archive), code('codex_archive_invalid'));
  }
  writeFileSync(archive, Buffer.from('not a gzip file'));
  await assert.rejects(validateCodexArchive(archive), code('codex_archive_invalid'));
  writeFileSync(archive, tar([{ name: 'lib/real', body: 'real' }, { name: 'bin/relative', type: '2', link: '../lib/real' }]));
  await validateCodexArchive(archive);
});

test('verified installation preserves the complete package, limits permissions and checks version', async t => {
  const root = temporary(t), destination = join(root, 'release'); mkdirSync(destination);
  const archive = packageArchive();
  const bin = await installCodexRelease(release(archive), destination, { fetch: serve(archive) });
  assert.equal(bin, join(destination, 'bin/codex')); assert.equal(await readCodexVersion(bin, root), version);
  assert.equal(readFileSync(join(destination, 'codex-resources/support.txt'), 'utf8'), 'preserved helper resource');
  assert.equal(statSync(bin).mode & 0o777, 0o700);
  assert.equal(statSync(join(destination, 'codex-package.json')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(root), ['release']);
  await assert.rejects(installCodexRelease(release(archive), destination, { fetch: serve(archive) }), code('codex_destination_not_empty'));
});

test('failed checksums and versions never publish a candidate and remove staging files', async t => {
  const root = temporary(t), archive = packageArchive(), selected = release(archive), destination = join(root, 'release');
  await assert.rejects(installCodexRelease({ ...selected, sha256: '0'.repeat(64) }, destination, { fetch: serve(archive) }), code('codex_checksum_mismatch'));
  assert.deepEqual(readdirSync(root), []);
  const wrong = packageArchive('0.164.0');
  await assert.rejects(installCodexRelease(release(wrong), destination, { fetch: serve(wrong) }), code('codex_version_mismatch'));
  assert.deepEqual(readdirSync(root), []);
  const malicious = tar([{ name: '../escaped', body: 'bad' }]);
  await assert.rejects(installCodexRelease(release(malicious), destination, { fetch: serve(malicious) }), code('codex_archive_invalid'));
  assert.equal(existsSync(join(root, 'escaped')), false); assert.deepEqual(readdirSync(root), []);
  await assert.rejects(installCodexRelease(selected, destination, { fetch: serve('', { 'content-length': String(512 * 1024 ** 2 + 1) }) }), code('codex_download_too_large'));
  assert.deepEqual(readdirSync(root), []);
});

test('version probe limits runtime and output and does not inherit service credentials', async t => {
  const root = temporary(t), bin = join(root, 'codex');
  const write = (body: string) => { writeFileSync(bin, '#!/bin/sh\n' + body); chmodSync(bin, 0o700); };
  process.env.NAMO_DISTRIBUTION_TEST_SECRET = 'must-not-reach-child';
  t.after(() => { delete process.env.NAMO_DISTRIBUTION_TEST_SECRET; });
  write('test -z "$NAMO_DISTRIBUTION_TEST_SECRET" || exit 1\nprintf "codex-cli 0.165.0\\n"\n');
  assert.equal(await readCodexVersion(bin, root), version);
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = root + delimiter + (priorPath ?? '');
    assert.equal(await readCodexVersion('codex', root), version, 'resolves the caller PATH before spawning with a clean environment');
  } finally { if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath; }
  writeFileSync(bin, '#!/usr/bin/env node\nif (process.env.NAMO_DISTRIBUTION_TEST_SECRET) process.exit(1); console.log("codex-cli 0.165.0");\n');
  assert.equal(await readCodexVersion(bin, root), version, 'npm-style launcher can locate the controlled Node runtime');
  write('printf "raw private output\\n"\n'); assert.equal(await readCodexVersion(bin, root), null);
  write('sleep 20\n'); const started = Date.now();
  assert.equal(await readCodexVersion(bin, root, 30), null); assert.ok(Date.now() - started < 1500);
  write('i=0; while [ "$i" -lt 5000 ]; do printf x; i=$((i+1)); done\n');
  assert.equal(await readCodexVersion(bin, root), null);
});

test('metadata and download cancellation stop blocked work without publishing a candidate', async t => {
  const root = temporary(t), preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(fetchStableRelease({ signal: preAborted.signal, fetch: (() => { assert.fail('must not fetch after cancellation'); }) as typeof fetch }), code('codex_update_cancelled'));
  const controller = new AbortController();
  let cancelled = false, fetchedSignal: AbortSignal | null | undefined;
  const blocked = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new Uint8Array([1, 2, 3])); }, cancel() { cancelled = true; } });
  const pending = installCodexRelease(release(packageArchive()), join(root, 'release'), { signal: controller.signal, fetch: (async (_url, init) => {
    fetchedSignal = init?.signal; setTimeout(() => controller.abort(), 10); return new Response(blocked);
  }) as typeof fetch });
  await assert.rejects(pending, code('codex_update_cancelled'));
  assert.equal(cancelled, true); assert.equal(fetchedSignal?.aborted, true); assert.deepEqual(readdirSync(root), []);
});

test('archive and child-process cancellation terminate validation and clean candidate files', async t => {
  const root = temporary(t), archive = join(root, 'archive.tar.gz'); writeFileSync(archive, packageArchive());
  const validation = new AbortController(), validating = validateCodexArchive(archive, validation.signal); validation.abort();
  await assert.rejects(validating, code('codex_update_cancelled'));
  rmSync(archive);
  const pidFile = join(root, 'probe.pid'), controller = new AbortController();
  const packageBytes = packageArchive(version, `#!/bin/sh\nprintf '%s' "$$" > '${pidFile}'\nsleep 30\nprintf 'codex-cli ${version}\\n'\n`);
  const pending = installCodexRelease(release(packageBytes), join(root, 'release'), { fetch: serve(packageBytes), signal: controller.signal });
  const rejected = assert.rejects(pending, code('codex_update_cancelled'));
  for (let tries = 0; tries < 200 && !existsSync(pidFile); tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(pidFile), true, 'reaches the version child process');
  const pid = Number(readFileSync(pidFile, 'utf8')); controller.abort(); await rejected;
  let alive = true;
  for (let tries = 0; tries < 100 && alive; tries++) {
    try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 10)); } catch { alive = false; }
  }
  assert.equal(alive, false); assert.deepEqual(readdirSync(root), ['probe.pid']);
});
