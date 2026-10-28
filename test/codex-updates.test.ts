import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { CodexUpdates, newerVersion, type UpdateDependencies } from '../src/codex-updates.js';
import { installationRoot, installationState, resolveCodexBinary, saveInstallation } from '../src/codex-installation.js';

function fixture(t: TestContext, overrides: Partial<UpdateDependencies> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'namo-cli-update-'))), data = join(root, 'data');
  const home = join(data, 'codex-home'), file = join(root, 'config.json'), original = join(root, 'original-codex');
  mkdirSync(home, { recursive: true }); writeFileSync(original, 'fixture', { mode: 0o700 });
  writeFileSync(file, JSON.stringify({ version: 1, dataDir: data, feishu: { appId: 'test', appSecret: 'PRIVATE_FIXTURE_SECRET' },
    codex: { bin: original, home, sandbox: 'read-only' } }));
  const config = loadConfig(file), store = new Store(join(data, 'bot.sqlite'));
  const state = { now: 1_000, latest: '0.200.0', current: '0.100.0', checks: 0, installs: 0, probes: [] as string[] };
  const versions = new Map<string, string>();
  const deps: UpdateDependencies = {
    now: () => state.now,
    latest: async () => { state.checks++; return { version: state.latest, target: 'aarch64-apple-darwin',
      url: `https://releases.openai.com/codex/releases/${state.latest}/codex-package-aarch64-apple-darwin.tar.gz`, sha256: 'a'.repeat(64) }; },
    install: async (release, destination) => {
      state.installs++; mkdirSync(join(destination, 'bin'), { recursive: true });
      const binary = join(destination, 'bin', 'codex'); writeFileSync(binary, 'fixture', { mode: 0o700 });
      versions.set(binary, release.version); return binary;
    },
    version: async bin => bin === original ? state.current : versions.get(bin) ?? null,
    probe: async c => { state.probes.push(c.bin); },
    ...overrides,
  };
  const updater = new CodexUpdates(config, deps);
  t.after(async () => { await updater.settled(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, data, home, file, original, config, store, state, deps, versions, updater };
}

test('checking records the latest stable release without installing or selecting it', async t => {
  const f = fixture(t), before = readFileSync(f.file, 'utf8');
  assert.equal((await f.updater.status()).automatic, false);
  await f.updater.action('check'); await f.updater.settled();
  const status = await f.updater.status();
  assert.equal(status.currentVersion, '0.100.0'); assert.equal(status.latestVersion, '0.200.0');
  assert.equal(status.checkedAt, f.state.now); assert.equal(status.updateAvailable, true);
  assert.equal(status.state, 'idle'); assert.equal(status.managed, false);
  assert.equal(f.state.installs, 0); assert.deepEqual(f.state.probes, []);
  assert.equal(resolveCodexBinary(f.original, f.home), f.original);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('upgrade activates a validated private binary, survives reconstruction and can roll back to the original', async t => {
  const f = fixture(t), originalBytes = readFileSync(f.original);
  await f.updater.action('upgrade'); await f.updater.settled();
  const selected = resolveCodexBinary(f.original, f.home), status = await f.updater.status();
  assert.notEqual(selected, f.original); assert.ok(selected.startsWith(installationRoot(f.home) + '/releases/'));
  assert.equal(status.currentVersion, '0.200.0'); assert.equal(status.previousVersion, '0.100.0');
  assert.equal(status.managed, true); assert.deepEqual(f.state.probes, [selected]);
  assert.deepEqual(readFileSync(f.original), originalBytes);
  const reopened = new CodexUpdates(f.config, f.deps);
  assert.equal((await reopened.status()).currentVersion, '0.200.0');
  await reopened.action('rollback'); await reopened.settled();
  assert.equal(resolveCodexBinary(f.original, f.home), f.original);
  assert.equal((await reopened.status()).currentVersion, '0.100.0');
  assert.equal((await reopened.status()).previousVersion, '0.200.0');
});

test('failed candidate compatibility checks preserve the active release and report a bounded error', async t => {
  const f = fixture(t);
  await f.updater.action('upgrade'); await f.updater.settled();
  const selected = resolveCodexBinary(f.original, f.home);
  f.state.latest = '0.201.0';
  const failing = new CodexUpdates(f.config, { ...f.deps, probe: async () => { throw Error('PRIVATE_RUNTIME_CREDENTIAL'); } });
  await failing.action('upgrade'); await failing.settled();
  const status = await failing.status();
  assert.equal(resolveCodexBinary(f.original, f.home), selected);
  assert.equal(status.currentVersion, '0.200.0'); assert.equal(status.state, 'failed');
  assert.equal(status.error, 'update_probe_failed'); assert.doesNotMatch(JSON.stringify(status), /PRIVATE_RUNTIME/);
});

test('automatic updates defer while tasks are queued and continue when the queue becomes idle', async t => {
  const f = fixture(t);
  f.store.enqueue({ key: 'busy', messageId: 'busy', chatKey: 'chat', chatId: 'chat', senderId: 'user', text: 'fixture task' });
  await f.updater.action('automatic', true); await f.updater.tick(); await f.updater.settled();
  assert.equal((await f.updater.status()).state, 'deferred'); assert.equal(f.state.installs, 0);
  await f.updater.tick(); assert.equal(f.state.checks, 1);
  f.store.claim('busy'); f.store.finish('busy', 'finished');
  const output = f.store.nextOutput()!; f.store.sending(output.id); f.store.sent(output.id, 'fixture-reply');
  await f.updater.tick(); await f.updater.settled();
  assert.equal((await f.updater.status()).currentVersion, '0.200.0'); assert.equal(f.state.installs, 1);
});

test('a task arriving during installation prevents selecting the candidate', async t => {
  const f = fixture(t);
  const updater = new CodexUpdates(f.config, { ...f.deps, install: async (release, destination) => {
    const bin = await f.deps.install(release, destination);
    f.store.enqueue({ key: 'arrived', messageId: 'arrived', chatKey: 'chat', chatId: 'chat', senderId: 'user', text: 'new task' });
    return bin;
  } });
  await updater.action('upgrade'); await updater.settled();
  assert.equal((await updater.status()).state, 'deferred');
  assert.equal(resolveCodexBinary(f.original, f.home), f.original);
});

test('configuration changes during download prevent switching to a previously approved candidate', async t => {
  const f = fixture(t);
  const updater = new CodexUpdates(f.config, { ...f.deps, install: async (release, destination) => {
    const bin = await f.deps.install(release, destination);
    writeFileSync(f.file, readFileSync(f.file, 'utf8') + '\n'); return bin;
  } });
  await updater.action('upgrade'); await updater.settled();
  const status = await updater.status();
  assert.equal(status.state, 'failed'); assert.equal(status.error, 'update_config_changed');
  assert.equal(resolveCodexBinary(f.original, f.home), f.original);
});

test('closing during installation aborts the installer and leaves the selected binary unchanged', async t => {
  const f = fixture(t); let destination = '', signal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const updater = new CodexUpdates(f.config, { ...f.deps, install: async (_release, dir, options) => {
    destination = dir; signal = options?.signal;
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'partial-download'), 'partial');
    markStarted();
    return new Promise<string>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(Error('update_cancelled')), { once: true });
    });
  } });
  await updater.action('upgrade'); await started; await updater.close();
  assert.equal(signal?.aborted, true); assert.equal(existsSync(destination), false);
  assert.equal(resolveCodexBinary(f.original, f.home), f.original);
  assert.equal((await updater.status()).error, 'update_cancelled');
  assert.deepEqual(f.state.probes, []);
  await assert.rejects(updater.action('upgrade'), /update_cancelled/);
});

test('shutdown prevents activation even when an installer ignores cancellation', async t => {
  const f = fixture(t); let destination = '', signal: AbortSignal | undefined;
  let markStarted!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const updater = new CodexUpdates(f.config, { ...f.deps, install: async (release, dir, options) => {
    destination = dir; signal = options?.signal; markStarted();
    await gate; return f.deps.install(release, dir);
  } });
  await updater.action('upgrade'); await started;
  const closing = updater.close(); assert.equal(signal?.aborted, true);
  finish(); await closing;
  assert.equal(resolveCodexBinary(f.original, f.home), f.original);
  assert.equal((await updater.status()).error, 'update_cancelled');
  assert.equal(existsSync(destination), false);
});

test('an updater constructed before a configuration change refuses all later actions', async t => {
  const f = fixture(t);
  writeFileSync(f.file, readFileSync(f.file, 'utf8') + '\n');
  for (const action of ['check', 'upgrade', 'rollback', 'automatic']) {
    await assert.rejects(f.updater.action(action, true), /update_config_changed/);
  }
  assert.equal(f.state.checks, 0); assert.equal(f.state.installs, 0);
  assert.equal(installationState(f.original, f.home).automatic, false);
});

test('failure reporting errors do not escape as unhandled rejections or leak the operation lock', async t => {
  const f = fixture(t), before = installationState(f.original, f.home);
  let fail!: () => void;
  const gate = new Promise<void>((_resolve, reject) => { fail = () => reject(Error('update_download_failed')); });
  const updater = new CodexUpdates(f.config, { ...f.deps, latest: async () => { await gate; return f.deps.latest(); } });
  await updater.action('check');
  const file = join(installationRoot(f.home), 'state.json');
  rmSync(file); mkdirSync(file);
  fail();
  // Let the background rejection settle without attaching a caller-owned handler.
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
  rmSync(file, { recursive: true }); saveInstallation(f.home, before);
  await f.updater.action('check'); await f.updater.settled();
  assert.equal((await f.updater.status()).state, 'idle');
});

test('the operation lock rejects concurrent updater instances and is released after completion', async t => {
  const f = fixture(t);
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const first = new CodexUpdates(f.config, { ...f.deps, latest: async () => { await wait; return f.deps.latest(); } });
  await first.action('check');
  await assert.rejects(f.updater.action('upgrade'), /update_busy/);
  await assert.rejects(f.updater.action('automatic', true), /update_busy/);
  finish(); await first.settled();
  await f.updater.action('check'); await f.updater.settled();
  assert.equal((await f.updater.status()).state, 'idle');
});

test('automatic mode is opt-in, persists across instances and checks at most once per day', async t => {
  const f = fixture(t);
  await f.updater.tick(); assert.equal(f.state.checks, 0);
  await f.updater.action('automatic', true);
  const reopened = new CodexUpdates(f.config, f.deps);
  assert.equal((await reopened.status()).automatic, true);
  await reopened.tick(); await reopened.settled(); assert.equal(f.state.checks, 1);
  f.state.now += 86_400_000 - 1;
  await reopened.tick(); await reopened.settled(); assert.equal(f.state.checks, 1);
  f.state.now++;
  await reopened.tick(); await reopened.settled(); assert.equal(f.state.checks, 2);
  assert.equal(f.state.installs, 1);
});

test('enabling automatic updates preserves the recent check time and applies an already discovered update', async t => {
  const f = fixture(t);
  await f.updater.action('check'); await f.updater.settled();
  const checkedAt = (await f.updater.status()).checkedAt;
  f.state.now += 1_000;
  const enabled = await f.updater.action('automatic', true);
  assert.equal(enabled.checkedAt, checkedAt);
  await f.updater.tick(); await f.updater.settled();
  assert.equal(f.state.installs, 1); assert.equal((await f.updater.status()).currentVersion, '0.200.0');
});

test('failed automatic upgrades back off for an hour before retrying', async t => {
  const f = fixture(t); let failing = true;
  const updater = new CodexUpdates(f.config, { ...f.deps, probe: async c => {
    if (failing) throw Error('probe unavailable');
    await f.deps.probe(c);
  } });
  await updater.action('automatic', true); await updater.tick(); await updater.settled();
  assert.equal((await updater.status()).state, 'failed'); assert.equal(f.state.checks, 1);
  f.state.now += 3_600_000 - 1; failing = false;
  await updater.tick(); await updater.settled(); assert.equal(f.state.checks, 1);
  f.state.now++;
  await updater.tick(); await updater.settled();
  assert.equal(f.state.checks, 2); assert.equal((await updater.status()).currentVersion, '0.200.0');
});

test('rolling back disables automatic upgrades and refuses a changed external previous binary', async t => {
  const f = fixture(t);
  await f.updater.action('automatic', true); await f.updater.action('upgrade'); await f.updater.settled();
  const selected = resolveCodexBinary(f.original, f.home);
  f.state.current = '0.101.0';
  await f.updater.action('rollback'); await f.updater.settled();
  assert.equal((await f.updater.status()).error, 'update_previous_changed');
  assert.equal(resolveCodexBinary(f.original, f.home), selected);
  f.state.current = '0.100.0';
  await f.updater.action('rollback'); await f.updater.settled();
  assert.equal((await f.updater.status()).automatic, false);
  f.state.now += 86_400_000; const checks = f.state.checks;
  await f.updater.tick(); assert.equal(f.state.checks, checks);
});

test('managed selection is bound to the configured command and rejects escaping release paths', async t => {
  const f = fixture(t);
  await f.updater.action('upgrade'); await f.updater.settled();
  assert.equal(resolveCodexBinary('/different/codex', f.home), '/different/codex');
  const state = installationState(f.original, f.home);
  saveInstallation(f.home, { ...state, active: { version: '0.200.0', directory: '../outside' } });
  assert.throws(() => resolveCodexBinary(f.original, f.home), /update_state_invalid/);
  saveInstallation(f.home, state);
  const linkName = '0.200.0-escaping', link = join(installationRoot(f.home), 'releases', linkName);
  symlinkSync(f.root, link);
  saveInstallation(f.home, { ...state, active: { version: '0.200.0', directory: linkName } });
  assert.throws(() => resolveCodexBinary(f.original, f.home), /update_state_invalid/);
});

test('stable version comparisons do not downgrade newer prerelease CLIs', async t => {
  assert.equal(newerVersion('0.165.0', '0.166.0-alpha.1.2'), false);
  assert.equal(newerVersion('0.165.0', '0.165.0-alpha.1.2'), true);
  assert.equal(newerVersion('0.165.0', '0.165.0'), false);
  assert.equal(newerVersion('0.165.0', '0.99.0'), true);
  const f = fixture(t); f.state.current = '0.201.0-alpha.1';
  await f.updater.action('upgrade'); await f.updater.settled();
  assert.equal(f.state.installs, 0); assert.equal((await f.updater.status()).updateAvailable, false);
});
