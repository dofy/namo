import type { Store } from './store.js';
import type { WaitRequest } from './runtime.js';
import { ExternalWaitError, ExternalWaits, type ExternalWaitRequest, type GitHubObservationAdapter } from './external-waits.js';
import { Waits, endExternalTaskWait, linkExternalWait, linkedExternalWait, settleExternalWait } from './waits.js';

export class ExternalWaitBridgeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ExternalWaitBridgeError'; }
}

function trustedContext(store: Store, taskId: string, runId: string, request: WaitRequest) {
  const row = store.db.prepare(`SELECT t.ownerId,i.chatId FROM tasks t JOIN inbox i ON i.key=t.inboxKey
    JOIN task_runs r ON r.taskId=t.id WHERE t.id=? AND r.id=?`).get(taskId, runId);
  if (!row) throw new ExternalWaitBridgeError('external_wait_task_missing');
  return { taskId, runId, threadId: request.threadId, turnId: request.turnId, callId: request.callId,
    ownerId: String(row.ownerId), chatId: String(row.chatId) };
}

function externalQuestion(request: ExternalWaitRequest): string {
  return `等待 GitHub ${request.target.owner}/${request.target.repo}#${request.target.pullNumber} 的固定 HEAD ${request.target.headSha.slice(0, 12)} 检查`;
}

/** Persist both the proven task-turn pause and its external condition atomically. */
export function requestExternalWait(store: Store, taskId: string, runId: string, request: WaitRequest,
  now = Date.now()): string {
  if (!request.external) throw new ExternalWaitBridgeError('external_wait_request_missing');
  const externalRequest = request.external;
  return store.transaction(() => {
    const context = trustedContext(store, taskId, runId, request);
    const existing = store.db.prepare('SELECT id FROM task_waits WHERE runId=? AND callId=?').get(runId, request.callId);
    if (existing) {
      const taskWaitId = String(existing.id), externalId = linkedExternalWait(store, taskWaitId);
      if (!externalId) throw new ExternalWaitBridgeError('external_wait_link_missing');
      const persisted = new ExternalWaits(store).request(context, externalRequest, now);
      if (persisted.id !== externalId) throw new ExternalWaitBridgeError('external_wait_link_mismatch');
      return taskWaitId;
    }
    const taskWaitId = new Waits(store).request(taskId, runId, { threadId: request.threadId, turnId: request.turnId,
      callId: request.callId, question: externalQuestion(externalRequest) });
    const external = new ExternalWaits(store).request(context, externalRequest, now);
    linkExternalWait(store, taskWaitId, external.id);
    return taskWaitId;
  });
}

/** Entry point for Engine and detached worker onWait callbacks. */
export function requestWait(store: Store, taskId: string, runId: string, request: WaitRequest, now = Date.now()): string {
  return request.external ? requestExternalWait(store, taskId, runId, request, now)
    : new Waits(store).request(taskId, runId, request);
}

function taskWaitForExternal(store: Store, externalId: string): string | undefined {
  const rows = store.db.prepare("SELECT key FROM settings WHERE key LIKE 'external-wait-link:%' AND value=? LIMIT 2").all(externalId);
  if (rows.length !== 1) return;
  const key = String(rows[0].key), id = key.slice('external-wait-link:'.length);
  return /^WAIT-[A-F0-9]{12}$/.test(id) ? id : undefined;
}

export type ExternalPollAction = Readonly<{ externalWaitId: string; taskWaitId?: string;
  action: 'resumed' | 'timed_out' | 'stale_head' | 'deferred' }>;

/**
 * Poll outside any model turn, atomically queue each ready result once, and
 * terminate timeout/stale waits without executing another model turn.
 */
export async function pollAndResume(store: Store, adapter: GitHubObservationAdapter, now = Date.now(), clock?: () => number): Promise<ExternalPollAction[]> {
  const waits = new ExternalWaits(store);
  const wallStartedAt = Date.now();
  const currentTime = () => clock ? clock() : now + Math.max(0, Date.now() - wallStartedAt);
  await waits.pollOpen(adapter, now, 4, currentTime);
  const actions: ExternalPollAction[] = [];
  for (const external of waits.list()) {
    if (!['ready','timed_out','stale_head'].includes(external.state)) continue;
    const taskWaitId = taskWaitForExternal(store, external.id);
    if (!taskWaitId) { actions.push({ externalWaitId: external.id, action: 'deferred' }); continue; }
    if (external.state === 'timed_out' || external.state === 'stale_head') {
      const ended = endExternalTaskWait(store, taskWaitId, external.id, external.state, currentTime());
      actions.push({ externalWaitId: external.id, taskWaitId, action: ended ? external.state : 'deferred' });
      continue;
    }
    let resumed = false;
    const settledAt = currentTime();
    try {
      waits.consume(external.id, { taskId: external.taskId, ownerId: external.ownerId, chatId: external.chatId }, result => {
        const reply = JSON.stringify(result);
        if (!settleExternalWait(store, taskWaitId, external.id, reply, settledAt))
          throw new ExternalWaitBridgeError('external_wait_resume_not_ready');
        resumed = true;
      }, settledAt);
    } catch (error) {
      if (!(error instanceof ExternalWaitBridgeError || error instanceof ExternalWaitError)) throw error;
    }
    if (resumed) actions.push({ externalWaitId: external.id, taskWaitId, action: 'resumed' });
    else {
      const current = waits.get(external.id);
      if (current?.state === 'timed_out') {
        const ended = endExternalTaskWait(store, taskWaitId, external.id, 'timed_out', currentTime());
        actions.push({ externalWaitId: external.id, taskWaitId, action: ended ? 'timed_out' : 'deferred' });
      } else actions.push({ externalWaitId: external.id, taskWaitId, action: 'deferred' });
    }
  }
  return actions;
}
