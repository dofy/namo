import { useState } from 'react';
import { Badge, Button, Code, Flex, Heading, Text, TextField } from '@radix-ui/themes';
import type { ApprovalList, ApprovalView, ManagementState, MigrationInspection, ServiceLog, TaskListItem } from '../src/ui-contract';
import { api, message } from './api';
import { Choice, ConfirmButton, Field, Notice, StatusBadge } from './components';
import { t as tr, getLocale, type MessageKey } from './i18n';

const approvalStates: Record<ApprovalView['state'], MessageKey> = {
  pending:'operations.pending', approved:'operations.approved', rejected:'operations.rejected', expired:'operations.expired',
  invalidated:'operations.invalidated', executing:'operations.executing', succeeded:'status.completed', failed:'status.failed', unknown:'components.deliveryUnknown',
};
export function OperationsPanel({state, expired}: {state: ManagementState; expired: boolean}) {
  const [logs, setLogs] = useState<ServiceLog[]>(), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const loadLogs = async () => {
    setBusy(true); setError('');
    try {setLogs(await api.logs());} catch (error) {setError(message(error));} finally {setBusy(false);}
  };
  return <section className="form-section operations-panel" aria-labelledby="operations-title">
    <Heading as="h2" size="5" id="operations-title">{tr('operations.title')}</Heading>
    <dl className="operations-info">
      <div><dt>{tr('operations.connection')}</dt><dd>{state.service.ready?tr('app.feishuConnected'):state.service.running?tr('app.connectionNotReady'):tr('app.serviceStopped')}</dd></div>
      <div><dt>{tr('operations.backgroundService')}</dt><dd>{state.service.installed?tr('operations.installed'):tr('operations.notInstalled')}</dd></div>
      <div><dt>{tr('operations.process')}</dt><dd>{state.service.pid??'—'}</dd></div>
      <div><dt>{tr('operations.schema')}</dt><dd>{state.database.schema}</dd></div>
      <div className="operations-wide"><dt>{tr('operations.configFile')}</dt><dd><Code variant="ghost">{state.config.file}</Code></dd></div>
    </dl>
    <Flex gap="3" wrap="wrap" align="center"><Text size="2">{tr('operations.queue')}</Text>
      {(state.database.queue?.states??[]).map(row=><Text key={row.state} size="2"><StatusBadge state={row.state}/> {row.count}</Text>)}
      {!state.database.queue?.states.length&&<Text size="2" color="gray">{tr('operations.emptyQueue')}</Text>}
    </Flex>
    <details onToggle={event=>{if(event.currentTarget.open&&!logs&&!busy&&!expired)void loadLogs();}}>
      <summary>{tr('operations.logs')}</summary>
      <Text as="p" size="1" color="gray">{tr('operations.logsHelp')}</Text>
      <Button variant="soft" disabled={expired} loading={busy} onClick={()=>void loadLogs()}>{tr('operations.refreshLogs')}</Button>
      {error&&<Notice error>{error}</Notice>}
      {logs?.map(log=><div key={log.name} className="operation-log"><Heading as="h3" size="2">{log.name}</Heading>
        {log.status==='ready'?<><pre className="detail-block">{log.text||tr('operations.emptyLog')}</pre>{log.truncated&&<Text as="p" size="1" color="gray">{tr('operations.logTruncated')}</Text>}</>
          :<Text as="p" size="2" color="gray">{tr(log.status==='missing'?'operations.logMissing':'operations.logUnavailable')}</Text>}
      </div>)}
    </details>
    <ApprovalPanel disabled={expired||!state.recoveryAvailable}/>
    <MigrationPanel disabled={expired}/>
  </section>;
}
function ApprovalPanel({disabled}: {disabled: boolean}) {
  const [list,setList] = useState<ApprovalList>(), [tasks,setTasks] = useState<TaskListItem[]>([]);
  const [task,setTask] = useState(''), [remote,setRemote] = useState(''), [branch,setBranch] = useState('main');
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  async function load() {
    const next = await api.approvals(); setList(next);
    if(next.configured) setTasks((await api.tasks('state=succeeded&pageSize=50')).items);
  }
  async function refresh() {
    setBusy(true); setError(''); try {await load();} catch(error){setError(message(error));} finally{setBusy(false);}
  }
  const act = async (record:ApprovalView, action:'approve'|'reject'|'execute'|'reconcile') => {
    if(!list)return;
    setBusy(true);setError('');
    try {await api.approval({action,id:record.id,revision:record.revision,configRevision:list.configRevision,confirmed:true});await load();}
    catch(error){setError(message(error));try{await load();}catch{/* Preserve the action error. */}}
    finally{setBusy(false);}
  };
  return <details onToggle={event=>{if(event.currentTarget.open&&!list&&!busy&&!disabled)void refresh();}}>
    <summary>{tr('operations.approvals')}</summary>
    <Text as="p" size="2" color="gray">{tr('operations.approvalHelp')}</Text>
    <Button variant="soft" loading={busy} disabled={disabled} onClick={()=>void refresh()}>{tr('operations.refreshApprovals')}</Button>
    {error&&<Notice error>{error}</Notice>}
    {list&&!list.configured&&<Notice>{tr('operations.approvalsUnavailable')}</Notice>}
    {list?.configured&&<form onSubmit={async event=>{
      event.preventDefault();setBusy(true);setError('');
      try {await api.approval({action:'request',taskId:task.trim().toUpperCase(),remote:remote||list.remotes[0],ref:branch.startsWith('refs/heads/')?branch:`refs/heads/${branch}`,configRevision:list.configRevision,confirmed:true});await load();}
      catch(error){setError(message(error));}finally{setBusy(false);}
    }}><fieldset disabled={busy||disabled}>
      <div className="form-grid">
        <Field label={tr('operations.completedTask')} htmlFor="approval-task"><TextField.Root id="approval-task" list="approval-task-options" placeholder="N-…" value={task} onChange={event=>setTask(event.target.value)}/><datalist id="approval-task-options">{tasks.map(task=><option key={task.id} value={task.id}>{task.title}</option>)}</datalist></Field>
        <Field label={tr('operations.remote')} htmlFor="approval-remote"><Choice id="approval-remote" value={remote||list.remotes[0]} onChange={setRemote} options={list.remotes.map(remote=>({value:remote,label:remote}))}/></Field>
      </div>
      <Field label={tr('operations.branch')} htmlFor="approval-branch"><TextField.Root id="approval-branch" value={branch} onChange={event=>setBranch(event.target.value)}/></Field>
      <Button type="submit" variant="soft" disabled={!task.trim()||!branch.trim()}>{tr('operations.previewPush')}</Button>
    </fieldset></form>}
    {list?.items.map(record=><article key={record.id} className="audit approval-record">
      <Flex gap="3" align="center" wrap="wrap"><Heading as="h3" size="3">{record.remote} / {record.ref}</Heading><Badge>{tr(approvalStates[record.state])}</Badge></Flex>
      <Text as="p" size="2">{record.commitSummary}</Text>
      <dl className="operations-info">
        <div><dt>{tr('operations.approvalId')}</dt><dd>{record.id}</dd></div>
        <div><dt>{tr('operations.project')}</dt><dd>{record.project??'—'}</dd></div>
        <div><dt>{tr('operations.completedTask')}</dt><dd>{record.taskId}</dd></div>
        <div><dt>{tr('operations.expires')}</dt><dd>{new Date(record.expiresAt).toLocaleString(getLocale())}</dd></div>
        <div className="operations-wide"><dt>{tr('operations.commit')}</dt><dd><Code variant="ghost">{record.headSha}</Code></dd></div>
        <div className="operations-wide"><dt>{tr('operations.remoteBaseline')}</dt><dd><Code variant="ghost">{record.remoteBeforeSha??tr('operations.newBranch')}</Code></dd></div>
      </dl>
      {record.reason&&<Text as="p" size="1" color="gray">{record.reason}</Text>}
      <Flex gap="3" wrap="wrap">
        {(['pending','approved','unknown'] as string[]).includes(record.state)&&<ConfirmButton disabled={busy||disabled} title={tr(record.state==='pending'?'operations.approve':record.state==='approved'?'operations.execute':'operations.reconcile')} description={tr('operations.exactTarget',record.remote,record.ref,record.headSha)} action={tr(record.state==='pending'?'operations.approve':record.state==='approved'?'operations.execute':'operations.reconcile')} onConfirm={()=>act(record,record.state==='pending'?'approve':record.state==='approved'?'execute':'reconcile')}>
          {tr(record.state==='pending'?'operations.approve':record.state==='approved'?'operations.execute':'operations.reconcile')}
        </ConfirmButton>}
        {record.state==='pending'&&<ConfirmButton disabled={busy||disabled} title={tr('operations.reject')} description={tr('operations.exactTarget',record.remote,record.ref,record.headSha)} action={tr('operations.reject')} onConfirm={()=>act(record,'reject')}>{tr('operations.reject')}</ConfirmButton>}
      </Flex>
    </article>)}
    {list?.configured&&!list.items.length&&<Text as="p" size="2" color="gray">{tr('operations.noApprovals')}</Text>}
  </details>;
}
function MigrationPanel({disabled}: {disabled:boolean}) {
  const [path,setPath]=useState(''),[name,setName]=useState('openclaw'),[result,setResult]=useState<MigrationInspection>();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  return <details><summary>{tr('operations.migration')}</summary>
    <Text as="p" size="2" color="gray">{tr('operations.migrationHelp')}</Text>
    <form onSubmit={async event=>{event.preventDefault();setBusy(true);setError('');setResult(undefined);try{setResult(await api.inspectMigration(path,name));}catch(error){setError(message(error));}finally{setBusy(false);}}}>
      <fieldset disabled={disabled||busy}><div className="form-grid">
        <Field label={tr('operations.sourceFile')} htmlFor="migration-source"><TextField.Root id="migration-source" value={path} onChange={event=>setPath(event.target.value)} placeholder="/path/to/openclaw.json"/></Field>
        <Field label={tr('operations.sourceName')} htmlFor="migration-name"><TextField.Root id="migration-name" value={name} onChange={event=>setName(event.target.value)}/></Field>
      </div><Button type="submit" variant="soft" disabled={!path||!name}>{tr('operations.inspectSource')}</Button></fieldset>
    </form>
    {error&&<Notice error>{error}</Notice>}
    {result&&<div className="audit"><Badge>{tr(result.status==='supported'?'operations.sourceSupported':result.status==='unsupported'?'operations.sourceUnsupported':'operations.sourceManual')}</Badge><Text as="p" size="2">{tr('operations.sourceSummary',result.sourceVersion??'—',result.applications.length,result.candidates.length)}</Text>
      {result.applications.map(app=><Text as="p" size="2" key={app.accountId}>{app.accountId} · {app.appIdHint} · {app.domain} / {app.connectionMode}</Text>)}
      {result.issues.map((issue,index)=><Text as="p" size="2" key={index}>{issue.message} {issue.action}</Text>)}
    </div>}
  </details>;
}
