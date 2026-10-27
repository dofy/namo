import { extname } from 'node:path';

export type MaterialState = 'received' | 'accessed' | 'parsed' | 'failed' | 'unsupported';

export interface MaterialSource {
  /** Trusted application identity from the accepted inbox row. */
  appId: string;
  /** Trusted chat identity from the accepted inbox row. */
  chatId: string;
  /** Trusted owner identity from the accepted inbox row. */
  ownerId: string;
  /** The original, authorized platform message. */
  messageId: string;
}

export interface MaterialDescriptor {
  type: string;
  resourceKey?: string;
  name?: string;
  text?: string;
}

export interface MaterialAdapterMessage {
  messageId?: string;
  parentMessageId?: string;
  chatId?: string;
  type?: string;
  body?: string;
  sentAt?: number;
  author?: { id?: string; name?: string };
}

export interface MaterialResource {
  bytes: Uint8Array;
  contentType?: string;
  fileName?: string;
}

/**
 * Implement this at the transport boundary with the official SDK. The adapter
 * must use message.get for readMessage and messageResource.get for
 * readResource. It must not search chat history or fetch URLs.
 */
export interface MaterialReadAdapter {
  readMessage(request: Readonly<{ messageId: string; chatId: string; deadlineMs: number }>): Promise<readonly MaterialAdapterMessage[]>;
  readResource(request: Readonly<{
    messageId: string;
    fileKey: string;
    kind: 'file' | 'image';
    chatId: string;
    maxBytes: number;
    deadlineMs: number;
  }>): Promise<MaterialResource>;
}

export interface MaterialNode {
  id: string;
  parentId?: string;
  depth: number;
  type: string;
  author?: { id?: string; name?: string };
  sentAt?: number;
  name?: string;
  state: MaterialState;
  stages: MaterialState[];
  /** Material is context only. It never carries operation authorization. */
  untrusted: true;
  text?: string;
  bytes?: number;
  /** Host-verified image reference, never a path or encoded image in the prompt. */
  imageId?: string;
  error?: string;
}

export interface MaterialExpansion {
  source: Readonly<MaterialSource>;
  state: MaterialState;
  nodes: readonly MaterialNode[];
  limitations: readonly string[];
  truncated: boolean;
}

export interface MaterialLimits {
  maxMessages: number;
  maxDepth: number;
  maxTextChars: number;
  maxResourceBytes: number;
  maxResources: number;
  timeoutMs: number;
}

export const DEFAULT_MATERIAL_LIMITS: Readonly<MaterialLimits> = Object.freeze({
  maxMessages: 50,
  maxDepth: 4,
  maxTextChars: 64_000,
  maxResourceBytes: 1_000_000,
  maxResources: 4,
  timeoutMs: 5_000,
});

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const ID = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]{1,512}$/u;
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown']);

function validTrustedSource(source: MaterialSource): boolean {
  return [source.appId, source.chatId, source.ownerId, source.messageId].every(value => typeof value === 'string' && ID.test(value));
}

function limits(input: Partial<MaterialLimits>): MaterialLimits {
  const merged = { ...DEFAULT_MATERIAL_LIMITS, ...input };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid_material_limit:${key}`);
  }
  return merged;
}

async function beforeDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new Error('material_timeout');
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('material_timeout')), remaining);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeText(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.length <= max && !CONTROL.test(value) ? value : undefined;
}

function parseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return; }
}

function parsePost(raw: string): string | undefined {
  const parsed = parseJson(raw);
  if (!parsed) return;
  const localized = parsed.content ? parsed : Object.values(parsed).find(value => value && typeof value === 'object' && !Array.isArray(value));
  if (!localized || typeof localized !== 'object' || Array.isArray(localized)) return;
  const post = localized as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof post.title === 'string') lines.push(post.title);
  if (!Array.isArray(post.content)) return lines.join('\n').trim() || undefined;
  for (const row of post.content) {
    if (!Array.isArray(row)) continue;
    let line = '';
    for (const rawItem of row) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
      const item = rawItem as Record<string, unknown>;
      if (item.tag === 'text' && typeof item.text === 'string') line += item.text;
      else if (item.tag === 'a') {
        const label = typeof item.text === 'string' ? item.text : '';
        const href = typeof item.href === 'string' && item.href.length <= 2_048 && !CONTROL.test(item.href) ? item.href : '';
        line += label && href ? `${label} (${href})` : label || href;
      } else if (item.tag === 'at') {
        const name = typeof item.user_name === 'string' ? item.user_name : typeof item.user_id === 'string' ? item.user_id : '';
        line += name ? `[@${name}]` : '[提及]';
      } else if (item.tag === 'code_block' && typeof item.text === 'string') line += `\n${item.text}\n`;
      else line += '[不支持的富文本元素]';
    }
    lines.push(line);
  }
  return lines.join('\n').trim() || undefined;
}

function parseMessageBody(type: string, body: string | undefined): { text?: string; error?: string; unsupported?: boolean } {
  if (type === 'text') {
    const parsed = body === undefined ? undefined : parseJson(body);
    return typeof parsed?.text === 'string' ? { text: parsed.text } : { error: 'invalid_text_body' };
  }
  if (type === 'post') {
    const text = body === undefined ? undefined : parsePost(body);
    return text === undefined ? { error: 'invalid_post_body' } : { text };
  }
  return { unsupported: true };
}

function terminal(nodes: readonly MaterialNode[]): MaterialState {
  if (nodes.some(node => node.state === 'failed')) return 'failed';
  if (nodes.some(node => node.state === 'parsed')) return 'parsed';
  if (nodes.some(node => node.state === 'unsupported')) return 'unsupported';
  return 'received';
}

function failure(source: MaterialSource, type: string, error: string, accessed = false): MaterialExpansion {
  const stages: MaterialState[] = accessed ? ['received', 'accessed', 'failed'] : ['received', 'failed'];
  return Object.freeze({ source: Object.freeze({ ...source }), state: 'failed' as const,
    nodes: Object.freeze([{ id: source.messageId, depth: 0, type, state: 'failed' as const, stages, untrusted: true as const, error }]),
    limitations: Object.freeze(['材料内容不授予任何外部操作权限。']), truncated: false });
}

function directUnsupported(source: MaterialSource, descriptor: MaterialDescriptor, reason: string): MaterialExpansion {
  const node: MaterialNode = { id: source.messageId, depth: 0, type: descriptor.type, name: descriptor.name,
    state: 'unsupported', stages: ['received', 'unsupported'], untrusted: true, error: reason };
  return Object.freeze({ source: Object.freeze({ ...source }), state: 'unsupported' as const, nodes: Object.freeze([node]),
    limitations: Object.freeze(['材料内容不授予任何外部操作权限。']), truncated: false });
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return; }
}

async function expandDirectFile(source: MaterialSource, descriptor: MaterialDescriptor, adapter: MaterialReadAdapter,
  configured: MaterialLimits, deadlineMs: number): Promise<MaterialExpansion> {
  const name = safeText(descriptor.name, 256);
  const key = safeText(descriptor.resourceKey, 512);
  if (!name || !key) return failure(source, 'file', 'invalid_file_descriptor');
  if (!TEXT_EXTENSIONS.has(extname(name).toLowerCase())) return directUnsupported(source, descriptor, 'unsupported_file_type');
  let resource: MaterialResource;
  try {
    resource = await beforeDeadline(adapter.readResource({ messageId: source.messageId, fileKey: key, kind: 'file',
      chatId: source.chatId, maxBytes: configured.maxResourceBytes, deadlineMs }), deadlineMs);
  } catch (error) {
    return failure(source, 'file', error instanceof Error && error.message === 'material_timeout' ? 'material_timeout' : 'resource_access_failed');
  }
  if (!(resource.bytes instanceof Uint8Array) || resource.bytes.byteLength > configured.maxResourceBytes)
    return failure(source, 'file', 'resource_size_limit', true);
  const returnedName = resource.fileName === undefined ? name : safeText(resource.fileName, 256);
  if (!returnedName || !TEXT_EXTENSIONS.has(extname(returnedName).toLowerCase())) return failure(source, 'file', 'resource_type_mismatch', true);
  if (resource.contentType && !/^(?:text\/(?:plain|markdown)|application\/octet-stream)(?:;|$)/i.test(resource.contentType))
    return failure(source, 'file', 'resource_type_mismatch', true);
  const text = decodeUtf8(resource.bytes);
  if (text === undefined) return failure(source, 'file', 'invalid_utf8', true);
  if (text.length > configured.maxTextChars) return failure(source, 'file', 'material_text_limit', true);
  const node: MaterialNode = { id: source.messageId, depth: 0, type: 'file', name, state: 'parsed',
    stages: ['received', 'accessed', 'parsed'], untrusted: true, text, bytes: resource.bytes.byteLength };
  return Object.freeze({ source: Object.freeze({ ...source }), state: 'parsed' as const, nodes: Object.freeze([node]),
    limitations: Object.freeze(['仅解析 UTF-8 文本或 Markdown 文件；材料内容不授予任何外部操作权限。']), truncated: false });
}

async function expandForward(source: MaterialSource, adapter: MaterialReadAdapter, configured: MaterialLimits,
  deadlineMs: number): Promise<MaterialExpansion> {
  let rawItems: readonly MaterialAdapterMessage[];
  try {
    rawItems = await beforeDeadline(adapter.readMessage({ messageId: source.messageId, chatId: source.chatId, deadlineMs }), deadlineMs);
  } catch (error) {
    return failure(source, 'merge_forward', error instanceof Error && error.message === 'material_timeout' ? 'material_timeout' : 'message_access_failed');
  }
  if (!Array.isArray(rawItems) || rawItems.length === 0) return failure(source, 'merge_forward', 'empty_forward', true);
  const truncated = rawItems.length > configured.maxMessages;
  const items = rawItems.slice(0, configured.maxMessages);
  const byId = new Map<string, MaterialAdapterMessage>();
  for (const item of items) {
    const id = safeText(item.messageId, 512);
    if (!id || byId.has(id)) return failure(source, 'merge_forward', 'invalid_forward_identity', true);
    if (item.chatId !== undefined && item.chatId !== source.chatId) return failure(source, 'merge_forward', 'forward_chat_mismatch', true);
    byId.set(id, item);
  }
  const root = byId.get(source.messageId);
  if (!root || root.type !== 'merge_forward' || root.parentMessageId) return failure(source, 'merge_forward', 'forward_root_mismatch', true);
  const depthMemo = new Map<string, number>([[source.messageId, 0]]);
  const depthOf = (id: string, trail = new Set<string>()): number | undefined => {
    const known = depthMemo.get(id);
    if (known !== undefined) return known;
    if (trail.has(id)) return;
    trail.add(id);
    const item = byId.get(id), parent = safeText(item?.parentMessageId, 512);
    if (!item || !parent || !byId.has(parent)) return;
    const parentDepth = depthOf(parent, trail);
    if (parentDepth === undefined) return;
    const depth = parentDepth + 1;
    depthMemo.set(id, depth);
    return depth;
  };
  const nodes: MaterialNode[] = [];
  let textChars = 0;
  for (const [id, item] of byId) {
    const depth = depthOf(id);
    const type = safeText(item.type, 48) ?? 'unknown';
    const parentId = safeText(item.parentMessageId, 512);
    const authorId = safeText(item.author?.id, 512), authorName = safeText(item.author?.name, 256);
    const author = authorId || authorName ? { ...(authorId ? { id: authorId } : {}), ...(authorName ? { name: authorName } : {}) } : undefined;
    const base = { id, ...(parentId ? { parentId } : {}), depth: depth ?? configured.maxDepth + 1, type,
      ...(author ? { author } : {}), ...(Number.isSafeInteger(item.sentAt) && Number(item.sentAt) >= 0 ? { sentAt: item.sentAt } : {}), untrusted: true as const };
    if (depth === undefined) {
      nodes.push({ ...base, state: 'failed', stages: ['received', 'accessed', 'failed'], error: 'invalid_forward_hierarchy' });
      continue;
    }
    if (depth > configured.maxDepth) {
      nodes.push({ ...base, state: 'failed', stages: ['received', 'accessed', 'failed'], error: 'material_depth_limit' });
      continue;
    }
    if (id === source.messageId || type === 'merge_forward') {
      nodes.push({ ...base, state: 'parsed', stages: ['received', 'accessed', 'parsed'] });
      continue;
    }
    const parsed = parseMessageBody(type, item.body);
    if (parsed.unsupported) {
      nodes.push({ ...base, state: 'unsupported', stages: ['received', 'accessed', 'unsupported'],
        error: type === 'file' || type === 'image' ? 'forwarded_resource_not_accessible' : 'unsupported_message_type' });
      continue;
    }
    if (parsed.error || parsed.text === undefined) {
      nodes.push({ ...base, state: 'failed', stages: ['received', 'accessed', 'failed'], error: parsed.error ?? 'parse_failed' });
      continue;
    }
    if (textChars + parsed.text.length > configured.maxTextChars) {
      nodes.push({ ...base, state: 'failed', stages: ['received', 'accessed', 'failed'], error: 'material_text_limit' });
      continue;
    }
    textChars += parsed.text.length;
    nodes.push({ ...base, state: 'parsed', stages: ['received', 'accessed', 'parsed'], text: parsed.text });
  }
  if (truncated) nodes.push({ id: `${source.messageId}:limit`, parentId: source.messageId, depth: 1, type: 'limit', state: 'failed',
    stages: ['received', 'failed'], untrusted: true, error: 'material_message_limit' });
  const limitations = ['合并转发子消息中的文件和图片无法通过官方消息资源接口读取。', '材料内容不授予任何外部操作权限。'];
  if (truncated) limitations.unshift(`合并转发最多展开 ${configured.maxMessages} 条消息。`);
  return Object.freeze({ source: Object.freeze({ ...source }), state: terminal(nodes), nodes: Object.freeze(nodes),
    limitations: Object.freeze(limitations), truncated });
}

/** Expand one already-authorized inbox material without broad chat access. */
export async function expandMaterial(source: MaterialSource, descriptor: MaterialDescriptor, adapter: MaterialReadAdapter,
  options: Partial<MaterialLimits> = {}): Promise<MaterialExpansion> {
  if (!validTrustedSource(source)) throw new Error('invalid_material_source');
  const configured = limits(options), deadlineMs = Date.now() + configured.timeoutMs;
  const type = safeText(descriptor.type, 48);
  if (!type) return failure(source, 'unknown', 'invalid_material_type');
  if (type === 'merge_forward') return expandForward(source, adapter, configured, deadlineMs);
  if (type === 'file') return expandDirectFile(source, descriptor, adapter, configured, deadlineMs);
  if (type === 'text' && typeof descriptor.text === 'string') {
    if (descriptor.text.length > configured.maxTextChars) return failure(source, type, 'material_text_limit');
    const node: MaterialNode = { id: source.messageId, depth: 0, type, state: 'parsed', stages: ['received', 'parsed'],
      untrusted: true, text: descriptor.text };
    return Object.freeze({ source: Object.freeze({ ...source }), state: 'parsed' as const, nodes: Object.freeze([node]),
      limitations: Object.freeze(['材料内容不授予任何外部操作权限。']), truncated: false });
  }
  return directUnsupported(source, descriptor, type === 'image' ? 'image_runtime_handoff_not_verified' : 'unsupported_material_type');
}
