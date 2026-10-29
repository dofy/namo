import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Incoming } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Schedules } from '../src/schedules.js';
import { waitFor } from './helpers.js';

function message(key:string,text:string,senderId='user'):Incoming {return {key,messageId:key,chatKey:'chat',chatId:'chat',senderId,text,envelope:{version:1,type:'text',kind:'instruction',chatType:'p2p',scopeKey:'chat',materials:[],limitations:[]}};}

test('schedules are owned, scoped, durable and missed occurrences are coalesced',t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-schedule-')),store=new Store(join(dir,'db'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const m=message('create','/schedule add reminder daily 2030-01-01T09:00+08:00 drink water');store.enqueue(m);
 const schedules=new Schedules(store); const now=Date.parse('2029-12-31T00:00Z');
 const reply=schedules.command(m,()=>({}),now)!;const id=/S-[A-F0-9]{12}/.exec(reply)![0];
 assert.match(schedules.command(message('other',`/schedule delete ${id}`,'other'),()=>({}),now)!,/未找到/);
 const first=Date.parse('2030-01-01T01:00Z'); let count=0;
 schedules.due(first+3*86400000,()=>{count++;}); schedules.due(first+3*86400000,()=>{count++;});assert.equal(count,1);
 assert.equal(store.db.prepare('SELECT nextAt FROM schedules WHERE id=?').get(id)?.nextAt,first+4*86400000);
 assert.match(schedules.command(message('pause',`/schedule pause ${id}`),()=>({}),now)!,/暂停/);
 schedules.due(first+5*86400000,()=>{count++;});assert.equal(count,1);
 assert.match(schedules.command(message('resume',`/schedule resume ${id}`),()=>({}),first+5*86400000)!,/恢复/);
 assert.equal(store.db.prepare('SELECT nextAt FROM schedules WHERE id=?').get(id)?.nextAt,first+6*86400000);
});

test('due reminders and tasks use durable outbox and ordinary task engine',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-schedule-')),store=new Store(join(dir,'db'));let calls=0;const sent:string[]=[];
 const engine=new Engine(store,{async run(){calls++;return {text:'task done',threadId:'t',turnId:'r'};}},{async send(_c,text,uuid,route){assert.equal(route,undefined);sent.push(text);return uuid;}},{dataDir:dir,concurrency:1,feishu:{allowedUserIds:['user'],allowedChatIds:[],progressUpdates:false,reactions:false}});
 t.after(async()=>{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});});
 for(const [key,kind] of [['a','reminder'],['b','task']]){
  const m=message(key,`/schedule add ${kind} once 2030-01-01T09:00+08:00 hello ${kind}`);store.enqueue(m);assert.match(new Schedules(store).command(m,()=>({}),Date.parse('2029-01-01'))!,/已创建/);
 }
 // Bind the task to the actual project policy selected by the engine.
 const source=store.get('b')!;const bound=(engine as unknown as {project(m:Incoming):unknown}).project(source);
 store.db.prepare("UPDATE schedules SET binding=?,nextAt=? WHERE kind='task'").run(JSON.stringify(bound),Date.now()-1);
 store.db.prepare("UPDATE schedules SET nextAt=? WHERE kind='reminder'").run(Date.now()-1);
 store.db.prepare("UPDATE inbox SET state='replied' WHERE key IN ('a','b')").run();
 engine.start();await waitFor(()=>sent.includes('task done')&&sent.some(x=>x.includes('定时提醒')),5000);
 assert.equal(calls,1);assert.equal(store.db.prepare("SELECT COUNT(*) n FROM schedules WHERE state='completed'").get()?.n,2);
});

test('version 13 upgrades in place and keeps existing rows', t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-schedule-migrate-')),path=join(dir,'db');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const old=new Store(path);old.enqueue(message('kept','hello'));old.db.exec('DROP TABLE schedules; PRAGMA user_version=13');old.close();
 const upgraded=new Store(path);assert.equal(upgraded.get('kept')?.text,'hello');assert.equal(upgraded.db.prepare('PRAGMA user_version').get()?.user_version,14);
 assert.deepEqual(upgraded.db.prepare('PRAGMA foreign_key_check').all(),[]);upgraded.close();
});

test('rejects invalid calendar dates and untrusted group commands',t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-schedule-')),store=new Store(join(dir,'db'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const m=message('invalid','/schedule add reminder once 2030-02-30T09:00+08:00 hello');
 assert.match(new Schedules(store).command(m,()=>({}),Date.parse('2029-01-01'))!,/无效/);
 m.envelope!.chatType='group';assert.match(new Schedules(store).command(m,()=>({}))!,/私聊/);
});

test('accepts a direct rich-text command but rejects attached content',t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-schedule-')),store=new Store(join(dir,'db'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const m=message('post','/schedule add reminder once 2030-01-01T09:00+08:00 hello');m.envelope!.type='post';store.enqueue(m);
 assert.match(new Schedules(store).command(m,()=>({}),Date.parse('2029-01-01'))!,/已创建/);
 const attached=message('attached',m.text);attached.envelope!.type='post';attached.envelope!.materials=[{type:'image'}];
 assert.match(new Schedules(store).command(attached,()=>({}),Date.parse('2029-01-01'))!,/单独发送/);
});

test('trigger and schedule cursor roll back together on persistence failure',t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-schedule-')),store=new Store(join(dir,'db'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const m=message('origin','/schedule add reminder daily 2030-01-01T09:00+08:00 hello');store.enqueue(m);
 const s=new Schedules(store);s.command(m,()=>({}),Date.parse('2029-01-01'));
 const due=Date.parse('2030-01-01T01:00Z');
 assert.throws(()=>s.due(due,()=>{store.enqueue(message('synthetic','hello'));throw new Error('storage failed');}),/storage failed/);
 assert.equal(store.get('synthetic'),undefined);assert.equal(store.db.prepare('SELECT nextAt FROM schedules').get()?.nextAt,due);
 let calls=0;s.due(due,()=>{calls++;});assert.equal(calls,1);
});

test('revoked user cannot trigger a saved reminder after restart',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-schedule-')),store=new Store(join(dir,'db'));const source=message('origin','/schedule add reminder daily 2030-01-01T09:00+08:00 hello');store.enqueue(source);
 new Schedules(store).command(source,()=>({}),Date.parse('2029-01-01'));store.db.prepare("UPDATE schedules SET nextAt=?").run(Date.now()-1);store.db.prepare("UPDATE inbox SET state='replied'").run();
 let sent=0;const engine=new Engine(store,{async run(){throw new Error('unexpected');}},{async send(){sent++;return 'id';}},{dataDir:dir,concurrency:1,feishu:{allowedUserIds:[],allowedChatIds:[]}});
 t.after(async()=>{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});});engine.start();
 await waitFor(()=>store.db.prepare('SELECT state FROM schedules').get()?.state==='paused',3000);assert.equal(sent,0);
});
