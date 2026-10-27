import type { Config } from './config.js';
import type { Inbox, Store } from './store.js';
import { Tasks, type Task } from './tasks.js';
import { AssistantSettings, composeAssistantPrompt } from './assistant.js';
import { Memories, composeMemoryPrompt } from './memory.js';
import { memoryProjects } from './memory-access.js';
import { admitted } from './access.js';
import { makeRedactor } from './safety.js';

const DATE_TIME_TASK = /(?:日期|时间|时区|今天|明天|昨天|后天|星期|周[一二三四五六日天]|几点|日程|截止|到期)|\b(?:date|time|timezone|today|tomorrow|yesterday|calendar|schedule|deadline|expiry|expiration)\b/iu;

/** Conservative classifier: English terms use word boundaries, so "runtime" is not a date/time task. */
export function isDateTimeTask(text: string): boolean {
  return DATE_TIME_TASK.test(text);
}

/**
 * Builds one fresh run's immutable prompt context. Call exactly once after the
 * task run ID exists and before persisting the runner prompt. Existing runner
 * jobs must reuse their saved prompt instead of calling this helper again.
 */
export function buildTaskRunPrompt(store: Store, task: Task, inbox: Inbox, config: Pick<Config, 'feishu'> & { codex?: Config['codex'] }, runId: string): string {
  const tasks = new Tasks(store), base = tasks.prompt(task), continuing = !!tasks.thread(task);
  const paired = new Set(config.feishu.allowedUserIds);
  if (config.feishu.access && admitted(config.feishu,inbox.senderId,inbox.chatId,inbox.envelope?.tenantKey)) paired.add(inbox.senderId);
  const identity = { channel: config.feishu.domain, appId: config.feishu.appId, userId: inbox.senderId };
  const assistant = new AssistantSettings(store, candidate => candidate.channel === config.feishu.domain
    && candidate.appId === config.feishu.appId && paired.has(candidate.userId));
  let prompt = composeAssistantPrompt(base, assistant.adopt(runId, {
    message: inbox, identity, dateTimeRelevant: isDateTimeTask(inbox.text),
  }), continuing);

  // No memory rows means an upgraded installation keeps its prior prompt and
  // does not manufacture an empty memory audit record.
  if (!store.db.prepare("SELECT 1 FROM settings WHERE key LIKE 'memory:meta:%' LIMIT 1").get()) return prompt;
  const memories = new Memories(store, makeRedactor([config.feishu.appSecret]));
  const snapshot = memories.snapshot(runId, {
    kind: 'verified-user', authenticated: paired.has(inbox.senderId), ownerId: inbox.senderId,
    allowedProjects: memoryProjects(config, inbox), chatKey: inbox.chatKey, chatType: inbox.envelope?.chatType, project: task.project ?? null,
  }, { relevantText: inbox.text });
  prompt = composeMemoryPrompt(prompt, snapshot);
  return prompt;
}
