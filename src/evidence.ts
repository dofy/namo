import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Store } from './store.js';
import type { EvidenceItem, EvidenceStatus, RunEvidence } from './ui-contract.js';
import { makeRedactor } from './safety.js';

const MAX_ITEMS = 60, MAX_FILES = 8, MAX_PATH = 240;
const within = (root: string, path: string) => {
  const r = relative(root, path);
  return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
};
const status = (s: unknown): EvidenceStatus => s === 'inProgress' ? 'running'
  : ['completed', 'failed', 'declined'].includes(String(s)) ? s as EvidenceStatus : 'unknown';

// Only fixed, recognized labels survive. Shell text, arguments, output and diffs
// can contain arbitrary secrets; redacting known token formats is not sufficient.
function commandLabel(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 8000) return '命令（参数未保存）';
  let command = raw.trim();
  const shell = command.match(/^(?:\/(?:bin|usr\/bin)\/)?(?:ba|z)?sh -[a-z]*c (['"])([\s\S]*)\1$/);
  if (shell) command = shell[2].trim();
  if (/[;&|\x60$<>\n\r]/.test(command)) return '脚本（内容未保存）';
  const packageTask = command.match(/^(pnpm|npm) (?:run )?(test|build|lint|typecheck|check|smoke:codex)(?: |$)/);
  if (packageTask) return packageTask[1] + ' ' + packageTask[2];
  const git = command.match(/^git (status|diff|log|show|rev-parse|add|commit)(?: |$)/);
  if (git) return 'git ' + git[1];
  if (/^node --test(?: |$)/.test(command)) return 'node --test';
  const name = command.match(/^(node|python3?|swift|cargo|go|rg|ls|cat|sed|find|curl)(?: |$)/)?.[1];
  return name ? name + '（参数未保存）' : '命令（参数未保存）';
}

/** Bounded protocol projection. Never retain tool output, arguments or patch text. */
export function projectEvidenceItem(raw: unknown): EvidenceItem | undefined {
  if (!raw || typeof raw !== 'object') return;
  const item = raw as Record<string, any>;
  if (typeof item.id !== 'string' || !item.id || item.id.length > 256) return;
  const id = createHash('sha256').update(item.id).digest('hex').slice(0, 16);
  const base = { id, status: status(item.status) };
  const path = (p: unknown) => typeof p === 'string' && p.length <= 4096 ? p : '';
  if (item.type === 'commandExecution') return { ...base, kind: 'command', label: commandLabel(item.command), cwd: path(item.cwd),
    ...(Number.isSafeInteger(item.exitCode) ? { exitCode: item.exitCode } : {}),
    ...(Number.isSafeInteger(item.durationMs) && item.durationMs >= 0 ? { durationMs: item.durationMs } : {}) };
  if (item.type === 'fileChange') {
    const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
    return { ...base, kind: 'files', label: '文件补丁', limited: changes.length > MAX_FILES,
      files: changes.slice(0, MAX_FILES).flatMap(c => c && ['add', 'update', 'delete'].includes(c.kind?.type)
        ? [{ path: path(c.path), action: c.kind.type, ...(c.kind.move_path ? { movedTo: path(c.kind.move_path) } : {}) }] : []) };
  }
  if (item.type === 'imageGeneration') return { ...base, kind: 'artifact', label: '生成图片', path: path(item.savedPath) };
  if (['mcpToolCall', 'dynamicToolCall'].includes(item.type)) return { ...base, kind: 'tool', label: '其他工具（未采集内容）', limited: true };
}

export class EvidenceRecorder {
  readonly report: RunEvidence;
  private readonly root: string;
  private readonly redact: (text: string) => string;
  constructor(private store: Store, runId: string, cwd: string, private denyPaths: string[] = [], redact = makeRedactor()) {
    this.root = realpathSync(cwd);
    const generic = makeRedactor();
    this.redact = text => generic(redact(text));
    this.report = { version: 1, runId, state: 'collecting', truncated: false, items: [],
      git: { before: this.head(), after: null, status: 'unavailable' } };
    this.save();
  }
  private head(): string | null {
    const git = (args: string[]) => spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', this.root, ...args], {
      encoding: 'utf8', timeout: 1000, maxBuffer: 4096,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
    });
    try {
      const top = git(['rev-parse', '--show-toplevel']);
      if (top.status !== 0 || realpathSync(top.stdout.trim()) !== this.root) return null;
      const result = git(['rev-parse', '--verify', 'HEAD']);
      return result.status === 0 && /^[a-f0-9]{40,64}$/.test(result.stdout.trim()) ? result.stdout.trim() : null;
    } catch { return null; }
  }
  private safePath(raw?: string, allowRoot = false): string | undefined {
    if (!raw || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(raw)) return;
    const full = resolve(this.root, raw);
    if (!within(this.root, full) || this.denyPaths.some(p => within(resolve(p), full))) return;
    const rel = relative(this.root, full).split(sep).join('/');
    if ((!rel && !allowRoot) || rel.length > MAX_PATH || this.redact(rel) !== rel) return;
    if (rel.split('/').some(p => /^(?:\.env(?:\.|$)|\.git$|\.codex$|\.ssh$|config\.local|auth\.json$)|(?:token|credential|secret)|\.(?:pem|key)$/i.test(p))) return;
    try {
      let parent = full;
      while (parent !== dirname(parent)) {
        try { lstatSync(parent); break; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return; parent = dirname(parent); }
      }
      const physical = realpathSync(parent);
      if (!within(this.root, physical) || this.denyPaths.some(p => within(resolve(p), physical))) return;
    } catch { return; }
    return rel || '.';
  }
  observe(item: EvidenceItem): void {
    if (this.report.state !== 'collecting') return;
    const prior = this.report.items.findIndex(x => x.id === item.id);
    if (prior >= 0 && this.report.items[prior].status !== 'running' && item.status === 'running') return;
    if (prior < 0 && this.report.items.length >= MAX_ITEMS) {
      if (!this.report.truncated) { this.report.truncated = true; this.save(); }
      return;
    }
    const next = { ...item };
    if (next.cwd !== undefined) { next.cwd = this.safePath(next.cwd, true); if (!next.cwd) next.limited = true; }
    if (next.path !== undefined) { next.path = this.safePath(next.path); if (!next.path) next.limited = true; }
    if (next.files) {
      next.files = next.files.flatMap(f => {
        const path = this.safePath(f.path), movedTo = f.movedTo ? this.safePath(f.movedTo) : undefined;
        if (!path || (f.movedTo && !movedTo)) { next.limited = true; return []; }
        return [{ path, action: f.action, ...(movedTo ? { movedTo } : {}) }];
      });
    }
    if (prior < 0) this.report.items.push(next); else this.report.items[prior] = next;
    this.save();
  }
  finish(complete: boolean): void {
    this.report.state = complete ? 'finished' : 'partial';
    const fileExists = (p: string) => {
      if (!this.safePath(p)) return false;
      try { return statSync(resolve(this.root, p)).isFile(); } catch { return false; }
    };
    for (const item of this.report.items) {
      if (item.status === 'running') item.status = 'unknown';
      if (item.status !== 'completed') continue;
      if (item.path) item.existsAtFinish = fileExists(item.path);
      for (const f of item.files ?? []) if (f.action !== 'delete') f.existsAtFinish = fileExists(f.movedTo ?? f.path);
    }
    const after = this.head(), before = this.report.git.before;
    this.report.git = { before, after, status: before && after ? before === after ? 'unchanged' : 'changed' : 'unavailable' };
    this.save();
  }
  private save(): void {
    this.store.db.prepare('INSERT INTO run_evidence(runId,report) VALUES(?,?) ON CONFLICT(runId) DO UPDATE SET report=excluded.report')
      .run(this.report.runId, JSON.stringify(this.report));
  }
}

export function readEvidence(store: Store, taskId: string): RunEvidence[] {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='run_evidence'").get()) return [];
  const rows = store.db.prepare('SELECT e.report,r.state FROM task_runs r JOIN run_evidence e ON e.runId=r.id WHERE r.taskId=? ORDER BY r.startedAt').all(taskId);
  return rows.map(row => {
    const report = JSON.parse(String(row.report)) as RunEvidence;
    if (report.state === 'collecting' && row.state !== 'running') {
      report.state = 'partial';
      report.items = report.items.map(i => i.status === 'running' ? { ...i, status: 'unknown' } : i);
    }
    return report;
  });
}

const stateLabel = { running: '执行中', completed: '已结束', failed: '失败', declined: '被拒绝', unknown: '结果未知' };
export function evidenceSummary(e: RunEvidence): string {
  if (!e.items.length && e.git.status !== 'changed') return '';
  const lines = ['执行记录（有限采集）'];
  const commands = e.items.filter(i => i.kind === 'command');
  for (const c of commands.slice(0, 4)) lines.push('命令：' + c.label + ' · ' + stateLabel[c.status] + (c.exitCode !== undefined ? ' · 退出码 ' + c.exitCode : ' · 无退出码'));
  const patches = e.items.filter(i => i.kind === 'files');
  for (const item of patches.slice(0, 4)) for (const f of (item.files ?? []).slice(0, 3)) lines.push('文件：' + f.path + (f.movedTo ? ' → ' + f.movedTo : '') + ' · ' + stateLabel[item.status]);
  const outputs = e.items.flatMap(i => i.status === 'completed'
    ? [...(i.path ? [i.path] : []), ...(i.files ?? []).filter(f => f.action === 'add' && f.existsAtFinish).map(f => f.path)] : []);
  for (const p of [...new Set(outputs)].slice(0, 3)) lines.push('产物线索：' + p);
  if (e.git.status === 'changed') lines.push('期间 HEAD：' + e.git.before!.slice(0, 12) + ' → ' + e.git.after!.slice(0, 12) + '（未核实归属）');
  if (e.state === 'partial') lines.push('执行未完整结束，记录可能不完整；已发生的操作不会自动撤销。');
  if (e.truncated || e.items.some(i => i.limited) || commands.length > 4 || patches.length > 4 || patches.some(i => (i.files?.length ?? 0) > 3) || outputs.length > 3)
    lines.push('部分记录已省略；已保存的记录可在工作台任务详情查看。');
  lines.push('退出码不代表任务验收通过；未覆盖所有脚本或工具改动，文件内容与产物质量尚未核验。');
  return '\n\n' + lines.join('\n');
}
