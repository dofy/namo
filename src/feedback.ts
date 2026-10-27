import type { Store } from './store.js';
import type { Sender } from './engine.js';
import type { Task } from './tasks.js';
import { renderTaskCard } from './cards.js';
import { readProgress, progressTotals } from './public-progress.js';
import { readEvidence } from './evidence.js';

export type ActivityPhase = 'connecting' | 'working' | 'command' | 'file' | 'tool' | 'answering';
const labels: Record<string, string> = { queued:'排队中', connecting:'正在连接执行器', working:'正在处理', command:'正在运行命令', file:'正在修改文件', tool:'正在调用工具', answering:'正在整理回复', waiting:'等待你补充', succeeded:'已完成', failed:'执行失败', cancelled:'已停止', interrupted:'运行中断', needs_attention:'需要核对', lost:'执行器失联', finishing:'执行已结束，正在整理回复', execution_failed:'执行未完成，正在整理结果' };
export function recordActivity(store: Store, runId: string, phase: ActivityPhase): void {
  store.db.prepare('INSERT INTO run_activity(runId,phase,updatedAt) VALUES(?,?,?) ON CONFLICT(runId) DO UPDATE SET phase=excluded.phase,updatedAt=excluded.updatedAt').run(runId,phase,Date.now());
}
export function progressState(store: Store, task: Task, now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): { phase: string; content: string; terminal: boolean; revision: string } {
  const run = store.db.prepare(`SELECT r.id,a.phase,a.updatedAt,j.state AS worker,j.updatedAt AS heartbeat FROM task_runs r LEFT JOIN run_activity a ON a.runId=r.id LEFT JOIN runner_jobs j ON j.runId=r.id WHERE r.taskId=? ORDER BY r.rowid DESC LIMIT 1`).get(task.id);
  const terminal = !['queued','running','waiting'].includes(task.state);
  const phase = terminal || task.state !== 'running' ? task.state : run?.worker === 'lost' ? 'lost'
    : run?.worker === 'completed' ? 'finishing' : run?.worker === 'failed' ? 'execution_failed' : String(run?.phase ?? 'connecting');
  const executing = task.state==='running'&&!['lost','finishing','execution_failed'].includes(phase);
  const stamp = (time: number) => new Intl.DateTimeFormat('sv-SE', {timeZone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(time);
  const seconds = task.startedAt ? Math.max(0,Math.floor(((task.finishedAt??now)-task.startedAt)/1000)) : 0;
  const elapsed = !task.startedAt ? '尚未开始' : seconds<60 ? `${seconds} 秒`
    : seconds<3600 ? `${Math.floor(seconds/60)} 分 ${seconds%60} 秒` : `${Math.floor(seconds/3600)} 小时 ${Math.floor(seconds%3600/60)} 分 ${seconds%60} 秒`;
  const progress = run ? readProgress(store,String(run.id)) : undefined;
  const revision=`${task.inputVersion}:${run?.id??''}:${phase}:${progress?.revision??0}`;
  const times=[`**开始时间**：${task.startedAt?stamp(task.startedAt):'尚未开始'}`,
    ...(terminal&&task.finishedAt?[`**结束时间**：${stamp(task.finishedAt)}`]:[]),`本地时间 · ${timeZone}`];
  if(terminal){
    const totals=progressTotals(store,task.id),plan=totals.plan;
    return {phase,terminal,revision,content:[`**${labels[phase]??'状态待核对'} · 总用时：${elapsed}**`,times.join('\n'),
      '**执行统计**',
      plan?`📋 计划步骤：${plan.completed} / ${plan.total} 已完成（模型计划）`:'📋 计划步骤：未提供结构化计划',
      `🔧 已记录工具步骤：${totals.total} 次${totals.limited?'（记录有限）':''}`,
      `✅ 成功 ${totals.succeeded} · ❌ 失败 ${totals.failed} · ⚪ 未确认 ${totals.unknown}`,
      totals.limited?'统计仅包含留存的工具事件，不能视为完整总量。':null,
      '工具成功仅表示调用成功或命令正常退出；最终结果以独立结果消息为准。'].filter(Boolean).join('\n\n')};
  }
  // Public text stays literal inside the host-owned Markdown layout.
  const literal=(text:string)=>text.replace(/[\\`*_{}\[\]()#~!>|+-]/g,'\\$&');
  const grouped:{line:string;count:number}[]=[];
  for(const e of progress?.events??[]){
    const icon=e.kind==='plan'?'📋':e.kind==='commentary'?'💬':e.status==='running'?'⚙️':e.status==='failed'?'❌':e.outcome==='success'?'✅':'⏹';
    const text=Array.from(e.text),line=`${icon} ${literal(text.slice(0,70).join(''))}${text.length>70?'…':''}`;
    const last=grouped.at(-1);if(last?.line===line)last.count++;else grouped.push({line,count:1});
  }
  const files = run ? readEvidence(store,task.id).find(e=>e.runId===run.id)?.items
    .filter(i=>i.kind==='files'&&i.status==='completed').flatMap(i=>(i.files??[]).map(f=>f.path))??[] : [];
  const stale=executing&&run?.heartbeat&&now-Number(run.heartbeat)>30_000;
  return {phase,terminal,revision,content:[`**当前：${labels[phase]??'状态待核对'}** · ⏱ **${elapsed}**`,times.join('\n'),
    grouped.length?'**最近进展**\n'+grouped.map(e=>`- ${e.line}${e.count>1?` × ${e.count}`:''}`).join('\n'):null,
    files.length?'**已应用文件补丁**\n'+[...new Set(files)].slice(-3).map(f=>`- ${literal(Array.from(f).slice(0,60).join(''))}`).join('\n'):null,
    stale?'⚠️ 执行器心跳已过期，执行状态待核对。':null,
    executing&&now-Number(progress?.updatedAt??run?.updatedAt??now)>=30_000
      ?stale?'执行状态待核对，暂无新的公开进展。':'仍在运行，暂无新的公开进展。':null,
    `最近活动：${run?.updatedAt?stamp(Number(run.updatedAt)):'尚无执行事件'}\n状态核对：${stamp(now)}`].filter(Boolean).join('\n\n')};
}
/** One receiver-owned writer. No retry after uncertain side effects. */
export class Feedback {
  private progressBusy = false;
  private reactionBusy = false;
  private finalizers = 0;
  constructor(private store: Store, private sender: Sender, private canAccess:(task:Task)=>boolean=()=>true) {}
  accepted(key: string): void {this.store.db.prepare('INSERT OR IGNORE INTO message_feedback(inboxKey,updatedAt) VALUES(?,?)').run(key,Date.now());}
  recover(): void {
    this.store.db.prepare("UPDATE message_feedback SET state='unknown',error='receiver_stopped' WHERE state IN ('adding','removing')").run();
    this.store.db.prepare("UPDATE progress_updates SET state='unknown',error='receiver_stopped' WHERE state='sending'").run();
  }
  async tick(options: { progress?: boolean; cadenceMs?: number; heartbeatMs?: number } = {}): Promise<void> {
    // Independent lanes: a slow reaction must never hold up readable progress.
    const work:Promise<void>[]=[];
    if(!this.reactionBusy){this.reactionBusy=true;work.push(this.reactions().finally(()=>{this.reactionBusy=false;}));}
    if(options.progress!==false&&!this.progressBusy){this.progressBusy=true;work.push(this.progress(options.cadenceMs??5000,options.heartbeatMs??30000).finally(()=>{this.progressBusy=false;}));}
    await Promise.all(work);
  }
  async settle(): Promise<void> {while(this.progressBusy||this.reactionBusy||this.finalizers)await new Promise(r=>setTimeout(r,20));}
  private async reactions(): Promise<void> {
    if(!this.sender.react)return;
    const row=this.store.db.prepare(`SELECT f.*,i.messageId,t.state AS taskState FROM message_feedback f JOIN inbox i ON i.key=f.inboxKey LEFT JOIN tasks t ON t.id=i.taskId WHERE f.state='pending' OR (f.state='added' AND t.state NOT IN ('queued','running')) ORDER BY f.updatedAt LIMIT 1`).get();
    if(!row)return;
    const live=['queued','running'].includes(String(row.taskState));
    if(row.state==='pending'&&!live){this.store.db.prepare("UPDATE message_feedback SET state='suppressed' WHERE inboxKey=?").run(row.inboxKey);return;}
    if(row.state==='added'&&live)return;
    if(row.state==='added'&&!this.sender.unreact)return;
    this.store.db.prepare('UPDATE message_feedback SET state=?,updatedAt=? WHERE inboxKey=?').run(live?'adding':'removing',Date.now(),row.inboxKey);
    try {
      const id=live?await this.sender.react(String(row.messageId)):(await this.sender.unreact!(String(row.messageId),String(row.reactionId)),row.reactionId);
      this.store.db.prepare('UPDATE message_feedback SET state=?,reactionId=?,updatedAt=? WHERE inboxKey=?').run(live?'added':'removed',id,Date.now(),row.inboxKey);
    }catch(e){const error=e as {unknown?:boolean;code?:string};this.store.transaction(()=>{this.store.db.prepare('UPDATE message_feedback SET state=?,error=? WHERE inboxKey=?').run(error.unknown===false?'failed':'unknown',error.code??'reaction_unknown',row.inboxKey);
      const task=this.store.db.prepare('SELECT t.state FROM tasks t JOIN inbox i ON i.taskId=t.id WHERE i.key=?').get(row.inboxKey);
      if(live&&error.unknown===false&&['queued','running'].includes(String(task?.state)))this.store.addOutput(String(row.inboxKey),'acceptance-fallback','已收到，正在处理。');
    });}
  }
  async finalize(taskId:string):Promise<void>{
    this.finalizers++;
    try {
      while(this.progressBusy)await new Promise(r=>setTimeout(r,20));this.progressBusy=true;
      try {await this.progress(0,30000,taskId);}finally {this.progressBusy=false;}
    } finally {this.finalizers--;}
  }
  private async progress(cadence: number, heartbeat: number, taskId?:string): Promise<void> {
    if(!this.sender.updateCard)return;
    const rows=this.store.db.prepare(`SELECT o.id AS outputId,o.platformId,o.payload,o.acceptedAt,t.* FROM outbox o JOIN tasks t ON t.inboxKey=o.inboxKey WHERE o.kind='progress' AND o.mutableProgress=1 AND o.state='sent' AND o.payload IS NOT NULL AND (? IS NULL OR t.id=?) ORDER BY o.id`).all(taskId??null,taskId??null);
    for(const row of rows){
      if(!this.canAccess(row as unknown as Task))continue;
      const original=JSON.parse(String(row.payload)); if(original.textOnly)continue;
      const last=this.store.db.prepare('SELECT * FROM progress_updates WHERE outboxId=? ORDER BY version DESC LIMIT 1').get(row.outputId);
      if(last&&['unknown','failed','sending'].includes(String(last.state))){
        if(last.state==='unknown'&&!last.checked&&this.sender.readCard){
          this.store.db.prepare('UPDATE progress_updates SET checked=1 WHERE id=?').run(last.id);
          try {const actual=await this.sender.readCard(String(row.platformId)); if(actual===last.content)this.store.db.prepare("UPDATE progress_updates SET state='sent',error=NULL WHERE id=?").run(last.id);}catch{/* Remains visibly unconfirmed; never blindly replay. */}
        }
        continue;
      }
      const task=row as unknown as Task, state=progressState(this.store,task), now=Date.now();
      const changed=last?.revision!==state.revision;
      if(last&&!changed&&(state.terminal||task.state==='waiting'))continue;
      const important=state.terminal||task.state==='waiting';
      if(!important&&now-Number(last?.createdAt??row.acceptedAt??0)<(changed?cadence:heartbeat))continue;
      const card=renderTaskCard(task,state.content,'progress',0);
      // Preserve only the original authorized action tokens, whose acceptance rechecks current task/version.
      if(!state.terminal){const actions=original.elements?.filter((x:{tag:string})=>x.tag==='action')??[];(card as {elements:unknown[]}).elements.push(...actions);}
      const content=JSON.stringify(card),version=Number(last?.version??0)+1;
      this.store.db.prepare("INSERT INTO progress_updates(outboxId,version,state,phase,content,createdAt,revision) VALUES(?,?,'sending',?,?,?,?)").run(row.outputId,version,state.phase,content,now,state.revision);
      try {await this.sender.updateCard(String(row.platformId),card);this.store.db.prepare("UPDATE progress_updates SET state='sent' WHERE outboxId=? AND version=?").run(row.outputId,version);}
      catch(e){const error=e as {unknown?:boolean;code?:string};this.store.db.prepare('UPDATE progress_updates SET state=?,error=? WHERE outboxId=? AND version=?').run(error.unknown===false?'failed':'unknown',error.code??'update_unknown',row.outputId,version);}
      // A terminal commit may race this HTTP request. Correct it in this same
      // writer; independent final delivery never waits on this HTTP lane.
      const current=this.store.db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id);
      if(current&&current.state!==task.state&&!['queued','running','waiting'].includes(String(current.state)))await this.progress(0,heartbeat,task.id);
      return;
    }
  }
}
