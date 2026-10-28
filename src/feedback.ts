import type { Store } from './store.js';
import type { Sender } from './engine.js';
import type { Task } from './tasks.js';
import { renderTaskCard } from './cards.js';
import { progressState } from './task-progress.js';
export { progressState, recordActivity, type ActivityPhase } from './task-progress.js';

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
  private retire(outputId: number): void {
    this.store.db.prepare('UPDATE outbox SET progressRetired=1 WHERE id=?').run(outputId);
  }
  private async progress(cadence: number, heartbeat: number, taskId?:string): Promise<void> {
    if(!this.sender.updateCard)return;
    const rows=this.store.db.prepare(`SELECT o.id AS outputId,o.platformId,o.payload,o.acceptedAt,t.* FROM outbox o JOIN tasks t ON t.inboxKey=o.inboxKey WHERE o.kind='progress' AND o.mutableProgress=1 AND o.progressRetired=0 AND o.state='sent' AND o.payload IS NOT NULL AND (? IS NULL OR t.id=?) ORDER BY o.id`).all(taskId??null,taskId??null);
    for(const row of rows){
      if(!this.canAccess(row as unknown as Task)){
        if(!['queued','running','waiting'].includes(String(row.state)))this.retire(Number(row.outputId));
        continue;
      }
      const original=JSON.parse(String(row.payload)); if(original.textOnly){this.retire(Number(row.outputId));continue;}
      const last=this.store.db.prepare('SELECT * FROM progress_updates WHERE outboxId=? ORDER BY version DESC LIMIT 1').get(row.outputId);
      if(last&&['unknown','failed','sending'].includes(String(last.state))){
        if(last.state==='unknown'&&!last.checked&&this.sender.readCard){
          this.store.db.prepare('UPDATE progress_updates SET checked=1 WHERE id=?').run(last.id);
          try {const actual=await this.sender.readCard(String(row.platformId)); if(actual===last.content){
            this.store.db.prepare("UPDATE progress_updates SET state='sent',error=NULL WHERE id=?").run(last.id);
            continue; // Recompute the current task state on the next pass.
          }}catch{/* Remains visibly unconfirmed; never blindly replay. */}
        }
        if(last.state!=='sending')this.retire(Number(row.outputId));
        continue;
      }
      const task=row as unknown as Task, state=progressState(this.store,task), now=Date.now();
      const changed=last?.revision!==state.revision;
      if(last&&!changed&&(state.terminal||task.state==='waiting')){
        if(state.terminal)this.retire(Number(row.outputId));
        continue;
      }
      const important=state.terminal||task.state==='waiting';
      if(!important&&now-Number(last?.createdAt??row.acceptedAt??0)<(changed?cadence:heartbeat))continue;
      const card=renderTaskCard(task,state.content,'progress',0,[],state.totals);
      // Preserve only the original authorized action tokens, whose acceptance rechecks current task/version.
      if(!state.terminal){const actions=original.elements?.filter((x:{tag:string})=>x.tag==='action')??[];(card as {elements:unknown[]}).elements.push(...actions);}
      const content=JSON.stringify(card),version=Number(last?.version??0)+1;
      this.store.db.prepare("INSERT INTO progress_updates(outboxId,version,state,phase,content,createdAt,revision) VALUES(?,?,'sending',?,?,?,?)").run(row.outputId,version,state.phase,content,now,state.revision);
      try {await this.sender.updateCard(String(row.platformId),card);this.store.db.prepare("UPDATE progress_updates SET state='sent' WHERE outboxId=? AND version=?").run(row.outputId,version);if(state.terminal)this.retire(Number(row.outputId));}
      catch(e){const error=e as {unknown?:boolean;code?:string};this.store.db.prepare('UPDATE progress_updates SET state=?,error=? WHERE outboxId=? AND version=?').run(error.unknown===false?'failed':'unknown',error.code??'update_unknown',row.outputId,version);}
      // A terminal commit may race this HTTP request. Correct it in this same
      // writer; independent final delivery never waits on this HTTP lane.
      const current=this.store.db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id);
      if(current&&current.state!==task.state&&!['queued','running','waiting'].includes(String(current.state)))await this.progress(0,heartbeat,task.id);
      return;
    }
  }
}
