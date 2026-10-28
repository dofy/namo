import type { Store } from './store.js';
import type { Task } from './tasks.js';
import { evidenceSummary, readEvidence } from './evidence.js';
import type { RunEvidence } from './ui-contract.js';
import { Waits, linkedExternalWait } from './waits.js';
import { progressState } from './task-progress.js';

export const taskStateLabel = (state: string): string => ({ queued: '排队中', running: '正在处理', succeeded: '已完成',
  waiting: '等待你补充', failed: '未完成', cancelled: '已停止', interrupted: '执行中断，需核对', needs_attention: '需要核对补充要求' }[state] ?? '状态待核对');

export function hasExecution(e: RunEvidence): boolean { return e.items.length > 0 || e.git.status === 'changed'; }

/** Only useful outcomes belong in the everyday reply; raw records remain in details. */
export function evidenceBrief(e: RunEvidence): string {
  if (!hasExecution(e)) return '';
  const lines: string[] = [];
  const files = new Set(e.items.filter(i => i.kind === 'files' && i.status === 'completed').flatMap(i => (i.files ?? []).map(f => f.path)));
  const checks = e.items.filter(i => i.kind === 'command' && i.status === 'completed' && i.exitCode === 0
    && /^(?:pnpm|npm) (?:test|build|lint|typecheck|check|smoke:codex)$|^node --test$/.test(i.label));
  const failed = e.items.filter(i => ['failed','declined'].includes(i.status) || (i.kind === 'command' && i.exitCode !== undefined && i.exitCode !== 0));
  const unknown = e.items.filter(i => ['unknown','running'].includes(i.status));
  if (files.size) lines.push(`已记录 ${files.size} 个文件的补丁。`);
  if (checks.length) lines.push(`检查命令：${checks.length} 项正常退出。`);
  if (failed.length) lines.push(`有 ${failed.length} 项操作失败或被拒绝，请查看详情。`);
  if (unknown.length) lines.push(`有 ${unknown.length} 项操作结果待核对。`);
  if (e.git.status === 'changed') lines.push('检测到提交变化，归属尚未核对。');
  if (e.state === 'partial') lines.push('执行未完整结束，需核对结果。');
  else if (e.truncated) lines.push('操作记录达到保存上限，部分记录未保存。');
  else if (e.items.some(i => i.limited)) lines.push('部分工具内容未纳入执行记录；这不表示任务中断。');
  return '\n\n' + (lines.join('\n') || '执行记录已保存。');
}

export function taskStatus(store: Store, task: Task): string {
  const job = store.db.prepare(`SELECT j.state,j.error FROM runner_jobs j JOIN task_runs r ON r.id=j.runId
    WHERE r.taskId=? ORDER BY r.startedAt DESC LIMIT 1`).get(task.id);
  let state = taskStateLabel(task.state);
  if (task.state === 'running' && job?.state === 'completed') state = '执行已结束，正在整理回复';
  if (task.state === 'running' && job?.state === 'failed') state = job.error === 'cancelled' ? '已停止，正在整理回复' : '执行未完成，正在整理回复';
  if (job?.state === 'lost') state = '执行状态待核对';
  const literal=(text:string)=>text.replace(/[\\`*_{}\[\]()#~!>|+-]/g,'\\$&');
  const lines = [`**${state}**`];
  if (task.state === 'waiting') {
    const waiting = new Waits(store).current(task.id);
    if (waiting) lines.push(literal(waiting.question), linkedExternalWait(store,waiting.id)?'外部检查由系统核对，条件满足后继续；不能用人工回复代替检查结果。':`恢复：\`/resume ${waiting.id} 你的回答\``, `停止：\`/cancel ${task.id}\``);
  }
  if (task.project) lines.push(`项目：${task.project}`);
  if (store.get(task.inboxKey)?.cancelRequested && ['queued','running'].includes(task.state) && !['completed','failed','lost','reviewed'].includes(String(job?.state)))
    lines.push('停止请求已保存，正在等待执行结束。');
  if (task.startedAt && task.finishedAt) lines.push(`用时：${Math.max(0, Math.round((task.finishedAt - task.startedAt) / 1000))} 秒`);
  const outputs = store.db.prepare("SELECT state FROM outbox WHERE inboxKey=? AND kind='result' ORDER BY part").all(task.inboxKey);
  const states = outputs.map(o => String(o.state));
  lines.push(!states.length ? '回复：尚未生成' : states.includes('unknown') ? '回复：发送结果不明，请先核对聊天记录'
    : states.includes('failed') ? '回复：发送失败，需要核对' : states.includes('dismissed') ? '回复：部分内容已放弃发送'
    : states.every(s => s === 'confirmed') ? '回复：已人工确认收到'
    : states.every(s => ['sent','confirmed'].includes(s)) ? '回复：平台已接受，未确认是否已读' : '回复：正在等待发送');
  if (job?.state === 'lost') lines.push('执行进程失联，没有重跑任务。请在本机工作台核对进程和已发生的操作。');
  else if (task.state === 'cancelled') lines.push('停止不会撤销已经发生的操作。');
  else if (['failed','interrupted'].includes(task.state)) lines.push('请核对已发生的操作；系统没有自动重跑任务。');
  const revisions = store.db.prepare("SELECT COUNT(*) n FROM task_messages WHERE taskId=? AND role='revision' AND dispatch NOT IN ('accepted','applied')").get(task.id);
  if (Number(revisions?.n)) lines.push(`有 ${revisions!.n} 条补充要求尚未确认应用，请核对最终结果。`);
  const report = readEvidence(store, task.id).at(-1);
  if (report) { const evidence = evidenceSummary(report).trim(); if (evidence) lines.push('', literal(evidence)); }
  if (!['queued','running','waiting'].includes(task.state)) lines.push('',progressState(store,task).content);
  lines.push('', `任务编号：${task.id}`);
  if (['queued','running'].includes(task.state) && (!job || ['starting','running'].includes(String(job.state))))
    lines.push(`补充：\`/amend ${task.id} 新要求\``, `停止：\`/cancel ${task.id}\``);
  return lines.join('\n');
}
