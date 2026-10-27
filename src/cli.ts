import { t as tr, withLocale } from './locale.js';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { acquireLock, makeRedactor } from './safety.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { FeishuTransport } from './feishu.js';
import { configFile, atomicJson, receiverDir, digest } from './paths.js';
import { Management } from './management.js';
import { randomUUID } from 'node:crypto';
import { detectAgents, loginAgent, probeAgent, probeAgentProfile, liveAgentTest } from './agents.js';
import { RunnerRuntime } from './runner.js';
import { doctor } from './doctor.js';
import { TerminalPrompter, Cancelled } from './prompts.js';
import { onboard } from './onboarding.js';
import { serviceAction, serviceStatus, assertNoLegacyReceiver } from './service.js';
import { currentRuntimeRelease } from './release.js';
import { parseLocale, systemLocale } from './i18n.js';
import { PROJECT_URL } from './project.js';
import { ExecFileGitRunner, GitApprovals, type ApprovalTaskContext } from './approvals.js';
import { Tasks } from './tasks.js';
import { getAgentRegistry, selectAgent, selectedPolicyHash } from './agent-registry.js';

process.umask(0o077);
const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('-') && (i === 0 || !['--config', '--lang', '--profile'].includes(args[i - 1])));
const startupRelease = positional[0] === 'start' ? currentRuntimeRelease(import.meta.url) : undefined;
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(tr("cli.requiresValue", name));
  return args[i + 1];
}
const help = () => tr("cli.namoConnectFeishuLocalAgentCodexSupported");
function finish(code: number): void { process.exitCode = code; setTimeout(() => process.exit(code), 250).unref(); }
let redact = makeRedactor();
async function main(): Promise<void> {
  const command = positional[0] ?? 'help';
  const requestedLocale = flag('--lang') ?? process.env.NAMO_LANG;
  const requestedProfile = flag('--profile');
  if (requestedLocale !== undefined && requestedLocale !== 'system' && !parseLocale(requestedLocale)) throw new Error(tr("cli.supportedLanguagesSystemEnZhCnSet"));
  if (args.filter(arg => arg === '--lang').length > 1) throw new Error(tr("cli.specifyLangOnce"));
  if (args.filter(arg => arg === '--profile').length > 1) throw new Error(tr("cli.specifyProfileOnce"));
  for (let i = 0; i < args.length; i++) {
    if (['--config', '--lang', '--profile'].includes(args[i])) { flag(args[i]); i++; continue; }
    if (args[i].startsWith('-') && !['--help', '-h', '--version', '-v', '--json', '--live', '--confirm'].includes(args[i])) throw new Error(tr("cli.unknownOptionRunNamoHelpUsage"));
  }
  if (args.includes('--version') || args.includes('-v')) { console.log(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version); return; }
  if (args.includes('--help') || args.includes('-h') || ['help', '-h', '--help'].includes(command)) { console.log(help()
    + '\n  migrate              OpenClaw import preview / OpenClaw 导入预览（不会自动接管）'
    + '\n  migrate inspect      Read-only source metadata / 只读来源元数据检查'
    + '\n  access configure / status  ' + tr("cli.configureOrganizationAccessInspectItsScope")
    + '\n  github configure / status  ' + tr("cli.configurePrivateRepositoryCheckAccessViewIts")
    + '\n  approval             Controlled Git push approval / 受控 Git push 审批'
    + '\n\n' + tr("cli.languageLangSystemEnZhCnNamo") + '\n' + tr("cli.project", PROJECT_URL)); return; }
  if (!['resolve','migrate','approval'].includes(command)&&positional.length > (['agent', 'service', 'config','issue','github','access'].includes(command) ? 2 : 1)) throw new Error(tr("cli.tooManyArgumentsRunNamoHelpUsage"));
  const known = ['access','github','approval','migrate','ui','issues','issue','resolve','init', 'doctor', 'agent', 'login', 'start', 'status', 'logs', 'service', 'config', 'check'];
  if (!known.includes(command)) throw new Error(tr("cli.unknownCommandRunNamoHelp", command));
  if(requestedProfile&&!(command==='login'||command==='agent'&&['probe','use','test'].includes(positional[1]??'')))throw new Error(tr("cli.profileAvailableLoginAgentProbeAgentUse"));
  const file = configFile(flag('--config'));
  if (command === 'config') { if (positional[1] !== 'path') throw new Error(tr("cli.usageNamoConfigPath")); console.log(file); return; }
  if (command === 'migrate') {
    if (positional[1] === 'inspect') {
      if (positional.length !== 4) throw new Error('Usage: namo migrate inspect <openclaw.json> <instance-id> --json');
      const { inspectOpenClawSource } = await import('./migration.js');
      console.log(JSON.stringify(inspectOpenClawSource({ sourceFile: positional[2]!, sourceInstanceId: positional[3]! }), null, 2)); return;
    }
    if (positional.length !== 1) throw new Error('Usage: namo migrate, or namo migrate inspect <openclaw.json> <instance-id> --json');
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run namo migrate in a local interactive terminal / 请在本机交互终端运行 namo migrate');
    const ui=new TerminalPrompter();try {await (await import('./migration-cli.js')).migrateInteractive(file,ui);}finally {ui.close();}return;
  }
  if (command === 'init') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(tr("cli.namoInitRequiresInteractiveTerminalRunLocally"));
    const ui = new TerminalPrompter();
    try { const r = await onboard(file, ui); if (!r.configured) process.exitCode = 1; }
    finally { ui.close(); }
    return;
  }
  if (command === 'agent' && positional[1] === 'list') {
    const infos = detectAgents();
    if (args.includes('--json')) console.log(JSON.stringify(infos, null, 2));
    else for (const a of infos) console.log(`${a.id}: ${a.installed ? tr("cli.installed", a.version ?? tr("cli.versionUnknown")) : tr("cli.notFound")} · ${a.kind} · ${a.supported ? tr("cli.supportedBackend") : tr("cli.notIntegrated")}${a.path ? `\n  ${a.path}` : ''}`);
    return;
  }
  if (command === 'doctor' || command === 'check') {
    const checks = await doctor(file, args.includes('--live'));
    if (args.includes('--json')) console.log(JSON.stringify(checks, null, 2));
    else for (const c of checks) console.log(`${c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗'} ${c.message}${c.next ? `\n  ${c.next}` : ''}`);
    if (checks.some(c => c.status === 'fail')) process.exitCode = 1;
    return;
  }
  if (!existsSync(file)) throw new Error(tr("cli.noConfigurationFoundRunNamoInitSpecify"));
  if(command==='access') {
    const {Management}=await import('./management.js'),manager=new Management(file);
    if(positional[1]==='status'){console.log(JSON.stringify(manager.config().feishu,null,2));return;}
    if(positional[1]!=='configure')throw new Error('Usage: namo access configure|status');
    if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error(tr("cli.configureAccessInteractiveTerminalHost"));
    const ui=new TerminalPrompter();try{await(await import('./access-cli.js')).configureAccess(file,ui,manager);}finally{ui.close();}return;
  }
  if(command==='github'){
    if(positional[1]==='status'){console.log(JSON.stringify(new Management(file).config().github,null,2));return;}
    if(positional[1]!=='configure')throw new Error(tr("cli.usageNamoGithubConfigureStatus"));
    if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error(tr("cli.configureGithubLocalInteractiveTerminalNotPass"));
    const ui=new TerminalPrompter();try{await(await import('./github-cli.js')).configureGitHub(file,ui);}finally{ui.close();}return;
  }
  if(command==='ui') {
    const {startUi,openUi}=await import('./ui.js');const ui=await startUi(new Management(file));
    try{await openUi(ui.entryUrl);}catch(e){await ui.close();throw e;}
    console.log(tr("cli.namoWorkbenchOpenedLocalAccessClosingProcess", ui.url));
    let stopping=false;const close=async()=>{if(stopping)return;stopping=true;await ui.close();finish(0);};
    process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());return;
  }
  if(['issues','issue','resolve'].includes(command)) {
    const manager=new Management(file);
    if(command==='issues'){const state=manager.state();console.log(JSON.stringify({available:state.recoveryAvailable,issues:state.database.issues},null,2));}
    else if(command==='issue')console.log(JSON.stringify(manager.issue(positional[1]??''),null,2));
    else {
      if(!args.includes('--confirm')||positional.length<5)throw new Error(tr("cli.inspectIssueFirstResolveRequiresIdVersion"));
      console.log(JSON.stringify(manager.reconcile({subject:positional[1],stamp:positional[2],action:positional[3],note:positional.slice(4).join(' '),requestId:randomUUID(),acknowledgeDuplicate:positional[3]==='retry'})));
    }return;
  }
  const configRevision=digest(readFileSync(file,'utf8'));
  const config = loadConfig(file); redact = makeRedactor([config.feishu.appSecret,config.github?.token??'']);
  if(configRevision!==digest(readFileSync(file,'utf8')))throw new Error(tr("cli.configurationChangingPleaseRetry"));
  if(command==='agent'&&positional[1]==='profiles') {
    const registry=getAgentRegistry(config),safe={defaultProfile:registry.defaultProfile,memoryProfile:registry.memoryProfile,
      profiles:registry.profiles.map(({id,adapter,enabled,bin,home,model,timeoutMs,revision,available})=>({id,adapter,enabled,bin:redact(bin),home:redact(home),...(model?{model:redact(model)}:{}),timeoutMs,revision,available}))};
    if(args.includes('--json'))console.log(JSON.stringify(safe,null,2));
    else {console.log(`${tr("cli.defaultProfile")}: ${safe.defaultProfile}\n${tr("cli.memoryProfile")}: ${safe.memoryProfile}`);for(const profile of safe.profiles)console.log(`${profile.id}: ${profile.adapter} · ${profile.enabled?tr("status.enabled"):tr("status.disabled")} · ${profile.available?tr("cli.runtimeAdapterAvailable"):tr("common.comingLaterRelease")}\n  ${profile.bin}\n  ${profile.home}`);}
    return;
  }
  if(command==='agent'&&positional[1]==='probe') {
    if(!requestedProfile)throw new Error(tr("cli.usageNamoAgentProbeProfileIdJson"));
    const result=await probeAgentProfile(config,requestedProfile);
    if(args.includes('--json'))console.log(JSON.stringify(result,null,2));
    else {
      console.log(`${tr("common.profile")}: ${result.profileId} · ${result.adapter}`);
      for(const check of result.checks??[])console.log(`${check.status==='ok'?'✓':check.status==='warn'?'!':'×'} ${check.message}${check.next?`\n  ${check.next}`:''}`);
      if(result.report){
        for(const [label,item] of [[tr("cli.install"),result.report.installed],[tr("cli.protocol"),result.report.protocol],[tr("cli.sign"),result.report.auth]] as const)
          console.log(`${label}: ${tr(({supported:'probe.supported',unverified:'probe.unverified',unavailable:'probe.unavailable'} as const)[item.status])} · ${item.evidence}`);
        for(const [capability,item] of Object.entries(result.report.capabilities))console.log(`${capability}: ${tr(({supported:'probe.supported',unverified:'probe.unverified',unavailable:'probe.unavailable'} as const)[item.status])} · ${item.evidence}`);
        console.log(tr("cli.probeNotEnableRuntimeClaudeCodeCursor"));
      }
    }
    return;
  }
  if(command==='agent'&&positional[1]==='use') {
    if(!requestedProfile)throw new Error(tr("cli.usageNamoAgentUseProfileId"));
    selectAgent(config,requestedProfile);
    const manager=new Management(file),view=manager.config();
    const saved=manager.save(view.revision,{agents:{defaultProfile:requestedProfile,memoryProfile:view.agents.memoryProfile,profiles:view.agents.specs}});
    const result={defaultProfile:saved.agents.defaultProfile,restartRequired:true,scope:'new_workstreams'};
    if(args.includes('--json'))console.log(JSON.stringify(result,null,2));
    else console.log(tr("cli.defaultAgentProfileSavedReceiverWasNot",requestedProfile));
    return;
  }
  const dbFile = join(config.dataDir, 'bot.sqlite');
  if (command === 'approval') {
    const sub = positional[1] ?? '', policy = config.gitApprovals ?? { remotes: [], maxTtlMs: 900_000 };
    if (!policy.gitBin) throw new Error('gitApprovals.gitBin must be an explicit absolute Git executable path before using approvals');
    if (!existsSync(dbFile)) throw new Error(tr("cli.messageDatabaseNotExistNoTaskCan"));
    const approvalStore = new Store(dbFile);
    try {
      const approvals = new GitApprovals(approvalStore, { remotes: policy.remotes, maxTtlMs: policy.maxTtlMs, sshCommand: policy.sshCommand }, new ExecFileGitRunner(policy.gitBin));
      const task = (id: string): ApprovalTaskContext & { state: string } => {
        const row = approvalStore.db.prepare('SELECT id,ownerId,chatKey,project,cwd,policyHash,state FROM tasks WHERE id=?').get(id.toUpperCase()) as Record<string, unknown> | undefined;
        if (!row) throw new Error(tr("cli.taskNotExist"));
        const project = row.project == null ? undefined : String(row.project), cwd = String(row.cwd), savedPolicy = String(row.policyHash), projects = config.codex.projects ?? {};
        const selection=new Tasks(approvalStore).selection(String(row.id))??selectAgent(config,'codex');
        if (savedPolicy !== selectedPolicyHash(config,selection)) throw new Error(tr("cli.agentProfileProjectPermissionsChangedTaskWas"));
        if (project && (!Object.hasOwn(projects, project) || projects[project] !== cwd)) throw new Error(tr("cli.taskProjectWasRemovedItsPathChanged"));
        return { taskId: String(row.id), ownerId: String(row.ownerId), chatKey: String(row.chatKey), project, cwd, policyHash: savedPolicy, state: String(row.state) };
      };
      const view = (id: string) => {
        const record = approvals.get(id); if (!record) throw new Error(tr("cli.approvalNotExist"));
        return { id: record.id, state: record.state, scope: record.task, target: { remote: record.target.remote, transport: record.target.transport, ref: record.target.ref,
          headSha: record.target.headSha, remoteBeforeSha: record.target.remoteBeforeSha }, configRevision: record.configRevision, expiresAt: record.expiresAt,
          reason: record.reason, limitedProtection: true, limitation: tr("cli.protectsApprovalEntrypointOtherAgentNetworkCredential") };
      };
      let result: unknown;
      if (sub === 'request') {
        if (positional.length !== 5) throw new Error('Usage: namo approval request <task> <remote> <refs/heads/branch>');
        const bound = task(positional[2]!); if (bound.state !== 'succeeded') throw new Error(tr("cli.taskNotCompletedSuccessfully"));
        const requested = await approvals.request(bound, { remote: positional[3]!, ref: positional[4]!, configRevision }); result = view(requested.id);
      } else if (sub === 'inspect') {
        if (positional.length !== 3) throw new Error('Usage: namo approval inspect <AP-id>'); result = view(positional[2]!);
      } else if (sub === 'approve' || sub === 'reject') {
        if (positional.length !== 3 || sub === 'approve' && !args.includes('--confirm')) throw new Error(`Usage: namo approval ${sub} <AP-id>${sub === 'approve' ? ' --confirm' : ''}`);
        const record = approvals.get(positional[2]!); if (!record) throw new Error(tr("cli.approvalNotExist"));
        const actor = { ownerId: record.task.ownerId, chatKey: record.task.chatKey, authority: 'local-management' as const };
        sub === 'approve' ? approvals.approve(record.id, actor) : approvals.reject(record.id, actor); result = view(record.id);
      } else if (sub === 'execute' || sub === 'reconcile') {
        if (positional.length !== 3 || !args.includes('--confirm')) throw new Error(`Usage: namo approval ${sub} <AP-id> --confirm`);
        const record = approvals.get(positional[2]!); if (!record) throw new Error(tr("cli.approvalNotExist")); const bound = task(record.task.taskId);
        if (sub === 'execute') await approvals.execute(record.id, bound, () => digest(readFileSync(file,'utf8'))); else await approvals.reconcile(record.id, bound, configRevision);
        result = view(record.id);
      } else throw new Error('Usage: namo approval request|inspect|approve|reject|execute|reconcile ...');
      console.log(JSON.stringify(result, null, 2));
    } finally { approvalStore.close(); }
    return;
  }
  if (command === 'login') { await loginAgent(config,requestedProfile); return; }
  if (command === 'agent') {
    if (positional[1] !== 'test' || !args.includes('--live')) throw new Error(tr("cli.useNamoAgentTestLiveRealTest"));
    const ok = await liveAgentTest(config,requestedProfile); console.log(JSON.stringify({ profileId:selectAgent(config,requestedProfile).profileId,modelTurnVerified: ok })); if (!ok) process.exitCode = 1; return;
  }
  if (command === 'service') { console.log(JSON.stringify(await serviceAction(positional[1] ?? 'status', config), null, 2)); return; }
  if (command === 'logs') {
    for (const name of ['service.log', 'service.error.log']) {
      const path = join(config.dataDir, name);
      if (existsSync(path)) console.log(redact(readFileSync(path, 'utf8').trim().split('\n').slice(-80).join('\n')));
    }
    return;
  }
  if (command === 'status') {
    let queue: unknown = tr("cli.serviceNotCreatedItsMessageDatabaseYet");
    if (existsSync(dbFile)) { const store = new Store(dbFile, true); try { queue = store.status(); } finally { store.close(); } }
    console.log(JSON.stringify({ service: serviceStatus(config), queue }, null, 2)); return;
  }
  const { validateFeishu } = await import('./config.js'); validateFeishu(config);
  if ((await probeAgent(config)).some(c => c.status === 'fail')) throw new Error(tr("cli.agentNotReadyRunNamoDoctorNamo"));
  const release = acquireLock(config.dataDir);
  let releaseReceiver: (() => void) | undefined;
  let store: Store | undefined, engine: Engine | undefined, transport: FeishuTransport | undefined;
  let closing: Promise<void> | undefined;
  let health: Record<string, unknown> = { pid: process.pid, startedAt: new Date().toISOString(), ready: false, connection: 'connecting',
    configRevision,managementVersion:2,...(startupRelease ? { releaseId: startupRelease.id } : {}) };
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    if (['ready', 'stopped', 'feishu_connected', 'feishu_reconnecting', 'feishu_reconnected', 'feishu_connection_failed', 'feishu_startup_timeout'].includes(event)) {
      const connection = event === 'ready' || ['feishu_connected', 'feishu_reconnected'].includes(event) ? 'connected'
        : event === 'feishu_reconnecting' ? 'reconnecting' : event === 'stopped' ? 'stopped' : 'failed';
      health = { ...health, connection, ready: event === 'ready' || event === 'feishu_reconnected', updatedAt: new Date().toISOString() };
      atomicJson(join(config.dataDir, 'health.json'), health);
    }
    console.log(redact(JSON.stringify({ time: new Date().toISOString(), event, ...fields })));
  };
  const close = () => closing ??= (async () => {
    transport?.close();
    try { await engine?.stop(); } finally { try { store?.close(); } finally { releaseReceiver?.(); release(); } }
    log('stopped');
  })();
  const stop = async (code: number) => { try { await close(); finish(code); } catch { console.error(tr("cli.serviceShutdownFailed")); finish(1); } };
  process.once('SIGINT', () => void stop(0)); process.once('SIGTERM', () => void stop(0));
  try {
    mkdirSync(config.codex.home, { recursive: true, mode: 0o700 });
    assertNoLegacyReceiver(config.feishu.appId);
    releaseReceiver = acquireLock(receiverDir(config.feishu.appId));
    store = new Store(dbFile); store.bindAccount(config.feishu.appId);
    transport = new FeishuTransport(config.feishu, log);
    engine = new Engine(store, new RunnerRuntime(store, config), transport, config, redact, log, () => void stop(1));
    const service = engine;
    await transport.connect(m => withLocale('zh-CN', () => { service.accept(m); }), event => withLocale('zh-CN', () => service.acceptCard(event))); if (closing) return;
    withLocale('zh-CN', () => service.start()); log('ready', { dataDir: config.dataDir, concurrency: config.concurrency });
  } catch (e) { await close(); throw e; }
}
const languageChoice = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : process.env.NAMO_LANG;
const defaultLocale = systemLocale([process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale]);
withLocale(parseLocale(languageChoice) ?? defaultLocale, () => main().then(() => { if (!['start','ui'].includes(positional[0]) || args.includes('--help') || args.includes('--version') || args.includes('-h') || args.includes('-v')) finish(Number(process.exitCode ?? 0)); }).catch(e => {
  const message = e instanceof Cancelled ? e.message : e instanceof SyntaxError ? tr("cli.invalidConfigurationJsonConfigurationContentsWereNot") : e instanceof Error ? e.message : tr("cli.actionIncomplete");
  console.error(redact(message.slice(0, 500))); finish(e instanceof Cancelled ? 130 : 1);
}));
