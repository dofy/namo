import type { Config } from './config.js';
import type { Incoming } from './store.js';
import { admitted, projectAllowed } from './access.js';

/** Undefined preserves paired-owner installs; an empty list grants no organization resources. */
export function memoryProjects(config: Pick<Config, 'feishu'> & { codex?: Config['codex'] }, message: Incoming): string[] | undefined {
  if (!config.feishu.access) return undefined;
  if (!config.codex || !admitted(config.feishu, message.senderId, message.chatId, message.envelope?.tenantKey)) return [];
  return Object.keys(config.codex.projects ?? {}).filter(name => projectAllowed(config.codex!, config.feishu, message, name));
}
