import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { Store } from './store.js';
import { ApprovalError, ExecFileGitRunner, GitApprovals, type GitApprovalRecord, type ApprovalTaskContext } from './approvals.js';
import { selectAgent, selectedPolicyHash } from './agent-registry.js';
import { Tasks } from './tasks.js';
import type { ApprovalAction, ApprovalView, ServiceLog } from './ui-contract.js';
import { t as tr } from './locale.js';

/** Fixed files, bounded reads, no symlinks, and no raw filesystem errors. */
export function serviceLogs(dataDir: string, redact: (text: string) => string): ServiceLog[] {
  return ['service.log', 'service.error.log'].map(name => {
    let fd: number | undefined;
    try {
      fd = openSync(join(dataDir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile()) return { name, status: 'unavailable', text: '', truncated: false };
      const start = Math.max(0, stat.size - 65536), buffer = Buffer.alloc(Math.min(stat.size, 65536));
      const bytes = readSync(fd, buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytes).toString('utf8');
      if (start > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
      const lines = text.trimEnd().split('\n');
      return { name, status: 'ready', text: redact(lines.slice(-80).join('\n')), truncated: start > 0 || lines.length > 80 };
    } catch (error) {
      return { name, status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable', text: '', truncated: false };
    } finally { if (fd !== undefined) closeSync(fd); }
  });
}

export function approvalView(record: GitApprovalRecord): ApprovalView {
  const { id, revision, task, target, configRevision, commitSummary, expiresAt, reason } = record;
  return { id, revision, taskId: task.taskId, project: task.project, ownerId: task.ownerId,
    state: ['pending', 'approved'].includes(record.state) && expiresAt <= Date.now() ? 'expired' : record.state,
    remote: target.remote, ref: target.ref, headSha: target.headSha, remoteBeforeSha: target.remoteBeforeSha,
    configRevision, commitSummary, expiresAt, reason };
}
export function listApprovals(store: Store): ApprovalView[] {
  // Reading history must not create an engine, run Git, expire records, or take a write lock.
  return store.db.prepare("SELECT value FROM settings WHERE key LIKE 'git-approval:%' ORDER BY json_extract(value,'$.createdAt') DESC LIMIT 50")
    .all().map(row => approvalView(JSON.parse(String(row.value)) as GitApprovalRecord));
}
export async function changeApproval(store: Store, config: Config, revision: string, currentRevision: () => string, input: ApprovalAction): Promise<ApprovalView> {
  if (input.configRevision !== revision) throw new ApprovalError('approval_config_changed', tr('management.configurationChangedReviewAgainApplying'));
  if (!input.confirmed) throw new ApprovalError('approval_confirmation_required', tr('operations.confirmRequired'));
  const policy = config.gitApprovals;
  if (!policy?.gitBin) throw new ApprovalError('approval_unconfigured', tr('operations.approvalsUnavailable'));
  const approvals = new GitApprovals(store, policy, new ExecFileGitRunner(policy.gitBin));
  const task = (id: string): ApprovalTaskContext & { state: string } => {
    const row = store.db.prepare('SELECT id,ownerId,chatKey,project,cwd,policyHash,state FROM tasks WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ApprovalError('task_missing', tr('cli.taskNotExist'));
    const project = row.project == null ? undefined : String(row.project), cwd = String(row.cwd), projects = config.codex.projects ?? {};
    const selection = new Tasks(store).selection(id) ?? selectAgent(config, 'codex');
    if (row.policyHash !== selectedPolicyHash(config, selection)) throw new ApprovalError('task_configuration_changed', tr('cli.agentProfileProjectPermissionsChangedTaskWas'));
    if (project && (!Object.hasOwn(projects, project) || projects[project] !== cwd)) throw new ApprovalError('task_configuration_changed', tr('cli.taskProjectWasRemovedItsPathChanged'));
    return { taskId: id, ownerId: String(row.ownerId), chatKey: String(row.chatKey), project, cwd, policyHash: String(row.policyHash), state: String(row.state) };
  };
  const unchanged = () => {
    const current = currentRevision();
    if (current !== revision) throw new ApprovalError('approval_config_changed', tr('management.configurationChangedReviewAgainApplying'));
    return current;
  };
  if (input.action === 'request') {
    const bound = task(input.taskId);
    if (bound.state !== 'succeeded') throw new ApprovalError('task_not_complete', tr('cli.taskNotCompletedSuccessfully'));
    const requested = await approvals.request(bound, { remote: input.remote, ref: input.ref, configRevision: unchanged() });
    return approvalView(approvals.get(requested.id)!);
  }
  const record = approvals.get(input.id);
  if (!record) throw new ApprovalError('approval_missing', tr('cli.approvalNotExist'));
  if (input.revision !== record.revision) throw new ApprovalError('approval_changed', tr('operations.approvalChanged'));
  if (input.action !== 'reject' && record.configRevision !== revision) throw new ApprovalError('approval_config_changed', tr('management.configurationChangedReviewAgainApplying'));
  const actor = { ownerId: record.task.ownerId, chatKey: record.task.chatKey, authority: 'local-management' as const };
  if (input.action === 'approve') { unchanged(); task(record.task.taskId); approvals.approve(record.id, actor); }
  else if (input.action === 'reject') approvals.reject(record.id, actor);
  else if (input.action === 'execute') await approvals.execute(record.id, task(record.task.taskId), unchanged);
  else if (input.action === 'reconcile') await approvals.reconcile(record.id, task(record.task.taskId), unchanged());
  else throw new ApprovalError('approval_action_invalid', tr('common.actionNotFound'));
  return approvalView(approvals.get(record.id)!);
}
