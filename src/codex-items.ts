import { EXTERNAL_WAIT_TOOL } from './external-waits.js';
type Obj = Record<string, any>;

export function isWaitToolItem(item: Obj): boolean {
  return item?.type === 'dynamicToolCall' && item.namespace === null
    && (item.tool === 'wait_for_user' || item.tool === EXTERNAL_WAIT_TOOL.name);
}

export function isEffectfulItem(item: Obj): boolean {
  if (isWaitToolItem(item)) return false;
  return ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall',
    'subAgentActivity', 'webSearch', 'sleep', 'imageGeneration'].includes(item?.type);
}

export function itemSettled(item: Obj): boolean {
  return ['completed', 'failed', 'declined', 'interrupted'].includes(item?.status);
}
