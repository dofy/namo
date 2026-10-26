import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRuntime, RuntimeError, type WaitRequest } from '../src/runtime.js';

const FAKE = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
const write = value => process.stdout.write(JSON.stringify(value) + '\\n');
let threadParams, cwd, mode, waitParams, waitItem;
const requestWait = (overrides = {}, args = { question: '请选择 A 或 B' }) => {
  waitParams = { threadId: 'thread-one', turnId: 'turn-one', callId: 'call-one', namespace: null,
    tool: 'wait_for_user', arguments: args, ...overrides };
  waitItem = { id: waitParams.callId, type: 'dynamicToolCall', namespace: waitParams.namespace,
    tool: waitParams.tool, arguments: waitParams.arguments, status: 'inProgress', contentItems: null, success: null };
  write({ method: 'item/started', params: { threadId: 'thread-one', turnId: 'turn-one', item: waitItem } });
  write({ id: 900, method: 'item/tool/call', params: waitParams });
};
const requestExternalWait = () => requestWait({ tool: 'wait_for_external' }, {
  owner: 'octo-org', repo: 'app', pull_number: 42, head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  required_checks: [{ kind: 'check_run', context: 'build', app_id: 123 }], timeout_minutes: 30
});
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return write({ id: m.id, result: {} });
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    threadParams = m.params; cwd = m.params.cwd;
    const id = m.params.threadId === 'mismatch-request' ? 'silent-fork' : m.params.threadId || 'thread-one';
    return write({ id: m.id, result: { thread: { id } } });
  }
  if (m.method === 'turn/start') {
    mode = m.params.input[0].text;
    if (mode === 'normal-config') {
      if ('dynamicTools' in threadParams || threadParams.developerInstructions.includes('wait_for_user')) process.exit(20);
      write({ id: m.id, result: { turn: { id: 'turn-one' } } });
      return write({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-one', status: 'completed', items: [] } } });
    }
    if (mode === 'unavailable') {
      if ('dynamicTools' in threadParams || threadParams.developerInstructions.includes('wait_for_user')) process.exit(27);
      write({ id: m.id, result: { turn: { id: 'turn-one' } } });
      return requestWait();
    }
    if (mode === 'resume-wait' && ('dynamicTools' in threadParams || threadParams.threadId !== 'thread-one')) process.exit(21);
    if (mode !== 'resume-wait' && (!threadParams.dynamicTools || threadParams.dynamicTools[0]?.name !== 'wait_for_user'
      || threadParams.dynamicTools[1]?.name !== 'wait_for_external'
      || !threadParams.developerInstructions.includes('/new'))) process.exit(22);
    if (mode === 'wait-fast') {
      requestWait();
      return setTimeout(() => write({ id: m.id, result: { turn: { id: 'turn-one' } } }), 10);
    }
    write({ id: m.id, result: { turn: { id: 'turn-one' } } });
    if (mode === 'active-effect') {
      write({ method: 'item/started', params: { threadId: 'thread-one', turnId: 'turn-one', item: {
        id: 'cmd', type: 'commandExecution', command: 'node task.js', cwd, status: 'inProgress' } } });
      return requestWait();
    }
    if (mode === 'foreign') return requestWait({ threadId: 'foreign-thread' });
    if (mode === 'malformed') return requestWait({}, { question: 'ok', extra: true });
    if (mode === 'choices') return requestWait({}, { question: '选择语言', choices: ['中文', '英文'] });
    if (mode === 'invalid-choices') return requestWait({}, { question: '选择语言', choices: ['中文', '中文'] });
    if (mode === 'external-wait') return requestExternalWait();
    requestWait();
    return;
  }
  if (m.method === 'turn/interrupt') {
    if (m.params.threadId !== 'thread-one' || m.params.turnId !== 'turn-one') process.exit(23);
    write({ id: m.id, result: {} });
    if (mode === 'wait-disconnect' || mode === 'wait-timeout' || mode === 'cancel-wait' || mode === 'post-effect' || mode === 'duplicate') return;
    const item = { ...waitItem, status: 'completed', success: true, contentItems: [{ type: 'inputText', text: 'stored' }] };
    write({ method: 'item/completed', params: { threadId: 'thread-one', turnId: 'turn-one', item } });
    const items = mode === 'unsettled-terminal' ? [item, { id: 'async-command', type: 'commandExecution',
      command: 'long-running', cwd, status: 'inProgress' }] : [item];
    write({ method: 'turn/completed', params: { threadId: 'thread-one', turn: {
      id: 'turn-one', status: mode === 'close-after-completed' ? 'completed' : 'interrupted', items } } });
    if (mode === 'close-after-completed') setImmediate(() => process.exit(0));
    return;
  }
  if (m.id === 900) {
    if (mode === 'storage-error') {
      if (!m.error || m.result) process.exit(24);
      return;
    }
    if (mode === 'unavailable') {
      if (!m.error || m.result) process.exit(28);
      return;
    }
    if (m.error || !existsSync(cwd + '/persisted') || m.result?.success !== true) process.exit(25);
    const body = JSON.parse(m.result.contentItems?.[0]?.text || '{}');
    if (m.result.contentItems?.[0]?.type !== 'inputText' || body.status !== 'waiting' || body.wait_id !== 'wait-db-one') process.exit(26);
    if (mode === 'post-effect') return write({ method: 'item/started', params: { threadId: 'thread-one', turnId: 'turn-one', item: {
      id: 'late', type: 'mcpToolCall', server: 'remote', tool: 'mutate', status: 'inProgress' } } });
    if (mode === 'duplicate') return write({ id: 901, method: 'item/tool/call', params: { ...waitParams, callId: 'call-two' } });
    if (mode === 'wait-disconnect') return setTimeout(() => process.exit(1), 5);
  }
});
`;

function fixture(t: { after: (fn: () => void) => void }, timeoutMs = 500) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-wait-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'codex.mjs');
  writeFileSync(bin, FAKE, { mode: 0o700 });
  return { dir, runtime: new CodexRuntime({ bin, home: join(dir, 'home'), timeoutMs, sandbox: 'read-only' }) };
}

function waitRun(runtime: CodexRuntime, dir: string, prompt: string, extra: Partial<Parameters<CodexRuntime['run']>[0]> = {}) {
  return runtime.run({ cwd: dir, prompt, signal: new AbortController().signal, onThread() {}, onTurn() {},
    onWait(request) { writeFileSync(join(dir, 'persisted'), request.question); return 'wait-db-one'; }, ...extra });
}

test('fast wait is durably stored before acknowledgement, interrupts the exact turn, and returns only after completion', async t => {
  const { dir, runtime } = fixture(t);
  const requests: WaitRequest[] = [];
  let executionEvents = 0;
  let steerReceipt: Promise<string> | undefined;
  const result = await waitRun(runtime, dir, 'wait-fast', { onWait(request) {
    requests.push(request); writeFileSync(join(dir, 'persisted'), request.question); return 'wait-db-one';
  }, onReady(controls) { steerReceipt = controls.steer('must not be sent'); }, onEvidence() { executionEvents++; } });
  assert.deepEqual(requests, [{ threadId: 'thread-one', turnId: 'turn-one', callId: 'call-one', question: '请选择 A 或 B' }]);
  assert.deepEqual(result, { text: '', threadId: 'thread-one', turnId: 'turn-one', waiting: { id: 'wait-db-one', ...requests[0] } });
  assert.equal(await steerReceipt, 'not_active');
  assert.equal(executionEvents, 0, 'wait control events belong in the wait ledger, not execution evidence');
});

test('a resumed legacy thread accepts its persisted wait tool without sending dynamicTools again', async t => {
  const { dir, runtime } = fixture(t);
  const result = await waitRun(runtime, dir, 'resume-wait', { threadId: 'thread-one' });
  assert.equal(result.waiting?.id, 'wait-db-one');
});

test('structured choices are preserved before wait acknowledgement and malformed choices fail closed', async t => {
  const f = fixture(t); const result = await waitRun(f.runtime, f.dir, 'choices');
  assert.deepEqual(result.waiting?.choices, ['中文','英文']);
  const invalid = fixture(t);
  await assert.rejects(waitRun(invalid.runtime, invalid.dir, 'invalid-choices'),
    (e: unknown) => e instanceof RuntimeError && e.code === 'wait_protocol_error');
  assert.equal(existsSync(join(invalid.dir, 'persisted')), false);
});

test('external wait uses the same durable ACK, interrupt and terminal-turn protocol with validated arguments', async t => {
  const f = fixture(t); const requests: WaitRequest[] = [];
  const result = await waitRun(f.runtime, f.dir, 'external-wait', { onWait(request) {
    requests.push(request); writeFileSync(join(f.dir, 'persisted'), request.question); return 'wait-db-one';
  } });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].external, { target: { owner: 'octo-org', repo: 'app', pullNumber: 42,
    headSha: 'a'.repeat(40) }, requiredChecks: [{ kind: 'check_run', context: 'build', appId: 123 }], timeoutMs: 1_800_000 });
  assert.match(requests[0].question, /octo-org\/app#42/);
  assert.deepEqual(result.waiting, { id: 'wait-db-one', ...requests[0] });
});

test('resume refuses a response that silently forks to a different thread id', async t => {
  const { dir, runtime } = fixture(t);
  await assert.rejects(waitRun(runtime, dir, 'unused', { threadId: 'mismatch-request' }),
    (error: unknown) => error instanceof RuntimeError && error.code === 'thread_mismatch');
});

test('wait storage failure rejects before any success acknowledgement', async t => {
  const { dir, runtime } = fixture(t);
  await assert.rejects(waitRun(runtime, dir, 'storage-error', { onWait() { throw new Error('private database detail'); } }),
    (error: unknown) => error instanceof RuntimeError && error.code === 'wait_storage_error');
  assert.equal(existsSync(join(dir, 'persisted')), false);
});

test('foreign and malformed wait requests are protocol errors, never successful waits', async t => {
  for (const prompt of ['foreign', 'malformed']) {
    const { dir, runtime } = fixture(t);
    await assert.rejects(waitRun(runtime, dir, prompt),
      (error: unknown) => error instanceof RuntimeError && error.code === 'wait_protocol_error');
  }
});

test('an active effect, a post-wait effect, and a second wait are rejected conservatively', async t => {
  for (const prompt of ['active-effect', 'post-effect', 'duplicate', 'unsettled-terminal']) {
    const { dir, runtime } = fixture(t);
    await assert.rejects(waitRun(runtime, dir, prompt),
      (error: unknown) => error instanceof RuntimeError && error.code === 'wait_protocol_error');
  }
});

test('pending waits fail on disconnect and cancellation instead of being reported as waiting', async t => {
  const { dir, runtime } = fixture(t);
  await assert.rejects(waitRun(runtime, dir, 'wait-disconnect'),
    (error: unknown) => error instanceof RuntimeError && error.code === 'runtime_disconnected');

  const timed = fixture(t, 80);
  await assert.rejects(waitRun(timed.runtime, timed.dir, 'wait-timeout'),
    (error: unknown) => error instanceof RuntimeError && error.code === 'turn_timeout');

  const next = fixture(t); const abort = new AbortController();
  await assert.rejects(waitRun(next.runtime, next.dir, 'cancel-wait', { signal: abort.signal, onWait(request) {
    writeFileSync(join(next.dir, 'persisted'), request.question); setTimeout(() => abort.abort(), 5); return 'wait-db-one';
  } }), (error: unknown) => error instanceof RuntimeError && error.code === 'cancelled');
});

test('transport closure after a completed wait turn cannot turn success into disconnect', async t => {
  const { dir, runtime } = fixture(t);
  const result = await waitRun(runtime, dir, 'close-after-completed');
  assert.equal(result.waiting?.id, 'wait-db-one');
});

test('a tool call without a durable wait callback is rejected as a protocol error', async t => {
  const { dir, runtime } = fixture(t);
  await assert.rejects(runtime.run({ cwd: dir, prompt: 'unavailable', signal: new AbortController().signal,
    onThread() {}, onTurn() {} }), (error: unknown) => error instanceof RuntimeError && error.code === 'wait_protocol_error');
});

test('normal runs do not expose the wait tool and still reject empty completions', async t => {
  const { dir, runtime } = fixture(t);
  await assert.rejects(runtime.run({ cwd: dir, prompt: 'normal-config', signal: new AbortController().signal,
    onThread() {}, onTurn() {} }), (error: unknown) => error instanceof RuntimeError && error.code === 'empty_reply');
});
