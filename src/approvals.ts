import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import type { Store } from './store.js';

const KEY_PREFIX = 'git-approval:';
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REVISION = /^[0-9a-f]{64}$/;
const MAX_TTL = 15 * 60_000;
const MAX_OUTPUT = 1024 * 1024;
const CREDENTIAL_HELPERS = new Set(['osxkeychain', 'manager', 'manager-core', 'wincred', 'libsecret']);

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired' | 'invalidated' | 'executing' | 'succeeded' | 'failed' | 'unknown';
export type RemoteTransport = 'https' | 'ssh' | 'local-test';

export class ApprovalError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ApprovalError'; }
}

export interface ApprovalTaskContext {
  taskId: string; ownerId: string; chatKey: string; project?: string; cwd: string; policyHash: string;
}
export interface ApprovalActor { ownerId: string; chatKey: string; authority: 'verified-owner-command' | 'local-management'; }
export interface GitRemotePolicy {
  name: string; url: string; transport: RemoteTransport; credentialHelpers?: string[];
}
export interface GitApprovalPolicy {
  remotes: GitRemotePolicy[]; maxTtlMs?: number; sshCommand?: string;
}
export interface GitCommandResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; }
export interface GitRunner { run(cwd: string, args: string[], timeoutMs?: number): Promise<GitCommandResult>; }

export class ExecFileGitRunner implements GitRunner {
  constructor(readonly gitBin: string) {
    if (!isAbsolute(gitBin) || !existsSync(gitBin) || !statSync(gitBin).isFile() || !(statSync(gitBin).mode & 0o111)) throw new ApprovalError('git_binary_unsafe', 'Git executable must be an explicit executable regular file.');
  }
  run(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitCommandResult> {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('GIT_') || key.startsWith('DYLD_') || key.startsWith('LD_') || key === 'PATH' || ['SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'].includes(key.toUpperCase())) continue;
      env[key] = value;
    }
    env.PATH = [...new Set([dirname(this.gitBin), '/usr/bin', '/bin'])].join(delimiter);
    env.GIT_TERMINAL_PROMPT = '0'; env.GIT_PAGER = 'cat'; env.GIT_EDITOR = 'false'; env.GIT_SEQUENCE_EDITOR = 'false';
    // Never allow repository or global fsmonitor configuration to execute a
    // program during otherwise read-only Git inspection.
    const fixedArgs = ['-c', 'core.fsmonitor=false', ...args];
    return new Promise(resolveResult => execFile(this.gitBin, fixedArgs, { cwd, env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true }, (error, stdout, stderr) => {
      const detail = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
      resolveResult({ exitCode: error ? typeof detail?.code === 'number' ? detail.code : null : 0,
        stdout: String(stdout).slice(0, MAX_OUTPUT), stderr: String(stderr).slice(0, MAX_OUTPUT), timedOut: !!detail?.killed || detail?.code === 'ETIMEDOUT' });
    }));
  }
}

export interface GitApprovalRecord {
  schemaVersion: 1; id: string; operation: 'git-push'; state: ApprovalState; revision: number;
  task: { taskId: string; ownerId: string; chatKey: string; project: string | null; cwd: string; policyHash: string };
  target: { remote: string; url: string; transport: RemoteTransport; ref: string; headSha: string; remoteBeforeSha: string | null };
  configRevision: string; commitSummary: string; createdAt: number; expiresAt: number; updatedAt: number;
  limitedProtection: true; attemptId?: string; reason?: string;
  events: Array<{ state: ApprovalState; at: number; actor?: ApprovalActor['authority']; reason?: string }>;
}

export interface ApprovalPreview {
  id: string; state: ApprovalState; taskId: string; project: string | null; remote: string; transport: RemoteTransport;
  ref: string; headSha: string; remoteBeforeSha: string | null; commitSummary: string; expiresAt: number;
  limitedProtection: true; limitation: string;
}

function bounded(value: string, name: string, max = 256): string {
  if (!value || value.length > max || /[\0-\x1f\x7f]/.test(value)) throw new ApprovalError('context_invalid', `${name} is missing, too long, or contains control characters.`);
  return value;
}
function checkRef(ref: string): void {
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes('..') || ref.includes('@{') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) throw new ApprovalError('ref_unsafe', 'Only one canonical refs/heads/* destination is supported.');
}
function transportOf(url: string): RemoteTransport | undefined {
  if (/[\0-\x20\x7f]/.test(url)) return;
  if (isAbsolute(url)) return 'local-test';
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9._/-]+$/.test(url) && !url.split(':', 2)[1]?.split('/').includes('..')) return 'ssh';
  try {
    const parsed = new URL(url);
    if (parsed.username && parsed.protocol === 'https:') return;
    if (parsed.password || parsed.search || parsed.hash || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(parsed.hostname) || /[%\\\0-\x20]/.test(parsed.pathname) || parsed.pathname.split('/').includes('..')) return;
    if (parsed.protocol === 'https:') return 'https';
    if (parsed.protocol === 'ssh:' && parsed.pathname !== '/') return 'ssh';
  } catch { return; }
}
function outputLine(result: GitCommandResult, code: string): string {
  if (result.exitCode !== 0) throw new ApprovalError(code, 'Git inspection failed without changing the repository or remote.');
  return result.stdout.trim();
}

export class GitApprovals {
  private hooksDir: string;
  private maxTtl: number;
  constructor(private store: Store, private policy: GitApprovalPolicy, private runner: GitRunner, private now: () => number = Date.now) {
    this.maxTtl = Math.min(Math.max(policy.maxTtlMs ?? MAX_TTL, 1_000), MAX_TTL);
    this.hooksDir = mkdtempSync(join(tmpdir(), 'namo-empty-hooks-')); chmodSync(this.hooksDir, 0o700);
    const names = new Set<string>();
    for (const remote of policy.remotes) {
      if (!REMOTE.test(remote.name) || names.has(remote.name) || transportOf(remote.url) !== remote.transport) throw new ApprovalError('remote_policy_invalid', 'Every approved remote needs a unique safe name, exact URL, and matching transport.');
      if (remote.transport === 'local-test' && (!isAbsolute(remote.url) || remote.url === '/' || remote.url === homedir() || existsSync(remote.url) && lstatSync(remote.url).isSymbolicLink())) throw new ApprovalError('remote_policy_invalid', 'Local test remotes must be specific non-link absolute paths.');
      for (const helper of remote.credentialHelpers ?? []) if (!CREDENTIAL_HELPERS.has(helper)) throw new ApprovalError('credential_helper_unsafe', 'Credential helper is not in the fixed supported allowlist.');
      if (remote.transport !== 'https' && remote.credentialHelpers?.length) throw new ApprovalError('credential_helper_unsafe', 'Credential helpers are supported only for explicit HTTPS remotes.');
      names.add(remote.name);
    }
    if (policy.sshCommand !== undefined && (!isAbsolute(policy.sshCommand) || !existsSync(policy.sshCommand) || !statSync(policy.sshCommand).isFile() || !(statSync(policy.sshCommand).mode & 0o111))) throw new ApprovalError('ssh_command_unsafe', 'SSH command must be an explicit executable regular file.');
  }

  private key(id: string): string { return `${KEY_PREFIX}${id}`; }
  private decode(value: string): GitApprovalRecord {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || (parsed as GitApprovalRecord).schemaVersion !== 1 || (parsed as GitApprovalRecord).operation !== 'git-push') throw new ApprovalError('approval_record_invalid', 'Approval record is malformed or unsupported.');
    return parsed as GitApprovalRecord;
  }
  get(id: string): GitApprovalRecord | undefined {
    const row = this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(this.key(id.toUpperCase())) as { value: string } | undefined;
    if (!row) return;
    const record = this.decode(row.value); this.expireRecord(record); return this.read(id);
  }
  private read(id: string): GitApprovalRecord | undefined {
    const row = this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(this.key(id.toUpperCase())) as { value: string } | undefined;
    return row ? this.decode(row.value) : undefined;
  }
  private save(record: GitApprovalRecord, expected: ApprovalState): GitApprovalRecord {
    return this.store.transaction(() => {
      const current = this.read(record.id);
      if (!current || current.state !== expected || current.revision !== record.revision) throw new ApprovalError('approval_changed', 'Approval changed; refresh before acting.');
      record.revision++; record.updatedAt = this.now();
      this.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(record), this.key(record.id));
      return structuredClone(record);
    });
  }
  private transition(record: GitApprovalRecord, expected: ApprovalState, state: ApprovalState, reason?: string, actor?: ApprovalActor['authority']): GitApprovalRecord {
    const next = structuredClone(record); next.state = state; next.reason = reason; next.events.push({ state, at: this.now(), actor, reason });
    return this.save(next, expected);
  }
  private expireRecord(record: GitApprovalRecord): void {
    if (['pending', 'approved'].includes(record.state) && this.now() >= record.expiresAt) this.transition(record, record.state, 'expired', 'approval_expired');
  }
  private assertActor(record: GitApprovalRecord, actor: ApprovalActor): void {
    if (!['verified-owner-command', 'local-management'].includes(actor.authority) || actor.ownerId !== record.task.ownerId || actor.chatKey !== record.task.chatKey) throw new ApprovalError('approval_owner_mismatch', 'Only the bound owner in the bound chat can decide this approval.');
  }
  approve(id: string, actor: ApprovalActor): GitApprovalRecord {
    const record = this.get(id); if (!record) throw new ApprovalError('approval_missing', 'Approval does not exist.'); this.assertActor(record, actor);
    if (record.state !== 'pending') throw new ApprovalError('approval_not_pending', 'Approval is no longer pending.');
    return this.transition(record, 'pending', 'approved', undefined, actor.authority);
  }
  reject(id: string, actor: ApprovalActor): GitApprovalRecord {
    const record = this.get(id); if (!record) throw new ApprovalError('approval_missing', 'Approval does not exist.'); this.assertActor(record, actor);
    if (!['pending', 'approved'].includes(record.state)) throw new ApprovalError('approval_not_decidable', 'Approval can no longer be rejected.');
    return this.transition(record, record.state, 'rejected', 'owner_rejected', actor.authority);
  }
  expireAll(): number {
    const rows = this.store.db.prepare("SELECT value FROM settings WHERE key LIKE 'git-approval:%'").all() as { value: string }[];
    let count = 0; for (const row of rows) { const record = this.decode(row.value); const before = record.state; this.expireRecord(record); if (before !== this.read(record.id)?.state) count++; }
    return count;
  }

  private remotePolicy(name: string): GitRemotePolicy {
    const remote = this.policy.remotes.find(item => item.name === name);
    if (!remote) throw new ApprovalError('remote_not_approved', 'Remote is not in the administrator-approved target list.');
    return remote;
  }
  private safeArgs(remote: GitRemotePolicy, command: string[]): string[] {
    const args = ['-c', `core.hooksPath=${this.hooksDir}`, '-c', 'credential.helper=', '-c', 'http.extraHeader=', '-c', 'http.proxy=',
      '-c', 'http.sslCert=', '-c', 'http.sslKey=', '-c', 'http.cookieFile=', '-c', 'http.saveCookies=false', '-c', 'protocol.ext.allow=never',
      '-c', `protocol.file.allow=${remote.transport === 'local-test' ? 'always' : 'never'}`];
    for (const helper of remote.credentialHelpers ?? []) args.push('-c', `credential.helper=${helper}`);
    if (remote.transport === 'ssh') {
      const ssh = this.policy.sshCommand ?? '/usr/bin/ssh';
      if (!isAbsolute(ssh) || !existsSync(ssh)) throw new ApprovalError('ssh_command_unsafe', 'No explicit safe SSH executable is available.');
      args.push('-c', `core.sshCommand=${ssh} -F /dev/null -oBatchMode=yes -oClearAllForwardings=yes -oPermitLocalCommand=no -oProxyCommand=none`);
    }
    return [...args, ...command];
  }
  private async remoteSha(cwd: string, remote: GitRemotePolicy, ref: string): Promise<{ reachable: boolean; sha: string | null }> {
    const result = await this.runner.run(cwd, this.safeArgs(remote, ['ls-remote', '--refs', '--', remote.url, ref]));
    if (result.exitCode !== 0) return { reachable: false, sha: null };
    const rows = result.stdout.trim() ? result.stdout.trim().split('\n') : [];
    if (rows.length > 1) return { reachable: false, sha: null };
    if (!rows.length) return { reachable: true, sha: null };
    const [sha, foundRef] = rows[0]!.trim().split(/\s+/, 2);
    return { reachable: foundRef === ref && !!sha && SHA.test(sha) , sha: foundRef === ref && sha && SHA.test(sha) ? sha : null };
  }
  private validateContext(record: GitApprovalRecord, task: ApprovalTaskContext, configRevision: string): void {
    const cwd = realpathSync(task.cwd);
    if (record.task.taskId !== task.taskId || record.task.ownerId !== task.ownerId || record.task.chatKey !== task.chatKey ||
      record.task.project !== (task.project ?? null) || record.task.cwd !== cwd || record.task.policyHash !== task.policyHash || record.configRevision !== configRevision) {
      throw new ApprovalError('approval_context_changed', 'Task owner, chat, project, policy, directory, or configuration changed after approval.');
    }
  }
  private async inspect(task: ApprovalTaskContext, remoteName: string, ref: string): Promise<{ remote: GitRemotePolicy; head: string; summary: string; before: string | null }> {
    bounded(task.taskId, 'taskId', 96); bounded(task.ownerId, 'ownerId'); bounded(task.chatKey, 'chatKey'); bounded(task.policyHash, 'policyHash', 128);
    if (!REVISION.test(task.policyHash)) throw new ApprovalError('context_invalid', 'Task policy hash is invalid.');
    if (!REMOTE.test(remoteName)) throw new ApprovalError('remote_unsafe', 'Remote name is invalid.'); checkRef(ref);
    const cwd = realpathSync(task.cwd); if (cwd === '/' || cwd === homedir() || !statSync(cwd).isDirectory()) throw new ApprovalError('project_unsafe', 'Approval requires a specific real project directory.');
    const top = outputLine(await this.runner.run(cwd, ['rev-parse', '--show-toplevel']), 'repository_invalid');
    if (realpathSync(top) !== cwd) throw new ApprovalError('project_mismatch', 'Task directory must be the exact Git project root.');
    const check = await this.runner.run(cwd, ['check-ref-format', ref]); if (check.exitCode !== 0) throw new ApprovalError('ref_unsafe', 'Destination ref is not valid.');
    const head = outputLine(await this.runner.run(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']), 'head_unavailable'); if (!SHA.test(head)) throw new ApprovalError('head_unavailable', 'HEAD is not a supported commit hash.');
    const filters = await this.runner.run(cwd, ['config', '--show-origin', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$']);
    if (filters.exitCode === 0 && filters.stdout.trim()) throw new ApprovalError('filter_config_unsafe', 'Executable Git clean, smudge, or process filters are not supported for controlled push.');
    if (![0, 1].includes(filters.exitCode ?? -1)) throw new ApprovalError('git_config_unreadable', 'Git filter configuration could not be audited.');
    const dirty = await this.runner.run(cwd, ['-c', 'status.submoduleSummary=false', '-c', 'submodule.recurse=false', 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all']);
    if (dirty.exitCode !== 0 || dirty.stdout) throw new ApprovalError('worktree_dirty', 'Commit or remove all tracked and untracked changes before requesting push approval.');
    const remote = this.remotePolicy(remoteName);
    const urls = outputLine(await this.runner.run(cwd, ['remote', 'get-url', '--push', '--all', remoteName]), 'remote_unavailable').split('\n').filter(Boolean);
    if (urls.length !== 1 || urls[0] !== remote.url || transportOf(urls[0]!) !== remote.transport) throw new ApprovalError('remote_changed', 'Configured push URL does not exactly match the approved remote.');
    const rewrites = await this.runner.run(cwd, ['config', '--get-regexp', '^url\..*\.(insteadOf|pushInsteadOf)$']); if (rewrites.exitCode === 0 && rewrites.stdout.trim()) throw new ApprovalError('url_rewrite_unsafe', 'Git URL rewrite rules must be removed before controlled push.');
    if (![0, 1].includes(rewrites.exitCode ?? -1)) throw new ApprovalError('git_config_unreadable', 'Git URL rewrite configuration could not be audited.');
    const hookPath = await this.runner.run(cwd, ['config', '--path', '--get', 'core.hooksPath']); if (hookPath.exitCode === 0 && hookPath.stdout.trim()) throw new ApprovalError('push_hook_unsafe', 'Custom hooksPath is not supported for controlled push.');
    if (![0, 1].includes(hookPath.exitCode ?? -1)) throw new ApprovalError('git_config_unreadable', 'Git hooks configuration could not be audited.');
    const httpRisk = await this.runner.run(cwd, ['config', '--local', '--name-only', '--get-regexp', '^http\..*(extraHeader|sslCert|sslKey|cookieFile|proxy)$']);
    if (httpRisk.exitCode === 0 && httpRisk.stdout.trim()) throw new ApprovalError('http_config_unsafe', 'Repository-local HTTP credential, certificate, cookie, or proxy settings are not supported.');
    if (![0, 1].includes(httpRisk.exitCode ?? -1)) throw new ApprovalError('git_config_unreadable', 'Repository HTTP configuration could not be audited.');
    const credentialRisk = await this.runner.run(cwd, ['config', '--local', '--name-only', '--get-regexp', '^(credential\..*helper|credential\.helper|include\..*|includeIf\..*)$']);
    if (credentialRisk.exitCode === 0 && credentialRisk.stdout.trim()) throw new ApprovalError('credential_config_unsafe', 'Repository-local credential helpers or config includes are not supported.');
    if (![0, 1].includes(credentialRisk.exitCode ?? -1)) throw new ApprovalError('git_config_unreadable', 'Repository credential configuration could not be audited.');
    const gitDir = outputLine(await this.runner.run(cwd, ['rev-parse', '--absolute-git-dir']), 'repository_invalid');
    const prePush = join(gitDir, 'hooks', 'pre-push'); if (existsSync(prePush) && lstatSync(prePush).isFile()) throw new ApprovalError('push_hook_unsafe', 'Repositories with a pre-push hook require a separate reviewed workflow; hooks are never executed by this approval path.');
    if (remote.transport === 'local-test') { const bare = await this.runner.run(realpathSync(remote.url), ['rev-parse', '--is-bare-repository']); if (bare.exitCode !== 0 || bare.stdout.trim() !== 'true') throw new ApprovalError('local_remote_unsafe', 'Local test remote must be an existing bare repository.'); }
    const baseline = await this.remoteSha(cwd, remote, ref); if (!baseline.reachable) throw new ApprovalError('remote_unverifiable', 'Remote ref could not be read safely; approval was not created.');
    const subject = outputLine(await this.runner.run(cwd, ['show', '-s', '--format=%s', head]), 'commit_unreadable').replace(/[\0-\x1f\x7f]/g, ' ').slice(0, 200);
    return { remote, head, summary: subject, before: baseline.sha };
  }

  async request(task: ApprovalTaskContext, input: { remote: string; ref: string; configRevision: string; ttlMs?: number }): Promise<ApprovalPreview> {
    if (!REVISION.test(input.configRevision)) throw new ApprovalError('config_revision_invalid', 'Current configuration revision is required.');
    const inspected = await this.inspect(task, input.remote, input.ref); const now = this.now(); const ttl = Math.min(Math.max(input.ttlMs ?? this.maxTtl, 1_000), this.maxTtl);
    let record: GitApprovalRecord | undefined;
    for (let attempt = 0; attempt < 4 && !record; attempt++) {
      const id = `AP-${randomBytes(6).toString('hex').toUpperCase()}`;
      const candidate: GitApprovalRecord = { schemaVersion: 1, id, operation: 'git-push', state: 'pending', revision: 0,
        task: { taskId: task.taskId, ownerId: task.ownerId, chatKey: task.chatKey, project: task.project ?? null, cwd: realpathSync(task.cwd), policyHash: task.policyHash },
        target: { remote: inspected.remote.name, url: inspected.remote.url, transport: inspected.remote.transport, ref: input.ref, headSha: inspected.head, remoteBeforeSha: inspected.before },
        configRevision: input.configRevision, commitSummary: inspected.summary, createdAt: now, expiresAt: now + ttl, updatedAt: now, limitedProtection: true,
        events: [{ state: 'pending', at: now }] };
      if (this.store.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(this.key(id), JSON.stringify(candidate)).changes === 1) record = candidate;
    }
    if (!record) throw new ApprovalError('approval_id_collision', 'Could not allocate an approval identifier.');
    return this.preview(record);
  }
  preview(record: GitApprovalRecord): ApprovalPreview {
    return { id: record.id, state: record.state, taskId: record.task.taskId, project: record.task.project, remote: record.target.remote,
      transport: record.target.transport, ref: record.target.ref, headSha: record.target.headSha, remoteBeforeSha: record.target.remoteBeforeSha,
      commitSummary: record.commitSummary, expiresAt: record.expiresAt, limitedProtection: true,
      limitation: 'This gate controls only this API. The current general model runtime may still have other network or credential paths; do not describe it as complete enforced isolation.' };
  }
  private invalidate(record: GitApprovalRecord, reason: string): never {
    if (record.state === 'approved') this.transition(record, 'approved', 'invalidated', reason);
    throw new ApprovalError('approval_invalidated', reason);
  }
  async execute(id: string, task: ApprovalTaskContext, configRevision: string | (() => string)): Promise<GitApprovalRecord> {
    const revision = () => typeof configRevision === 'function' ? configRevision() : configRevision;
    let record = this.get(id); if (!record) throw new ApprovalError('approval_missing', 'Approval does not exist.');
    if (record.state !== 'approved') throw new ApprovalError('approval_not_executable', 'Approval is not approved or was already consumed.');
    try { this.validateContext(record, task, revision()); } catch (error) { return this.invalidate(record, (error as Error).message); }
    let inspected: Awaited<ReturnType<GitApprovals['inspect']>>;
    try { inspected = await this.inspect(task, record.target.remote, record.target.ref); } catch (error) { return this.invalidate(record, (error as Error).message); }
    if (inspected.head !== record.target.headSha || inspected.remote.url !== record.target.url || inspected.before !== record.target.remoteBeforeSha) return this.invalidate(record, 'HEAD, remote URL, or remote ref changed after approval.');
    const headAgain = await this.runner.run(record.task.cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (headAgain.exitCode !== 0 || headAgain.stdout.trim() !== record.target.headSha) return this.invalidate(record, 'HEAD changed immediately before push.');
    const remote = this.remotePolicy(record.target.remote);
    // All asynchronous inspection must finish before the one-time approval is
    // consumed. Re-read expiry, revocation, and configuration with no await
    // between these checks, the compare-and-swap, and the push invocation.
    const expectedRevision = record.revision;
    const consumed = this.store.transaction(() => {
      const current = this.get(id);
      if (!current || current.state !== 'approved' || current.revision !== expectedRevision) return { error: new ApprovalError('approval_not_executable', 'Approval expired, changed, or was already consumed.') };
      try { this.validateContext(current, task, revision()); } catch (error) {
        this.transition(current, 'approved', 'invalidated', (error as Error).message);
        return { error: new ApprovalError('approval_invalidated', (error as Error).message) };
      }
      const next = structuredClone(current); next.state = 'executing'; next.attemptId = randomBytes(12).toString('hex'); next.events.push({ state: 'executing', at: this.now() });
      return { record: this.save(next, 'approved') };
    });
    if (consumed.error) throw consumed.error;
    record = consumed.record!;
    const push = await this.runner.run(record.task.cwd, this.safeArgs(remote, ['push', '--porcelain', '--no-verify', '--', remote.url, `${record.target.headSha}:${record.target.ref}`]), 120_000);
    const observed = await this.remoteSha(record.task.cwd, remote, record.target.ref);
    if (observed.reachable && observed.sha === record.target.headSha) return this.transition(record, 'executing', 'succeeded', 'remote_ref_verified');
    if (push.exitCode !== 0 && observed.reachable && observed.sha === record.target.remoteBeforeSha) return this.transition(record, 'executing', 'failed', 'push_rejected_remote_unchanged');
    return this.transition(record, 'executing', 'unknown', push.timedOut ? 'push_timeout_remote_unverified' : 'push_result_unverified');
  }
  recoverInterrupted(): number {
    const rows = this.store.db.prepare("SELECT value FROM settings WHERE key LIKE 'git-approval:%'").all() as { value: string }[]; let count = 0;
    for (const row of rows) { const record = this.decode(row.value); if (record.state === 'executing') { this.transition(record, 'executing', 'unknown', 'process_interrupted_during_push'); count++; } }
    return count;
  }
  async reconcile(id: string, task: ApprovalTaskContext, configRevision: string): Promise<GitApprovalRecord> {
    let record = this.get(id); if (!record) throw new ApprovalError('approval_missing', 'Approval does not exist.');
    if (record.state === 'executing') record = this.transition(record, 'executing', 'unknown', 'process_interrupted_during_push');
    if (record.state !== 'unknown') throw new ApprovalError('approval_not_unknown', 'Only an unknown one-time attempt can be reconciled.');
    this.validateContext(record, task, configRevision);
    const remote = this.remotePolicy(record.target.remote); if (remote.url !== record.target.url) throw new ApprovalError('remote_changed', 'Approved remote policy changed; result remains unknown.');
    const observed = await this.remoteSha(record.task.cwd, remote, record.target.ref);
    if (!observed.reachable) return record;
    if (observed.sha === record.target.headSha) return this.transition(record, 'unknown', 'succeeded', 'remote_ref_verified_after_unknown');
    if (observed.sha === record.target.remoteBeforeSha) return this.transition(record, 'unknown', 'failed', 'remote_unchanged_after_unknown');
    return record;
  }
}
