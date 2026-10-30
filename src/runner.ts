import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { digest } from './paths.js';
import { workerEnvironment } from './runtime-config.js';
import { Store } from './store.js';
import { extractConversationMemory, RuntimeError, type Runtime, type RunRequest, type RunResult } from './runtime.js';
import type { AutoMemoryInput } from './auto-memory.js';
import { runnerJob, runnerEvent, reconcileRunner } from './runner-store.js';
import { saveRunImages } from './image-inputs.js';

/** The receiver only observes. The detached worker owns the model and durable result. */
export class RunnerRuntime implements Runtime {
  readonly persistent = true;
  constructor(private store: Store, private config: Config) {}
  extractMemory(input: AutoMemoryInput, signal: AbortSignal): Promise<unknown> { return extractConversationMemory(this.config.codex,input,signal); }
  reservations(): { runId: string; chatKey: string; cwd: string; slotKey: string }[] {
    const rows=this.store.db.prepare(`SELECT j.runId,t.chatKey,t.cwd,t.scopeKey,t.ownerId,i.envelope FROM runner_jobs j JOIN task_runs r ON r.id=j.runId
      JOIN tasks t ON t.id=r.taskId JOIN inbox i ON i.key=t.inboxKey WHERE j.state IN ('starting','running','lost')`).all();
    return rows.map(row=>{let group=false;try{group=JSON.parse(String(row.envelope)).chatType==='group';}catch{}
      return {runId:String(row.runId),chatKey:String(row.chatKey),cwd:String(row.cwd),slotKey:group?JSON.stringify(['group',row.chatKey,row.scopeKey,row.ownerId]):String(row.chatKey)};});
  }
  async run(r: RunRequest): Promise<RunResult> {
    if (!r.runId || !r.taskId) throw new RuntimeError('runner_identity_missing');
    const runId = r.runId;
    let launch = false;
    const owner = randomUUID();
    const snapshot = JSON.stringify(this.config);
    this.store.transaction(() => {
      const run = this.store.db.prepare('SELECT taskId,state FROM task_runs WHERE id=?').get(runId);
      if (!run || run.taskId !== r.taskId || run.state !== 'running') throw new RuntimeError('runner_identity_mismatch');
      if (runnerJob(this.store, runId)) return;
      if (r.signal.aborted) throw new RuntimeError(r.signal.reason === 'receiver_stopped' ? 'receiver_detached' : 'cancelled');
      this.store.db.prepare("INSERT INTO runner_jobs(runId,owner,state,createdAt,updatedAt,configRevision,prompt) VALUES(?,?,'starting',?,?,?,?)")
        .run(runId, owner, Date.now(), Date.now(), digest(snapshot), r.prompt);
      saveRunImages(this.store,runId,r.images??[]);
      runnerEvent(this.store, runId, 'reserved'); launch = true;
    });
    if (launch) {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./runner-worker.js', import.meta.url)),
        join(this.config.dataDir, 'bot.sqlite'), this.config.file, runId, owner, '--snapshot'], {
        detached: true, stdio: ['pipe', 'ignore', 'ignore'], cwd: this.config.dataDir,
        env: workerEnvironment(this.config),
      });
      // Registration is written by the worker before it can invoke the model.
      child.on('error', () => {
        try { this.store.transaction(() => {
          if (this.store.db.prepare("UPDATE runner_jobs SET state='failed',error='runner_spawn_failed',updatedAt=? WHERE runId=? AND owner=? AND state='starting'").run(Date.now(), runId, owner).changes)
            runnerEvent(this.store, runId, 'spawn_failed');
        }); } catch { /* Closed receiver: startup reconciliation keeps the reservation. */ }
      });
      // A private pipe carries the receiver's applied config. No credential snapshot is stored on disk.
      child.stdin.on('error', () => {});
      child.stdin.end(snapshot);
      child.unref();
    }
    return new Promise<RunResult>((resolve, reject) => {
      let settled = false, cancellationWritten = false;
      const finish = (error?: RuntimeError, result?: RunResult) => {
        if (settled) return; settled = true; clearInterval(timer); r.signal.removeEventListener('abort', poll);
        if (error) reject(error); else resolve(result!);
      };
      const poll = () => {
        if (settled) return;
        try {
          if (r.signal.aborted && r.signal.reason === 'receiver_stopped') { finish(new RuntimeError('receiver_detached')); return; }
          if (r.signal.aborted && !cancellationWritten) {
            this.store.transaction(() => {
              if (['starting','running'].includes(runnerJob(this.store, runId)?.state ?? '')) {
                this.store.db.prepare('UPDATE inbox SET cancelRequested=1 WHERE taskId=?').run(r.taskId!);
                runnerEvent(this.store, runId, 'cancel_requested');
              }
            }); cancellationWritten = true;
          }
          const job = reconcileRunner(this.store, runId);
          if (!job) { finish(new RuntimeError('runner_record_missing')); return; }
          if (job.state === 'completed') { finish(undefined, JSON.parse(job.result!) as RunResult); return; }
          if (['failed', 'lost', 'reviewed'].includes(job.state)) finish(new RuntimeError(job.error ?? 'runner_lost'));
        } catch { finish(new RuntimeError('runner_observer_error')); }
      };
      const timer = setInterval(poll, 100);
      r.signal.addEventListener('abort', poll); poll();
    });
  }
}
