import { Button, Heading, Table, Text } from '@radix-ui/themes';
import type { ManagementState } from '../../src/ui-contract';
import { Notice, StatusBadge, statusLabel } from '../components';

export type DetailTarget = { type: 'task' | 'issue'; id: string };
export function TasksPage({ state, onOpen }: { state: ManagementState; onOpen: (target: DetailTarget) => void }) {
  const { database: db } = state;
  return <>
    {!state.recoveryAvailable && <Notice>当前接收服务使用旧版数据结构。可以查看任务与编辑配置；异常处理需在维护窗口升级后启用。</Notice>}
    {!!db.issues.length && <section className="issues" aria-labelledby="issues-heading">
      <Heading as="h2" size="4" id="issues-heading">需要你核对</Heading>
      <div className="issue-list">{db.issues.map(issue => <div className="issue-row" key={issue.subject}>
        <div><Text weight="medium">{issue.subject}</Text><Text as="p" size="2" color="gray">{statusLabel(issue.state)}</Text></div>
        <Button variant="soft" onClick={() => onOpen({ type: 'issue', id: issue.subject })}>核对</Button>
      </div>)}</div>
    </section>}
    <div className="section-title"><Heading as="h2" size="4">最近的任务</Heading><Text size="2" color="gray">{db.tasks.length} 项</Text></div>
    <Table.Root variant="surface" className="task-table">
      <Table.Header><Table.Row>
        <Table.ColumnHeaderCell>任务</Table.ColumnHeaderCell><Table.ColumnHeaderCell>项目</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell>执行状态</Table.ColumnHeaderCell><Table.ColumnHeaderCell>耗时</Table.ColumnHeaderCell><Table.ColumnHeaderCell><span className="sr-only">操作</span></Table.ColumnHeaderCell>
      </Table.Row></Table.Header>
      <Table.Body>{db.tasks.map(task => <Table.Row key={task.id}>
        <Table.RowHeaderCell>{task.id}</Table.RowHeaderCell><Table.Cell>{task.project || '隔离目录'}</Table.Cell>
        <Table.Cell><StatusBadge state={task.state} /></Table.Cell>
        <Table.Cell>{task.startedAt && task.finishedAt ? `${Math.round((task.finishedAt - task.startedAt) / 1000)} 秒` : '—'}</Table.Cell>
        <Table.Cell><Button size="1" variant="soft" color="gray" onClick={() => onOpen({ type: 'task', id: task.id })}>查看<span className="sr-only"> {task.id}</span></Button></Table.Cell>
      </Table.Row>)}</Table.Body>
    </Table.Root>
    {!db.tasks.length && <Text as="p" className="empty" color="gray">还没有任务。在飞书私聊中发送一个明确要求，进展会出现在这里。</Text>}
    <section className="workstreams">
      <Heading as="h2" size="4">工作线</Heading>
      <Text as="p" size="2" color="gray">持续的上下文，可以从飞书用 /session 编号续接。</Text>
      <div className="stream-list">{db.workstreams.map(stream => <div className="stream" key={stream.id}>
        <Text size="2">{stream.id}</Text><Text as="p" size="1" color="gray">{stream.project || '隔离目录'}</Text>
      </div>)}</div>
      {!db.workstreams.length && <Text as="p" size="2" color="gray">首次任务会建立工作线。</Text>}
    </section>
  </>;
}
