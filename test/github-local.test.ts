import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localGhEnvironment,localGhToken,executeGh,parseLocalGh,type LocalGhConfig} from '../src/github-local.js';
const config:LocalGhConfig={executable:'/usr/local/bin/gh',configDir:'/tmp/isolated-gh',login:'alice',userId:12};

test('local gh pins its executable, config directory and account without ambient token/debug/proxy overrides',async()=>{
  const env=localGhEnvironment(config);
  for(const key of ['GH_TOKEN','GITHUB_TOKEN','GH_DEBUG','HTTPS_PROXY','NODE_OPTIONS','GIT_CONFIG','XDG_CONFIG_HOME'])assert.equal(env[key],undefined);
  assert.equal(env.GH_CONFIG_DIR,config.configDir);assert.equal(env.GH_HOST,'github.com');
  const result=await localGhToken(config,Date.now()+5000,async(c,args)=>{
    assert.deepEqual(c,config);assert.deepEqual(args,['auth','token','--hostname','github.com','--user','alice']);return ' synthetic-credential\n';
  });assert.equal(result,'synthetic-credential');
  for(const patch of [{executable:'gh'},{configDir:'relative'},{login:'--evil'},{userId:0},{extra:'value'}])assert.throws(()=>parseLocalGh({...config,...patch}));
});

test('gh process failures, excessive output and timeout never expose captured output or child errors',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'namo-gh-exec-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const executable=join(dir,'gh');
  writeFileSync(executable,'#!/bin/sh\necho DO_NOT_LEAK\necho DO_NOT_LEAK >&2\nexit 1\n',{mode:0o700});
  await assert.rejects(executeGh({...config,executable},[],Date.now()+2000),e=>{assert.equal(String(e),'LocalGhError: github_local_unavailable');return true;});
  writeFileSync(executable,'#!/bin/sh\nexec /bin/sleep 2\n',{mode:0o700});
  await assert.rejects(executeGh({...config,executable},[],Date.now()+50),/github_local_unavailable/);
  await assert.rejects(executeGh(config,[],Date.now()-1),/github_local_timeout/);
  await assert.rejects(localGhToken(config,Date.now()+2000,async()=> 'one\ntwo'),/github_local_unavailable/);
});
