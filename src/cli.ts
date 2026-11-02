import { t as tr, withLocale } from './locale.js';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { acquireLock, makeRedactor } from './safety.js';
import { Store } from './store.js';
import { RuntimeHost } from './runtime-host.js';
import { createLiveRuntime, type LiveRuntimeOptions } from './live-runtime.js';
import { activeRuntimeId, runtimeRelease, loadLiveFactory, watchLiveUpgrades } from './live-upgrade.js';
import { FeishuTransport } from './feishu.js';
import { configFile, atomicJson, receiverDir, digest } from './paths.js';
import { Management } from './management.js';
import { loginAgent, probeAgent } from './agents.js';
import { TerminalPrompter, Cancelled } from './prompts.js';
import { onboard } from './onboarding.js';
import { serviceAction, assertNoLegacyReceiver } from './service.js';
import { currentRuntimeRelease } from './release.js';
import { parseLocale, systemLocale } from './i18n.js';
import { REPOSITORY_URL } from './repository.js';
import { NAMO_VERSION } from './version.js';
import { startCodexAutoUpdates } from './codex-updates.js';
import { queuedConfiguration, watchConfiguration } from './config-reload.js';

process.umask(0o077);
const args = process.argv.slice(2);
const valueFlags = ['--config', '--lang', '--profile'];
const positional = args.filter((a, i) => !a.startsWith('-') && (i === 0 || !valueFlags.includes(args[i - 1])));
const startupRelease = positional[0] === 'start' ? currentRuntimeRelease(import.meta.url) : undefined;
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return;
  if (args.filter(arg => arg === name).length > 1) throw new Error(tr('cli.optionOnce', name));
  if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error(tr('cli.requiresValue', name));
  return args[i + 1];
}
function finish(code: number): void { process.exitCode = code; setTimeout(() => process.exit(code), 250).unref(); }
let redact = makeRedactor();
async function main(): Promise<void> {
  const command = positional[0] ?? 'help';
  const requestedLocale = flag('--lang') ?? process.env.NAMO_LANG;
  const requestedProfile = flag('--profile');
  if (requestedLocale !== undefined && requestedLocale !== 'system' && !parseLocale(requestedLocale)) throw new Error(tr('cli.supportedLanguagesSystemEnZhCnSet'));
  const moved = ['agent','doctor','check','status','logs','issues','issue','resolve','access','github','approval'];
  if (moved.includes(command) || command === 'service' && positional[1] === 'status') throw new Error(tr('cli.useWorkbench', command));
  if (command === 'migrate') throw new Error(tr('cli.importMoved'));
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.includes(args[i])) { flag(args[i]); i++; continue; }
    if (args[i].startsWith('-') && !['--help','-h','--version','-v','--import','--device-auth'].includes(args[i])) throw new Error(tr('cli.unknownOptionRunNamoHelpUsage'));
  }
  if (args.includes('--version') || args.includes('-v')) { console.log(NAMO_VERSION); return; }
  if (args.includes('--help') || args.includes('-h') || command === 'help') { console.log(tr('cli.help') + '\n' + tr('cli.directory', REPOSITORY_URL)); return; }
  if (!['init','config','login','start','service','ui'].includes(command)) throw new Error(tr('cli.unknownCommandRunNamoHelp', command));
  if (positional.length > (command === 'service' ? 2 : 1)) throw new Error(tr('cli.tooManyArgumentsRunNamoHelpUsage'));
  if (requestedProfile && command !== 'login') throw new Error(tr('cli.profileOnlyLogin'));
  if (args.includes('--device-auth') && command !== 'login') throw new Error(tr('terminal.deviceLoginOnly'));
  if (args.includes('--import') && command !== 'init') throw new Error(tr('cli.importOnlyInit'));
  if (command === 'service' && !['install','start','stop','restart','upgrade','uninstall'].includes(positional[1])) throw new Error(tr('cli.serviceUsage'));
  const file = configFile(flag('--config'));
  if (command === 'init') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(tr('cli.namoInitRequiresInteractiveTerminalRunLocally'));
    const ui = new TerminalPrompter();
    try {
      if (args.includes('--import')) await (await import('./migration-cli.js')).migrateInteractive(file, ui);
      else { const result = await onboard(file, ui); if (!result.configured) process.exitCode = 1; }
    } finally { ui.close(); }
    return;
  }
  if (!existsSync(file)) throw new Error(tr('cli.noConfigurationFoundRunNamoInitSpecify'));
  if (command === 'config') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(tr('terminal.ttyRequired'));
    const {ConfigTerminalPrompter} = await import('./config-prompts.js');
    const prompt = new ConfigTerminalPrompter(); const manager = new Management(file);
    try { await (await import('./terminal-config.js')).terminalConfig(manager, prompt); }
    finally { prompt.close(); await manager.close(); }
    return;
  }
  if (command === 'ui') {
    const {startUi,openUi} = await import('./ui.js'); const ui = await startUi(new Management(file));
    try { await openUi(ui.entryUrl); } catch (error) { await ui.close(); throw error; }
    console.log(tr('cli.namoWorkbenchOpenedLocalAccessClosingProcess', ui.url));
    let stopping = false;
    const close = async () => { if (stopping) return; stopping = true; await ui.close(); finish(0); };
    process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close()); return;
  }
  let configRevision = digest(readFileSync(file,'utf8'));
  let config = loadConfig(file); redact = makeRedactor([config.feishu.appSecret,config.github?.token??'',...(config.mcpConnections??[]).map(c=>c.token)]);
  const redactionSecrets=new Set([config.feishu.appSecret,config.github?.token??'',...(config.mcpConnections??[]).map(c=>c.token)]);
  if (configRevision !== digest(readFileSync(file,'utf8'))) throw new Error(tr('cli.configurationChangingPleaseRetry'));
  if (command === 'login') { await loginAgent(config,requestedProfile,args.includes('--device-auth')); return; }
  if (command === 'service') { console.log(JSON.stringify(await serviceAction(positional[1],config),null,2)); return; }
  ({config,revision:configRevision}=queuedConfiguration(config));
  for(const value of [config.feishu.appSecret,config.github?.token??'',...(config.mcpConnections??[]).map(c=>c.token)])redactionSecrets.add(value);
  redact=makeRedactor([...redactionSecrets]);
  const dbFile = join(config.dataDir,'bot.sqlite');
  const { validateFeishu } = await import('./config.js'); validateFeishu(config);
  if ((await probeAgent(config)).some(c => c.status === 'fail')) throw new Error(tr("cli.agentNotReadyRunNamoDoctorNamo"));
  const release = acquireLock(config.dataDir);
  let releaseReceiver: (() => void) | undefined;
  let store: Store | undefined, engine: RuntimeHost | undefined, transport: FeishuTransport | undefined;
  let closing: Promise<void> | undefined;
  let stopLiveUpgrades: (() => Promise<void>) | undefined;
  let stopUpdates: (() => Promise<void>) | undefined;
  let reload:ReturnType<typeof watchConfiguration>|undefined;
  let health: Record<string, unknown> = { pid: process.pid, startedAt: new Date().toISOString(), ready: false, connection: 'connecting',
    configRevision,managementVersion:2,automaticConfiguration:true,...(startupRelease ? { releaseId: startupRelease.id } : {}) };
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
    await reload?.stop();
    transport?.close();
    try {
      await stopLiveUpgrades?.();
      const stopped=await Promise.allSettled([engine?.stop(),stopUpdates?.()]);
      const failure=stopped.find(result=>result.status==='rejected');
      if(failure?.status==='rejected')throw failure.reason;
    } finally { try { store?.close(); } finally { releaseReceiver?.(); release(); } }
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
    const sender=new Proxy(transport,{get(_target,key){const value=Reflect.get(transport!,key);return typeof value==='function'?value.bind(transport):value;}});
    const options: LiveRuntimeOptions = { store, config, sender, redact:text=>redact(text), log, onFatal: () => void stop(1) };
    const activeId = startupRelease ? activeRuntimeId(config.dataDir, startupRelease.id) : undefined;
    const factory = startupRelease && activeId && activeId !== startupRelease.id
      ? await loadLiveFactory(startupRelease, runtimeRelease(config.dataDir, activeId), options) : () => createLiveRuntime(options);
    engine = new RuntimeHost(factory);
    if (startupRelease) health = { ...health, releaseId: activeId, receiverReleaseId: startupRelease.id, liveUpgradeVersion: 1 };
    const service = engine;
    if(config.codex.directories===undefined||configRevision!==digest(readFileSync(file,'utf8')))service.drainConfiguration(true);
    const accept=(m:Parameters<RuntimeHost['accept']>[0])=>withLocale('zh-CN',()=>{reload?.observe();service.accept(m);});
    const card=(event:Parameters<RuntimeHost['acceptCard']>[0])=>withLocale('zh-CN',()=>service.acceptCard(event));
    await transport.connect(accept,card); if (closing) return;
    withLocale('zh-CN', () => service.start()); log('ready', { dataDir: config.dataDir, concurrency: config.concurrency });
    stopUpdates=startCodexAutoUpdates(config);
    if (startupRelease && activeId) stopLiveUpgrades=watchLiveUpgrades(config,startupRelease,activeId,service,options,fields=>{
      health={...health,...fields,updatedAt:new Date().toISOString()};
      atomicJson(join(config.dataDir,'health.json'),health);
    });
    let applied=config;
    reload=watchConfiguration(store,service,config,configRevision,async next=>{
      await stopLiveUpgrades?.(); stopLiveUpgrades=undefined;
      const nextOptions={...options,config:next};
      const id=typeof health.releaseId==='string'?health.releaseId:undefined;
      return startupRelease&&id ? loadLiveFactory(startupRelease,runtimeRelease(config.dataDir,id),nextOptions) : ()=>createLiveRuntime(nextOptions);
    },async(next,revision)=>{
      await stopUpdates?.();
      for(const value of [next.feishu.appSecret,next.github?.token??'',...(next.mcpConnections??[]).map(c=>c.token)])redactionSecrets.add(value);
      redact=makeRedactor([...redactionSecrets]);
      if(applied.feishu.appSecret!==next.feishu.appSecret){
        transport!.close(); const candidate=new FeishuTransport(next.feishu,log);
        try {await candidate.connect(accept,card);transport=candidate;log('ready');}
        catch {candidate.close();transport=new FeishuTransport(applied.feishu,log);await transport.connect(accept,card);log('ready');stopUpdates=startCodexAutoUpdates(applied);throw Error('configuration_reconnect_failed');}
      } else transport!.updatePolicy(next.feishu);
      applied=next;options.config=next;
      stopUpdates=startCodexAutoUpdates(next);
      health={...health,configRevision:revision,configurationReload:'applied',automaticConfiguration:true,updatedAt:new Date().toISOString()};
      atomicJson(join(config.dataDir,'health.json'),health);
      const id=typeof health.releaseId==='string'?health.releaseId:undefined;
      if(startupRelease&&id)stopLiveUpgrades=watchLiveUpgrades(next,startupRelease,id,service,options,fields=>{health={...health,...fields};atomicJson(join(config.dataDir,'health.json'),health);});
    },state=>{
      if(health.configurationReload===state&&health.automaticConfiguration===true)return;
      health={...health,configurationReload:state,automaticConfiguration:true,updatedAt:new Date().toISOString()};atomicJson(join(config.dataDir,'health.json'),health);
    });
    health={...health,automaticConfiguration:true};atomicJson(join(config.dataDir,'health.json'),health);
  } catch (e) { await close(); throw e; }
}
const languageChoice = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : process.env.NAMO_LANG;
const defaultLocale = systemLocale([process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale]);
withLocale(parseLocale(languageChoice) ?? defaultLocale, () => main().then(() => { if (!['start','ui'].includes(positional[0]) || args.includes('--help') || args.includes('--version') || args.includes('-h') || args.includes('-v')) finish(Number(process.exitCode ?? 0)); }).catch(e => {
  const message = e instanceof Cancelled ? e.message : e instanceof SyntaxError ? tr("cli.invalidConfigurationJsonConfigurationContentsWereNot") : e instanceof Error ? e.message : tr("cli.actionIncomplete");
  console.error(redact(message.slice(0, 500))); finish(e instanceof Cancelled ? 130 : 1);
}));
