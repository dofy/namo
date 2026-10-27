import type { Store } from './store.js';

export interface RunnerJob {
  runId: string; owner: string; state: 'starting' | 'running' | 'completed' | 'failed' | 'lost' | 'reviewed';
  pid: number | null; runtimePid: number | null; createdAt: number; updatedAt: number; configRevision: string;
  prompt: string; result: string | null; error: string | null;
}
export function processState(pid: number): 'alive' | 'dead' | 'unknown' {
  if (!Number.isSafeInteger(pid) || pid < 1) return 'unknown';
  try { process.kill(pid, 0); return 'alive'; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
}
/** Codex is detached on POSIX, so its PID is also its process-group ID.
 * The group may survive its leader; signal 0 observes without terminating it. */
export function processGroupState(pgid: number): 'alive' | 'dead' | 'unknown' {
  if (process.platform === 'win32' || !Number.isSafeInteger(pgid) || pgid < 1) return 'unknown';
  try { process.kill(-pgid, 0); return 'alive'; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
}
export function runnerEvent(store: Store, runId: string, kind: string): void {
  store.db.prepare('INSERT INTO runner_events(runId,kind,createdAt) VALUES(?,?,?)').run(runId, kind, Date.now());
}
export function runnerJob(store: Store, runId: string): RunnerJob | undefined {
  return store.db.prepare('SELECT * FROM runner_jobs WHERE runId=?').get(runId) as unknown as RunnerJob | undefined;
}
export function runnerDetails(store: Store, taskId: string): unknown[] {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='runner_jobs' AND type='table'").get()) return [];
  return store.db.prepare(`SELECT j.runId,j.state,j.pid,j.runtimePid,j.createdAt,j.updatedAt,j.error FROM runner_jobs j
    JOIN task_runs r ON r.id=j.runId WHERE r.taskId=? ORDER BY j.createdAt`).all(taskId).map(row => ({ ...row,
    events: store.db.prepare('SELECT kind,createdAt FROM runner_events WHERE runId=? ORDER BY seq DESC LIMIT 100').all(row.runId).reverse(),
  }));
}

/** Missing heartbeat is diagnostic only. Never reuse an execution after a lease expires. */
export function reconcileRunner(store: Store, runId: string, now = Date.now()): RunnerJob | undefined {
  return store.transaction(() => {
    const job = runnerJob(store, runId);
    if (!job || !['starting', 'running'].includes(job.state)) return job;
    const lost = job.pid ? processState(job.pid) === 'dead' : job.state === 'starting' && now - job.createdAt > 30_000;
    if (!lost) return job;
    // A late starter can no longer claim this run. A lost worker may have left
    // descendants behind, so retain its scheduling reservation until reviewed.
    store.db.prepare("UPDATE runner_jobs SET state='lost',error='runner_lost',updatedAt=? WHERE runId=? AND owner=?")
      .run(now, runId, job.owner);
    store.db.prepare("UPDATE task_messages SET dispatch='unknown' WHERE taskId=(SELECT taskId FROM task_runs WHERE id=?) AND dispatch='submitting'").run(runId);
    const evidence = store.db.prepare('SELECT report FROM run_evidence WHERE runId=?').get(runId);
    if (evidence) {
      const report = JSON.parse(String(evidence.report));
      if (report.state === 'collecting') {
        report.state = 'partial';
        report.items = report.items.map((item: { status: string }) => item.status === 'running' ? { ...item, status: 'unknown' } : item);
        store.db.prepare('UPDATE run_evidence SET report=? WHERE runId=?').run(JSON.stringify(report), runId);
      }
    }
    runnerEvent(store, runId, 'owner_lost');
    return runnerJob(store, runId);
  });
}
