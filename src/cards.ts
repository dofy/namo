import { randomBytes } from 'node:crypto';
import type { Store, Outbox } from './store.js';
import { Tasks, type Task } from './tasks.js';
import { digest } from './paths.js';

export interface CardEvent { operator?: { open_id?: string }; context?: { open_chat_id?: string; open_message_id?: string }; action?: { value?: { namo?: string } }; }
const labels: Record<string,string>={queued:'已接收',running:'执行中',succeeded:'已完成',failed:'执行未完成',cancelled:'已取消',interrupted:'执行中断',needs_attention:'需要核对'};
const plain=(content:string)=>({tag:'plain_text',content});
export function renderTaskCard(t: Task, content: string, kind: string, part: number, actions: { action:string; token:string }[] = []): object {
  const title=kind==='progress'?'任务已接收':labels[t.state]??t.state;
  const elapsed=t.startedAt&&t.finishedAt?`${Math.max(0,Math.round((t.finishedAt-t.startedAt)/1000))} 秒`:'尚未结束';
  return {config:{wide_screen_mode:true},header:{title:plain(`${title} · ${t.id}`),template:kind==='progress'?'blue':t.state==='succeeded'?'green':t.state==='cancelled'?'grey':'orange'},
    elements:[{tag:'div',fields:[{is_short:true,text:plain(`项目\n${t.project??'隔离目录'}`)},{is_short:true,text:plain(`输入版本 / 耗时\nv${t.inputVersion} / ${elapsed}`)}]},
      {tag:'div',text:plain(`${kind==='result'?'结果与验证':'接收记录'}${part?`（续 ${part+1}）`:''}\n${content}`)},
      {tag:'note',elements:[plain(`工作线 ${t.workstreamId} · /task ${t.id} 查看最新状态`)]},
      ...(actions.length?[{tag:'action',actions:actions.map(a=>({tag:'button',text:plain(a.action==='cancel'?'停止任务':'查看状态'),type:'default',value:{namo:a.token},
        ...(a.action==='cancel'?{confirm:{title:plain('停止这项任务？'),text:plain('已发生的操作不会自动撤销。')}}:{})}))}]:[])]};
}
export class Cards {
  constructor(private store: Store) {}
  prepare(output: Outbox): object | undefined {
    if(output.payload) {const p=JSON.parse(output.payload);return p.textOnly?undefined:p;}
    if(!['progress','result'].includes(output.kind)) return;
    const task=this.store.db.prepare('SELECT * FROM tasks WHERE inboxKey=?').get(output.inboxKey) as unknown as Task|undefined;
    if(!task) return;
    return this.store.transaction(()=>{
      const actions=output.part?[]:['details',...(['queued','running'].includes(task.state)?['cancel']:[])].map(action=>({action,token:randomBytes(24).toString('base64url')}));
      for(const a of actions) this.store.db.prepare('INSERT INTO card_actions(token,outboxId,taskId,action,inputVersion,expiresAt) VALUES(?,?,?,?,?,?)')
        .run(a.token,output.id,task.id,a.action,task.inputVersion,Date.now()+900_000);
      const payload=renderTaskCard(task,output.content,output.kind,output.part,actions);
      this.store.db.prepare('UPDATE outbox SET payload=? WHERE id=?').run(JSON.stringify(payload),output.id);
      return payload;
    });
  }
  accept(event: CardEvent): { toast: { type:'info'|'error';content:string } } {
    const result=(content:string,error=false)=>({toast:{type:error?'error' as const:'info' as const,content}});
    const token=event.action?.value?.namo;
    if(typeof token!=='string'||token.length>100) return result('操作无效',true);
    return this.store.transaction(()=>{
      const a=this.store.db.prepare(`SELECT a.*,t.ownerId,t.state,t.inputVersion AS currentVersion,o.platformId,i.chatId AS deliveryChat
        FROM card_actions a JOIN tasks t ON t.id=a.taskId JOIN outbox o ON o.id=a.outboxId JOIN inbox i ON i.key=o.inboxKey WHERE a.token=?`).get(token);
      // Task stores chatKey; delivery's verified chatId is the callback channel identity.
      if(!a||a.ownerId!==event.operator?.open_id||a.deliveryChat!==event.context?.open_chat_id||!a.platformId||a.platformId!==event.context?.open_message_id) return result('无权操作这项任务',true);
      if(a.usedAt) return result('这次操作已经处理，请用 /task 查看最新状态');
      if(Number(a.expiresAt)<Date.now()) return result('按钮已过期，请用 /task 或 /cancel 命令',true);
      const tasks=new Tasks(this.store),task=tasks.get(String(a.taskId))!;
      if(a.action==='cancel'&&(!['queued','running'].includes(task.state)||a.inputVersion!==a.currentVersion)) return result('任务已变化，请查看最新状态后操作',true);
      this.store.db.prepare('UPDATE card_actions SET usedAt=? WHERE token=?').run(Date.now(),token);
      if(a.action==='cancel') { tasks.cancel(task); return result('已请求停止；已发生的操作不会撤销'); }
      this.store.addOutput(task.inboxKey,`card-status:${digest(token).slice(0,16)}`,JSON.stringify(tasks.detail(task),null,2));
      return result('最新任务状态已加入回复队列');
    });
  }
}
