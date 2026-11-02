import { randomBytes } from 'node:crypto';
import type { Store, Outbox, Incoming } from './store.js';
import { Tasks, type Task } from './tasks.js';
import { digest } from './paths.js';
import { readEvidence } from './evidence.js';
import { hasExecution, taskStateLabel, taskStatus } from './presentation.js';
import { progressState, taskElapsed } from './task-progress.js';
import { cardMarkdown, resultMarkdown, hasMarkdown, openFence } from './richtext.js';
import { Waits, WaitInputError, linkedExternalWait, type TaskWait } from './waits.js';

export interface CardEvent { operator?: { open_id?: string; tenant_key?: string }; context?: { open_chat_id?: string; open_message_id?: string }; action?: { value?: { namo?: string } }; }
const plain=(content:string)=>({tag:'plain_text',content});

/** Only host-generated task rows may introduce Feishu color tags. */
export function renderTaskListCard(content:string): object | undefined {
  const colors: Record<string,string> = {'已完成':'green','排队中':'blue','正在处理':'blue','等待你补充':'orange',
    '未完成':'red','已停止':'grey','执行中断，需核对':'orange','需要核对补充要求':'orange','状态待核对':'grey'};
  const rows=content.split('\n');
  const rendered:string[]=[];
  for(const row of rows) {
    const match=/^(排队中|正在处理|已完成|等待你补充|未完成|已停止|执行中断，需核对|需要核对补充要求|状态待核对)(?: · ([A-Za-z0-9_-]{1,48}))? · `\/task (N-[A-F0-9]{12})`$/.exec(row);
    if(!match)return;
    const [,state,directory,id]=match;
    rendered.push(`<font color='${colors[state]}'>${state}</font>${directory ? ` · ${directory}` : ''} · \`/task ${id}\``);
  }
  if(!rendered.length)return;
  return {schema:'2.0',config:{update_multi:true},body:{elements:[{tag:'markdown',content:rendered.join('\n')}]}};
}
/** Render a bounded subset of Markdown as host-owned layout components. */
export function structuredResult(content: string): object[] {
  const elements: object[]=[]; let prose: string[]=[]; let fence: string | undefined;
  const flush=()=>{if(prose.length){elements.push({tag:'markdown',content:resultMarkdown(prose.join('\n'))});prose=[];}};
  const lines=content.split('\n');
  for(let i=0;i<lines.length;i++) {
    const line=lines[i];
    const mark=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if(mark){if(!fence)fence=mark[1];else if(mark[1][0]===fence[0]&&mark[1].length>=fence.length&&!mark[2].trim())fence=undefined;prose.push(line);continue;}
    if(!fence && /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {flush();elements.push({tag:'hr'});continue;}
    const alert=!fence && /^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(line);
    if(alert){
      flush(); const body=[alert[2]];
      while(i+1<lines.length && /^\s*>/.test(lines[i+1])) body.push(lines[++i].replace(/^\s*>\s?/,''));
      const labels:Record<string,string>={NOTE:'说明',TIP:'提示',IMPORTANT:'重点',WARNING:'注意',CAUTION:'注意'};
      const label=labels[alert[1].toUpperCase()];
      elements.push({tag:'column_set',columns:[{tag:'column',width:'weighted',weight:1,background_style:'grey-100',elements:[{tag:'markdown',margin:'10px 12px 10px 12px',content:resultMarkdown(`**${label}**\n${body.join('\n')}`)}]}]});
      continue;
    }
    prose.push(line);
  }
  flush(); return elements.length?elements:[{tag:'markdown',content:''}];
}
interface ResultContext { source: 'main' | 'unrecorded'; model?: string; }

/** A result comes from the bound top-level Codex turn; child-agent output is
 * not delivered independently. Old or incomplete runs must not acquire an
 * invented source or a model from the current configuration. */
function resultContext(store: Store, task: Task): ResultContext | undefined {
  if (!['succeeded', 'needs_attention'].includes(task.state)) return;
  const run = store.db.prepare(`SELECT state,threadId,turnId FROM task_runs
    WHERE taskId=? ORDER BY startedAt DESC,rowid DESC LIMIT 1`).get(task.id);
  if (!run || run.state !== 'succeeded' || typeof run.threadId !== 'string' || !run.threadId
    || typeof run.turnId !== 'string' || !run.turnId) return { source: 'unrecorded' };
  let model: unknown;
  try { model = new Tasks(store).model(task.id); } catch { /* Legacy invalid metadata remains unknown. */ }
  return { source: 'main', ...(typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model) ? { model } : {}) };
}
export function renderTaskCard(t: Task, content: string, kind: string, part: number, actions: { action:string; token:string; label?: string }[] = [], totals?: ReturnType<typeof progressState>['totals'], context?: ResultContext, questions?: TaskWait['questions']): object {
  // Retire the live progress surface without competing with the durable result.
  // Do not claim delivery: the independent result send may still be pending.
  if (kind==='progress' && !['queued','running','waiting'].includes(t.state)) {
    const state=t.state==='succeeded'?'处理结束':t.state==='failed'?'执行失败':taskStateLabel(t.state);
    const summary=[`${state} · 用时：${taskElapsed(t)}`,
      ...(totals?[`工具调用 ${totals.total} 次${totals.limited?'（记录有限）':''}`,
        ...(totals.failed?[`失败 ${totals.failed} 次`]:[]),...(totals.unknown?[`未确认 ${totals.unknown} 次`]:[])]:[])].join(' · ');
    return {config:{wide_screen_mode:true,update_multi:true},elements:[{tag:'note',elements:[plain(summary)]}]};
  }
  const title=part?'回复（续）':kind==='external-wait'?'等待外部检查':taskStateLabel(t.state);
  if (kind==='result') return {
    schema:'2.0',config:{update_multi:true},
    header:{title:plain(title),template:t.state==='succeeded'?'green':t.state==='cancelled'?'grey':'orange'},
    body:{elements:[...structuredResult(content),
      ...(!part&&context?[{tag:'div',text:{...plain(`${context.source === 'main' ? '主线程' : '来源未记录'} · ${context.model ? `任务模型：${context.model}` : context.source === 'main' ? '模型未记录' : '模型未确认'}`),text_size:'notation'}}]:[]),
      ...actions.map(a=>({tag:'button',text:plain(a.label??(a.action==='cancel'?'停止任务':'查看详情')),type:'default',
        behaviors:[{type:'callback',value:{namo:a.token}}],
        ...(a.action==='cancel'?{confirm:{title:plain('停止这项任务？'),text:plain('已发生的操作不会自动撤销。')}}:{})}))]},
  };
  const body=(kind==='result'||kind==='progress'||questions)&&hasMarkdown(content)?{tag:'markdown',content:cardMarkdown(content)}:{tag:'div',text:plain(content)};
  const answers=actions.filter(a=>a.action.startsWith('answer:')),controls=actions.filter(a=>!a.action.startsWith('answer:'));
  const buttons=(group:typeof actions)=>({tag:'action',actions:group.map(a=>({tag:'button',text:plain(a.label??(a.action==='cancel'?'停止任务':'查看详情')),type:a.action.startsWith('answer:')?'primary':'default',value:{namo:a.token},
    ...(a.action==='cancel'?{confirm:{title:plain('停止这项任务？'),text:plain('已发生的操作不会自动撤销。')}}:{})}))});
  const grouped=questions?.flatMap((q,i)=>[{tag:'hr'},{tag:'div',text:plain(`${i+1}. ${q.question}`)}, buttons(answers.filter(a=>a.action.startsWith(`answer:${i}:`)))]) ?? [];
  return {config:{wide_screen_mode:true,update_multi:true},header:{title:plain(title),template:t.state==='succeeded'?'green':t.state==='cancelled'?'grey':kind==='progress'&&['queued','running','waiting'].includes(t.state)?'blue':'orange'},
    elements:[body,
      ...(questions ? [...grouped,{tag:'hr'}] : answers.length?[buttons(answers),{tag:'hr'}]:[]),
      ...(controls.length?[buttons(controls)]:[])]};
}
export class Cards {
  constructor(private store: Store, private canAccess: (task:Task)=>boolean = ()=>true) {}
  prepare(output: Outbox): object | undefined {
    if(output.payload) {const p=JSON.parse(output.payload);return p.textOnly||p.noCard?undefined:p;}
    if(!['progress','result'].includes(output.kind) && !output.kind.startsWith('wait:')) return;
    const task=this.store.db.prepare('SELECT * FROM tasks WHERE inboxKey=?').get(output.inboxKey) as unknown as Task|undefined;
    if(!task) return;
    return this.store.transaction(()=>{
      if(output.kind==='result'&&task.state==='succeeded'&&!readEvidence(this.store,task.id).some(hasExecution) && !/(?:^|\n)\s*>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(output.content)) {
        this.store.db.prepare('UPDATE outbox SET payload=? WHERE id=?').run(JSON.stringify({noCard:true}),output.id);
        return;
      }
      const wait=output.kind.startsWith('wait:')?new Waits(this.store).get(output.kind.slice(5)):undefined;
      const choices=wait?.state==='open'&&wait.taskId===task.id&&wait.inputVersion===task.inputVersion?wait.choices:undefined;
      const questions=wait?.state==='open'&&wait.taskId===task.id&&wait.inputVersion===task.inputVersion?wait.questions:undefined;
      const actions=output.part?[]:[...(questions ? questions.flatMap((q,i)=>q.choices.map((label,j)=>({action:`answer:${i}:${j}`,label}))) : (choices??[]).map((label,index)=>({action:`answer:${index}`,label}))),{action:'details'},
        ...(['queued','running','waiting'].includes(task.state)?[{action:'cancel'}]:[])].map(a=>({...a,token:randomBytes(24).toString('base64url')}));
      for(const a of actions) this.store.db.prepare('INSERT INTO card_actions(token,outboxId,taskId,action,inputVersion,expiresAt) VALUES(?,?,?,?,?,?)')
        .run(a.token,output.id,task.id,a.action,task.inputVersion,Date.now()+900_000);
      const progress=output.kind==='progress'?progressState(this.store,task):undefined;
      const content=progress?progress.content:(choices||questions)&&!output.part?`${wait!.question}\n\n${questions?'请回答全部问题后继续；也可以引用消息一次回复全部答案。':'点击下面的答案继续，也可以引用这条消息自由回复。'}`:output.content;
      const prefix=output.part?this.store.db.prepare('SELECT content FROM outbox WHERE inboxKey=? AND kind=? AND part<? ORDER BY part').all(output.inboxKey,output.kind,output.part).map(row=>String(row.content)).join(''):'';
      const fence=output.kind==='result'?openFence(prefix):undefined;
      const display=(fence?fence+'\n':'')+content;
      const payload=renderTaskCard(task,display,wait&&linkedExternalWait(this.store,wait.id)?'external-wait':output.kind,output.part,actions,progress?.totals,output.kind==='result'?resultContext(this.store,task):undefined,output.part?undefined:questions);
      // Receipt text is not host formatting. Keep it literal beside the
      // structured Markdown progress block, including on the first card.
      if(output.kind==='progress'&&output.content&&['queued','running','waiting'].includes(task.state))(payload as {elements:unknown[]}).elements.unshift({tag:'div',text:plain(output.content)});
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
      if (!this.canAccess(task)) return result('任务访问权限已变化，请联系管理员。',true);
      if(String(a.action).startsWith('answer:')) {
        const waits=new Waits(this.store),w=String(a.outputKind).startsWith('wait:')?waits.get(String(a.outputKind).slice(5)):undefined;
        const groupMatch=/^answer:(\d+):(\d+)$/.exec(String(a.action));
        if (groupMatch) {
          if(!w || w.taskId!==task.id || w.state!=='open' || task.state!=='waiting' || a.inputVersion!==a.currentVersion) return result('这次问题已结束或任务已变化，请查看最新问题。',true);
          const key=`card-wait:${digest(token)}`;
          const input:Incoming={key,messageId:key,chatId:String(a.deliveryChat),chatKey:task.chatKey,senderId:String(a.ownerId),text:'',envelope:{...this.store.get(task.inboxKey)?.envelope,version:1,type:'card_action',kind:'instruction',scopeKey:task.scopeKey,materials:[],limitations:[]}};
          try {
            const complete=waits.answerChoice(w,input,Number(groupMatch[1]),Number(groupMatch[2]));
            this.store.db.prepare('UPDATE card_actions SET usedAt=? WHERE token=?').run(Date.now(),token);
            return result(complete?'全部回答已保存，继续原任务':'回答已保存，请继续回答其他问题');
          } catch(e) {if(e instanceof WaitInputError)return result(e.message,true);throw e;}
        }
        const index=Number(String(a.action).slice(7)),choice=w?.choices?.[index];
        if(!w||w.taskId!==task.id||w.state!=='open'||task.state!=='waiting'||a.inputVersion!==a.currentVersion||!Number.isInteger(index)||choice===undefined)
          return result('这次问题已结束或任务已变化，请查看最新问题。',true);
        const key=`card-wait:${digest(token)}`;
        const input:Incoming={key,messageId:key,chatId:String(a.deliveryChat),chatKey:task.chatKey,senderId:String(a.ownerId),text:choice,
          envelope:{...this.store.get(task.inboxKey)?.envelope,version:1,type:'card_action',kind:'instruction',scopeKey:task.scopeKey,materials:[],limitations:[]}};
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
