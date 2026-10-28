import { storeFixture } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { Feedback, recordActivity, progressState } from '../src/feedback.js';
import { richPost, splitDisplay, fenceState } from '../src/richtext.js';
import { recordProgress, readProgress, type PublicProgressEvent } from '../src/public-progress.js';
import { makeRedactor } from '../src/safety.js';

function fixture(t:{after(fn:()=>void):void}){const { dir, store } = storeFixture(t, 'namo-feedback-');
  store.enqueue({key:'m',messageId:'om_original',chatId:'chat',chatKey:'app:chat',senderId:'owner',text:'work',envelope:{version:1,type:'text',kind:'instruction',scopeKey:'app:chat:thread:t',threadId:'t',materials:[],limitations:[]}});
  const tasks=new Tasks(store),task=tasks.create(store.get('m')!,{cwd:dir,policyHash:'policy'});return {store,tasks,task};}

test('feedback starts after durable acceptance, deduplicates and removes after completion',async t=>{
  const f=fixture(t);let adds=0,removes=0;
  const feedback=new Feedback(f.store,{async send(){return 'sent';},async react(id){assert.equal(id,'om_original');assert.ok(f.store.get('m'));adds++;return 'reaction';},async unreact(id,reaction){assert.equal(reaction,'reaction');assert.equal(id,'om_original');removes++;}});
  feedback.accepted('m');feedback.accepted('m');await feedback.tick();await feedback.tick();assert.equal(adds,1);
  f.store.db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(f.task.id);await feedback.tick();await feedback.tick();assert.equal(removes,1);
});
test('fast completion suppresses pending feedback; uncertain reaction is never repeated',async t=>{
  const f=fixture(t);let adds=0;const feedback=new Feedback(f.store,{async send(){return 'sent';},async react(){adds++;throw new Error('timeout');}});
  feedback.accepted('m');await feedback.tick();await feedback.tick();assert.equal(adds,1);assert.equal(f.store.db.prepare('SELECT state FROM message_feedback').get()?.state,'unknown');
  f.store.db.prepare("UPDATE message_feedback SET state='pending'").run();f.store.db.prepare("UPDATE tasks SET state='succeeded'").run();await feedback.tick();assert.equal(adds,1);assert.equal(f.store.db.prepare('SELECT state FROM message_feedback').get()?.state,'suppressed');
});
test('one progress card is updated from real activity and terminal state fences later updates',async t=>{
  const f=fixture(t),run=f.tasks.start(f.task);recordActivity(f.store,run,'command');
  f.store.addOutput('m','progress','started');const row=f.store.nextOutput()!;f.store.sending(row.id);f.store.sent(row.id,'card-id');f.store.db.prepare('UPDATE outbox SET payload=? WHERE id=?').run(JSON.stringify({elements:[]}),row.id);
  const cards:object[]=[];const feedback=new Feedback(f.store,{async send(){throw new Error('never create');},async updateCard(id,card){assert.equal(id,'card-id');cards.push(card);}});
  await feedback.tick({cadenceMs:0,heartbeatMs:0});assert.match(JSON.stringify(cards[0]),/正在运行命令/);
  const before=progressState(f.store,f.tasks.get(f.task.id)!);assert.equal(before.phase,'command');
  f.store.db.prepare("UPDATE tasks SET state='succeeded',finishedAt=? WHERE id=?").run(Date.now(),f.task.id);await feedback.tick({cadenceMs:0});await feedback.tick({cadenceMs:0});assert.equal(cards.length,2);assert.match(JSON.stringify(cards[1]),/处理结束/);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='progress'").get()?.n,1);
});
test('reply routing and original answer survive chunking; Markdown cannot produce mentions or images',t=>{
  const f=fixture(t),answer='**bold** [safe](https://example.com) <at user_id="all">all</at> ![remote](https://example.com/p.png) [unsafe](javascript:alert)\n```ts\n'+ 'x'.repeat(4500)+'\n```';
  f.store.addOutput('m','result',answer);const rows=f.store.db.prepare('SELECT content,route FROM outbox ORDER BY part').all();assert.equal(rows.map(row=>row.content).join(''),answer);
  for(const row of rows)assert.deepEqual(JSON.parse(String(row.route)),{messageId:'om_original',thread:true});
  assert.equal(f.store.db.prepare('SELECT content FROM output_sources').get()?.content,answer);
  let prefix='';for(const chunk of splitDisplay(answer)){const payload=JSON.stringify(richPost(chunk,fenceState(prefix)));assert.ok(Buffer.byteLength(payload)<12000);assert.doesNotMatch(payload,/<at|javascript:|!\[remote\]/);prefix+=chunk;}
});

test('an in-flight working update is corrected before a terminal fence releases',async t=>{
  const f=fixture(t),run=f.tasks.start(f.task);recordActivity(f.store,run,'command');
  f.store.addOutput('m','progress','working');const output=f.store.nextOutput()!;f.store.sending(output.id);f.store.sent(output.id,'card');f.store.db.prepare('UPDATE outbox SET payload=? WHERE id=?').run(JSON.stringify({elements:[]}),output.id);
  let release:()=>void=()=>{};const cards:object[]=[];
  const feedback=new Feedback(f.store,{async send(){return 'sent';},async updateCard(_id,card){cards.push(card);if(cards.length===1)await new Promise<void>(resolve=>{release=resolve;});}});
  const active=feedback.tick({cadenceMs:0});await new Promise(resolve=>setImmediate(resolve));
  f.store.db.prepare("UPDATE tasks SET state='succeeded',finishedAt=? WHERE id=?").run(Date.now(),f.task.id);
  let fenced=false;const final=feedback.finalize(f.task.id).then(()=>{fenced=true;});assert.equal(fenced,false);release();await active;await final;
  assert.equal(cards.length,2);assert.match(JSON.stringify(cards.at(-1)),/处理结束/);assert.equal(fenced,true);
});

test('empty result retains its raw source and still reaches a terminal delivery state',t=>{
  const f=fixture(t);f.store.claim('m');f.store.finish('m','');const output=f.store.nextOutput()!;assert.ok(output.content);
  f.store.sending(output.id);f.store.sent(output.id,'empty-result');assert.equal(f.store.get('m')?.state,'replied');assert.equal(f.store.db.prepare('SELECT content FROM output_sources').get()?.content,'');
});

function sentProgress(f:ReturnType<typeof fixture>){
  f.store.addOutput('m','progress','working');const output=f.store.nextOutput()!;
  f.store.sending(output.id);f.store.sent(output.id,'card');
  f.store.db.prepare('UPDATE outbox SET payload=? WHERE id=?').run(JSON.stringify({elements:[]}),output.id);
  return output.id;
}

test('completed progress cards leave the polling set and stay retired after reopening', async t => {
  const f = fixture(t); f.tasks.start(f.task); sentProgress(f);
  f.store.db.prepare("UPDATE tasks SET state='succeeded',finishedAt=? WHERE id=?").run(Date.now(), f.task.id);
  let checks = 0, updates = 0;
  const sender = { async send() { return 'unused'; }, async updateCard() { updates++; } };
  const authorized = () => { checks++; return true; };
  await new Feedback(f.store, sender, authorized).tick();
  assert.equal(updates, 1); checks = 0;
  const restarted = new Feedback(f.store, sender, authorized); restarted.recover();
  await restarted.tick(); await restarted.tick();
  assert.equal(checks, 0); assert.equal(updates, 1);
});

test('same-phase tool content updates at cadence while unchanged activity waits for heartbeat',async t=>{
  let now=1_800_000_000_000;t.mock.method(Date,'now',()=>now);
  const f=fixture(t),run=f.tasks.start(f.task);recordActivity(f.store,run,'command');sentProgress(f);
  const cards:object[]=[];const feedback=new Feedback(f.store,{async send(){return 'unused';},async updateCard(_id,card){cards.push(card);}});
  recordProgress(f.store,run,{id:'one',kind:'tool',status:'running',text:'pnpm test：执行中'});
  now+=5000;await feedback.tick();assert.equal(cards.length,1);assert.match(JSON.stringify(cards[0]),/pnpm test/);
  recordProgress(f.store,run,{id:'two',kind:'tool',status:'running',text:'pnpm lint：执行中'});
  now+=4999;await feedback.tick();assert.equal(cards.length,1);
  now++;await feedback.tick();assert.equal(cards.length,2);assert.match(JSON.stringify(cards[1]),/pnpm lint/);
  now+=29_999;await feedback.tick();assert.equal(cards.length,2);
  now++;await feedback.tick();assert.equal(cards.length,3);assert.match(JSON.stringify(cards[2]),/暂无新的公开进展/);
});

test('a slow reaction cannot hold the progress writer or terminal update behind it',async t=>{
  const f=fixture(t),run=f.tasks.start(f.task);recordActivity(f.store,run,'working');sentProgress(f);
  let release:()=>void=()=>{};const cards:object[]=[];
  const feedback=new Feedback(f.store,{async send(){return 'unused';},async react(){await new Promise<void>(resolve=>{release=resolve;});return 'reaction';},async updateCard(_id,card){cards.push(card);}});
  feedback.accepted('m');const slow=feedback.tick({cadenceMs:0});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(cards.length,1);
  f.store.db.prepare("UPDATE tasks SET state='succeeded',finishedAt=? WHERE id=?").run(Date.now(),f.task.id);
  await feedback.finalize(f.task.id);assert.equal(cards.length,2);assert.match(JSON.stringify(cards[1]),/处理结束/);
  release();await slow;
});

test('terminal changes bypass ordinary cadence and never return to an execution phase',async t=>{
  const f=fixture(t),run=f.tasks.start(f.task);recordActivity(f.store,run,'command');sentProgress(f);
  const cards:object[]=[];const feedback=new Feedback(f.store,{async send(){return 'unused';},async updateCard(_id,card){cards.push(card);}});
  await feedback.tick({cadenceMs:0});assert.equal(cards.length,1);
  f.store.db.prepare("UPDATE tasks SET state='failed',finishedAt=? WHERE id=?").run(Date.now(),f.task.id);
  await feedback.tick();assert.equal(cards.length,2);assert.match(JSON.stringify(cards[1]),/执行失败/);
  recordActivity(f.store,run,'tool');await feedback.tick();assert.equal(cards.length,2);
});

test('an uncertain patch is reconciled once and never blindly retried after recovery',async t=>{
  const f=fixture(t),run=f.tasks.start(f.task);recordActivity(f.store,run,'command');sentProgress(f);
  let updates=0,reads=0;
  const sender={async send(){return 'unused';},async updateCard(){updates++;throw new Error('timeout');},async readCard(){reads++;return 'different card';}};
  const feedback=new Feedback(f.store,sender);await feedback.tick({cadenceMs:0});
  assert.equal(f.store.db.prepare('SELECT state FROM progress_updates').get()?.state,'unknown');
  const recovered=new Feedback(f.store,sender);recovered.recover();
  await recovered.tick({cadenceMs:0});await recovered.tick({cadenceMs:0});
  f.store.db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(f.task.id);await recovered.finalize(f.task.id);
  assert.equal(updates,1);assert.equal(reads,1);
  assert.equal(f.store.db.prepare('SELECT state,checked FROM progress_updates').get()?.checked,1);
});

test('runner receipts and stale heartbeats never claim normal execution after it has ended or become uncertain',t=>{
  const f=fixture(t),run=f.tasks.start(f.task);recordActivity(f.store,run,'command');
  f.store.db.prepare(`INSERT INTO runner_jobs(runId,owner,state,createdAt,updatedAt,configRevision,prompt)
    VALUES(?,?,'lost',?,?,?,?)`).run(run,'worker',Date.now()-60_000,Date.now()-60_000,'revision','private prompt');
  for(const [worker,phase] of [['lost','lost'],['completed','finishing'],['failed','execution_failed']] as const){
    f.store.db.prepare('UPDATE runner_jobs SET state=? WHERE runId=?').run(worker,run);
    const state=progressState(f.store,f.tasks.get(f.task.id)!);
    assert.equal(state.phase,phase);assert.doesNotMatch(state.content,/仍在运行|private prompt/);
  }
  f.store.db.prepare("UPDATE runner_jobs SET state='running' WHERE runId=?").run(run);
  const state=progressState(f.store,f.tasks.get(f.task.id)!,Date.now()+60_000);
  assert.match(state.content,/执行状态待核对/);assert.doesNotMatch(state.content,/仍在运行/);
});

test('revoked task access suppresses cached and new progress card updates',async t=>{
  const f=fixture(t),run=f.tasks.start(f.task);sentProgress(f);
  let allowed=true,updates=0;
  const feedback=new Feedback(f.store,{async send(){return 'unused';},async updateCard(){updates++;}},()=>allowed);
  recordProgress(f.store,run,{id:'first',kind:'commentary',status:'completed',text:'Authorized progress'});
  await feedback.tick({cadenceMs:0});assert.equal(updates,1);
  allowed=false;recordProgress(f.store,run,{id:'second',kind:'commentary',status:'completed',text:'Private finding'});
  await feedback.tick({cadenceMs:0});
  f.store.db.prepare("UPDATE tasks SET state='succeeded',finishedAt=? WHERE id=?").run(Date.now(),f.task.id);
  await feedback.finalize(f.task.id);assert.equal(updates,1);
});

function publicProgressFixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-public-progress-')), database = join(dir, 'db');
  let store = new Store(database);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.enqueue({ key: 'm', messageId: 'original', chatId: 'chat', chatKey: 'app:chat', senderId: 'owner', text: 'work' });
  const tasks = new Tasks(store), task = tasks.create(store.get('m')!, { cwd: dir, policyHash: 'policy' });
  const run = tasks.start(task); tasks.saveRun(run, 'thread', 'turn');
  return { store, tasks, task, run, reopen() { store.close(); store = new Store(database); return store; } };
}
const event = (id: string, text: string, status: PublicProgressEvent['status'] = 'completed'): PublicProgressEvent =>
  ({ id, kind: 'tool', text, status, threadId: 'thread', turnId: 'turn' });

test('bounded public progress survives reopening and deduplicates completed tools and late starts', t => {
  const f = publicProgressFixture(t);
  for (let i = 0; i < 270; i++) recordProgress(f.store, f.run, event('tool-' + i, '已完成命令 ' + i));
  const before = readProgress(f.store, f.run)!;
  assert.equal(before.revision, 270); assert.equal(before.events.length, 5); assert.equal(before.seen.length, 256);
  assert.deepEqual(before.events.map(e => e.sequence), [266, 267, 268, 269, 270]);
  assert.ok(before.events.every(e => e.id.length === 24 && !e.id.includes('tool-')));
  const reopened = f.reopen(); assert.deepEqual(readProgress(reopened, f.run), before);
  recordProgress(reopened, f.run, event('tool-269', '已完成命令 269'));
  recordProgress(reopened, f.run, event('tool-269', '旧的开始事件', 'running'));
  assert.equal(readProgress(reopened, f.run)!.revision, 270);
  recordProgress(reopened, f.run, event('tool-269', '已完成命令 269，退出码 0'));
  assert.equal(readProgress(reopened, f.run)!.revision, 271);
  assert.equal(readProgress(reopened, f.run)!.events.length, 5);
});

test('public progress rejects foreign turns, obsolete runs and terminal tasks', t => {
  const f = publicProgressFixture(t), input = event('safe', '可公开的摘要');
  recordProgress(f.store, f.run, { ...input, threadId: 'foreign' });
  recordProgress(f.store, f.run, { ...input, turnId: 'old-turn' });
  recordProgress(f.store, 'missing-run', input); assert.equal(readProgress(f.store, f.run), undefined);
  f.store.db.prepare("INSERT INTO task_runs(id,taskId,inputVersion,state,threadId,turnId,startedAt) VALUES(?,?,1,'running','thread','turn',?)")
    .run('newer-run', f.task.id, Date.now());
  recordProgress(f.store, f.run, input); assert.equal(readProgress(f.store, f.run), undefined);
  recordProgress(f.store, 'newer-run', input); assert.equal(readProgress(f.store, 'newer-run')!.revision, 1);
  f.store.db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(f.task.id);
  recordProgress(f.store, 'newer-run', { ...input, id: 'late' }); assert.equal(readProgress(f.store, 'newer-run')!.revision, 1);
});

test('public projection removes configured secrets, URLs, local paths, code, markup and controls before storing', t => {
  const f = publicProgressFixture(t), secret = 'private-configured-token';
  recordProgress(f.store, f.run, { ...event('unsafe', ''), kind: 'commentary', text:
    `检查 ${secret} ghp_12345678901234567890 https://example.test/private /Users/seven/private ./local/file C:\\private\\file <at user_id="all">所有人</at> \u202e\n\`\`\`sh\nPRIVATE_CODE\n\`\`\` \`PRIVATE_INLINE_COMMAND --arg\` 结束` }, makeRedactor([secret]));
  const report = readProgress(f.store, f.run)!, raw = JSON.stringify(report);
  assert.doesNotMatch(raw, /private-configured-token|ghp_|example\.test|Users|local\/file|private\\\\file|<at|PRIVATE_CODE|PRIVATE_INLINE_COMMAND|\u202e/);
  assert.match(report.events[0].text, /REDACTED/); assert.match(report.events[0].text, /链接已省略/);
  assert.match(report.events[0].text, /路径已省略/); assert.match(report.events[0].text, /代码已省略/);
  recordProgress(f.store, f.run, { ...event('truncated-inline', '正在检查 `PRIVATE_UNCLOSED_COMMAND --argument'), kind: 'commentary' });
  assert.doesNotMatch(JSON.stringify(readProgress(f.store, f.run)), /PRIVATE_UNCLOSED_COMMAND|--argument/);
  recordProgress(f.store, f.run, { ...event('bounded', '船'.repeat(500)), kind: 'commentary' });
  assert.equal(Array.from(readProgress(f.store, f.run)!.events.at(-1)!.text).length, 180);
});

test('plan fractions and revisions stay readable, including replanning after completion', t => {
  const f = publicProgressFixture(t), plan: PublicProgressEvent = { ...event('plan', '计划：已完成 1/2 项', 'running'), kind: 'plan' };
  recordProgress(f.store, f.run, plan); recordProgress(f.store, f.run, plan);
  assert.equal(readProgress(f.store, f.run)!.revision, 1);
  assert.equal(readProgress(f.store, f.run)!.events[0].text, '计划：已完成 1/2 项');
  recordProgress(f.store, f.run, { ...plan, text: '计划：已完成 2/2 项', status: 'completed' });
  recordProgress(f.store, f.run, { ...plan, text: '计划：已完成 2/3 项' });
  const report = readProgress(f.store, f.run)!;
  assert.equal(report.revision, 3); assert.equal(report.events.length, 1);
  assert.equal(report.events[0].text, '计划：已完成 2/3 项'); assert.equal(report.events[0].status, 'running');
});
