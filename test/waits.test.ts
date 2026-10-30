import { storeFixture, waitFor } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, SendError, type Sender } from '../src/engine.js';
import { RuntimeError, type RunRequest, type RunResult, type Runtime, type WaitRequest } from '../src/runtime.js';
import { Store, type Incoming } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { HUMAN_WAIT_TIMEOUT_MS, WaitInputError, Waits } from '../src/waits.js';
import { Cards } from '../src/cards.js';

const until = (condition: () => boolean, timeoutMs = 6000) => waitFor(condition, timeoutMs);

function message(key: string, text = 'ORIGINAL_MARKER', options: {
  chat?: string; scope?: string; owner?: string; parentId?: string;
} = {}): Incoming {
  const chat = options.chat ?? 'chat';
  return { key, messageId: key, chatKey: chat, chatId: chat, senderId: options.owner ?? 'alice', text,
    envelope: { version: 1, type: 'text', kind: 'instruction', scopeKey: options.scope ?? chat,
      parentId: options.parentId, chatType: 'p2p', materials: [], limitations: [] } };
}

function waitingResult(r: RunRequest, index: number, question = `question-${index}`): RunResult {
  const threadId = r.threadId ?? 'thread-one';
  const turnId = `turn-${index}`;
  r.onThread(threadId); r.onTurn(turnId);
  const request: WaitRequest = { threadId, turnId, callId: `call-${index}`, question };
  const id = r.onWait!(request);
  return { text: `partial-${index}`, threadId, turnId, waiting: { ...request, id } };
}

function fixture(t: { after: (fn: () => void | Promise<void>) => void }, runtime: Runtime,
  sender?: Sender, concurrency = 2) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'namo-waits-')));
  const one = join(dir, 'one'), two = join(dir, 'two'); mkdirSync(one); mkdirSync(two);
  const store = new Store(join(dir, 'bot.sqlite')); const tasks = new Tasks(store); const engines: Engine[] = [];
  const config = { dataDir: dir, concurrency, codex: { bin: 'codex', home: join(dir, 'auth'), timeoutMs: 10_000,
    sandbox: 'workspace-write' as const, projects: { one, two }, defaultProject: 'one' } };
  const makeEngine = (nextRuntime: Runtime = runtime) => {
    const engine = new Engine(store, nextRuntime, sender ?? { async send(_chat, _text, uuid) { return `platform-${uuid}`; } }, config);
    engines.push(engine); return engine;
  };
  t.after(async () => {
    for (const engine of engines) await engine.stop();
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { dir, one, two, store, tasks, config, makeEngine };
}

test('requested wait is persisted before acknowledgement, parks every state, and crash recovery makes an unparked request uncertain', async t => {
  let observedRequested = false; let calls = 0;
  let f: ReturnType<typeof fixture>;
  const runtime: Runtime = { async run(r) {
    calls++;
    const result = waitingResult(r, calls, '请选择 A 或 B');
    const row = f.store.db.prepare('SELECT state,question FROM task_waits WHERE id=?').get(result.waiting!.id);
    observedRequested = row?.state === 'requested' && row.question === '请选择 A 或 B';
    return result;
  } };
  f = fixture(t, runtime); const engine = f.makeEngine(); engine.start(); engine.accept(message('first'));
  await until(() => f.tasks.get(f.store.get('first')!.taskId!)?.state === 'waiting');
  const task = f.tasks.get(f.store.get('first')!.taskId!)!;
  const waiting = new Waits(f.store).current(task.id)!;
  assert.equal(observedRequested, true); assert.equal(waiting.state, 'open');
  assert.equal(f.store.get('first')?.state, 'waiting');
  assert.equal(f.store.db.prepare('SELECT state FROM task_runs WHERE id=?').get(waiting.runId)?.state, 'waiting');
  assert.match(String(f.store.db.prepare('SELECT state FROM outbox WHERE kind=?').get(`wait:${waiting.id}`)?.state),
    /^(pending|sending|sent)$/);

  const manual = message('manual', 'manual crash'); f.store.enqueue(manual);
  const second = f.tasks.create(f.store.get('manual')!, { cwd: f.one, policyHash: task.policyHash, project: 'one' });
  const run = f.tasks.start(second); f.tasks.saveRun(run, 'thread-crash', 'turn-crash');
  const id = new Waits(f.store).request(second.id, run,
    { threadId: 'thread-crash', turnId: 'turn-crash', callId: 'call-crash', question: 'still there?' });
  f.tasks.recover(false);
  assert.equal(new Waits(f.store).get(id)?.state, 'uncertain');
  assert.equal(f.tasks.get(second.id)?.state, 'interrupted');
});

test('waiting releases global and cwd slots but remains a FIFO barrier for the same chat', async t => {
  const starts: string[] = [];
  const runtime: Runtime = { async run(r) {
    const prompt = JSON.parse(r.prompt); const key = prompt.messages?.[0]?.message_id as string;
    starts.push(key);
    if (key === 'waiting') return waitingResult(r, 1);
    r.onThread(`thread-${key}`); r.onTurn(`turn-${key}`);
    return { text: `done-${key}`, threadId: `thread-${key}`, turnId: `turn-${key}` };
  } };
  const f = fixture(t, runtime, undefined, 1); const engine = f.makeEngine();
  engine.accept(message('waiting')); engine.accept(message('same-chat'));
  engine.accept(message('other-chat', 'other task', { chat: 'other-chat' })); engine.start();
  await until(() => f.store.get('other-chat')?.state === 'replied');
  assert.deepEqual(starts, ['waiting', 'other-chat']);
  assert.equal(f.tasks.get(f.store.get('waiting')!.taskId!)?.state, 'waiting');
  assert.equal(f.tasks.get(f.store.get('same-chat')!.taskId!)?.state, 'queued');
});

test('a group wait blocks only the same person and topic',async t=>{
 const starts:string[]=[],runtime:Runtime={async run(r){const key=JSON.parse(r.prompt).messages[0].message_id;starts.push(key);
  if(key==='waiting-group')return waitingResult(r,1);r.onThread(`thread-${key}`);r.onTurn(`turn-${key}`);return {text:'done',threadId:`thread-${key}`,turnId:`turn-${key}`};}};
 const f=fixture(t,runtime,undefined,1),engine=f.makeEngine();
 const group=(key:string,owner:string,scope:string)=>{const m=message(key,'work',{chat:'group',owner,scope});m.envelope!.chatType='group';return m;};
 engine.accept(group('waiting-group','alice','topic-a'));engine.accept(group('same-person','alice','topic-a'));
 engine.accept(group('other-person','bob','topic-a'));engine.accept(group('other-topic','alice','topic-b'));engine.start();
 await until(()=>f.store.get('other-person')?.state==='replied'&&f.store.get('other-topic')?.state==='replied');
 assert.deepEqual(starts,['waiting-group','other-person','other-topic']);
 assert.equal(f.tasks.get(f.store.get('same-person')!.taskId!)?.state,'queued');
});

test('different members in a group may run concurrently in isolated directories',async t=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'namo-group-slots-'))),store=new Store(join(dir,'db'));const starts:string[]=[];
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const engine=new Engine(store,{async run(r){starts.push(r.cwd);await gate;r.onThread(`thread-${starts.length}`);r.onTurn('turn');return {text:'done',threadId:'thread',turnId:'turn'};}},
  {async send(_chat,_text,uuid){return uuid;}},{dataDir:dir,concurrency:2,feishu:{progressUpdates:false,reactions:false}});
 t.after(async()=>{release();await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});});
 for(const owner of ['alice','bob']){const m=message(owner,'work',{chat:'group',owner,scope:'topic'});m.envelope!.chatType='group';engine.accept(m);}
 engine.start();await until(()=>starts.length===2);assert.notEqual(starts[0],starts[1]);release();
 await until(()=>store.get('alice')?.state==='replied'&&store.get('bob')?.state==='replied');
});

test('daily turn limit leaves excess work queued and resumes it when capacity returns',async t=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'namo-turn-limit-'))),store=new Store(join(dir,'db'));let calls=0;
 const engine=new Engine(store,{async run(r){calls++;r.onThread(`thread-${calls}`);r.onTurn('turn');return {text:'done',threadId:'thread',turnId:'turn'};}},
  {async send(_chat,_text,uuid){return uuid;}},{dataDir:dir,concurrency:1,codex:{bin:'codex',home:join(dir,'home'),sandbox:'read-only',timeoutMs:10000,dailyTurnLimit:1},feishu:{progressUpdates:false,reactions:false}});
 t.after(async()=>{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});});
 engine.accept(message('first'));engine.accept(message('second','next',{chat:'other'}));engine.start();
 await until(()=>!!store.db.prepare("SELECT 1 FROM outbox WHERE kind LIKE 'quota:%'").get());
 assert.equal(calls,1);assert.equal(store.get('second')?.state,'queued');
 store.db.prepare("UPDATE settings SET value='0' WHERE key LIKE 'daily-turns:%'").run();await engine.pump();
 await until(()=>store.get('second')?.state==='replied');assert.equal(calls,2);
});

test('resume enforces owner, chat and topic, rejects stale quotes, and supports multiple cycles on the original thread', async t => {
  const prompts: string[] = []; const threads: (string | undefined)[] = [];
  const runtime: Runtime = { async run(r) {
    prompts.push(r.prompt); threads.push(r.threadId);
    const index = prompts.length;
    if (index < 3) return waitingResult(r, index);
    r.onThread(r.threadId!); r.onTurn('turn-3');
    return { text: 'all done', threadId: r.threadId!, turnId: 'turn-3' };
  } };
  const f = fixture(t, runtime); const engine = f.makeEngine(); engine.start();
  engine.accept(message('first')); await until(() => f.tasks.list(message('lookup'))[0]?.state === 'waiting');
  const task = f.tasks.list(message('lookup'))[0]; const first = new Waits(f.store).current(task.id)!;
  await until(() => !!f.store.db.prepare('SELECT platformId FROM outbox WHERE kind=? AND platformId IS NOT NULL').get(`wait:${first.id}`));
  const firstPlatform = String(f.store.db.prepare('SELECT platformId FROM outbox WHERE kind=?').get(`wait:${first.id}`)?.platformId);

  engine.accept(message('wrong-owner', `/resume ${first.id} stolen`, { owner: 'bob' }));
  engine.accept(message('wrong-chat', `/resume ${first.id} stolen`, { chat: 'elsewhere' }));
  engine.accept(message('wrong-topic', `/resume ${first.id} stolen`, { scope: 'other-topic' }));
  assert.equal(f.tasks.get(task.id)?.inputVersion, 1); assert.equal(prompts.length, 1);

  const reply = message('reply-one', 'answer-one', { parentId: firstPlatform });
  assert.equal(engine.accept(reply), true); assert.equal(engine.accept(reply), false);
  await until(() => {
    const current = new Waits(f.store).current(task.id);
    return current?.id !== first.id && current?.state === 'open';
  });
  const second = new Waits(f.store).current(task.id)!;
  assert.equal(second.state, 'open'); assert.equal(f.tasks.get(task.id)?.inputVersion, 2);

  engine.accept(message('amend-waiting', `/amend ${task.id} should-not-steer`));
  engine.accept(message('switch-waiting', '/project two'));
  engine.accept(message('stale-quote', 'late old answer', { parentId: firstPlatform }));
  await until(() => f.store.get('stale-quote')?.state === 'replied');
  assert.equal(f.tasks.get(task.id)?.inputVersion, 2); assert.equal(f.store.project('chat'), undefined);
  assert.equal(new Waits(f.store).get(first.id)?.state, 'answered'); assert.equal(new Waits(f.store).get(second.id)?.state, 'open');

  engine.accept(message('reply-two', `/resume ${second.id} answer-two`));
  await until(() => f.tasks.get(task.id)?.state === 'succeeded');
  assert.equal(f.tasks.get(task.id)?.inputVersion, 3); assert.deepEqual(threads, [undefined, 'thread-one', 'thread-one']);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE taskId=?').get(task.id)?.n, 3);
  const firstResume = JSON.parse(prompts[1]), secondResume = JSON.parse(prompts[2]);
  assert.equal(firstResume.type, 'task_resume'); assert.equal(firstResume.question, 'question-1'); assert.equal(firstResume.reply, 'answer-one');
  assert.equal(secondResume.type, 'task_resume'); assert.equal(secondResume.question, 'question-2'); assert.equal(secondResume.reply, 'answer-two');
  assert.equal('messages' in firstResume, false); assert.doesNotMatch(prompts[1], /ORIGINAL_MARKER/);
  assert.equal(f.tasks.thread(f.tasks.get(task.id)!), 'thread-one');
});

test('unknown wait delivery is never retried, and cancellation closes the wait without another inference', async t => {
  let calls = 0, waitSends = 0;
  const runtime: Runtime = { async run(r) { calls++; return waitingResult(r, calls, 'delivery question'); } };
  const sender: Sender = { async send(_chat, content, uuid) {
    if (content.includes('delivery question')) { waitSends++; throw new SendError(true, 'transport_timeout'); }
    return uuid;
  } };
  const f = fixture(t, runtime, sender); const engine = f.makeEngine(); engine.start(); engine.accept(message('first'));
  await until(() => f.store.db.prepare("SELECT state FROM outbox WHERE kind LIKE 'wait:%'").get()?.state === 'unknown');
  for (let i = 0; i < 8; i++) await engine.pump();
  assert.equal(waitSends, 1); assert.equal(calls, 1);
  const task = f.tasks.get(f.store.get('first')!.taskId!)!; const wait = new Waits(f.store).current(task.id)!;
  engine.accept(message('cancel', `/cancel ${task.id}`)); await until(() => f.tasks.get(task.id)?.state === 'cancelled');
  assert.equal(new Waits(f.store).get(wait.id)?.state, 'cancelled'); assert.equal(calls, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE inboxKey='first' AND kind='result'").get()?.n, 1);
});

test('a waiting task survives receiver restart and resumes exactly once from the stored reply', async t => {
  const prompts: string[] = []; let calls = 0;
  const runtime: Runtime = { async run(r) {
    prompts.push(r.prompt); calls++;
    if (calls === 1) return waitingResult(r, 1, 'restart question');
    r.onThread(r.threadId!); r.onTurn('turn-2'); return { text: 'resumed', threadId: r.threadId!, turnId: 'turn-2' };
  } };
  const f = fixture(t, runtime); const first = f.makeEngine(); first.start(); first.accept(message('first'));
  await until(() => f.tasks.get(f.store.get('first')!.taskId!)?.state === 'waiting');
  const task = f.tasks.get(f.store.get('first')!.taskId!)!; const wait = new Waits(f.store).current(task.id)!;
  await first.stop();
  const second = f.makeEngine(); second.start(); second.accept(message('resume', `/resume ${wait.id} after restart`));
  await until(() => f.tasks.get(task.id)?.state === 'succeeded');
  assert.equal(calls, 2); assert.equal(JSON.parse(prompts[1]).reply, 'after restart');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE taskId=?').get(task.id)?.n, 2);
});

test('changed resume context fails closed without forking a thread or replaying the original instruction', async t => {
  const prompts: string[] = []; let calls = 0;
  const runtime: Runtime = { async run(r) { prompts.push(r.prompt); calls++; return waitingResult(r, calls, 'context question'); } };
  const f = fixture(t, runtime); const first = f.makeEngine(); first.start(); first.accept(message('first'));
  await until(() => f.tasks.get(f.store.get('first')!.taskId!)?.state === 'waiting');
  const task = f.tasks.get(f.store.get('first')!.taskId!)!; const wait = new Waits(f.store).current(task.id)!;
  await first.stop(); first.accept(message('resume', `/resume ${wait.id} answer`));
  f.store.saveThread(`workstream:${task.workstreamId}`, 'different-thread');
  const second = f.makeEngine(); second.start(); await until(() => f.tasks.get(task.id)?.state === 'failed');
  assert.equal(f.tasks.get(task.id)?.error, 'wait_context_changed'); assert.equal(calls, 1);
  assert.equal(prompts.length, 1); assert.match(prompts[0], /ORIGINAL_MARKER/);
});

test('answer and cancel are serialized, and neither a late answer nor an unresolved revision can open a new run', t => {
  const runtime: Runtime = { async run() { throw new Error('not used'); } };
  const f = fixture(t, runtime); const engine = f.makeEngine(); engine.accept(message('first'));
  const task = f.tasks.get(f.store.get('first')!.taskId!)!; const run = f.tasks.start(task);
  f.tasks.saveRun(run, 'thread-one', 'turn-one');
  const waits = new Waits(f.store); const id = waits.request(task.id, run,
    { threadId: 'thread-one', turnId: 'turn-one', callId: 'call-one', question: 'answer?' });
  waits.park(task, run, { id, threadId: 'thread-one', turnId: 'turn-one', callId: 'call-one', question: 'answer?' });
  assert.equal(f.tasks.cancel(f.tasks.get(task.id)!), true);
  const late = message('late', 'too late'); f.store.enqueue(late);
  assert.throws(() => waits.answer(waits.get(id)!, late, late.text), WaitInputError);
  assert.equal(f.tasks.get(task.id)?.state, 'cancelled'); assert.equal(waits.get(id)?.state, 'cancelled');

  engine.accept(message('answered-first')); const answered = f.tasks.get(f.store.get('answered-first')!.taskId!)!;
  const answeredRun = f.tasks.start(answered); f.tasks.saveRun(answeredRun, 'thread-answer', 'turn-answer');
  const answeredId = waits.request(answered.id, answeredRun,
    { threadId: 'thread-answer', turnId: 'turn-answer', callId: 'call-answer', question: 'answer first?' });
  waits.park(answered, answeredRun,
    { id: answeredId, threadId: 'thread-answer', turnId: 'turn-answer', callId: 'call-answer', question: 'answer first?' });
  const accepted = message('accepted-answer', 'saved answer'); f.store.enqueue(accepted);
  waits.answer(waits.get(answeredId)!, accepted, accepted.text);
  assert.equal(f.tasks.cancel(f.tasks.get(answered.id)!), true);
  assert.equal(f.tasks.get(answered.id)?.state, 'cancelled'); assert.equal(waits.get(answeredId)?.state, 'answered');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE taskId=?').get(answered.id)?.n, 1);

  engine.accept(message('second')); const next = f.tasks.get(f.store.get('second')!.taskId!)!; const nextRun = f.tasks.start(next);
  f.tasks.saveRun(nextRun, 'thread-two', 'turn-two');
  const revision = message('revision', 'unresolved'); f.store.enqueue(revision); f.tasks.amend(next, revision);
  assert.throws(() => waits.request(next.id, nextRun,
    { threadId: 'thread-two', turnId: 'turn-two', callId: 'call-two', question: 'unsafe?' }),
  (error: unknown) => error instanceof RuntimeError && error.code === 'wait_unresolved_revision');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM task_waits WHERE taskId=?').get(next.id)?.n, 0);
  f.tasks.dispatch(revision.key, 'accepted');
  const safe = waits.request(next.id, nextRun,
    { threadId: 'thread-two', turnId: 'turn-two', callId: 'call-safe', question: 'which option?' });
  waits.park(next, nextRun, { id: safe, threadId: 'thread-two', turnId: 'turn-two', callId: 'call-safe', question: 'which option?' });
  const followup = message('audit-answer', 'A'); f.store.enqueue(followup);
  waits.answer(waits.get(safe)!, followup, followup.text);
  f.tasks.start(f.tasks.get(next.id)!);
  assert.equal(f.store.db.prepare('SELECT dispatch FROM task_messages WHERE inboxKey=?').get(revision.key)?.dispatch, 'accepted',
    'resuming must preserve the prior runner receipt rather than rewrite it as a newly applied input');
});

test('human waits expire durably without resuming the model and late replies are rejected',t=>{
 const f=fixture(t,{async run(){throw Error('not used');}}),engine=f.makeEngine();engine.accept(message('expire'));
 const task=f.tasks.get(f.store.get('expire')!.taskId!)!,run=f.tasks.start(task);f.tasks.saveRun(run,'thread','turn');
 const waits=new Waits(f.store),request={threadId:'thread',turnId:'turn',callId:'call',question:'answer?'};
 const id=waits.request(task.id,run,request);waits.park(task,run,{id,...request});const created=waits.get(id)!.createdAt;
 waits.expire(created);
 waits.expire(created+HUMAN_WAIT_TIMEOUT_MS-1);assert.equal(waits.get(id)?.state,'open');
 waits.expire(created+HUMAN_WAIT_TIMEOUT_MS);waits.expire(created+HUMAN_WAIT_TIMEOUT_MS+1);
 assert.equal(waits.get(id)?.state,'expired');assert.equal(f.tasks.get(task.id)?.error,'wait_expired');
 assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE inboxKey=? AND kind='result'").get(task.inboxKey)?.n,1);
 const late=message('expired-answer','late');f.store.enqueue(late);
 assert.throws(()=>waits.answer(waits.get(id)!,late,late.text),WaitInputError);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_runs WHERE taskId=?').get(task.id)?.n,1);
});

function waitChoicesFixture(t: any, choices?: string[]) {
  const { dir, file, store: s } = storeFixture(t, 'namo-choice-');
  s.enqueue({key:'original',messageId:'original',chatId:'chat',chatKey:'chat',senderId:'alice',text:'ORIGINAL',
    envelope:{version:1,type:'text',kind:'instruction',scopeKey:'topic-one',chatType:'group',materials:[],limitations:[]}});
  const tasks=new Tasks(s),task=tasks.create(s.get('original')!,{cwd:dir,policyHash:'policy'}),run=tasks.start(task);
  tasks.saveRun(run,'thread','turn');
  const waits=new Waits(s),request={threadId:'thread',turnId:'turn',callId:'call',question:'中文还是英文？',choices};
  const id=waits.request(task.id,run,request);waits.park(task,run,{id,...request});
  const out=s.db.prepare("SELECT * FROM outbox WHERE kind=?").get(`wait:${id}`) as any;
  const cards=new Cards(s),payload=cards.prepare(out) as any;s.sending(out.id);s.sent(out.id,'platform-wait');
  const actions=s.db.prepare('SELECT action,token FROM card_actions WHERE outboxId=?').all(out.id);
  const event=(action:string)=>({operator:{open_id:'alice'},context:{open_chat_id:'chat',open_message_id:'platform-wait'},
    action:{value:{namo:String(actions.find(a=>a.action===action)!.token)}}});
  return {file,s,tasks,task,waits,id,cards,payload,event};
}

test('wait choices render as answers above task controls, persist across restart, and one click resumes once',t=>{
  const f=waitChoicesFixture(t,['中文','英文']);
  const groups=f.payload.elements.filter((e:any)=>e.tag==='action');
  assert.deepEqual(groups[0].actions.map((a:any)=>a.text.content),['中文','英文']);
  assert.deepEqual(groups[1].actions.map((a:any)=>a.text.content),['查看详情','停止任务']);
  assert.doesNotMatch(f.payload.elements[0].text.content,/WAIT-|N-|\/resume/);
  const resumed=new Store(f.file);try {
    const cards=new Cards(resumed);assert.equal(cards.accept(f.event('answer:0')).toast.type,'info');
    assert.equal(cards.accept(f.event('answer:0')).toast.content,'这次操作已经处理，请用 /task 查看最新状态');
    assert.equal(cards.accept(f.event('answer:1')).toast.type,'error');
  }finally{resumed.close();}
  const task=f.tasks.get(f.task.id)!;assert.equal(task.state,'queued');assert.equal(task.inputVersion,2);
  const w=f.waits.get(f.id)!;assert.equal(w.state,'answered');assert.equal(f.s.get(w.replyInboxKey!)?.state,'linked');
  assert.equal(JSON.parse(f.tasks.prompt(task)).reply,'中文');
  assert.equal(f.s.get('original')?.text,'ORIGINAL');
  assert.equal(f.s.db.prepare("SELECT COUNT(*) n FROM task_messages WHERE role='wait_reply'").get()?.n,1);
  assert.equal(f.s.db.prepare("SELECT COUNT(*) n FROM task_runs").get()?.n,1,'callback queues but never starts a model');
});

test('choice callbacks require the owner and exact delivered card, and expired or cancelled waits cannot resume',t=>{
  const f=waitChoicesFixture(t,['中文','英文']),event=f.event('answer:0');
  assert.equal(f.cards.accept({...event,operator:{open_id:'bob'}}).toast.type,'error');
  assert.equal(f.cards.accept({...event,context:{...event.context,open_chat_id:'another'}}).toast.type,'error');
  assert.equal(f.cards.accept({...event,context:{...event.context,open_message_id:'another'}}).toast.type,'error');
  f.s.db.prepare('UPDATE card_actions SET expiresAt=0 WHERE action LIKE ?').run('answer:%');
  assert.equal(f.cards.accept(event).toast.type,'error');
  f.s.db.prepare('UPDATE card_actions SET expiresAt=?').run(Date.now()+60000);
  assert.equal(f.cards.accept(f.event('cancel')).toast.type,'info');
  assert.equal(f.cards.accept(event).toast.type,'error');assert.equal(f.waits.get(f.id)?.state,'cancelled');
  assert.equal(f.s.db.prepare("SELECT COUNT(*) n FROM inbox WHERE envelope LIKE '%card_action%'").get()?.n,0);
});

test('open questions without choices stay text-answerable after reopening',t=>{
  const f=waitChoicesFixture(t);assert.equal(f.payload.elements.filter((e:any)=>e.tag==='action').length,1);
  const upgraded=new Store(f.file);try {
    const waits=new Waits(upgraded),w=waits.get(f.id)!;assert.equal(w.state,'open');assert.equal(w.choices,undefined);
    const input={key:'reply',messageId:'reply',chatId:'chat',chatKey:'chat',senderId:'alice',text:'自由回答',
      envelope:{version:1 as const,type:'text',kind:'instruction' as const,scopeKey:'topic-one',materials:[],limitations:[]}};
    upgraded.enqueue(input);waits.answer(w,input,input.text);assert.equal(waits.get(f.id)?.state,'answered');
  }finally{upgraded.close();}
});

test('bad structured choices are rejected before creating any durable wait',t=>{
  for(const choices of [[],['only'],['a','a'],[' a','b'],['a\nb','c'],['a'.repeat(81),'b']]) {
    assert.throws(()=>waitChoicesFixture(t,choices),(e:unknown)=>e instanceof RuntimeError&&e.code==='wait_invalid_choices');
  }
});

test('a real card callback reaches the scheduler and resumes the same task and thread only once',async t=>{
  const {Engine}=await import('../src/engine.js');
  const dir=mkdtempSync(join(tmpdir(),'namo-choice-engine-')),s=new Store(join(dir,'bot.sqlite'));let calls=0;
  const engine=new Engine(s,{async run(r){
    calls++;r.onThread('thread-choice');r.onTurn(`turn-${calls}`);
    if(calls===1){const request={threadId:'thread-choice',turnId:'turn-1',callId:'call',question:'中文还是英文？',choices:['中文','英文']};
      return {text:'',threadId:'thread-choice',turnId:'turn-1',waiting:{...request,id:r.onWait!(request)}};}
    assert.equal(r.threadId,'thread-choice');assert.equal(JSON.parse(r.prompt).reply,'中文');
    return {text:'已选择中文。',threadId:'thread-choice',turnId:'turn-2'};
  }},{async send(_c,_t,id){return id;},async sendCard(_c,_p,id){return id;}},{dataDir:dir,concurrency:1,feishu:{cards:true}});
  t.after(async()=>{await engine.stop();s.close();rmSync(dir,{recursive:true,force:true});});
  const until=async(fn:()=>boolean)=>{const end=Date.now()+6000;while(!fn()){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,10));}};
  engine.start();engine.accept({key:'first',messageId:'first',chatKey:'chat',chatId:'chat',senderId:'alice',text:'choose'});
  await until(()=>!!s.db.prepare("SELECT 1 FROM outbox WHERE kind LIKE 'wait:%' AND state='sent'").get());
  const action=s.db.prepare("SELECT a.token,o.platformId FROM card_actions a JOIN outbox o ON o.id=a.outboxId WHERE a.action='answer:0'").get()!;
  const event={operator:{open_id:'alice'},context:{open_chat_id:'chat',open_message_id:String(action.platformId)},action:{value:{namo:String(action.token)}}};
  engine.acceptCard(event);engine.acceptCard(event);
  await until(()=>s.get('first')?.state==='replied');
  assert.equal(calls,2);assert.equal(s.db.prepare("SELECT COUNT(*) n FROM outbox WHERE kind='result' AND state='sent'").get()?.n,1);
});

test('a temporary language answer resumes only its task and never changes preferences for the next task',async t=>{
  const {Engine}=await import('../src/engine.js');
  const {Profiles}=await import('../src/profiles.js');
  const {AssistantSettings}=await import('../src/assistant.js');
  const dir=mkdtempSync(join(tmpdir(),'namo-language-')),s=new Store(join(dir,'db'));
  const profiles=new Profiles(s,{channel:'feishu',appId:'app',userId:'alice'}),assistant=new AssistantSettings(s);
  profiles.update(0,{language:'zh-TW'},{source:'local-owner'});
  const originalProfile=profiles.get(),originalSettings=assistant.read();let calls=0,firstTask='';
  const engine=new Engine(s,{async run(r){
    const prompt=JSON.parse(r.prompt);calls++;r.onThread('same-thread');r.onTurn(`turn-${calls}`);
    if(calls===1){firstTask=prompt.task_id;const request={threadId:'same-thread',turnId:'turn-1',callId:'language',question:'中文还是英文？',choices:['中文','英文']};
      return {text:'',threadId:'same-thread',turnId:'turn-1',waiting:{...request,id:r.onWait!(request)}};}
    assert.equal(r.threadId,'same-thread');
    if(calls===2){assert.equal(prompt.task_id,firstTask);assert.equal(prompt.reply,'英文');assert.match(prompt.note,/只对本任务有效/);}
    else {assert.notEqual(prompt.task_id,firstTask);assert.match(prompt.note,/其他已结束任务.*已经失效/);assert.doesNotMatch(JSON.stringify(prompt.messages),/英文/);}
    return {text:calls===2?'English confirmation.':'新的任务使用中文。',threadId:'same-thread',turnId:`turn-${calls}`};
  }},{async send(_c,_t,id){return id;},async sendCard(_c,_p,id){return id;}},{dataDir:dir,concurrency:1,feishu:{cards:true}});
  t.after(async()=>{await engine.stop();s.close();rmSync(dir,{recursive:true,force:true});});
  const until=async(fn:()=>boolean)=>{const end=Date.now()+6000;while(!fn()){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,10));}};
  const message=(key:string,text:string)=>({key,messageId:key,chatKey:'chat',chatId:'chat',senderId:'alice',text});
  engine.start();engine.accept(message('choose','问我中文还是英文'));
  await until(()=>!!s.db.prepare("SELECT 1 FROM outbox WHERE kind LIKE 'wait:%' AND state='sent'").get());
  const action=s.db.prepare("SELECT a.token,o.platformId FROM card_actions a JOIN outbox o ON o.id=a.outboxId WHERE a.action='answer:1'").get()!;
  engine.acceptCard({operator:{open_id:'alice'},context:{open_chat_id:'chat',open_message_id:String(action.platformId)},action:{value:{namo:String(action.token)}}});
  await until(()=>s.get('choose')?.state==='replied');engine.accept(message('next','现在处理下一件事'));
  await until(()=>s.get('next')?.state==='replied');assert.equal(calls,3);
  assert.deepEqual(profiles.get(),originalProfile);assert.deepEqual(assistant.read(),originalSettings);
});
