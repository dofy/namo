import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { digest } from './paths.js';
import { makeRedactor } from './safety.js';
import { Store } from './store.js';
import { Tasks, policyHash, sessionKey } from './tasks.js';
import { CodexRuntime, RuntimeError, type RunControls, type RunResult } from './runtime.js';
import { EvidenceRecorder } from './evidence.js';
import { runnerJob, runnerEvent } from './runner-store.js';
import { recordActivity } from './feedback.js';
import { Waits } from './waits.js';
import { requestWait } from './external-wait-bridge.js';
import { loadRunImages } from './image-inputs.js';

process.umask(0o077);
async function main(): Promise<void> {
  const [database, file, runId, owner] = process.argv.slice(2);
  if (!database || !file || !runId || !owner) return;
  const store = new Store(database), tasks = new Tasks(store);
  const abort = new AbortController();
  const stop = () => abort.abort('worker_stopped');
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  let timer: NodeJS.Timeout | undefined, evidence: EvidenceRecorder | undefined;
  let controls: RunControls | undefined, steering: Promise<void> | undefined;
  let storageFailed = false;
  const owned = () => {
    const job = runnerJob(store, runId);
    if (job?.owner !== owner || job.state !== 'running' || job.pid !== process.pid) throw new RuntimeError('runner_ownership_lost');
  };
  const write = (fn: () => void) => store.transaction(() => { owned(); fn(); });
  try {
    // Compare-and-swap is the only path into execution, even if a duplicate or
    // delayed worker is launched with the same arguments.
    const claimed = store.transaction(() => {
      const row = store.db.prepare("UPDATE runner_jobs SET state='running',pid=?,updatedAt=? WHERE runId=? AND owner=? AND state='starting'")
        .run(process.pid, Date.now(), runId, owner);
      if (row.changes) runnerEvent(store, runId, 'claimed');
      return row.changes === 1;
    });
    if (!claimed) return;
    const run = store.db.prepare('SELECT taskId FROM task_runs WHERE id=?').get(runId)!;
    const task = tasks.get(String(run.taskId))!;
    let result: RunResult | undefined, error: string | undefined;
    try {
      const config = loadConfig(file), revision = digest(readFileSync(file, 'utf8'));
      if (resolve(database) !== join(config.dataDir, 'bot.sqlite') || revision !== runnerJob(store, runId)!.configRevision
        || task.policyHash !== policyHash(config.codex) || realpathSync(task.cwd) !== task.cwd
        || (task.project && config.codex.projects?.[task.project] !== task.cwd)) throw new RuntimeError('task_configuration_changed');
      const redact = makeRedactor([config.feishu.appSecret,config.github?.token??'']);
      if (store.get(task.inboxKey)?.cancelRequested || abort.signal.aborted) throw new RuntimeError('cancelled');
      write(() => { evidence = new EvidenceRecorder(store, runId, task.cwd, config.codex.denyPaths, redact); });
      const steer = (): void => {
        if (!controls || steering || abort.signal.aborted) return;
        steering = (async () => {
          for (;;) {
            const revision = tasks.revisions(task.id)[0];
            if (!revision || abort.signal.aborted) break;
            write(() => { tasks.dispatch(revision.inboxKey, 'submitting'); runnerEvent(store, runId, 'revision_submitting'); });
            let state: string;
            try { state = await controls!.steer(JSON.stringify({ task_id: task.id, revision: revision.version,
              user_message: revision.text, note: '这是该任务所有者追加的要求，较新的明确限制优先。' })); }
            catch { state = 'unknown'; }
            write(() => {
              tasks.dispatch(revision.inboxKey, state); runnerEvent(store, runId, `revision_${state}`);
              store.addOutput(revision.inboxKey, 'notice', state === 'accepted'
                ? `任务 ${task.id} 的补充已被执行器接受，请核对最终结果；不代表此前操作已撤销。`
                : `任务 ${task.id} 的补充${state === 'unknown' ? '提交结果不明' : '未被当前轮接受'}，未自动重送。请用 /task 核对。`);
            });
          }
        })().catch(() => { storageFailed = true; abort.abort('storage_failed'); }).finally(() => { steering = undefined; });
      };
      timer = setInterval(() => {
        try {
          write(() => { store.db.prepare('UPDATE runner_jobs SET updatedAt=? WHERE runId=?').run(Date.now(), runId); });
          if (store.get(task.inboxKey)?.cancelRequested) abort.abort('user_cancelled');
          steer();
        } catch { storageFailed = true; abort.abort('storage_failed'); }
      }, 200);
      const raw = await new CodexRuntime(config.codex).run({ taskId: task.id, runId,
        cwd: task.cwd, prompt: runnerJob(store, runId)!.prompt, images:loadRunImages(store,config.dataDir,runId),
        threadId: tasks.thread(task), signal: abort.signal,
        onProcess: pid => write(() => { store.db.prepare('UPDATE runner_jobs SET runtimePid=? WHERE runId=?').run(pid, runId); runnerEvent(store, runId, 'runtime_started'); }),
        onThread: thread => write(() => {
          store.saveThread(sessionKey(task.workstreamId), thread); store.saveRun(task.inboxKey, thread); tasks.saveRun(runId, thread);
          runnerEvent(store, runId, 'thread_bound');
        }),
        onTurn: turn => write(() => {
          const thread = store.thread(sessionKey(task.workstreamId))!;
          store.saveRun(task.inboxKey, thread, turn); tasks.saveRun(runId, thread, turn); runnerEvent(store, runId, 'turn_bound');
        }),
        onReady: next => { controls = next; steer(); },
        onActivity: phase => write(() => recordActivity(store, runId, phase)),
        onEvidence: item => write(() => evidence!.observe(item)),
        onWait: request => store.transaction(() => {
          owned();
          const safe = request.external ? request
            : { ...request, question: redact(request.question), choices: request.choices?.map(redact) };
          const id = requestWait(store, task.id, runId, safe);
          runnerEvent(store, runId, 'wait_requested'); return id;
        }),
      });
      result = { ...raw, text: redact(raw.text), ...(raw.waiting ? { waiting: { ...raw.waiting, question: redact(raw.waiting.question), choices: raw.waiting.choices?.map(redact) } } : {}) };
    } catch (e) {
      error = abort.signal.reason === 'worker_stopped' ? 'interrupted'
        : storageFailed ? 'runner_storage_error' : e instanceof RuntimeError ? e.code : 'runtime_error';
    } finally { clearInterval(timer); await steering; }
    if (storageFailed) error = 'runner_storage_error';
    write(() => {
      if (store.get(task.inboxKey)?.cancelRequested) error = 'cancelled';
      if (error) new Waits(store).close(task.id, error === 'cancelled');
      evidence?.finish(!error);
      store.db.prepare('UPDATE runner_jobs SET state=?,result=?,error=?,updatedAt=? WHERE runId=?')
        .run(error ? 'failed' : 'completed', error ? null : JSON.stringify(result), error ?? null, Date.now(), runId);
      runnerEvent(store, runId, error ? 'failed' : 'completed');
    });
  } finally {
    clearInterval(timer); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); store.close();
  }
}
// Never forward raw SDK/runtime/storage errors from the independent process.
void main().catch(() => { process.exitCode = 1; });
