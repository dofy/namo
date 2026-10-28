/** Render the push approval receipt for people while retaining its durable JSON record. */
export function formatControlDisplay(command: string, content: string): string {
  if (!/^\/push-(?:request|approve|reject|status)(?:\s|$)/i.test(command.trim())) return content;
  let data: Record<string, unknown>;
  try { data=JSON.parse(content); } catch { return content; }
  if (!data || typeof data !== 'object' || typeof data.id !== 'string' || !/^AP-[A-F0-9]{12}$/.test(data.id)
    || typeof data.state !== 'string' || typeof data.taskId !== 'string' || typeof data.ref !== 'string'
    || typeof data.headSha !== 'string' || typeof data.remote !== 'string') return content;
  const literal=(value:unknown)=>String(value ?? '无').replace(/[\\`*_{}\[\]()#~!>|+-]/g,'\\$&');
  const statuses:Record<string,string>={pending:'等待确认',approved:'已确认',executing:'执行中',succeeded:'已完成',rejected:'已拒绝',expired:'已过期',invalidated:'已失效',failed:'失败',unknown:'结果待核对'};
  const expiry=typeof data.expiresAt==='number' && Number.isFinite(data.expiresAt) ? new Date(data.expiresAt) : undefined;
  const lines=[`**受控推送 · ${statuses[data.state] ?? literal(data.state)}**`,
    `审批编号：\`${data.id}\`\n任务：\`${literal(data.taskId)}\`\n项目：${literal(data.project ?? '隔离目录')}`,
    `**推送目标**\n远程：${literal(data.remote)}\n分支：${literal(data.ref)}\n提交：${literal(data.headSha)}\n远端原提交：${literal(data.remoteBeforeSha)}`,
    ...(typeof data.commitSummary==='string'?[`提交说明：${literal(data.commitSummary)}`]:[]),
    ...(expiry && !Number.isNaN(expiry.getTime())?[`有效期至：${expiry.toISOString()}（UTC）`]:[]),
    ...(typeof data.reason==='string'?[`原因：${literal(data.reason)}`]:[]),
    ...(data.state==='pending'?[`确认并执行：\`/push-approve ${data.id} --confirm\`\n拒绝：\`/push-reject ${data.id}\``]:[]),
    `查看状态：\`/push-status ${data.id}\``,
    '此审批仅约束受控推送入口，不代表其他联网或凭据路径已被隔离。'];
  return lines.join('\n\n');
}
