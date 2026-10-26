import * as lark from '@larksuiteoapi/node-sdk';
import type { Config } from './config.js';
import type { Incoming } from './store.js';
import { SendError, type Sender, type DeliveryRoute } from './engine.js';
import type { Material } from './messages.js';
import type { CardEvent } from './cards.js';
import { plainMessage } from './richtext.js';
import type { MaterialReadAdapter } from './materials.js';
import type { PreparedArtifact } from './artifacts.js';

export interface FeishuEvent {
  sender?: { sender_type?: string; sender_id?: { open_id?: string } };
  message?: {
    message_id?: string; chat_id?: string; chat_type?: string; message_type?: string;
    thread_id?: string; parent_id?: string; root_id?: string; create_time?: string;
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
  const materials: Material[] = [];
  const limitations: string[] = [];
  let content: any;
  try { content = JSON.parse(m.content ?? '{}'); } catch { content = {}; }
  if (!content || typeof content !== 'object' || Array.isArray(content)) content = {};
  if (m.message_type === 'text') text = typeof content.text === 'string' ? content.text : '';
  else if (m.message_type === 'post') {
    const post = content.content ? content : content.zh_cn ?? content.en_us ?? Object.values(content)[0];
    if (post && typeof post === 'object') {
      text = [post.title, ...(Array.isArray(post.content) ? post.content : []).filter(Array.isArray).map((row: any[]) => row.map(item => {
        if (!item || typeof item !== 'object') return '';
        if (item.tag === 'text') return item.text ?? '';
        if (item.tag === 'a') return `${item.text ?? ''} (${item.href ?? ''})`;
        if (item.tag === 'at') return `[提及 ${item.user_name ?? item.user_id ?? ''}]`;
        materials.push({ type: String(item.tag ?? 'unknown').slice(0, 48), resourceKey: typeof item.image_key === 'string' ? item.image_key.slice(0, 512) : undefined,
          limitation: '仅保存资源描述，尚未读取内容' });
        return '[此富文本元素暂不支持读取]';
      }).join(''))].filter(Boolean).join('\n');
    }
  } else {
    materials.push({ type: m.message_type ?? 'unknown', resourceKey: typeof content.file_key === 'string' ? content.file_key.slice(0, 512)
      : typeof content.image_key === 'string' ? content.image_key.slice(0, 512) : undefined,
      name: typeof content.file_name === 'string' ? content.file_name.slice(0, 256) : undefined,
      limitation: '当前仅保存资源描述，未下载、解析或展开转发内容' });
    limitations.push('此消息的实际内容尚未读取，不能据占位符推断内容');
    text = '';
  }
  for (const mention of mentioned) text = text.split(mention.key).join('');
  text = text.trim();
  if (!text && !materials.length) text = '/help';
  if (text.length > 16_000) text = '/too-long';
  const chatKey = `${config.appId}:${m.chat_id}`;
  const scopeKey = m.thread_id ? `${chatKey}:thread:${m.thread_id}` : chatKey;
  return { key: `${config.appId}:${m.message_id}`, messageId: m.message_id,
    chatKey, chatId: m.chat_id, senderId, text,
    envelope: { version: 1, type: m.message_type ?? 'unknown', kind: !text && materials.length ? 'material' : 'instruction', scopeKey,
      chatType: m.chat_type === 'p2p' ? 'p2p' : m.chat_type === 'group' ? 'group' : undefined,
      threadId: m.thread_id, parentId: m.parent_id, rootId: m.root_id,
      sentAt: m.create_time && /^\d+$/.test(m.create_time) ? Number(m.create_time) : undefined,
      materials: materials.slice(0, 30), limitations } };
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
  async connect(accept: (message: Incoming) => void, cardAction?: (event: CardEvent) => unknown): Promise<void> {
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
      ...(this.config.cards&&cardAction?{'card.action.trigger': async (event: CardEvent) => {
        if(!event.operator?.open_id||!this.config.allowedUserIds.includes(event.operator.open_id)||
          (this.config.allowedChatIds.length&&!this.config.allowedChatIds.includes(event.context?.open_chat_id??''))) return {toast:{type:'error',content:'无权操作这项任务'}};
        try {return cardAction(event);} catch {this.log('card_persistence_failed');throw new Error('durable_card_accept_failed');}
      }}:{}),
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
  async send(chatId: string, content: string, uuid: string, route?: DeliveryRoute): Promise<string> {
    return this.createMessage(chatId,'text',JSON.stringify({text:plainMessage(content)}),uuid,route);
  }
  async sendCard(chatId: string, card: object, uuid: string, route?: DeliveryRoute): Promise<string> {
    return this.createMessage(chatId,'interactive',JSON.stringify(card),uuid,route);
  }
  async sendPost(chatId: string, post: object, uuid: string, route?: DeliveryRoute): Promise<string> {
    return this.createMessage(chatId,'post',JSON.stringify(post),uuid,route);
  }
  async react(messageId: string): Promise<string> {
    let response;
    try { response = await this.client.im.messageReaction.create({path:{message_id:messageId},data:{reaction_type:{emoji_type:'OK'}}}); }
    catch { throw new SendError(true, 'reaction_transport_unknown'); }
    if(response.code!==0)throw new SendError(false,`feishu_${response.code}`);
    if(!response.data?.reaction_id)throw new SendError(true,'reaction_missing_receipt');
    return response.data.reaction_id;
  }
  async unreact(messageId: string, reactionId: string): Promise<void> {
    let response;
    try { response=await this.client.im.messageReaction.delete({path:{message_id:messageId,reaction_id:reactionId}}); }
    catch {throw new SendError(true,'reaction_delete_unknown');}
    if(response.code!==0)throw new SendError(false,`feishu_${response.code}`);
  }
  async updateCard(messageId: string, card: object): Promise<void> {
    let response;
    try {response=await this.client.im.message.patch({path:{message_id:messageId},data:{content:JSON.stringify(card)}});}
    catch {throw new SendError(true,'card_update_unknown');}
    if(response.code!==0)throw new SendError(false,`feishu_${response.code}`);
  }
  async readCard(messageId: string): Promise<string> {
    let response;
    try {response=await this.client.im.message.get({path:{message_id:messageId}});}
    catch {throw new SendError(true,'card_read_unknown');}
    if(response.code!==0)throw new SendError(false,`feishu_${response.code}`);
    return response.data?.items?.[0]?.body?.content??'';
  }
  readonly materials: MaterialReadAdapter = {
    readMessage: async request => {
      const result = await this.client.im.message.get({path:{message_id:request.messageId}});
      if(result.code!==0)throw new Error('material_access_failed');
      const items=result.data?.items??[];
      if(items.some(item=>item.chat_id && item.chat_id!==request.chatId))throw new Error('material_chat_mismatch');
      return items.map(item=>({messageId:item.message_id,parentMessageId:item.upper_message_id,chatId:item.chat_id,type:item.msg_type,body:item.body?.content,
        sentAt:item.create_time?Number(item.create_time):undefined,author:{id:item.sender?.id}}));
    },
    readResource: async request => {
      const result=await this.client.im.messageResource.get({path:{message_id:request.messageId,file_key:request.fileKey},params:{type:'file'}});
      const stream=result.getReadableStream(); const chunks:Buffer[]=[];let size=0;
      const timer=setTimeout(()=>stream.destroy(new Error('material_timeout')),Math.max(1,request.deadlineMs-Date.now()));
      try {for await(const chunk of stream){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>request.maxBytes)throw new Error('material_bytes_limit');chunks.push(bytes);}return {bytes:Buffer.concat(chunks)};}
      finally {clearTimeout(timer);stream.destroy();}
    },
  };
  async uploadArtifact(artifact: PreparedArtifact): Promise<string> {
    // Upload exactly the validated frozen bytes; never reopen the user's path.
    try {const result=await this.client.im.file.create({data:{file_type:artifact.platformFileType,file_name:artifact.name,file:artifact.readPayload()}});
      if(!result?.file_key)throw new SendError(true,'artifact_upload_missing_receipt');return result.file_key;
    }catch(e){if(e instanceof SendError)throw e;throw new SendError(true,'artifact_upload_unknown');}
  }
  async sendArtifact(chatId:string,fileKey:string,uuid:string,route:DeliveryRoute):Promise<string>{
    return this.createMessage(chatId,'file',JSON.stringify({file_key:fileKey}),uuid,route);
  }
  private async createMessage(chatId:string,type:string,content:string,uuid:string,route?:DeliveryRoute):Promise<string> {
    let response: Awaited<ReturnType<typeof this.client.im.message.create>>;
    try {
      response = route ? await this.client.im.message.reply({path:{message_id:route.messageId},data:{msg_type:type,content,uuid,reply_in_thread:route.thread}}) : await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: type, content, uuid },
      });
    } catch { throw new SendError(true, 'feishu_transport_unknown'); }
    if (response.code !== 0) throw new SendError(false, `feishu_${response.code ?? 'rejected'}`);
    if (!response.data?.message_id) throw new SendError(true, 'feishu_missing_receipt');
    return response.data.message_id;
  }
  close(): void { this.ws?.close({ force: true }); }
}
