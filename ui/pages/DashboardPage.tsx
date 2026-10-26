import { t as tr, getLocale } from '../i18n';
import { Heading, Spinner, Text } from '@radix-ui/themes';
import type { ManagementState } from '../../src/ui-contract';
import { api } from '../api';
import { Notice } from '../components';
import { duration, LocalLink, useRemote, type Navigate } from '../browse-components';
import { TaskTable, type DetailTarget } from './TasksPage';

export function DashboardPage({ state, navigate, onOpen, enabled }: { state: ManagementState; navigate: Navigate; onOpen: (target: DetailTarget) => void; enabled: boolean }) {
  const { data, error } = useRemote('dashboard', api.dashboard, state, enabled);
  if (!data) return error ? <Notice error>{error}</Notice> : <div className="loading"><Spinner />  {tr("读取概览")}</div>;
  const max = Math.max(1, ...data.daily.map(day => day.count));
  const metrics = [
    { label: tr("执行中"), value: data.running, href: '/tasks?state=running', hint: tr("Agent 正在处理"), tone: 'blue' },
    { label: tr("等待补充"), value: data.waiting, href: '/tasks?state=waiting', hint: tr("需要你回答问题"), tone: 'orange' },
    { label: tr("排队中"), value: data.queued, href: '/tasks?state=queued', hint: tr("等待执行空位"), tone: 'gray' },
    { label: tr("今日完成"), value: data.completedToday, href: `/tasks?state=succeeded&dateField=finished&from=${data.daily[6].date}&to=${data.daily[6].date}`, hint: tr("按完成时间统计"), tone: 'green' },
  ];
  return <>
    {error && <Notice error>{tr("刷新失败，以下为上次读取的数据：")}{error}</Notice>}
    <div className="overview-caption"><Text size="2" color="gray">{tr("累计")} {data.totalTasks}  {tr("项任务，")}{data.totalSessions}  {tr("个会话")}</Text><Text size="1" color="gray">{tr("更新于")} {new Date(data.generatedAt).toLocaleTimeString(getLocale(), { hour12: false })}</Text></div>
    <div className="metrics" aria-label={tr("任务概况")}>{metrics.map(metric => <LocalLink key={metric.label} href={metric.href} navigate={navigate} className={`metric metric-${metric.tone}`}>
      <span className="metric-label">{metric.label}</span><strong>{metric.value}</strong><span className="metric-hint">{metric.hint}</span>
    </LocalLink>)}</div>
    <div className="dashboard-middle">
      <section className="activity-panel" aria-labelledby="activity-heading">
        <div className="section-title"><Heading as="h2" size="4" id="activity-heading">{tr("近七天任务量")}</Heading><Text size="2" color="gray">{tr("共")} {data.daily.reduce((sum, day) => sum + day.count, 0)}  {tr("项")}</Text></div>
        <svg className="activity-chart" viewBox="0 0 560 170" role="img" aria-labelledby="activity-title activity-description">
          <title id="activity-title">{tr("近七天每日创建的任务数量")}</title><desc id="activity-description">{data.daily.map(day => tr("{0}：{1} 项", day.date, day.count)).join('；')}</desc>
          <line x1="0" y1="132" x2="560" y2="132" stroke="#dce3e9" />
          {data.daily.map((day, index) => {
            const height = day.count / max * 98, x = index * 80 + 20;
            return <g key={day.date}><rect x={x} y={132 - Math.max(2, height)} width="40" height={Math.max(2, height)} rx="4" fill={day.count ? index === 6 ? '#f58a24' : '#f7c18b' : '#e7ecf0'} /><text x={x + 20} y={120 - height} textAnchor="middle" className="chart-count">{day.count}</text><text x={x + 20} y="158" textAnchor="middle" className="chart-label">{day.date.slice(5).replace('-', '/')}</text></g>;
          })}
        </svg>
        <div className="period-stats"><div><span>{tr("七天执行成功率")}</span><strong>{data.successRate == null ? '—' : `${(data.successRate * 100).toLocaleString(getLocale(), { maximumFractionDigits: 1 })}%`}</strong></div><div><span>{tr("完成任务平均耗时")}</span><strong>{duration(data.averageDurationMs)}</strong></div><div><span>{tr("七天活跃用户")}</span><strong>{data.activeUsers}  {tr("人")}</strong></div></div>
        <Text as="p" size="1" color="gray" className="metric-note">{tr("按")} {data.timeZone}  {tr("自然日统计。成功率不含取消和未结束任务；耗时包含等待补充。")}</Text>
      </section>
      <section className="attention-panel" aria-labelledby="attention-heading"><Heading as="h2" size="4" id="attention-heading">{tr("值得留意")}</Heading>
        <LocalLink href="/tasks?state=waiting" navigate={navigate} className="attention-row"><span><strong>{tr("等待你的回答")}</strong><small>{tr("到原飞书会话补充后继续")}</small></span><b>{data.waiting}</b></LocalLink>
        <LocalLink href="/tasks?state=problem" navigate={navigate} className="attention-row"><span><strong>{tr("执行异常记录")}</strong><small>{tr("查看未完成、中断与待核对任务")}</small></span><b>{data.failed}</b></LocalLink>
        <LocalLink href="/tasks?review=delivery" navigate={navigate} className="attention-row"><span><strong>{tr("投递待核对")}</strong><small>{tr("平台接收不代表用户已读")}</small></span><b>{data.deliveryIssues}</b></LocalLink>
        <Text as="p" size="1" color="gray">{tr("执行异常包含已核对的历史记录。")}</Text>
      </section>
    </div>
    <div className="section-title"><Heading as="h2" size="4">{tr("最近任务")}</Heading><LocalLink href="/tasks" navigate={navigate}>{tr("查看全部任务")}</LocalLink></div>
    {data.recent.length ? <TaskTable tasks={data.recent} onOpen={onOpen} navigate={navigate} compact /> : <div className="list-empty"><Heading as="h3" size="3">{tr("从第一项任务开始")}</Heading><Text as="p" size="2" color="gray">{tr("在飞书私聊中发送一个明确要求，这里会记录任务进展。")}</Text></div>}
  </>;
}
