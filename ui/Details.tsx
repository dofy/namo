import { useEffect, useState } from 'react';
import { Button, Dialog, Heading, Spinner, Text, TextArea } from '@radix-ui/themes';
import type { Issue, TaskDetail } from '../src/ui-contract';
import { api, message } from './api';
import { ConfirmButton, Field, Notice, StatusBadge } from './components';
import type { DetailTarget } from './pages/TasksPage';

export function Details({ target, close, changed, notify, restoreFocus }: {
  target: DetailTarget | null; close: () => void; changed: () => Promise<unknown>;
  notify: (text: string) => void; restoreFocus: () => void;
}) {
  const [data, setData] = useState<{ type: 'task'; value: TaskDetail } | { type: 'issue'; value: Issue }>();
  const [error, setError] = useState(''), [note, setNote] = useState('');
  useEffect(() => {
    setData(undefined); setError(''); setNote('');
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
  }, [target]);
  const completed = async (text: string) => { close(); notify(text); await changed(); };
  return <Dialog.Root open={!!target} onOpenChange={open => { if (!open) close(); }}>
    <Dialog.Content maxWidth="760px" onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}>
      <div className="dialog-title"><Dialog.Title>{target?.type === 'issue' ? '核对 ' : ''}{target?.id}</Dialog.Title><Dialog.Close><Button variant="soft" color="gray" aria-label="关闭详情">关闭</Button></Dialog.Close></div>
      <Dialog.Description size="2" color="gray">{target?.type === 'issue' ? '核对执行与消息投递，不会重新执行任务。' : '查看执行结果、输入版本和投递记录。'}</Dialog.Description>
      {error && <Notice error>{error}</Notice>}
      {!data && !error && <div className="loading"><Spinner /> 读取详情</div>}
      {data?.type === 'task' && <>
        <div className="detail-summary"><StatusBadge state={data.value.execution} /><Text size="2">{data.value.project || '隔离目录'} · 输入版本 {data.value.inputVersion}</Text></div>
        <Text as="p" size="2" color="gray">工作线 {data.value.workstream}</Text>
        {data.value.error && <Notice error>原因：{data.value.error}</Notice>}
        {data.value.results.map(result => <section className="result" key={result.part}>
          <StatusBadge state={result.state} /><div className="detail-block">{result.content}</div>
        </section>)}
        <details><summary>输入、运行与投递记录</summary><pre className="detail-block">{JSON.stringify({ messages: data.value.messages, runs: data.value.runs, delivery: data.value.delivery }, null, 2)}</pre></details>
        {['queued', 'running'].includes(data.value.execution) && <div className="actions">
          <ConfirmButton danger title="停止这项任务？" description="停止不会撤销已发生的操作。请求会先保存，再通知执行器停止。" action="确认停止"
            onConfirm={async () => { await api.cancel(data.value); await completed('停止请求已保存。'); }}>停止这项任务</ConfirmButton>
        </div>}
      </>}
      {data?.type === 'issue' && <>
        <div className="detail-summary"><StatusBadge state={data.value.state} /></div>
        <Notice>{data.value.guidance}</Notice>
        {data.value.content && <div className="detail-block">{data.value.content}</div>}
        {!!data.value.actions.length && <>
          <Field label="核对依据" htmlFor="recovery-note"><TextArea id="recovery-note" rows={3} maxLength={1000} value={note} onChange={event => setNote(event.target.value)} placeholder="例如：已在飞书看到结果；或已检查 Git，确认没有新增提交。" /></Field>
          <div className="actions">{data.value.actions.map(action => {
            const label = { received: '确认已收到', retry: '重发这段结果', dismiss: '放弃发送', reviewed: '标记已核对' }[action];
            return <ConfirmButton key={action} title={`${label}？`} disabled={!note.trim()}
              description={action === 'retry' ? '只重发已保存的这段结果，可能重复发送。确认已核对并仍要重发？' : '记录本次核对，保留原执行结论，不会重新调用模型。'} action={label}
              onConfirm={async () => { await api.resolve(data.value, action, note); await completed('核对已记录，没有重新调用模型。'); }}>{label}</ConfirmButton>;
          })}</div>
          {!note.trim() && <Text as="p" size="1" color="gray">填写核对依据后即可选择处理方式。</Text>}
        </>}
        {!!data.value.history.length && <section className="audit"><Heading as="h3" size="3">核对历史</Heading>
          {data.value.history.map((entry, index) => <div key={index}><Text as="p" size="2">{entry.note}</Text><Text size="1" color="gray">{entry.action} · {new Date(entry.createdAt).toLocaleString()}</Text></div>)}
        </section>}
      </>}
    </Dialog.Content>
  </Dialog.Root>;
}
