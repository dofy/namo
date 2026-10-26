import { randomBytes } from 'node:crypto';
import type { Incoming, Store } from './store.js';
import type { Task } from './tasks.js';
import { RuntimeError, validWaitChoices, type WaitRequest, type WaitResult } from './runtime.js';

export interface TaskWait extends WaitResult {
  taskId: string; runId: string; inputVersion: number; state: string; createdAt: number;
  settledAt?: number; replyInboxKey?: string; replyVersion?: number;
}
export class WaitInputError extends Error {}

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
    return this.store.db.prepare('SELECT id,runId,question,state,createdAt,settledAt FROM task_waits WHERE taskId=? ORDER BY rowid').all(taskId);
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
      this.store.addOutput(task.inboxKey, `wait:${w.id}`, `${w.question}${w.choices ? '\n选项：' + w.choices.join(' / ') : ''}\n\n请引用这条消息回复，或发送：\n/resume ${w.id} 你的回答\n等待期间不会继续执行；/cancel ${task.id} 可停止任务。`);
    });
  }
  answer(w: TaskWait, m: Incoming, reply: string): void {
    this.store.transaction(() => {
      const current = this.get(w.id);
      const t = this.store.db.prepare('SELECT * FROM tasks WHERE id=?').get(w.taskId) as unknown as Task | undefined;
      if (!t || t.ownerId !== m.senderId || t.chatKey !== m.chatKey || t.scopeKey !== (m.envelope?.scopeKey ?? m.chatKey))
        throw new WaitInputError('未找到本话题中属于你的等待事项。');
      if (current?.state !== 'open' || t.state !== 'waiting' || t.inputVersion !== current.inputVersion
        || this.store.get(t.inboxKey)?.cancelRequested) throw new WaitInputError('这次等待已结束或尚未准备好，未恢复任务。请用 /task 查看最新状态。');
      if (!reply.trim() || reply.length > 16_000) throw new WaitInputError('请提供 1 到 16000 字符的回答。');
      if (t.inputVersion >= 100) throw new WaitInputError('本任务已达到输入版本上限，请先取消，再明确发起后续任务。');
      if (this.store.db.prepare('SELECT state FROM task_runs WHERE id=?').get(w.runId)?.state !== 'waiting') throw new WaitInputError('上一轮执行尚未确认结束，未恢复任务。');
      const version = t.inputVersion + 1;
      // Store only the owner's reply as the continuation; never replay the original prompt.
      this.store.db.prepare('UPDATE inbox SET taskId=? WHERE key=?').run(t.id, m.key);
      this.store.db.prepare("INSERT INTO task_messages(taskId,inboxKey,role,version) VALUES(?,?,'wait_reply',?)").run(t.id, m.key, version);
      this.store.db.prepare("UPDATE task_waits SET state='answered',replyInboxKey=?,replyVersion=?,settledAt=? WHERE id=?").run(m.key, version, Date.now(), w.id);
      this.store.db.prepare("UPDATE tasks SET state='queued',inputVersion=?,finishedAt=NULL,error=NULL WHERE id=?").run(version, t.id);
      this.store.db.prepare("UPDATE inbox SET state='queued',finishedAt=NULL,error=NULL WHERE key=?").run(t.inboxKey);
      this.suppress(w.id);
    });
  }
  close(taskId: string, cancelled: boolean): void {
    this.store.transaction(() => {
      const rows = this.store.db.prepare("SELECT id FROM task_waits WHERE taskId=? AND state IN ('requested','open')").all(taskId);
      for (const row of rows) {
        this.store.db.prepare('UPDATE task_waits SET state=?,settledAt=? WHERE id=?').run(cancelled ? 'cancelled' : 'uncertain', Date.now(), row.id);
        this.suppress(String(row.id));
      }
    });
  }
  private suppress(id: string): void {
    this.store.db.prepare("UPDATE outbox SET state='suppressed',error='wait_closed' WHERE kind=? AND state IN ('pending','deferred')").run(`wait:${id}`);
  }
  recover(): void {
    // A crash before a terminal runner receipt leaves the request uncertain.
    this.store.db.prepare(`UPDATE task_waits SET state='uncertain',settledAt=? WHERE state='requested'
      AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=task_waits.taskId AND t.state!='running')`).run(Date.now());
  }
}
