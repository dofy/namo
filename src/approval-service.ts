import type { Config } from './config.js';
import type { Incoming } from './store.js';
import { Store } from './store.js';
import { ApprovalError, ExecFileGitRunner, GitApprovals, type ApprovalTaskContext, type GitRunner } from './approvals.js';
import { policyHash } from './tasks.js';

const JOB_PREFIX = 'git-approval-job:';
type Action = 'request' | 'approve' | 'reject' | 'status';
interface ApprovalJob { version: 1; inboxKey: string; action: Action; args: string[]; state: 'queued' | 'running' | 'done'; createdAt: number; updatedAt: number; }

const unavailableRunner: GitRunner = { async run() { return { exitCode: null, stdout: '', stderr: '', timedOut: false }; } };

export class ApprovalService {
  readonly approvals: GitApprovals;
  private pumping?: Promise<void>;
  private scheduled = false;
  constructor(private store: Store, private config: Config, private configRevision: string,
    private currentConfigRevision: () => string = () => configRevision, runner?: GitRunner) {
    const policy = config.gitApprovals ?? { remotes: [], maxTtlMs: 900_000 };
    const selectedRunner = runner ?? (policy.gitBin ? new ExecFileGitRunner(policy.gitBin) : unavailableRunner);
    this.approvals = new GitApprovals(store, { remotes: policy.remotes, maxTtlMs: policy.maxTtlMs, sshCommand: policy.sshCommand }, selectedRunner);
  }
  start(): void {
    this.approvals.recoverInterrupted();
    this.store.db.prepare("UPDATE settings SET value=json_set(value,'$.state','queued','$.updatedAt',?) WHERE key LIKE ? AND json_extract(value,'$.state')='running'")
      .run(Date.now(), `${JOB_PREFIX}%`);
    this.schedule();
  }
  private syntax(text: string): { action: Action; args: string[] } | undefined {
    let match = /^\/push-request\s+(N-[A-F0-9]+)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+(refs\/heads\/\S+)\s*$/i.exec(text);
    if (match) return { action: 'request', args: [match[1]!.toUpperCase(), match[2]!, match[3]!] };
    match = /^\/push-approve\s+(AP-[A-F0-9]{12})\s+--confirm\s*$/i.exec(text);
    if (match) return { action: 'approve', args: [match[1]!.toUpperCase()] };
    match = /^\/push-reject\s+(AP-[A-F0-9]{12})\s*$/i.exec(text);
    if (match) return { action: 'reject', args: [match[1]!.toUpperCase()] };
    match = /^\/push-status\s+(AP-[A-F0-9]{12})\s*$/i.exec(text);
    if (match) return { action: 'status', args: [match[1]!.toUpperCase()] };
  }
  handleControl(message: Incoming): boolean {
    if (!message.text.trim().toLowerCase().startsWith('/push-')) return false;
    const parsed = this.syntax(message.text.trim());
    const acceptedIdentity = message.envelope?.chatType === 'p2p' && this.config.feishu.allowedUserIds.includes(message.senderId);
    this.store.transaction(() => {
      if (!this.store.claim(message.key)) return;
      if (!acceptedIdentity) { this.store.finish(message.key, '受控 push 只接受已配对本人的私聊命令；本条未进入审批。', 'approval_identity_rejected'); return; }
      if (!parsed) { this.store.finish(message.key, '用法：/push-request N-任务编号 remote refs/heads/分支；/push-approve AP-编号 --confirm；/push-reject AP-编号；/push-status AP-编号。', 'approval_command_invalid'); return; }
      const job: ApprovalJob = { version: 1, inboxKey: message.key, action: parsed.action, args: parsed.args, state: 'queued', createdAt: Date.now(), updatedAt: Date.now() };
      this.store.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(`${JOB_PREFIX}${message.key}`, JSON.stringify(job));
    });
    // Engine.accept owns the outer durable-acceptance transaction. Defer the
    // reader/runner until that transaction has either committed or rolled back.
    this.deferSchedule(); return true;
  }
  private deferSchedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.schedule(); });
  }
  private schedule(): void { if (!this.pumping) this.pumping = this.pump().finally(() => { this.pumping = undefined; if (this.next()) this.schedule(); }); }
  async idle(): Promise<void> {
    do {
      // Also flush a deferred post-transaction schedule before declaring idle.
      await Promise.resolve();
      if (this.pumping) await this.pumping;
    } while (this.scheduled || this.pumping);
  }
  private next(): ApprovalJob | undefined {
    const row = this.store.db.prepare("SELECT value FROM settings WHERE key LIKE ? AND json_extract(value,'$.state')='queued' ORDER BY json_extract(value,'$.createdAt') LIMIT 1")
      .get(`${JOB_PREFIX}%`) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as ApprovalJob : undefined;
  }
  private task(id: string): ApprovalTaskContext & { state: string } {
    const row = this.store.db.prepare('SELECT id,ownerId,chatKey,project,cwd,policyHash,state FROM tasks WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ApprovalError('task_missing', '任务不存在。');
    const project = row.project == null ? undefined : String(row.project), cwd = String(row.cwd), savedPolicy = String(row.policyHash);
    const projects = this.config.codex.projects ?? {};
    if (savedPolicy !== policyHash(this.config.codex)) throw new ApprovalError('task_configuration_changed', '任务创建后的项目权限配置已更改，不能申请或执行 push。');
    if (project && (!Object.hasOwn(projects, project) || projects[project] !== cwd)) {
      throw new ApprovalError('task_configuration_changed', '任务绑定的项目已移除或路径已更改，不能申请或执行 push。');
    }
    return { taskId: String(row.id), ownerId: String(row.ownerId), chatKey: String(row.chatKey), project,
      cwd, policyHash: savedPolicy, state: String(row.state) };
  }
  private view(id: string): string {
    const record = this.approvals.get(id); if (!record) throw new ApprovalError('approval_missing', '审批不存在。');
    return JSON.stringify({ id: record.id, state: record.state, taskId: record.task.taskId, project: record.task.project,
      remote: record.target.remote, ref: record.target.ref, headSha: record.target.headSha, remoteBeforeSha: record.target.remoteBeforeSha,
      expiresAt: record.expiresAt, reason: record.reason, limitedProtection: true,
      limitation: '只保护本审批入口；通用 Agent 运行环境仍可能存在其他联网或凭据绕过路径。' });
  }
  private async process(job: ApprovalJob): Promise<string> {
    const revision = () => {
      const current = this.currentConfigRevision();
      if (current !== this.configRevision) throw new ApprovalError('approval_config_changed', '配置已更改，请重启服务加载最新审批策略后再操作。');
      return current;
    };
    if (job.action === 'request' || job.action === 'approve') revision();
    if (job.action === 'request') {
      const task = this.task(job.args[0]!); const incoming = this.store.get(job.inboxKey)!;
      if (task.ownerId !== incoming.senderId || task.chatKey !== incoming.chatKey) throw new ApprovalError('task_owner_mismatch', '只能为本人在本聊天中的任务申请 push。');
      if (task.state !== 'succeeded') throw new ApprovalError('task_not_complete', '任务尚未成功完成，不能申请 push。');
      const preview = await this.approvals.request(task, { remote: job.args[1]!, ref: job.args[2]!, configRevision: revision() });
      return JSON.stringify({ ...preview, scope: { taskId: task.taskId, project: task.project ?? null, chat: 'current' } });
    }
    const id = job.args[0]!, record = this.approvals.get(id); if (!record) throw new ApprovalError('approval_missing', '审批不存在。');
    const incoming = this.store.get(job.inboxKey)!;
    const actor = { ownerId: incoming.senderId, chatKey: incoming.chatKey, authority: 'verified-owner-command' as const };
    if (record.task.ownerId !== actor.ownerId || record.task.chatKey !== actor.chatKey) throw new ApprovalError('approval_owner_mismatch', '审批不属于当前用户和聊天。');
    if (job.action === 'status') { if (record.task.ownerId !== actor.ownerId || record.task.chatKey !== actor.chatKey) throw new ApprovalError('approval_owner_mismatch', '审批不属于当前用户和聊天。'); return this.view(id); }
    if (job.action === 'reject') { this.approvals.reject(id, actor); return this.view(id); }
    if (record.state === 'pending') this.approvals.approve(id, actor);
    else if (record.state !== 'approved') throw new ApprovalError('approval_not_executable', '审批不是可执行状态，不能重复 push。');
    const task = this.task(record.task.taskId);
    await this.approvals.execute(id, task, revision); return this.view(id);
  }
  private finish(job: ApprovalJob, text: string, error?: string): void {
    this.store.transaction(() => {
      const next = { ...job, state: 'done' as const, updatedAt: Date.now() };
      this.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(next), `${JOB_PREFIX}${job.inboxKey}`);
      this.store.finish(job.inboxKey, text, error);
    });
  }
  private async pump(): Promise<void> {
    for (;;) {
      const job = this.next(); if (!job) return;
      const running = { ...job, state: 'running' as const, updatedAt: Date.now() };
      this.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(running), `${JOB_PREFIX}${job.inboxKey}`);
      try { this.finish(running, await this.process(running)); }
      catch (error) {
        const message = error instanceof ApprovalError ? error.message : '受控 push 操作未完成；未自动重试。';
        this.finish(running, `${message}\n未执行新的模型任务；如状态不明，请先用 /push-status 核对。`, 'approval_control_failed');
      }
    }
  }
}
