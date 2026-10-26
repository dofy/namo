import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { Profiles } from '../src/profiles.js';
import { Browse, BrowseError } from '../src/browse.js';
import { Management } from '../src/management.js';
import { startUi } from '../src/ui.js';
import { makeRedactor } from '../src/safety.js';
import type { TaskList } from '../src/ui-contract.js';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-browse-')), file = join(dir, 'config.json'), project = join(dir, 'project');
  mkdirSync(project);
  const store = new Store(join(dir, 'bot.sqlite')), tasks = new Tasks(store);
  store.bindAccount('app');
  writeFileSync(file, JSON.stringify({ dataDir:dir, feishu:{appId:'app',appSecret:'TEST_ONLY_SECRET_123',allowedUserIds:['alice','bob']}, codex:{bin:'codex',home:join(dir,'home'),sandbox:'read-only',projects:{app:project},defaultProject:'app'} }));
  const manager = new Management(file, { status: () => ({ running:false,installed:false,registered:false,mode:'stopped' }) });
  const view = () => new Browse(store, { appId:'app',channel:'feishu' }, makeRedactor(['TEST_ONLY_SECRET_123']));
  let seq = 0;
  function add(input: { text?:string; owner?:string; project?:string|null; at?:number; state?:string; start?:number|null; end?:number|null; chat?:string } = {}) {
    const key = `m-${++seq}`, owner = input.owner ?? 'alice', chat = input.chat ?? owner;
    store.enqueue({ key, messageId:key,chatId:chat,chatKey:chat,senderId:owner,text:input.text ?? `任务 ${seq}`,createdAt:input.at ?? Date.now() });
    const task = tasks.create(store.get(key)!, { project:input.project === null ? undefined : input.project ?? 'app',cwd:input.project === null ? dir : project,policyHash:'p' });
    store.db.prepare('UPDATE tasks SET state=?,startedAt=?,finishedAt=? WHERE id=?').run(input.state ?? 'queued',input.start ?? null,input.end ?? null,task.id);
    return task;
  }
  t.after(() => {store.close();rmSync(dir,{recursive:true,force:true});});
  return { store,tasks,manager,view,add,dir };
}
const q = (s = '') => new URLSearchParams(s);

test('task browsing filters the entire history, paginates with a stable tie-break, and clamps out-of-range pages', t => {
  const f=fixture(t), ids:string[]=[];
  for(let i=0;i<121;i++) ids.push(f.add({ text:i===0?'早期针尖 100%_literal':'常规任务',owner:i%2?'bob':'alice',state:i%3?'succeeded':'queued',at:1000,start:i%3?2000:null,end:i%3?3000:null }).id);
  const page=f.view().tasks(q()); assert.equal(page.total,121); assert.equal(page.items.length,25);assert.equal(page.pages,5);assert.equal(page.items[0].id,ids[120]);
  const all=Array.from({length:5},(_,i)=>f.view().tasks(q(`page=${i+1}`)).items).flat();
  assert.equal(new Set(all.map(x=>x.id)).size,121);
  assert.equal(f.view().tasks(q('sort=oldest')).items[0].id,ids[0]);
  const old=f.view().tasks(q('q=针尖&owner=alice&project=named:app&state=queued'));
  assert.equal(old.total,1);assert.equal(old.items[0].id,ids[0]);assert.equal(old.items[0].startedAt,null);
  assert.equal(f.view().tasks(q('q=100%25_literal')).total,1);
  assert.equal(f.view().tasks(q("q=' OR 1=1 --")).total,0);
  assert.equal(f.view().tasks(q('owner=missing')).total,0);
  assert.equal(f.view().tasks(q('page=900')).page,5);assert.equal(f.view().tasks(q('page=900')).items.length,21);
  assert.equal(f.view().tasks(q('pageSize=100')).items.length,100);
});

test('date filters respect calendar-day boundaries and independently select created, started and finished times', t => {
  const f=fixture(t), start=new Date(2026,9,20).getTime(), next=new Date(2026,9,21).getTime();
  const a=f.add({at:start-1,start:start,end:next-1,state:'succeeded'});
  const b=f.add({at:start,start:next,end:next+10,state:'succeeded'});
  f.add({at:next});
  const date='from=2026-10-20&to=2026-10-20';
  assert.deepEqual(f.view().tasks(q(date)).items.map(x=>x.id),[b.id]);
  assert.deepEqual(f.view().tasks(q(`${date}&dateField=started`)).items.map(x=>x.id),[a.id]);
  assert.deepEqual(f.view().tasks(q(`${date}&dateField=finished`)).items.map(x=>x.id),[a.id]);
  for(const query of ['page=-1','page=1e2','pageSize=1000','pageSize=26','state=nonsense','sort=drop','from=2026-02-30','from=2026-10-21&to=2026-10-20','dateField=SQL','workstream=bad','page=1&page=2','q='+ 'x'.repeat(201)]) assert.throws(()=>f.view().tasks(q(query)),BrowseError,query);
});

test('sessions have first/latest task context, current binding, accurate activity and uncapped history', t => {
  const f=fixture(t);
  new Profiles(f.store,{channel:'feishu',appId:'app',userId:'alice'}).update(0,{name:'小七'},{source:'local-owner'});
  const first=f.add({text:'设计导出流程',at:100,state:'succeeded',start:101,end:200});
  const second=f.add({text:'补充中文字段',at:300,state:'waiting',start:310});
  assert.equal(first.workstreamId,second.workstreamId);
  f.store.enqueue({key:'reply',messageId:'reply',chatId:'alice',chatKey:'alice',senderId:'alice',text:'改成英文',createdAt:900});
  f.store.db.prepare("INSERT INTO task_messages VALUES(?,?,'amendment',2,'pending')").run(second.id,'reply');
  for(let i=0;i<40;i++)f.add({chat:`new-${i}`,owner:'bob',text:`其他 ${i}`});
  const page=f.view().sessions(q());assert.equal(page.total,41);assert.equal(page.items.length,25);
  const session=f.view().sessions(q('q=设计导出&owner=alice')).items[0];
  assert.equal(session.title,'设计导出流程');assert.equal(session.latestTitle,'补充中文字段');assert.equal(session.ownerName,'小七');assert.equal(session.taskCount,2);assert.equal(session.state,'waiting');assert.equal(session.current,true);assert.equal(session.lastActiveAt,900);
  const history=f.view().tasks(q(`workstream=${session.id}`));assert.equal(history.total,2);assert.equal(history.session?.title,session.title);
  assert.equal(f.view().sessions(q('state=waiting')).total,1);
  f.tasks.reset({key:'reset',messageId:'reset',chatId:'alice',chatKey:'alice',senderId:'alice',text:'/new'});
  assert.equal(f.view().sessions(q('owner=alice&state=current')).total,0);
  assert.equal(f.view().sessions(q('owner=alice')).total,1);
});

test('titles and names are scoped and redacted; missing names stay explicit and isolation can be filtered', t => {
  const f=fixture(t);f.add({text:'包含 TEST_ONLY_SECRET_123 的任务',project:null});
  new Profiles(f.store,{channel:'feishu',appId:'app',userId:'alice'}).update(0,{name:'正确称呼'},{source:'local-owner'});
  f.store.db.prepare("INSERT INTO user_profiles VALUES('lark','other','alice','不可泄露其他应用的名字','','',1,1)").run();
  const list=f.view().tasks(q('project=isolated'));assert.equal(list.total,1);assert.equal(list.items[0].ownerName,'正确称呼');assert.match(list.items[0].title,/REDACTED/);
  assert.doesNotMatch(JSON.stringify(list),/TEST_ONLY_SECRET_123|不可泄露/);
  f.add({owner:'bob',project:'other'});assert.equal(f.view().tasks(q('owner=bob')).items[0].ownerName,'');
  assert.deepEqual(f.view().options(),{users:[{id:'alice',name:'正确称呼'},{id:'bob',name:''}],projects:['other']});
});

test('dashboard aggregates all records, uses finish dates for results, excludes cancellation and preserves empty denominators', t => {
  const f=fixture(t), today=new Date(2026,9,26).getTime(), now=today+12*3600000, old=today-10*86400000;
  const empty=f.view().dashboard(now);assert.equal(empty.totalTasks,0);assert.equal(empty.successRate,null);assert.equal(empty.averageDurationMs,null);assert.equal(empty.daily.length,7);assert.ok(empty.daily.every(x=>x.count===0));
  for(let i=0;i<105;i++)f.add({at:today+100+i,start:today+1000,end:today+2000,state:'succeeded'});
  f.add({at:old,start:old,end:today+3000,state:'failed',owner:'bob'});
  f.add({at:today+200,state:'cancelled',start:today+1000,end:today+4000});
  f.add({at:today+201,state:'waiting',start:today+1000});f.add({at:today+202,state:'running',start:today+1000});f.add({at:today+203,state:'queued'});
  const task=f.add({at:old,state:'succeeded',start:old,end:old+5000});f.store.addOutput(task.inboxKey,'result','answer');f.store.db.prepare("UPDATE outbox SET state='unknown'").run();
  const d=f.view().dashboard(now);assert.equal(d.totalTasks,111);assert.equal(d.completedToday,105);assert.equal(d.successRate,105/106);assert.equal(d.averageDurationMs,1000);
  assert.equal(d.daily[6].count,109);assert.equal(d.daily.reduce((n,x)=>n+x.count,0),109);assert.equal(d.running,1);assert.equal(d.waiting,1);assert.equal(d.queued,1);assert.equal(d.activeUsers,1);assert.equal(d.failed,1);assert.equal(d.deliveryIssues,1);assert.equal(d.recent.length,5);
});

test('new browse HTTP endpoints retain auth and input guards and do not mutate existing data or schemas', async t => {
  const f=fixture(t);f.add({text:'检索 TEST_ONLY_SECRET_123'});
  const ui=await startUi(f.manager);t.after(()=>ui.close());
  for(const path of ['/api/tasks','/api/sessions','/api/dashboard','/api/browse-options'])assert.equal((await fetch(ui.url+path)).status,401);
  const login=await fetch(ui.url+'/api/session',{method:'POST',headers:{Origin:ui.url,'Content-Type':'application/json'},body:JSON.stringify({code:new URL(ui.entryUrl).hash.slice(1)})});
  const cookie=login.headers.get('set-cookie')!, before=readFileSync(join(f.dir,'bot.sqlite'));
  for(const path of ['/api/tasks','/api/sessions','/api/dashboard','/api/browse-options']){
    const response=await fetch(ui.url+path,{headers:{Cookie:cookie}});assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/TEST_ONLY_SECRET_123/);
  }
  assert.equal((await fetch(ui.url+'/api/tasks?pageSize=10000',{headers:{Cookie:cookie}})).status,400);
  assert.equal((await fetch(ui.url+'/api/tasks',{headers:{Cookie:cookie,'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((f.manager.browse('tasks') as TaskList).total,1);assert.deepEqual(readFileSync(join(f.dir,'bot.sqlite')),before);
});
