import { mkdirSync, realpathSync } from 'node:fs';
import type { Config } from './config.js';
import { chatWorkspace } from './safety.js';
import { Store, type Incoming, type Inbox } from './store.js';
import { RuntimeError, type Runtime } from './runtime.js';

export interface Sender { send(chatId: string, content: string, uuid: string): Promise<string>; }
export class SendError extends Error {
  constructor(readonly unknown: boolean, readonly code: string) { super(code); }
}
type Log = (event: string, fields?: Record<string, unknown>) => void;

export class Engine {
  private active = new Map<string, { key: string; abort: AbortController; promise: Promise<void> }>();
  private outputBusy = false;
  private stopped = false;
  private started = false;
  private interval?: NodeJS.Timeout;
  private pumping = false;
  private nextSendAt = 0;
  constructor(readonly store: Store, private runtime: Runtime, private sender: Sender,
    private config: Pick<Config, 'dataDir' | 'concurrency'> & { codex?: Config['codex'] },
    private redact: (s: string) => string = s => s,
    private log: Log = () => {},
    private onFatal: (code: string) => void = () => {}) {}

  private fatal(code: string): void {
    this.stopped = true; clearInterval(this.interval);
    this.log(code); this.onFatal(code);
  }

  accept(m: Incoming): boolean {
    const fresh = this.store.enqueue({ ...m, text: this.redact(m.text) });
    if (!fresh) return false;
    if (!this.handleControl(m)) this.store.addOutput(m.key, 'progress', '已收到。可用 /status 查看状态，/cancel 取消本会话的请求。');
    void this.pump();
    return true;
  }
  private handleControl(m: Incoming): boolean {
    const command = m.text.trim().split(/\s/)[0];
    if (['/status', '/whoami', '/cancel', '/reset', '/help', '/project', '/unsupported', '/too-long'].includes(command)) {
      if (!this.store.claim(m.key)) return true;
      let reply: string;
      if (command === '/whoami') reply = `用户 open_id：${m.senderId}\n会话 chat_id：${m.chatId}`;
      else if (command === '/status') reply = JSON.stringify({ queue: this.store.status(m.chatKey), workspace: this.workspaceLabel(m.chatKey), sandbox: this.config.codex?.sandbox, network: this.config.codex?.networkAccess,
        localCommits: this.config.codex?.allowLocalCommits ?? false, pushAndDeploy: '需单独确认目标和内容' }, null, 2);
      else if (command === '/project') {
        const name = m.text.trim().split(/\s+/)[1];
        const projects = this.config.codex?.projects ?? {};
        if (!name) reply = `当前目录：${this.workspaceLabel(m.chatKey)}\n可选项目：\n${Object.entries(projects).map(([n, p]) => `${n} → ${p}`).join('\n') || '尚未配置'}\n切换：/project 项目名（开始新上下文）`;
        else if (!Object.hasOwn(projects, name)) reply = '未配置该项目。用 /project 查看可选项目；新增目录需修改本地配置。';
        else if (this.store.hasPending(m.chatKey, m.key)) reply = '本会话仍有未完成的请求，暂不能切换项目。请等待完成，或 /cancel 后再切换。';
        else { this.store.setProject(m.chatKey, name); reply = `已切换到 ${name}：${projects[name]}。下一条消息开始新的 Codex 上下文。`; }
      }
      else if (command === '/unsupported') reply = '当前版本只支持文字和富文本。图片、文件、语音等内容尚未接入，请先发文字说明。';
      else if (command === '/too-long') reply = '这条消息超过 16000 字符，尚未交给模型。请拆成较短的消息。';
      else if (command === '/help') reply = '支持文字对话与富文本；/project 查看或切换已配置项目，/status 查看状态和权限，/whoami 查看身份，/cancel 取消本会话正在执行和排队的请求，/reset 开始新上下文。当前不支持文件解析、定时提醒或后台派工。';
      else if (command === '/reset') {
        if (this.active.has(m.chatKey)) reply = '本会话仍在执行。请先 /cancel，等执行停止后再 /reset。';
        else { this.store.clearThread(m.chatKey); reply = '已重置会话上下文。下一条消息将开始新的 Codex 会话。'; }
      } else {
        const rows = this.store.cancel(m.chatKey, m.key);
        this.active.get(m.chatKey)?.abort.abort();
        reply = rows.length ? `已请求停止 ${rows.length} 条请求。已发生的外部操作不会自动撤销。` : '当前没有待取消的请求。';
      }
      this.store.finish(m.key, reply);
      return true;
    }
    return false;
  }
  private workspace(chatKey: string): string {
    const c = this.config.codex;
    const name = this.store.project(chatKey) ?? c?.defaultProject;
    if (name) {
      if (!c?.projects || !Object.hasOwn(c.projects, name)) throw new RuntimeError('project_unavailable');
      try { if (realpathSync(c.projects[name]) !== c.projects[name]) throw new Error(); }
      catch { throw new RuntimeError('project_unavailable'); }
      return c.projects[name];
    }
    return chatWorkspace(this.config.dataDir, chatKey);
  }
  private workspaceLabel(chatKey: string): string {
    try { return this.workspace(chatKey); }
    catch (e) { if (e instanceof RuntimeError) return '当前项目已从配置移除，请用 /project 选择其他项目'; throw e; }
  }
  start(): void {
    this.log('recovered', this.store.recover());
    this.started = true;
    this.interval = setInterval(() => void this.pump(), 250);
    void this.pump();
  }
  async pump(): Promise<void> {
    if (!this.started || this.stopped || this.pumping) return;
    this.pumping = true;
    try {
      while (this.active.size < this.config.concurrency) {
        const next = this.store.next([...this.active.keys()]);
        if (!next) break;
        // A crash after enqueue but before command handling must not turn a
        // recovered /cancel or /reset into an ordinary model prompt.
        if (this.handleControl(next)) continue;
        if (!this.store.claim(next.key)) break;
        const abort = new AbortController();
        // Register the slot before run() starts, including synchronous failures.
        const promise = Promise.resolve().then(() => this.execute(next, abort.signal))
          .catch(() => this.fatal('execution_storage_error'))
          .finally(() => { this.active.delete(next.chatKey); void this.pump(); });
        this.active.set(next.chatKey, { key: next.key, abort, promise });
      }
      if (!this.outputBusy) {
        this.outputBusy = true;
        void this.flush().catch(() => this.fatal('outbox_storage_error')).finally(() => { this.outputBusy = false; });
      }
    } catch { this.fatal('queue_storage_error'); }
    finally { this.pumping = false; }
  }
  private async execute(m: Inbox, signal: AbortSignal): Promise<void> {
    this.log('turn_started', { messageId: m.messageId });
    try {
      const cwd = this.workspace(m.chatKey);
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      this.store.bindWorkspace(m.chatKey, cwd);
      const result = await this.runtime.run({
        threadId: this.store.thread(m.chatKey), cwd, signal,
        prompt: `以下元数据由接入服务提供：${JSON.stringify({ message_id: m.messageId, sender_open_id: m.senderId, chat_id: m.chatId })}\n\n<user_message>\n${m.text}\n</user_message>`,
        onThread: threadId => { this.store.saveThread(m.chatKey, threadId); this.store.saveRun(m.key, threadId); },
        onTurn: turnId => { const threadId = this.store.thread(m.chatKey); if (threadId) this.store.saveRun(m.key, threadId, turnId); },
      });
      if (signal.aborted) throw new RuntimeError('cancelled');
      this.store.finish(m.key, this.redact(result.text));
      this.log('turn_completed', { messageId: m.messageId });
    } catch (e) {
      const code = signal.aborted ? 'cancelled' : e instanceof RuntimeError ? e.code : 'runtime_error';
      const text = code === 'cancelled' ? '这条请求已停止。已发生的操作不会自动撤销。'
        : code === 'turn_timeout' ? '这条请求超时，执行器已停止。执行结果未确认，没有自动重跑。'
        : `这条请求未完成（${code}）。请检查本地 Codex 登录与服务状态；为避免重复操作，没有自动重跑。`;
      this.store.finish(m.key, text, code);
      this.log('turn_failed', { messageId: m.messageId, code });
    }
  }
  private async flush(): Promise<void> {
    while (!this.stopped) {
      if (this.nextSendAt > Date.now()) await new Promise(r => setTimeout(r, this.nextSendAt - Date.now()));
      if (this.stopped) return;
      const output = this.store.nextOutput();
      if (!output || !this.store.sending(output.id)) return;
      this.nextSendAt = Date.now() + 300;
      let platformId: string;
      try { platformId = await this.sender.send(output.chatId, output.content, output.uuid); }
      catch (e) {
        const error = e instanceof SendError ? e : new SendError(true, 'transport_error');
        this.store.deliveryFailed(output.id, error.unknown, error.code);
        this.log('delivery_issue', { outboxId: output.id, state: error.unknown ? 'unknown' : 'failed', code: error.code });
        continue;
      }
      // A database error after platform acceptance must stay `sending`, never
      // become a retryable send. Startup reconciliation will mark it unknown.
      this.store.sent(output.id, platformId);
      this.log('reply_sent', { outboxId: output.id, platformId });
    }
  }
  async stop(): Promise<void> {
    this.stopped = true; clearInterval(this.interval);
    const tasks = [...this.active.values()];
    for (const task of tasks) task.abort.abort();
    await Promise.allSettled(tasks.map(t => t.promise));
    while (this.outputBusy) await new Promise(r => setTimeout(r, 20));
  }
}
