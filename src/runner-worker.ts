import { selectAgent, selectedPolicyHash, AgentRegistryError, agentCodexConfig } from './agent-registry.js';
import { runtimeFor } from './agents.js';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, type Config } from './config.js';
import { readWorkerSnapshot } from './runtime-config.js';
import { digest } from './paths.js';
import { makeRedactor } from './safety.js';
import { Store } from './store.js';
import { Tasks } from './tasks.js';
import { RuntimeError, type RunControls, type RunResult } from './runtime.js';
import { EvidenceRecorder } from './evidence.js';
import { runnerJob, runnerEvent } from './runner-store.js';
import { recordActivity } from './feedback.js';
import { recordProgress } from './public-progress.js';
import { Waits } from './waits.js';
import { requestWait } from './external-wait-bridge.js';
import { loadRunImages } from './image-inputs.js';
import { admitted, executionPolicy, taskAuthorizationValid } from './access.js';
import { readReview, assertReviewDelivery } from './github-review.js';
import { mcpRead, assertMcpDelivery } from './mcp-connections.js';
import { githubApi } from './github-api.js';
import { Schedules } from './schedules.js';
import { conversationControl } from './conversation-control.js';
import { EgoBrowserPrototype, egoExecute, browserAction } from './ego-browser-prototype.js';
import { awaitMcpApproval, browserGrant } from './mcp-write-approval.js';

process.umask(0o077);
async function main(): Promise<void> {
  const [database, file, runId, owner, mode] = process.argv.slice(2);
  if (!database || !file || !runId || !owner) return;
  const store = new Store(database), tasks = new Tasks(store);
  const abort = new AbortController();
  const stop = () => abort.abort('worker_stopped');
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  let timer: NodeJS.Timeout | undefined, evidence: EvidenceRecorder | undefined;
  let nextHeartbeat=0,nextAccessCheck=0;
  let controls: RunControls | undefined, steering: Promise<void> | undefined;
  let storageFailed = false;
  const owned = () => {
    const job = runnerJob(store, runId);
    if (job?.owner !== owner || job.state !== 'running' || job.pid !== process.pid) throw new RuntimeError('runner_ownership_lost');
  };
  const write = (fn: () => void) => store.transaction(() => { owned(); fn(); });
  try {
    // Compare-and-swap is the only path into execution, even if a duplicate or
    // delayed worker is launched with the same arguments.
    const claimed = store.transaction(() => {
      const row = store.db.prepare("UPDATE runner_jobs SET state='running',pid=?,updatedAt=? WHERE runId=? AND owner=? AND state='starting'")
        .run(process.pid, Date.now(), runId, owner);
      if (row.changes) runnerEvent(store, runId, 'claimed');
      return row.changes === 1;
    });
    if (!claimed) return;
    const run = store.db.prepare('SELECT taskId FROM task_runs WHERE id=?').get(runId)!;
    const task = tasks.get(String(run.taskId))!;
    let result: RunResult | undefined, error: string | undefined;
    try {
      const snapshot = mode === '--snapshot' ? await readWorkerSnapshot() : undefined;
      const config: Config = snapshot === undefined ? loadConfig(file) : JSON.parse(snapshot);
      const revision = digest(snapshot ?? readFileSync(file, 'utf8'));
      const current = loadConfig(file);
      const message=store.get(task.inboxKey)!;
      if (config.file !== file || !taskAuthorizationValid(config,current,message))
        throw new RuntimeError('task_configuration_changed');
      if(config.codex.directories?.some(path=>!tasks.directories(task).includes(path)))throw new RuntimeError('task_directory_snapshot_changed');
      const policy = executionPolicy(config.codex,config.feishu,store.get(task.inboxKey)!);
      const effectiveConfig = {...config,codex:policy};
      const selection = tasks.selection(task.id) ?? selectAgent(effectiveConfig, 'codex');
      const selectedConfig = agentCodexConfig(effectiveConfig, selection);
      if (resolve(database) !== join(config.dataDir, 'bot.sqlite') || revision !== runnerJob(store, runId)!.configRevision
        || task.policyHash !== selectedPolicyHash(effectiveConfig, selection) || realpathSync(task.cwd) !== task.cwd) throw new RuntimeError('task_configuration_changed');
      const redact = makeRedactor([config.feishu.appSecret,config.github?.token??'',...(config.mcpConnections??[]).map(c=>c.token)]);
      const egoBin=join(homedir(),'.local','bin','ego-browser');
      const browserEligible=process.platform==='darwin' && existsSync(egoBin) && message.envelope?.chatType==='p2p'
        && message.envelope.kind==='instruction' && config.feishu.allowedUserIds.includes(message.senderId)
        && !message.key.startsWith('schedule:') && config.codex.networkAccess===true;
      const browser=browserEligible ? new EgoBrowserPrototype(egoExecute(egoBin)) : undefined;
      let browserGranted=false, browserBusy=false, permanentId:string|undefined;
      const browserValid=()=>{
        try { owned(); const latest=loadConfig(file); return !abort.signal.aborted && latest.codex.networkAccess===true
          && latest.feishu.allowedUserIds.includes(message.senderId) && taskAuthorizationValid(config,latest,message)
          && (!permanentId || browserGrant(store,latest,message.senderId,message.chatKey)===permanentId); }
        catch { return false; }
      };
      if (store.get(task.inboxKey)?.cancelRequested || abort.signal.aborted) throw new RuntimeError('cancelled');
      write(() => { evidence = new EvidenceRecorder(store, runId, task.cwd, selectedConfig.denyPaths, redact); });
      const steer = (): void => {
        if (!controls || steering || abort.signal.aborted) return;
        steering = (async () => {
          for (;;) {
            const revision = tasks.revisions(task.id)[0];
            if (!revision || abort.signal.aborted) break;
            write(() => { tasks.dispatch(revision.inboxKey, 'submitting'); runnerEvent(store, runId, 'revision_submitting'); });
            let state: string;
            try { state = await controls!.steer(JSON.stringify({ task_id: task.id, revision: revision.version,
              user_message: revision.text, note: '这是该任务所有者追加的要求，较新的明确限制优先。' })); }
            catch { state = 'unknown'; }
            write(() => {
              tasks.dispatch(revision.inboxKey, state); runnerEvent(store, runId, `revision_${state}`);
              if (state !== 'accepted') store.addOutput(revision.inboxKey, 'notice',
                `任务 ${task.id} 的补充${state === 'unknown' ? '提交结果不明' : '未被当前轮接受'}，未自动重送。请询问任务状态。`);
            });
          }
        })().catch(() => { storageFailed = true; abort.abort('storage_failed'); }).finally(() => { steering = undefined; });
      };
      timer = setInterval(() => {
        try {
          const now=Date.now();
          if(now>=nextHeartbeat){write(() => { store.db.prepare('UPDATE runner_jobs SET updatedAt=? WHERE runId=?').run(now, runId); });nextHeartbeat=now+1000;}
          if(now>=nextAccessCheck){
            try {
              const current = loadConfig(file);
              if (!taskAuthorizationValid(config,current,message)) abort.abort('access_configuration_changed');
            } catch { abort.abort('access_configuration_changed'); }
            nextAccessCheck=now+1000;
          }
          if (store.get(task.inboxKey)?.cancelRequested) abort.abort('user_cancelled');
          steer();
        } catch { storageFailed = true; abort.abort('storage_failed'); }
      }, 200);
      assertMcpDelivery(store,current,task);
      const raw = await runtimeFor(effectiveConfig, selection).run({ taskId: task.id, runId,
        model: tasks.model(task.id),
        onModel: model => write(() => tasks.freezeDefaultModel(task.id, model)),
        cwd: task.cwd, prompt: runnerJob(store, runId)!.prompt, images:loadRunImages(store,config.dataDir,runId),
        threadId: tasks.thread(task), signal: abort.signal,
        onProcess: pid => write(() => { store.db.prepare('UPDATE runner_jobs SET runtimePid=? WHERE runId=?').run(pid, runId); runnerEvent(store, runId, 'runtime_started'); }),
        onThread: thread => write(() => {
          if (!new Waits(store).resume(task)) store.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(`control-tools-v4-thread:${thread}`,'1');
          store.saveThread(tasks.sessionKey(task), thread); store.saveRun(task.inboxKey, thread); tasks.saveRun(runId, thread);
          runnerEvent(store, runId, 'thread_bound');
        }),
        onTurn: turn => write(() => {
          const thread = store.thread(tasks.sessionKey(task))!;
          store.saveRun(task.inboxKey, thread, turn); tasks.saveRun(runId, thread, turn); runnerEvent(store, runId, 'turn_bound');
        }),
        onMcp:async(args:unknown,signal:AbortSignal)=>{
          const response=await mcpRead(store,file,task,args,signal,undefined,config);
          if(args&&typeof args==='object'&&(args as Record<string,unknown>).operation==='call') {
            const failed=!!(response as {data?:{isError?:boolean}})?.data?.isError;
            write(()=>runnerEvent(store,runId,`mcp_call_${failed?'failed':'completed'}`));
          }
          return response;
        },
        ...(browser ? { onBrowser:async(args:unknown,signal:AbortSignal)=>{
          const action=browserAction(args);
          if(browserBusy || !browserValid() || signal.aborted)throw Error('browser_unavailable');
          browserBusy=true;
          try {
            if(!browserGranted){
              permanentId=browserGrant(store,loadConfig(file),message.senderId,message.chatKey);
              if(!permanentId){
                const finish=await awaitMcpApproval(store,task,'ego-browser','local Ego Lite','task_browser_access',
                  {capability:'open, snapshot, click, fill',scope:'this task',initialAction:action.operation,
                    ...(action.operation==='open'?{site:new URL(action.url).origin}:{})},'browser',signal,browserValid);
                if(finish.always){permanentId=browserGrant(store,loadConfig(file),message.senderId,message.chatKey);if(!permanentId){finish('not_sent');throw Error('browser_unavailable');}}
                finish('completed');
              }
              browserGranted=true;
            }
            let finish:((outcome:'completed'|'unknown'|'not_sent')=>void)|undefined;
            if(permanentId && !['open','snapshot','click','fill','press','finish'].includes(action.operation))throw Error('browser_unsupported_action');
            if(permanentId && action.operation==='press' && !['Enter','Tab','Escape','ArrowDown','ArrowUp'].includes(action.key))throw Error('browser_unsupported_action');
            if(action.operation==='press' && !permanentId) {
              const approval=await awaitMcpApproval(store,task,'ego-browser','local Ego Lite','press',
                {selector:action.selector,key:action.key},'browser',signal,browserValid);
              if(approval.always){permanentId=browserGrant(store,loadConfig(file),message.senderId,message.chatKey);if(!permanentId){approval('not_sent');throw Error('browser_unavailable');}}
              finish=approval;
            }
            if(!browserValid() || signal.aborted){finish?.('not_sent');throw Error('browser_unavailable');}
            try {const value=await browser.call(action,signal); finish?.('completed');return value;}
            catch(error){finish?.('unknown');throw error;}
          } finally {browserBusy=false;}
        }} : {}),
        onReview: args => readReview(store,file,task,args,abort.signal),
        ...(config.github && (config.github.source==='gh'||!!config.github.token)?{onGitHub:(args:unknown,signal:AbortSignal)=>githubApi(store,file,task,args,signal)}:{}),
        onControl: (args,callId) => {
          const latest=loadConfig(file);
          if(abort.signal.aborted || !taskAuthorizationValid(config,latest,message)) throw new RuntimeError('access_configuration_changed');
          owned();
          return conversationControl(store,latest,message,task,args,callId,redact,t=>{
            try {const source=store.get(t.inboxKey);if(!source||!admitted(latest.feishu,source.senderId,source.chatId,source.envelope?.tenantKey))return false;
              assertReviewDelivery(store,latest,t);assertMcpDelivery(store,latest,t);return true;}catch{return false;}
          });
        },
        onSchedule: (args,callId) => {
          if(abort.signal.aborted || !taskAuthorizationValid(config,loadConfig(file),message)) throw new RuntimeError('access_configuration_changed');
          owned();
          return new Schedules(store).tool(message,args,callId,()=>({cwd:task.cwd,policyHash:task.policyHash,directories:config.codex.directories??[],...(selection.profileId!=='codex'?{agentSelection:selection}:{})}));
        },
        onReady: next => { controls = next; steer(); },
        onActivity: phase => write(() => recordActivity(store, runId, phase)),
        onProgress: event => write(() => recordProgress(store, runId, event, redact)),
        onEvidence: item => write(() => evidence!.observe(item)),
        onWait: request => store.transaction(() => {
          owned();
          const safe = request.external ? request
            : { ...request, question: redact(request.question), choices: request.choices?.map(redact), questions: request.questions?.map(q => ({question:redact(q.question),choices:q.choices.map(redact)})) };
          const id = requestWait(store, task.id, runId, safe);
          runnerEvent(store, runId, 'wait_requested'); return id;
        }),
      });
      let browserCleanupFailed=false;
      if(browser && browserGranted && !abort.signal.aborted) {
        try { await browser.call({operation:'finish'},AbortSignal.timeout(5000)); }
        catch { browserCleanupFailed=true; /* Never retry unknown or user-controlled browser state. */ }
      }
      if(browserCleanupFailed && raw.waiting) write(()=>store.addOutput(task.inboxKey,`browser-cleanup:${runId}`,'浏览器空间未能确认关闭，请在 Ego 中检查。'));
      assertReviewDelivery(store,loadConfig(file),task);
      assertMcpDelivery(store,loadConfig(file),task);
      result = { ...raw, text: redact(raw.text) + (browserCleanupFailed && !raw.waiting ? '\n\n浏览器空间未能确认关闭，请在 Ego 中检查。' : ''), ...(raw.waiting ? { waiting: { ...raw.waiting, question: redact(raw.waiting.question), choices: raw.waiting.choices?.map(redact), questions: raw.waiting.questions?.map(q => ({question:redact(q.question),choices:q.choices.map(redact)})) } } : {}) };
    } catch (e) {
      error = abort.signal.reason === 'worker_stopped' ? 'interrupted'
        : storageFailed ? 'runner_storage_error' : e instanceof RuntimeError || e instanceof AgentRegistryError ? e.code : 'runtime_error';
    } finally { clearInterval(timer); await steering; }
    if (storageFailed) error = 'runner_storage_error';
    write(() => {
      if (store.get(task.inboxKey)?.cancelRequested) error = 'cancelled';
      if (error) new Waits(store).close(task.id, error === 'cancelled');
      if (!error) tasks.finishRefresh(task);
      evidence?.finish(!error);
      store.db.prepare('UPDATE runner_jobs SET state=?,result=?,error=?,updatedAt=? WHERE runId=?')
        .run(error ? 'failed' : 'completed', error ? null : JSON.stringify(result), error ?? null, Date.now(), runId);
      runnerEvent(store, runId, error ? 'failed' : 'completed');
    });
  } finally {
    clearInterval(timer); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); store.close();
  }
}
// Never forward raw SDK/runtime/storage errors from the independent process.
void main().catch(() => { process.exitCode = 1; });
