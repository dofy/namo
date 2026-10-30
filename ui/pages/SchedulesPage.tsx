import { useCallback } from 'react';
import { Badge, Spinner, Table, Text } from '@radix-ui/themes';
import type { ManagementState, ScheduleListItem } from '../../src/ui-contract';
import { api } from '../api';
import { t as tr } from '../i18n';
import { Notice } from '../components';
import { DateTime, Owner, Pagination, useRemote, type Navigate } from '../browse-components';
import { EmptyState, SectionHeading } from '../components/PageSection';

const frequency=(item:ScheduleListItem)=>item.intervalMs===null?tr('schedules.once'):item.intervalMs===86_400_000?tr('schedules.daily'):item.intervalMs===604_800_000?tr('schedules.weekly'):tr('schedules.otherInterval',item.intervalMs);
const scheduleStatus=(item:ScheduleListItem)=><Badge color={item.state==='active'?'green':item.state==='paused'?'amber':'gray'} variant="soft">{item.state==='active'?tr('schedules.active'):item.state==='paused'?tr('schedules.paused'):tr('schedules.completed')}</Badge>;
const scheduleTime=(item:ScheduleListItem)=><><DateTime value={item.state==='completed'?null:item.nextAt} empty="—" />{item.state==='paused' && <span className="created-hint">{tr('schedules.pausedTime')}</span>}</>;

export function SchedulesPage({ state, search, navigate, enabled }: {
  state:ManagementState; search:string; navigate:Navigate; enabled:boolean;
}) {
  const load=useCallback((signal:AbortSignal)=>api.schedules(search,signal),[search]);
  const {data,error,busy}=useRemote(`schedules?${search}`,load,state,enabled);
  return <section className="page-panel records-panel">
    <div className="list-title"><SectionHeading icon="schedules" title={tr('schedules.title')} action={<Text size="2" color="gray">{busy ? tr('tasks.refreshing') : data ? tr('tasks.total',data.total,tr('tasks.tasks')) : ''}</Text>} /></div>
    <Text as="p" size="2" color="gray">{tr('schedules.help')}</Text>
    <Text as="p" size="2" color="gray">{tr('schedules.manage')}</Text>
    {error && <Notice error>{error}</Notice>}
    {!data && busy && <div className="loading"><Spinner /> {tr('tasks.loadingRecords')}</div>}
    {data && <div aria-busy={busy}>
      {data.items.length ? <><Table.Root variant="surface" className="task-table browse-table schedule-table">
        <Table.Header><Table.Row><Table.ColumnHeaderCell>{tr('schedules.content')}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr('common.user')}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr('schedules.type')}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr('schedules.frequency')}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr('common.status')}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr('schedules.next')}</Table.ColumnHeaderCell></Table.Row></Table.Header>
        <Table.Body>{data.items.map(item=><Table.Row key={item.id}>
          <Table.RowHeaderCell className="summary-cell"><span className="schedule-content">{item.content}</span><span className="secondary-id">{item.id}</span></Table.RowHeaderCell>
          <Table.Cell><Owner id={item.ownerId} name={item.ownerName} /></Table.Cell>
          <Table.Cell>{item.kind==='reminder'?tr('schedules.reminder'):tr('schedules.task')}</Table.Cell>
          <Table.Cell>{frequency(item)}</Table.Cell>
          <Table.Cell>{scheduleStatus(item)}</Table.Cell>
          <Table.Cell>{scheduleTime(item)}</Table.Cell>
        </Table.Row>)}</Table.Body>
      </Table.Root><div className="schedule-mobile">{data.items.map(item=><article key={item.id} className="schedule-mobile-card">
        <div className="schedule-mobile-heading"><span className="schedule-content">{item.content}</span>{scheduleStatus(item)}</div>
        <span className="secondary-id">{item.id}</span>
        <dl><dt>{tr('common.user')}</dt><dd><Owner id={item.ownerId} name={item.ownerName} /></dd>
          <dt>{tr('schedules.type')}</dt><dd>{item.kind==='reminder'?tr('schedules.reminder'):tr('schedules.task')} · {frequency(item)}</dd>
          <dt>{tr('schedules.next')}</dt><dd>{scheduleTime(item)}</dd></dl>
      </article>)}</div></> : <EmptyState icon="schedules" title={tr('schedules.empty')} description={tr('schedules.emptyHelp')} />}
      <Pagination page={data} busy={busy} onChange={(page,size)=>{const q=new URLSearchParams();q.set('page',String(page));q.set('pageSize',String(size));navigate(`/schedules?${q}`);}} />
    </div>}
  </section>;
}
