import { isolatedGit, seedRun } from './helpers.js';
import { approvals as approvalRecords } from '../src/business-storage.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalError, ExecFileGitRunner, GitApprovals, type ApprovalTaskContext } from '../src/approvals.js';
import { Store } from '../src/store.js';

const git = isolatedGit({ after });
const CONFIG_REVISION = 'b'.repeat(64);

function command(cwd: string, args: string[]): string { return execFileSync(git, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function markerScript(path: string, marker: string, passthrough = false): void {
  writeFileSync(path, `#!/bin/sh\ntouch "${marker}"\n${passthrough ? 'cat\n' : "printf '\\n'\n"}`); chmodSync(path, 0o700);
}
function assertNotPushed(bare: string, ref = 'refs/heads/main'): void { assert.throws(() => command(bare, ['rev-parse', ref])); }
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'namo-approval-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), bare = join(root, 'remote.git'), data = join(root, 'data'); mkdirSync(repo); mkdirSync(data);
  command(root, ['init', '--bare', bare]); command(repo, ['init']); command(repo, ['config', 'user.name', 'Test User']); command(repo, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(repo, 'README.md'), 'approved content\n'); command(repo, ['add', 'README.md']); command(repo, ['commit', '-m', 'approved commit']); command(repo, ['branch', '-M', 'main']);
  command(repo, ['remote', 'add', 'origin', bare]);
  const store = new Store(join(data, 'bot.sqlite')); t.after(() => store.close());
  const task: ApprovalTaskContext = { taskId: 'N-APPROVAL01', ownerId: 'ou_owner', chatKey: 'chat_owner', project: 'app', cwd: realpathSync(repo), policyHash: 'a'.repeat(64) };
  seedRun(store, 'approval-run', task.taskId);
  const approvals = new GitApprovals(store, { remotes: [{ name: 'origin', url: bare, transport: 'local-test' }] }, new ExecFileGitRunner(git));
  const actor = { ownerId: task.ownerId, chatKey: task.chatKey, authority: 'verified-owner-command' as const };
  return { root, repo, bare, store, task, approvals, actor };
}

test('request preview persists an exact metadata-only target and discloses limited protection', async t => {
  const f = fixture(t);
  const preview = await f.approvals.request(f.task, { remote: 'origin', ref: 'refs/heads/main', configRevision: CONFIG_REVISION });
  assert.equal(preview.state, 'pending'); assert.equal(preview.remoteBeforeSha, null); assert.equal(preview.headSha, command(f.repo, ['rev-parse', 'HEAD']));
  assert.equal(preview.commitSummary, 'approved commit'); assert.equal(preview.limitedProtection, true); assert.match(preview.limitation, /other network or credential paths/);
  const saved = f.approvals.get(preview.id)!; assert.equal(saved.task.ownerId, f.task.ownerId); assert.equal(saved.task.chatKey, f.task.chatKey);
  assert.equal(saved.task.cwd, f.task.cwd); assert.equal(saved.task.policyHash, f.task.policyHash); assert.equal(saved.configRevision, CONFIG_REVISION);
  assert.doesNotMatch(JSON.stringify(preview), /test@example|approved content/);
});

test('only the bound owner and chat can approve or reject once, and expiry is durable', async t => {
  const f = fixture(t); const pending = await f.approvals.request(f.task, { remote: 'origin', ref: 'refs/heads/main', configRevision: CONFIG_REVISION });
  assert.throws(() => f.approvals.approve(pending.id, { ...f.actor, ownerId: 'ou_other' }), (error: unknown) => error instanceof ApprovalError && error.code === 'approval_owner_mismatch');
  const approved = f.approvals.approve(pending.id, f.actor); assert.equal(approved.state, 'approved');
  assert.throws(() => f.approvals.approve(pending.id, f.actor), (error: unknown) => error instanceof ApprovalError && error.code === 'approval_not_pending');
  assert.equal(f.approvals.reject(pending.id, f.actor).state, 'rejected');
  assert.throws(() => f.approvals.reject(pending.id, f.actor), /no longer/);

  let now = 1_000; const timed = new GitApprovals(f.store, { maxTtlMs: 2_000, remotes: [{ name: 'origin', url: f.bare, transport: 'local-test' }] }, new ExecFileGitRunner(git), () => now);
  const expiring = await timed.request(f.task, { remote: 'origin', ref: 'refs/heads/expiry', configRevision: CONFIG_REVISION, ttlMs: 1_000 });
  now = 2_001; assert.equal(timed.get(expiring.id)?.state, 'expired'); assert.throws(() => timed.approve(expiring.id, f.actor), /no longer pending/);
});

test('one approved attempt pushes the exact SHA to a local bare remote and verifies the ref', async t => {
  const f = fixture(t); const pending = await f.approvals.request(f.task, { remote: 'origin', ref: 'refs/heads/main', configRevision: CONFIG_REVISION });
  f.approvals.approve(pending.id, f.actor); const result = await f.approvals.execute(pending.id, f.task, CONFIG_REVISION);
  assert.equal(result.state, 'succeeded'); assert.equal(result.reason, 'remote_ref_verified');
  assert.equal(command(f.bare, ['rev-parse', 'refs/heads/main']), pending.headSha);
  await assert.rejects(f.approvals.execute(pending.id, f.task, CONFIG_REVISION), (error: unknown) => error instanceof ApprovalError && error.code === 'approval_not_executable');
});

test('HEAD, config, hooks, and URL rewrites invalidate or block approval without pushing', async t => {
  const changed = fixture(t); const pending = await changed.approvals.request(changed.task, { remote: 'origin', ref: 'refs/heads/main', configRevision: CONFIG_REVISION }); changed.approvals.approve(pending.id, changed.actor);
  writeFileSync(join(changed.repo, 'second.txt'), 'later\n'); command(changed.repo, ['add', 'second.txt']); command(changed.repo, ['commit', '-m', 'later commit']);
  await assert.rejects(changed.approvals.execute(pending.id, changed.task, CONFIG_REVISION), (error: unknown) => error instanceof ApprovalError && error.code === 'approval_invalidated');
  assert.equal(changed.approvals.get(pending.id)?.state, 'invalidated');
  assert.throws(() => command(changed.bare, ['rev-parse', 'refs/heads/main']));

  const config = fixture(t); const configPending = await config.approvals.request(config.task, { remote: 'origin', ref: 'refs/heads/main', configRevision: CONFIG_REVISION }); config.approvals.approve(configPending.id, config.actor);
  await assert.rejects(config.approvals.execute(configPending.id, config.task, 'c'.repeat(64)), (error: unknown) => error instanceof ApprovalError && error.code === 'approval_invalidated');
  assert.equal(config.approvals.get(configPending.id)?.state, 'invalidated');

  const hook = fixture(t), hookMarker = join(hook.root, 'hook-marker'), prePush = join(hook.repo, '.git', 'hooks', 'pre-push');
  markerScript(prePush, hookMarker);
  await assert.rejects(hook.approvals.request(hook.task, { remote: 'origin', ref: 'refs/heads/main', configRevision: CONFIG_REVISION }), (error: unknown) => error instanceof ApprovalError && error.code === 'push_hook_unsafe');
  assert.equal(existsSync(hookMarker), false); assertNotPushed(hook.bare);
  const rewrite = fixture(t); command(rewrite.repo, ['config', 'url.ext::evil.insteadOf', rewrite.bare]);
  await assert.rejects(rewrite.approvals.request(rewrite.task, { remote: 'origin', ref: 'refs/heads/main', configRevision: CONFIG_REVISION }), (error: unknown) => error instanceof ApprovalError && ['remote_changed', 'url_rewrite_unsafe'].includes(error.code));
});

test('inspection disables fsmonitor, rejects executable filters before status, and never descends into submodules', async t => {
  const fsmonitor = fixture(t), fsmonitorMarker = join(fsmonitor.root, 'fsmonitor-marker'), fsmonitorHook = join(fsmonitor.root, 'fsmonitor-hook');
  markerScript(fsmonitorHook, fsmonitorMarker); command(fsmonitor.repo, ['config', 'core.fsmonitor', fsmonitorHook]);
  command(fsmonitor.repo, ['status', '--porcelain=v1']); assert.equal(existsSync(fsmonitorMarker), true, 'fixture must prove raw Git executes the configured fsmonitor'); rmSync(fsmonitorMarker);
  await fsmonitor.approvals.request(fsmonitor.task, { remote: 'origin', ref: 'refs/heads/main', configRevision: CONFIG_REVISION });
  assert.equal(existsSync(fsmonitorMarker), false); assertNotPushed(fsmonitor.bare);

  const filter = fixture(t), filterMarker = join(filter.root, 'filter-marker'), cleanFilter = join(filter.root, 'clean-filter');
  writeFileSync(join(filter.repo, '.gitattributes'), '*.md filter=marker\n'); command(filter.repo, ['add', '.gitattributes']); command(filter.repo, ['commit', '-m', 'add filter attributes']);
  markerScript(cleanFilter, filterMarker, true); command(filter.repo, ['config', 'filter.marker.clean', cleanFilter]);
  writeFileSync(join(filter.repo, 'README.md'), 'approved content\n'); command(filter.repo, ['status', '--porcelain=v1']);
  assert.equal(existsSync(filterMarker), true, 'fixture must prove raw Git status executes the clean filter'); rmSync(filterMarker);
  await assert.rejects(filter.approvals.request(filter.task, { remote: 'origin', ref: 'refs/heads/main', configRevision: CONFIG_REVISION }),
    (error: unknown) => error instanceof ApprovalError && error.code === 'filter_config_unsafe' && !error.message.includes(cleanFilter));
  assert.equal(existsSync(filterMarker), false); assertNotPushed(filter.bare);

  const submodule = fixture(t), child = join(submodule.root, 'child'), checkout = join(submodule.repo, 'vendor', 'child'); mkdirSync(child);
  command(child, ['init']); command(child, ['config', 'user.name', 'Child']); command(child, ['config', 'user.email', 'child@example.invalid']);
  writeFileSync(join(child, 'child.txt'), 'committed\n'); command(child, ['add', 'child.txt']); command(child, ['commit', '-m', 'child commit']);
  command(submodule.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'vendor/child']); command(submodule.repo, ['commit', '-m', 'add submodule']);
  const submoduleMarker = join(submodule.root, 'submodule-marker'), submoduleHook = join(submodule.root, 'submodule-fsmonitor');
  markerScript(submoduleHook, submoduleMarker); command(checkout, ['config', 'core.fsmonitor', submoduleHook]); appendFileSync(join(checkout, 'child.txt'), 'dirty\n');
  command(submodule.repo, ['status', '--porcelain=v1']); assert.equal(existsSync(submoduleMarker), true, 'fixture must prove raw Git descends into the dirty submodule'); rmSync(submoduleMarker);
  await submodule.approvals.request(submodule.task, { remote: 'origin', ref: 'refs/heads/main', configRevision: CONFIG_REVISION });
  assert.equal(existsSync(submoduleMarker), false); assertNotPushed(submodule.bare);
});

test('an interrupted one-time attempt is reconciled by remote read and is never blindly retried', async t => {
  const f = fixture(t); const pending = await f.approvals.request(f.task, { remote: 'origin', ref: 'refs/heads/main', configRevision: CONFIG_REVISION }); f.approvals.approve(pending.id, f.actor);
  const record = f.approvals.get(pending.id)!; record.state = 'executing'; record.revision++; record.attemptId = 'simulated-crash';
  approvalRecords(f.store.db).save(record);
  command(f.repo, ['push', f.bare, `${record.target.headSha}:refs/heads/main`]);
  assert.equal(f.approvals.recoverInterrupted(), 1); assert.equal(f.approvals.get(record.id)?.state, 'unknown');
  const reconciled = await f.approvals.reconcile(record.id, f.task, CONFIG_REVISION); assert.equal(reconciled.state, 'succeeded'); assert.equal(reconciled.reason, 'remote_ref_verified_after_unknown');
  await assert.rejects(f.approvals.execute(record.id, f.task, CONFIG_REVISION), /already consumed/);
});

test('unsafe remote schemes, refs, credential helpers, and non-bare local targets fail closed', async t => {
  const f = fixture(t);
  assert.throws(() => new GitApprovals(f.store, { remotes: [{ name: 'origin', url: 'ext::sh -c evil', transport: 'ssh' }] }, new ExecFileGitRunner(git)), /exact URL/);
  assert.throws(() => new GitApprovals(f.store, { remotes: [{ name: 'origin', url: 'https://example.invalid/repo.git', transport: 'https', credentialHelpers: ['!evil'] }] }, new ExecFileGitRunner(git)), /allowlist/);
  await assert.rejects(f.approvals.request(f.task, { remote: 'origin', ref: 'refs/tags/release', configRevision: CONFIG_REVISION }), (error: unknown) => error instanceof ApprovalError && error.code === 'ref_unsafe');
  const ordinary = join(f.root, 'ordinary'); mkdirSync(ordinary);
  const unsafe = new GitApprovals(f.store, { remotes: [{ name: 'local', url: ordinary, transport: 'local-test' }] }, new ExecFileGitRunner(git));
  command(f.repo, ['remote', 'add', 'local', ordinary]);
  await assert.rejects(unsafe.request(f.task, { remote: 'local', ref: 'refs/heads/main', configRevision: CONFIG_REVISION }), (error: unknown) => error instanceof ApprovalError && error.code === 'local_remote_unsafe');
});

test('approval expiry and configuration are rechecked after asynchronous inspection, before consumption', async t => {
  for (const kind of ['expiry', 'config'] as const) {
    const f = fixture(t); let now = 10_000, revision = CONFIG_REVISION, inspecting = false, pushes = 0;
    const underlying = new ExecFileGitRunner(git);
    const approvals = new GitApprovals(f.store, { remotes: [{ name: 'origin', url: f.bare, transport: 'local-test' }] }, {
      async run(cwd, args, timeout) {
        if (args.includes('push')) pushes++;
        const result = await underlying.run(cwd, args, timeout);
        if (inspecting && args.includes('ls-remote')) {
          if (kind === 'expiry') now = 12_000;
          else revision = 'c'.repeat(64);
        }
        return result;
      },
    }, () => now);
    const pending = await approvals.request(f.task, { remote: 'origin', ref: `refs/heads/${kind}`, configRevision: revision, ttlMs: 1_000 });
    approvals.approve(pending.id, f.actor); inspecting = true;
    await assert.rejects(approvals.execute(pending.id, f.task, () => revision), ApprovalError);
    assert.equal(pushes, 0);
    assert.equal(approvals.get(pending.id)?.state, kind === 'expiry' ? 'expired' : 'invalidated');
    assert.throws(() => command(f.bare, ['rev-parse', `refs/heads/${kind}`]));
  }
});
