import type { Store } from './store.js';
import type { Sender } from './engine.js';
import type { Task } from './tasks.js';
import { renderTaskCard, taskTitleSummary } from './cards.js';
import { progressState } from './task-progress.js';
import { Waits } from './waits.js';
import { savedTitle } from './title-summary.js';
import { digest } from './paths.js';
export { progressState, recordActivity, type ActivityPhase } from './task-progress.js';

const waitCardUpdateAgeMs = 14 * 86_400_000;

/** One receiver-owned writer. No retry after uncertain side effects. */
export class Feedback {
  private progressBusy = false;
  private reactionBusy = false;
  private finalizers = 0;
  private readRetryAt = new Map<number,number>();
  constructor(private store: Store, private sender: Sender, private canAccess:(task:Task)=>boolean=()=>true, private redact:(text:string)=>string=text=>text) {}
  accepted(key: string): void {this.store.db.prepare('INSERT OR IGNORE INTO message_feedback(inboxKey,updatedAt) VALUES(?,?)').run(key,Date.now());}
  recover(): void {
    this.store.db.prepare("UPDATE message_feedback SET state='unknown',error='receiver_stopped' WHERE state IN ('adding','removing')").run();
    this.store.db.prepare("UPDATE progress_updates SET state='unknown',error='receiver_stopped' WHERE state='sending'").run();
  }
  async tick(options: { progress?: boolean; waitCards?: boolean; cadenceMs?: number; heartbeatMs?: number } = {}): Promise<void> {
    // Independent lanes: a slow reaction must never hold up readable progress.
    const work:Promise<void>[]=[];
    if(!this.reactionBusy){this.reactionBusy=true;work.push(this.reactions().finally(()=>{this.reactionBusy=false;}));}
    if(!this.progressBusy){this.progressBusy=true;work.push((async()=>{if(options.waitCards!==false){await this.approvalCards();await this.waitCards();await this.resultTitles();} if(options.progress!==false) await this.progress(options.cadenceMs??5000,options.heartbeatMs??30000);})().finally(()=>{this.progressBusy=false;}));}
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
  /** Resolve an uncertain update by reading it once; never replay the patch. */
  private async reconcileBlockedUpdate(last: Record<string, unknown>, outputId: number, platformId: string): Promise<void> {
    if (last.state==='unknown' && !last.checked && this.sender.readCard) {
      const updateId=Number(last.id),now=Date.now();
      if ((this.readRetryAt.get(updateId)??0)>now) return;
      try {
        const actual=await this.sender.readCard(platformId);
        this.readRetryAt.delete(updateId);
        this.store.db.prepare('UPDATE progress_updates SET checked=1 WHERE id=?').run(updateId);
        if (actual===last.content) {
          this.store.db.prepare("UPDATE progress_updates SET state='sent',error=NULL WHERE id=?").run(updateId);
          return; // Recompute the latest state on the next pass.
        }
      } catch {
        this.readRetryAt.set(updateId,now+30_000);
        return; // Only the read is retried.
      }
    }
    if (last.state!=='sending') this.retire(outputId);
  }
  /** Reflect durable decisions on the original card after the callback returns. */
  private async approvalCards():Promise<void> {
    if(!this.sender.updateCard)return;
    const rows=this.store.db.prepare(`SELECT o.id AS outputId,o.platformId,o.payload,o.kind,t.* FROM outbox o
      JOIN tasks t ON t.inboxKey=o.inboxKey LEFT JOIN settings s ON s.key=o.kind
      WHERE o.kind LIKE 'mcp-approval:%' AND o.state='sent' AND o.progressRetired=0 AND o.payload IS NOT NULL
        AND (EXISTS(SELECT 1 FROM card_actions a WHERE a.outboxId=o.id AND a.usedAt IS NOT NULL)
          OR t.state<>'running' OR CASE WHEN json_valid(s.value) THEN json_extract(s.value,'$.state')<>'pending' OR json_extract(s.value,'$.expiresAt')<=? ELSE 1 END)
      ORDER BY o.id`).all(Date.now());
    for(const row of rows){
      const task=row as unknown as Task;if(!this.canAccess(task))continue;
      const last=this.store.db.prepare('SELECT * FROM progress_updates WHERE outboxId=? ORDER BY version DESC LIMIT 1').get(row.outputId);
      if(last&&['unknown','failed','sending'].includes(String(last.state))){await this.reconcileBlockedUpdate(last,Number(row.outputId),String(row.platformId));continue;}
      if(last?.state==='sent'){this.retire(Number(row.outputId));continue;}
      const chosen=this.store.db.prepare('SELECT action FROM card_actions WHERE outboxId=? AND usedAt IS NOT NULL ORDER BY usedAt, rowid LIMIT 1').get(row.outputId);
      let approval:{state?:string;always?:boolean};try{approval=JSON.parse(String(this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(row.kind)?.value));}catch{approval={};}
      const action=String(chosen?.action??'').split(':')[0];
      const label=action==='mcp-approve'?'已选择：本次允许':action==='mcp-always'?'已选择：永久允许':action==='mcp-reject'?'已选择：拒绝':approval.state==='rejected'?'已拒绝':approval.always?'已永久允许':['approved','executing','completed','unknown','not_sent'].includes(approval.state??'')?'已允许':'授权已结束';
      const card=JSON.parse(String(row.payload)) as {header?:{title?:{content?:string};template?:string};elements?:{tag?:string}[]};
      if(!Array.isArray(card.elements)){this.retire(Number(row.outputId));continue;}
      if(card.header?.title)card.header.title.content=label;
      if(card.header)card.header.template=action==='mcp-reject'||approval.state==='rejected'||label==='授权已结束'?'grey':'green';
      card.elements=card.elements.map(element=>element.tag==='action'?{tag:'div',text:{tag:'plain_text',content:label}}:element);
      const content=JSON.stringify(card),version=Number(last?.version??0)+1;
      this.store.db.prepare("INSERT INTO progress_updates(outboxId,version,state,phase,content,createdAt,revision) VALUES(?,?,'sending','approval',?,?,?)").run(row.outputId,version,content,Date.now(),label);
      try{await this.sender.updateCard(String(row.platformId),card);this.store.db.prepare("UPDATE progress_updates SET state='sent' WHERE outboxId=? AND version=?").run(row.outputId,version);this.retire(Number(row.outputId));}
      catch(e){const error=e as {unknown?:boolean;code?:string};this.store.db.prepare('UPDATE progress_updates SET state=?,error=? WHERE outboxId=? AND version=?').run(error.unknown===false?'failed':'unknown',error.code??'update_unknown',row.outputId,version);}
      return;
    }
  }
  /** Update a delivered result only after its background title is durable. */
  private async resultTitles():Promise<void> {
    if(!this.sender.updateCard)return;
    const rows=this.store.db.prepare(`SELECT o.id AS outputId,o.platformId,o.payload,t.* FROM outbox o JOIN tasks t ON t.inboxKey=o.inboxKey
      JOIN settings s ON s.key='title-summary:'||t.id||':result' WHERE o.kind='result' AND o.part=0 AND o.state='sent' AND o.progressRetired=0 AND o.payload IS NOT NULL
      AND CASE WHEN json_valid(s.value) THEN json_extract(s.value,'$.state')='completed' ELSE 0 END ORDER BY o.id`).all();
    for(const row of rows){
      const task=row as unknown as Task;if(!this.canAccess(task))continue;
      const last=this.store.db.prepare('SELECT * FROM progress_updates WHERE outboxId=? ORDER BY version DESC LIMIT 1').get(row.outputId);
      if(last&&['unknown','failed','sending'].includes(String(last.state))){await this.reconcileBlockedUpdate(last,Number(row.outputId),String(row.platformId));continue;}
      if(last?.state==='sent'){this.retire(Number(row.outputId));continue;}
      const summary=savedTitle(this.store,task.id,'result');if(!summary)continue;
      const card=JSON.parse(String(row.payload)) as {header?:{title?:{content?:string}}};
      if(!card.header?.title){this.retire(Number(row.outputId));continue;}
      const title=(renderTaskCard(task,'','result',0,[],undefined,undefined,undefined,this.redact(summary)) as {header:{title:{content:string}}}).header.title.content;
      if(card.header.title.content===title){this.retire(Number(row.outputId));continue;}
      card.header.title.content=title;const content=JSON.stringify(card),version=Number(last?.version??0)+1;
      this.store.db.prepare("INSERT INTO progress_updates(outboxId,version,state,phase,content,createdAt,revision) VALUES(?,?,'sending','title',?,?,?)").run(row.outputId,version,content,Date.now(),digest(title));
      try{await this.sender.updateCard(String(row.platformId),card);this.store.db.prepare("UPDATE progress_updates SET state='sent' WHERE outboxId=? AND version=?").run(row.outputId,version);this.retire(Number(row.outputId));}
      catch(e){const error=e as {unknown?:boolean;code?:string};this.store.db.prepare('UPDATE progress_updates SET state=?,error=? WHERE outboxId=? AND version=?').run(error.unknown===false?'failed':'unknown',error.code??'update_unknown',row.outputId,version);}
      return;
    }
  }
  /** Serialize wait-card patches in the same receiver-owned lane as progress. */
  private async waitCards(): Promise<void> {
    if(!this.sender.updateCard)return;
    const rows=this.store.db.prepare(`SELECT o.id AS outputId,o.platformId,o.payload,o.kind,t.* FROM outbox o
      JOIN tasks t ON t.inboxKey=o.inboxKey JOIN task_waits w ON o.kind='wait:'||w.id
      WHERE o.state='sent' AND o.part=0 AND o.progressRetired=0 AND o.payload IS NOT NULL
        AND COALESCE(o.acceptedAt,o.createdAt)>=?
        AND (w.choices LIKE '{%' OR (w.choices LIKE '[%' AND w.state NOT IN ('requested','open')))
      ORDER BY o.id`).all(Date.now()-waitCardUpdateAgeMs);
    for(const row of rows){
      const task=row as unknown as Task;
      if(!this.canAccess(task))continue;
      const wait=new Waits(this.store).get(String(row.kind).slice(5));
      if(!wait || (!wait.choices && !wait.questions))continue;
      const last=this.store.db.prepare('SELECT * FROM progress_updates WHERE outboxId=? ORDER BY version DESC LIMIT 1').get(row.outputId);
      if(last && ['unknown','failed','sending'].includes(String(last.state))) {
        await this.reconcileBlockedUpdate(last,Number(row.outputId),String(row.platformId));
        continue;
      }
      const revision=JSON.stringify({answers:wait.answers,state:wait.state});
      if(last?.revision===revision || !last && wait.state==='open' && wait.answers?.every(value=>value===null))continue;
      const card=JSON.parse(String(row.payload)) as {header?: {title?: {content?:string}; template?:string}; elements?: any[]};
      if(!Array.isArray(card.elements)){this.retire(Number(row.outputId));continue;}
      const statusLine=(content:string)=>({tag:'div',text:{tag:'plain_text',content}});
      const answered=wait.state==='answered';
      if(wait.state!=='open') {
        if(card.header?.title)card.header.title.content=answered?'已回答':'等待已结束';
        if(card.header)card.header.template=answered?'green':'grey';
        card.elements[0]=statusLine(wait.choices?wait.question:answered?'已收到回答。':'本次等待已结束。');
      }
      // A single-choice callback stores its exact choice as the durable reply.
      // Only render values from the original menu, never an arbitrary text reply.
      const reply=wait.choices&&answered&&wait.replyInboxKey?this.store.get(wait.replyInboxKey)?.text.trim():undefined;
      const choice=wait.choices?.find(label=>label===reply);
      const actions=this.store.db.prepare('SELECT token,action FROM card_actions WHERE outboxId=?').all(row.outputId);
      const lookup=new Map(actions.map(a=>[String(a.token),String(a.action)]));
      card.elements=card.elements.flatMap(element=>{
        if(element.tag!=='action' || !Array.isArray(element.actions))return [element];
        const buttonActions:string[]=element.actions.map((button:{value?:{namo?:string}})=>lookup.get(button.value?.namo??'')??'');
        if(wait.choices&&buttonActions.some(action=>/^answer:\d+$/.test(action))) {
          if(choice)return [statusLine(`✓ 已选择：${choice}`)];
          return [statusLine(answered?'已通过文字回复':'本次等待已结束。')];
        }
        const question=buttonActions.map(action=>/^answer:(\d+):(\d+)$/.exec(action)).find(Boolean);
        if(question&&wait.answers&&wait.questions){
          const i=Number(question[1]),selected=wait.answers[i];
          if(selected!==null)return [statusLine(`✓ 已选择：${wait.questions[i].choices[selected]}`)];
          return wait.state==='open'?[element]:[statusLine(answered?'已通过文字回复':'未选择')];
        }
        if(wait.state==='open')return [element];
        const controls=element.actions.filter((_button:unknown,index:number)=>buttonActions[index]!=='cancel');
        return controls.length?[{...element,actions:controls}]:[];
      });
      const content=JSON.stringify(card),version=Number(last?.version??0)+1;
      this.store.db.prepare("INSERT INTO progress_updates(outboxId,version,state,phase,content,createdAt,revision) VALUES(?,?,'sending','wait',?,?,?)").run(row.outputId,version,content,Date.now(),revision);
      try {
        await this.sender.updateCard(String(row.platformId),card);
        this.store.db.prepare("UPDATE progress_updates SET state='sent' WHERE outboxId=? AND version=?").run(row.outputId,version);
        const current=new Waits(this.store).get(wait.id);
        if(current && current.state!=='open' && JSON.stringify({answers:current.answers,state:current.state})===revision)this.retire(Number(row.outputId));
      } catch(e) {
        const error=e as {unknown?:boolean;code?:string};
        this.store.db.prepare('UPDATE progress_updates SET state=?,error=? WHERE outboxId=? AND version=?').run(error.unknown===false?'failed':'unknown',error.code??'update_unknown',row.outputId,version);
      }
      return;
    }
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
      if(last && ['unknown','failed','sending'].includes(String(last.state))) {
        await this.reconcileBlockedUpdate(last,Number(row.outputId),String(row.platformId));
        continue;
      }
      const task=row as unknown as Task, state=progressState(this.store,task), now=Date.now();
      const summary=taskTitleSummary(this.store,task,'progress',state.content,this.redact),revision=state.revision+':'+digest(summary??'');
      const changed=last?.revision!==revision;
      if(last&&!changed&&(state.terminal||task.state==='waiting')){
        if(state.terminal)this.retire(Number(row.outputId));
        continue;
      }
      const important=state.terminal||task.state==='waiting';
      if(!important&&now-Number(last?.createdAt??row.acceptedAt??0)<(changed?cadence:heartbeat))continue;
      const card=renderTaskCard(task,state.content,'progress',0,[],state.totals,undefined,undefined,summary);
      // Preserve only the original authorized action tokens, whose acceptance rechecks current task/version.
      if(!state.terminal){const actions=original.elements?.filter((x:{tag:string})=>x.tag==='action')??[];(card as {elements:unknown[]}).elements.push(...actions);}
      const content=JSON.stringify(card),version=Number(last?.version??0)+1;
      this.store.db.prepare("INSERT INTO progress_updates(outboxId,version,state,phase,content,createdAt,revision) VALUES(?,?,'sending',?,?,?,?)").run(row.outputId,version,state.phase,content,now,revision);
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
