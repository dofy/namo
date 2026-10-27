import { BackgroundWork } from './background-work.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Inbox, Store } from './store.js';
import { Memories, MemoryError, type MemoryKind } from './memory.js';

export interface AutoMemoryCandidate {
  key: string;
  kind: 'preference' | 'user_fact' | 'project_knowledge';
  level: 'global' | 'local';
  privacy: 'shared' | 'private' | 'chat';
  text: string;
  project?: string | null;
  evidence: { messageId: string; quote: string }[];
  operation?: 'upsert' | 'forget';
}
export interface AutoMemoryExisting {
  id: string; key?: string; version: number; kind: MemoryKind; level: 'global' | 'local';
  privacy: 'shared' | 'private' | 'chat'; project: string | null; text: string; ownerId?: string;
}
export interface AutoMemoryInput {
  messages: { messageId: string; text: string }[];
  ownerId: string; chatKey: string; chatType: 'p2p' | 'group'; project: string | null;
  existing: AutoMemoryExisting[];
  blocked?: { key: string; level: 'global' | 'local'; project: string | null }[];
}
export interface AutoMemoryOptions {
  allowedUsers: string[];
  authorize?: (row:Inbox)=>boolean;
  allowedProjects?: (row: Inbox) => readonly string[] | undefined;
  redact: (text: string) => string;
  extract: (input: AutoMemoryInput, signal: AbortSignal) => Promise<unknown>;
}
interface Job {
  version: 1; id: string; inboxKeys: string[]; ownerId: string; chatKey: string;
  chatType: 'p2p' | 'group'; project: string | null; sourceRunId: string;
  state: 'pending' | 'running' | 'completed' | 'failed'; attempts: number;
  createdAt: number; dueAt: number; leaseUntil: number; lease: string | null;
  accepted?: number; rejected?: number; error?: 'extraction_failed';
}

export const AUTO_MEMORY_JOB_PREFIX = 'auto-memory:job:';
const LEASE_MS = 120_000, TIMEOUT_MS = 60_000, MAX_ATTEMPTS = 3;
const MAX_MESSAGES = 24, MAX_INPUT_CHARS = 16_000, MAX_CANDIDATES = 8, MAX_OUTPUT_CHARS = 12_000;
const DEBOUNCE_MS = 1500, MERGE_WINDOW_MS = 15_000;
const sensitive = /薪资|工资|收入|奖金|健康|疾病|诊断|病史|身份证|身份号|护照|住址|家庭地址|人事|私人|私密|银行|salary|compensation|medical|diagnos|health|passport|home address|personnel|private|confidential/iu;
const contact = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?\d[\d ()-]{7,}\d)/iu;
const credential = /\b(?:password|passwd|token|api[_-]?key|secret|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"']{3,}|(?:密码|口令|密钥|令牌)\s*(?:[:：=]|是|为)\s*\S{3,}/iu;
const temporary = /这次|本轮|这回|临时|仅.{0,8}(?:会话|对话)|只.{0,5}这(?:个|次)|\b(?:this time|this turn|for this session|temporarily|just for now)\b/iu;
const uncertain = /可能|大概|也许|猜测|\b(?:maybe|probably|guess|uncertain)\b/iu;
const forget = /忘记|忘掉|不要.{0,5}记|别.{0,5}记|删除.{0,8}记忆|\b(?:forget|erase|delete.{0,12}memory)\b/iu;
const forbidden = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const bounded = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.trim().length > 0 && [...value].length <= max && !forbidden.test(value);

/** Persist only source references. Original messages remain in the inbox ledger. */
export class AutoMemories {
  private busy = false;
  constructor(private readonly store: Store, private readonly options: AutoMemoryOptions) {}

  enqueue(inboxKeys: string[], project: string | null, sourceRunId: string): void {
    if (!bounded(sourceRunId, 200) || !Array.isArray(inboxKeys) || inboxKeys.length > 100) return;
    const rows = [...new Set(inboxKeys)].flatMap(key => {
      if (typeof key !== 'string') return [];
      const row = this.store.get(key); return row && this.eligible(row) ? [row] : [];
    }).sort((a, b) => a.seq - b.seq);
    const first = rows[0]; if (!first) return;
    const selected = rows.filter(row => row.senderId === first.senderId && row.chatKey === first.chatKey
      && row.envelope!.chatType === first.envelope!.chatType).slice(-MAX_MESSAGES);
    const id = createHash('sha256').update(sourceRunId).digest('hex'), now = Date.now();
    this.store.transaction(() => {
      const sourceKey = 'auto-memory:source:' + id;
      if (this.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(sourceKey)
        || this.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(AUTO_MEMORY_JOB_PREFIX + id)) return;
      const merged = this.jobs().find(job => job.state === 'pending' && job.attempts === 0 && now - job.createdAt <= MERGE_WINDOW_MS
        && job.ownerId === first.senderId && job.chatKey === first.chatKey && job.chatType === first.envelope!.chatType
        && job.project === project && new Set([...job.inboxKeys, ...selected.map(row => row.key)]).size <= MAX_MESSAGES);
      if (merged) {
        merged.inboxKeys = [...new Set([...merged.inboxKeys, ...selected.map(row => row.key)])]
          .sort((a, b) => this.store.get(a)!.seq - this.store.get(b)!.seq);
        merged.dueAt = now + DEBOUNCE_MS; this.write(merged);
        this.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(sourceKey, JSON.stringify({ jobId: merged.id }));
      } else {
        const job: Job = { version: 1, id, sourceRunId, inboxKeys: selected.map(row => row.key), ownerId: first.senderId,
          chatKey: first.chatKey, chatType: first.envelope!.chatType!, project,
          state: 'pending', attempts: 0, createdAt: now, dueAt: now + DEBOUNCE_MS, leaseUntil: 0, lease: null };
        this.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(AUTO_MEMORY_JOB_PREFIX + id, JSON.stringify(job));
        this.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(sourceKey, JSON.stringify({ jobId: id }));
      }
    });
  }

  pending(): boolean {
    const now = Date.now();
    // Decode only the indexed due set: a malformed legacy row must not create a busy pump loop.
    return this.jobs(now).some(job => this.runnable(job, now));
  }

  /** One leased, bounded extraction. Retrying this operation never replays a user task. */
  async tick(signal?: AbortSignal): Promise<void> {
    if (this.busy || signal?.aborted) return;
    this.busy = true;
    let job: Job | undefined;
    try {
      job = this.store.transaction(() => {
        const now = Date.now(), next = this.jobs(now).filter(value => this.runnable(value, now))
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
        if (!next) return;
        if (next.attempts >= MAX_ATTEMPTS) {
          next.state = 'failed'; next.lease = null; next.leaseUntil = 0; next.error = 'extraction_failed'; this.write(next); return;
        }
        next.state = 'running'; next.attempts++; next.lease = randomUUID(); next.leaseUntil = now + LEASE_MS;
        this.write(next); return next;
      });
      if (!job) return;
      const input = this.input(job);
      if (!input.messages.length) { this.complete(job, 0, 0); return; }
      const output = await this.extract(input, signal);
      const candidates = this.candidates(output, input);
      this.store.transaction(() => {
        if (!this.owns(job!)) return;
        if (this.input(job!).messages.length!==input.messages.length) { this.complete(job!,0,candidates.accepted.length+candidates.rejected);return; }
        const memory = new Memories(this.store, this.options.redact);
        let accepted = 0;
        for (const candidate of candidates.accepted) {
          const evidence = candidate.evidence;
          const observedAt = Math.max(...evidence.map(ref => this.store.get(job!.inboxKeys.find(key => this.store.get(key)?.messageId === ref.messageId)!)?.createdAt ?? job!.createdAt));
          try {
            const saved = memory.upsertAutomatic({ ...candidate, sourceMessageIds: evidence.map(item => item.messageId),
              evidence: evidence.map(item => item.quote), observedAt }, {
              kind: 'local-owner', authenticated: true, ownerId: job!.ownerId,
              chatKey: job!.chatKey, chatType: job!.chatType, project: job!.project,
              source: { kind: 'automatic', ref: job!.id },
            });
            if (saved) accepted++;
          } catch (error) {
            if (!(error instanceof MemoryError) || !['invalid', 'forbidden', 'conflict', 'capacity'].includes(error.code)) throw error;
          }
        }
        this.complete(job!, accepted, candidates.rejected + candidates.accepted.length - accepted);
      });
    } catch {
      if (job) this.store.transaction(() => {
        if (!this.owns(job!)) return;
        const aborted = signal?.aborted;
        job!.state = aborted || job!.attempts < MAX_ATTEMPTS ? 'pending' : 'failed';
        if (aborted) job!.attempts--;
        job!.dueAt = Date.now() + (aborted ? 0 : Math.min(300_000, 5000 * 2 ** (job!.attempts - 1)));
        job!.lease = null; job!.leaseUntil = 0; job!.error = 'extraction_failed'; this.write(job!);
      });
    } finally { this.busy = false; }
  }

  private eligible(row: Inbox): boolean {
    const envelope = row.envelope;
    return (this.options.authorize?this.options.authorize(row):this.options.allowedUsers.includes(row.senderId)) && !!envelope && envelope.type === 'text'
      && envelope.kind === 'instruction' && (envelope.chatType === 'p2p' || envelope.chatType === 'group')
      && !envelope.parentId && envelope.materials.length === 0
      && bounded(row.text, 40_000) && !row.text.trimStart().startsWith('/');
  }

  private input(job: Job): AutoMemoryInput {
    const messages: AutoMemoryInput['messages'] = []; let chars = 0;
    for (const key of job.inboxKeys) {
      const row = this.store.get(key);
      if (!row || !this.eligible(row) || row.senderId !== job.ownerId || row.chatKey !== job.chatKey || row.envelope?.chatType !== job.chatType) continue;
      const text = this.options.redact(row.text);
      // A source containing credentials is not sent to extraction, even redacted.
      if (text !== row.text || credential.test(text) || chars + text.length > MAX_INPUT_CHARS) continue;
      chars += text.length; messages.push({ messageId: row.messageId, text });
    }
    const memory = new Memories(this.store, this.options.redact);
    const existing = memory.search({ kind: 'verified-user', authenticated: true, ownerId: job.ownerId,
      chatKey: job.chatKey, chatType: job.chatType, project: job.project,
      allowedProjects: this.store.get(job.inboxKeys[0]) ? this.options.allowedProjects?.(this.store.get(job.inboxKeys[0])!) : [] }, { limit: 20 })
      .filter(record => record.scope.ownerId === job.ownerId).map(record => {
      const extended = record as typeof record & { automatic?: { key: string }; visibility?: { privacy: AutoMemoryCandidate['privacy'] } };
      return { id: record.id, key: extended.automatic?.key, version: record.version, kind: record.kind, ownerId: record.scope.ownerId,
        level: (record.scope.kind === 'local' ? 'local' : 'global') as AutoMemoryCandidate['level'],
        privacy: extended.visibility?.privacy ?? 'private', project: record.scope.project, text: record.text };
    });
    const blocked = memory.manage({ kind: 'local-owner', authenticated: true, ownerId: job.ownerId })
      .filter(record => record.scope.ownerId === job.ownerId && ['deleted', 'disabled'].includes(record.status) && record.automatic)
      .slice(0, 100).map(record => ({ key: record.automatic!.key,
        level: (record.scope.kind === 'local' ? 'local' : 'global') as 'global' | 'local', project: record.scope.project }));
    return { ownerId: job.ownerId, chatKey: job.chatKey, chatType: job.chatType, project: job.project, messages, existing, blocked };
  }

  private candidates(output: unknown, input: AutoMemoryInput): { accepted: AutoMemoryCandidate[]; rejected: number } {
    if (typeof output === 'string') {
      if (output.length > MAX_OUTPUT_CHARS * 3) throw new Error('memory_output_limit');
      output = JSON.parse(output);
    }
    const raw = Array.isArray(output) ? output : output && typeof output === 'object'
      && Object.keys(output).length === 1 ? (output as { memories?: unknown }).memories : undefined;
    if (!Array.isArray(raw) || raw.length > MAX_CANDIDATES || JSON.stringify(raw).length > MAX_OUTPUT_CHARS * 3) throw new Error('memory_output_invalid');
    const accepted: AutoMemoryCandidate[] = []; let chars = 0, rejected = 0;
    for (const value of raw) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { rejected++; continue; }
      const c = value as Record<string, unknown>;
      if (Object.keys(c).some(key => !['key', 'kind', 'level', 'privacy', 'text', 'project', 'evidence', 'operation'].includes(key))
        || !bounded(c.key, 160) || !bounded(c.text, 3000) || !['preference', 'user_fact', 'project_knowledge'].includes(String(c.kind))
        || !['global', 'local'].includes(String(c.level)) || !['shared', 'private', 'chat'].includes(String(c.privacy))
        || (c.operation !== undefined && !['upsert', 'forget'].includes(String(c.operation)))
        || (c.project !== undefined && c.project !== null && c.project !== input.project)
        || (c.level === 'local' && !input.project) || !Array.isArray(c.evidence) || !c.evidence.length || c.evidence.length > 8) {
        rejected++; continue;
      }
      const evidence = c.evidence as Record<string, unknown>[];
      if (evidence.some(ref => !ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).length !== 2
        || !bounded(ref.messageId, 256) || !bounded(ref.quote, 1000)
        || !input.messages.some(message => message.messageId === ref.messageId && message.text.includes(ref.quote as string)))) {
        rejected++; continue;
      }
      const quotes = evidence.map(item => item.quote as string).join('\n'), operation = c.operation ?? 'upsert';
      if (this.options.redact(c.text) !== c.text || this.options.redact(c.key) !== c.key || credential.test(c.text) || credential.test(c.key)
        || (operation === 'upsert' && (temporary.test(quotes) || uncertain.test(quotes)))
        || (operation === 'forget' && !forget.test(quotes)) || chars + c.text.length > MAX_OUTPUT_CHARS) { rejected++; continue; }
      chars += c.text.length;
      accepted.push({ key: c.key, kind: c.kind as AutoMemoryCandidate['kind'], level: c.level as AutoMemoryCandidate['level'],
        privacy: sensitive.test(c.text + '\n' + quotes) || contact.test(c.text + '\n' + quotes) ? 'private' : c.privacy as AutoMemoryCandidate['privacy'],
        text: c.text, project: c.level === 'local' ? input.project : c.project as string | null | undefined,
        operation: operation as AutoMemoryCandidate['operation'], evidence: evidence as AutoMemoryCandidate['evidence'] });
    }
    return { accepted, rejected };
  }

  private async extract(input: AutoMemoryInput, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    let rejectAbort: (reason: Error) => void = () => {};
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const abort = () => { controller.abort(); rejectAbort(new Error('memory_extraction_aborted')); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, TIMEOUT_MS);
    const work = Promise.resolve().then(() => this.options.extract(input, controller.signal));
    try { if (signal?.aborted) abort(); return await Promise.race([work, aborted]); }
    finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      // Abort requests cancellation; it does not prove the adapter released its
      // Codex process. Keep the lease and scheduling slot until cleanup settles.
      // Extractor adapters must honor the AbortSignal with bounded cleanup.
      await work.catch(() => undefined);
    }
  }

  private jobs(now?: number): Job[] {
    return new BackgroundWork(this.store).records('memory', now).flatMap(row => {
      try {
        const job = JSON.parse(String(row.value)) as Job;
        return job.version === 1 && /^[a-f0-9]{64}$/.test(job.id) && Array.isArray(job.inboxKeys)
          && ['pending', 'running', 'completed', 'failed'].includes(job.state) && Number.isSafeInteger(job.attempts)
          && Number.isFinite(job.dueAt) && Number.isFinite(job.leaseUntil) ? [job] : [];
      } catch { return []; }
    });
  }
  private runnable(job: Job, now: number): boolean {
    return (job.attempts < MAX_ATTEMPTS && job.state === 'pending' && job.dueAt <= now)
      || (job.state === 'running' && job.leaseUntil <= now);
  }
  private owns(job: Job): boolean {
    const value = this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(AUTO_MEMORY_JOB_PREFIX + job.id)?.value;
    if (typeof value !== 'string') return false;
    const current = JSON.parse(value) as Job;
    return current.state === 'running' && current.lease === job.lease;
  }
  private write(job: Job): void {
    this.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(job), AUTO_MEMORY_JOB_PREFIX + job.id);
  }
  private complete(job: Job, accepted: number, rejected: number): void {
    if (!this.owns(job)) return;
    job.state = 'completed'; job.accepted = accepted; job.rejected = rejected; job.lease = null; job.leaseUntil = 0;
    delete job.error; this.write(job);
  }
}
