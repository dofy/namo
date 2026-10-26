import { randomUUID } from 'node:crypto';
import { digest } from './paths.js';
import { Store } from './store.js';

export class RecoveryError extends Error {}
export interface Actor { id: string; chatKey?: string; }
export interface Resolution { subject: string; stamp: string; action: string; note: string; requestId: string; acknowledgeDuplicate?: boolean; }
export class Recovery {
  constructor(private store: Store) {}
  private allowed(row: { ownerId?: string; senderId?: string; chatKey: string }, actor?: Actor): boolean {
    return !actor || ((row.ownerId ?? row.senderId) === actor.id && row.chatKey === actor.chatKey);
  }
  inspect(subject: string, actor?: Actor): any {
    const delivery = /^D-[1-9]\d*$/.test(subject);
    const row = delivery ? this.store.db.prepare(`SELECT o.*,i.senderId,i.chatKey,i.taskId FROM outbox o JOIN inbox i ON i.key=o.inboxKey WHERE o.id=?`).get(Number(subject.slice(2)))
      : /^N-[A-F0-9]{12}$/.test(subject) ? this.store.db.prepare('SELECT * FROM tasks WHERE id=?').get(subject) : undefined;
    if (!row || !this.allowed(row as any, actor)) throw new RecoveryError('未找到可访问的记录');
    const snapshot = delivery ? { id: row.id, state: row.state, uuid: row.uuid, platformId: row.platformId, error: row.error, content: digest(String(row.content)), payload: digest(String(row.payload)) }
      : { id: row.id, state: row.state, inputVersion: row.inputVersion, finishedAt: row.finishedAt, error: row.error };
    const stamp = digest(JSON.stringify(snapshot)).slice(0, 24);
    const reviewed = !!this.store.db.prepare("SELECT 1 FROM reconciliations WHERE subject=? AND action='reviewed' AND beforeState=?").get(subject, JSON.stringify(snapshot));
    const actionable = delivery ? ['unknown', 'failed'].includes(String(row.state)) : ['interrupted', 'needs_attention', 'failed'].includes(String(row.state)) && !reviewed;
    return { subject, stamp, type: delivery ? 'delivery' : 'task', state: row.state, taskId: delivery ? row.taskId : row.id,
      error: row.error, kind: row.kind, part: row.part, platformReceipt: delivery ? !!row.platformId : undefined,
      content: delivery ? row.content : undefined, reviewed, actionable,
      actions: actionable ? delivery ? ['received', ...(row.kind === 'result' ? ['retry'] : []), 'dismiss'] : ['reviewed'] : [],
      guidance: delivery ? '先在飞书核对。确认收到只记账；重发只发送这段已保存结果，可能重复；放弃发送不会删除历史。'
        : '先核对代码、Git 和外部操作。标记已核对不会改变执行结论或重跑；如需继续，请明确发起后续任务。',
      history: this.store.db.prepare('SELECT action,note,createdAt FROM reconciliations WHERE subject=? ORDER BY id DESC LIMIT 20').all(subject),
      snapshot, inboxKey: row.inboxKey };
  }
  list(actor?: Actor): any[] {
    const outputs = this.store.db.prepare("SELECT id FROM outbox WHERE state IN ('unknown','failed') ORDER BY id DESC LIMIT 100").all();
    const tasks = this.store.db.prepare("SELECT id FROM tasks WHERE state IN ('interrupted','needs_attention','failed') ORDER BY rowid DESC LIMIT 100").all();
    return [...outputs.map(r => `D-${r.id}`), ...tasks.map(r => String(r.id))].flatMap(id => {
      try { const x=this.inspect(id,actor); const { snapshot: _s, inboxKey: _k, content: _c, ...safe }=x; return safe.actionable ? [safe] : []; }
      catch(e) { if(e instanceof RecoveryError) return []; throw e; }
    }).slice(0, 100);
  }
  resolve(r: Resolution, actor: Actor, local = false): { duplicate: boolean } {
    if (!r.requestId || r.requestId.length > 256 || !r.note?.trim() || r.note.length > 1000) throw new RecoveryError('请填写不超过 1000 字的核对依据');
    return this.store.transaction(() => {
      const old = this.store.db.prepare('SELECT subject,actor,action,note FROM reconciliations WHERE requestId=?').get(r.requestId);
      if (old) {
        if (old.subject!==r.subject || old.actor!==actor.id || old.action!==r.action || old.note!==r.note.trim()) throw new RecoveryError('操作编号已用于其他请求');
        return { duplicate:true };
      }
      const x = this.inspect(r.subject, local ? undefined : actor);
      if (x.stamp!==r.stamp || !x.actionable || !x.actions.includes(r.action)) throw new RecoveryError('记录已变化或操作不可用，请刷新后重新核对');
      if (r.action==='retry' && x.state==='unknown' && !r.acknowledgeDuplicate) throw new RecoveryError('发送结果不明；重发可能产生重复消息，需明确确认');
      this.store.db.prepare('INSERT INTO reconciliations(requestId,subject,actor,action,note,beforeState,createdAt) VALUES(?,?,?,?,?,?,?)')
        .run(r.requestId,r.subject,actor.id,r.action,r.note.trim(),JSON.stringify(x.snapshot),Date.now());
      if (x.type==='delivery') {
        const state=r.action==='received'?'confirmed':r.action==='dismiss'?'dismissed':'pending';
        if (r.action==='retry') {
          // Keep prior attempt evidence in the append-only audit. A retry gets its own UUID.
          this.store.db.prepare('UPDATE outbox SET state=?,uuid=?,error=NULL,platformId=NULL,payload=NULL WHERE id=?').run(state,randomUUID(),x.snapshot.id);
          this.store.db.prepare('DELETE FROM card_actions WHERE outboxId=?').run(x.snapshot.id);
        } else this.store.db.prepare('UPDATE outbox SET state=? WHERE id=?').run(state,x.snapshot.id);
        if (x.kind==='result') {
          const task = this.store.db.prepare('SELECT error FROM tasks WHERE inboxKey=?').get(x.inboxKey);
          // Pre-M1 messages have no separate execution record; delivery errors may have
          // overwritten their original outcome. Reconciliation must not invent success.
          this.store.db.prepare("UPDATE inbox SET state='awaiting_reply',error=? WHERE key=?").run(task ? task.error : 'legacy_execution_unverified',x.inboxKey);
          this.store.completeDelivery(x.inboxKey);
        }
      }
      return { duplicate:false };
    });
  }
}
