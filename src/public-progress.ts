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
}
interface Entry extends Omit<PublicProgressEvent, 'threadId' | 'turnId'> { sequence: number; }
export interface PublicProgress {
  revision: number;
  firstAt: number;
  updatedAt: number;
  events: Entry[];
  // Bounded tombstones prevent late starts from replacing completed tools.
  seen: { id: string; status: PublicProgressEvent['status']; hash: string }[];
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
    const id = hash(event.kind + ':' + event.id), digest = hash(text), old = report.seen.find(x => x.id === id);
    if (old && (event.kind === 'tool' && old.status !== 'running' && event.status === 'running'
      || old.status === event.status && old.hash === digest)) return;
    report.seen = [...report.seen.filter(x => x.id !== id), { id, status: event.status, hash: digest }].slice(-256);
    report.revision++;
    report.updatedAt = Date.now();
    report.events = [...report.events.filter(x => x.id !== id),
      { id, kind: event.kind, status: event.status, text, sequence: report.revision }].slice(-5);
    store.db.prepare('INSERT INTO run_progress(runId,report) VALUES(?,?) ON CONFLICT(runId) DO UPDATE SET report=excluded.report')
      .run(runId, JSON.stringify(report));
  });
}
