import {test} from 'node:test';
import assert from 'node:assert/strict';
import {storeFixture} from './helpers.js';
import {Tasks} from '../src/tasks.js';
import {awaitMcpApproval,mcpApprovalCommand,decideMcpApproval,browserGrant} from '../src/mcp-write-approval.js';
import {Cards} from '../src/cards.js';
import {Feedback} from '../src/feedback.js';
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

test('permanent browser permission is owner, chat and app scoped and revocable',async t=>{
 const {browserGrant,revokeBrowserGrant}=await import('../src/mcp-write-approval.js');
 const f=fixture(t),c={feishu:{appId:'app',domain:'feishu',allowedUserIds:['alice']}} as import('../src/config.js').Config;
 const waiting=awaitMcpApproval(f.store,f.task,'ego-browser','local Ego Lite','task_browser_access',{},'browser',new AbortController().signal,()=>true);
 const id=f.approval();let seq=0;
 const input=(senderId='alice',chatKey='chat',chatType:'p2p'|'group'='p2p')=>{const key=`always-${++seq}`;return {key,messageId:key,chatKey,chatId:chatKey,senderId,text:`/mcp-approve ${id} --always`,envelope:{version:1 as const,type:'text' as const,kind:'instruction' as const,scopeKey:chatKey,chatType,materials:[],limitations:[]}};};
 for(const m of [input('bob'),input('alice','other'),input('alice','chat','group')]){f.store.enqueue(m);mcpApprovalCommand(f.store,m,c);assert.equal(browserGrant(f.store,c,'alice','chat'),undefined);}
 const m=input();f.store.enqueue(m);mcpApprovalCommand(f.store,m,c);const grant=browserGrant(f.store,c,'alice','chat');assert.ok(grant);
 assert.equal(browserGrant(f.store,c,'alice','other'),undefined);assert.equal(browserGrant(f.store,{...c,feishu:{...c.feishu,appId:'other'}},'alice','chat'),undefined);
 const done=await waiting;assert.equal(done.always,true);done('completed');
 assert.equal(revokeBrowserGrant(f.store,c,input('bob')),false);assert.equal(browserGrant(f.store,c,'alice','chat'),grant);
 assert.equal(revokeBrowserGrant(f.store,c,input()),true);assert.equal(browserGrant(f.store,c,'alice','chat'),undefined);
});

test('permanent browser approval cannot grant an arbitrary MCP',async t=>{
 const f=fixture(t),c={feishu:{appId:'app',domain:'feishu',allowedUserIds:['alice']}} as import('../src/config.js').Config;
 const waiting=awaitMcpApproval(f.store,f.task,'remote','https://example.com','create',{},'scope',new AbortController().signal,()=>true);
 const id=f.approval();const m={key:'bad-always',messageId:'bad-always',chatKey:'chat',chatId:'chat',senderId:'alice',text:`/mcp-approve ${id} --always`,envelope:{version:1 as const,type:'text' as const,kind:'instruction' as const,scopeKey:'chat',chatType:'p2p' as const,materials:[],limitations:[]}};
 f.store.enqueue(m);mcpApprovalCommand(f.store,m,c);assert.match(String(f.store.db.prepare("SELECT content FROM outbox WHERE inboxKey=?").get(m.key)?.content),/只适用于/);
 f.command(`/mcp-reject ${id}`);await assert.rejects(waiting,/mcp_approval_rejected/);
});

test('browser approval cards bind the owner, delivered message and task, and grant only once',async t=>{
 const f=fixture(t),c={feishu:{appId:'app',domain:'feishu',allowedUserIds:['alice']}} as import('../src/config.js').Config;
 f.store.db.prepare('UPDATE inbox SET envelope=? WHERE key=?').run(JSON.stringify({version:1,type:'post',kind:'instruction',scopeKey:'chat',chatType:'p2p',materials:[{type:'text'}],limitations:[]}),f.task.inboxKey);
 const waiting=awaitMcpApproval(f.store,f.task,'ego-browser','local Ego Lite','task_browser_access',{site:'https://example.com',untrusted:'<at user_id="all">'},'browser',new AbortController().signal,()=>true);
 const id=f.approval(),out=f.store.nextOutput()!,cards=new Cards(f.store,()=>true,undefined,(id,input,action,always)=>decideMcpApproval(f.store,input,id,action,always,c));
 const payload=cards.prepare(out) as {elements:{tag:string;content?:string}[]};assert.ok(payload);assert.match(JSON.stringify(payload),/本次允许/);assert.match(JSON.stringify(payload),/永久允许/);assert.match(JSON.stringify(payload),/拒绝/);
 assert.equal(payload.elements[0].tag,'markdown');assert.match(payload.elements[0].content!,/\*\*浏览器 操作需要确认\*\*/);assert.match(payload.elements[0].content!,/```json\n/);assert.match(payload.elements[0].content!,/\&lt;at/);assert.doesNotMatch(payload.elements[0].content!,/<at/);
 assert.doesNotMatch(payload.elements[0].content!,/回复“确认操作|回复“永久允许|最长有效期/);assert.match(out.content,/回复“确认操作/);assert.match(out.content,/回复“永久允许/);
 assert.match(JSON.stringify(payload),/按键/);assert.match(JSON.stringify(payload),/撤销浏览器永久授权/);
 f.store.sending(out.id);f.store.sent(out.id,'platform');
 const tokens=f.store.db.prepare('SELECT action,token FROM card_actions WHERE outboxId=?').all(out.id);
 const event=(action:string)=>({operator:{open_id:'alice'},context:{open_chat_id:'chat',open_message_id:'platform'},action:{value:{namo:String(tokens.find(x=>x.action===`mcp-${action}:${id}`)!.token)}}});
 assert.equal(cards.accept({...event('always'),operator:{open_id:'bob'}}).toast.type,'error');
 assert.equal(cards.accept({...event('always'),context:{open_chat_id:'chat',open_message_id:'other'}}).toast.type,'error');
 assert.equal(browserGrant(f.store,c,'alice','chat'),undefined);
 assert.equal(cards.accept(event('always')).toast.type,'info');assert.ok(browserGrant(f.store,c,'alice','chat'));
 assert.equal(cards.accept(event('approve')).toast.type,'error');assert.match(cards.accept(event('always')).toast.content,/已经处理/);
 const patches:object[]=[];const feedback=new Feedback(f.store,{async send(){throw Error('unexpected send');},async updateCard(id,card){assert.equal(id,'platform');patches.push(card);}});
 await feedback.tick({progress:false});assert.equal(patches.length,1);assert.match(JSON.stringify(patches[0]),/已选择：永久允许/);assert.doesNotMatch(JSON.stringify(patches[0]),/"tag":"button"|"tag":"action"/);
 await feedback.tick({progress:false});assert.equal(patches.length,1);
 f.store.db.prepare('UPDATE outbox SET progressRetired=0 WHERE id=?').run(out.id);await feedback.tick({progress:false});assert.equal(patches.length,1);
 const done=await waiting;assert.equal(done.always,true);done('completed');
});

test('uncertain approval card updates are never blindly retried',async t=>{
 const f=fixture(t),c={feishu:{appId:'app',domain:'feishu',allowedUserIds:['alice']}} as import('../src/config.js').Config;
 f.store.db.prepare('UPDATE inbox SET envelope=? WHERE key=?').run(JSON.stringify({version:1,type:'text',kind:'instruction',scopeKey:'chat',chatType:'p2p',materials:[],limitations:[]}),f.task.inboxKey);
 const waiting=awaitMcpApproval(f.store,f.task,'ego-browser','local Ego Lite','task_browser_access',{},'browser',new AbortController().signal,()=>true);
 const id=f.approval(),out=f.store.nextOutput()!,cards=new Cards(f.store,()=>true,undefined,(id,input,action,always)=>decideMcpApproval(f.store,input,id,action,always,c));
 cards.prepare(out);f.store.sending(out.id);f.store.sent(out.id,'platform');
 const token=String(f.store.db.prepare('SELECT token FROM card_actions WHERE outboxId=? AND action=?').get(out.id,`mcp-reject:${id}`)!.token);
 assert.equal(cards.accept({operator:{open_id:'alice'},context:{open_chat_id:'chat',open_message_id:'platform'},action:{value:{namo:token}}}).toast.type,'info');
 let updates=0,reads=0;const feedback=new Feedback(f.store,{async send(){return 'unused';},async updateCard(){updates++;throw Error('timeout');},async readCard(){reads++;return 'unmatched';}});
 await feedback.tick({progress:false});await feedback.tick({progress:false});await feedback.tick({progress:false});assert.equal(updates,1);assert.equal(reads,1);
 assert.equal(f.store.db.prepare('SELECT state FROM progress_updates WHERE outboxId=?').get(out.id)?.state,'unknown');await assert.rejects(waiting,/mcp_approval_rejected/);
});

test('approval card rejection and expiry do not approve a pending operation',async t=>{
 const f=fixture(t),c={feishu:{appId:'app',domain:'feishu',allowedUserIds:['alice']}} as import('../src/config.js').Config;
 f.store.db.prepare('UPDATE inbox SET envelope=? WHERE key=?').run(JSON.stringify({version:1,type:'text',kind:'instruction',scopeKey:'chat',chatType:'p2p',materials:[],limitations:[]}),f.task.inboxKey);
 const waiting=awaitMcpApproval(f.store,f.task,'ego-browser','local Ego Lite','task_browser_access',{},'browser',new AbortController().signal,()=>true);
 const id=f.approval(),out=f.store.nextOutput()!,cards=new Cards(f.store,()=>true,undefined,(id,input,action,always)=>decideMcpApproval(f.store,input,id,action,always,c));
 cards.prepare(out);f.store.sending(out.id);f.store.sent(out.id,'platform');
 const token=(name:string)=>String(f.store.db.prepare('SELECT token FROM card_actions WHERE outboxId=? AND action=?').get(out.id,`mcp-${name}:${id}`)!.token);
 const event=(name:string)=>({operator:{open_id:'alice'},context:{open_chat_id:'chat',open_message_id:'platform'},action:{value:{namo:token(name)}}});
 f.store.db.prepare('UPDATE card_actions SET expiresAt=0 WHERE token=?').run(token('approve'));
 assert.equal(cards.accept(event('approve')).toast.type,'error');assert.equal(browserGrant(f.store,c,'alice','chat'),undefined);
 assert.equal(cards.accept(event('reject')).toast.type,'info');
 const patches:object[]=[];const feedback=new Feedback(f.store,{async send(){return 'unused';},async updateCard(_id,card){patches.push(card);}});await feedback.tick({progress:false});
 assert.equal(patches.length,1);assert.match(JSON.stringify(patches[0]),/已选择：拒绝/);assert.doesNotMatch(JSON.stringify(patches[0]),/"tag":"button"|"tag":"action"/);
 await assert.rejects(waiting,/mcp_approval_rejected/);
});

test('one-time approval card resumes without creating a permanent grant',async t=>{
 const f=fixture(t),c={feishu:{appId:'app',domain:'feishu',allowedUserIds:['alice']}} as import('../src/config.js').Config;
 f.store.db.prepare('UPDATE inbox SET envelope=? WHERE key=?').run(JSON.stringify({version:1,type:'text',kind:'instruction',scopeKey:'chat',chatType:'p2p',materials:[],limitations:[]}),f.task.inboxKey);
 const waiting=awaitMcpApproval(f.store,f.task,'ego-browser','local Ego Lite','task_browser_access',{},'browser',new AbortController().signal,()=>true);
 const id=f.approval(),out=f.store.nextOutput()!,cards=new Cards(f.store,()=>true,undefined,(id,input,action,always)=>decideMcpApproval(f.store,input,id,action,always,c));
 cards.prepare(out);f.store.sending(out.id);f.store.sent(out.id,'platform');
 const token=String(f.store.db.prepare('SELECT token FROM card_actions WHERE outboxId=? AND action=?').get(out.id,`mcp-approve:${id}`)!.token);
 const event={operator:{open_id:'alice'},context:{open_chat_id:'chat',open_message_id:'platform'},action:{value:{namo:token}}};
 f.store.db.prepare('UPDATE tasks SET inputVersion=inputVersion+1 WHERE id=?').run(f.task.id);
 assert.equal(cards.accept(event).toast.type,'error');f.store.db.prepare('UPDATE tasks SET inputVersion=inputVersion-1 WHERE id=?').run(f.task.id);
 assert.equal(cards.accept(event).toast.type,'info');const done=await waiting;assert.equal(done.always,false);assert.equal(browserGrant(f.store,c,'alice','chat'),undefined);done('completed');
});
