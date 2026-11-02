import type { Config } from './config.js';
import type { Incoming } from './store.js';
import { admitted } from './access.js';
export function memoryDirectories(config: Pick<Config, 'feishu'> & { codex?: Config['codex'] }, message: Incoming, cwd?: string): string[] | undefined {
  if(!admitted(config.feishu,message.senderId,message.chatId,message.envelope?.tenantKey))return [];
  return config.codex ? [...(config.codex.directories??[]),...(cwd?[cwd]:[])] : undefined;
}
