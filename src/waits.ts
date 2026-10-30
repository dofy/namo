import { randomBytes } from 'node:crypto';
import type { Incoming, Store } from './store.js';
import type { Task } from './tasks.js';
import { RuntimeError, validWaitChoices, type WaitRequest, type WaitResult } from './runtime.js';
import { ExternalWaits } from './external-waits.js';

export interface TaskWait extends WaitResult {
  taskId: string; runId: string; inputVersion: number; state: string; createdAt: number;
  settledAt?: number; replyInboxKey?: string; replyVersion?: number;
}
export class WaitInputError extends Error {}
export const HUMAN_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function linkedExternalWait(store: Store, taskWaitId: string): string | undefined {
  const value = store.db.prepare('SELECT externalWaitId FROM external_wait_links WHERE taskWaitId=?').get(taskWaitId)?.externalWaitId;
  return typeof value === 'string' && /^EXT-[A-F0-9]{16}$/.test(value) ? value : undefined;
}

export function linkExternalWait(store: Store, taskWaitId: string, externalWaitId: string): void {
  if (!/^WAIT-[A-F0-9]{12}$/.test(taskWaitId) || !/^EXT-[A-F0-9]{16}$/.test(externalWaitId))
    throw new RuntimeError('external_wait_link_invalid');
  store.db.prepare('INSERT INTO external_wait_links(taskWaitId,externalWaitId) VALUES(?,?)').run(taskWaitId, externalWaitId);
}

/** A request is not resumable until the runner has positively ended its turn. */
export class Waits {
  constructor(private store: Store) {}
  private decode(row: unknown): TaskWait | undefined {
    if (!row) return;
    const value = row as Omit<TaskWait, 'choices'> & { choices?: string | null };
    const choices: unknown = value.choices ? JSON.parse(value.choices) : undefined;
    if (choices !== undefined && !validWaitChoices(choices)) throw new RuntimeError('wait_invalid_choices');
    return { ...value, choices } as TaskWait;
  }
  list(taskId: string): unknown[] {
    if (!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_waits'").get()) return [];
    return this.store.db.prepare('SELECT id,runId,question,state,createdAt,settledAt FROM task_waits WHERE taskId=? ORDER BY rowid').all(taskId).map(row=>({...row,external:!!linkedExternalWait(this.store,String(row.id))}));
  }
  get(id: string): TaskWait | undefined {
    return this.decode(this.store.db.prepare('SELECT * FROM task_waits WHERE id=?').get(id));
  }
  current(taskId: string): TaskWait | undefined {
    return this.decode(this.store.db.prepare("SELECT * FROM task_waits WHERE taskId=? AND state IN ('requested','open') ORDER BY rowid DESC LIMIT 1")
      .get(taskId));
  }
  resume(task: Task): TaskWait | undefined {
    return this.decode(this.store.db.prepare("SELECT * FROM task_waits WHERE taskId=? AND state='answered' AND replyVersion<=? ORDER BY replyVersion DESC LIMIT 1")
      .get(task.id, task.inputVersion));
  }
  referenced(m: Incoming): TaskWait | undefined {
    if (!m.envelope?.parentId) return;
    // Include old/closed waits so a stale quotation can never become a fresh task.
    return this.decode(this.store.db.prepare(`SELECT w.* FROM task_waits w JOIN tasks t ON t.id=w.taskId
      JOIN outbox o ON o.inboxKey=t.inboxKey AND o.kind='wait:'||w.id
      WHERE o.platformId=? LIMIT 1`).get(m.envelope.parentId));
  }
  request(taskId: string, runId: string, request: WaitRequest): string {
    return this.store.transaction(() => {
      const row = this.store.db.prepare(`SELECT t.state,t.inputVersion,i.cancelRequested,r.state AS runState,r.threadId,r.turnId
        FROM tasks t JOIN inbox i ON i.key=t.inboxKey JOIN task_runs r ON r.taskId=t.id WHERE t.id=? AND r.id=?`).get(taskId, runId);
      if (!row || row.state !== 'running' || row.runState !== 'running' || row.cancelRequested
        || row.threadId !== request.threadId || row.turnId !== request.turnId) throw new RuntimeError('wait_identity_mismatch');
      if (this.current(taskId) || this.store.db.prepare('SELECT 1 FROM task_waits WHERE runId=?').get(runId)) throw new RuntimeError('wait_already_requested');
      if (!request.question.trim() || [...request.question].length > 1500 || !request.callId) throw new RuntimeError('wait_invalid_request');
      if (request.choices !== undefined && !validWaitChoices(request.choices)) throw new RuntimeError('wait_invalid_choices');
      if (this.store.db.prepare("SELECT 1 FROM task_messages WHERE taskId=? AND role='revision' AND dispatch NOT IN ('accepted','applied')").get(taskId))
        throw new RuntimeError('wait_unresolved_revision');
      const id = `WAIT-${randomBytes(6).toString('hex').toUpperCase()}`;
      this.store.db.prepare(`INSERT INTO task_waits(id,taskId,runId,threadId,turnId,callId,question,inputVersion,state,createdAt,choices)
        VALUES(?,?,?,?,?,?,?,?,'requested',?,?)`).run(id, taskId, runId, request.threadId, request.turnId, request.callId, request.question.trim(), Number(row.inputVersion), Date.now(), request.choices ? JSON.stringify(request.choices) : null);
      return id;
    });
  }
  park(task: Task, runId: string, result: WaitResult): void {
    this.store.transaction(() => {
      const w = this.get(result.id), current = this.store.db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id);
      if (!w || w.state !== 'requested' || w.taskId !== task.id || w.runId !== runId || w.threadId !== result.threadId
        || w.turnId !== result.turnId || w.callId !== result.callId || current?.state !== 'running') throw new RuntimeError('wait_result_mismatch');
      if (this.store.get(task.inboxKey)?.cancelRequested) throw new RuntimeError('cancelled');
      const now = Date.now();
      this.store.db.prepare("UPDATE task_waits SET state='open' WHERE id=?").run(w.id);
      this.store.db.prepare("UPDATE tasks SET state='waiting',error=NULL WHERE id=?").run(task.id);
      this.store.db.prepare("UPDATE inbox SET state='waiting' WHERE key=? AND state='running'").run(task.inboxKey);
      this.store.db.prepare("UPDATE task_runs SET state='waiting',finishedAt=? WHERE id=? AND state='running'").run(now, runId);
      const external = linkedExternalWait(this.store, w.id);
      this.store.addOutput(task.inboxKey, `wait:${w.id}`, external
        ? `${w.question}\n\n系统会只读核对固定的 PR HEAD；普通回复、引用、按钮或 /resume 都不会跳过条件。等待期间不会继续执行；/cancel ${task.id} 可停止任务。`
        : `${w.question}${w.choices ? '\n选项：' + w.choices.join(' / ') : ''}\n\n请引用这条消息回复，或发送：\n/resume ${w.id} 你的回答\n等待最长 24 小时，超时后任务结束；/cancel ${task.id} 可停止任务。`);
    });
  }
  answer(w: TaskWait, m: Incoming, reply: string): void {
    this.expire();
    this.store.transaction(() => {
      const current = this.get(w.id);
      const t = this.store.db.prepare('SELECT * FROM tasks WHERE id=?').get(w.taskId) as unknown as Task | undefined;
      if (!t || t.ownerId !== m.senderId || t.chatKey !== m.chatKey || t.scopeKey !== (m.envelope?.scopeKey ?? m.chatKey))
        throw new WaitInputError('未找到本话题中属于你的等待事项。');
      if (linkedExternalWait(this.store, w.id))
        throw new WaitInputError('这是系统外部条件等待，普通回复、引用、按钮或 /resume 不能恢复。可用 /cancel 停止任务。');
      if (current?.state !== 'open' || t.state !== 'waiting' || t.inputVersion !== current.inputVersion
        || this.store.get(t.inboxKey)?.cancelRequested) throw new WaitInputError('这次等待已结束或尚未准备好，未恢复任务。请用 /task 查看最新状态。');
      if (!reply.trim() || reply.length > 16_000) throw new WaitInputError('请提供 1 到 16000 字符的回答。');
      if (t.inputVersion >= 100) throw new WaitInputError('本任务已达到输入版本上限，请先取消，再明确发起后续任务。');
      if (this.store.db.prepare('SELECT state FROM task_runs WHERE id=?').get(w.runId)?.state !== 'waiting') throw new WaitInputError('上一轮执行尚未确认结束，未恢复任务。');
      this.settle(current, t, m.key);
    });
  }
  expire(now=Date.now()):void {
    this.store.transaction(()=>{
      // Existing waits get a full grace period after this feature is first
      // enabled, rather than expiring immediately after an upgrade.
      this.store.db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('human-wait-expiry-enabled-at',?)").run(String(now));
      const enabledAt=Number(this.store.db.prepare("SELECT value FROM settings WHERE key='human-wait-expiry-enabled-at'").get()?.value);
      if(!Number.isSafeInteger(enabledAt)||enabledAt>now-HUMAN_WAIT_TIMEOUT_MS)return;
      const rows=this.store.db.prepare(`SELECT w.id,w.taskId,t.inboxKey FROM task_waits w JOIN tasks t ON t.id=w.taskId
        WHERE w.state='open' AND t.state='waiting' AND w.createdAt<=?
        AND NOT EXISTS(SELECT 1 FROM external_wait_links e WHERE e.taskWaitId=w.id)`).all(now-HUMAN_WAIT_TIMEOUT_MS);
      for(const row of rows){
        const id=String(row.id),taskId=String(row.taskId),key=String(row.inboxKey);
        this.store.db.prepare("UPDATE task_waits SET state='expired',settledAt=? WHERE id=? AND state='open'").run(now,id);
        this.store.db.prepare("UPDATE tasks SET state='failed',error='wait_expired',finishedAt=? WHERE id=? AND state='waiting'").run(now,taskId);
        this.store.db.prepare("UPDATE inbox SET state='awaiting_reply',error='wait_expired',finishedAt=? WHERE key=? AND state='waiting'").run(now,key);
        this.suppress(id);
        this.store.addOutput(key,'result','等待回复已超过 24 小时，任务已结束，未自动继续。此前执行过的操作不会自动撤销；如需继续，请重新发起任务。');
      }
    });
  }
  close(taskId: string, cancelled: boolean): void {
    this.store.transaction(() => {
      const rows = this.store.db.prepare("SELECT id FROM task_waits WHERE taskId=? AND state IN ('requested','open')").all(taskId);
      for (const row of rows) {
        const externalId = linkedExternalWait(this.store, String(row.id));
        if (externalId) {
          const task = this.store.db.prepare('SELECT ownerId,inboxKey FROM tasks WHERE id=?').get(taskId);
          const inbox = task ? this.store.get(String(task.inboxKey)) : undefined;
          if (task && inbox) new ExternalWaits(this.store).cancel(externalId,
            { taskId, ownerId: String(task.ownerId), chatId: inbox.chatId });
        }
        this.store.db.prepare('UPDATE task_waits SET state=?,settledAt=? WHERE id=?').run(cancelled ? 'cancelled' : 'uncertain', Date.now(), row.id);
        this.suppress(String(row.id));
      }
    });
  }
  private suppress(id: string): void {
    this.store.db.prepare("UPDATE outbox SET state='suppressed',error='wait_closed' WHERE kind=? AND state IN ('pending','deferred')").run(`wait:${id}`);
  }
  private settle(current: TaskWait, task: Task, replyInboxKey: string): void {
    const version = task.inputVersion + 1;
    this.store.db.prepare('UPDATE inbox SET taskId=? WHERE key=?').run(task.id, replyInboxKey);
    this.store.db.prepare("INSERT INTO task_messages(taskId,inboxKey,role,version) VALUES(?,?,'wait_reply',?)").run(task.id, replyInboxKey, version);
    this.store.db.prepare("UPDATE task_waits SET state='answered',replyInboxKey=?,replyVersion=?,settledAt=? WHERE id=?")
      .run(replyInboxKey, version, Date.now(), current.id);
    this.store.db.prepare("UPDATE tasks SET state='queued',inputVersion=?,finishedAt=NULL,error=NULL WHERE id=?").run(version, task.id);
    this.store.db.prepare("UPDATE inbox SET state='queued',finishedAt=NULL,error=NULL WHERE key=?").run(task.inboxKey);
    this.suppress(current.id);
  }
  recover(): void {
    // A crash before a terminal runner receipt leaves the request uncertain.
    const now = Date.now();
    const rows = this.store.db.prepare(`SELECT w.id,w.taskId,t.ownerId,t.inboxKey FROM task_waits w JOIN tasks t ON t.id=w.taskId
      WHERE w.state='requested' AND t.state!='running'`).all();
    for (const row of rows) {
      const externalId = linkedExternalWait(this.store, String(row.id)), inbox = this.store.get(String(row.inboxKey));
      if (externalId && inbox) new ExternalWaits(this.store).cancel(externalId,
        { taskId: String(row.taskId), ownerId: String(row.ownerId), chatId: inbox.chatId }, now);
      this.store.db.prepare("UPDATE task_waits SET state='uncertain',settledAt=? WHERE id=? AND state='requested'").run(now, row.id);
      this.suppress(String(row.id));
    }
  }
}

/** @internal Called only by the system external-wait bridge inside its consume transaction. */
export function settleExternalWait(store: Store, taskWaitId: string, externalWaitId: string, reply: string,
  now = Date.now()): boolean {
  return store.transaction(() => {
    if (linkedExternalWait(store, taskWaitId) !== externalWaitId || !reply.trim() || reply.length > 16_000) return false;
    const external = new ExternalWaits(store).get(externalWaitId);
    const wait = new Waits(store).get(taskWaitId);
    if (!external || external.state !== 'ready' || !wait || wait.state !== 'open') return false;
    const task = store.db.prepare('SELECT * FROM tasks WHERE id=?').get(wait.taskId) as unknown as Task | undefined;
    if (!task || task.state !== 'waiting' || task.inputVersion !== wait.inputVersion || task.inputVersion >= 100
      || store.get(task.inboxKey)?.cancelRequested
      || store.db.prepare('SELECT state FROM task_runs WHERE id=?').get(wait.runId)?.state !== 'waiting') return false;
    const root = store.get(task.inboxKey);
    if (!root || external.taskId !== task.id || external.runId !== wait.runId || external.ownerId !== task.ownerId
      || external.chatId !== root.chatId) return false;
    const key = `external-result:${externalWaitId}`;
    if (!store.enqueue({ key, messageId: key, chatKey: task.chatKey, chatId: root.chatId, senderId: task.ownerId,
      text: reply, createdAt: now, envelope: { version: 1, type: 'external_wait_result', kind: 'material', scopeKey: task.scopeKey,
        chatType: root.envelope?.chatType, materials: [], limitations: ['系统只读观察，不是用户回答或操作授权'] } })) return false;
    store.db.prepare("UPDATE inbox SET state='linked',taskId=? WHERE key=?").run(task.id, key);
    const version = task.inputVersion + 1;
    store.db.prepare("INSERT INTO task_messages(taskId,inboxKey,role,version) VALUES(?,?,'wait_reply',?)").run(task.id, key, version);
    store.db.prepare("UPDATE task_waits SET state='answered',replyInboxKey=?,replyVersion=?,settledAt=? WHERE id=?")
      .run(key, version, now, wait.id);
    store.db.prepare("UPDATE tasks SET state='queued',inputVersion=?,finishedAt=NULL,error=NULL WHERE id=?").run(version, task.id);
    store.db.prepare("UPDATE inbox SET state='queued',finishedAt=NULL,error=NULL WHERE key=?").run(task.inboxKey);
    store.db.prepare("UPDATE outbox SET state='suppressed',error='wait_closed' WHERE kind=? AND state IN ('pending','deferred')")
      .run(`wait:${wait.id}`);
    return true;
  });
}

/** @internal End an external wait without running another model turn. */
export function endExternalTaskWait(store: Store, taskWaitId: string, externalWaitId: string,
  reason: 'timed_out' | 'stale_head', now = Date.now()): boolean {
  return store.transaction(() => {
    if (linkedExternalWait(store, taskWaitId) !== externalWaitId) return false;
    const wait = new Waits(store).get(taskWaitId), external = new ExternalWaits(store).get(externalWaitId);
    if (!wait || wait.state !== 'open' || !external || external.state !== reason) return false;
    const task = store.db.prepare('SELECT * FROM tasks WHERE id=?').get(wait.taskId) as unknown as Task | undefined;
    if (!task || task.state !== 'waiting') return false;
    const root = store.get(task.inboxKey);
    if (!root || root.state !== 'waiting') return false;
    const message = reason === 'timed_out'
      ? '外部检查等待已超时，未自动继续任务，也没有执行推送、合并或部署。请核对 PR 后明确发起后续任务。'
      : 'PR HEAD 已变化，原等待绑定的提交已失效，未自动继续任务。请核对新的提交和 required checks 后明确发起后续任务。';
    store.db.prepare('UPDATE task_waits SET state=?,settledAt=? WHERE id=?').run(reason, now, wait.id);
    store.db.prepare("UPDATE task_runs SET state='failed',error=?,finishedAt=? WHERE id=? AND state='waiting'").run(`external_wait_${reason}`, now, wait.runId);
    store.db.prepare("UPDATE tasks SET state='needs_attention',error=?,finishedAt=? WHERE id=?")
      .run(`external_wait_${reason}`, now, task.id);
    store.db.prepare("UPDATE inbox SET state='running' WHERE key=? AND state='waiting'").run(task.inboxKey);
    store.finish(task.inboxKey, message, `external_wait_${reason}`);
    store.db.prepare("UPDATE outbox SET state='suppressed',error='wait_closed' WHERE kind=? AND state IN ('pending','deferred')")
      .run(`wait:${wait.id}`);
    return true;
  });
}
