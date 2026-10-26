import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store,type Incoming} from '../src/store.js';import {memoryCommand} from '../src/memory-commands.js';
const message=(text:string):Incoming=>({key:'app:original',messageId:'original',chatKey:'app:chat',chatId:'chat',senderId:'owner',text,envelope:{version:1,type:'text',kind:'instruction',chatType:'p2p',scopeKey:'app:chat',materials:[],limitations:[]}});
test('explicit private memory commands preserve ownership, version conflicts and deletion',t=>{
 const root=mkdtempSync(join(tmpdir(),'namo-memory-command-')),store=new Store(join(root,'db'));t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const run=(text:string)=>memoryCommand(store,message(text),['owner'],'project',x=>x)!;
 assert.match(run('/remember owner concise answers'),/已保存/);const list=run('/memories');assert.match(list,/concise answers/);const id=list.split(' ')[0];
 assert.match(run(`/memory-correct ${id} 1 precise answers`),/v2/);assert.match(run(`/forget ${id} 1`),/未完成/);assert.match(run(`/forget ${id} 2`),/v3/);assert.doesNotMatch(run('/memories'),/precise answers/);
 const group=message('/remember owner injected');group.envelope!.chatType='group';assert.match(memoryCommand(store,group,['owner'],'project',x=>x)!,/只接受/);
 const quote=message('/remember owner injected');quote.envelope!.parentId='quoted';assert.match(memoryCommand(store,quote,['owner'],'project',x=>x)!,/引用/);
});
test('pending controls are isolated by owner and topic without changing chat scheduling',t=>{
 const root=mkdtempSync(join(tmpdir(),'namo-scope-')),store=new Store(join(root,'db'));t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});const m=message('work');store.enqueue(m);store.claim(m.key);
 assert.equal(store.hasPending(m.chatKey,'other','owner',m.chatKey),true);assert.equal(store.hasPending(m.chatKey,'other','bob',m.chatKey),false);assert.equal(store.hasPending(m.chatKey,'other','owner',m.chatKey+':thread:other'),false);assert.equal(store.hasPending(m.chatKey,'other'),true);
});
