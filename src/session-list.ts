import type { Incoming, Store } from './store.js';
import { Tasks, type Task } from './tasks.js';
import { taskStateLabel } from './presentation.js';

interface SessionRow {
  id: string; project: string | null; taskCount: number; lastActiveAt: number;
  firstTask: string | null; latestTask: string | null;
}

/** A bounded excerpt of user input, not a generated or inferred conversation title. */
function excerpt(value: string, limit: number): string {
  const clean = value.replace(/^\/run\s+/i, '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  return chars.slice(0, limit).join('') + (chars.length > limit ? '…' : '');
}
const literal = (text: string) => text.replace(/[\\`*_{}\[\]()#~!>|+-]/g, '\\$&');

/** Same owner/chat boundary as /session selection; check content access before rendering titles. */
export function sessionList(store: Store, message: Incoming, options: {
  accessible: (task: Task) => boolean; redact: (text: string) => string; timeZone?: string;
}): string {
  const tasks = new Tasks(store), current = tasks.binding(message)?.id;
  const rows = store.db.prepare(`WITH scoped_tasks AS (
    SELECT t.*,i.seq,i.createdAt FROM tasks t JOIN inbox i ON i.key=t.inboxKey
    WHERE t.ownerId=? AND t.chatKey=?
  ), message_activity AS (
    SELECT m.taskId,MAX(i.createdAt) AS updatedAt FROM scoped_tasks t
    JOIN task_messages m ON m.taskId=t.id JOIN inbox i ON i.key=m.inboxKey GROUP BY m.taskId
  ), activity AS (
    SELECT t.workstreamId,COUNT(*) AS taskCount,MIN(t.seq) AS firstSeq,MAX(t.seq) AS latestSeq,
      MAX(MAX(t.createdAt,COALESCE(t.startedAt,0),COALESCE(t.finishedAt,0),COALESCE(m.updatedAt,0))) AS lastActiveAt
    FROM scoped_tasks t LEFT JOIN message_activity m ON m.taskId=t.id GROUP BY t.workstreamId
  ) SELECT w.id,w.project,COALESCE(a.taskCount,0) AS taskCount,COALESCE(a.lastActiveAt,w.createdAt) AS lastActiveAt,
    f.id AS firstTask,l.id AS latestTask
    FROM workstreams w LEFT JOIN activity a ON a.workstreamId=w.id
    LEFT JOIN scoped_tasks f ON f.seq=a.firstSeq LEFT JOIN scoped_tasks l ON l.seq=a.latestSeq
    WHERE w.ownerId=? AND w.chatKey=?
    ORDER BY (w.id=?) DESC,lastActiveAt DESC,w.createdAt DESC,w.id ASC`)
    .all(message.senderId, message.chatKey, message.senderId, message.chatKey, current ?? '') as unknown as SessionRow[];
  const zone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const entries: string[] = [];
  for (const row of rows) {
    const first = row.firstTask ? tasks.get(row.firstTask) : undefined, latest = row.latestTask ? tasks.get(row.latestTask) : undefined;
    if (first && !options.accessible(first) || latest && latest.id !== first?.id && !options.accessible(latest)) continue;
    // Redact before clipping, so a long credential cannot be exposed as an unmatched prefix.
    const title = excerpt(options.redact(first ? store.get(first.inboxKey)?.text ?? '' : ''), 64) || (first ? '无文字请求（可能包含附件）' : '尚无任务的会话');
    const recent = excerpt(options.redact(latest ? store.get(latest.inboxKey)?.text ?? '' : ''), 88);
    entries.push([
      `**${entries.length + 1}. ${literal(title)}${row.id === current ? ' · 当前会话' : ''}**`,
      `${literal(excerpt(options.redact(row.project ?? '隔离目录'), 40))} · ${row.taskCount} 项任务${latest ? ` · 最近任务${taskStateLabel(latest.state)}` : ''}`,
      `最近活动：${date.format(row.lastActiveAt)}`,
      ...(latest && latest.id !== first?.id && recent && recent !== title ? [`最近：${literal(recent)}`] : []),
      `继续此会话：\`/session ${row.id}\``,
    ].join('\n'));
    if (entries.length === 10) break;
  }
  if (!entries.length) return '**会话列表**\n\n尚无可用会话。直接发送任务即可创建；也可以用 `/new` 开始新会话。';
  return ['**会话列表**', `最多显示 10 条；当前会话置顶，其余按最近活动排序。时间：${zone}。\n标题取自首条请求。`,
    ...entries,
    '发送对应的 `/session W-编号` 后，再发送新要求即可续接上下文；不会重跑旧任务。\n正在等待补充的任务，请用 `/tasks` 找到后查看 `/task N-编号` 的恢复指引。\n新开会话：`/new`',
  ].join('\n\n');
}
