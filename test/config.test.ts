import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, migrateDirectoryConfiguration } from '../src/config.js';
import { executionPolicy, taskAuthorizationValid } from '../src/access.js';
import { readFileSync, readdirSync } from 'node:fs';
import { initialConfig } from '../src/onboarding.js';

test('directory migration preserves credentials and backs up legacy configuration without promoting read roots',t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'namo-directory-config-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=join(root,'config.json');mkdirSync(join(root,'source'));mkdirSync(join(root,'tools'));
  const old={codex:{projects:{app:'./source'},defaultProject:'app',readPaths:['./tools']},feishu:{appSecret:'synthetic-secret',allowedUserIds:['a','b']},custom:{keep:true}};
  const original=JSON.stringify(old);writeFileSync(file,original);migrateDirectoryConfiguration(file);
  const current=loadConfig(file),raw=JSON.parse(readFileSync(file,'utf8'));
  assert.deepEqual(current.codex.directories,[join(root,'source')]);assert.deepEqual(current.codex.readPaths,[]);
  assert.equal(raw.codex.projects,undefined);assert.deepEqual(raw.custom,old.custom);assert.equal(raw.feishu.appSecret,old.feishu.appSecret);
  const backups=join(root,'data','config-backups');assert.equal(readFileSync(join(backups,readdirSync(backups)[0]),'utf8'),original);
  migrateDirectoryConfiguration(file);assert.equal(readdirSync(backups).length,1);
  const message={key:'m',messageId:'m',chatKey:'group',chatId:'group',senderId:'b',text:'task'};
  assert.equal(executionPolicy(current.codex,current.feishu,message).sandbox,'workspace-write');
  assert.throws(()=>executionPolicy(current.codex,current.feishu,{...message,senderId:'outsider'}));
  assert.equal(taskAuthorizationValid(current,{...current,codex:{...current.codex,directories:[]}},message),false);
  assert.equal(taskAuthorizationValid(current,{...current,codex:{...current.codex,directories:[...current.codex.directories!,join(root,'tools')]}},message),true);
  for(const directory of ['/',homedir(),join(root,'data')]) {
    writeFileSync(file,JSON.stringify({...raw,codex:{...raw.codex,directories:[directory]}}));assert.throws(()=>loadConfig(file));
  }
});

test('project configuration resolves cwd and enforces service credential exclusions', t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'project'));
  const file = join(root, 'config.json');
  const base = { codex: { directories: ['./project'], networkAccess: true, sandbox: 'workspace-write' } };
  const save = (c: unknown) => writeFileSync(file, JSON.stringify(c));
  save(base); const config = loadConfig(file);
  assert.equal(config.concurrency, 8);
  assert.equal(initialConfig(file, file.slice(0, file.lastIndexOf('/'))).concurrency,8);
  for(const value of [1,2,3]) {save({...base,concurrency:value}); assert.equal(loadConfig(file).concurrency,4);}
  for(const value of [4,8,64]) {save({...base,concurrency:value}); assert.equal(loadConfig(file).concurrency,value);}
  for(const value of [0,65,2.5]) {save({...base,concurrency:value}); assert.throws(()=>loadConfig(file));}
  save(base);
  assert.equal(config.codex.directories?.[0], realpathSync(join(root, 'project')));
  assert.equal(config.codex.networkAccess, true);
  assert.equal(config.codex.allowLocalCommits, true);
  assert.ok(config.codex.denyPaths?.includes(file));
  assert.ok(config.codex.denyPaths?.includes(join(root, 'data')));
  save({codex:{...base.codex,directories:['/missing']}});assert.throws(()=>loadConfig(file));
  save({ codex: { ...base.codex, directories: [homedir()] } }); assert.throws(() => loadConfig(file));
  save({ codex: { ...base.codex, directories: ['/'] } }); assert.throws(() => loadConfig(file));
  save({ codex: { ...base.codex, networkAccess: 'true' } }); assert.throws(() => loadConfig(file));
  save({ codex: { ...base.codex, allowLocalCommits: 'true' } }); assert.throws(() => loadConfig(file));
  save({ codex: { ...base.codex, allowLocalCommits: true, sandbox: 'read-only' } }); assert.throws(() => loadConfig(file));
  save({ codex: { ...base.codex, allowLocalCommits: true } }); assert.equal(loadConfig(file).codex.allowLocalCommits, true);
});

test('git approval configuration defaults closed and validates explicit targets without exposing credentials', t => {
  const root = mkdtempSync(join(tmpdir(), 'namo-approval-config-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'config.json'); const save = (value: unknown) => writeFileSync(file, JSON.stringify(value));
  save({}); assert.deepEqual(loadConfig(file).gitApprovals, { gitBin: undefined, sshCommand: undefined, maxTtlMs: 900000, remotes: [] });
  save({ gitApprovals: { gitBin: '/usr/bin/git', maxTtlMs: 60000, remotes: [{ name: 'origin', url: 'https://example.invalid/org/repo.git', transport: 'https', credentialHelpers: ['osxkeychain'] }] } });
  const configured = loadConfig(file).gitApprovals!; assert.equal(configured.gitBin, '/usr/bin/git'); assert.equal(configured.remotes.length, 1); assert.deepEqual(configured.remotes[0]?.credentialHelpers, ['osxkeychain']);
  save({ gitApprovals: { remotes: [{ name: 'origin', url: 'x', transport: 'ext' }] } }); assert.throws(() => loadConfig(file), /remote/);
  save({ gitApprovals: { remotes: [{ name: 'origin', url: 'x', transport: 'https' }, { name: 'origin', url: 'y', transport: 'https' }] } }); assert.throws(() => loadConfig(file), /unique/);
  save({ gitApprovals: { maxTtlMs: 999 } }); assert.throws(() => loadConfig(file), /maxTtlMs/);
});

test('network access defaults on but an explicit restriction remains effective',t=>{
 const root=mkdtempSync(join(tmpdir(),'namo-network-default-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const file=join(root,'config.json');
 writeFileSync(file,JSON.stringify({codex:{directories:[]}}));assert.equal(loadConfig(file).codex.networkAccess,true);
 writeFileSync(file,JSON.stringify({codex:{directories:[],networkAccess:false}}));assert.equal(loadConfig(file).codex.networkAccess,false);
});
