import { test } from 'node:test';
import assert from 'node:assert/strict';
import sqlite, { DatabaseSync } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUpgradeBackup, databaseFingerprint } from '../src/upgrade-backup.js';
import { parseConfig } from '../src/config.js';
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


test('a failed or silently empty backup operation cannot produce a verified receipt',async t=>{
 for(const mode of ['throw','empty','corrupt'])await t.test(mode,async inner=>{
  const f=fixture(inner),db=new DatabaseSync(f.database);db.exec("CREATE TABLE keep(value TEXT); INSERT INTO keep VALUES('safe')");const before=databaseFingerprint(db);db.close();
  const mock=inner.mock.method(sqlite,'backup',async(_db:DatabaseSync,target:string)=>{if(mode==='throw')throw new Error('private backend detail');writeFileSync(target,mode==='empty'?'':'corrupt');return 1;});syncBuiltinESMExports();
  inner.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  await assert.rejects(createUpgradeBackup(f.config,f.plist),/^Error: upgrade_backup_failed$/);
  const current=new DatabaseSync(f.database,{readOnly:true});assert.equal(databaseFingerprint(current),before);current.close();
 });
});
