import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initialConfig } from '../src/onboarding.js';
import { loadConfig } from '../src/config.js';
import { atomicJson, readJson } from '../src/paths.js';
import { Store } from '../src/store.js';
import type * as Service from '../src/service.js';
import { databaseFingerprint } from '../src/upgrade-backup.js';
import { DatabaseSync } from 'node:sqlite';
import { acquireLock } from '../src/safety.js';

function writable(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  } else chmodSync(path, 0o600);
}
function put(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body);
}
interface BootstrapReceipt { status: number | null; registered: boolean; timeout?: boolean }
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(os.tmpdir(), 'namo-service-lifecycle-'));
  const privateHome = join(dir, 'private-home'), fake = join(dir, 'codex.mjs'), calls = join(dir, 'probe-calls');
  mkdirSync(privateHome);
  writeFileSync(fake, `#!${process.execPath}
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const allowed = new Set(['initialize', 'initialized', 'account/read', 'permissionProfile/list', 'plugin/list', 'skills/list']);
createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (!allowed.has(message.method)) process.exit(98);
  appendFileSync(${JSON.stringify(calls)}, message.method + '\\n');
  if (message.id === undefined) return;
  const result = message.method === 'account/read' ? {account:{type:'chatgpt'}}
    : message.method === 'permissionProfile/list' ? {data:[{id:'feishu-bot',allowed:true}]}
    : message.method === 'skills/list' ? {data:[{cwd:message.params.cwds[0],skills:[],errors:[]}]} : {};
  process.stdout.write(JSON.stringify({id:message.id,result})+'\\n');
});
`, { mode: 0o700 });
  let registered = false, bootstrapCount = 0;
  let receipt: BootstrapReceipt = { status: 0, registered: true };
  const launches: string[][] = [];
  const originalSpawn = childProcess.spawn;
  const spawnMock = t.mock.method(childProcess, 'spawn', ((command: string, ...args: unknown[]) => {
    assert.equal(command, realpathSync(fake), 'only the temporary protocol fixture may execute');
    return Reflect.apply(originalSpawn, childProcess, [command, ...args]);
  }) as typeof childProcess.spawn);
  const spawnSyncMock = t.mock.method(childProcess, 'spawnSync', ((command: string, args: string[] = []) => {
    assert.equal(command, 'launchctl', 'never run a real system or agent command');
    launches.push([...args]);
    let status: number | null = 0, stdout = '', error: NodeJS.ErrnoException | undefined;
    if (args[0] === 'print') { status = registered ? 0 : 113; stdout = registered ? 'state = running\n' : ''; }
    else if (args[0] === 'bootstrap') {
      assert.ok(args[2]?.startsWith(privateHome + '/'), 'plist must remain in the temporary home');
      bootstrapCount++; registered = receipt.registered; status = receipt.status;
      if (receipt.timeout) error = Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' });
    } else if (args[0] === 'bootout') registered = false;
    else assert.fail('unexpected launchctl operation');
    return { pid: 0, output: [null, stdout, ''], stdout, stderr: '', status, signal: receipt.timeout ? 'SIGTERM' : null, error };
  }) as typeof childProcess.spawnSync);
  const homeMock = t.mock.method(os, 'homedir', () => privateHome);
  syncBuiltinESMExports();
  t.after(() => {
    spawnMock.mock.restore(); spawnSyncMock.mock.restore(); homeMock.mock.restore(); syncBuiltinESMExports();
    writable(dir); rmSync(dir, { recursive: true, force: true });
  });
  const file = join(dir, 'config.json'), raw = initialConfig(file);
  raw.feishu.appId = 'cli_aaaaaaaaaaaaaaaa'; raw.feishu.appSecret = 'lifecycle-fixture-secret';
  raw.feishu.allowedUserIds = ['ou_fixture']; raw.codex.bin = fake;
  mkdirSync(raw.codex.home, { recursive: true }); atomicJson(file, raw);
  const config = loadConfig(file);
  const source = async (name: string): Promise<typeof Service> => {
    const root = join(dir, name);
    // Copy the actual compiled modules, then exercise serviceAction against a
    // package fixture. No source checkout, live registration or SDK is modified.
    cpSync(fileURLToPath(new URL('../src/', import.meta.url)), join(root, 'dist/src'), { recursive: true });
    put(join(root, 'dist/ui/index.html'), `<main>${name}</main>`);
    put(join(root, 'dist/scripts/launchd.js'), 'export {};');
    put(join(root, 'bin/namo.js'), 'export {};');
    put(join(root, 'assets/logo.png'), 'fixture');
    const toml = realpathSync(fileURLToPath(new URL('../../node_modules/smol-toml/', import.meta.url)));
    cpSync(toml, join(root, 'node_modules/smol-toml'), { recursive: true });
    const tomlVersion = JSON.parse(readFileSync(join(toml, 'package.json'), 'utf8')).version;
    put(join(root, 'package.json'), JSON.stringify({ name: 'namo-service-fixture', version: '0.1.0', type: 'module', dependencies: { 'smol-toml': tomlVersion } }));
    return import(pathToFileURL(join(root, 'dist/src/service.js')).href) as Promise<typeof Service>;
  };
  const service = await source('before');
  const plist = join(privateHome, 'Library/LaunchAgents', `${service.serviceLabel(config)}.plist`);
  return { config, file, service, source, plist, calls, launches,
    get bootstrapCount() { return bootstrapCount; },
    setReceipt(value: BootstrapReceipt) { receipt = value; },
  };
}

test('ambiguous installation preserves registration without retrying or assuming the receiver is stopped', { skip: process.platform !== 'darwin' }, async t => {
  for (const outcome of [
    { status: null, registered: true, timeout: true },
    { status: 1, registered: false },
  ] satisfies BootstrapReceipt[]) {
    await t.test(outcome.timeout ? 'timed out after registration' : 'rejected before registration', async inner => {
      const f = await fixture(inner); f.setReceipt(outcome);
      await assert.rejects(f.service.serviceAction('install', f.config), /启动结果未确认/);
      assert.equal(f.bootstrapCount, 1);
      assert.equal(existsSync(f.plist), true);
      const record = f.service.verifyServiceRegistration(f.config, f.plist);
      assert.equal(f.service.serviceStatus(f.config).registered, outcome.registered);
      await assert.rejects(f.service.serviceAction('install', f.config), /服务已安装/);
      assert.equal(f.bootstrapCount, 1, 'install must not replay an ambiguous bootstrap');
      if (outcome.registered) {
        await assert.rejects(f.service.serviceAction('start', f.config), /服务已启动/);
        assert.equal(f.bootstrapCount, 1);
        await f.service.serviceAction('stop', f.config);
      }
      f.setReceipt({ status: 0, registered: true });
      const restarted = await f.service.serviceAction('start', f.config);
      assert.equal(restarted.registered, true);
      assert.equal(f.bootstrapCount, 2, 'only an explicit start may make another attempt');
      assert.equal(f.service.verifyServiceRegistration(f.config, f.plist).release.id, record.release.id);
    });
  }
});

test('isolated install, stopped upgrade and same-schema rollback preserve newer messages and unknown sends', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t), originalConfig = readFileSync(f.file);
  await f.service.serviceAction('install', f.config);
  const before = f.service.verifyServiceRegistration(f.config, f.plist).release;
  await f.service.serviceAction('stop', f.config);
  const database = join(f.config.dataDir, 'bot.sqlite');
  const first = new Store(database);
  first.enqueue({ key: 'old', messageId: 'old-message', chatKey: 'chat', chatId: 'chat', senderId: 'owner', text: 'old message' });
  first.db.prepare("UPDATE inbox SET state='replied' WHERE key='old'").run(); first.close();
  const newer = await f.source('after');
  await newer.serviceAction('upgrade', f.config);
  const after = newer.verifyServiceRegistration(f.config, f.plist).release;
  assert.notEqual(after.id, before.id);
  assert.equal(newer.serviceStatus(f.config).registered, false, 'upgrade must stay stopped');
  assert.equal(f.bootstrapCount, 1);
  const second = new Store(database);
  second.enqueue({ key: 'new', messageId: 'new-message', chatKey: 'chat', chatId: 'chat', senderId: 'owner', text: 'new message after upgrade' });
  second.addOutput('new', 'result', 'ambiguous result');
  second.db.prepare("UPDATE inbox SET state='delivery_unknown' WHERE key='new'").run();
  second.db.prepare("UPDATE outbox SET state='unknown',error='fixture_ambiguous_send'").run();
  const rows = { inbox: second.db.prepare('SELECT * FROM inbox ORDER BY seq').all(), outbox: second.db.prepare('SELECT * FROM outbox ORDER BY id').all() };
  second.close();
  await newer.serviceAction('start', f.config); await newer.serviceAction('stop', f.config);
  // Running upgrade from the old immutable package is the same-schema rollback
  // path. A receiver is never started by this rehearsal's launchctl substitute.
  const previous = await import(pathToFileURL(join(before.root, 'dist/src/service.js')).href) as typeof Service;
  await previous.serviceAction('upgrade', f.config);
  assert.equal(previous.verifyServiceRegistration(f.config, f.plist).release.id, before.id);
  assert.equal(previous.serviceStatus(f.config).registered, false);
  const current = new Store(database, true);
  assert.deepEqual(current.db.prepare('SELECT * FROM inbox ORDER BY seq').all(), rows.inbox);
  assert.deepEqual(current.db.prepare('SELECT * FROM outbox ORDER BY id').all(), rows.outbox);
  current.close();
  assert.deepEqual(readFileSync(f.file), originalConfig);
  assert.equal(readJson(join(f.config.dataDir, 'service.json')).release.id, before.id);
  assert.equal(f.bootstrapCount, 2, 'upgrade and rollback never bootstrap or replay work');
  assert.deepEqual(readFileSync(f.calls, 'utf8').trim().split('\n'), ['initialize', 'initialized', 'plugin/list', 'skills/list', 'account/read', 'permissionProfile/list']);
});


test('backup failure aborts upgrade before changing release, bootstrap or registration', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t); await f.service.serviceAction('install', f.config); await f.service.serviceAction('stop', f.config);
  const files = [f.plist, join(f.config.dataDir,'service.json'), join(f.config.dataDir,'service-bootstrap.mjs'), f.file];
  const before = files.map(path=>readFileSync(path));
  const release = f.service.verifyServiceRegistration(f.config,f.plist).release.id;
  // A real filesystem failure, not a mocked success result. A subsequent start must still use the old registration.
  writeFileSync(join(f.config.dataDir,'backups'),'blocked');
  await assert.rejects(f.service.serviceAction('upgrade',f.config), /upgrade_backup_failed/);
  files.forEach((path,i)=>assert.deepEqual(readFileSync(path),before[i]));
  assert.equal(f.service.verifyServiceRegistration(f.config,f.plist).release.id,release);
  assert.equal(f.service.serviceStatus(f.config).registered,false);assert.equal(f.bootstrapCount,1);
  await f.service.serviceAction('start',f.config);
  assert.equal(f.service.verifyServiceRegistration(f.config,f.plist).release.id,release);
});

test('reinstall requires a verified backup before replacing registration or starting', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  const installed = await f.service.serviceAction('install', f.config);
  assert.equal(installed.backup, undefined, 'first installation has no existing data to migrate');
  await f.service.serviceAction('uninstall', f.config);
  const database = join(f.config.dataDir, 'bot.sqlite');
  const db = new Store(database);
  db.enqueue({ key: 'unknown', messageId: 'message', chatKey: 'chat', chatId: 'chat', senderId: 'owner', text: 'retained' });
  db.addOutput('unknown', 'result', 'do not resend');
  db.db.prepare("UPDATE inbox SET state='delivery_unknown'").run();
  db.db.prepare("UPDATE outbox SET state='unknown'").run();
  const fingerprint = databaseFingerprint(db.db); db.close();
  const paths = [f.file, join(f.config.dataDir, 'service.json'), join(f.config.dataDir, 'service-bootstrap.mjs')];
  const before = paths.map(path => readFileSync(path));
  const releases = readdirSync(join(f.config.dataDir, 'releases'));
  const newer = await f.source('reinstalled');
  const backupRoot = join(f.config.dataDir, 'backups');
  writeFileSync(backupRoot, 'blocked');
  await assert.rejects(newer.serviceAction('install', f.config), /upgrade_backup_failed/);
  paths.forEach((path, i) => assert.deepEqual(readFileSync(path), before[i]));
  assert.equal(existsSync(f.plist), false);
  assert.deepEqual(readdirSync(join(f.config.dataDir, 'releases')), releases);
  assert.equal(f.bootstrapCount, 1, 'failure must not start a new receiver');
  acquireLock(join(f.config.dataDir, 'config-edit.lock'))();
  rmSync(backupRoot);
  const result = await newer.serviceAction('install', f.config);
  const backup = result.backup as { path: string; verified: boolean };
  assert.equal(backup.verified, true);
  assert.equal(readJson(join(backup.path, 'verified.json')).operation, 'install');
  assert.equal(existsSync(join(backup.path, 'launch-agent.plist')), false, 'uninstall already removed the plist');
  for (const [index, name] of ['config.json', 'service.json', 'service-bootstrap.mjs'].entries()) {
    assert.deepEqual(readFileSync(join(backup.path, name)), before[index]);
  }
  for (const path of [database, join(backup.path, 'bot.sqlite')]) {
    const copy = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(databaseFingerprint(copy), fingerprint); } finally { copy.close(); }
  }
  assert.equal(f.bootstrapCount, 2);
  assert.notEqual(newer.verifyServiceRegistration(f.config, f.plist).release.id, JSON.parse(before[1]!.toString()).release.id);
});

test('installing over foreground data backs up the database without prior service files', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  const db = new Store(join(f.config.dataDir, 'bot.sqlite'));
  const fingerprint = databaseFingerprint(db.db); db.close();
  const result = await f.service.serviceAction('install', f.config);
  const backup = result.backup as { path: string; verified: boolean };
  assert.equal(backup.verified, true);
  assert.deepEqual(readJson(join(backup.path, 'verified.json')).files.map((file: { name: string }) => file.name), ['config.json']);
  const copy = new DatabaseSync(join(backup.path, 'bot.sqlite'), { readOnly: true });
  try { assert.equal(databaseFingerprint(copy), fingerprint); } finally { copy.close(); }
  assert.equal(f.bootstrapCount, 1);
});
