import { t as tr, getLocale } from '../i18n';
import { Icon } from '../Icon';
import { useCallback, useState } from 'react';
import { Badge, Button, Heading, Link, Spinner, Table, Text } from '@radix-ui/themes';
import type { ManagementState, PageResult, SessionSummary, TaskList, TaskListItem } from '../../src/ui-contract';
import { api } from '../api';
import { Notice, StatusBadge, statusLabel } from '../components';
import { DateTime, duration, Filters, LocalLink, Owner, Pagination, useRemote, type Navigate } from '../browse-components';

export type DetailTarget = { type: 'task' | 'issue'; id: string };
export function TaskTable({ tasks, onOpen, navigate, compact = false }: { tasks: TaskListItem[]; onOpen: (target: DetailTarget) => void; navigate: Navigate; compact?: boolean }) {
  return <Table.Root variant="surface" className={`task-table browse-table ${compact ? 'compact-table' : ''}`}>
    <Table.Header><Table.Row><Table.ColumnHeaderCell>{tr("任务")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("用户")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("项目")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("状态")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("开始时间")}</Table.ColumnHeaderCell>{!compact && <Table.ColumnHeaderCell>{tr("耗时")}</Table.ColumnHeaderCell>}</Table.Row></Table.Header>
    <Table.Body>{tasks.map(task => <Table.Row key={task.id}>
      <Table.RowHeaderCell className="summary-cell"><Link asChild color="gray" highContrast underline="hover"><button type="button" className="task-title" title={task.title} onClick={() => onOpen({ type: 'task', id: task.id })}>{task.title}</button></Link><span className="secondary-id">{task.id}</span>
        {!compact && <LocalLink className="session-link" href={`/tasks?workstream=${encodeURIComponent(task.workstreamId)}`} navigate={navigate}>{tr("查看所在会话")}</LocalLink>}</Table.RowHeaderCell>
      <Table.Cell><Owner id={task.ownerId} name={task.ownerName} /></Table.Cell><Table.Cell>{task.project || tr("隔离目录")}</Table.Cell>
      <Table.Cell><StatusBadge state={task.state} /></Table.Cell><Table.Cell><DateTime value={task.startedAt} />{task.startedAt == null && <span className="created-hint" title={new Date(task.createdAt).toLocaleString(getLocale())}>{tr("创建于")} {new Date(task.createdAt).toLocaleDateString(getLocale())}</span>}</Table.Cell>
      {!compact && <Table.Cell><span title={tr("从首次开始到结束的时间，包含等待补充")}>{task.startedAt == null ? '—' : duration((task.finishedAt ?? Date.now()) - task.startedAt)}</span>{task.startedAt != null && task.finishedAt == null && <span className="created-hint">{task.state === 'waiting' ? tr("含等待时间") : tr("尚未结束")}</span>}</Table.Cell>}
    </Table.Row>)}</Table.Body>
  </Table.Root>;
}
export function TasksPage({ state, onOpen, navigate, search, kind, enabled }: {
  state: ManagementState; onOpen: (target: DetailTarget) => void; navigate: Navigate; search: string; kind: 'tasks' | 'sessions'; enabled: boolean;
}) {
  const path = kind === 'tasks' ? '/tasks' : '/sessions';
  const load = useCallback((signal: AbortSignal): Promise<TaskList | PageResult<SessionSummary>> => kind === 'tasks' ? api.tasks(search, signal) : api.sessions(search, signal), [kind, search]);
  const { data, error, busy } = useRemote(`${kind}?${search}`, load, state, enabled);
  const options = useRemote('options', api.browseOptions, state, enabled);
  const go = (query: URLSearchParams) => navigate(`${path}${query.size ? `?${query}` : ''}`);
  const taskData = kind === 'tasks' ? data as TaskList | undefined : undefined;
  const session = taskData?.session;
  const reviewing = new URLSearchParams(search).get('review') === 'delivery';
  const [issuePage, setIssuePage] = useState(1);
  const issues = state.database.issues.filter(i => !reviewing || i.type === 'delivery');
  const currentIssuePage = Math.min(issuePage, Math.max(1, Math.ceil(issues.length / 10)));
  return <>
    {!state.recoveryAvailable && <Notice>{tr("当前接收服务使用旧版数据结构。可以浏览；异常处理需在维护窗口升级后启用。")}</Notice>}
    {new URLSearchParams(search).has('workstream') && <div className="session-context">
      <div><Text size="1" color="gray">{tr("会话中的任务")}</Text><Heading as="h2" size="4">{session?.title || new URLSearchParams(search).get('workstream')}</Heading>
        {session && <Text as="p" size="2" color="gray">{session.ownerName || session.ownerId} · {session.project || tr("隔离目录")} · {session.taskCount}  {tr("项任务")}</Text>}</div>
      <LocalLink href="/sessions" navigate={navigate}>{tr("返回会话列表")}</LocalLink>
    </div>}
    <Filters kind={kind} search={search} options={options.data} onSearch={go} />
    {options.error && <Notice error>{tr("筛选选项读取失败：")}{options.error}</Notice>}
    <div className="section-title list-title"><Heading as="h2" size="4">{kind === 'tasks' ? session ? tr("会话任务记录") : tr("任务记录") : tr("会话记录")}</Heading><Text size="2" color="gray">{busy ? tr("正在刷新…") : data ? tr("共 {0} {1}", data.total, kind === 'tasks' ? tr("项任务") : tr("个会话")) : ''}</Text></div>
    {kind === 'sessions' && <Text as="p" size="2" color="gray">{tr("会话保留连续上下文。标题来自首条任务，点击可查看这条工作线的完整任务记录。")}</Text>}
    {error && <Notice error>{error}{tr("。可调整筛选或点击“刷新状态”重试。")}</Notice>}
    {!data && busy && <div className="loading"><Spinner />  {tr("读取记录")}</div>}
    {data && <div aria-busy={busy}>
      {data.items.length > 0 ? kind === 'tasks' ? <TaskTable tasks={(data as TaskList).items} onOpen={onOpen} navigate={navigate} /> :
        <Table.Root variant="surface" className="task-table browse-table session-table"><Table.Header><Table.Row>
          <Table.ColumnHeaderCell>{tr("会话")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("用户")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("项目")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("状态")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("任务数")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("最近活动")}</Table.ColumnHeaderCell>
        </Table.Row></Table.Header><Table.Body>{(data as PageResult<SessionSummary>).items.map(item => <Table.Row key={item.id}>
          <Table.RowHeaderCell className="summary-cell"><LocalLink className="task-title" title={item.title} href={`/tasks?workstream=${item.id}`} navigate={navigate}>{item.title}</LocalLink><span className="secondary-id">{item.id}</span><span className="session-latest" title={item.latestTitle}>{tr("最近：")}{item.latestTitle}</span></Table.RowHeaderCell>
          <Table.Cell><Owner id={item.ownerId} name={item.ownerName} /></Table.Cell><Table.Cell>{item.project || tr("隔离目录")}</Table.Cell>
          <Table.Cell><StatusBadge state={item.state} />{item.current && <span className="current-session"><Badge variant="outline" color="gray">{tr("当前会话")}</Badge></span>}</Table.Cell>
          <Table.Cell>{item.taskCount}</Table.Cell><Table.Cell><DateTime value={item.lastActiveAt} /><span className="created-hint" title={new Date(item.createdAt).toLocaleString(getLocale())}>{tr("创建于")} {new Date(item.createdAt).toLocaleDateString(getLocale())}</span></Table.Cell>
        </Table.Row>)}</Table.Body></Table.Root>
      : <div className="list-empty"><Heading as="h3" size="3">{tr("没有符合条件的")}{kind === 'tasks' ? tr("任务") : tr("会话")}</Heading><Text as="p" size="2" color="gray">{tr("可以清除筛选或扩大日期范围。首次在飞书提交任务后，记录会出现在这里。")}</Text></div>}
      <Pagination page={data} busy={busy} onChange={(page, size) => { const q = new URLSearchParams(search); q.set('page', String(page)); q.set('pageSize', String(size)); go(q); document.querySelector('.list-title')?.scrollIntoView({ block: 'start' }); }} />
    </div>}
    {kind === 'tasks' && issues.length > 0 && <details className="recovery-panel" open={reviewing || undefined}>
      <summary>{tr("全局异常核对（")}{issues.length}  {tr("条，最多展示最近 100 条；独立于上方筛选）")}</summary>
      <div className="issue-list">{issues.slice((currentIssuePage - 1) * 10, currentIssuePage * 10).map(issue => <div className="issue-row" key={issue.subject}>
        <div><Text weight="medium">{issue.type === 'delivery' ? tr("消息投递需核对") : tr("任务执行需核对")}</Text><Text as="p" size="2" color="gray">{issue.subject} · {statusLabel(issue.state)}</Text></div>
        <Button variant="soft" onClick={() => onOpen({ type: 'issue', id: issue.subject })}><Icon name="check" />{tr("核对")}</Button>
      </div>)}</div>
      {issues.length > 10 && <div className="page-buttons"><Button variant="soft" color="gray" disabled={currentIssuePage <= 1} onClick={() => setIssuePage(currentIssuePage - 1)}>{tr("前 10 条")}</Button><Text size="2">{currentIssuePage} / {Math.ceil(issues.length / 10)}</Text><Button variant="soft" color="gray" disabled={currentIssuePage * 10 >= issues.length} onClick={() => setIssuePage(currentIssuePage + 1)}>{tr("后 10 条")}</Button></div>}
    </details>}
  </>;
}
