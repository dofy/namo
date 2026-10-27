import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, type Sender } from '../src/engine.js';
import { Store, type Incoming } from '../src/store.js';
import type { Runtime, RunRequest, RunResult } from '../src/runtime.js';
import { RuntimeError } from '../src/runtime.js';
import { parseConfig } from '../src/config.js';
import { Tasks } from '../src/tasks.js';
import { Waits } from '../src/waits.js';

const wait = async (condition: () => boolean) => {
  const end = Date.now()+5000;
  while(!condition()) { if(Date.now()>end)throw new Error('condition_timeout'); await new Promise(r=>setTimeout(r,10)); }
};
const gate = () => { let release!:()=>void; const promise=new Promise<void>(r=>{release=r;}); return {promise,release}; };
const message = (key:string):Incoming => ({key,messageId:'om_'+key,chatId:'chat',chatKey:'app:chat',senderId:'owner',text:'do work',
  envelope:{version:1,type:'text',kind:'instruction',scopeKey:'app:chat:thread:root',threadId:'root',materials:[],limitations:[]}});
function fixture(t:{after(fn:()=>Promise<void>):void},sender:Sender) {
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
  const f=fixture(t,{async send(){return 'text';},async sendCard(_chat,_card,_uuid,route){
    assert.deepEqual(route,{messageId:'om_first',thread:true});cards++;return 'first-card';},
    async react(){reactions++;await reaction.promise;return 'reaction';}});
  assert.equal(parseConfig({},join(f.dir,'config.json')).feishu.progressDelayMs,200);
  f.engine.start();f.engine.accept(message('first'));
  await wait(()=>cards===1);assert.equal(reactions,1);assert.ok(f.request());
  const output=f.store.db.prepare("SELECT sendStartedAt,acceptedAt,createdAt FROM outbox WHERE kind='progress'").get()!;
  assert.ok(Number(output.acceptedAt)>=Number(output.sendStartedAt));
  assert.ok(Number(output.sendStartedAt)>=Number(output.createdAt));
  reaction.release();f.finish();await wait(()=>f.store.get('first')?.state==='replied');assert.equal(cards,1);
});

test('final answer delivery does not wait for a slow progress patch; same card is terminally corrected',async t=>{
  const patch=gate();const cards:object[]=[],updates:object[]=[],texts:string[]=[];
  t.after(async()=>{patch.release();});
  const f=fixture(t,{async send(_chat,text){texts.push(text);return 'final';},async sendCard(_chat,card){cards.push(card);return 'live-card';},
    async updateCard(id,card){assert.equal(id,'live-card');updates.push(card);if(updates.length===1)await patch.promise;}});
  f.engine.start();f.engine.accept(message('slow-patch'));await wait(()=>cards.length===1);
  f.request()!.onProgress?.({id:'step',kind:'commentary',status:'completed',text:'已定位入口，正在检查相关实现。'});
  await f.engine.pump();await wait(()=>updates.length===1);
  f.finish();await wait(()=>texts.some(text=>text.startsWith('final answer')));
  assert.equal(updates.length,1);assert.equal(f.store.get('slow-patch')?.state,'replied');
  patch.release();await wait(()=>updates.length===2);assert.match(JSON.stringify(updates[1]),/已完成/);
  assert.equal(cards.length,1);
});

test('a queued task gets readable feedback before the occupied executor is available',async t=>{
  const routes:string[]=[];
  const f=fixture(t,{async send(){return 'text';},async sendCard(_chat,card,_uuid,route){
    routes.push(route!.messageId);if(route!.messageId==='om_queued')assert.match(JSON.stringify(card),/正在排队|排队中/);return route!.messageId;}});
  f.engine.start();f.engine.accept(message('active'));await wait(()=>!!f.request());
  f.engine.accept(message('queued'));await wait(()=>routes.includes('om_queued'));
  const queued=f.store.get('queued')!;assert.equal(queued.state,'queued');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM task_runs').get()?.n,1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE inboxKey='queued' AND kind='progress'").get()?.n,1);
});

test('wait/resume reuses the original progress intent, including a wait before the first card',async t=>{
  for(const sent of [false,true])await t.test(String(sent),t=>{
    const dir=mkdtempSync(join(tmpdir(),'namo-progress-resume-')),store=new Store(join(dir,'db'));
    t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
    store.enqueue(message('original'));
    const tasks=new Tasks(store),task=tasks.create(store.get('original')!,{cwd:dir,policyHash:'policy'});
    store.addOutput('original','progress','已收到');
    const output=store.nextOutput()!;
    if(sent){store.sending(output.id);store.sent(output.id,'original-live-card');}
    else store.db.prepare("UPDATE outbox SET state='deferred' WHERE id=?").run(output.id);
    const run=tasks.start(task);tasks.saveRun(run,'thread','turn');
    const waits=new Waits(store),request={threadId:'thread',turnId:'turn',callId:'question',question:'请选择'};
    const id=waits.request(task.id,run,request);waits.park(task,run,{...request,id});tasks.progress();
    assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=?').get(output.id)?.state,sent?'sent':'suppressed');
    const reply=message('reply');store.enqueue(reply);waits.answer(waits.get(id)!,reply,'继续');
    tasks.start(tasks.get(task.id)!);tasks.progress(Date.now()+1000);
    const original=store.db.prepare('SELECT * FROM outbox WHERE id=?').get(output.id)!;
    assert.equal(original.state,sent?'sent':'pending');
    assert.equal(original.platformId,sent?'original-live-card':null);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='progress'").get()?.n,1);
    assert.deepEqual(JSON.parse(String(original.route)),{messageId:'om_original',thread:true});
  });
});
