import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { Waits } from '../src/waits.js';
import { Cards } from '../src/cards.js';
import { RuntimeError } from '../src/runtime.js';

function fixture(t: any, choices?: string[]) {
  const dir=mkdtempSync(join(tmpdir(),'namo-choice-')),file=join(dir,'bot.sqlite'),s=new Store(file);
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
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
  const f=fixture(t,['中文','英文']);
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
  const f=fixture(t,['中文','英文']),event=f.event('answer:0');
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

test('legacy open questions stay text-answerable and schema 6 waiting rows survive the choices migration',t=>{
  const f=fixture(t);assert.equal(f.payload.elements.filter((e:any)=>e.tag==='action').length,1);
  f.s.db.exec('ALTER TABLE task_waits DROP COLUMN choices; PRAGMA user_version=6');
  const upgraded=new Store(f.file);try {
    const waits=new Waits(upgraded),w=waits.get(f.id)!;assert.equal(w.state,'open');assert.equal(w.choices,undefined);
    const input={key:'reply',messageId:'reply',chatId:'chat',chatKey:'chat',senderId:'alice',text:'自由回答',
      envelope:{version:1 as const,type:'text',kind:'instruction' as const,scopeKey:'topic-one',materials:[],limitations:[]}};
    upgraded.enqueue(input);waits.answer(w,input,input.text);assert.equal(waits.get(f.id)?.state,'answered');
  }finally{upgraded.close();}
});

test('bad structured choices are rejected before creating any durable wait',t=>{
  for(const choices of [[],['only'],['a','a'],[' a','b'],['a\nb','c'],['a'.repeat(81),'b']]) {
    assert.throws(()=>fixture(t,choices),(e:unknown)=>e instanceof RuntimeError&&e.code==='wait_invalid_choices');
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
