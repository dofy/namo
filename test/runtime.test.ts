import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRuntime, RuntimeError } from '../src/runtime.js';
import type { EvidenceItem } from '../src/ui-contract.js';

const FAKE = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const write = m => process.stdout.write(JSON.stringify(m)+'\\n');
createInterface({input:process.stdin}).on('line', line=>{
 const m=JSON.parse(line);
 if(!m.method || m.id===undefined)return;
 if(m.method==='initialize')return write({id:m.id,result:{}});
 if(m.method==='thread/start'||m.method==='thread/resume')return write({id:m.id,result:{thread:{id:m.params.threadId||'thread-one'}}});
 if(m.method==='turn/steer'){
  if(m.params.expectedTurnId!=='turn-one')return write({id:m.id,error:{code:-32602,message:'wrong turn'}});
  if(m.params.input[0].text==='reject')return write({id:m.id,error:{code:-32600,message:'rejected'}});
  write({id:m.id,result:{turnId:'turn-one'}});
  return write({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'turn-one',status:'completed',items:[{id:'final',type:'agentMessage',phase:'final_answer',text:'steered answer'}]}}});
 }
 if(m.method==='turn/start'){
  if(m.params.sandboxPolicy || m.params.permissions!=='feishu-bot')return write({id:m.id,error:{code:-32600,message:'legacy permissions rejected'}});
  const prompt=m.params.input[0].text;
  if(prompt==='image-input' && (m.params.input.length!==2 || m.params.input[1].type!=='localImage' || !m.params.input[1].path.endsWith('/accepted.png')))
   return write({id:m.id,error:{code:-32602,message:'image input missing'}});
  if(prompt==='hang')return write({id:m.id,result:{turn:{id:'turn-one'}}});
  if(prompt==='disconnect')return process.exit(1);
  const threadId=m.params.threadId;
  if(prompt==='evidence'||prompt==='evidence-fail'){
   const command={id:'cmd',type:'commandExecution',command:'pnpm test --password PRIVATE_ARGUMENT',cwd:process.cwd(),status:'inProgress',aggregatedOutput:'PRIVATE_OUTPUT'};
   write({method:'item/completed',params:{threadId,turnId:'old-turn',item:{...command,id:'stale'}}});
   write({method:'turn/completed',params:{threadId,turn:{id:'old-turn',status:'completed',items:[{id:'old',type:'agentMessage',text:'WRONG_ANSWER'}]}}});
   write({method:'item/started',params:{threadId,turnId:'turn-one',item:command}});
   write({method:'item/completed',params:{threadId:'another-thread',turnId:'turn-one',item:{...command,id:'foreign'}}});
   write({method:'item/completed',params:{threadId,turnId:'turn-one',item:{...command,status:'completed',exitCode:1,durationMs:14}}});
   write({method:'turn/completed',params:{threadId,turn:{id:'turn-one',status:prompt==='evidence-fail'?'failed':'completed',items:[{id:'final',type:'agentMessage',phase:'final_answer',text:'answer'}]}}});
   return write({id:m.id,result:{turn:{id:'turn-one'}}});
  }
  write({method:'item/completed',params:{threadId,turnId:'turn-one',item:{id:'comment',type:'agentMessage',phase:'commentary',text:'private progress'}}});
  const item={id:'final',type:'agentMessage',phase:'final_answer',text:'public answer'};
  write({method:'item/completed',params:{threadId,turnId:'turn-one',item}});
  write({method:'turn/completed',params:{threadId,turn:{id:'turn-one',status:prompt==='fail'?'failed':'completed',items:[]}}});
  return write({id:m.id,result:{turn:{id:'turn-one'}}});
 }
});
`;

function fixture(t: { after: (fn: () => void) => void }, timeoutMs = 1000) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-rpc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'codex.mjs'); writeFileSync(bin, FAKE, { mode: 0o700 });
  return { dir, runtime: new CodexRuntime({ bin, home: join(dir, 'home'), timeoutMs, sandbox: 'read-only' }) };
}

test('actual subprocess framing handles completion-before-response and excludes commentary', async t => {
  const { dir, runtime } = fixture(t);
  const threads: string[] = [];
  const result = await runtime.run({ cwd: dir, prompt: 'hello', signal: new AbortController().signal,
    onThread: id => threads.push(id), onTurn: () => {} });
  assert.equal(result.text, 'public answer'); assert.deepEqual(threads, ['thread-one']);
  const resumed = await runtime.run({ cwd: dir, prompt: 'hello', threadId: 'previous-thread', signal: new AbortController().signal,
    onThread: () => {}, onTurn: () => {} });
  assert.equal(resumed.threadId, 'previous-thread');
});

test('failed turn cannot pass as a successful response even if text was emitted', async t => {
  const { dir, runtime } = fixture(t);
  await assert.rejects(runtime.run({ cwd: dir, prompt: 'fail', signal: new AbortController().signal,
    onThread: () => {}, onTurn: () => {} }), (e: unknown) => e instanceof RuntimeError && e.code === 'turn_failed');
});

test('host-accepted images use official localImage input items alongside text',async t=>{
  const {dir,runtime}=fixture(t),path=join(dir,'accepted.png');
  const result=await runtime.run({cwd:dir,prompt:'image-input',images:[{id:'a'.repeat(64),path,sha256:'b'.repeat(64),mime:'image/png',width:1,height:1,bytes:1}],
    signal:new AbortController().signal,onThread(){},onTurn(){}});
  assert.equal(result.text,'public answer');
});

test('stream disconnect fails promptly and hanging turns obey the timeout', async t => {
  const { dir, runtime } = fixture(t, 100);
  await assert.rejects(runtime.run({ cwd: dir, prompt: 'disconnect', signal: new AbortController().signal,
    onThread: () => {}, onTurn: () => {} }), (e: unknown) => e instanceof RuntimeError && e.code === 'runtime_disconnected');
  await assert.rejects(runtime.run({ cwd: dir, prompt: 'hang', signal: new AbortController().signal,
    onThread: () => {}, onTurn: () => {} }), (e: unknown) => e instanceof RuntimeError && e.code === 'turn_timeout');
});

test('cancellation kills the owned subprocess and rejects the turn', async t => {
  const { dir, runtime } = fixture(t);
  const abort = new AbortController();
  await assert.rejects(runtime.run({ cwd: dir, prompt: 'hang', signal: abort.signal,
    onThread: () => {}, onTurn: () => abort.abort() }), (e: unknown) => e instanceof RuntimeError && e.code === 'cancelled');
});

test('running input uses turn/steer with an exact turn receipt and explicit rejection is distinguishable', async t => {
  const { dir, runtime } = fixture(t, 2000); const receipts: string[] = [];
  let steering: Promise<void> | undefined;
  const completed = await runtime.run({ cwd: dir, prompt: 'hang', signal: new AbortController().signal, onThread() {}, onTurn() {},
    onReady(controls) { steering = (async () => {
      receipts.push(await controls.steer('reject'));
      receipts.push(await controls.steer('追加要求'));
    })(); } });
  await steering; assert.deepEqual(receipts, ['rejected', 'accepted']); assert.equal(completed.text, 'steered answer');
});

test('a turn completed before readiness never sends a steer to the next turn', async t => {
  const { dir, runtime } = fixture(t); let receipt: Promise<string> | undefined;
  await runtime.run({ cwd: dir, prompt: 'hello', signal: new AbortController().signal, onThread() {}, onTurn() {},
    onReady(controls) { receipt = controls.steer('late amendment'); } });
  assert.equal(await receipt, 'not_active');
});

test('evidence before turn/start response is scoped to the acknowledged turn and strips output and arguments', async t => {
  const { dir, runtime } = fixture(t), events: EvidenceItem[] = [];
  const result = await runtime.run({ cwd: dir, prompt: 'evidence', signal: new AbortController().signal,
    onThread() {}, onTurn() {}, onEvidence: e => events.push(e) });
  assert.equal(result.text, 'answer'); assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => e.status), ['running', 'completed']);
  assert.equal(events[1].exitCode, 1); assert.equal(events[1].label, 'pnpm test');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|stale|foreign|WRONG/);
});

test('failed turns retain observed operations and evidence storage failure stops the owned runtime', async t => {
  const { dir, runtime } = fixture(t), events: EvidenceItem[] = [];
  await assert.rejects(runtime.run({ cwd: dir, prompt: 'evidence-fail', signal: new AbortController().signal,
    onThread() {}, onTurn() {}, onEvidence: e => events.push(e) }),
  (e: unknown) => e instanceof RuntimeError && e.code === 'turn_failed');
  assert.equal(events.length, 2);
  await assert.rejects(runtime.run({ cwd: dir, prompt: 'evidence', signal: new AbortController().signal,
    onThread() {}, onTurn() {}, onEvidence() { throw new Error('PRIVATE_STORAGE_ERROR'); } }),
  (e: unknown) => e instanceof RuntimeError && e.code === 'evidence_storage_error');
});
