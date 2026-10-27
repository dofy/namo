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
    <Table.Header><Table.Row><Table.ColumnHeaderCell>{tr("nav.tasks")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("common.user")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("common.project")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("common.status")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("common.startedAt")}</Table.ColumnHeaderCell>{!compact && <Table.ColumnHeaderCell>{tr("tasks.duration")}</Table.ColumnHeaderCell>}</Table.Row></Table.Header>
    <Table.Body>{tasks.map(task => <Table.Row key={task.id}>
      <Table.RowHeaderCell className="summary-cell"><Link asChild color="gray" highContrast underline="hover"><button type="button" className="task-title" title={task.title} onClick={() => onOpen({ type: 'task', id: task.id })}>{task.title}</button></Link><span className="secondary-id">{task.id}</span>
        {!compact && <LocalLink className="session-link" href={`/tasks?workstream=${encodeURIComponent(task.workstreamId)}`} navigate={navigate}>{tr("tasks.viewSession")}</LocalLink>}</Table.RowHeaderCell>
      <Table.Cell><Owner id={task.ownerId} name={task.ownerName} /></Table.Cell><Table.Cell>{task.project || tr("common.isolatedDirectory")}</Table.Cell>
      <Table.Cell><StatusBadge state={task.state} /></Table.Cell><Table.Cell><DateTime value={task.startedAt} />{task.startedAt == null && <span className="created-hint" title={new Date(task.createdAt).toLocaleString(getLocale())}>{tr("tasks.created")} {new Date(task.createdAt).toLocaleDateString(getLocale())}</span>}</Table.Cell>
      {!compact && <Table.Cell><span title={tr("tasks.firstStartCompletionIncludingTimeWaitingInput")}>{task.startedAt == null ? '—' : duration((task.finishedAt ?? Date.now()) - task.startedAt)}</span>{task.startedAt != null && task.finishedAt == null && <span className="created-hint">{task.state === 'waiting' ? tr("tasks.includesWaiting") : tr("common.notFinished")}</span>}</Table.Cell>}
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
    {!state.recoveryAvailable && <Notice>{tr("tasks.receiverUsesOlderDataSchemaBrowsingAvailable")}</Notice>}
    {new URLSearchParams(search).has('workstream') && <div className="session-context">
      <div><Text size="1" color="gray">{tr("tasks.tasksSession")}</Text><Heading as="h2" size="4">{session?.title || new URLSearchParams(search).get('workstream')}</Heading>
        {session && <Text as="p" size="2" color="gray">{session.ownerName || session.ownerId} · {session.project || tr("common.isolatedDirectory")} · {session.taskCount}  {tr("tasks.tasks")}</Text>}</div>
      <LocalLink href="/sessions" navigate={navigate}>{tr("tasks.backSessions")}</LocalLink>
    </div>}
    <Filters kind={kind} search={search} options={options.data} onSearch={go} />
    {options.error && <Notice error>{tr("tasks.couldNotLoadFilterOptions")}{options.error}</Notice>}
    <div className="section-title list-title"><Heading as="h2" size="4">{kind === 'tasks' ? session ? tr("tasks.sessionTasks") : tr("tasks.taskHistory") : tr("tasks.sessionHistory")}</Heading><Text size="2" color="gray">{busy ? tr("tasks.refreshing") : data ? tr("tasks.total", data.total, kind === 'tasks' ? tr("tasks.tasks") : tr("common.sessions")) : ''}</Text></div>
    {kind === 'sessions' && <Text as="p" size="2" color="gray">{tr("tasks.sessionsPreserveContextTitlesComeFirstTask")}</Text>}
    {error && <Notice error>{error}{tr("tasks.adjustFiltersClickRefreshTryAgain")}</Notice>}
    {!data && busy && <div className="loading"><Spinner />  {tr("tasks.loadingRecords")}</div>}
    {data && <div aria-busy={busy}>
      {data.items.length > 0 ? kind === 'tasks' ? <TaskTable tasks={(data as TaskList).items} onOpen={onOpen} navigate={navigate} /> :
        <Table.Root variant="surface" className="task-table browse-table session-table"><Table.Header><Table.Row>
          <Table.ColumnHeaderCell>{tr("nav.sessions")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("common.user")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("common.project")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("common.status")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("tasks.taskCount")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr("tasks.lastActive")}</Table.ColumnHeaderCell>
        </Table.Row></Table.Header><Table.Body>{(data as PageResult<SessionSummary>).items.map(item => <Table.Row key={item.id}>
          <Table.RowHeaderCell className="summary-cell"><LocalLink className="task-title" title={item.title} href={`/tasks?workstream=${item.id}`} navigate={navigate}>{item.title}</LocalLink><span className="secondary-id">{item.id}</span><span className="session-latest" title={item.latestTitle}>{tr("tasks.latest")}{item.latestTitle}</span></Table.RowHeaderCell>
          <Table.Cell><Owner id={item.ownerId} name={item.ownerName} /></Table.Cell><Table.Cell>{item.project || tr("common.isolatedDirectory")}</Table.Cell>
          <Table.Cell><StatusBadge state={item.state} />{item.current && <span className="current-session"><Badge variant="outline" color="gray">{tr("tasks.currentSession")}</Badge></span>}</Table.Cell>
          <Table.Cell>{item.taskCount}</Table.Cell><Table.Cell><DateTime value={item.lastActiveAt} /><span className="created-hint" title={new Date(item.createdAt).toLocaleString(getLocale())}>{tr("tasks.created")} {new Date(item.createdAt).toLocaleDateString(getLocale())}</span></Table.Cell>
        </Table.Row>)}</Table.Body></Table.Root>
      : <div className="list-empty"><Heading as="h3" size="3">{tr("tasks.noMatching")}{kind === 'tasks' ? tr("nav.tasks") : tr("nav.sessions")}</Heading><Text as="p" size="2" color="gray">{tr("tasks.clearFiltersExpandDateRangeRecordsAppear")}</Text></div>}
      <Pagination page={data} busy={busy} onChange={(page, size) => { const q = new URLSearchParams(search); q.set('page', String(page)); q.set('pageSize', String(size)); go(q); document.querySelector('.list-title')?.scrollIntoView({ block: 'start' }); }} />
    </div>}
    {kind === 'tasks' && issues.length > 0 && <details className="recovery-panel" open={reviewing || undefined}>
      <summary>{tr("tasks.globalIssueReview")}{issues.length}  {tr("tasks.itemsUpRecentRecordsIndependentFiltersAbove")}</summary>
      <div className="issue-list">{issues.slice((currentIssuePage - 1) * 10, currentIssuePage * 10).map(issue => <div className="issue-row" key={issue.subject}>
        <div><Text weight="medium">{issue.type === 'delivery' ? tr("tasks.deliveryNeedsReview") : tr("tasks.executionNeedsReview")}</Text><Text as="p" size="2" color="gray">{issue.subject} · {statusLabel(issue.state)}</Text></div>
        <Button variant="soft" onClick={() => onOpen({ type: 'issue', id: issue.subject })}><Icon name="check" />{tr("tasks.review")}</Button>
      </div>)}</div>
      {issues.length > 10 && <div className="page-buttons"><Button variant="soft" color="gray" disabled={currentIssuePage <= 1} onClick={() => setIssuePage(currentIssuePage - 1)}>{tr("tasks.previous")}</Button><Text size="2">{currentIssuePage} / {Math.ceil(issues.length / 10)}</Text><Button variant="soft" color="gray" disabled={currentIssuePage * 10 >= issues.length} onClick={() => setIssuePage(currentIssuePage + 1)}>{tr("tasks.next")}</Button></div>}
    </details>}
  </>;
}
