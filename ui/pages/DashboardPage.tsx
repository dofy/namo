import { t as tr, getLocale } from '../i18n';
import { Heading, Spinner, Text } from '@radix-ui/themes';
import type { ManagementState } from '../../src/ui-contract';
import { api } from '../api';
import { Notice } from '../components';
import { duration, LocalLink, useRemote, type Navigate } from '../browse-components';
import { TaskTable, type DetailTarget } from './TasksPage';

export function DashboardPage({ state, navigate, onOpen, enabled }: { state: ManagementState; navigate: Navigate; onOpen: (target: DetailTarget) => void; enabled: boolean }) {
  const { data, error } = useRemote('dashboard', api.dashboard, state, enabled);
  if (!data) return error ? <Notice error>{error}</Notice> : <div className="loading"><Spinner />  {tr("dashboard.loadingDashboard")}</div>;
  const max = Math.max(1, ...data.daily.map(day => day.count));
  const metrics = [
    { label: tr("status.running"), value: data.running, href: '/tasks?state=running', hint: tr("dashboard.agentWorking"), tone: 'blue' },
    { label: tr("common.waitingInput"), value: data.waiting, href: '/tasks?state=waiting', hint: tr("dashboard.answerNeeded"), tone: 'orange' },
    { label: tr("common.queued"), value: data.queued, href: '/tasks?state=queued', hint: tr("dashboard.waitingExecutionSlot"), tone: 'gray' },
    { label: tr("dashboard.completedToday"), value: data.completedToday, href: `/tasks?state=succeeded&dateField=finished&from=${data.daily[6].date}&to=${data.daily[6].date}`, hint: tr("dashboard.completionTime"), tone: 'green' },
  ];
  return <>
    {error && <Notice error>{tr("dashboard.refreshFailedShowingPreviouslyLoadedData")}{error}</Notice>}
    <div className="overview-caption"><Text size="2" color="gray">{tr("dashboard.allTimeTotal")} {data.totalTasks}  {tr("dashboard.taskCountPrefix")}{data.totalSessions}  {tr("common.sessions")}</Text><Text size="1" color="gray">{tr("dashboard.updated")} {new Date(data.generatedAt).toLocaleTimeString(getLocale(), { hour12: false })}</Text></div>
    <div className="metrics" aria-label={tr("dashboard.taskOverview")}>{metrics.map(metric => <LocalLink key={metric.label} href={metric.href} navigate={navigate} className={`metric metric-${metric.tone}`}>
      <span className="metric-label">{metric.label}</span><strong>{metric.value}</strong><span className="metric-hint">{metric.hint}</span>
    </LocalLink>)}</div>
    <div className="dashboard-middle">
      <section className="activity-panel" aria-labelledby="activity-heading">
        <div className="section-title"><Heading as="h2" size="4" id="activity-heading">{tr("dashboard.tasksOverSevenDays")}</Heading><Text size="2" color="gray">{tr("dashboard.periodTotal")} {data.daily.reduce((sum, day) => sum + day.count, 0)}  {tr("dashboard.taskCountSuffix")}</Text></div>
        <svg className="activity-chart" viewBox="0 0 560 170" role="img" aria-labelledby="activity-title activity-description">
          <title id="activity-title">{tr("dashboard.tasksCreatedEachDayOverLastSeven")}</title><desc id="activity-description">{data.daily.map(day => tr("dashboard.dailyTaskCount", day.date, day.count)).join('；')}</desc>
          <line x1="0" y1="132" x2="560" y2="132" stroke="#dce3e9" />
          {data.daily.map((day, index) => {
            const height = day.count / max * 98, x = index * 80 + 20;
            return <g key={day.date}><rect x={x} y={132 - Math.max(2, height)} width="40" height={Math.max(2, height)} rx="4" fill={day.count ? index === 6 ? '#f58a24' : '#f7c18b' : '#e7ecf0'} /><text x={x + 20} y={120 - height} textAnchor="middle" className="chart-count">{day.count}</text><text x={x + 20} y="158" textAnchor="middle" className="chart-label">{day.date.slice(5).replace('-', '/')}</text></g>;
          })}
        </svg>
        <div className="period-stats"><div><span>{tr("dashboard.sevenDaySuccessRate")}</span><strong>{data.successRate == null ? '—' : `${(data.successRate * 100).toLocaleString(getLocale(), { maximumFractionDigits: 1 })}%`}</strong></div><div><span>{tr("dashboard.averageCompletionTime")}</span><strong>{duration(data.averageDurationMs)}</strong></div><div><span>{tr("dashboard.sevenDayActiveUsers")}</span><strong>{data.activeUsers}  {tr("dashboard.users")}</strong></div></div>
        <Text as="p" size="1" color="gray" className="metric-note">{tr("dashboard.calendarDays")} {data.timeZone}  {tr("dashboard.successRateExcludesCancelledUnfinishedTasksDuration")}</Text>
      </section>
      <section className="attention-panel" aria-labelledby="attention-heading"><Heading as="h2" size="4" id="attention-heading">{tr("dashboard.needsAttention")}</Heading>
        <LocalLink href="/tasks?state=waiting" navigate={navigate} className="attention-row"><span><strong>{tr("common.waitingAnswer")}</strong><small>{tr("dashboard.replyOriginalFeishuConversationContinue")}</small></span><b>{data.waiting}</b></LocalLink>
        <LocalLink href="/tasks?state=problem" navigate={navigate} className="attention-row"><span><strong>{tr("dashboard.executionIssues")}</strong><small>{tr("dashboard.reviewFailedInterruptedUncertainTasks")}</small></span><b>{data.failed}</b></LocalLink>
        <LocalLink href="/tasks?review=delivery" navigate={navigate} className="attention-row"><span><strong>{tr("dashboard.deliveryNeedsReview")}</strong><small>{tr("dashboard.platformAcceptanceNotMeanMessageWasRead")}</small></span><b>{data.deliveryIssues}</b></LocalLink>
        <Text as="p" size="1" color="gray">{tr("dashboard.executionIssuesIncludePreviouslyReviewedRecords")}</Text>
      </section>
    </div>
    <div className="section-title"><Heading as="h2" size="4">{tr("dashboard.recentTasks")}</Heading><LocalLink href="/tasks" navigate={navigate}>{tr("dashboard.viewAllTasks")}</LocalLink></div>
    {data.recent.length ? <TaskTable tasks={data.recent} onOpen={onOpen} navigate={navigate} compact /> : <div className="list-empty"><Heading as="h3" size="3">{tr("dashboard.startFirstTask")}</Heading><Text as="p" size="2" color="gray">{tr("dashboard.sendClearRequestFeishuDirectMessageSee")}</Text></div>}
  </>;
}
