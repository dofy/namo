import { agentLabel, type AgentProfile } from './agent-registry.js';
import { readAgentModel } from './agent-models.js';
import type { CatalogModel } from './model-catalog.js';

const modelId = (value: string) => '`' + value + '`';

export function formatTaskModel(model: string | null | undefined, taskId?: string): string {
  const label = taskId ? `任务 ${taskId} 的模型` : '本次任务模型';
  return `**${label}**  ${model ? modelId(model) : '暂未记录'}`;
}

export function formatModelStatus(agent: AgentProfile, inherited?: string): string {
  const configured = readAgentModel(agent);
  const runtime = agent.adapter === 'claude' ? 'Claude Code' : 'Codex';
  return [
    `**当前 Agent**  ${agentLabel(agent)}`,
    `**新任务模型**  ${configured ? modelId(configured) : inherited ? modelId(inherited) + '（运行时默认）' : `跟随 ${runtime} 运行时默认`}`,
  ].join('\n');
}

export function formatModelReply(agent: AgentProfile, recent: string | undefined, models: readonly CatalogModel[], canEdit: boolean): string {
  const configured = readAgentModel(agent);
  const fallback = models.find(model => model.isDefault)?.id;
  const lines = [formatModelStatus(agent, fallback), `**最近任务模型**  ${recent ? modelId(recent) : '暂无记录'}`];
  if (canEdit) {
    lines.push('\n`/model 模型ID` 设置此 Agent 的共享模型，`/model default` 恢复运行时默认。');
    if (models.length) lines.push('\n**可选模型**', ...models.map(model =>
      `- ${modelId(model.id)}${model.id === (configured ?? fallback) ? ' · 当前' : ''}`));
  }
  return lines.join('\n');
}
