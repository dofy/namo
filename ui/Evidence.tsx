import { Badge, Heading, Text } from '@radix-ui/themes';
import type { EvidenceItem, RunEvidence } from '../src/ui-contract';
import { Notice } from './components';

const labels = { running: '执行中', completed: '已结束', failed: '失败', declined: '被拒绝', unknown: '结果未知' };
const actions = { add: '新增', update: '修改', delete: '删除' };
function Outcome({ item }: { item: EvidenceItem }) {
  const failed = item.status === 'failed' || (item.exitCode !== undefined && item.exitCode !== 0);
  return <Badge color={failed ? 'red' : item.status === 'completed' ? 'blue' : 'gray'}>
    {labels[item.status]}{item.exitCode !== undefined ? ' · 退出码 ' + item.exitCode : ''}
  </Badge>;
}

export function Evidence({ reports = [] }: { reports?: RunEvidence[] }) {
  return <section className="evidence" aria-label="执行证据">
    <Heading as="h2" size="4">执行证据</Heading>
    <Text as="p" size="2" color="gray">记录来自执行事件。退出码只表示命令如何结束，文件存在也不代表内容正确；脚本和其他工具的全部改动尚未覆盖。</Text>
    {!reports.length && <Notice>这次任务没有采集记录。历史任务不会补造证据，不能据此认定没有执行或修改。</Notice>}
    {reports.map((report, index) => {
      const commands = report.items.filter(i => i.kind === 'command');
      const patches = report.items.filter(i => i.kind === 'files');
      const artifacts = report.items.filter(i => i.kind === 'artifact');
      const created = patches.flatMap(i => i.status === 'completed' ? (i.files ?? []).filter(f => f.action === 'add').map(f => ({
        path: f.movedTo ?? f.path, exists: f.existsAtFinish,
      })) : []);
      return <div className="evidence-run" key={report.runId}>
        <div className="detail-summary"><Text size="2" weight="medium">运行 {index + 1}</Text>
          <Badge color={report.state === 'partial' ? 'orange' : 'gray'}>{report.state === 'collecting' ? '正在记录' : report.state === 'partial' ? '部分记录' : '记录已结束'}</Badge>
        </div>
        {report.state === 'partial' && <Notice>执行未完整结束。没有完成回执的操作标记为结果未知，已发生的操作不会自动撤销。</Notice>}
        {(report.truncated || report.items.some(i => i.limited)) && <Notice>部分事件或路径未保存：可能涉及采集上限、敏感或项目外路径，或尚不支持的工具。</Notice>}
        <Heading as="h3" size="3">文件变更</Heading>
        {!patches.length && <Text as="p" size="2" color="gray">未记录到文件补丁；命令和其他工具也可能修改文件。</Text>}
        {patches.map(item => <div className="evidence-entry" key={item.id}>
          <Outcome item={item} />
          {(item.files ?? []).map((file, n) => <Text as="p" size="2" key={n}>{actions[file.action]} · <code>{file.path}</code>{file.movedTo && <> → <code>{file.movedTo}</code></>}</Text>)}
          {!item.files?.length && <Text as="p" size="2" color="gray">此补丁的路径未展示。</Text>}
        </div>)}
        <Heading as="h3" size="3">命令执行</Heading>
        {!commands.length && <Text as="p" size="2" color="gray">未记录到命令，验证情况未知。</Text>}
        {commands.map(item => <div className="evidence-entry" key={item.id}>
          <div className="evidence-command"><code>{item.label}</code><Outcome item={item} /></div>
          <Text as="p" size="1" color="gray">目录：{item.cwd ?? '未展示'}{item.durationMs !== undefined && ' · ' + item.durationMs + ' ms'}{item.exitCode === undefined && ' · 无退出码'}</Text>
        </div>)}
        <Heading as="h3" size="3">产物与提交线索</Heading>
        {!created.length && !artifacts.length && <Text as="p" size="2" color="gray">未记录到新增文件或图片产物。</Text>}
        {created.map((file, n) => <Text as="p" size="2" key={n}><code>{file.path}</code> · {file.exists === undefined ? '尚未检查' : file.exists ? '结束时文件存在，内容未验证' : '结束时未确认文件存在'}</Text>)}
        {artifacts.map(item => <div className="evidence-entry" key={item.id}><Outcome item={item} /><Text as="p" size="2">
          {item.path ?? '产物路径未展示'} · {item.existsAtFinish === undefined ? '尚未确认文件存在' : item.existsAtFinish ? '结束时文件存在，内容未验证' : '结束时未确认文件存在'}
        </Text></div>)}
        <Text as="p" size="2" color="gray">{report.git.status === 'changed'
          ? 'HEAD ' + report.git.before?.slice(0, 12) + ' → ' + report.git.after?.slice(0, 12) + '。仅证明期间 HEAD 变化，未核实提交归属或推送状态。'
          : report.git.status === 'unchanged' ? '结束时 HEAD 与开始时相同；不代表工作区没有改动。'
          : report.git.after ? '结束时 HEAD ' + report.git.after.slice(0, 12) + '；缺少可比较的基线，未核实提交归属。' : '没有可比较的项目根目录 Git HEAD。'}</Text>
        {report.items.some(i => i.kind === 'tool') && <Text as="p" size="2" color="gray">发生过其他工具调用，其内容和外部效果未采集。</Text>}
      </div>;
    })}
  </section>;
}
