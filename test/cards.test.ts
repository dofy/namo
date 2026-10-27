import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { Cards, renderTaskCard } from '../src/cards.js';
import { Engine, SendError } from '../src/engine.js';
import { recordProgress, progressTotals, readProgress, type PublicProgressEvent } from '../src/public-progress.js';
import { progressState, recordActivity } from '../src/feedback.js';

const input={key:'first',messageId:'first',senderId:'alice',chatKey:'chat',chatId:'chat',text:'request'};
function setup(t:any){const dir=mkdtempSync(join(tmpdir(),'namo-cards-')),s=new Store(join(dir,'bot.sqlite'));t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});s.enqueue(input);const tasks=new Tasks(s),task=tasks.create(s.get('first')!,{cwd:'/tmp',policyHash:'policy'});s.addOutput('first','progress','<script>alert(1)</script> @all');const out=s.nextOutput()!,cards=new Cards(s);cards.prepare(out);s.sending(out.id);s.sent(out.id,'platform');const tokens=s.db.prepare('SELECT action,token FROM card_actions').all();const event=(action:string)=>({operator:{open_id:'alice'},context:{open_chat_id:'chat',open_message_id:'platform'},action:{value:{namo:String(tokens.find(x=>x.action===action)!.token)}}});return {s,tasks,task,cards,out,event};}
test('cards render untrusted text as plain text, freeze payload and validate callback identity',t=>{const f=setup(t),p=JSON.parse(String(f.s.db.prepare('SELECT payload FROM outbox').get()?.payload));assert.equal(p.elements[0].text.tag,'plain_text');assert.match(p.elements[0].text.content,/<script>/);const e=f.event('cancel');assert.equal(f.cards.accept({...e,operator:{open_id:'bob'}}).toast.type,'error');assert.equal(f.cards.accept({...e,context:{...e.context,open_message_id:'wrong'}}).toast.type,'error');assert.equal(f.tasks.get(f.task.id)?.state,'queued');assert.equal(f.cards.accept(e).toast.type,'info');assert.equal(f.tasks.get(f.task.id)?.state,'cancelled');assert.match(f.cards.accept(e).toast.content,/已经处理/);assert.equal(f.s.db.prepare("SELECT COUNT(*) n FROM outbox WHERE kind='result'").get()?.n,1);});
test('expired, revised and terminal task cards cannot cancel',t=>{const f=setup(t),e=f.event('cancel');f.s.db.prepare('UPDATE card_actions SET expiresAt=0').run();assert.equal(f.cards.accept(e).toast.type,'error');f.s.db.prepare('UPDATE card_actions SET expiresAt=?').run(Date.now()+10000);f.s.db.prepare('UPDATE tasks SET inputVersion=2').run();assert.equal(f.cards.accept(e).toast.type,'error');f.s.db.prepare("UPDATE tasks SET inputVersion=1,state='succeeded'").run();assert.equal(f.cards.accept(e).toast.type,'error');assert.equal(f.tasks.get(f.task.id)?.state,'succeeded');});
for(const kind of ['validation','unknown','rejected'] as const)test(`card ${kind} failure only falls back when explicitly safe`,async t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-card-send-')),s=new Store(join(dir,'bot.sqlite'));let calls=0,cards=0,texts=0;const e=new Engine(s,{async run(r){calls++;r.onEvidence?.({id:'check',kind:'command',label:'pnpm test',status:'completed',exitCode:0});return {text:'answer',threadId:'t',turnId:'u'};}},{async send(_c,_text,id){texts++;return id;},async sendCard(){cards++;throw new SendError(kind==='unknown',kind==='validation'?'feishu_230099':kind==='unknown'?'timeout':'feishu_999');}},{dataDir:dir,concurrency:1,feishu:{cards:true}});
 t.after(async()=>{await e.stop();s.close();rmSync(dir,{recursive:true,force:true});});e.start();e.accept(input);const end=Date.now()+5000;while(!['replied','delivery_unknown','delivery_failed'].includes(s.get('first')?.state??'')){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,10));}assert.equal(calls,1);assert.equal(cards,1);assert.equal(texts,kind==='validation'?1:0);assert.equal(s.get('first')?.state,kind==='validation'?'replied':kind==='unknown'?'delivery_unknown':'delivery_failed');
});

function fixture(t:{after(fn:()=>void):void}) {
  const dir=mkdtempSync(join(tmpdir(),'namo-card-summary-')),store=new Store(join(dir,'db'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.enqueue({key:'message',messageId:'original',chatId:'chat',chatKey:'chat',senderId:'owner',text:'work'});
  const tasks=new Tasks(store),task=tasks.create(store.get('message')!,{cwd:dir,policyHash:'policy'}),run=tasks.start(task);
  const start=Date.parse('2026-10-27T04:12:51Z');
  store.db.prepare('UPDATE tasks SET startedAt=? WHERE id=?').run(start,task.id);
  const event=(id:string,status:PublicProgressEvent['status'],outcome?:PublicProgressEvent['outcome'])=>
    recordProgress(store,run,{id,kind:'tool',status,text:'命令：'+status,...(outcome?{outcome}:{})});
  return {store,tasks,task,run,start,event};
}

test('progress uses explicit local time and literal public text within a Markdown layout',t=>{
  const f=fixture(t);recordActivity(f.store,f.run,'working');
  recordProgress(f.store,f.run,{id:'comment',kind:'commentary',status:'completed',text:'已检查 **unsafe** [link](javascript:bad) <at user_id="all">hello</at>'});
  const state=progressState(f.store,f.tasks.get(f.task.id)!,f.start+52_000,'Asia/Shanghai');
  assert.match(state.content,/2026-10-27 12:12:51/);assert.match(state.content,/Asia\/Shanghai/);
  assert.doesNotMatch(state.content,/04:12:51|UTC|<at/);assert.match(state.content,/52 秒/);
  assert.ok(state.content.includes('\\*\\*unsafe\\*\\*'));
  const card=renderTaskCard(f.tasks.get(f.task.id)!,state.content,'progress',0) as any;
  assert.equal(card.elements[0].tag,'markdown');assert.match(card.elements[0].content,/\*\*最近进展\*\*/);
  const newYork=progressState(f.store,f.tasks.get(f.task.id)!,f.start+52_000,'America/New_York');
  assert.match(newYork.content,/2026-10-27 00:12:51/);
});

test('terminal summary removes progress and counts tools across runs, not claims in commentary',t=>{
  const f=fixture(t);
  recordProgress(f.store,f.run,{id:'plan',kind:'plan',status:'running',text:'计划：1/2',plan:{total:2,completed:1,running:1}});
  f.event('a','running');f.event('a','completed','success');f.event('a','completed','success');
  f.event('b','failed','failure');f.event('c','completed','unknown');f.event('d','running');
  for(let i=0;i<6;i++)recordProgress(f.store,f.run,{id:'comment'+i,kind:'commentary',status:'completed',text:'私人进展：86项测试全部成功'});
  assert.ok(!readProgress(f.store,f.run)!.events.some(e=>e.kind==='plan'));
  f.store.db.prepare("UPDATE task_runs SET state='waiting' WHERE id=?").run(f.run);
  f.store.db.prepare("INSERT INTO task_runs(id,taskId,inputVersion,state,startedAt) VALUES('resumed',?,2,'running',?)").run(f.task.id,f.start+60_000);
  recordProgress(f.store,'resumed',{id:'a',kind:'tool',status:'completed',text:'第二轮命令结束',outcome:'success'});
  assert.deepEqual(progressTotals(f.store,f.task.id),{total:5,succeeded:2,failed:1,unknown:2,plan:{total:2,completed:1,running:1},limited:false});
  f.store.db.prepare("UPDATE tasks SET state='succeeded',finishedAt=? WHERE id=?").run(f.start+100_000,f.task.id);
  const state=progressState(f.store,f.tasks.get(f.task.id)!,f.start+200_000,'Asia/Shanghai');
  assert.match(state.content,/总用时：1 分 40 秒/);assert.match(state.content,/1 \/ 2 已完成/);
  assert.match(state.content,/成功 2 · ❌ 失败 1 · ⚪ 未确认 2/);
  assert.doesNotMatch(state.content,/最近进展|最近活动|状态核对|私人进展|86项/);
  const card=renderTaskCard(f.tasks.get(f.task.id)!,state.content,'progress',0) as any;
  assert.equal(card.header.template,'green');assert.equal(card.elements[0].tag,'markdown');
});

test('bounded and legacy projections label incomplete statistics explicitly',t=>{
  const f=fixture(t);
  for(let i=0;i<270;i++)f.event('tool'+i,'completed','success');
  assert.equal(progressTotals(f.store,f.task.id).total,256);assert.equal(progressTotals(f.store,f.task.id).limited,true);
  f.store.db.prepare("UPDATE tasks SET state='failed',finishedAt=? WHERE id=?").run(f.start+120_000,f.task.id);
  const state=progressState(f.store,f.tasks.get(f.task.id)!);
  assert.match(state.content,/记录有限|不能视为完整总量/);assert.match(state.content,/未提供结构化计划/);
  assert.doesNotMatch(state.content,/最近进展/);
  const report=readProgress(f.store,f.run)!;
  delete report.limited;for(const entry of report.seen){delete entry.kind;delete entry.outcome;}
  f.store.db.prepare('UPDATE run_progress SET report=? WHERE runId=?').run(JSON.stringify(report),f.run);
  assert.equal(progressTotals(f.store,f.task.id).limited,true);assert.equal(progressTotals(f.store,f.task.id).succeeded,0);
});

test('active and ended duplicates compact visually without losing factual tool counts',t=>{
  const f=fixture(t);f.event('first','completed','success');f.event('second','completed','success');
  const state=progressState(f.store,f.tasks.get(f.task.id)!);
  assert.match(state.content,/✅.*× 2/);assert.equal(progressTotals(f.store,f.task.id).total,2);
  for(const terminal of ['cancelled','interrupted']){
    f.store.db.prepare('UPDATE tasks SET state=?,finishedAt=? WHERE id=?').run(terminal,f.start+3601_000,f.task.id);
    const ended=progressState(f.store,f.tasks.get(f.task.id)!);
    assert.match(ended.content,/1 小时 0 分 1 秒/);assert.doesNotMatch(ended.content,/最近进展/);
  }
});

test('malformed plan metadata cannot produce invented step counts',t=>{
  const f=fixture(t);
  for(const plan of [[],{total:3,completed:1},{total:1,completed:2,running:0},{total:2,completed:1,running:0,extra:9}]){
    recordProgress(f.store,f.run,{id:'bad-plan',kind:'plan',status:'completed',text:'malformed plan',plan} as PublicProgressEvent);
  }
  assert.equal(readProgress(f.store,f.run),undefined);
});
