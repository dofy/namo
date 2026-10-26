import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRuntime, RuntimeError } from '../src/runtime.js';

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
  if(prompt==='hang')return write({id:m.id,result:{turn:{id:'turn-one'}}});
  if(prompt==='disconnect')return process.exit(1);
  const threadId=m.params.threadId;
  write({method:'item/completed',params:{threadId,item:{id:'comment',type:'agentMessage',phase:'commentary',text:'private progress'}}});
  const item={id:'final',type:'agentMessage',phase:'final_answer',text:'public answer'};
  write({method:'item/completed',params:{threadId,item}});
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
