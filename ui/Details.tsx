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
      <div className="dialog-title"><Dialog.Title>{data?.type === 'task' ? data.value.title || target?.id : `${target?.type === 'issue' ? tr("核对 ") : ''}${target?.id ?? ''}`}</Dialog.Title><Dialog.Close><Button variant="soft" color="gray" aria-label={tr("关闭详情")}><Icon name="close" />{tr("关闭")}</Button></Dialog.Close></div>
      <Dialog.Description size="2" color="gray">{target?.type === 'issue' ? tr("核对执行与消息投递，不会重新执行任务。") : tr("查看执行结果、输入版本和投递记录。")}</Dialog.Description>
      {error && <Notice error>{error}</Notice>}
      {!data && !error && <div className="loading"><Spinner />  {tr("读取详情")}</div>}
      {data?.type === 'task' && <>
        <div className="detail-summary"><StatusBadge state={data.value.execution} /><Text size="2">{data.value.project || tr("隔离目录")}  {tr("· 输入版本")} {data.value.inputVersion}</Text></div>
        <Text as="p" size="2" color="gray">{data.value.ownerName || data.value.ownerId || tr("未命名用户")} · {data.value.id}</Text>
        <div className="detail-times"><div><span>{tr("创建时间")}</span><DateTime value={data.value.createdAt} empty={tr("未记录")} /></div><div><span>{tr("首次开始")}</span><DateTime value={data.value.startedAt} /></div><div><span>{tr("结束时间")}</span><DateTime value={data.value.finishedAt} empty={tr("尚未结束")} /></div></div>
        <Text as="p" size="2" color="gray">{tr("会话")} {data.value.workstream}</Text>
        {data.value.error && <Notice error>{tr("原因：")}{data.value.error}</Notice>}
        {!!data.value.waits?.length && <section>
          <Heading as="h2" size="4">{tr("等待与恢复")}</Heading>
          {data.value.waits.map(wait => <div key={wait.id} className="result">
            <Text as="p" size="2">{{ requested: tr("正在保存等待"), open: tr("等待你的回答"), answered: tr("回答已保存"), cancelled: tr("已停止等待"), uncertain: tr("等待未确认，需核对") }[wait.state] ?? tr("状态待核对")}</Text>
            <div className="detail-block">{wait.question}</div>
            {wait.state === 'open' && !('external' in wait && wait.external) && <Text as="p" size="2">{tr("请在原飞书话题引用问题回复，或发送 /resume")} {wait.id}  {tr("你的回答。")}</Text>}
          </div>)}
        </section>}
        {!!data.value.runners?.length && <section>
          <Heading as="h2" size="4">{tr("独立执行")}</Heading>
          <Text as="p" size="2" color="gray">{tr("接收服务重启不重跑原任务；失联时保留占位，需在本机核对进程和外部操作。")}</Text>
          {data.value.runners.map(runner => <Text as="p" size="2" key={runner.runId}>
            {{ starting: tr("等待执行进程"), running: tr("执行中"), completed: tr("结果已保存"), failed: tr("执行未完成"), lost: tr("失联，等待核对"), reviewed: tr("已核对并解除占位") }[runner.state] ?? runner.state}
            {' · PID ' + (runner.pid ?? tr("尚未登记")) + tr(" · 最后记录 ") + new Date(runner.updatedAt).toLocaleString(getLocale())}
          </Text>)}
        </section>}
        <TaskContextDetails task={data.value} />
        <Evidence reports={data.value.evidence} />
        <Heading as="h2" size="4">{tr("答复与投递")}</Heading>
        {data.value.results.map(result => <section className="result" key={result.part}>
          <StatusBadge state={result.state} /><div className="detail-block">{result.content}</div>
        </section>)}
        <details><summary>{tr("输入、运行与投递记录")}</summary><pre className="detail-block">{JSON.stringify({ messages: data.value.messages, runs: data.value.runs, runners: data.value.runners, delivery: data.value.delivery }, null, 2)}</pre></details>
        {['queued', 'running', 'waiting'].includes(data.value.execution) && <div className="actions">
          <ConfirmButton danger title={tr("停止这项任务？")} description={tr("停止不会撤销已发生的操作。请求会先保存，再通知执行器停止。")} action={tr("确认停止")}
            onConfirm={async () => { await api.cancel(data.value); await completed(tr("停止请求已保存。")); }}><Icon name="stop" />{tr("停止这项任务")}</ConfirmButton>
        </div>}
      </>}
      {data?.type === 'issue' && <>
        <div className="detail-summary"><StatusBadge state={data.value.state} /></div>
        <Notice>{data.value.guidance}</Notice>
        {data.value.content && <div className="detail-block">{data.value.content}</div>}
        {!!data.value.actions.length && <>
          <Field label={tr("核对依据")} htmlFor="recovery-note"><TextArea id="recovery-note" rows={3} maxLength={1000} value={note} onChange={event => setNote(event.target.value)} placeholder={tr("例如：已在飞书看到结果；或已检查 Git，确认没有新增提交。")} /></Field>
          <div className="actions">{data.value.actions.map(action => {
            const label = { received: tr("确认已收到"), retry: tr("重发这段结果"), dismiss: tr("放弃发送"), reviewed: tr("标记已核对") }[action];
            return <ConfirmButton key={action} title={`${label}？`} disabled={!note.trim()}
              description={action === 'retry' ? tr("只重发已保存的这段结果，可能重复发送。确认已核对并仍要重发？") : tr("记录本次核对，保留原执行结论，不会重新调用模型。")} action={label}
              onConfirm={async () => { await api.resolve(data.value, action, note); await completed(tr("核对已记录，没有重新调用模型。")); }}><Icon name={action === 'retry' ? 'refresh' : action === 'dismiss' ? 'close' : 'check'} />{label}</ConfirmButton>;
          })}</div>
          {!note.trim() && <Text as="p" size="1" color="gray">{tr("填写核对依据后即可选择处理方式。")}</Text>}
        </>}
        {!!data.value.history.length && <section className="audit"><Heading as="h3" size="3">{tr("核对历史")}</Heading>
          {data.value.history.map((entry, index) => <div key={index}><Text as="p" size="2">{entry.note}</Text><Text size="1" color="gray">{entry.action} · {new Date(entry.createdAt).toLocaleString(getLocale())}</Text></div>)}
        </section>}
      </>}
    </Dialog.Content>
  </Dialog.Root>;
}
