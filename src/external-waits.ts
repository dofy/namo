import { createHash, randomBytes } from 'node:crypto';
import type { Store } from './store.js';

export type ExternalWaitState = 'open' | 'ready' | 'consumed' | 'timed_out' | 'cancelled' | 'stale_head';
export type CheckResult = 'pending' | 'passing' | 'failing' | 'unknown';

export type RequiredCheck =
  | Readonly<{ kind: 'check_run'; context: string; appId: number }>
  | Readonly<{ kind: 'commit_status'; context: string }>;

export interface GitHubTarget {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
}

export interface ExternalWaitContext {
  taskId: string;
  runId: string;
  threadId: string;
  turnId: string;
  callId: string;
  ownerId: string;
  chatId: string;
}

export interface ExternalWaitRequest {
  target: GitHubTarget;
  requiredChecks: readonly RequiredCheck[];
  timeoutMs: number;
}

export type CheckObservation = RequiredCheck & Readonly<{ result: CheckResult; detail: string }>;

export interface GitHubObservation {
  source: 'github_rest';
  target: GitHubTarget;
  pullState: 'open' | 'closed' | 'unknown';
  checks: readonly CheckObservation[];
  observedAt: number;
  /** Credential/scope fingerprint only, never the credential itself. */
  authorizationScope?: string;
}

export interface ExternalWait {
  version: 1;
  id: string;
  taskId: string;
  runId: string;
  threadId: string;
  turnId: string;
  callId: string;
  ownerId: string;
  chatId: string;
  target: GitHubTarget;
  requiredChecks: RequiredCheck[];
  state: ExternalWaitState;
  revision: number;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  /** Durable scheduler cursor. This is not an observation or wake-up revision. */
  lastPolledAt?: number;
  observation?: GitHubObservation;
  lastObservationHash?: string;
  lastError?: string;
  consumedAt?: number;
  cancelledAt?: number;
}

export interface ExternalWaitResume {
  type: 'external_wait_result';
  source: 'github_rest';
  authorization: false;
  waitId: string;
  taskId: string;
  priorRunId: string;
  priorThreadId: string;
  priorTurnId: string;
  target: GitHubTarget;
  requiredChecks: RequiredCheck[];
  observation: GitHubObservation;
  note: string;
}

export interface GitHubObservationAdapter {
  authorize?(target: Readonly<GitHubTarget>, context: ExternalWaitBinding): string|undefined;
  validateResume?(observation: GitHubObservation, checks: readonly RequiredCheck[], context: ExternalWaitBinding, deadlineMs: number): Promise<void>;
  observe(target: Readonly<GitHubTarget>, checks: readonly RequiredCheck[], deadlineMs: number, context?:ExternalWaitBinding): Promise<GitHubObservation>;
}

export interface ExternalWaitBinding { taskId: string; ownerId: string; chatId: string }

export class ExternalWaitError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ExternalWaitError'; }
}

const PREFIX = 'external-wait:';
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[a-f0-9]{40}$/;
const IDENTITY = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]{1,512}$/u;
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_CHECKS = 20;
const POLL_TIMEOUT_MS = 15_000;

function validIdentity(value: string): boolean { return typeof value === 'string' && IDENTITY.test(value); }

function checkKey(check: RequiredCheck): string {
  return check.kind === 'check_run' ? `check_run:${check.context}:${check.appId}` : `commit_status:${check.context}`;
}

function validateTarget(target: GitHubTarget): void {
  if (!target || !NAME.test(target.owner) || !NAME.test(target.repo) || !Number.isSafeInteger(target.pullNumber)
    || target.owner === '.' || target.owner === '..' || target.repo === '.' || target.repo === '..'
    || target.pullNumber < 1 || target.pullNumber > 2_147_483_647 || !SHA.test(target.headSha))
    throw new ExternalWaitError('external_wait_invalid_target');
}

function validateChecks(checks: readonly RequiredCheck[]): RequiredCheck[] {
  if (!Array.isArray(checks) || checks.length < 1 || checks.length > MAX_CHECKS) throw new ExternalWaitError('external_wait_invalid_checks');
  const result: RequiredCheck[] = [], keys = new Set<string>();
  for (const raw of checks) {
    if (!raw || typeof raw !== 'object' || !validIdentity(raw.context) || [...raw.context].length > 200)
      throw new ExternalWaitError('external_wait_invalid_checks');
    let check: RequiredCheck;
    if (raw.kind === 'check_run' && Number.isSafeInteger(raw.appId) && raw.appId > 0)
      check = { kind: 'check_run', context: raw.context, appId: raw.appId };
    else if (raw.kind === 'commit_status' && !('appId' in raw)) check = { kind: 'commit_status', context: raw.context };
    else throw new ExternalWaitError('external_wait_invalid_checks');
    const key = checkKey(check);
    if (keys.has(key)) throw new ExternalWaitError('external_wait_duplicate_check');
    keys.add(key); result.push(check);
  }
  return result;
}

function sameTarget(a: GitHubTarget, b: GitHubTarget): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
    && a.pullNumber === b.pullNumber && a.headSha === b.headSha;
}

function observationHash(value: GitHubObservation): string {
  const stable = { source: value.source, target: value.target, pullState: value.pullState, checks: value.checks };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function validateObservation(value: GitHubObservation): void {
  if (!value || value.source !== 'github_rest' || !Number.isSafeInteger(value.observedAt) || value.observedAt < 0
    || value.authorizationScope!==undefined && !/^[a-f0-9]{64}$/.test(value.authorizationScope)
    || !['open','closed','unknown'].includes(value.pullState) || !Array.isArray(value.checks))
    throw new ExternalWaitError('external_wait_invalid_observation');
  validateTarget(value.target);
  const keys = new Set<string>();
  for (const check of value.checks) {
    validateChecks([check]);
    if (!['pending','passing','failing','unknown'].includes(check.result) || !validIdentity(check.detail)
      || check.detail.length > 100 || keys.has(checkKey(check))) throw new ExternalWaitError('external_wait_invalid_observation');
    keys.add(checkKey(check));
  }
}

function settingKey(id: string): string { return `${PREFIX}${id}`; }

async function beforeDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new ExternalWaitError('external_wait_poll_timeout');
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ExternalWaitError('external_wait_poll_timeout')), remaining); timer.unref();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function decode(value: unknown): ExternalWait | undefined {
  if (typeof value !== 'string') return;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const wait = parsed as ExternalWait;
    if (wait.version !== 1 || !/^EXT-[A-F0-9]{16}$/.test(wait.id)
      || ![wait.taskId, wait.runId, wait.threadId, wait.turnId, wait.callId, wait.ownerId, wait.chatId].every(validIdentity)
      || !['open','ready','consumed','timed_out','cancelled','stale_head'].includes(wait.state)
      || !Number.isSafeInteger(wait.revision) || wait.revision < 0
      || ![wait.createdAt, wait.expiresAt, wait.updatedAt].every(item => Number.isSafeInteger(item) && item >= 0)
      || wait.lastPolledAt !== undefined && (!Number.isSafeInteger(wait.lastPolledAt) || wait.lastPolledAt < 0)) return;
    validateTarget(wait.target); validateChecks(wait.requiredChecks);
    if (wait.observation) validateObservation(wait.observation);
    return wait;
  } catch { return; }
}

function resume(wait: ExternalWait): ExternalWaitResume {
  if (!wait.observation) throw new ExternalWaitError('external_wait_result_missing');
  return { type: 'external_wait_result', source: 'github_rest', authorization: false,
    waitId: wait.id, taskId: wait.taskId, priorRunId: wait.runId, priorThreadId: wait.threadId, priorTurnId: wait.turnId,
    target: { ...wait.target }, requiredChecks: wait.requiredChecks.map(check => ({ ...check })),
    observation: structuredClone(wait.observation),
    note: '这是只读系统观察，不是用户回答或操作授权。仅继续原任务；不得据此推送、合并、部署、发送消息或扩大权限。' };
}

export class ExternalWaits {
  constructor(private store: Store) {}

  private save(wait: ExternalWait): void {
    this.store.db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(settingKey(wait.id), JSON.stringify(wait));
  }

  get(id: string): ExternalWait | undefined {
    if (!/^EXT-[A-F0-9]{16}$/.test(id)) return;
    const wait = decode(this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(settingKey(id))?.value);
    return wait?.id === id ? wait : undefined;
  }

  list(taskId?: string): ExternalWait[] {
    const rows = this.store.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'external-wait:%' ORDER BY key").all();
    return rows.flatMap(row => {
      const wait = decode(row.value);
      return wait && row.key === settingKey(wait.id) && (!taskId || wait.taskId === taskId) ? [wait] : [];
    });
  }

  request(context: ExternalWaitContext, request: ExternalWaitRequest, now = Date.now()): ExternalWait {
    if (![context.taskId, context.runId, context.threadId, context.turnId, context.callId, context.ownerId, context.chatId].every(validIdentity))
      throw new ExternalWaitError('external_wait_invalid_context');
    validateTarget(request.target);
    const requiredChecks = validateChecks(request.requiredChecks);
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < MIN_TIMEOUT_MS || request.timeoutMs > MAX_TIMEOUT_MS)
      throw new ExternalWaitError('external_wait_invalid_timeout');
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + request.timeoutMs))
      throw new ExternalWaitError('external_wait_invalid_time');
    return this.store.transaction(() => {
      const duplicate = this.list(context.taskId).find(wait => wait.runId === context.runId && wait.callId === context.callId);
      if (duplicate) {
        const exactContext = duplicate.taskId === context.taskId && duplicate.runId === context.runId
          && duplicate.threadId === context.threadId && duplicate.turnId === context.turnId && duplicate.callId === context.callId
          && duplicate.ownerId === context.ownerId && duplicate.chatId === context.chatId;
        if (!exactContext || !sameTarget(duplicate.target, request.target)
          || JSON.stringify(duplicate.requiredChecks) !== JSON.stringify(requiredChecks)
          || duplicate.expiresAt - duplicate.createdAt !== request.timeoutMs) throw new ExternalWaitError('external_wait_duplicate_call');
        return structuredClone(duplicate);
      }
      const task = this.store.db.prepare(`SELECT t.ownerId,t.state,i.chatId,r.state AS runState,r.threadId,r.turnId
        FROM tasks t JOIN inbox i ON i.key=t.inboxKey JOIN task_runs r ON r.taskId=t.id
        WHERE t.id=? AND r.id=?`).get(context.taskId, context.runId);
      if (!task || task.ownerId !== context.ownerId || task.chatId !== context.chatId || task.state !== 'running'
        || task.runState !== 'running' || task.threadId !== context.threadId || task.turnId !== context.turnId)
        throw new ExternalWaitError('external_wait_identity_mismatch');
      if (this.list(context.taskId).some(wait => wait.state === 'open' || wait.state === 'ready'))
        throw new ExternalWaitError('external_wait_already_open');
      const wait: ExternalWait = { version: 1, id: `EXT-${randomBytes(8).toString('hex').toUpperCase()}`,
        ...context, target: { ...request.target }, requiredChecks, state: 'open', revision: 0,
        createdAt: now, expiresAt: now + request.timeoutMs, updatedAt: now };
      this.save(wait); return structuredClone(wait);
    });
  }

  cancel(id: string, binding: ExternalWaitBinding, now = Date.now()): boolean {
    return this.store.transaction(() => {
      const wait = this.get(id);
      if (!wait || wait.taskId !== binding.taskId || wait.ownerId !== binding.ownerId || wait.chatId !== binding.chatId) return false;
      if (wait.state !== 'open' && wait.state !== 'ready') return false;
      wait.state = 'cancelled'; wait.cancelledAt = now; wait.updatedAt = now; wait.revision++;
      this.save(wait); return true;
    });
  }

  expire(now = Date.now()): string[] {
    return this.store.transaction(() => {
      const expired: string[] = [];
      for (const wait of this.list()) {
        if (wait.state !== 'open' || wait.expiresAt > now) continue;
        wait.state = 'timed_out'; wait.updatedAt = now; wait.revision++; this.save(wait); expired.push(wait.id);
      }
      return expired;
    });
  }

  ready(): ExternalWait[] { return this.list().filter(wait => wait.state === 'ready'); }

  /** Queue the resume durably inside callback; callback and consumption commit atomically. */
  consume<T>(id: string, binding: ExternalWaitBinding, enqueue: (result: ExternalWaitResume) => T,
    now = Date.now()): T | undefined {
    return this.store.transaction(() => {
      const wait = this.get(id);
      if (!wait || wait.taskId !== binding.taskId || wait.ownerId !== binding.ownerId || wait.chatId !== binding.chatId) return;
      if (wait.state !== 'ready') return;
      if (wait.expiresAt <= now) {
        wait.state = 'timed_out'; wait.updatedAt = now; wait.revision++; this.save(wait); return;
      }
      const value = enqueue(resume(wait));
      wait.state = 'consumed'; wait.consumedAt = now; wait.updatedAt = now; wait.revision++;
      this.save(wait); return value;
    });
  }

  private apply(id: string, expectedRevision: number, observation: GitHubObservation, now: number): ExternalWait | undefined {
    return this.store.transaction(() => {
      const wait = this.get(id);
      if (!wait || wait.state !== 'open' || wait.revision !== expectedRevision) return wait;
      if (wait.expiresAt <= now) {
        wait.state = 'timed_out'; wait.updatedAt = now; wait.revision++; this.save(wait); return wait;
      }
      validateObservation(observation);
      const targetWithoutSha = wait.target.owner.toLowerCase() === observation.target.owner.toLowerCase()
        && wait.target.repo.toLowerCase() === observation.target.repo.toLowerCase()
        && wait.target.pullNumber === observation.target.pullNumber;
      if (!targetWithoutSha) return wait;
      if (!sameTarget(wait.target, observation.target)) {
        wait.state = 'stale_head'; wait.observation = structuredClone(observation); wait.updatedAt = now; wait.revision++;
        this.save(wait); return wait;
      }
      const observed = new Map(observation.checks.map(check => [checkKey(check), check]));
      const exact = wait.requiredChecks.map(check => observed.get(checkKey(check)));
      const hash = observationHash(observation);
      if (hash === wait.lastObservationHash) return wait;
      wait.observation = structuredClone(observation); wait.lastObservationHash = hash; wait.lastError = undefined;
      if (observation.pullState === 'closed'
        || (observation.pullState === 'open' && exact.every(Boolean)
          && exact.every(check => check!.result === 'passing' || check!.result === 'failing'))) wait.state = 'ready';
      wait.updatedAt = now; wait.revision++; this.save(wait); return wait;
    });
  }

  private failedPoll(id: string, expectedRevision: number, now: number): ExternalWait | undefined {
    return this.store.transaction(() => {
      const wait = this.get(id);
      if (!wait || wait.state !== 'open' || wait.revision !== expectedRevision) return wait;
      if (wait.expiresAt <= now) wait.state = 'timed_out';
      wait.lastError = 'github_read_unknown'; wait.updatedAt = now; wait.revision++; this.save(wait); return wait;
    });
  }

  async poll(id: string, adapter: GitHubObservationAdapter, now = Date.now(), clock?: () => number): Promise<ExternalWait | undefined> {
    const wallStartedAt = Date.now();
    const currentTime = () => clock ? clock() : now + Math.max(0, Date.now() - wallStartedAt);
    const wait = this.get(id);
    if (!wait || wait.state !== 'open') return wait;
    if (wait.expiresAt <= now) { this.expire(now); return this.get(id); }
    try {
      const deadlineMs = Date.now() + Math.min(wait.expiresAt - now, POLL_TIMEOUT_MS);
      const observation = await beforeDeadline(adapter.observe(wait.target, wait.requiredChecks, deadlineMs,wait), deadlineMs);
      return this.apply(id, wait.revision, observation, currentTime());
    } catch { return this.failedPoll(id, wait.revision, currentTime()); }
  }

  async pollOpen(adapter: GitHubObservationAdapter, now = Date.now(), max = 4, clock?: () => number): Promise<ExternalWait[]> {
    if (!Number.isSafeInteger(max) || max < 1 || max > 20) throw new ExternalWaitError('external_wait_invalid_poll_limit');
    if (!Number.isSafeInteger(now) || now < 0) throw new ExternalWaitError('external_wait_invalid_time');
    const wallStartedAt = Date.now();
    const currentTime = () => clock ? clock() : now + Math.max(0, Date.now() - wallStartedAt);
    this.expire(now);
    // Claim the least-recently-polled waits and persist the scheduler cursor
    // before network access. A restart therefore continues the rotation even
    // if the process stopped between selection and observation.
    const selected = this.store.transaction(() => {
      const allOpen = this.list().filter(item => item.state === 'open');
      const open = allOpen.sort((left, right) => {
        const leftPoll = left.lastPolledAt ?? -1, rightPoll = right.lastPolledAt ?? -1;
        return leftPoll - rightPoll || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
      }).slice(0, max);
      const latest = allOpen.reduce((value, wait) => Math.max(value, wait.lastPolledAt ?? -1), -1);
      const pollStamp = latest >= now ? latest + 1 : now;
      if (!Number.isSafeInteger(pollStamp)) throw new ExternalWaitError('external_wait_invalid_time');
      for (const wait of open) { wait.lastPolledAt = pollStamp; this.save(wait); }
      return open.map(wait => structuredClone(wait));
    });
    const results: ExternalWait[] = [];
    for (const wait of selected) {
      const result = await this.poll(wait.id, adapter, currentTime(), currentTime);
      if (result) results.push(result);
    }
    return results;
  }
}

export const EXTERNAL_WAIT_TOOL = Object.freeze({
  type: 'function', name: 'wait_for_external',
  description: 'Durably pause this task until the exact required checks on one pinned GitHub pull-request HEAD finish.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      owner: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,100}$' },
      repo: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,100}$' },
      pull_number: { type: 'integer', minimum: 1 },
      head_sha: { type: 'string', pattern: '^[a-f0-9]{40}$' },
      required_checks: { type: 'array', minItems: 1, maxItems: MAX_CHECKS, items: {
        oneOf: [
          { type: 'object', additionalProperties: false, required: ['kind','context','app_id'], properties: {
            kind: { const: 'check_run' }, context: { type: 'string', minLength: 1, maxLength: 200 }, app_id: { type: 'integer', minimum: 1 } } },
          { type: 'object', additionalProperties: false, required: ['kind','context'], properties: {
            kind: { const: 'commit_status' }, context: { type: 'string', minLength: 1, maxLength: 200 } } },
        ],
      } },
      timeout_minutes: { type: 'integer', minimum: 1, maximum: 10_080 },
    },
    required: ['owner','repo','pull_number','head_sha','required_checks','timeout_minutes'],
  },
});

export const EXTERNAL_WAIT_INSTRUCTIONS = `仅当用户明确要求等待一个具体 GitHub PR 的固定 HEAD 检查结果，且已知精确 required check context（check run 还必须知道 GitHub App ID）时，才可调用 wait_for_external。调用后结束当前轮次。不要猜测检查名称或 SHA，不要把它用于计时提醒、用户问答、推送、合并、部署或任何写操作；等待结果也不构成这些操作的授权。`;

type ToolArgs = { owner?: unknown; repo?: unknown; pull_number?: unknown; head_sha?: unknown; required_checks?: unknown; timeout_minutes?: unknown };

export function parseExternalWaitToolArguments(args: unknown): ExternalWaitRequest {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ExternalWaitError('external_wait_invalid_arguments');
  const value = args as ToolArgs;
  const allowed = new Set(['owner','repo','pull_number','head_sha','required_checks','timeout_minutes']);
  if (Object.keys(value).some(key => !allowed.has(key)) || typeof value.owner !== 'string' || typeof value.repo !== 'string'
    || typeof value.pull_number !== 'number' || typeof value.head_sha !== 'string' || !Array.isArray(value.required_checks)
    || typeof value.timeout_minutes !== 'number') throw new ExternalWaitError('external_wait_invalid_arguments');
  const requiredChecks = value.required_checks.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ExternalWaitError('external_wait_invalid_checks');
    const check = raw as Record<string, unknown>;
    if (check.kind === 'check_run' && Object.keys(check).length === 3 && typeof check.context === 'string'
      && typeof check.app_id === 'number') return { kind: 'check_run' as const, context: check.context, appId: check.app_id };
    if (check.kind === 'commit_status' && Object.keys(check).length === 2 && typeof check.context === 'string')
      return { kind: 'commit_status' as const, context: check.context };
    throw new ExternalWaitError('external_wait_invalid_checks');
  });
  const request: ExternalWaitRequest = { target: { owner: value.owner, repo: value.repo, pullNumber: value.pull_number,
    headSha: value.head_sha }, requiredChecks, timeoutMs: value.timeout_minutes * 60_000 };
  validateTarget(request.target); validateChecks(request.requiredChecks);
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < MIN_TIMEOUT_MS || request.timeoutMs > MAX_TIMEOUT_MS)
    throw new ExternalWaitError('external_wait_invalid_timeout');
  return request;
}

export function externalWaitToolRegistration(waits: ExternalWaits, context: ExternalWaitContext): {
  definition: typeof EXTERNAL_WAIT_TOOL;
  handle(args: unknown, now?: number): { wait_id: string; state: ExternalWaitState; message: string };
} {
  return { definition: EXTERNAL_WAIT_TOOL, handle(args: unknown, now = Date.now()) {
    const wait = waits.request(context, parseExternalWaitToolArguments(args), now);
    return { wait_id: wait.id, state: wait.state, message: '等待已持久化；系统将只读检查固定 PR HEAD，当前模型轮次应结束。' };
  } };
}

export interface GitHubRestAdapterOptions {
  /** Inject from protected configuration. Never persist this value in waits. */
  token?: string;
  fetch?: typeof globalThis.fetch;
  apiVersion?: string;
  maxResponseBytes?: number;
}

export class GitHubReadError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'GitHubReadError'; }
}

type Json = Record<string, any>;

/** Fixed-host, read-only GitHub REST adapter. It never shells out to gh. */
export class GitHubRestAdapter implements GitHubObservationAdapter {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly apiVersion: string;
  private readonly maxResponseBytes: number;
  constructor(private options: GitHubRestAdapterOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.apiVersion = options.apiVersion ?? '2022-11-28';
    this.maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
    if (typeof this.fetcher !== 'function') throw new GitHubReadError('github_fetch_unavailable');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(this.apiVersion) || !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1)
      throw new GitHubReadError('github_adapter_invalid_options');
  }

  private async get(path: string, deadlineMs: number): Promise<Json> {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw new GitHubReadError('github_timeout');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining); timer.unref();
    try {
      const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': this.apiVersion,
        'User-Agent': 'namo-read-only-wait' };
      if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
      const response = await this.fetcher(`https://api.github.com${path}`, { method: 'GET', headers, signal: controller.signal,
        redirect: 'error' });
      if (!response.ok) throw new GitHubReadError(response.status === 403 || response.status === 429 ? 'github_rate_limited' : 'github_read_failed');
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > this.maxResponseBytes) throw new GitHubReadError('github_response_too_large');
      if (!response.body) throw new GitHubReadError('github_invalid_response');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > this.maxResponseBytes) { await reader.cancel(); throw new GitHubReadError('github_response_too_large'); }
        chunks.push(chunk.value);
      }
      const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GitHubReadError('github_invalid_response');
      return value as Json;
    } catch (error) {
      if (error instanceof GitHubReadError) throw error;
      throw new GitHubReadError('github_read_unknown');
    } finally { clearTimeout(timer); }
  }

  async account(deadlineMs: number): Promise<{ login: string; id: number }> {
    const value = await this.get('/user', deadlineMs);
    if (typeof value.login !== 'string' || !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(value.login)
      || !Number.isSafeInteger(value.id) || value.id < 1) throw new GitHubReadError('github_invalid_response');
    return { login: value.login, id: value.id };
  }

  private path(target: GitHubTarget): string {
    validateTarget(target);
    return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  }

  private async pull(target: GitHubTarget, deadlineMs: number): Promise<{ headSha: string; state: 'open' | 'closed' | 'unknown' }> {
    const value = await this.get(`${this.path(target)}/pulls/${target.pullNumber}`, deadlineMs);
    const headSha = value.head?.sha, state = value.state;
    if (typeof headSha !== 'string' || !SHA.test(headSha)) throw new GitHubReadError('github_invalid_response');
    return { headSha, state: state === 'open' || state === 'closed' ? state : 'unknown' };
  }

  private async checkRun(target: GitHubTarget, check: Extract<RequiredCheck, { kind: 'check_run' }>, deadlineMs: number): Promise<CheckObservation> {
    const query = new URLSearchParams({ check_name: check.context, app_id: String(check.appId), filter: 'latest', per_page: '100' });
    const value = await this.get(`${this.path(target)}/commits/${target.headSha}/check-runs?${query}`, deadlineMs);
    const rows = Array.isArray(value.check_runs) ? value.check_runs.filter((row: Json) => row?.name === check.context && row?.app?.id === check.appId) : [];
    if (rows.length !== 1) return { ...check, result: 'unknown', detail: rows.length ? 'ambiguous' : 'missing' };
    const row = rows[0];
    if (row.status === 'queued' || row.status === 'in_progress') return { ...check, result: 'pending', detail: row.status };
    if (row.status !== 'completed') return { ...check, result: 'unknown', detail: 'unknown_status' };
    if (['success','neutral','skipped'].includes(row.conclusion)) return { ...check, result: 'passing', detail: row.conclusion };
    if (['failure','cancelled','timed_out','action_required','stale','startup_failure'].includes(row.conclusion))
      return { ...check, result: 'failing', detail: row.conclusion };
    return { ...check, result: 'unknown', detail: 'unknown_conclusion' };
  }

  private async statuses(target: GitHubTarget, checks: readonly Extract<RequiredCheck, { kind: 'commit_status' }>[],
    deadlineMs: number): Promise<CheckObservation[]> {
    if (!checks.length) return [];
    const value = await this.get(`${this.path(target)}/commits/${target.headSha}/status?per_page=100`, deadlineMs);
    const rows = Array.isArray(value.statuses) ? value.statuses : [];
    return checks.map(check => {
      const matches = rows.filter((row: Json) => row?.context === check.context);
      if (matches.length !== 1) return { ...check, result: 'unknown' as const, detail: matches.length ? 'ambiguous' : 'missing' };
      const state = matches[0].state;
      if (state === 'success') return { ...check, result: 'passing' as const, detail: state };
      if (state === 'pending') return { ...check, result: 'pending' as const, detail: state };
      if (state === 'failure' || state === 'error') return { ...check, result: 'failing' as const, detail: state };
      return { ...check, result: 'unknown' as const, detail: 'unknown_state' };
    });
  }

  async observe(target: Readonly<GitHubTarget>, checks: readonly RequiredCheck[], deadlineMs: number): Promise<GitHubObservation> {
    validateTarget(target); const exactChecks = validateChecks(checks);
    const before = await this.pull(target, deadlineMs);
    if (before.headSha !== target.headSha) return { source: 'github_rest', target: { ...target, headSha: before.headSha },
      pullState: before.state, checks: [], observedAt: Date.now() };
    const checkRuns = exactChecks.filter((check): check is Extract<RequiredCheck, { kind: 'check_run' }> => check.kind === 'check_run');
    const commitStatuses = exactChecks.filter((check): check is Extract<RequiredCheck, { kind: 'commit_status' }> => check.kind === 'commit_status');
    const observedRuns: CheckObservation[] = [];
    for (const check of checkRuns) observedRuns.push(await this.checkRun(target, check, deadlineMs));
    const observedStatuses = await this.statuses(target, commitStatuses, deadlineMs);
    const after = await this.pull(target, deadlineMs);
    if (after.headSha !== target.headSha) return { source: 'github_rest', target: { ...target, headSha: after.headSha },
      pullState: after.state, checks: [], observedAt: Date.now() };
    return { source: 'github_rest', target: { ...target }, pullState: after.state,
      checks: [...observedRuns, ...observedStatuses], observedAt: Date.now() };
  }
}
