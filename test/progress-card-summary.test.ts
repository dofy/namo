import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { recordProgress, progressTotals, readProgress, type PublicProgressEvent } from '../src/public-progress.js';
import { progressState, recordActivity } from '../src/feedback.js';
import { renderTaskCard } from '../src/cards.js';

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
