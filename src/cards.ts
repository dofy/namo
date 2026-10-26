import { randomBytes } from 'node:crypto';
import type { Store, Outbox, Incoming } from './store.js';
import { Tasks, type Task } from './tasks.js';
import { digest } from './paths.js';
import { readEvidence } from './evidence.js';
import { hasExecution, taskStateLabel, taskStatus } from './presentation.js';
import { Waits, WaitInputError } from './waits.js';

export interface CardEvent { operator?: { open_id?: string }; context?: { open_chat_id?: string; open_message_id?: string }; action?: { value?: { namo?: string } }; }
const plain=(content:string)=>({tag:'plain_text',content});
export function renderTaskCard(t: Task, content: string, kind: string, part: number, actions: { action:string; token:string; label?: string }[] = []): object {
  const title=part?'回复（续）':taskStateLabel(t.state);
  const answers=actions.filter(a=>a.action.startsWith('answer:')),controls=actions.filter(a=>!a.action.startsWith('answer:'));
  const buttons=(group:typeof actions)=>({tag:'action',actions:group.map(a=>({tag:'button',text:plain(a.label??(a.action==='cancel'?'停止任务':'查看详情')),type:a.action.startsWith('answer:')?'primary':'default',value:{namo:a.token},
    ...(a.action==='cancel'?{confirm:{title:plain('停止这项任务？'),text:plain('已发生的操作不会自动撤销。')}}:{})}))});
  return {config:{wide_screen_mode:true},header:{title:plain(title),template:kind==='progress'?'blue':t.state==='succeeded'?'green':t.state==='cancelled'?'grey':'orange'},
    elements:[{tag:'div',text:plain(content)},
      ...(answers.length?[buttons(answers),{tag:'hr'}]:[]),
      ...(t.project&&!part?[{tag:'note',elements:[plain(`项目：${t.project}`)]}]:[]),
      ...(controls.length?[buttons(controls)]:[])]};
}
export class Cards {
  constructor(private store: Store) {}
  prepare(output: Outbox): object | undefined {
    if(output.payload) {const p=JSON.parse(output.payload);return p.textOnly?undefined:p;}
    if(!['progress','result'].includes(output.kind) && !output.kind.startsWith('wait:')) return;
    const task=this.store.db.prepare('SELECT * FROM tasks WHERE inboxKey=?').get(output.inboxKey) as unknown as Task|undefined;
    if(!task) return;
    return this.store.transaction(()=>{
      if(output.kind==='result'&&task.state==='succeeded'&&!readEvidence(this.store,task.id).some(hasExecution)) {
        this.store.db.prepare('UPDATE outbox SET payload=? WHERE id=?').run(JSON.stringify({textOnly:true}),output.id);
        return;
      }
      const wait=output.kind.startsWith('wait:')?new Waits(this.store).get(output.kind.slice(5)):undefined;
      const choices=wait?.state==='open'&&wait.taskId===task.id&&wait.inputVersion===task.inputVersion?wait.choices:undefined;
      const actions=output.part?[]:[...(choices??[]).map((label,index)=>({action:`answer:${index}`,label})),{action:'details'},
        ...(['queued','running','waiting'].includes(task.state)?[{action:'cancel'}]:[])].map(a=>({...a,token:randomBytes(24).toString('base64url')}));
      for(const a of actions) this.store.db.prepare('INSERT INTO card_actions(token,outboxId,taskId,action,inputVersion,expiresAt) VALUES(?,?,?,?,?,?)')
        .run(a.token,output.id,task.id,a.action,task.inputVersion,Date.now()+900_000);
      const content=choices&&!output.part?`${wait!.question}\n\n点击下面的答案继续，也可以引用这条消息自由回复。`:output.content;
      const payload=renderTaskCard(task,content,output.kind,output.part,actions);
      this.store.db.prepare('UPDATE outbox SET payload=? WHERE id=?').run(JSON.stringify(payload),output.id);
      return payload;
    });
  }
  accept(event: CardEvent): { toast: { type:'info'|'error';content:string } } {
    const result=(content:string,error=false)=>({toast:{type:error?'error' as const:'info' as const,content}});
    const token=event.action?.value?.namo;
    if(typeof token!=='string'||token.length>100) return result('操作无效',true);
    return this.store.transaction(()=>{
      const a=this.store.db.prepare(`SELECT a.*,t.ownerId,t.state,t.inputVersion AS currentVersion,o.platformId,o.kind AS outputKind,i.chatId AS deliveryChat
        FROM card_actions a JOIN tasks t ON t.id=a.taskId JOIN outbox o ON o.id=a.outboxId JOIN inbox i ON i.key=o.inboxKey WHERE a.token=?`).get(token);
      // Task stores chatKey; delivery's verified chatId is the callback channel identity.
      if(!a||a.ownerId!==event.operator?.open_id||a.deliveryChat!==event.context?.open_chat_id||!a.platformId||a.platformId!==event.context?.open_message_id) return result('无权操作这项任务',true);
      if(a.usedAt) return result('这次操作已经处理，请用 /task 查看最新状态');
      if(Number(a.expiresAt)<Date.now()) return result('按钮已过期，请用 /task 或 /cancel 命令',true);
      const tasks=new Tasks(this.store),task=tasks.get(String(a.taskId))!;
      if(String(a.action).startsWith('answer:')) {
        const waits=new Waits(this.store),w=String(a.outputKind).startsWith('wait:')?waits.get(String(a.outputKind).slice(5)):undefined;
        const index=Number(String(a.action).slice(7)),choice=w?.choices?.[index];
        if(!w||w.taskId!==task.id||w.state!=='open'||task.state!=='waiting'||a.inputVersion!==a.currentVersion||!Number.isInteger(index)||choice===undefined)
          return result('这次问题已结束或任务已变化，请查看最新问题。',true);
        const key=`card-wait:${digest(token)}`;
        const input:Incoming={key,messageId:key,chatId:String(a.deliveryChat),chatKey:task.chatKey,senderId:String(a.ownerId),text:choice,
          envelope:{version:1,type:'card_action',kind:'instruction',scopeKey:task.scopeKey,materials:[],limitations:[]}};
        try {
          this.store.transaction(()=>{
            if(!this.store.enqueue(input))throw new WaitInputError('这次回答已经处理。');
            waits.answer(w,input,choice);
            this.store.db.prepare("UPDATE inbox SET state='linked' WHERE key=?").run(key);
            this.store.db.prepare('UPDATE card_actions SET usedAt=? WHERE token=?').run(Date.now(),token);
          });
        }catch(e){if(e instanceof WaitInputError)return result(e.message,true);throw e;}
        return result('回答已保存，继续原任务');
      }
      if(a.action==='cancel'&&(!['queued','running','waiting'].includes(task.state)||a.inputVersion!==a.currentVersion)) return result('任务已变化，请查看最新状态后操作',true);
      if(a.action==='cancel'&&!tasks.cancel(task)) return result('运行已结束或失联，没有再发出停止请求；请查看任务状态，失联运行需在本机核对',true);
      this.store.db.prepare('UPDATE card_actions SET usedAt=? WHERE token=?').run(Date.now(),token);
      if(a.action==='cancel') return result('已请求停止；已发生的操作不会撤销');
      this.store.addOutput(task.inboxKey,`card-status:${digest(token).slice(0,16)}`,taskStatus(this.store,task));
      return result('任务详情已加入回复队列');
    });
  }
}
