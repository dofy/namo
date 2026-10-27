import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initialConfig } from '../src/onboarding.js';
import { loadConfig } from '../src/config.js';
import { atomicJson } from '../src/paths.js';
import { renderLaunchAgent } from '../src/service.js';
const bin=resolve('bin/namo.js');
test('CLI help/version need no config; removed commands guide users to the UI and piped init fails clearly',t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const run=(...a:string[])=>spawnSync(process.execPath,[bin,...a],{cwd:dir,encoding:'utf8',env:{...process.env,NAMO_HOME:dir,NAMO_LANG:'system',LC_ALL:'en_US.UTF-8'}});
 assert.equal(run('--help').status,0);assert.match(run('--version').stdout,/0\.1\.0/);
 for(const command of ['doctor','check','status','logs','config','agent','issues','issue','resolve','access','github','approval']) {const result=run(command);assert.equal(result.status,1);assert.match(result.stderr,/namo ui/);}
 assert.match(run('migrate').stderr,/namo init --import/);
 assert.match(run('init','--import').stderr,/interactive (?:local )?terminal/);
 assert.match(run('service','status').stderr,/namo ui/);
 assert.match(run('service').stderr,/install.*uninstall/);
 assert.equal(run('ui','--import').status,1);
 assert.equal(run('login','extra').status,1);
 const init=run('init');assert.equal(init.status,1);assert.match(init.stderr,/interactive (?:local )?terminal/);
 assert.match(run('init','--lang','zh-CN').stderr,/交互终端/);
 assert.equal(run('agent','test').status,1);
 assert.match(run('--config',join(dir,'other.json'),'ui').stderr,/No configuration/);
 assert.equal(run('doctor','--unknown').status,1);
});
test('service render uses explicit installed entry and private config references without secrets',t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-service-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'config.json');const raw=initialConfig(file);raw.feishu.appSecret='SECRET_MUST_NOT_APPEAR';atomicJson(file,raw);
 const xml=renderLaunchAgent(loadConfig(file),'io.namo.0123456789ab','/installed/namo/bin.js','/stable/node','/tools/a&b');
 assert.ok(xml.includes('/installed/namo/bin.js'));assert.ok(xml.includes('/tools/a&amp;b'));assert.ok(!xml.includes(raw.feishu.appSecret));assert.ok(xml.includes(file));
});

test('status recognizes a foreground instance but needs matching health to report ready',async t=>{
 const {serviceStatus}=await import('../src/service.js');const {acquireLock}=await import('../src/safety.js');
 const dir=mkdtempSync(join(tmpdir(),'namo-foreground-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'config.json');atomicJson(file,initialConfig(file));const c=loadConfig(file);const release=acquireLock(c.dataDir);
 try{
  assert.equal(serviceStatus(c).running,true);assert.equal(serviceStatus(c).ready,false);
  atomicJson(join(c.dataDir,'health.json'),{pid:process.pid,connection:'connected',ready:true});
  assert.equal(serviceStatus(c).ready,true);
  atomicJson(join(c.dataDir,'health.json'),{pid:process.pid+100000,connection:'connected',ready:true});assert.equal(serviceStatus(c).ready,false);
 }finally{release()}
});
