import * as lark from '@larksuiteoapi/node-sdk';
import type { Config } from './config.js';
import type { Incoming } from './store.js';
import { SendError, type Sender } from './engine.js';

export interface FeishuEvent {
  sender?: { sender_type?: string; sender_id?: { open_id?: string } };
  message?: {
    message_id?: string; chat_id?: string; chat_type?: string; message_type?: string;
    content?: string; mentions?: { key: string; id?: { open_id?: string } }[];
  };
}

export function normalizeEvent(event: FeishuEvent, config: Config['feishu'], botId: string): Incoming | undefined {
  const m = event.message;
  const senderId = event.sender?.sender_id?.open_id;
  if (event.sender?.sender_type !== 'user' || !senderId || !m?.message_id || !m.chat_id) return;
  if (!config.allowedUserIds.includes(senderId)) return;
  if (config.allowedChatIds.length && !config.allowedChatIds.includes(m.chat_id)) return;
  const mentioned = m.mentions?.filter(x => x.id?.open_id === botId) ?? [];
  if (m.chat_type !== 'p2p' && config.requireMention && !mentioned.length) return;
  let text = '';
  let content: any;
  try { content = JSON.parse(m.content ?? '{}'); } catch { content = {}; }
  if (m.message_type === 'text') text = typeof content.text === 'string' ? content.text : '';
  else if (m.message_type === 'post') {
    const post = content.content ? content : content.zh_cn ?? content.en_us ?? Object.values(content)[0];
    if (post && typeof post === 'object') {
      text = [post.title, ...(post.content ?? []).map((row: any[]) => row.map(item => {
        if (item.tag === 'text') return item.text ?? '';
        if (item.tag === 'a') return `${item.text ?? ''} (${item.href ?? ''})`;
        if (item.tag === 'at') return `[提及 ${item.user_name ?? item.user_id ?? ''}]`;
        return '[此富文本元素暂不支持读取]';
      }).join(''))].filter(Boolean).join('\n');
    }
  } else text = '/unsupported';
  for (const mention of mentioned) text = text.split(mention.key).join('');
  text = text.trim();
  if (!text) text = '/help';
  if (text.length > 16_000) text = '/too-long';
  return { key: `${config.appId}:${m.message_id}`, messageId: m.message_id,
    chatKey: `${config.appId}:${m.chat_id}`, chatId: m.chat_id, senderId, text };
}

export class FeishuTransport implements Sender {
  private client: lark.Client;
  private ws?: lark.WSClient;
  constructor(private config: Config['feishu'], private log: (event: string, fields?: Record<string, unknown>) => void) {
    // All requests, including token acquisition, have a bounded transport wait.
    lark.defaultHttpInstance.defaults.timeout = 15_000;
    const silent = () => {};
    const logger = { error: silent, warn: silent, info: silent, debug: silent, trace: silent };
    this.client = new lark.Client({ appId: config.appId, appSecret: config.appSecret,
      domain: config.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu, logger });
  }
  async connect(accept: (message: Incoming) => void): Promise<void> {
    let identity: any;
    try { identity = await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }); }
    catch { throw new Error('飞书身份查询失败：请检查 App ID、Secret、网络和机器人能力'); }
    const botId = identity?.bot?.open_id ?? identity?.data?.bot?.open_id;
    if (identity?.code !== 0 || !botId) throw new Error('无法取得飞书 bot 身份，拒绝在身份不明时接收消息');
    const silent = () => {};
    this.ws = new lark.WSClient({ appId: this.config.appId, appSecret: this.config.appSecret,
      domain: this.config.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      handshakeTimeoutMs: 15_000,
      logger: { error: silent, warn: silent, info: silent, debug: silent, trace: silent },
      onReady: () => this.log('feishu_connected'),
      onReconnecting: () => this.log('feishu_reconnecting'),
      onReconnected: () => this.log('feishu_reconnected'),
      onError: () => this.log('feishu_connection_failed'),
    });
    const dispatcher = new lark.EventDispatcher({ logger: { error: silent, warn: silent, info: silent, debug: silent, trace: silent } }).register({
      'im.message.receive_v1': async event => {
        const message = normalizeEvent(event, this.config, botId);
        if (message) {
          // This callback returns only after the synchronous SQLite commit.
          // Throwing makes the SDK ACK with failure so Feishu can redeliver.
          try { accept(message); }
          catch { this.log('inbound_persistence_failed'); throw new Error('durable_accept_failed'); }
        }
      },
    });
    await this.ws.start({ eventDispatcher: dispatcher });
    // The SDK/server can delay its first retry by up to 30 seconds. Allow that
    // retry, but bound both an individual handshake and startup readiness.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const state = this.ws.getConnectionStatus().state;
      if (state === 'connected') return;
      if (state === 'failed') break;
      await new Promise(r => setTimeout(r, 100));
    }
    const status = this.ws.getConnectionStatus();
    this.log('feishu_startup_timeout', { state: status.state, reconnectAttempts: status.reconnectAttempts });
    this.close();
    throw new Error('飞书长连接未就绪，请检查平台已启用长连接接收事件和应用已发布');
  }
  async send(chatId: string, content: string, uuid: string): Promise<string> {
    let response: Awaited<ReturnType<typeof this.client.im.message.create>>;
    try {
      response = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: content }), uuid },
      });
    } catch { throw new SendError(true, 'feishu_transport_unknown'); }
    if (response.code !== 0) throw new SendError(false, `feishu_${response.code ?? 'rejected'}`);
    if (!response.data?.message_id) throw new SendError(true, 'feishu_missing_receipt');
    return response.data.message_id;
  }
  close(): void { this.ws?.close({ force: true }); }
}
