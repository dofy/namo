import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { recordProgress, readProgress, type PublicProgressEvent } from '../src/public-progress.js';
import { makeRedactor } from '../src/safety.js';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-public-progress-')), database = join(dir, 'db');
  let store = new Store(database);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.enqueue({ key: 'm', messageId: 'original', chatId: 'chat', chatKey: 'app:chat', senderId: 'owner', text: 'work' });
  const tasks = new Tasks(store), task = tasks.create(store.get('m')!, { cwd: dir, policyHash: 'policy' });
  const run = tasks.start(task); tasks.saveRun(run, 'thread', 'turn');
  return { store, tasks, task, run, reopen() { store.close(); store = new Store(database); return store; } };
}
const event = (id: string, text: string, status: PublicProgressEvent['status'] = 'completed'): PublicProgressEvent =>
  ({ id, kind: 'tool', text, status, threadId: 'thread', turnId: 'turn' });

test('bounded public progress survives reopening and deduplicates completed tools and late starts', t => {
  const f = fixture(t);
  for (let i = 0; i < 270; i++) recordProgress(f.store, f.run, event('tool-' + i, '已完成命令 ' + i));
  const before = readProgress(f.store, f.run)!;
  assert.equal(before.revision, 270); assert.equal(before.events.length, 5); assert.equal(before.seen.length, 256);
  assert.deepEqual(before.events.map(e => e.sequence), [266, 267, 268, 269, 270]);
  assert.ok(before.events.every(e => e.id.length === 24 && !e.id.includes('tool-')));
  const reopened = f.reopen(); assert.deepEqual(readProgress(reopened, f.run), before);
  recordProgress(reopened, f.run, event('tool-269', '已完成命令 269'));
  recordProgress(reopened, f.run, event('tool-269', '旧的开始事件', 'running'));
  assert.equal(readProgress(reopened, f.run)!.revision, 270);
  recordProgress(reopened, f.run, event('tool-269', '已完成命令 269，退出码 0'));
  assert.equal(readProgress(reopened, f.run)!.revision, 271);
  assert.equal(readProgress(reopened, f.run)!.events.length, 5);
});

test('public progress rejects foreign turns, obsolete runs and terminal tasks', t => {
  const f = fixture(t), input = event('safe', '可公开的摘要');
  recordProgress(f.store, f.run, { ...input, threadId: 'foreign' });
  recordProgress(f.store, f.run, { ...input, turnId: 'old-turn' });
  recordProgress(f.store, 'missing-run', input); assert.equal(readProgress(f.store, f.run), undefined);
  f.store.db.prepare("INSERT INTO task_runs(id,taskId,inputVersion,state,threadId,turnId,startedAt) VALUES(?,?,1,'running','thread','turn',?)")
    .run('newer-run', f.task.id, Date.now());
  recordProgress(f.store, f.run, input); assert.equal(readProgress(f.store, f.run), undefined);
  recordProgress(f.store, 'newer-run', input); assert.equal(readProgress(f.store, 'newer-run')!.revision, 1);
  f.store.db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(f.task.id);
  recordProgress(f.store, 'newer-run', { ...input, id: 'late' }); assert.equal(readProgress(f.store, 'newer-run')!.revision, 1);
});

test('public projection removes configured secrets, URLs, local paths, code, markup and controls before storing', t => {
  const f = fixture(t), secret = 'private-configured-token';
  recordProgress(f.store, f.run, { ...event('unsafe', ''), kind: 'commentary', text:
    `检查 ${secret} ghp_12345678901234567890 https://example.test/private /Users/seven/private ./local/file C:\\private\\file <at user_id="all">所有人</at> \u202e\n\`\`\`sh\nPRIVATE_CODE\n\`\`\` \`PRIVATE_INLINE_COMMAND --arg\` 结束` }, makeRedactor([secret]));
  const report = readProgress(f.store, f.run)!, raw = JSON.stringify(report);
  assert.doesNotMatch(raw, /private-configured-token|ghp_|example\.test|Users|local\/file|private\\\\file|<at|PRIVATE_CODE|PRIVATE_INLINE_COMMAND|\u202e/);
  assert.match(report.events[0].text, /REDACTED/); assert.match(report.events[0].text, /链接已省略/);
  assert.match(report.events[0].text, /路径已省略/); assert.match(report.events[0].text, /代码已省略/);
  recordProgress(f.store, f.run, { ...event('truncated-inline', '正在检查 `PRIVATE_UNCLOSED_COMMAND --argument'), kind: 'commentary' });
  assert.doesNotMatch(JSON.stringify(readProgress(f.store, f.run)), /PRIVATE_UNCLOSED_COMMAND|--argument/);
  recordProgress(f.store, f.run, { ...event('bounded', '船'.repeat(500)), kind: 'commentary' });
  assert.equal(Array.from(readProgress(f.store, f.run)!.events.at(-1)!.text).length, 180);
});

test('plan fractions and revisions stay readable, including replanning after completion', t => {
  const f = fixture(t), plan: PublicProgressEvent = { ...event('plan', '计划：已完成 1/2 项', 'running'), kind: 'plan' };
  recordProgress(f.store, f.run, plan); recordProgress(f.store, f.run, plan);
  assert.equal(readProgress(f.store, f.run)!.revision, 1);
  assert.equal(readProgress(f.store, f.run)!.events[0].text, '计划：已完成 1/2 项');
  recordProgress(f.store, f.run, { ...plan, text: '计划：已完成 2/2 项', status: 'completed' });
  recordProgress(f.store, f.run, { ...plan, text: '计划：已完成 2/3 项' });
  const report = readProgress(f.store, f.run)!;
  assert.equal(report.revision, 3); assert.equal(report.events.length, 1);
  assert.equal(report.events[0].text, '计划：已完成 2/3 项'); assert.equal(report.events[0].status, 'running');
});
