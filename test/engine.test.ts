import { waitFor } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, SendError, type Sender } from '../src/engine.js';
import { RuntimeError, type Runtime } from '../src/runtime.js';
import { Store, type Incoming } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { conversationControl } from '../src/conversation-control.js';
import { awaitMcpApproval } from '../src/mcp-write-approval.js';
import type { Config } from '../src/config.js';

test('shared writable directories serialize distinct chats while all tasks run in private scratch directories',async t=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'namo-directory-engine-'))),store=new Store(join(dir,'bot.sqlite'));
  const source=join(dir,'source');mkdirSync(source);
  let active=0,max=0;const runs:string[]=[];
  const engine=new Engine(store,{async run(r){runs.push(r.cwd);active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,40));active--;return{text:'done',threadId:r.cwd,turnId:'turn'};}},
    {async send(_c,_text,id){return id;}},{dataDir:dir,concurrency:4,feishu:{appId:'app',appSecret:'test',domain:'feishu',requireMention:true,allowedUserIds:['user','bob'],allowedChatIds:[]},
    codex:{bin:'codex',home:join(dir,'auth'),timeoutMs:1000,sandbox:'workspace-write',directories:[source],allowLocalCommits:true}});
  t.after(async()=>{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});});
  engine.start();engine.accept(msg('first'));engine.accept({...msg('second','other'),senderId:'bob'});
  await wait(()=>store.get('first')?.state==='replied'&&store.get('second')?.state==='replied');
  assert.equal(runs.length,2);assert.equal(max,1);assert.notEqual(runs[0],runs[1]);assert.ok(runs.every(path=>path.startsWith(join(dir,'workspaces'))));
  const tasks=new Tasks(store);for(const key of ['first','second'])assert.ok(tasks.directories(tasks.get(store.get(key)!.taskId!)!).includes(source));
});

const msg = (key: string, chatKey = 'chat', text = 'hello'): Incoming => ({ key, chatKey, chatId: chatKey, messageId: key, senderId: 'user', text });
const wait = (condition: () => boolean, timeoutMs = 4000) => waitFor(condition, timeoutMs);

test('recovered control commands never run as model prompts', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-engine-')); const store = new Store(join(dir, 'bot.sqlite'));
  store.enqueue(msg('status', 'chat', '/status'));
  let calls = 0;
  const engine = new Engine(store, { async run() { calls++; throw new Error('must not run'); } },
    { async send(_chat, _text, uuid) { return uuid; } }, { dataDir: dir, concurrency: 2 });
  t.after(async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  engine.start(); await wait(() => store.get('status')?.state === 'replied'); assert.equal(calls, 0);
});

test('a completed result pending delivery is sent after restart without another model call', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-engine-')); const file = join(dir, 'bot.sqlite');
  const before = new Store(file); before.enqueue(msg('a')); before.claim('a'); before.finish('a', 'saved answer'); before.close();
  const store = new Store(file); let calls = 0; const sent: string[] = [];
  const engine = new Engine(store, { async run() { calls++; throw new Error('must not run'); } },
    { async send(_chat, text, uuid) { sent.push(text); return uuid; } }, { dataDir: dir, concurrency: 2 });
  t.after(async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  engine.start(); await wait(() => store.get('a')?.state === 'replied'); assert.equal(calls, 0); assert.deepEqual(sent, ['saved answer']);
});

test('end-to-end queues serialize a chat, run other chats, and deduplicate deliveries', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-engine-'));
  const store = new Store(join(dir, 'bot.sqlite'));
  const started: string[] = []; let live = 0; let max = 0;
  const runtime: Runtime = { async run(r) {
    started.push(r.prompt); live++; max = Math.max(max, live);
    const threadId = r.threadId ?? r.cwd; r.onThread(threadId); r.onTurn('turn');
    await new Promise(resolve => setTimeout(resolve, 40)); live--;
    return { text: 'answer', threadId, turnId: 'turn' };
  } };
  const sent: string[] = [];
  const sender: Sender = { async send(_chat, content, uuid) { if (content === 'answer') sent.push(uuid); return uuid; } };
  const engine = new Engine(store, runtime, sender, { dataDir: dir, concurrency: 2 });
  t.after(async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  engine.accept(msg('a')); engine.accept(msg('b')); engine.accept(msg('c', 'other'));
  assert.equal(started.length, 0); engine.start();
  assert.equal(engine.accept(msg('a')), false);
  await wait(() => store.get('b')?.state === 'replied');
  assert.equal(started.length, 3); assert.equal(max, 2); assert.equal(sent.length, 3);
  assert.match(started[0], /"message_id":"a"/); assert.match(started[1], /"message_id":"c"/); assert.match(started[2], /"message_id":"b"/);
});

test('cancel immediately interrupts a running request and cancels queued work', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-engine-')); const store = new Store(join(dir, 'bot.sqlite'));
  let started = 0;
  const runtime: Runtime = { run(r) { started++; return new Promise((_resolve, reject) => r.signal.addEventListener('abort', () => reject(new RuntimeError('cancelled')), { once: true })); } };
  const engine = new Engine(store, runtime, { async send(_chat, _text, uuid) { return uuid; } }, { dataDir: dir, concurrency: 2 });
  t.after(async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  engine.start(); engine.accept(msg('a')); engine.accept(msg('b')); await wait(() => started === 1);
  engine.accept(msg('cancel', 'chat', '/cancel')); await wait(() => store.get('a')?.state === 'failed' && store.get('b')?.state === 'failed');
  assert.equal(started, 1); assert.equal(store.get('cancel')?.state, 'replied');
});

test('ambiguous transport failure never re-executes the model or blindly resends', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-engine-')); const store = new Store(join(dir, 'bot.sqlite'));
  let calls = 0; let deliveries = 0;
  const runtime: Runtime = { async run() { calls++; return { text: 'answer', threadId: 't', turnId: 'r' }; } };
  const sender: Sender = { async send(_c, text, uuid) { if (text === 'answer') { deliveries++; throw new SendError(true, 'timeout'); } return uuid; } };
  const engine = new Engine(store, runtime, sender, { dataDir: dir, concurrency: 2 });
  t.after(async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  engine.start(); engine.accept(msg('a')); await wait(() => store.get('a')?.state === 'delivery_unknown');
  for (let i = 0; i < 10; i++) await engine.pump();
  assert.equal(calls, 1); assert.equal(deliveries, 1);
});

test('receipt storage failure stops dispatch and leaves sending evidence for reconciliation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-engine-')); const store = new Store(join(dir, 'bot.sqlite'));
  store.enqueue(msg('a')); store.claim('a'); store.finish('a', 'answer');
  store.db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE OF state ON outbox WHEN NEW.state='sent' BEGIN SELECT RAISE(ABORT, 'disk_error'); END");
  let deliveries = 0; let fatal = '';
  const engine = new Engine(store, { async run() { throw new Error('must not run'); } },
    { async send() { deliveries++; return 'platform-message'; } }, { dataDir: dir, concurrency: 2 }, s => s, () => {}, code => { fatal = code; });
  t.after(async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  engine.start(); await wait(() => fatal !== ''); assert.equal(fatal, 'outbox_storage_error');
  for (let i = 0; i < 5; i++) await engine.pump(); assert.equal(deliveries, 1);
  store.db.exec('DROP TRIGGER fail_receipt'); assert.equal(store.recover().unknown, 1);
});

test('directory listing is a control command and tasks always use isolated scratch',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-directory-engine-')),store=new Store(join(dir,'bot.sqlite'));
 const runs:string[]=[],engine=new Engine(store,{async run(r){runs.push(r.cwd);return {text:'answer',threadId:'t',turnId:'r'};}},{async send(_c,_t,id){return id;}},
 {dataDir:dir,concurrency:1,codex:{bin:'codex',home:join(dir,'auth'),sandbox:'workspace-write',timeoutMs:1000,directories:[dir]}});
 t.after(async()=>{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});});
 engine.accept(msg('list','chat','/directories'));assert.equal(store.get('list')?.taskId,null);
 assert.match(String(store.db.prepare("SELECT content FROM outbox WHERE inboxKey='list'").get()?.content),/可访问目录/);
 engine.accept(msg('a'));engine.start();await wait(()=>store.get('a')?.state==='replied');assert.notEqual(runs[0],dir);
});


test('natural control operations use real ownership, durable delivery and scoped sessions',t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-control-')),store=new Store(join(dir,'db'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const envelope={version:1 as const,type:'text' as const,kind:'instruction' as const,chatType:'p2p' as const,scopeKey:'chat',materials:[],limitations:[]};
 const m:Incoming={key:'app:current',messageId:'current',chatKey:'chat',chatId:'chat',senderId:'user',text:'查看任务并发送文件',envelope};
 const old:Incoming={...m,key:'app:old',messageId:'old',text:'old work'};store.enqueue(old);const tasks=new Tasks(store),workspace={cwd:dir,policyHash:'p'};
 const prior=tasks.create(store.get(old.key)!,workspace);store.db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(prior.id);
 store.enqueue(m);const current=tasks.create(store.get(m.key)!,workspace);store.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(current.id);
 const config={dataDir:dir,codex:{directories:[],denyPaths:[]},feishu:{domain:'feishu',appId:'app',allowedUserIds:['user'],allowedChatIds:[]}} as unknown as Config;
 const run=(args:unknown,call='call')=>conversationControl(store,config,m,current,args,call,x=>x,()=>true) as {result:any;error?:string};
 assert.deepEqual(run({operation:'tasks'}).result.map((x:{id:string})=>x.id),[prior.id]);
 assert.match(run({operation:'task',id:prior.id}).result,/任务/);
 assert.match(run({operation:'deliver',path:'result.pdf'},'delivery').result,/已登记/);
 assert.equal(store.db.prepare('SELECT path FROM artifact_intents WHERE taskId=?').get(current.id)?.path,'result.pdf');
 assert.match(run({operation:'deliver',path:'other.pdf'},'delivery-2').result,/已有/);
 assert.match(run({operation:'stage_material',value:'参考资料'},'material').result,/已暂存/);
 assert.equal(store.db.prepare("SELECT text FROM inbox WHERE state='material'").get()?.text,'参考资料');
 assert.match(run({operation:'stage_material',value:'参考资料'},'material').result,/已经处理/);
 assert.equal(run({operation:'set_profile',field:'name',value:'Seven'},'profile').result.name,'Seven');
 assert.match(run({operation:'set_profile',field:'name',value:'Seven'},'profile').result,/已经处理/);
 store.saveThread(tasks.sessionKey(current),'old-thread');
 assert.match(run({operation:'refresh_session'},'refresh').result,/已准备刷新/);
 tasks.finishRefresh(current);assert.ok(store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(tasks.refreshKey(current)));
 assert.equal(run({operation:'new_session'},'session').result,'已准备新会话，下一条任务将使用新上下文。');
 assert.equal(tasks.binding(m),undefined);
 const attacker={...m,senderId:'other'};
 assert.ok((conversationControl(store,config,attacker,current,{operation:'task',id:prior.id},'x',x=>x,()=>true) as {error:string}).error);
});


test('an unambiguous natural stop interrupts a running task without waiting in its queue',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-stop-natural-')),store=new Store(join(dir,'db'));let started=0;
 const engine=new Engine(store,{run(r){started++;return new Promise((_resolve,reject)=>r.signal.addEventListener('abort',()=>reject(new RuntimeError('cancelled')),{once:true}));}},
  {async send(_c,_text,id){return id;}},{dataDir:dir,concurrency:1});
 t.after(async()=>{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});});
 engine.start();engine.accept(msg('work'));await wait(()=>started===1);
 engine.accept(msg('stop','chat','请停止当前任务'));await wait(()=>new Tasks(store).get(store.get('work')!.taskId!)?.state==='cancelled');
 assert.equal(started,1);assert.equal(store.get('stop')?.text,'请停止当前任务');
 assert.equal(new Tasks(store).get(store.get('work')!.taskId!)?.state,'cancelled');
});


test('natural approval reaches a waiting operation without accepting another user',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-natural-approval-')),store=new Store(join(dir,'db'));
 const engine=new Engine(store,{async run(){throw Error('unexpected');}},{async send(_c,_t,id){return id;}},{dataDir:dir,concurrency:1});
 t.after(async()=>{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});});
 store.enqueue(msg('source'));const tasks=new Tasks(store),task=tasks.create(store.get('source')!,{cwd:dir,policyHash:'p'});store.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(task.id);
 const pending=awaitMcpApproval(store,task,'remote','https://example.com/mcp','write',{},'scope',new AbortController().signal,()=>true);
 const key=String(store.db.prepare("SELECT key FROM settings WHERE key LIKE 'mcp-approval:%'").get()?.key),id=key.slice('mcp-approval:'.length);
 engine.accept({...msg('other','chat',`确认操作 ${id}`),senderId:'other'});
 assert.equal(JSON.parse(String(store.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value)).state,'pending');
 engine.accept({...msg('approved','chat',`确认操作 ${id}`),envelope:{version:1,type:'text',kind:'instruction',chatType:'p2p',scopeKey:'chat',parentId:'approval-card',materials:[],limitations:[]}});const finalize=await pending;finalize('completed');
 assert.equal(JSON.parse(String(store.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value)).state,'completed');
});
