import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Dialog, Link, Spinner, Table, Text } from '@radix-ui/themes';
import type { ManagementState, ScheduleListItem } from '../../src/ui-contract';
import { api, message } from '../api';
import { Icon } from '../Icon';
import { t as tr } from '../i18n';
import { ButtonGroup, ConfirmButton, EditorCloseButton, Notice } from '../components';
import { DateTime, Owner, Pagination, useRemote, type Navigate } from '../browse-components';
import { EmptyState, SectionHeading } from '../components/PageSection';

const frequency=(item:ScheduleListItem)=>item.intervalMs===null?tr('schedules.once'):item.intervalMs===86_400_000?tr('schedules.daily'):item.intervalMs===604_800_000?tr('schedules.weekly'):tr('schedules.otherInterval',item.intervalMs);
const scheduleStatus=(item:ScheduleListItem)=><Badge color={item.state==='active'?'green':item.state==='paused'?'amber':'gray'} variant="soft">{item.state==='active'?tr('schedules.active'):item.state==='paused'?tr('schedules.paused'):tr('schedules.completed')}</Badge>;
const scheduleTime=(item:ScheduleListItem)=><><DateTime value={item.state==='completed'?null:item.nextAt} empty="—" />{item.state==='paused' && <span className="created-hint">{tr('schedules.pausedTime')}</span>}</>;

function ScheduleSummary({item}:{item:ScheduleListItem}) {
  const content=useRef<HTMLSpanElement>(null),[overflow,setOverflow]=useState(false),[open,setOpen]=useState(false);
  useEffect(()=>{
    const element=content.current;if(!element)return;
    const measure=()=>setOverflow(element.clientHeight>0 && element.scrollHeight>element.clientHeight+1);
    measure();
    const observer=new ResizeObserver(measure);observer.observe(element);
    return ()=>observer.disconnect();
  },[item.content]);
  return <div className="schedule-summary">
    <span ref={content} className="schedule-content">{item.content}</span>
    <span className="secondary-id">{item.id}</span>
    <Dialog.Root open={open} onOpenChange={setOpen}>
      {overflow && <Dialog.Trigger><Link asChild size="1"><button type="button" className="schedule-content-more">{tr('schedules.viewFullContent')}</button></Link></Dialog.Trigger>}
      <Dialog.Content maxWidth="680px">
        <div className="editor-dialog-header"><Dialog.Title>{tr('schedules.content')}</Dialog.Title><EditorCloseButton busy={false} onClose={()=>setOpen(false)}/></div>
        <Text as="p" size="1" color="gray">{item.id}</Text>
        <Dialog.Description className="schedule-content-full">{item.content}</Dialog.Description>
      </Dialog.Content>
    </Dialog.Root>
  </div>;
}

export function SchedulesPage({ state, search, navigate, enabled }: {
  state:ManagementState; search:string; navigate:Navigate; enabled:boolean;
}) {
  const [revision,setRevision]=useState(0),[actionId,setActionId]=useState(''),[actionError,setActionError]=useState(''),[feedback,setFeedback]=useState('');
  const load=useCallback((signal:AbortSignal)=>api.schedules(search,signal),[search,revision]);
  const perform=async(item:ScheduleListItem,action:'pause'|'resume'|'delete')=>{
    setActionId(item.id);setActionError('');setFeedback('');
    try {await api.scheduleAction(item,action);setFeedback(tr('schedules.actionDone'));setRevision(n=>n+1);}
    catch(error){setActionError(message(error));setRevision(n=>n+1);throw error;}
    finally{setActionId('');}
  };
  const actions=(item:ScheduleListItem)=><ButtonGroup label={tr('schedules.actions')} className="schedule-actions">
    <Button type="button" size="2" variant="soft" color="blue" aria-label={tr('schedules.pause')} title={tr('schedules.pause')} disabled={!enabled||!!actionId||item.state!=='active'} onClick={()=>void perform(item,'pause').catch(()=>{})}><Icon name="pause" /></Button>
    <Button type="button" size="2" variant="soft" aria-label={tr('schedules.resume')} title={tr('schedules.resume')} disabled={!enabled||!!actionId||item.state!=='paused'} onClick={()=>void perform(item,'resume').catch(()=>{})}><Icon name="play" /></Button>
    <ConfirmButton size="2" danger triggerLabel={tr('schedules.delete')} disabled={!enabled||!!actionId||item.state==='active'} title={tr('schedules.deleteTitle')} description={tr('schedules.deleteDescription')} action={tr('schedules.delete')} onConfirm={()=>perform(item,'delete')}><Icon name="trash" /></ConfirmButton>
  </ButtonGroup>;
  const {data,error,busy}=useRemote(`schedules?${search}`,load,state,enabled);
  return <section className="page-panel records-panel">
    <div className="list-title"><SectionHeading icon="schedules" title={tr('schedules.title')} action={<Text size="2" color="gray">{busy ? tr('tasks.refreshing') : data ? tr('tasks.total',data.total,tr('tasks.tasks')) : ''}</Text>} /></div>
    <Text as="p" size="2" color="gray">{tr('schedules.help')}</Text>
    <Text as="p" size="2" color="gray">{tr('schedules.manage')}</Text>
    {error && <Notice error>{error}</Notice>}
    {actionError && <Notice error>{actionError}</Notice>}
    {feedback && <div role="status"><Notice>{feedback}</Notice></div>}
    {!data && busy && <div className="loading"><Spinner /> {tr('tasks.loadingRecords')}</div>}
    {data && <div aria-busy={busy}>
      {data.items.length ? <><Table.Root variant="surface" className="task-table browse-table schedule-table">
        <Table.Header><Table.Row><Table.ColumnHeaderCell>{tr('schedules.content')}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr('common.user')}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr('schedules.type')}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr('schedules.frequency')}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr('common.status')}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr('schedules.next')}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{tr('schedules.actions')}</Table.ColumnHeaderCell></Table.Row></Table.Header>
        <Table.Body>{data.items.map(item=><Table.Row key={item.id}>
          <Table.RowHeaderCell className="summary-cell"><ScheduleSummary item={item}/></Table.RowHeaderCell>
          <Table.Cell><Owner id={item.ownerId} name={item.ownerName} /></Table.Cell>
          <Table.Cell>{item.kind==='reminder'?tr('schedules.reminder'):tr('schedules.task')}</Table.Cell>
          <Table.Cell>{frequency(item)}</Table.Cell>
          <Table.Cell>{scheduleStatus(item)}</Table.Cell>
          <Table.Cell>{scheduleTime(item)}</Table.Cell>
          <Table.Cell>{actions(item)}</Table.Cell>
        </Table.Row>)}</Table.Body>
      </Table.Root><div className="schedule-mobile">{data.items.map(item=><article key={item.id} className="schedule-mobile-card">
        <div className="schedule-mobile-heading"><ScheduleSummary item={item}/>{scheduleStatus(item)}</div>
        <dl><dt>{tr('common.user')}</dt><dd><Owner id={item.ownerId} name={item.ownerName} /></dd>
          <dt>{tr('schedules.type')}</dt><dd>{item.kind==='reminder'?tr('schedules.reminder'):tr('schedules.task')} · {frequency(item)}</dd>
          <dt>{tr('schedules.next')}</dt><dd>{scheduleTime(item)}</dd></dl>
        {actions(item)}
      </article>)}</div></> : <EmptyState icon="schedules" title={tr('schedules.empty')} description={tr('schedules.emptyHelp')} />}
      <Pagination page={data} busy={busy} onChange={(page,size)=>{const q=new URLSearchParams();q.set('page',String(page));q.set('pageSize',String(size));navigate(`/schedules?${q}`);}} />
    </div>}
  </section>;
}
