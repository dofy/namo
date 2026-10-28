import { randomBytes } from 'node:crypto';
import type { Store, Incoming } from './store.js';
import {scopeOf, type Task} from './tasks.js';

type State='pending'|'approved'|'rejected'|'executing'|'completed'|'unknown'|'cancelled';
interface Approval {id:string;taskId:string;inboxKey:string;ownerId:string;chatKey:string;scopeKey:string;connection:string;tool:string;arguments:Record<string,unknown>;scope:string;state:State;expiresAt:number}
const key=(id:string)=>`mcp-approval:${id}`;
function get(store:Store,id:string):Approval|undefined {const row=store.db.prepare('SELECT value FROM settings WHERE key=?').get(key(id));return row?JSON.parse(String(row.value)) as Approval:undefined;}
function save(store:Store,a:Approval):void {store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key(a.id),JSON.stringify(a));}
/** Decisions are owner- and chat-bound and processed in the inbox acceptance transaction. */
export function mcpApprovalCommand(store:Store,message:Incoming):boolean {
 if(!/^\/mcp-(?:approve|reject|status)(?:\s|$)/i.test(message.text.trim()))return false;
 if(!store.claim(message.key))return true;
 const match=/^\/mcp-(approve|reject|status)\s+(MA-[A-F0-9]{12})(?:\s+(--confirm))?\s*$/i.exec(message.text.trim());
 if(!match||match[1]!.toLowerCase()==='approve'&&!match[3]){store.finish(message.key,'用法：/mcp-approve MA-编号 --confirm；/mcp-reject MA-编号；/mcp-status MA-编号。');return true;}
 const a=get(store,match[2]!.toUpperCase());
 if(!a||a.ownerId!==message.senderId||a.chatKey!==message.chatKey||a.scopeKey!==scopeOf(message)){store.finish(message.key,'未找到属于当前用户和会话的 MCP 审批。');return true;}
 const currentTask=store.db.prepare('SELECT state FROM tasks WHERE id=?').get(a.taskId);
 if(currentTask?.state!=='running'&&a.state==='executing'){a.state='unknown';save(store,a);}
 else if((Date.now()>=a.expiresAt||currentTask?.state!=='running')&&['pending','approved'].includes(a.state)){a.state='cancelled';save(store,a);}
 const action=match[1]!.toLowerCase();
 if(action!=='status'){
   const task=store.db.prepare("SELECT state FROM tasks WHERE id=? AND ownerId=? AND chatKey=?").get(a.taskId,a.ownerId,a.chatKey);
   if(a.state!=='pending'||Date.now()>=a.expiresAt||task?.state!=='running'||store.get(a.inboxKey)?.cancelRequested){store.finish(message.key,'审批已处理或已过期，不能重复执行。');return true;}
   a.state=action==='approve'?'approved':'rejected';save(store,a);
 }
 const labels:Record<State,string>={pending:'等待确认',approved:'已确认，等待任务继续',rejected:'已拒绝',executing:'正在执行',completed:'已完成',unknown:'结果不明，请先核对外部服务',cancelled:'已取消'};
 store.finish(message.key,`MCP 审批 ${a.id}：${labels[a.state]}。`);return true;
}
export async function awaitMcpApproval(store:Store,task:Task,connection:string,url:string,tool:string,args:Record<string,unknown>,scope:string,signal:AbortSignal,valid:()=>boolean):Promise<(outcome:'completed'|'unknown')=>void> {
 const json=JSON.stringify(args,null,2);
 if(Buffer.byteLength(json)>6000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(json))throw new Error('mcp_approval_arguments_invalid');
 const id=`MA-${randomBytes(6).toString('hex').toUpperCase()}`;
 const approval:Approval={id,taskId:task.id,inboxKey:task.inboxKey,ownerId:task.ownerId,chatKey:task.chatKey,scopeKey:task.scopeKey,connection,tool,arguments:args,scope,state:'pending',expiresAt:Date.now()+600000};
 store.transaction(()=>{save(store,approval);store.addOutput(task.inboxKey,`mcp-approval:${id}`,`**MCP 操作需要确认**\n连接：${connection}\n地址：${url}\n工具：${tool}\n任务：${task.id}\n参数：\n\`\`\`json\n${json.replace(/```/g,'\\u0060\\u0060\\u0060')}\n\`\`\`\n\n确认执行：\`/mcp-approve ${id} --confirm\`\n拒绝：\`/mcp-reject ${id}\`\n最长有效期 10 分钟，且受任务时限约束；每次调用都需要单独确认。`);});
 try {
   while(!signal.aborted&&Date.now()<approval.expiresAt){
     const current=get(store,id);if(!current||current.state==='rejected')throw new Error('mcp_approval_rejected');
     if(store.get(task.inboxKey)?.cancelRequested||store.db.prepare("SELECT state FROM tasks WHERE id=?").get(task.id)?.state!=='running')throw new Error('mcp_approval_changed');
     if(current.state==='approved'){
       store.transaction(()=>{const latest=get(store,id);if(!latest||latest.state!=='approved'||signal.aborted||Date.now()>=latest.expiresAt||store.get(task.inboxKey)?.cancelRequested||store.db.prepare("SELECT state FROM tasks WHERE id=?").get(task.id)?.state!=='running'||!valid())throw new Error('mcp_approval_changed');latest.state='executing';save(store,latest);});
       return outcome=>store.transaction(()=>{const latest=get(store,id);if(latest?.state==='executing'){latest.state=outcome;save(store,latest);}});
     }
     await new Promise<void>(resolve=>setTimeout(resolve,300));
   }
   throw new Error('mcp_approval_expired');
 } catch(error){store.transaction(()=>{const current=get(store,id);if(current&&['pending','approved'].includes(current.state)){current.state='cancelled';save(store,current);}});throw error;}
}
