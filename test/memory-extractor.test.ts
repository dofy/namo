import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import type { AutoMemoryInput } from '../src/auto-memory.js';
import { extractConversationMemory, RuntimeError } from '../src/runtime.js';

const input: AutoMemoryInput = { ownerId: 'fixture-user', chatKey: 'fixture-dm', chatType: 'p2p', project: 'fixture-project', existing: [],
  messages: [{ messageId: 'fixture-message', text: 'I prefer concise answers.' }] };

function fixture(t: TestContext, mode: 'complete' | 'tool' | 'hang' | 'ignore-init' | 'ignore-thread' | 'ignore-turn' = 'complete') {
  const dir = mkdtempSync(join(tmpdir(), 'namo-memory-extractor-')), home = join(dir, 'home'), trace = join(dir, 'protocol.jsonl');
  mkdirSync(home);
  const bin = join(dir, 'codex.mjs');
  writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const record = value => appendFileSync(${JSON.stringify(trace)}, JSON.stringify(value)+'\\n');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const mode = ${JSON.stringify(mode)};
if(mode.startsWith('ignore-')) process.on('SIGTERM', () => record({kind:'ignored-sigterm'}));
record({kind:'spawn',pid:process.pid,argv:process.argv.slice(2),home:process.env.CODEX_HOME});
createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line); record({kind:'request',...request});
  if(request.method==='initialize') return mode==='ignore-init' ? undefined : send({id:request.id,result:{}});
  if(request.method==='thread/start') return mode==='ignore-thread' ? undefined : send({id:request.id,result:{thread:{id:'extract-thread'}}});
  if(request.method!=='turn/start') return;
  if(mode==='ignore-turn') return;
  if(${JSON.stringify(mode)}==='tool') {
    send({method:'item/started',params:{threadId:'extract-thread',turnId:'extract-turn',item:{id:'forbidden-tool',type:'commandExecution',command:'echo forbidden',status:'inProgress'}}});
    return send({id:request.id,result:{turn:{id:'extract-turn'}}});
  }
  if(${JSON.stringify(mode)}==='hang') return send({id:request.id,result:{turn:{id:'extract-turn'}}});
  send({method:'item/completed',params:{threadId:'foreign-thread',turnId:'extract-turn',item:{id:'foreign-answer',type:'agentMessage',phase:'final_answer',text:'WRONG'}}});
  send({method:'item/completed',params:{threadId:'extract-thread',turnId:'extract-turn',item:{id:'commentary',type:'agentMessage',phase:'commentary',text:'PRIVATE_PROGRESS'}}});
  send({method:'turn/completed',params:{threadId:'extract-thread',turn:{id:'extract-turn',status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text:'{"memories":[]}' }]}}});
  send({id:request.id,result:{turn:{id:'extract-turn'}}});
});
record({kind:'ready'});
`, { mode: 0o700 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config: Config['codex'] = { bin, home, sandbox: 'workspace-write', timeoutMs: 3000, networkAccess: true,
    readPaths: ['/fixture-host-path'], model: 'fixture-model' };
  const records = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { home, config, records };
}

test('memory extraction uses an ephemeral constrained official-provider turn and handles completion before start response', async t => {
  const f = fixture(t);
  assert.deepEqual(await extractConversationMemory(f.config, input, new AbortController().signal), { memories: [] });
  const records = f.records(), spawn = records.find(row => row.kind === 'spawn');
  assert.equal(spawn.home, f.home);
  for (const setting of ['model_provider="openai"', 'features.shell_tool=false', 'features.plugins=false', 'features.apps=false',
    'features.hooks=false', 'mcp_servers={}', 'web_search="disabled"', 'permissions.feishu-bot.network.enabled=false']) {
    assert.ok(spawn.argv.includes(setting), 'extractor must pass ' + setting);
  }
  assert.ok(!spawn.argv.some((arg: string) => arg.includes('/fixture-host-path')));
  const filesystem = spawn.argv.find((arg: string) => arg.startsWith('permissions.feishu-bot.filesystem='));
  assert.match(filesystem, /":workspace_roots"="read"/); assert.doesNotMatch(filesystem, /"write"/);
  const requests = records.filter(row => row.kind === 'request');
  assert.deepEqual(requests.map(row => row.method), ['initialize', 'initialized', 'thread/start', 'turn/start']);
  assert.equal(requests[0].params.clientInfo.name, 'namo-memory');
  const thread = requests.find(row => row.method === 'thread/start').params;
  assert.equal(thread.ephemeral, true); assert.equal(thread.modelProvider, 'openai'); assert.equal(thread.model, 'fixture-model');
  assert.equal(thread.cwd, f.home); assert.equal(thread.permissions, 'feishu-bot'); assert.equal(thread.approvalPolicy, 'never');
  assert.match(thread.baseInstructions, /Never use tools/); assert.match(thread.developerInstructions, /逐字 quote/);
  const turn = requests.find(row => row.method === 'turn/start').params;
  assert.deepEqual(JSON.parse(turn.input[0].text), input); assert.equal(turn.threadId, 'extract-thread');
  assert.equal(turn.outputSchema.additionalProperties, false); assert.deepEqual(turn.outputSchema.required, ['memories']);
  assert.equal(turn.outputSchema.properties.memories.maxItems, 8);
  assert.deepEqual(turn.outputSchema.properties.memories.items.properties.privacy.enum, ['shared', 'private', 'chat']);
  assert.equal(existsSync(join(f.home, 'sessions')), false);
  assert.throws(() => process.kill(spawn.pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
});

test('memory extractor rejects an attempted tool call and closes its owned process', async t => {
  const f = fixture(t, 'tool');
  await assert.rejects(extractConversationMemory(f.config, input, new AbortController().signal),
    (error: unknown) => error instanceof RuntimeError && ['memory_extraction_tool_rejected', 'runtime_disconnected'].includes(error.code));
  const spawn = f.records().find(row => row.kind === 'spawn');
  assert.throws(() => process.kill(spawn.pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
});

test('aborting an in-flight extraction rejects promptly and leaves no subprocess or session', async t => {
  const f = fixture(t, 'hang'), controller = new AbortController();
  const running = extractConversationMemory(f.config, input, controller.signal);
  void running.catch(() => {});
  const deadline = Date.now() + 3000;
  while (!f.records().some(row => row.method === 'turn/start')) {
    assert.ok(Date.now() < deadline, 'fake extractor did not start');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  controller.abort();
  await assert.rejects(running, (error: unknown) => error instanceof RuntimeError && /cancelled|disconnected/.test(error.code));
  const spawn = f.records().find(row => row.kind === 'spawn');
  assert.throws(() => process.kill(spawn.pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
  assert.equal(existsSync(join(f.home, 'sessions')), false);
  const before = f.records().length;
  await assert.rejects(extractConversationMemory(f.config, input, controller.signal), (error: unknown) => error instanceof RuntimeError && error.code === 'cancelled');
  assert.equal(f.records().length, before, 'an already aborted extraction must not spawn');
});

for (const [mode, pendingMethod] of [['ignore-init', 'initialize'], ['ignore-thread', 'thread/start'], ['ignore-turn', 'turn/start']] as const) {
  test(`cancelling extraction kills a SIGTERM-ignoring subprocess while ${pendingMethod} has no response`, async t => {
    const f = fixture(t, mode), controller = new AbortController();
    const running = extractConversationMemory(f.config, input, controller.signal);
    void running.catch(() => {});
    let pid: number | undefined, limit: ReturnType<typeof setTimeout> | undefined;
    try {
      const readyDeadline = Date.now() + 3000;
      while (!f.records().some(row => row.kind === 'ready') || !f.records().some(row => row.method === pendingMethod)) {
        assert.ok(Date.now() < readyDeadline, 'fake extractor did not reach the intended unresolved request');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      pid = f.records().find(row => row.kind === 'spawn').pid;
      const cancelledAt = Date.now(); controller.abort();
      await assert.rejects(Promise.race([running, new Promise<never>((_resolve, reject) => {
        limit = setTimeout(() => reject(new Error('extractor_cancellation_exceeded_2500ms')), 2500);
      })]), (error: unknown) => error instanceof RuntimeError && /cancelled|disconnected/.test(error.code));
      assert.ok(Date.now() - cancelledAt <= 2500, 'cancellation waited for the 30-second RPC timeout');
      assert.ok(f.records().some(row => row.kind === 'ignored-sigterm'), 'fake subprocess must actually ignore the graceful termination signal');
      assert.throws(() => process.kill(pid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
      assert.equal(existsSync(join(f.home, 'sessions')), false);
    } finally {
      clearTimeout(limit); controller.abort();
      // Test-owned cleanup also covers a regression that would otherwise leave
      // this intentionally stubborn fake alive after the timing assertion.
      if (pid) try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); } catch { /* Already reaped by the runtime. */ }
      await running.catch(() => {});
    }
  });
}
