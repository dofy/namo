import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { processState } from '../src/runner-store.js';
import { RunnerRuntime } from '../src/runner.js';
import { RuntimeError, type RunRequest, type RunResult, type Runtime } from '../src/runtime.js';
import { Store, type Incoming } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { Waits } from '../src/waits.js';

const until = async (predicate: () => boolean, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition_timeout');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

const FAKE_CODEX = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let cwd, thread = 'thread-durable', turn, waitItem, waitParams, count = 0;
const finish = text => {
  const item = { id: 'final-' + count, type: 'agentMessage', phase: 'final_answer', text };
  send({ method: 'item/completed', params: { threadId: thread, turnId: turn, item } });
  send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed', items: [item] } } });
};
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({ id: m.id, result: {} });
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    cwd = m.params.cwd; thread = m.params.threadId || 'thread-durable';
    if (m.method === 'thread/resume' && ('dynamicTools' in m.params || thread !== 'thread-durable')) process.exit(31);
    return send({ id: m.id, result: { thread: { id: thread } } });
  }
  if (m.method === 'turn/start') {
    count++; turn = 'turn-' + count;
    appendFileSync(join(cwd, 'calls'), 'turn\\n');
    const prompt = JSON.parse(m.params.input[0].text);
    send({ id: m.id, result: { turn: { id: turn } } });
    if (prompt.type === 'task_resume') {
      if (prompt.question !== 'Which branch?' || prompt.reply !== 'take blue' || 'messages' in prompt
        || JSON.stringify(prompt).includes('ORIGINAL_DETACHED_MARKER')) process.exit(32);
      writeFileSync(join(cwd, 'resume-prompt.json'), JSON.stringify(prompt));
      return finish('resumed once');
    }
    waitParams = { threadId: thread, turnId: turn, callId: 'call-durable', namespace: null,
      tool: 'wait_for_user', arguments: { question: 'Which branch?' } };
    waitItem = { id: waitParams.callId, type: 'dynamicToolCall', namespace: null, tool: 'wait_for_user',
      arguments: waitParams.arguments, status: 'inProgress', contentItems: null, success: null };
    send({ method: 'item/started', params: { threadId: thread, turnId: turn, item: waitItem } });
    return send({ id: 900, method: 'item/tool/call', params: waitParams });
  }
  if (m.id === 900) {
    if (m.error || m.result?.success !== true) process.exit(33);
    const database = join(dirname(cwd), 'data', 'bot.sqlite');
    const db = new DatabaseSync(database, { readOnly: true });
    const row = db.prepare("SELECT id,state,question FROM task_waits WHERE callId='call-durable'").get(); db.close();
    const body = JSON.parse(m.result.contentItems?.[0]?.text || '{}');
    if (!row || row.state !== 'requested' || row.question !== 'Which branch?' || body.wait_id !== row.id) process.exit(34);
    writeFileSync(join(cwd, 'ack-after-durable'), row.id);
    return;
  }
  if (m.method === 'turn/interrupt') {
    send({ id: m.id, result: {} });
    const item = { ...waitItem, status: 'completed', success: true,
      contentItems: [{ type: 'inputText', text: 'durably stored' }] };
    send({ method: 'item/completed', params: { threadId: thread, turnId: turn, item } });
    return send({ method: 'turn/completed', params: { threadId: thread,
      turn: { id: turn, status: 'interrupted', items: [item] } } });
  }
});
`;

function incoming(key: string, text = 'ORIGINAL_DETACHED_MARKER'): Incoming {
  return { key, messageId: key, chatKey: 'chat', chatId: 'chat', senderId: 'alice', text,
    envelope: { version: 1, type: 'text', kind: 'instruction', scopeKey: 'chat', chatType: 'p2p',
      materials: [], limitations: [] } };
}

class HeldCompletedRunner implements Runtime {
  readonly persistent = true;
  completed?: () => void;
  constructor(private inner: RunnerRuntime) {}
  reservations() { return this.inner.reservations(); }
  async run(request: RunRequest): Promise<RunResult> {
    await this.inner.run(request); this.completed?.();
    // Hold the observer after the worker's terminal commit so stop() exercises
    // the exact completed-worker / not-yet-parked receiver crash window.
    return new Promise<RunResult>((_resolve, reject) => {
      const abort = () => { cleanup(); reject(new RuntimeError('receiver_detached')); };
      const cleanup = () => request.signal.removeEventListener('abort', abort);
      if (request.signal.aborted) abort();
      else request.signal.addEventListener('abort', abort, { once: true });
    });
  }
}

test('detached worker durably requests a wait before ACK, survives receiver loss before park, exits, and resumes once', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'namo-runner-wait-')));
  const data = join(root, 'data'), project = join(root, 'project'); mkdirSync(data); mkdirSync(project);
  const bin = join(root, 'fake-codex.mjs'); writeFileSync(bin, FAKE_CODEX, { mode: 0o700 });
  const file = join(root, 'config.json');
  writeFileSync(file, JSON.stringify({ dataDir: data,
    feishu: { appId: 'app', appSecret: 'TEST_ONLY_SECRET', allowedUserIds: ['alice'] }, concurrency: 1,
    codex: { bin, home: join(data, 'home'), timeoutMs: 5000, sandbox: 'workspace-write',
      projects: { one: project }, defaultProject: 'one' } }));
  const config = loadConfig(file), store = new Store(join(data, 'bot.sqlite')), tasks = new Tasks(store);
  const engines: Engine[] = []; const deliveries: string[] = [];
  const sender = { async send(_chat: string, text: string, uuid: string) { deliveries.push(text); return uuid; } };
  t.after(async () => {
    for (const engine of engines) await engine.stop();
    for (const row of store.db.prepare('SELECT pid,runtimePid FROM runner_jobs').all()) {
      if (row.runtimePid) { try { process.kill(-Number(row.runtimePid), 'SIGKILL'); } catch {} }
      if (row.pid) { try { process.kill(Number(row.pid), 'SIGKILL'); } catch {} }
    }
    store.close(); rmSync(root, { recursive: true, force: true });
  });

  const held = new HeldCompletedRunner(new RunnerRuntime(store, config));
  let workerCompleted!: () => void; const completed = new Promise<void>(resolve => { workerCompleted = resolve; });
  held.completed = workerCompleted;
  const first = new Engine(store, held, sender, config); engines.push(first); first.start(); first.accept(incoming('first'));
  await completed;
  const job = store.db.prepare('SELECT * FROM runner_jobs ORDER BY createdAt DESC LIMIT 1').get();
  assert.equal(job?.state, 'completed'); assert.equal(existsSync(join(project, 'ack-after-durable')), true);
  const requested = store.db.prepare("SELECT * FROM task_waits WHERE callId='call-durable'").get();
  assert.equal(requested?.state, 'requested'); assert.equal(requested?.question, 'Which branch?');
  await first.stop();
  const taskId = store.get('first')!.taskId!;
  // The durable terminal record can be observed before the worker exits.
  // Wait for process exit rather than equating a committed result with exit.
  await until(() => processState(Number(job?.pid)) === 'dead');
  assert.equal(tasks.get(taskId)?.state, 'running'); assert.equal(processState(Number(job?.pid)), 'dead');

  const second = new Engine(store, new RunnerRuntime(store, config), sender, config); engines.push(second); second.start();
  await until(() => tasks.get(taskId)?.state === 'waiting');
  const open = new Waits(store).current(taskId)!;
  assert.equal(open.id, requested?.id); assert.equal(open.state, 'open');
  second.accept(incoming('resume', `/resume ${open.id} take blue`));
  await until(() => tasks.get(taskId)?.state === 'succeeded');
  assert.equal(readFileSync(join(project, 'calls'), 'utf8').trim().split('\n').length, 2);
  const resume = JSON.parse(readFileSync(join(project, 'resume-prompt.json'), 'utf8'));
  assert.equal(resume.type, 'task_resume'); assert.equal(resume.question, 'Which branch?'); assert.equal(resume.reply, 'take blue');
  assert.equal('messages' in resume, false); assert.doesNotMatch(JSON.stringify(resume), /ORIGINAL_DETACHED_MARKER/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE taskId=?').get(taskId)?.n, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM runner_events WHERE kind='wait_requested'").get()?.n, 1);
  await until(() => deliveries.filter(text => text.includes('resumed once')).length === 1);
  await until(() => (store.db.prepare('SELECT pid FROM runner_jobs ORDER BY createdAt DESC LIMIT 1').get()?.pid
    ? processState(Number(store.db.prepare('SELECT pid FROM runner_jobs ORDER BY createdAt DESC LIMIT 1').get()?.pid)) === 'dead' : false));
});
