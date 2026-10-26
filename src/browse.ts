import { t as tr } from './locale.js';
import type { SQLInputValue } from 'node:sqlite';
import type { Store } from './store.js';
import type { BrowseOptions, Dashboard, PageResult, SessionSummary, TaskList, TaskListItem } from './ui-contract.js';

export class BrowseError extends Error {}
type Kind = 'tasks' | 'sessions';
interface Query {
  q: string; owner: string; project: string; state: string; workstream: string;
  from?: number; to?: number; sort: 'newest' | 'oldest'; page: number; pageSize: number;
  dateField: 'created' | 'started' | 'finished';
}
const taskStates = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted', 'needs_attention', 'problem'];
function dateBoundary(value: string, end = false): number | undefined {
  if (!value) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BrowseError(tr("日期格式无效"));
  const [y, m, d] = value.split('-').map(Number), date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) throw new BrowseError(tr("日期不存在"));
  if (end) date.setDate(date.getDate() + 1);
  return date.getTime();
}
function parse(params: URLSearchParams, kind: Kind): Query {
  const value = (key: string, max = 256) => {
    const v = params.get(key)?.trim() ?? '';
    if (v.length > max || params.getAll(key).length > 1) throw new BrowseError(tr("筛选条件过长或重复"));
    return v;
  };
  const integer = (key: string, fallback: number, max: number) => {
    const raw = value(key); if (!raw) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new BrowseError(tr("分页参数无效"));
    return Number(raw);
  };
  const state = value('state'), sort = value('sort') || 'newest', project = value('project'), workstream = value('workstream');
  if (state && !(kind === 'tasks' ? taskStates : ['running', 'waiting', 'queued', 'idle', 'current']).includes(state)) throw new BrowseError(tr("状态筛选无效"));
  if (!['newest', 'oldest'].includes(sort)) throw new BrowseError(tr("排序方式无效"));
  if (project && project !== 'isolated' && !project.startsWith('named:')) throw new BrowseError(tr("项目筛选无效"));
  if (workstream && !/^W-[A-F0-9]{12}$/.test(workstream)) throw new BrowseError(tr("会话编号无效"));
  const dateField = value('dateField') || 'created';
  if (!(kind === 'tasks' ? ['created', 'started', 'finished'] : ['created']).includes(dateField)) throw new BrowseError(tr("日期类型无效"));
  const from = dateBoundary(value('from')), to = dateBoundary(value('to'), true);
  if (from !== undefined && to !== undefined && from >= to) throw new BrowseError(tr("结束日期不能早于开始日期"));
  const pageSize = integer('pageSize', 25, 100);
  if (![25, 50, 100].includes(pageSize)) throw new BrowseError(tr("每页可显示 25、50 或 100 条"));
  return { q: value('q', 200), owner: value('owner'), project, state, workstream, from, to,
    sort: sort as Query['sort'], dateField: dateField as Query['dateField'], page: integer('page', 1, 1_000_000), pageSize };
}
const taskSelect = `SELECT t.id,t.workstreamId,t.project,t.state,t.inputVersion,t.startedAt,t.finishedAt,t.error,
  t.ownerId,i.createdAt,i.text FROM tasks t JOIN inbox i ON i.key=t.inboxKey`;
// Aggregate once per query, rather than running a full task scan for every session.
const sessionsCte = `WITH message_activity AS (
  SELECT m.taskId,MAX(i.createdAt) AS updatedAt FROM task_messages m JOIN inbox i ON i.key=m.inboxKey GROUP BY m.taskId
), activity AS (
  SELECT t.workstreamId,COUNT(*) AS taskCount,MIN(i.seq) AS firstSeq,MAX(i.seq) AS latestSeq,
    MAX(MAX(i.createdAt,COALESCE(t.startedAt,0),COALESCE(t.finishedAt,0),COALESCE(m.updatedAt,0))) AS lastActiveAt,
    SUM(t.state='running') AS running,SUM(t.state='waiting') AS waiting,SUM(t.state='queued') AS queued
  FROM tasks t JOIN inbox i ON i.key=t.inboxKey LEFT JOIN message_activity m ON m.taskId=t.id GROUP BY t.workstreamId
), session_rows AS (
  SELECT w.id,w.project,w.ownerId,w.createdAt,COALESCE(a.lastActiveAt,w.createdAt) AS lastActiveAt,
    COALESCE(a.taskCount,0) AS taskCount,a.firstSeq,a.latestSeq,
    EXISTS(SELECT 1 FROM bindings b WHERE b.workstreamId=w.id) AS current,
    CASE WHEN a.running>0 THEN 'running' WHEN a.waiting>0 THEN 'waiting' WHEN a.queued>0 THEN 'queued' ELSE 'idle' END AS state
  FROM workstreams w LEFT JOIN activity a ON a.workstreamId=w.id
)`;

/** Read-only projections. Each public operation runs inside Management's read snapshot. */
export class Browse {
  private names = new Map<string, string>();
  constructor(private store: Store, identity: { appId: string; channel: string }, private redact: (s: string) => string) {
    const account = store.db.prepare("SELECT value FROM settings WHERE key='account'").get()?.value;
    if ((!account || account === identity.appId) && store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='user_profiles' AND type='table'").get()) {
      for (const row of store.db.prepare('SELECT userId,name FROM user_profiles WHERE channel=? AND appId=?').all(identity.channel, identity.appId)) {
        this.names.set(String(row.userId), redact(String(row.name)));
      }
    }
  }
  private title(text: unknown, fallback: string): string {
    const clean = this.redact(String(text ?? '')).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
    return Array.from(clean).slice(0, 120).join('') || fallback;
  }
  private task(row: Record<string, any>): TaskListItem {
    const { text, ...rest } = row;
    return { ...rest, title: this.title(text, tr("无文字任务")), ownerName: this.names.get(row.ownerId) ?? '',
      error: row.error ? this.redact(row.error) : null } as TaskListItem;
  }
  private session(row: Record<string, any>): SessionSummary {
    const { text, latestText, firstSeq: _first, latestSeq: _last, ...rest } = row;
    return { ...rest, current: !!row.current, title: this.title(text, tr("尚无任务的会话")),
      latestTitle: this.title(latestText, tr("尚无任务")), ownerName: this.names.get(row.ownerId) ?? '' } as SessionSummary;
  }
  private where(q: Query, kind: Kind): { sql: string; values: SQLInputValue[] } {
    const alias = kind === 'tasks' ? 't' : 's', clauses: string[] = [], values: SQLInputValue[] = [];
    const add = (sql: string, ...args: SQLInputValue[]) => { clauses.push(sql); values.push(...args); };
    if (q.owner) add(`${alias}.ownerId=?`, q.owner);
    if (q.project === 'isolated') add(`${alias}.project IS NULL`);
    else if (q.project) add(`${alias}.project=?`, q.project.slice(6));
    if (q.state === 'problem') add(`${alias}.state IN ('failed','interrupted','needs_attention')`);
    else if (q.state === 'current') add('s.current=1');
    else if (q.state) add(`${alias}.state=?`, q.state);
    if (q.workstream) add(kind === 'tasks' ? 't.workstreamId=?' : 's.id=?', q.workstream);
    const time = kind === 'tasks' ? { created: 'i.createdAt', started: 't.startedAt', finished: 't.finishedAt' }[q.dateField] : 's.createdAt';
    if (q.from !== undefined) add(`${time}>=?`, q.from);
    if (q.to !== undefined) add(`${time}<?`, q.to);
    if (q.q) {
      if (kind === 'tasks') add('(instr(lower(i.text),lower(?))>0 OR instr(lower(t.id),lower(?))>0 OR instr(lower(t.workstreamId),lower(?))>0)', q.q, q.q, q.q);
      else add(`(instr(lower(s.id),lower(?))>0 OR EXISTS(SELECT 1 FROM tasks t JOIN inbox i ON i.key=t.inboxKey WHERE t.workstreamId=s.id AND instr(lower(i.text),lower(?))>0))`, q.q, q.q);
    }
    return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values };
  }
  private page(total: number, q: Query): Omit<PageResult<never>, 'items'> {
    const pages = Math.max(1, Math.ceil(total / q.pageSize));
    return { total, page: Math.min(q.page, pages), pageSize: q.pageSize, pages };
  }
  tasks(params: URLSearchParams): TaskList {
    const q = parse(params, 'tasks'), where = this.where(q, 'tasks');
    const total = Number(this.store.db.prepare(`SELECT COUNT(*) AS n FROM tasks t JOIN inbox i ON i.key=t.inboxKey${where.sql}`).get(...where.values)?.n);
    const page = this.page(total, q), order = q.sort === 'oldest' ? 'ASC' : 'DESC';
    const rows = this.store.db.prepare(`${taskSelect}${where.sql} ORDER BY i.createdAt ${order},i.seq ${order} LIMIT ? OFFSET ?`)
      .all(...where.values, page.pageSize, (page.page - 1) * page.pageSize);
    return { ...page, items: rows.map(row => this.task(row)), session: q.workstream ? this.findSession(q.workstream) : null };
  }
  taskSummary(id: string): TaskListItem | undefined {
    const row = this.store.db.prepare(`${taskSelect} WHERE t.id=?`).get(id);
    return row ? this.task(row) : undefined;
  }
  sessions(params: URLSearchParams): PageResult<SessionSummary> {
    const q = parse(params, 'sessions'), where = this.where(q, 'sessions');
    const total = Number(this.store.db.prepare(`${sessionsCte} SELECT COUNT(*) AS n FROM session_rows s${where.sql}`).get(...where.values)?.n);
    const page = this.page(total, q), order = q.sort === 'oldest' ? 'ASC' : 'DESC';
    const rows = this.store.db.prepare(`${sessionsCte} SELECT s.*,f.text,l.text AS latestText FROM session_rows s
      LEFT JOIN inbox f ON f.seq=s.firstSeq LEFT JOIN inbox l ON l.seq=s.latestSeq${where.sql}
      ORDER BY s.lastActiveAt ${order},s.id ${order} LIMIT ? OFFSET ?`).all(...where.values, page.pageSize, (page.page - 1) * page.pageSize);
    return { ...page, items: rows.map(row => this.session(row)) };
  }
  private findSession(id: string): SessionSummary | null {
    const row = this.store.db.prepare(`${sessionsCte} SELECT s.*,f.text,l.text AS latestText FROM session_rows s
      LEFT JOIN inbox f ON f.seq=s.firstSeq LEFT JOIN inbox l ON l.seq=s.latestSeq WHERE s.id=?`).get(id);
    return row ? this.session(row) : null;
  }
  options(): BrowseOptions {
    return {
      users: this.store.db.prepare('SELECT ownerId FROM tasks UNION SELECT ownerId FROM workstreams ORDER BY ownerId').all()
        .map(row => ({ id: String(row.ownerId), name: this.names.get(String(row.ownerId)) ?? '' })),
      projects: this.store.db.prepare('SELECT project FROM tasks WHERE project IS NOT NULL UNION SELECT project FROM workstreams WHERE project IS NOT NULL ORDER BY project').all().map(row => String(row.project)),
    };
  }
  dashboard(now = Date.now()): Dashboard {
    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    const days = Array.from({ length: 8 }, (_, index) => { const d = new Date(midnight); d.setDate(d.getDate() - 6 + index); return d.getTime(); });
    const [weekStart] = days;
    const row = this.store.db.prepare(`SELECT COUNT(*) AS totalTasks,SUM(state='running') AS running,SUM(state='waiting') AS waiting,SUM(state='queued') AS queued,
      SUM(state='succeeded' AND finishedAt>=? AND finishedAt<=?) AS completedToday,
      SUM(state IN ('failed','interrupted','needs_attention')) AS failed,
      SUM(state='succeeded' AND finishedAt>=? AND finishedAt<=?) AS successes,
      SUM(state IN ('succeeded','failed','interrupted','needs_attention') AND finishedAt>=? AND finishedAt<=?) AS outcomes,
      AVG(CASE WHEN state='succeeded' AND finishedAt>=? AND finishedAt<=? AND startedAt IS NOT NULL AND finishedAt>=startedAt THEN finishedAt-startedAt END) AS duration
      FROM tasks`).get(midnight.getTime(), now, weekStart, now, weekStart, now, weekStart, now)!;
    const count = (sql: string, ...values: SQLInputValue[]) => Number(this.store.db.prepare(sql).get(...values)?.n ?? 0);
    const daily = days.slice(0, 7).map((from, i) => {
      const d = new Date(from);
      return { date: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`, from,
        count: count('SELECT COUNT(*) AS n FROM tasks t JOIN inbox i ON i.key=t.inboxKey WHERE i.createdAt>=? AND i.createdAt<? AND i.createdAt<=?', from, days[i+1], now) };
    });
    return {
      generatedAt: now, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, today: midnight.getTime(), weekStart,
      totalTasks: Number(row.totalTasks), totalSessions: count('SELECT COUNT(*) AS n FROM workstreams'),
      activeUsers: count('SELECT COUNT(DISTINCT t.ownerId) AS n FROM task_messages m JOIN tasks t ON t.id=m.taskId JOIN inbox i ON i.key=m.inboxKey WHERE i.createdAt>=? AND i.createdAt<=?', weekStart, now),
      running: Number(row.running ?? 0), waiting: Number(row.waiting ?? 0), queued: Number(row.queued ?? 0), completedToday: Number(row.completedToday ?? 0),
      successRate: Number(row.outcomes) ? Number(row.successes) / Number(row.outcomes) : null,
      averageDurationMs: row.duration === null ? null : Number(row.duration), failed: Number(row.failed ?? 0),
      deliveryIssues: count("SELECT COUNT(*) AS n FROM outbox WHERE state IN ('unknown','failed')"), daily,
      recent: this.store.db.prepare(`${taskSelect} ORDER BY i.createdAt DESC,i.seq DESC LIMIT 5`).all().map(r => this.task(r)),
    };
  }
}
