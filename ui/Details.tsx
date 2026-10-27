import { t as tr, getLocale, useLocale } from './i18n';
import { Icon } from './Icon';
import { useEffect, useState } from 'react';
import { Button, Dialog, Heading, Spinner, Text, TextArea } from '@radix-ui/themes';
import type { Issue, TaskDetail } from '../src/ui-contract';
import { api, message } from './api';
import { ConfirmButton, Field, Notice, StatusBadge } from './components';
import type { DetailTarget } from './pages/TasksPage';
import { Evidence } from './Evidence';
import { TaskContextDetails } from './TaskContextDetails';
import { DateTime } from './browse-components';

export function Details({ target, close, changed, notify, restoreFocus }: {
  target: DetailTarget | null; close: () => void; changed: () => Promise<unknown>;
  notify: (text: string) => void; restoreFocus: () => void;
}) {
  const locale = useLocale();
  const [data, setData] = useState<{ type: 'task'; value: TaskDetail } | { type: 'issue'; value: Issue }>();
  const [error, setError] = useState(''), [note, setNote] = useState('');
  useEffect(() => setNote(''), [target]);
  useEffect(() => {
    setData(undefined); setError('');
    if (!target) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const next = target.type === 'task' ? { type: 'task' as const, value: await api.task(target.id, controller.signal) }
          : { type: 'issue' as const, value: await api.issue(target.id, controller.signal) };
        if (!controller.signal.aborted) setData(next);
      } catch (e) { if (!controller.signal.aborted) setError(message(e)); }
    };
    void load(); return () => controller.abort();
  }, [target, locale]);
  const completed = async (text: string) => { close(); notify(text); await changed(); };
  return <Dialog.Root open={!!target} onOpenChange={open => { if (!open) close(); }}>
    <Dialog.Content maxWidth="760px" onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}>
      <div className="dialog-title"><Dialog.Title>{data?.type === 'task' ? data.value.title || target?.id : `${target?.type === 'issue' ? tr("taskDetails.review") : ''}${target?.id ?? ''}`}</Dialog.Title><Dialog.Close><Button variant="soft" color="gray" aria-label={tr("taskDetails.closeDetails")}><Icon name="close" />{tr("common.close")}</Button></Dialog.Close></div>
      <Dialog.Description size="2" color="gray">{target?.type === 'issue' ? tr("taskDetails.reviewExecutionDeliveryWithoutRunningTaskAgain") : tr("taskDetails.viewResultsInputVersionsDeliveryRecords")}</Dialog.Description>
      {error && <Notice error>{error}</Notice>}
      {!data && !error && <div className="loading"><Spinner />  {tr("taskDetails.loadingDetails")}</div>}
      {data?.type === 'task' && <>
        <div className="detail-summary"><StatusBadge state={data.value.execution} /><Text size="2">{data.value.project || tr("common.isolatedDirectory")}  {tr("taskDetails.inputVersion")} {data.value.inputVersion}</Text></div>
        <Text as="p" size="2" color="gray">{data.value.ownerName || data.value.ownerId || tr("common.unnamedUser")} · {data.value.id}</Text>
        <div className="detail-times"><div><span>{tr("common.createdAt")}</span><DateTime value={data.value.createdAt} empty={tr("taskDetails.notRecorded")} /></div><div><span>{tr("taskDetails.firstStarted")}</span><DateTime value={data.value.startedAt} /></div><div><span>{tr("common.finishedAt")}</span><DateTime value={data.value.finishedAt} empty={tr("common.notFinished")} /></div></div>
        <Text as="p" size="2" color="gray">{tr("nav.sessions")} {data.value.workstream}</Text>
        {data.value.error && <Notice error>{tr("taskDetails.reason")}{data.value.error}</Notice>}
        {!!data.value.waits?.length && <section>
          <Heading as="h2" size="4">{tr("taskDetails.waitingResuming")}</Heading>
          {data.value.waits.map(wait => <div key={wait.id} className="result">
            <Text as="p" size="2">{{ requested: tr("taskDetails.savingQuestion"), open: tr("common.waitingAnswer"), answered: tr("taskDetails.answerSaved"), cancelled: tr("taskDetails.waitingStopped"), uncertain: tr("taskDetails.waitUnconfirmedReviewRequired") }[wait.state] ?? tr("taskDetails.statusNeedsReview")}</Text>
            <div className="detail-block">{wait.question}</div>
            {wait.state === 'open' && !('external' in wait && wait.external) && <Text as="p" size="2">{tr("taskDetails.replyQuestionOriginalFeishuThreadSendResume")} {wait.id}  {tr("taskDetails.answer")}</Text>}
          </div>)}
        </section>}
        {!!data.value.runners?.length && <section>
          <Heading as="h2" size="4">{tr("taskDetails.independentExecution")}</Heading>
          <Text as="p" size="2" color="gray">{tr("taskDetails.restartingReceiverNotRepeatTaskIfRunner")}</Text>
          {data.value.runners.map(runner => <Text as="p" size="2" key={runner.runId}>
            {{ starting: tr("taskDetails.waitingRunner"), running: tr("status.running"), completed: tr("taskDetails.resultSaved"), failed: tr("taskDetails.executionIncomplete"), lost: tr("taskDetails.contactLostReviewRequired"), reviewed: tr("taskDetails.reviewedSlotReleased") }[runner.state] ?? runner.state}
            {' · PID ' + (runner.pid ?? tr("taskDetails.notRegistered")) + tr("taskDetails.lastRecorded") + new Date(runner.updatedAt).toLocaleString(getLocale())}
          </Text>)}
        </section>}
        <TaskContextDetails task={data.value} />
        <Evidence reports={data.value.evidence} />
        <Heading as="h2" size="4">{tr("taskDetails.repliesDelivery")}</Heading>
        {data.value.results.map(result => <section className="result" key={result.part}>
          <StatusBadge state={result.state} /><div className="detail-block">{result.content}</div>
        </section>)}
        <details><summary>{tr("taskDetails.inputExecutionDeliveryRecords")}</summary><pre className="detail-block">{JSON.stringify({ messages: data.value.messages, runs: data.value.runs, runners: data.value.runners, delivery: data.value.delivery }, null, 2)}</pre></details>
        {['queued', 'running', 'waiting'].includes(data.value.execution) && <div className="actions">
          <ConfirmButton danger title={tr("taskDetails.confirmStopTask")} description={tr("taskDetails.stoppingCannotUndoCompletedActionsRequestSaved")} action={tr("taskDetails.confirmStop")}
            onConfirm={async () => { await api.cancel(data.value); await completed(tr("taskDetails.stopRequestSaved")); }}><Icon name="stop" />{tr("taskDetails.stopTask")}</ConfirmButton>
        </div>}
      </>}
      {data?.type === 'issue' && <>
        <div className="detail-summary"><StatusBadge state={data.value.state} /></div>
        <Notice>{data.value.guidance}</Notice>
        {data.value.content && <div className="detail-block">{data.value.content}</div>}
        {!!data.value.actions.length && <>
          <Field label={tr("taskDetails.reviewNotes")} htmlFor="recovery-note"><TextArea id="recovery-note" rows={3} maxLength={1000} value={note} onChange={event => setNote(event.target.value)} placeholder={tr("taskDetails.exampleResultVisibleFeishuGitWasChecked")} /></Field>
          <div className="actions">{data.value.actions.map(action => {
            const label = { received: tr("taskDetails.confirmReceived"), retry: tr("taskDetails.resendResult"), dismiss: tr("taskDetails.dismissDelivery"), reviewed: tr("taskDetails.markReviewed") }[action];
            return <ConfirmButton key={action} title={`${label}？`} disabled={!note.trim()}
              description={action === 'retry' ? tr("taskDetails.savedResultResentMayCreateDuplicateYou") : tr("taskDetails.recordReviewWithoutChangingExecutionOutcomeCalling")} action={label}
              onConfirm={async () => { await api.resolve(data.value, action, note); await completed(tr("taskDetails.reviewRecordedModelWasNotCalledAgain")); }}><Icon name={action === 'retry' ? 'refresh' : action === 'dismiss' ? 'close' : 'check'} />{label}</ConfirmButton>;
          })}</div>
          {!note.trim() && <Text as="p" size="1" color="gray">{tr("taskDetails.addReviewNotesChooseAction")}</Text>}
        </>}
        {!!data.value.history.length && <section className="audit"><Heading as="h3" size="3">{tr("taskDetails.reviewHistory")}</Heading>
          {data.value.history.map((entry, index) => <div key={index}><Text as="p" size="2">{entry.note}</Text><Text size="1" color="gray">{entry.action} · {new Date(entry.createdAt).toLocaleString(getLocale())}</Text></div>)}
        </section>}
      </>}
    </Dialog.Content>
  </Dialog.Root>;
}
