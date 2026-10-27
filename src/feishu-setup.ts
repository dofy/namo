import { t as tr } from './locale.js';
import * as lark from '@larksuiteoapi/node-sdk';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import type { FeishuEvent } from './feishu.js';
import { SendError } from './engine.js';

export const FEISHU_GUIDE = {
  console: 'https://open.feishu.cn/app',
  larkConsole: 'https://open.larksuite.com/app',
  websocket: 'https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-',
  scopes: ['im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly', 'im:message:send_as_bot', 'im:message.reactions:write_only', 'im:message.reactions:read', 'im:message:readonly', 'im:resource'],
  event: 'im.message.receive_v1',
};
export interface Candidate { senderId: string; chatId: string; messageId: string; }
export function privateText(event: FeishuEvent): (Candidate & { text: string }) | undefined {
  const m = event.message, senderId = event.sender?.sender_id?.open_id;
  if (event.sender?.sender_type !== 'user' || !senderId || m?.chat_type !== 'p2p' || m.message_type !== 'text' || !m.message_id || !m.chat_id) return;
  try {
    const text = JSON.parse(m.content ?? '{}').text;
    if (typeof text === 'string') return { senderId, chatId: m.chat_id, messageId: m.message_id, text: text.trim() };
  } catch { /* An invalid event is not a pairing request. */ }
}
export class PairingChallenge {
  readonly code: string;
  readonly expiresAt: number;
  private used = false;
  constructor(private now: () => number = Date.now, ttl = 600_000) {
    this.code = `NAMO-${randomBytes(8).toString('hex').toUpperCase()}`;
    this.expiresAt = now() + ttl;
  }
  accept(event: FeishuEvent): Candidate | undefined {
    if (this.used || this.now() >= this.expiresAt) return;
    const m = privateText(event);
    if (!m || Buffer.byteLength(m.text) !== Buffer.byteLength(this.code)) return;
    if (!timingSafeEqual(Buffer.from(m.text), Buffer.from(this.code))) return;
    this.used = true;
    return { senderId: m.senderId, chatId: m.chatId, messageId: m.messageId };
  }
}
export interface SetupConnection {
  credentials(): Promise<boolean>;
  connect(accept: (event: FeishuEvent) => void): Promise<void>;
  identity(): Promise<{ id: string; name: string }>;
  send(chatId: string, text: string, uuid: string): Promise<string>;
  close(): void;
}
export class FeishuSetupConnection implements SetupConnection {
  private client: lark.Client;
  private ws?: lark.WSClient;
  constructor(private config: Config['feishu']) {
    const silent = () => {};
    lark.defaultHttpInstance.defaults.timeout = 15_000;
    this.client = new lark.Client({ appId: config.appId, appSecret: config.appSecret,
      domain: config.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      logger: { error: silent, warn: silent, info: silent, debug: silent, trace: silent } });
  }
  async credentials(): Promise<boolean> {
    try {
      const r = await this.client.auth.tenantAccessToken.internal({ data: { app_id: this.config.appId, app_secret: this.config.appSecret } });
      return r.code === 0 && !!((r as any).tenant_access_token ?? r.data?.tenant_access_token);
    } catch { return false; }
  }
  async identity(): Promise<{ id: string; name: string }> {
    let r: any;
    try { r = await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }); }
    catch { throw new Error(tr("feishuSetup.couldNotReadBotIdentityCheckBot")); }
    const bot = r.bot ?? r.data?.bot;
    if (r.code !== 0 || !bot?.open_id) throw new Error(tr("feishuSetup.noBotIdentityReturnedEnableBotCapabilities"));
    return { id: bot.open_id, name: String(bot.app_name ?? bot.bot_name ?? tr("feishuSetup.bot")) };
  }
  async connect(accept: (event: FeishuEvent) => void): Promise<void> {
    const silent = () => {};
    const logger = { error: silent, warn: silent, info: silent, debug: silent, trace: silent };
    this.ws = new lark.WSClient({ appId: this.config.appId, appSecret: this.config.appSecret,
      domain: this.config.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      handshakeTimeoutMs: 15_000, logger });
    const dispatcher = new lark.EventDispatcher({ logger }).register({ 'im.message.receive_v1': async e => { accept(e); } });
    await this.ws.start({ eventDispatcher: dispatcher });
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      const state = this.ws.getConnectionStatus().state;
      if (state === 'connected') return;
      if (state === 'failed') break;
      await new Promise(r => setTimeout(r, 100));
    }
    this.close(); throw new Error(tr("feishuSetup.feishuConnectionNotReadyCheckNetworkApp"));
  }
  async send(chatId: string, text: string, uuid: string = randomUUID()): Promise<string> {
    let r: any;
    try { r = await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }), uuid } }); }
    catch { throw new SendError(true, 'feishu_transport_unknown'); }
    if (r.code !== 0) throw new SendError(false, `feishu_${r.code ?? 'rejected'}`);
    if (!r.data?.message_id) throw new SendError(true, 'feishu_missing_receipt');
    return r.data.message_id;
  }
  close(): void { this.ws?.close({ force: true }); }
}
