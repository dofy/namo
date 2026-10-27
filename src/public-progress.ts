import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import { makeRedactor } from './safety.js';

/** Public, completed messages and safe action labels, never token or reasoning streams. */
export interface PublicProgressEvent {
  id: string;
  kind: 'commentary' | 'plan' | 'tool';
  status: 'running' | 'completed' | 'failed';
  text: string;
  threadId?: string;
  turnId?: string;
  outcome?: 'success' | 'failure' | 'unknown';
  plan?: { total: number; completed: number; running: number };
}
interface Entry extends Omit<PublicProgressEvent, 'threadId' | 'turnId'> { sequence: number; }
export interface PublicProgress {
  revision: number;
  firstAt: number;
  updatedAt: number;
  events: Entry[];
  // Bounded tombstones prevent late starts from replacing completed tools.
  seen: { id: string; status: PublicProgressEvent['status']; hash: string; kind?: PublicProgressEvent['kind']; outcome?: PublicProgressEvent['outcome'] }[];
  plan?: PublicProgressEvent['plan'];
  limited?: boolean;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

export function readProgress(store: Store, runId: string): PublicProgress | undefined {
  const row = store.db.prepare('SELECT report FROM run_progress WHERE runId=?').get(runId);
  return row ? JSON.parse(String(row.report)) as PublicProgress : undefined;
}

/** Called inside the worker ownership transaction, or by the receiver's local runtime. */
export function recordProgress(store: Store, runId: string, event: PublicProgressEvent,
  redact: (text: string) => string = text => text): void {
  if (!event || typeof event.id !== 'string' || !event.id || event.id.length > 256
    || !['commentary','plan','tool'].includes(event.kind) || !['running','completed','failed'].includes(event.status)
    || typeof event.text !== 'string' || event.text.length > 16_000) return;
  if (event.outcome !== undefined && !['success','failure','unknown'].includes(event.outcome)) return;
  if (event.plan && (event.kind !== 'plan' || typeof event.plan !== 'object' || Array.isArray(event.plan)
    || Object.keys(event.plan).some(key=>!['total','completed','running'].includes(key))
    || ![event.plan.total,event.plan.completed,event.plan.running].every(n=>Number.isSafeInteger(n)&&n>=0)
    || event.plan.total < 1 || event.plan.total > 100 || event.plan.completed+event.plan.running > event.plan.total)) return;
  store.transaction(() => {
    const run = store.db.prepare(`SELECT r.*,t.state AS taskState FROM task_runs r JOIN tasks t ON t.id=r.taskId
      WHERE r.id=? AND NOT EXISTS(SELECT 1 FROM task_runs newer WHERE newer.taskId=r.taskId AND newer.rowid>r.rowid)`).get(runId);
    if (!run || run.state !== 'running' || run.taskState !== 'running'
      || (event.threadId && run.threadId && event.threadId !== run.threadId)
      || (event.turnId && run.turnId && event.turnId !== run.turnId)) return;
    // Apply configured secrets and generic patterns before persistence. Suppress
    // code, links, local paths and markup rather than echoing tool-shaped text.
    const text = Array.from(makeRedactor()(redact(event.text))
      .replace(/```[\s\S]*?(?:```|$)/g, '[代码已省略]')
      .replace(/`+[^`]*(?:`+|$)/g, '[代码已省略]')
      .replace(/https?:\/\/[^\s<>]+/gi, '[链接已省略]')
      .replace(/(?:[A-Za-z]:\\|(?<![0-9])(?:~|\.{1,2})?\/)[^\s，。；、<>"']+/g, '[路径已省略]')
      .replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
      .replace(/\s+/g, ' ').trim()).slice(0, 180).join('');
    if (!text) return;
    const report = readProgress(store, runId) ?? { revision: 0, firstAt: Date.now(), updatedAt: 0, events: [], seen: [] };
    const id = hash(event.kind + ':' + event.id), digest = hash(JSON.stringify([text,event.outcome,event.plan])), old = report.seen.find(x => x.id === id);
    if (old && (event.kind === 'tool' && old.status !== 'running' && event.status === 'running'
      || old.status === event.status && old.hash === digest)) return;
    if (!old&&report.seen.length>=256) report.limited=true;
    report.seen = [...report.seen.filter(x => x.id !== id), { id, status: event.status, hash: digest, kind: event.kind,
      ...(event.outcome ? {outcome:event.outcome} : {}) }].slice(-256);
    if(event.plan)report.plan={...event.plan};
    report.revision++;
    report.updatedAt = Date.now();
    report.events = [...report.events.filter(x => x.id !== id),
      { id, kind: event.kind, status: event.status, text, sequence: report.revision,
        ...(event.outcome ? {outcome:event.outcome} : {}) }].slice(-5);
    store.db.prepare('INSERT INTO run_progress(runId,report) VALUES(?,?) ON CONFLICT(runId) DO UPDATE SET report=excluded.report')
      .run(runId, JSON.stringify(report));
  });
}

/** Counts observed tool outcomes, never numbers claimed in commentary. */
export function progressTotals(store: Store, taskId: string) {
  const reports=store.db.prepare('SELECT p.report FROM task_runs r JOIN run_progress p ON p.runId=r.id WHERE r.taskId=? ORDER BY r.rowid')
    .all(taskId).map(row=>JSON.parse(String(row.report)) as PublicProgress);
  const tools=reports.flatMap(report=>report.seen.filter(event=>event.kind==='tool'));
  return { total:tools.length,
    succeeded:tools.filter(e=>e.status==='completed'&&e.outcome==='success').length,
    failed:tools.filter(e=>e.status==='failed'||e.outcome==='failure').length,
    unknown:tools.filter(e=>e.status!=='failed'&&e.outcome!=='failure'&&(e.status!=='completed'||e.outcome!=='success')).length,
    plan:reports.filter(report=>report.plan).at(-1)?.plan,
    limited:reports.some(report=>report.limited||report.seen.some(e=>!e.kind)) };
}
