import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { Feedback, recordActivity, progressState } from '../src/feedback.js';
import { richPost, splitDisplay, fenceState } from '../src/richtext.js';

function fixture(t:{after(fn:()=>void):void}){const dir=mkdtempSync(join(tmpdir(),'namo-feedback-'));const store=new Store(join(dir,'db'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
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
  f.store.db.prepare("UPDATE tasks SET state='succeeded',finishedAt=? WHERE id=?").run(Date.now(),f.task.id);await feedback.tick({cadenceMs:0});await feedback.tick({cadenceMs:0});assert.equal(cards.length,2);assert.match(JSON.stringify(cards[1]),/已完成/);
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
  const active=feedback.tick();await new Promise(resolve=>setImmediate(resolve));
  f.store.db.prepare("UPDATE tasks SET state='succeeded',finishedAt=? WHERE id=?").run(Date.now(),f.task.id);
  let fenced=false;const final=feedback.finalize(f.task.id).then(()=>{fenced=true;});assert.equal(fenced,false);release();await active;await final;
  assert.equal(cards.length,2);assert.match(JSON.stringify(cards.at(-1)),/已完成/);assert.equal(fenced,true);
});

test('empty result retains its raw source and still reaches a terminal delivery state',t=>{
  const f=fixture(t);f.store.claim('m');f.store.finish('m','');const output=f.store.nextOutput()!;assert.ok(output.content);
  f.store.sending(output.id);f.store.sent(output.id,'empty-result');assert.equal(f.store.get('m')?.state,'replied');assert.equal(f.store.db.prepare('SELECT content FROM output_sources').get()?.content,'');
});
