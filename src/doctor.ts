import { t as tr } from './locale.js';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { probeAgent, liveAgentTest, type Check } from './agents.js';
import { FeishuSetupConnection } from './feishu-setup.js';
import { serviceStatus } from './service.js';

export async function doctor(file: string, live = false): Promise<Check[]> {
  const checks: Check[] = [{ id: 'node', status: 'ok', message: `Node ${process.version}` }];
  if (!existsSync(file)) return [...checks, { id: 'config', status: 'fail', message: tr("尚无配置：{0}", file), next: tr("运行 namo init；也可使用 --config 指定已有配置") }];
  let c;
  try { c = loadConfig(file); }
  catch { return [...checks, { id: 'config', status: 'fail', message: tr("配置无效、无法读取或项目路径不存在"), next: tr("运行 namo init 修正设置；不会输出配置正文或覆盖原数据") }]; }
  checks.push({ id: 'config', status: 'ok', message: tr("配置：{0}", c.file) });
  checks.push(...await probeAgent(c));
  const connection = new FeishuSetupConnection(c.feishu);
  try {
    const valid = !!c.feishu.appId && !!c.feishu.appSecret && await connection.credentials();
    checks.push({ id: 'feishu.credentials', status: valid ? 'ok' : 'fail', message: valid ? tr("飞书应用凭据可用") : tr("飞书凭据或网络验证失败"), next: valid ? undefined : tr("运行 namo init 检查应用凭据和平台；无需把 Secret 发到聊天里") });
    if (valid) {
      try { await connection.identity(); checks.push({ id: 'feishu.bot', status: 'ok', message: tr("可读取机器人身份") }); }
      catch { checks.push({ id: 'feishu.bot', status: 'fail', message: tr("无法读取机器人身份"), next: tr("检查机器人能力、应用发布、可用范围与管理员审批") }); }
    }
  } finally { connection.close(); }
  checks.push({ id: 'feishu.pairing', status: c.feishu.allowedUserIds.length ? 'ok' : 'fail', message: c.feishu.allowedUserIds.length ? tr("已有 {0} 位授权用户", c.feishu.allowedUserIds.length) : tr("尚未配对用户，任何消息都不会执行"), next: c.feishu.allowedUserIds.length ? undefined : tr("运行 namo init 完成一次性配对与本地确认") });
  checks.push({id:'feishu.optional-features',status:'warn',message:tr('表情、消息读取、文件上传和卡片更新需在飞书后台核对权限；诊断不会制造测试消息。'),next:'im:message.reactions:write_only / im:message.reactions:read / im:message:readonly / im:resource / im:message:send_as_bot'});
  const status = serviceStatus(c);
  checks.push({ id: 'service', status: status.ready ? 'ok' : 'warn', message: status.ready ? tr("后台实例已报告连接就绪") : status.running ? tr("后台进程存在，但当前连接就绪状态尚未确认") : tr("后台服务未运行"), next: status.ready ? undefined : tr("运行 namo service status 和 namo logs；前台模式使用 namo start") });
  if (live) {
    if (checks.some(c => c.id.startsWith('agent.') && c.status === 'fail')) checks.push({ id: 'agent.inference', status: 'fail', message: tr("Agent 基础检查失败，未调用模型") });
    else {
      try { checks.push({ id: 'agent.inference', status: await liveAgentTest(c) ? 'ok' : 'fail', message: tr("真实 Agent 响应标记测试") }); }
      catch { checks.push({ id: 'agent.inference', status: 'fail', message: tr("真实 Agent 调用失败，请检查账号额度、模型可用性和网络") }); }
    }
  } else checks.push({ id: 'agent.inference', status: 'warn', message: tr("未调用模型，不消耗推理额度"), next: tr("显式运行 namo doctor --live 可测试推理；完整飞书收发使用 namo init") });
  return checks;
}
