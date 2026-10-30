import {test} from 'node:test';
import assert from 'node:assert/strict';
import {storeFixture} from './helpers.js';
import {Tasks} from '../src/tasks.js';
import {awaitMcpApproval,mcpApprovalCommand} from '../src/mcp-write-approval.js';
function fixture(t:any){
 const {dir,store}=storeFixture(t,'namo-mcp-approval-');
 const msg={key:'task',messageId:'task',chatKey:'chat',chatId:'chat',senderId:'alice',text:'request'};
 store.enqueue(msg);const task=new Tasks(store).create(store.get('task')!,{cwd:dir,policyHash:'test'});store.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(task.id);
 let seq=0;const command=(text:string,senderId='alice',chatKey='chat',scopeKey=chatKey)=>{const key=`cmd-${++seq}`;store.enqueue({key,messageId:key,chatKey,chatId:chatKey,senderId,text,envelope:{version:1,type:'text',kind:'instruction',scopeKey,materials:[],limitations:[]}});mcpApprovalCommand(store,store.get(key)!);return String(store.db.prepare("SELECT content FROM outbox WHERE inboxKey=? AND kind='result'").get(key)?.content);};
 const approval=()=>String(store.db.prepare("SELECT key FROM settings WHERE key LIKE 'mcp-approval:%'").get()?.key).slice('mcp-approval:'.length);
 return {store,task,command,approval};
}
test('MCP approval binds task, chat, owner and exact arguments; each confirmation is consumed once',async t=>{
 const f=fixture(t),signal=new AbortController().signal;
 const waiting=awaitMcpApproval(f.store,f.task,'remote','https://example.com/mcp','create_issue',{title:'Example'},'scope',signal,()=>true);
 const id=f.approval();assert.match(id,/^MA-[A-F0-9]{12}$/);
 const notice=String(f.store.db.prepare('SELECT content FROM outbox WHERE kind=?').get(`mcp-approval:${id}`)?.content);
 assert.match(notice,/create_issue/);assert.match(notice,/Example/);assert.match(notice,/example.com/);
 assert.match(f.command(`/mcp-approve ${id} --confirm`,'bob'),/未找到/);
 assert.match(f.command(`/mcp-approve ${id} --confirm`,'alice','other'),/未找到/);
 assert.match(f.command(`/mcp-approve ${id} --confirm`,'alice','chat','chat:thread:other'),/未找到/);
 assert.match(f.command(`/mcp-approve ${id}`),/用法/);
 assert.match(f.command(`/mcp-approve ${id} --confirm`),/已确认/);
 const finalize=await waiting;
 assert.match(f.command(`/mcp-approve ${id} --confirm`),/不能重复/);
 finalize('completed');assert.match(f.command(`/mcp-status ${id}`),/已完成/);
});
test('rejection, cancellation and permission changes prevent dispatch',async t=>{
 const f=fixture(t),controller=new AbortController();let valid=true;
 const waiting=awaitMcpApproval(f.store,f.task,'remote','https://example.com/mcp','remove',{},'scope',controller.signal,()=>valid);
 const id=f.approval();f.command(`/mcp-approve ${id} --confirm`);valid=false;
 await assert.rejects(waiting,/mcp_approval_changed/);assert.match(f.command(`/mcp-status ${id}`),/已取消/);
});
test('an approved operation cannot dispatch after the owning turn is cancelled',async t=>{
 const f=fixture(t),controller=new AbortController();
 const waiting=awaitMcpApproval(f.store,f.task,'remote','https://example.com/mcp','remove',{},'scope',controller.signal,()=>true);
 const id=f.approval();f.command(`/mcp-approve ${id} --confirm`);controller.abort('turn_timeout');
 await assert.rejects(waiting,/mcp_approval_expired/);
 assert.match(f.command(`/mcp-status ${id}`),/已取消/);
});
test('interrupted execution is shown as unknown and is never approved again',async t=>{
 const f=fixture(t),waiting=awaitMcpApproval(f.store,f.task,'remote','https://example.com/mcp','update',{},'scope',new AbortController().signal,()=>true);
 const id=f.approval();f.command(`/mcp-approve ${id} --confirm`);await waiting;
 f.store.db.prepare("UPDATE tasks SET state='failed' WHERE id=?").run(f.task.id);
 assert.match(f.command(`/mcp-status ${id}`),/结果不明/);assert.match(f.command(`/mcp-approve ${id} --confirm`),/不能重复/);
});
test('a repeated operation warns when a previous dispatch has an unknown outcome',async t=>{
 const f=fixture(t),signal=new AbortController().signal;
 const first=awaitMcpApproval(f.store,f.task,'remote','https://example.com/mcp','update',{a:1,b:2},'scope',signal,()=>true);
 const id=f.approval();f.command(`/mcp-approve ${id} --confirm`);(await first)('unknown');
 const second=awaitMcpApproval(f.store,f.task,'remote','https://example.com/mcp','update',{b:2,a:1},'scope',signal,()=>true);
 const rows=f.store.db.prepare("SELECT key FROM settings WHERE key LIKE 'mcp-approval:%'").all();
 const next=rows.map(r=>String(r.key).slice('mcp-approval:'.length)).find(x=>x!==id)!;
 const notice=String(f.store.db.prepare('SELECT content FROM outbox WHERE kind=?').get(`mcp-approval:${next}`)?.content);
 assert.match(notice,/此前相同操作的结果不明/);f.command(`/mcp-reject ${next}`);await assert.rejects(second,/mcp_approval_rejected/);
});
