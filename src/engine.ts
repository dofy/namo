import { mkdirSync, realpathSync } from 'node:fs';
import { relative, isAbsolute, sep } from 'node:path';
import type { Config } from './config.js';
import { chatWorkspace } from './safety.js';
import { Store, type Incoming, type Inbox } from './store.js';
import { RuntimeError, type Runtime, type RunControls } from './runtime.js';
import { Tasks, TaskInputError, policyHash, scopeOf, sessionKey, type Task, type ProjectBinding } from './tasks.js';

export interface Sender { send(chatId: string, content: string, uuid: string): Promise<string>; }
export class SendError extends Error {
  constructor(readonly unknown: boolean, readonly code: string) { super(code); }
}
type Log = (event: string, fields?: Record<string, unknown>) => void;
export function pathsOverlap(a: string, b: string): boolean {
  const contains = (x: string, y: string) => { const r = relative(x, y); return !r || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };
  return contains(a, b) || contains(b, a);
}
interface Active { key: string; task: Task; run: string; cwd: string; abort: AbortController; promise: Promise<void>; controls?: RunControls; steering?: Promise<void>; }

export class Engine {
  private active = new Map<string, Active>();
  private tasks: Tasks;
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
    private onFatal: (code: string) => void = () => {}) { this.tasks = new Tasks(store); }

  private fatal(code: string): void {
    this.stopped = true; clearInterval(this.interval);
    this.log(code); this.onFatal(code);
  }

  accept(m: Incoming): boolean {
    // All routing and receipts are durable in the same acceptance transaction.
    const fresh = this.store.transaction(() => {
      const safe: Incoming = JSON.parse(this.redact(JSON.stringify(m)));
      if (/^\/material(?:\s|$)/.test(safe.text)) safe.envelope = { ...safe.envelope, version: 1, type: safe.envelope?.type ?? 'text',
        kind: 'material', scopeKey: scopeOf(safe), materials: safe.envelope?.materials ?? [], limitations: safe.envelope?.limitations ?? [] };
      if (!this.store.enqueue(safe)) return false;
      if (!this.handleControl(safe)) this.route(this.store.get(safe.key)!);
      return true;
    });
    if (!fresh) return false;
    for (const active of this.active.values()) if (this.store.get(active.key)?.cancelRequested) active.abort.abort();
    const slot = this.active.get(m.chatKey);
    if (slot) void this.steer(slot).catch(() => this.fatal('revision_storage_error'));
    void this.pump();
    return true;
  }
  private handleControl(m: Incoming): boolean {
    if (m.envelope?.kind === 'material') return false;
    const command = m.text.trim().split(/\s/)[0];
    if (['/status', '/whoami', '/cancel', '/reset', '/new', '/session', '/tasks', '/task', '/help', '/project', '/unsupported', '/too-long'].includes(command)) {
      if (!this.store.claim(m.key)) return true;
      let reply: string;
      if (command === '/whoami') reply = `用户 open_id：${m.senderId}\n会话 chat_id：${m.chatId}`;
      else if (command === '/tasks') reply = this.tasks.list(m).map(t => `${t.id} · ${t.state} · ${t.project ?? '隔离目录'} · ${t.workstreamId}`).join('\n') || '尚无任务记录。';
      else if (command === '/task') { const t = this.tasks.owned(m.text.trim().split(/\s+/)[1] ?? '', m); reply = t ? JSON.stringify(this.tasks.detail(t), null, 2) : '未找到可访问的任务。用 /tasks 查看任务编号。'; }
      else if (command === '/session') {
        const wid = m.text.trim().split(/\s+/)[1];
        if (wid && this.store.hasPending(m.chatKey, m.key)) reply = '仍有未完成请求，暂不能切换工作线。';
        else if (wid) reply = this.tasks.selectStream(m, wid) ? `已选择工作线 ${wid.toUpperCase()}；下一项任务续接其上下文。` : '未找到可访问的工作线。';
        else reply = `当前工作线：${this.tasks.binding(m)?.id ?? '尚未创建'}\n${this.tasks.streams(m).map(w => `${w.id} · ${w.project ?? '隔离目录'}`).join('\n')}\n切换：/session W-编号；新开：/new`;
      }
      else if (command === '/status') reply = JSON.stringify({ queue: this.store.status(m.chatKey), workspace: this.workspaceLabel(m), workstream: this.tasks.binding(m)?.id, sandbox: this.config.codex?.sandbox, network: this.config.codex?.networkAccess,
        localCommits: this.config.codex?.allowLocalCommits ?? false, pushAndDeploy: '需单独确认目标和内容' }, null, 2);
      else if (command === '/project') {
        const name = m.text.trim().split(/\s+/)[1];
        const projects = this.config.codex?.projects ?? {};
        if (!name) reply = `当前目录：${this.workspaceLabel(m)}\n可选项目：\n${Object.entries(projects).map(([n, p]) => `${n} → ${p}`).join('\n') || '尚未配置'}\n切换：/project 项目名（开始新上下文）`;
        else if (!Object.hasOwn(projects, name)) reply = '未配置该项目。用 /project 查看可选项目；新增目录需修改本地配置。';
        else if (this.store.hasPending(m.chatKey, m.key)) reply = '本会话仍有未完成的请求，暂不能切换项目。请等待完成，或 /cancel 后再切换。';
        else { this.store.setProject(this.projectScope(m), name); this.store.clearThread(m.chatKey); this.tasks.reset(m); reply = `已切换到 ${name}：${projects[name]}。下一条消息开始新的 Codex 上下文。`; }
      }
      else if (command === '/unsupported') reply = '当前版本只支持文字和富文本。图片、文件、语音等内容尚未接入，请先发文字说明。';
      else if (command === '/too-long') reply = '这条消息超过 16000 字符，尚未交给模型。请拆成较短的消息。';
      else if (command === '/help') reply = '支持文字和富文本；独立附件 / 转发只保存描述、等待说明。/material 内容 暂存材料；/run 要求 开工并关联材料；/tasks 列表；/task N-编号 详情；/amend N-编号 补充要求；/cancel [N-编号] 取消本人任务；/session [W-编号] 查看或续接工作线；/new 或 /reset 新上下文；/project 选择项目；/status 查看状态。尚无附件解析、后台派工或定时功能。';
      else if (command === '/reset' || command === '/new') {
        if (this.active.has(m.chatKey)) reply = '本会话仍在执行。请先 /cancel，等执行停止后再 /reset。';
        else { this.store.clearThread(m.chatKey); this.tasks.reset(m); reply = '已开始新的工作线。下一条任务使用新上下文；历史任务和代码仍保留。'; }
      } else {
        const target = m.text.trim().split(/\s+/)[1];
        const rows = this.tasks.pending(m).filter(t => target ? t.id === target.toUpperCase() : t.scopeKey === scopeOf(m));
        for (const t of rows) this.tasks.cancel(t);
        reply = rows.length ? `已请求停止 ${rows.length} 条本人任务。已发生的操作不会自动撤销。` : '当前没有可取消的本人任务；可用 /tasks 核对任务编号。';
      }
      this.store.finish(m.key, reply);
      return true;
    }
    return false;
  }
  private projectScope(m: Incoming): string { return m.envelope ? `${scopeOf(m)}:user:${m.senderId}` : m.chatKey; }
  private project(m: Incoming, reference?: Task): ProjectBinding {
    const c = this.config.codex;
    const bound = reference ?? this.tasks.binding(m);
    const legacy = !m.envelope?.threadId ? this.store.project(m.chatKey) : undefined;
    const name = bound?.project ?? this.store.project(this.projectScope(m)) ?? legacy ?? c?.defaultProject;
    if (name) {
      if (!c?.projects || !Object.hasOwn(c.projects, name)) throw new RuntimeError('project_unavailable');
      try { if (realpathSync(c.projects[name]) !== c.projects[name]) throw new Error(); }
      catch { throw new RuntimeError('project_unavailable'); }
      if (bound && bound.cwd !== c.projects[name]) throw new RuntimeError('project_changed');
      return { project: name, cwd: c.projects[name], policyHash: policyHash(c) };
    }
    const cwd = bound?.cwd ?? chatWorkspace(this.config.dataDir, this.projectScope(m));
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    return { cwd: realpathSync(cwd), policyHash: policyHash(c) };
  }
  private workspaceLabel(m: Incoming): string {
    try { return this.project(m).cwd; }
    catch (e) { if (e instanceof RuntimeError) return '当前项目已从配置移除，请用 /project 选择其他项目'; throw e; }
  }
  start(): void {
    this.log('recovered', this.store.recover());
    this.tasks.recover();
    this.store.transaction(() => {
      const rows = this.store.db.prepare("SELECT key FROM inbox WHERE state='queued' AND taskId IS NULL ORDER BY seq").all() as { key: string }[];
      for (const row of rows) { const m = this.store.get(row.key)!; if (!this.handleControl(m)) this.route(m); }
    });
    this.started = true;
    this.interval = setInterval(() => void this.pump(), 250);
    void this.pump();
  }
  async pump(): Promise<void> {
    if (!this.started || this.stopped || this.pumping) return;
    this.pumping = true;
    try {
      this.tasks.expireMaterials();
      while (this.active.size < this.config.concurrency) {
        const next = this.tasks.candidates().find(t => !this.active.has(t.chatKey) && ![...this.active.values()].some(a => pathsOverlap(a.cwd, t.cwd)));
        if (!next) break;
        const run = this.tasks.start(next);
        const abort = new AbortController();
        // Register the slot before run() starts, including synchronous failures.
        const promise = Promise.resolve().then(() => this.execute(next, run, abort.signal))
          .catch(() => this.fatal('execution_storage_error'))
          .finally(() => { this.active.delete(next.chatKey); void this.pump(); });
        this.active.set(next.chatKey, { key: next.inboxKey, task: next, run, cwd: next.cwd, abort, promise });
      }
      if (!this.outputBusy) {
        this.outputBusy = true;
        void this.flush().catch(() => this.fatal('outbox_storage_error')).finally(() => { this.outputBusy = false; });
      }
    } catch { this.fatal('queue_storage_error'); }
    finally { this.pumping = false; }
  }
  private async execute(task: Task, run: string, signal: AbortSignal): Promise<void> {
    const m = this.store.get(task.inboxKey)!;
    this.log('turn_started', { messageId: m.messageId });
    try {
      const current = this.project(m, task);
      if (current.policyHash !== task.policyHash || realpathSync(task.cwd) !== task.cwd) throw new RuntimeError('task_configuration_changed');
      const cwd = task.cwd;
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const result = await this.runtime.run({
        threadId: this.store.thread(sessionKey(task.workstreamId)), cwd, signal,
        prompt: this.tasks.prompt(task),
        onThread: threadId => { this.store.saveThread(sessionKey(task.workstreamId), threadId); this.store.saveRun(m.key, threadId); this.tasks.saveRun(run, threadId); },
        onTurn: turnId => { const threadId = this.store.thread(sessionKey(task.workstreamId)); if (threadId) { this.store.saveRun(m.key, threadId, turnId); this.tasks.saveRun(run, threadId, turnId); } },
        onReady: controls => { const slot = this.active.get(m.chatKey); if (slot?.task.id === task.id) { slot.controls = controls; void this.steer(slot).catch(() => this.fatal('revision_storage_error')); } },
      });
      await this.active.get(m.chatKey)?.steering;
      if (signal.aborted) throw new RuntimeError('cancelled');
      this.tasks.finish(task, run, this.redact(result.text));
      this.log('turn_completed', { messageId: m.messageId });
    } catch (e) {
      const code = signal.aborted ? 'cancelled' : e instanceof RuntimeError ? e.code : 'runtime_error';
      const text = code === 'cancelled' ? '这条请求已停止。已发生的操作不会自动撤销。'
        : code === 'turn_timeout' ? '这条请求超时，执行器已停止。执行结果未确认，没有自动重跑。'
        : `这条请求未完成（${code}）。请检查本地 Codex 登录与服务状态；为避免重复操作，没有自动重跑。`;
      await this.active.get(m.chatKey)?.steering;
      this.tasks.finish(task, run, text, code);
      this.log('turn_failed', { messageId: m.messageId, code });
    }
  }
  private route(m: Inbox): void {
    try {
      if (/^\/(?:material|run)\s*$/.test(m.text)) { this.reply(m, '请在 /material 后填写材料，或在 /run 后填写处理要求。尚未开工。'); return; }
      const explicit = /^\/amend\s+(N-[A-Fa-f0-9]{12})\s+\S/.exec(m.text);
      if (m.text.startsWith('/amend') && !explicit) { this.reply(m, '用法：/amend N-任务编号 补充要求'); return; }
      const ref = explicit ? this.tasks.owned(explicit[1], m) : this.tasks.referenced(m);
      const materialRef = !explicit ? this.tasks.referenceMaterial(m) : undefined;
      if ((explicit || m.envelope?.parentId) && !ref && !materialRef) { this.reply(m, '未找到本人在本聊天中的引用任务或待处理材料。请用 /tasks 选择任务，或将引用材料和要求一并贴出。'); return; }
      const project = this.project(m, ref);
      if (materialRef && this.tasks.materialProject(materialRef.key) !== JSON.stringify(project)) {
        this.reply(m, '引用材料属于另一项目或权限版本，尚未开工。请先选择对应项目，或重新提交材料和要求。'); return;
      }
      if (m.envelope?.kind === 'material') { this.tasks.material(m, project); return; }
      if (ref && ['queued', 'running'].includes(ref.state)) {
        this.tasks.amend(ref, m); this.reply(m, `补充已保存到 ${ref.id}。${ref.state === 'running' ? '正在尝试追加给执行器；提交结果会另行提示，不表示此前操作已撤销。' : '将在开工时一并处理。'}`); return;
      }
      const t = this.tasks.create(m, project, ref);
      this.store.addOutput(m.key, 'progress', `已收到任务 ${t.id} · ${t.project ?? '隔离目录'}\n工作线 ${t.workstreamId}；/task ${t.id} 查看，/amend ${t.id} 补充，/cancel ${t.id} 停止。`);
    } catch (e) {
      if (e instanceof TaskInputError) { this.reply(m, e.message); return; }
      if (!(e instanceof RuntimeError)) throw e;
      this.reply(m, `项目不可用（${e.code}），尚未执行。请用 /project 选择已配置项目。`);
    }
  }
  private reply(m: Incoming, text: string): void { this.store.claim(m.key); this.store.finish(m.key, text); }
  private steer(slot: Active): Promise<void> {
    if (!slot.controls) return Promise.resolve();
    if (slot.steering) return slot.steering;
    slot.steering = (async () => {
      for (;;) {
        const revision = this.tasks.revisions(slot.task.id)[0];
        if (!revision || slot.abort.signal.aborted) break;
        this.tasks.dispatch(revision.inboxKey, 'submitting');
        let state: string;
        try { state = await slot.controls!.steer(JSON.stringify({ task_id: slot.task.id, revision: revision.version,
          user_message: revision.text, note: '这是该任务所有者追加的要求，较新的明确限制优先。' })); }
        catch { state = 'unknown'; }
        this.store.transaction(() => {
          this.tasks.dispatch(revision.inboxKey, state);
          this.store.addOutput(revision.inboxKey, 'notice', state === 'accepted'
            ? `任务 ${slot.task.id} 的补充已被执行器接受，请核对最终结果；不代表此前操作已撤销。`
            : `任务 ${slot.task.id} 的补充${state === 'unknown' ? '提交结果不明' : '未被当前轮接受'}，未自动重送。请用 /task 核对，必要时 /cancel 后明确继续。`);
        });
      }
    })().finally(() => { slot.steering = undefined; });
    return slot.steering;
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
