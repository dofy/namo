import { writable, put } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sqlite, { DatabaseSync } from 'node:sqlite';
import { createRuntimeRelease, verifyRuntimeRelease } from '../src/release.js';
import { releaseUpgradeBlockers, renderLaunchAgent, serviceStatus, verifyServiceRegistration } from '../src/service.js';
import { initialConfig } from '../src/onboarding.js';
import { loadConfig, parseConfig } from '../src/config.js';
import { acquireLock } from '../src/safety.js';
import { atomicJson } from '../src/paths.js';
import { SCHEMA_VERSION } from '../src/store.js';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createUpgradeBackup, databaseFingerprint } from '../src/upgrade-backup.js';

function source(root: string): { root: string; dependency: string } {
  put(join(root, 'dist/src/cli.js'), 'export const build = "one";\n');
  put(join(root, 'dist/src/runner-worker.js'), 'export const worker = "one";\n');
  put(join(root, 'dist/src/service-bootstrap.js'), readFileSync(new URL('../src/service-bootstrap.js', import.meta.url), 'utf8'));
  put(join(root, 'dist/scripts/smoke-codex.js'), 'export {};\n');
  put(join(root, 'dist/ui/index.html'), '<main>one</main>\n');
  put(join(root, 'bin/namo.js'), '#!/usr/bin/env node\n');
  put(join(root, 'assets/namo-logo.png'), 'fixture-logo');
  put(join(root, 'package.json'), JSON.stringify({ name: 'namo-fixture', version: '1.2.3', dependencies: { fixture_runtime: '1.0.0' } }));
  const dependency = join(dirname(root), 'store', 'fixture_runtime');
  put(join(dependency, 'package.json'), JSON.stringify({ name: 'fixture_runtime', version: '1.0.0' }));
  put(join(dependency, 'index.js'), 'export const dependency = "one";\n');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(dependency, join(root, 'node_modules', 'fixture_runtime'), 'dir');
  return { root, dependency };
}

test('release snapshot is deterministic, self-contained, and detects tampering', t => {
  const temp = mkdtempSync(join(tmpdir(), 'namo-release-'));
  t.after(() => { if (lstatSync(temp).isDirectory()) { writable(temp); rmSync(temp, { recursive: true, force: true }); } });
  const fixture = source(join(temp, 'source'));
  const releases = join(temp, 'data', 'releases');
  const first = createRuntimeRelease(fixture.root, releases);
  const second = createRuntimeRelease(fixture.root, releases);
  assert.equal(second.id, first.id);
  assert.equal(second.root, first.root);
  assert.equal(verifyRuntimeRelease(first.root).id, first.id);
  assert.equal(readFileSync(join(first.root, 'node_modules/fixture_runtime/index.js'), 'utf8'), 'export const dependency = "one";\n');
  assert.equal(lstatSync(join(first.root, 'node_modules/fixture_runtime')).isSymbolicLink(), false);
  assert.equal(dirname(first.worker), join(first.root, 'dist/src'));

  writeFileSync(join(fixture.root, 'dist/src/runner-worker.js'), 'export const worker = "changed";\n');
  writeFileSync(join(fixture.dependency, 'index.js'), 'export const dependency = "changed";\n');
  assert.equal(readFileSync(first.worker, 'utf8'), 'export const worker = "one";\n');
  assert.equal(readFileSync(join(first.root, 'node_modules/fixture_runtime/index.js'), 'utf8'), 'export const dependency = "one";\n');
  writeFileSync(join(fixture.root, 'dist/src/runner-worker.js'), 'export const worker = "one";\n');
  writeFileSync(join(fixture.dependency, 'index.js'), 'export const dependency = "one";\n');

  chmodSync(first.entry, 0o600);
  writeFileSync(first.entry, 'tampered\n');
  assert.throws(() => verifyRuntimeRelease(first.root, first.id), /损坏|修改/);
  assert.throws(() => createRuntimeRelease(fixture.root, releases), /损坏|修改/);
});

test('registered and running release identity comes from registration and matching process health', t => {
  const temp = mkdtempSync(join(tmpdir(), 'namo-release-status-'));
  t.after(() => { writable(temp); rmSync(temp, { recursive: true, force: true }); });
  const fixture = source(join(temp, 'source'));
  const file = join(temp, 'config.json');
  atomicJson(file, initialConfig(file));
  const config = loadConfig(file);
  const release = createRuntimeRelease(fixture.root, join(config.dataDir, 'releases'));
  const record = { format: 2, label: 'io.namo.0123456789ab', config: file, node: process.execPath, path: '/usr/bin', release };
  atomicJson(join(config.dataDir, 'service.json'), record);
  put(join(config.dataDir, 'service-bootstrap.mjs'), readFileSync(join(release.root, 'dist/src/service-bootstrap.js'), 'utf8'));
  const plist = join(temp, 'service.plist');
  put(plist, renderLaunchAgent(config, record.label, release.entry, record.node, record.path, release));
  assert.equal(verifyServiceRegistration(config, plist).release.id, release.id);
  writeFileSync(plist, renderLaunchAgent(config, record.label, join(fixture.root, 'dist/src/cli.js'), record.node, record.path));
  assert.throws(() => verifyServiceRegistration(config, plist), /登记或发布快照无效/);
  writeFileSync(plist, renderLaunchAgent(config, record.label, release.entry, record.node, record.path, release));
  const unlock = acquireLock(config.dataDir);
  try {
    atomicJson(join(config.dataDir, 'health.json'), { pid: process.pid, ready: true, connection: 'connected', releaseId: release.id });
    const status = serviceStatus(config, true) as any;
    assert.deepEqual(status.release, { installed: release.id, running: release.id, receiver: release.id, verified: true, matches: true });
    atomicJson(join(config.dataDir, 'health.json'), { pid: process.pid, ready: true, connection: 'connected', releaseId: 'f'.repeat(64) });
    assert.equal((serviceStatus(config, true) as any).release.matches, false);
  } finally { unlock(); }
});

test('upgrade guard accounts for queue, runner, wait, outbox, and maintenance state', t => {
  const temp = mkdtempSync(join(tmpdir(), 'namo-release-guard-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const file = join(temp, 'bot.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE inbox(state TEXT);
    CREATE TABLE runner_jobs(state TEXT);
    CREATE TABLE task_waits(state TEXT);
    CREATE TABLE outbox(state TEXT);
    CREATE TABLE settings(key TEXT);
    PRAGMA user_version=${SCHEMA_VERSION};
  `);
  assert.deepEqual(releaseUpgradeBlockers(file), []);
  db.exec(`
    INSERT INTO inbox VALUES('waiting');
    INSERT INTO runner_jobs VALUES('lost');
    INSERT INTO task_waits VALUES('requested');
    INSERT INTO task_waits VALUES('open');
    INSERT INTO outbox VALUES('deferred');
    INSERT INTO settings VALUES('maintenance');
  `);
  db.close();
  assert.deepEqual(releaseUpgradeBlockers(file), ['receiver-queue', 'runner', 'wait', 'outbox', 'maintenance']);
  const previous = join(temp, 'previous.sqlite');
  const previousDb = new DatabaseSync(previous);
  previousDb.exec(`
    CREATE TABLE inbox(state TEXT); CREATE TABLE runner_jobs(state TEXT); CREATE TABLE task_waits(state TEXT);
    CREATE TABLE outbox(state TEXT); CREATE TABLE settings(key TEXT); PRAGMA user_version=6;
  `);
  previousDb.close();
  assert.deepEqual(releaseUpgradeBlockers(previous), ['database-schema']);
  const old = join(temp, 'old.sqlite');
  const oldDb = new DatabaseSync(old); oldDb.exec('PRAGMA user_version=5'); oldDb.close();
  assert.deepEqual(releaseUpgradeBlockers(old), ['database-schema']);
});

test('service bootstrap validates pinned identity before loading application or dependency code on every restart', t => {
  const temp=mkdtempSync(join(tmpdir(),'namo-bootstrap-'));
  t.after(()=>{writable(temp);rmSync(temp,{recursive:true,force:true});});
  const fixture=source(join(temp,'source')),marker=join(temp,'executed');
  put(join(fixture.root,'dist/src/cli.js'), "import {writeFileSync} from 'node:fs'; import 'fixture_runtime'; writeFileSync(process.env.NAMO_BOOT_MARKER, 'loaded');\n");
  const release=createRuntimeRelease(fixture.root,join(temp,'releases'));
  const launcher=join(temp,'service-bootstrap.mjs');put(launcher,readFileSync(join(release.root,'dist/src/service-bootstrap.js'),'utf8'));
  const launch=(id=release.id)=>spawnSync(process.execPath,[launcher,release.root,id,'/unused-config'],{encoding:'utf8',env:{...process.env,NAMO_BOOT_MARKER:marker}});
  assert.equal(launch().status,0);assert.equal(readFileSync(marker,'utf8'),'loaded');rmSync(marker);
  assert.notEqual(launch('f'.repeat(64)).status,0);assert.equal(existsSync(marker),false);
  chmodSync(release.root,0o700);
  renameSync(release.manifest,join(temp,'saved-manifest.json'));
  // Each automatic restart enters this same external bootstrap, never the CLI.
  for(let attempt=0;attempt<2;attempt++){assert.notEqual(launch().status,0);assert.equal(existsSync(marker),false);}
  renameSync(join(temp,'saved-manifest.json'),release.manifest);chmodSync(release.root,0o500);
  for(const target of [release.entry,join(release.root,'node_modules/fixture_runtime/index.js')]){
    const original=readFileSync(target);chmodSync(target,0o600);
    writeFileSync(target,"import {writeFileSync} from 'node:fs'; writeFileSync(process.env.NAMO_BOOT_MARKER, 'tampered');\n");
    assert.notEqual(launch().status,0);assert.equal(existsSync(marker),false,'modified top-level code never executes');
    writeFileSync(target,original);chmodSync(target,0o400);
  }
  assert.equal(launch().status,0);
});

function fixture(t: {after(fn:()=>void):void}) {
  const root=mkdtempSync(join(tmpdir(),'namo-backup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=join(root,'config.json'),plist=join(root,'service.plist'),dataDir=join(root,'data');mkdirSync(dataDir);
  writeFileSync(file,'{"private":"fixture"}');writeFileSync(plist,'original registration');
  return {root,file,plist,dataDir,config:parseConfig({dataDir},file),database:join(dataDir,'bot.sqlite')};
}
test('verified backup includes WAL rows, registration, config and original schema without migrating',async t=>{
  const f=fixture(t),db=new DatabaseSync(f.database);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=9; CREATE TABLE history(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO history VALUES(1,'private row')");
  const before=databaseFingerprint(db),result=await createUpgradeBackup(f.config,f.plist),copy=new DatabaseSync(join(result,'bot.sqlite'),{readOnly:true});
  assert.equal(databaseFingerprint(copy),before);assert.equal(databaseFingerprint(db),before);copy.close();db.close();
  assert.equal(statSync(result).mode&0o777,0o700);assert.equal(statSync(join(result,'bot.sqlite')).mode&0o777,0o600);
  assert.deepEqual(readFileSync(join(result,'config.json')),readFileSync(f.file));
  const receipt=JSON.parse(readFileSync(join(result,'verified.json'),'utf8'));assert.equal(receipt.database.fingerprint,before);
  assert.equal(JSON.stringify(receipt).includes('private row'),false);
});
test('empty or corrupt SQLite never yields a verified backup',async t=>{
  for(const content of ['', 'not a database']){const f=fixture(t);writeFileSync(f.database,content);
    await assert.rejects(createUpgradeBackup(f.config,f.plist),/^Error: upgrade_backup_failed$/);assert.equal(readFileSync(f.database,'utf8'),content);}
});
test('symlinked backup destinations are rejected before any copy outside data directory',async t=>{
  const f=fixture(t),external=join(f.root,'external');mkdirSync(external);symlinkSync(external,join(f.dataDir,'backups'));
  await assert.rejects(createUpgradeBackup(f.config,f.plist),/upgrade_backup_failed/);
});

test('install and upgrade require opposite plist states', async t => {
  const f = fixture(t);
  await assert.rejects(createUpgradeBackup(f.config, f.plist, 'install'), /upgrade_backup_failed/);
  rmSync(f.plist);
  await assert.rejects(createUpgradeBackup(f.config, f.plist), /upgrade_backup_failed/);
  const result = await createUpgradeBackup(f.config, f.plist, 'install');
  const receipt = JSON.parse(readFileSync(join(result, 'verified.json'), 'utf8'));
  assert.equal(receipt.operation, 'install');
  assert.equal(receipt.database.present, false);
  assert.deepEqual(receipt.files.map((file: { name: string }) => file.name), ['config.json']);
});

test('a failed or silently empty backup operation cannot produce a verified receipt',async t=>{
 for(const mode of ['throw','empty','corrupt'])await t.test(mode,async inner=>{
  const f=fixture(inner),db=new DatabaseSync(f.database);db.exec("CREATE TABLE keep(value TEXT); INSERT INTO keep VALUES('safe')");const before=databaseFingerprint(db);db.close();
  const mock=inner.mock.method(sqlite,'backup',async(_db:DatabaseSync,target:string)=>{if(mode==='throw')throw new Error('private backend detail');writeFileSync(target,mode==='empty'?'':'corrupt');return 1;});syncBuiltinESMExports();
  inner.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  await assert.rejects(createUpgradeBackup(f.config,f.plist),/^Error: upgrade_backup_failed$/);
  const current=new DatabaseSync(f.database,{readOnly:true});assert.equal(databaseFingerprint(current),before);current.close();
 });
});
