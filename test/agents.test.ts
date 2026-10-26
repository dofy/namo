import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findExecutable,probeAgent } from '../src/agents.js';
import { initialConfig } from '../src/onboarding.js';
import { atomicJson } from '../src/paths.js';
import { loadConfig } from '../src/config.js';
test('probe distinguishes missing binary, login and protocol permission compatibility without inference',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-agent-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'config.json'),raw=initialConfig(file);raw.codex.bin=join(dir,'missing');atomicJson(file,raw);
 assert.equal(findExecutable(raw.codex.bin),undefined);assert.equal((await probeAgent(loadConfig(file)))[0].status,'fail');
 const bin=join(dir,'agent.mjs');raw.codex.bin=bin;writeFileSync(bin,`#!/usr/bin/env node
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='permissionProfile/list')result={data:[{id:'feishu-bot',allowed:true}]};if(m.method==='turn/start')process.exit(98);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')});`,{mode:0o700});atomicJson(file,raw);
 assert.equal((await probeAgent(loadConfig(file))).some(x=>x.id==='agent.auth'&&x.status==='fail'),true);
 mkdirSync(raw.codex.home,{recursive:true});
 const valid=await probeAgent(loadConfig(file));assert.equal(valid.some(x=>x.id==='agent.protocol'&&x.status==='ok'),true);assert.equal(valid.some(x=>x.id==='agent.auth'&&x.status==='ok'),true);
 writeFileSync(bin,readDenied(),{mode:0o700});assert.equal((await probeAgent(loadConfig(file))).some(x=>x.id==='agent.protocol'&&x.status==='fail'),true);
});
function readDenied(){return `#!/usr/bin/env node
import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='permissionProfile/list'?{data:[{id:'feishu-bot',allowed:false}]}:m.method==='account/read'?{account:{}}:{}})+'\\n')});`}
