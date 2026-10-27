import { waitFor } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Incoming } from '../src/store.js';
import { Engine, SendError, type Sender } from '../src/engine.js';
import { Tasks, PROGRESS_DELAY_MS } from '../src/tasks.js';
import { RuntimeError, type Runtime, type RunRequest, type RunResult } from '../src/runtime.js';
import { evidenceBrief, taskStatus } from '../src/presentation.js';
import { readEvidence } from '../src/evidence.js';
import { parseConfig } from '../src/config.js';
import { Waits } from '../src/waits.js';
import { Cards, renderTaskCard } from '../src/cards.js';
import { Feedback } from '../src/feedback.js';
import { cardMarkdown, hasMarkdown, openFence, richPost, splitDisplay } from '../src/richtext.js';

const answer = { text: 'pong，在。', threadId: 'thread', turnId: 'turn' };
const message = (key: string, text = 'ping', senderId = 'alice'): Incoming => ({ key, messageId: key, chatKey: 'chat', chatId: 'chat', senderId, text });

function fixture(t: { after(f: () => Promise<void>): void }, runtime: Runtime = { async run() { return answer; } }, failProgress = false) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-presentation-')), store = new Store(join(dir, 'bot.sqlite'));
  const texts: string[] = [], cards: any[] = [], tasks = new Tasks(store);
  const engine = new Engine(store, runtime, {
    async send(_c, text, uuid) { texts.push(text); return uuid; },
    async sendCard(_c, card, uuid) { cards.push(card); if (failProgress && cards.length === 1) throw new SendError(true, 'timeout'); return uuid; },
  }, { dataDir: dir, concurrency: 1, feishu: { cards: true } });
  t.after(async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const age = (key: string) => store.db.prepare("UPDATE outbox SET createdAt=? WHERE inboxKey=? AND kind='progress'").run(Date.now() - PROGRESS_DELAY_MS - 1, key);
  return { store, tasks, engine, texts, cards, age };
}
function held() {
  let request: RunRequest | undefined, resolve: ((r: RunResult) => void) | undefined;
  const runtime: Runtime = { run(r) { request = r; return new Promise((yes, no) => { resolve = yes; r.signal.addEventListener('abort', () => no(new RuntimeError('cancelled')), { once: true }); }); } };
  return { runtime, started: () => !!request, finish: () => resolve!(answer) };
}

test('quick conversation sends one plain answer while retaining task and run records', async t => {
  const f = fixture(t); f.engine.start(); f.engine.accept(message('ping'));
  await waitFor(() => f.store.get('ping')?.state === 'replied');
  assert.deepEqual(f.texts, ['pong，在。']); assert.equal(f.cards.length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM tasks').get()?.n, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_runs').get()?.n, 1);
  assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE kind='progress'").get()?.state, 'suppressed');
  assert.equal(JSON.parse(String(f.store.db.prepare("SELECT payload FROM outbox WHERE kind='result'").get()?.payload)).noCard, true);
  assert.equal(f.engine.accept(message('ping')), false);
});

test('long task gets one compact progress card and completion does not resend it', async t => {
  const hold = held(), f = fixture(t, hold.runtime); f.engine.start(); f.engine.accept(message('slow'));
  await waitFor(hold.started); assert.equal(f.cards.length, 0);
  f.age('slow'); await f.engine.pump(); await waitFor(() => f.cards.length === 1);
  const visible = JSON.stringify(f.cards[0]);
  assert.match(visible, /正在处理/); assert.match(visible, /停止任务/);
  assert.doesNotMatch(visible, /N-[A-F0-9]{12}|W-[A-F0-9]{12}|输入版本|接收记录|\/amend/);
  hold.finish(); await waitFor(() => f.store.get('slow')?.state === 'replied');
  await f.engine.pump(); assert.equal(f.cards.length, 1); assert.deepEqual(f.texts, [answer.text]);
});

test('queued task reports waiting, and never-sent progress is suppressed on cancellation', async t => {
  const hold = held(), f = fixture(t, hold.runtime); f.engine.start(); f.engine.accept(message('active'));
  await waitFor(hold.started); f.engine.accept(message('queued')); f.age('queued');
  await f.engine.pump(); await waitFor(() => f.cards.some(card=>/排队中|正在排队/.test(JSON.stringify(card))));
  f.engine.accept(message('queued-two')); f.age('queued-two'); f.tasks.progress();
  const task = f.tasks.get(f.store.get('queued-two')!.taskId!)!;
  assert.equal(f.tasks.cancel(task), true);
  assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE inboxKey='queued-two' AND kind='progress'").get()?.state, 'suppressed');
  hold.finish();
  // The second task also enters the controllable runtime; cancel it during cleanup.
  await waitFor(() => f.store.get('active')?.state === 'replied');
});

test('completion suppresses a ready but unsent progress prompt before final delivery', async t => {
  const hold = held(), f = fixture(t, hold.runtime); f.engine.start(); f.engine.accept(message('race'));
  await waitFor(hold.started); f.age('race'); f.tasks.progress();
  assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE kind='progress'").get()?.state, 'pending');
  hold.finish(); await waitFor(() => f.store.get('race')?.state === 'replied');
  assert.equal(f.cards.length, 0); assert.deepEqual(f.texts, [answer.text]);
  assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE kind='progress'").get()?.state, 'suppressed');
});

test('unknown progress send remains unknown after completion and is not retried', async t => {
  const hold = held(), f = fixture(t, hold.runtime, true); f.engine.start(); f.engine.accept(message('unknown'));
  await waitFor(hold.started); f.age('unknown'); await f.engine.pump();
  await waitFor(() => f.store.db.prepare("SELECT state FROM outbox WHERE kind='progress'").get()?.state === 'unknown');
  hold.finish(); await waitFor(() => f.store.get('unknown')?.state === 'replied');
  assert.equal(f.cards.length, 1); assert.equal(f.texts.length, 1);
  assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE kind='progress'").get()?.state, 'unknown');
});

test('result card keeps the answer and actionable failures; details keep evidence without raw JSON', async t => {
  let runs = 0;
  const f = fixture(t, { async run(r) {
    runs++; r.onEvidence?.({ id: 'one', kind: 'command', label: 'pnpm test', status: 'completed', exitCode: 0 });
    r.onEvidence?.({ id: 'two', kind: 'command', label: 'node（参数未保存）', status: 'failed', exitCode: 7 });
    return { ...answer, text: '文件已处理。' };
  } });
  f.engine.start(); f.engine.accept(message('work')); await waitFor(() => f.store.get('work')?.state === 'replied');
  assert.equal(f.cards.length, 1); const card = JSON.stringify(f.cards[0]);
  assert.match(card, /文件已处理。/); assert.match(card, /1 项操作失败/);
  assert.doesNotMatch(card, /工作线|输入版本|退出码|N-[A-F0-9]{12}|检查通过/);
  const token = f.store.db.prepare("SELECT a.token,o.platformId FROM card_actions a JOIN outbox o ON o.id=a.outboxId WHERE a.action='details'").get()!;
  const event = { operator: { open_id: 'alice' }, context: { open_chat_id: 'chat', open_message_id: String(token.platformId) }, action: { value: { namo: String(token.token) } } };
  assert.equal(f.engine.acceptCard({ ...event, operator: { open_id: 'bob' } }).toast.type, 'error');
  assert.equal(f.engine.acceptCard(event).toast.type, 'info');
  await waitFor(() => f.texts.length > 0);
  assert.match(f.texts.join(''), /退出码 7/); assert.match(f.texts.join(''), /平台已接受，未确认是否已读/);
  assert.doesNotMatch(f.texts.join(''), /"runId"|"inputVersion"|"runners"|"owner"/);
  f.engine.acceptCard(event); assert.equal(runs, 1);
  const task = f.tasks.get(f.store.get('work')!.taskId!)!;
  assert.equal(readEvidence(f.store, task.id)[0].items[1].exitCode, 7);
});

test('status and latest-task commands are readable and preserve ownership', async t => {
  const f = fixture(t); f.engine.start(); f.engine.accept(message('owned')); await waitFor(() => f.store.get('owned')?.state === 'replied');
  const id = f.store.get('owned')!.taskId!;
  f.engine.accept(message('status', '/status')); f.engine.accept(message('latest', '/task'));
  f.engine.accept(message('denied', `/task ${id}`, 'bob'));
  await waitFor(() => f.store.get('denied')?.state === 'replied');
  assert.match(f.texts.join('\n'), /服务可用/); assert.match(f.texts.join('\n'), /未找到可访问/);
  const latest = f.store.db.prepare("SELECT content FROM outbox WHERE inboxKey='latest'").get()!;
  assert.match(String(latest.content), /已完成/); assert.doesNotMatch(String(latest.content), /workstream|inputVersion|"execution"/);
});

test('detail distinguishes mixed delivery states and empty evidence never invents validation', t => {
  const f = fixture(t); f.engine.accept(message('task')); const task = f.tasks.get(f.store.get('task')!.taskId!)!;
  f.tasks.start(task); f.store.addOutput(task.inboxKey, 'result', 'x'.repeat(2100));
  f.store.db.prepare("UPDATE outbox SET state='sent' WHERE kind='result' AND part=0").run();
  assert.match(taskStatus(f.store, task), /等待发送/);
  f.store.db.prepare("UPDATE outbox SET state='unknown' WHERE kind='result' AND part=1").run();
  assert.match(taskStatus(f.store, task), /发送结果不明/);
  assert.equal(evidenceBrief({ version: 1, runId: 'run', state: 'finished', truncated: false, items: [], git: { status: 'unchanged', before: 'same', after: 'same' } }), '');
});

test('latest task is scoped to its owner and topic even after many newer tasks elsewhere', t => {
  const f = fixture(t);
  const scoped = (key: string, scope: string, owner = 'alice') => ({ ...message(key, 'task', owner),
    envelope: { version: 1 as const, type: 'text', kind: 'instruction' as const, scopeKey: scope, materials: [], limitations: [] } });
  f.engine.accept(scoped('original', 'topic-one'));
  for (let n = 0; n < 11; n++) f.engine.accept(scoped(`other-${n}`, 'topic-two'));
  f.engine.accept(scoped('other-owner', 'topic-one', 'bob'));
  f.engine.accept({ ...scoped('query', 'topic-one'), text: '/task' });
  const reply = String(f.store.db.prepare("SELECT content FROM outbox WHERE inboxKey='query' AND kind='result'").get()?.content);
  assert.match(reply, new RegExp(f.store.get('original')!.taskId!));
  assert.doesNotMatch(reply, new RegExp(f.store.get('other-owner')!.taskId!));
});

const gate = () => { let release!:()=>void; const promise=new Promise<void>(r=>{release=r;}); return {promise,release}; };
const progressFeedbackMessage = (key:string):Incoming => ({key,messageId:'om_'+key,chatId:'chat',chatKey:'app:chat',senderId:'owner',text:'do work',
  envelope:{version:1,type:'text',kind:'instruction',scopeKey:'app:chat:thread:root',threadId:'root',materials:[],limitations:[]}});
function progressFeedbackFixture(t:{after(fn:()=>Promise<void>):void},sender:Sender) {
  const dir=mkdtempSync(join(tmpdir(),'namo-progress-')),store=new Store(join(dir,'bot.sqlite'));
  let request:RunRequest|undefined,finish!:(result:RunResult)=>void;
  const runtime:Runtime={run(r){request=r;return new Promise((resolve,reject)=>{finish=resolve;
    r.signal.addEventListener('abort',()=>reject(new RuntimeError('cancelled')),{once:true});});}};
  const engine=new Engine(store,runtime,sender,{dataDir:dir,concurrency:1,feishu:{cards:true,progressIntervalMs:0}});
  t.after(async()=>{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,store,engine,request:()=>request,finish:()=>finish({text:'final answer',threadId:'thread',turnId:'turn'})};
}

test('default first feedback is 200ms; cold execution and a pending reaction do not block it',async t=>{
  const reaction=gate();let cards=0,reactions=0;
  t.after(async()=>{reaction.release();});
  const f=progressFeedbackFixture(t,{async send(){return 'text';},async sendCard(_chat,_card,_uuid,route){
    assert.deepEqual(route,{messageId:'om_first',thread:true});cards++;return 'first-card';},
    async react(){reactions++;await reaction.promise;return 'reaction';}});
  assert.equal(parseConfig({},join(f.dir,'config.json')).feishu.progressDelayMs,200);
  f.engine.start();f.engine.accept(progressFeedbackMessage('first'));
  await waitFor(()=>cards===1);assert.equal(reactions,1);assert.ok(f.request());
  const output=f.store.db.prepare("SELECT sendStartedAt,acceptedAt,createdAt FROM outbox WHERE kind='progress'").get()!;
  assert.ok(Number(output.acceptedAt)>=Number(output.sendStartedAt));
  assert.ok(Number(output.sendStartedAt)>=Number(output.createdAt));
  reaction.release();f.finish();await waitFor(()=>f.store.get('first')?.state==='replied');assert.equal(cards,1);
});

test('final answer delivery does not wait for a slow progress patch; same card is terminally corrected',async t=>{
  const patch=gate();const cards:object[]=[],updates:object[]=[],texts:string[]=[];
  t.after(async()=>{patch.release();});
  const f=progressFeedbackFixture(t,{async send(_chat,text){texts.push(text);return 'final';},async sendCard(_chat,card){cards.push(card);return 'live-card';},
    async updateCard(id,card){assert.equal(id,'live-card');updates.push(card);if(updates.length===1)await patch.promise;}});
  f.engine.start();f.engine.accept(progressFeedbackMessage('slow-patch'));await waitFor(()=>cards.length===1);
  f.request()!.onProgress?.({id:'step',kind:'commentary',status:'completed',text:'已定位入口，正在检查相关实现。'});
  await f.engine.pump();await waitFor(()=>updates.length===1);
  f.finish();await waitFor(()=>texts.some(text=>text.startsWith('final answer')));
  assert.equal(updates.length,1);assert.equal(f.store.get('slow-patch')?.state,'replied');
  patch.release();await waitFor(()=>updates.length===2);assert.match(JSON.stringify(updates[1]),/已完成/);
  assert.equal(cards.length,1);
});

test('a queued task gets readable feedback before the occupied executor is available',async t=>{
  const routes:string[]=[];
  const f=progressFeedbackFixture(t,{async send(){return 'text';},async sendCard(_chat,card,_uuid,route){
    routes.push(route!.messageId);if(route!.messageId==='om_queued')assert.match(JSON.stringify(card),/正在排队|排队中/);return route!.messageId;}});
  f.engine.start();f.engine.accept(progressFeedbackMessage('active'));await waitFor(()=>!!f.request());
  f.engine.accept(progressFeedbackMessage('queued'));await waitFor(()=>routes.includes('om_queued'));
  const queued=f.store.get('queued')!;assert.equal(queued.state,'queued');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM task_runs').get()?.n,1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE inboxKey='queued' AND kind='progress'").get()?.n,1);
});

test('wait/resume reuses the original progress intent, including a wait before the first card',async t=>{
  for(const sent of [false,true])await t.test(String(sent),t=>{
    const dir=mkdtempSync(join(tmpdir(),'namo-progress-resume-')),store=new Store(join(dir,'db'));
    t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
    store.enqueue(progressFeedbackMessage('original'));
    const tasks=new Tasks(store),task=tasks.create(store.get('original')!,{cwd:dir,policyHash:'policy'});
    store.addOutput('original','progress','已收到');
    const output=store.nextOutput()!;
    if(sent){store.sending(output.id);store.sent(output.id,'original-live-card');}
    else store.db.prepare("UPDATE outbox SET state='deferred' WHERE id=?").run(output.id);
    const run=tasks.start(task);tasks.saveRun(run,'thread','turn');
    const waits=new Waits(store),request={threadId:'thread',turnId:'turn',callId:'question',question:'请选择'};
    const id=waits.request(task.id,run,request);waits.park(task,run,{...request,id});tasks.progress();
    assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=?').get(output.id)?.state,sent?'sent':'suppressed');
    const reply=progressFeedbackMessage('reply');store.enqueue(reply);waits.answer(waits.get(id)!,reply,'继续');
    tasks.start(tasks.get(task.id)!);tasks.progress(Date.now()+1000);
    const original=store.db.prepare('SELECT * FROM outbox WHERE id=?').get(output.id)!;
    assert.equal(original.state,sent?'sent':'pending');
    assert.equal(original.platformId,sent?'original-live-card':null);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='progress'").get()?.n,1);
    assert.deepEqual(JSON.parse(String(original.route)),{messageId:'om_original',thread:true});
  });
});

function replyFormatFixture(t:any){
  const dir=mkdtempSync(join(tmpdir(),'namo-format-')),store=new Store(join(dir,'db'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.enqueue({key:'m',messageId:'original',chatId:'chat',chatKey:'chat',senderId:'alice',text:'do work'});
  const tasks=new Tasks(store),task=tasks.create(store.get('m')!,{cwd:dir,policyHash:'policy'}),run=tasks.start(task);
  return {dir,store,tasks,task,run};
}

test('normal Markdown replies use rich posts both on first send and after persisted preparation',async t=>{
  for(const prepared of [false,true])for(const answer of ['> quotation','_italic_','~~removed~~','| A | B |\n| --- | --- |\n| 1 | 2 |']){
    await t.test(`${prepared?'prepared':'fresh'} ${answer.slice(0,12)}`,async t=>{
      const f=replyFormatFixture(t),posts:object[]=[],texts:string[]=[];f.tasks.finish(f.task,f.run,answer);
      if(prepared)new Cards(f.store).prepare(f.store.nextOutput()!);
      const engine=new Engine(f.store,{async run(){throw Error('must not rerun');}}, {
        async send(_c,text,id){texts.push(text);return id;},async sendPost(_c,post,id){posts.push(post);return id;},
        async sendCard(){throw Error('simple reply needs no card');},
      },{dataDir:f.dir,concurrency:1,feishu:{cards:true}});
      try {engine.start();await waitFor(()=>f.store.get('m')?.state==='replied');assert.equal(posts.length,1);assert.deepEqual(texts,[]);
        assert.equal(f.store.db.prepare("SELECT content FROM output_sources WHERE kind='result'").get()?.content,answer);
      }finally{await engine.stop();}
    });
  }
});

test('format rejection allows exactly one plain fallback; ambiguous sends are never retried',async t=>{
  for(const unknown of [false,true])await t.test(String(unknown),async t=>{
    const f=replyFormatFixture(t);f.tasks.finish(f.task,f.run,'**bold**');new Cards(f.store).prepare(f.store.nextOutput()!);
    let posts=0,texts=0;const engine=new Engine(f.store,{async run(){throw Error('must not rerun');}}, {
      async send(_c,_text,id){texts++;return id;},async sendPost(){posts++;throw new SendError(unknown,unknown?'timeout':'feishu_230099');},
      async sendCard(){throw Error('unexpected card');},
    },{dataDir:f.dir,concurrency:1,feishu:{cards:true}});
    try {engine.start();await waitFor(()=>['replied','delivery_unknown'].includes(f.store.get('m')!.state));
      assert.equal(posts,1);assert.equal(texts,unknown?0:1);assert.equal(f.store.get('m')?.state,unknown?'delivery_unknown':'replied');
    }finally{await engine.stop();}
  });
});

test('result cards use the code-capable component and degrade unsupported blocks without altering stored answers',t=>{
  const f=replyFormatFixture(t),answer='# Heading\n> quote\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```';
  const card=renderTaskCard(f.task,answer,'result',0) as any;
  assert.equal(card.elements[0].tag,'markdown');assert.equal(card.config.update_multi,true);
  const rendered=cardMarkdown(answer);assert.match(rendered,/\*\*Heading\*\*/);assert.match(rendered,/```(?:text)?\n\| A/);
  assert.match(rendered,/```ts\nconst x = 1;/);assert.doesNotMatch(rendered,/^# Heading/m);
  assert.doesNotMatch(cardMarkdown('<at user_id="all">all</at> ![x](https://example.com/a.png) [bad](javascript:alert)'),/<at|!\[x\]|javascript:/);
  for(const value of ['> quote','_italic_','*italic*','~~strike~~','|a|b|\n|---|---|'])assert.equal(hasMarkdown(value),true);
  assert.equal(cardMarkdown('# C#'),'**C#**');assert.equal(cardMarkdown('# C# ###'),'**C#**');
  assert.match(cardMarkdown('| one |\n| --- |\n| value |'),/^```text\n/);
});

test('split code fences retain their marker and length and do not swallow following prose',()=>{
  for(const fence of ['~~~','````']){
    const source=`${fence}js\n${'const x = 1;\n'.repeat(220)}${fence}\n# After`;
    const chunks=splitDisplay(source);let prefix='';
    for(const chunk of chunks){const continuation=openFence(prefix),post=richPost(chunk,continuation??false) as any;
      const rendered=post.zh_cn.content[0][0].text;if(continuation)assert.ok(rendered.startsWith(fence+'\n'));
      assert.equal(openFence(rendered),undefined);prefix+=chunk;
      if(chunk.includes('# After'))assert.ok(rendered.endsWith('# After'));
    }assert.equal(chunks.join(''),source);
  }
});

test('viewing details repeatedly does not stop shared progress updates or repeat final delivery',async t=>{
  const f=replyFormatFixture(t);f.store.addOutput('m','progress','started');const output=f.store.nextOutput()!,cards=new Cards(f.store);
  const initial=cards.prepare(output) as any;assert.equal(initial.config.update_multi,true);f.store.sending(output.id);f.store.sent(output.id,'card-id');
  const token=f.store.db.prepare("SELECT token FROM card_actions WHERE action='details'").get()!.token;
  const event={operator:{open_id:'alice'},context:{open_chat_id:'chat',open_message_id:'card-id'},action:{value:{namo:String(token)}}};
  const patches:any[]=[];const feedback=new Feedback(f.store,{async send(){throw Error('no new card');},async updateCard(id,card){assert.equal(id,'card-id');patches.push(card);}});
  await feedback.tick({cadenceMs:0,heartbeatMs:0});cards.accept(event);cards.accept(event);
  f.store.db.prepare('UPDATE tasks SET startedAt=startedAt-5000 WHERE id=?').run(f.task.id);
  await feedback.tick({cadenceMs:0,heartbeatMs:0});assert.equal(patches.length,2);assert.notDeepEqual(patches[0],patches[1]);
  f.tasks.finish(f.task,f.run,'done');await feedback.tick({cadenceMs:0,heartbeatMs:0});await feedback.tick({cadenceMs:0,heartbeatMs:0});
  assert.equal(patches.length,3);for(const patch of patches)assert.equal(patch.config.update_multi,true);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE kind LIKE 'card-status:%'").get()?.n,1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE kind='result'").get()?.n,1);
});
