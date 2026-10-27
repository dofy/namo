import {spawn} from 'node:child_process';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ClaudeRuntime,type ClaudeRunRequest} from '../src/claude-runtime.js';
function fixture(t:{after(fn:()=>void):void}){
 const root=mkdtempSync(join(tmpdir(),'claude-runtime-')),cwd=join(root,'project'),bin=join(root,'claude.mjs');mkdirSync(cwd,{mode:0o700});t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(bin,`#!${process.execPath}
import {createInterface} from 'node:readline';import {writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';
const session='00000000-1111-4222-8333-444444444444';let prompt='';const out=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const result=()=>{out({type:'result',subtype:'success',is_error:false,result:prompt==='secret'?process.env.ANTHROPIC_API_KEY:'FIXTURE_OK',session_id:session,uuid:'result',usage:{},modelUsage:{}});setTimeout(()=>process.exit(0),30);};
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.type==='control_request'){out({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{commands:[],models:[],account:{}}}});return;}
 if(m.type==='control_response'){if(m.response?.response?.behavior==='allow')writeFileSync(process.cwd()+'/allowed.txt',prompt==='question'?JSON.stringify(m.response.response.updatedInput.answers):'OK');result();return;}
 if(m.type!=='user')return;prompt=typeof m.message?.content==='string'?m.message.content:Array.isArray(m.message?.content)?m.message.content.filter(b=>b.type==='text').map(b=>b.text).join(''):'';
 out({type:'system',subtype:'init',session_id:prompt==='wrong'?'00000000-1111-4222-8333-555555555555':session});
 if(prompt==='hang'){const child=spawn('/bin/sleep',['30']);writeFileSync(process.cwd()+'/descendant.pid',String(child.pid));setInterval(()=>{},1000);return;}
 if(prompt==='crash'){process.stderr.write('SECRET_FIXTURE_NEVER_FORWARD');process.exit(3);return;}
 if(prompt==='question'){out({type:'control_request',request_id:'question',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',tool_use_id:'question1',input:{questions:[{question:'Color?',options:[{label:'blue'},{label:'red'}]}]}}});return;}
 if(prompt==='permission'||prompt==='outside'){out({type:'control_request',request_id:'ask',request:{subtype:'can_use_tool',tool_name:'Edit',tool_use_id:'call1',input:{file_path:process.cwd()+(prompt==='outside'?'/../escape.txt':'/allowed.txt'),content:'OK'}}});return;}
 result();
});
`,{mode:0o700});
 const runtime=new ClaudeRuntime({bin,home:join(root,'home'),auth:{mode:'official-login'},validationRoot:root,timeoutMs:5000});
 const request=(prompt:string):ClaudeRunRequest=>({prompt,cwd,signal:new AbortController().signal,onThread(){},onTurn(){}});
 return {runtime,request,root,cwd};
}
test('SDK worker returns exact session, isolates profile environment and rejects unknown resume',async t=>{
 const f=fixture(t),first=await f.runtime.run(f.request('ok'));assert.equal(first.text,'FIXTURE_OK');assert.match(first.turnId,/^claude-run:/);
 const again=await f.runtime.run({...f.request('ok'),threadId:first.threadId});assert.equal(again.threadId,first.threadId);assert.notEqual(again.turnId,first.turnId);
 await assert.rejects(f.runtime.run({...f.request('ok'),threadId:'00000000-1111-4222-8333-777777777777'}),/session_mismatch/);
 await assert.rejects(f.runtime.run({...f.request('wrong'),threadId:first.threadId}),/session_mismatch/);
});
test('SDK permission decisions are per call, denied by default and cannot cross workspace',async t=>{
 const f=fixture(t);let called=0;
 await f.runtime.run({...f.request('permission'),onPermission:async p=>{called++;assert.equal(p.tool,'Edit');return true;}});
 assert.equal(called,1);assert.equal(readFileSync(join(f.cwd,'allowed.txt'),'utf8'),'OK');rmSync(join(f.cwd,'allowed.txt'));
 // A fresh query from the same fixture reuses its synthetic session ID.
 const id='00000000-1111-4222-8333-444444444444';
 await f.runtime.run({...f.request('permission'),threadId:id});assert.equal(existsSync(join(f.cwd,'allowed.txt')),false);
 await f.runtime.run({...f.request('outside'),threadId:id,onPermission:async()=>{called++;return true;}});assert.equal(called,1);
});
test('cancellation terminates the owned process group and does not return success',async t=>{
 const f=fixture(t),abort=new AbortController();let timer:NodeJS.Timeout|undefined;
 t.after(()=>clearTimeout(timer));
 const started=Date.now();await assert.rejects(f.runtime.run({...f.request('hang'),signal:abort.signal,onThread(){timer=setTimeout(()=>abort.abort(),150);}}),/cancelled/);
 assert.ok(Date.now()-started<4000);const pid=Number(readFileSync(join(f.cwd,'descendant.pid'),'utf8'));
 await new Promise(r=>setTimeout(r,100));assert.throws(()=>process.kill(pid,0));
});
test('worker errors are fixed codes and unsupported capabilities fail before spawning',async t=>{
 const f=fixture(t);await assert.rejects(f.runtime.run(f.request('crash')),e=>e instanceof Error&&!e.message.includes('SECRET_FIXTURE'));
 await assert.rejects(f.runtime.run({...f.request('ok'),cwd:tmpdir()}),/validation_workspace_required/);
 await assert.rejects(f.runtime.run({...f.request('ok'),onReview:async()=>({})}),/capability_unavailable/);
});


test('live question callback is distinct from durable wait and never returns persistent grants',async t=>{
 const f=fixture(t);let asked=0;
 await f.runtime.run({...f.request('question'),onQuestion:async p=>{asked++;assert.equal(p.tool,'AskUserQuestion');return {'Color?':'blue'};}});
 assert.equal(asked,1);assert.deepEqual(JSON.parse(readFileSync(join(f.cwd,'allowed.txt'),'utf8')),{'Color?':'blue'});
 await assert.rejects(f.runtime.run({...f.request('ok'),onWait:()=> 'wait'}),/durable_wait_unverified/);
});
test('credentials echoed by a model are redacted and parent callback errors fail closed',async t=>{
 const f=fixture(t),envFile=join(f.root,'credentials.env');writeFileSync(envFile,'ANTHROPIC_API_KEY="fixture-key-never-return"\n',{mode:0o600});
 const runtime=new ClaudeRuntime({...f.runtime.config,auth:{mode:'official-api-key',envFile}});
 const result=await runtime.run(f.request('secret'));assert.equal(result.text,'[redacted]');
 await assert.rejects(runtime.run({...f.request('ok'),onProcess(){throw new Error('private-callback-error');}}),/^Error: claude_callback_failed$/);
});


test('loss of the owning parent terminates the SDK worker group without replay',async t=>{
 const f=fixture(t),moduleUrl=new URL('../src/claude-runtime.js',import.meta.url).href;
 const code=`import {ClaudeRuntime} from ${JSON.stringify(moduleUrl)};const runtime=new ClaudeRuntime(${JSON.stringify(f.runtime.config)});await runtime.run({cwd:${JSON.stringify(f.cwd)},prompt:'hang',signal:new AbortController().signal,onThread(){},onTurn(){},onProcess(pid){console.log(pid);}});`;
 const parent=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','ignore']});let worker=0;
 parent.stdout.on('data',chunk=>{worker=Number(String(chunk).trim());});
 t.after(()=>{parent.kill('SIGKILL');if(worker)try{process.kill(-worker,'SIGKILL');}catch{}});
 for(let i=0;i<100&&!existsSync(join(f.cwd,'descendant.pid'));i++)await new Promise(r=>setTimeout(r,20));
 assert.ok(worker>0);const descendant=Number(readFileSync(join(f.cwd,'descendant.pid'),'utf8'));parent.kill('SIGKILL');
 await new Promise(r=>setTimeout(r,2400));assert.throws(()=>process.kill(descendant,0));
});


test('live validation command exits nonzero when results do not satisfy its assertions',async t=>{
 const f=fixture(t),script=new URL('../scripts/smoke-claude.js',import.meta.url);
 const child=spawn(process.execPath,[script.pathname,'--live','--auth','official-login','--bin',f.runtime.config.bin,'--tools-only'],{stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',chunk=>{output+=String(chunk);});child.stderr.resume();
 const status=await new Promise<number|null>((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
 assert.equal(status,2);const report=JSON.parse(output.trim());assert.equal(report.status,'incomplete');assert.ok(report.missingEvidence.includes('writeEffect'));
});
