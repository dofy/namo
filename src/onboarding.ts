import { optionalAssistantSetup } from './assistant-setup.js';
import { t as tr } from './locale.js';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { loadConfig, validateFeishu, parseConfig } from './config.js';
import { ConfigEditor, atomicJson, readJson, digest, receiverDir } from './paths.js';
import { acquireLock } from './safety.js';
import { probeAgent, loginAgent, liveAgentTest, detectAgents, toolchainPaths, type Check } from './agents.js';
import { PairingChallenge, FeishuSetupConnection, FEISHU_GUIDE, type SetupConnection, type Candidate } from './feishu-setup.js';
import type { FeishuEvent } from './feishu.js';
import { serviceAction, activeData, assertNoLegacyReceiver, waitForService } from './service.js';
import type { Prompter } from './prompts.js';
import { Cancelled } from './prompts.js';

export interface InitDeps {
  probe(c: Config): Promise<Check[]>;
  login(c: Config): Promise<void>;
  connection(c: Config): SetupConnection;
  live(c: Config): Promise<boolean>;
  install(c: Config): Promise<{ ready: boolean }>;
}
const defaults: InitDeps = { probe: probeAgent, login: loginAgent, connection: c => new FeishuSetupConnection(c.feishu), live: liveAgentTest,
  install: async c => { await serviceAction('install', c); return { ready: await waitForService(c) }; } };
export interface InitResult { configured: boolean; verified: boolean; serviceInstalled: boolean; serviceReady: boolean; }
export function initialConfig(file: string): any {
  return { version: 1, agent: 'codex', dataDir: join(dirname(file), 'data'), concurrency: 3,
    feishu: { appId: '', appSecret: '', appSecretEnv: 'FEISHU_APP_SECRET', allowedUserIds: [], allowedChatIds: [], requireMention: true, cards:true, domain: 'feishu' },
    codex: { bin: 'codex', home: join(dirname(file), 'data', 'codex-home'), sandbox: 'read-only', timeoutMs: 600_000,
      projects: {}, networkAccess: false, readPaths: toolchainPaths(), denyPaths: [], allowLocalCommits: false } };
}
export function waitForPairing(register: (fn: (event: FeishuEvent) => void) => () => void, ui: Prompter, allowed?: string[]): Promise<Candidate> {
  const challenge = new PairingChallenge();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); remove(); ui.signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new Cancelled()); };
    const remove = register(e => {
      if (allowed && !allowed.includes(e.sender?.sender_id?.open_id ?? '')) return;
      const candidate = challenge.accept(e);
      if (candidate) { cleanup(); resolve(candidate); }
    });
    const timer = setTimeout(() => { cleanup(); reject(new Error(tr("onboarding.pairingCodeExpiredRunNamoInitAgain"))); }, 600_000);
    ui.signal?.addEventListener('abort', abort, { once: true });
    if (ui.signal?.aborted) { abort(); return; }
    ui.info(tr("onboarding.sendOneTimeCodeDirectMessageFeishu", challenge.code));
  });
}
export async function onboard(file: string, ui: Prompter, overrides: Partial<InitDeps> = {}): Promise<InitResult> {
  const deps = { ...defaults, ...overrides };
  const editor = new ConfigEditor(file);
  let raw = structuredClone(editor.value ?? initialConfig(file));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ['feishu', 'codex'].some(k => raw[k] != null && (typeof raw[k] !== 'object' || Array.isArray(raw[k])))) throw new Error(tr("onboarding.invalidConfigurationStructureOriginalFileWasNot"));
  if (raw.version !== undefined && raw.version !== 1) throw new Error(tr("onboarding.unsupportedConfigurationVersionOriginalFileWasNot"));
  raw.feishu ??= {}; raw.codex ??= {};
  const dataDir = raw.dataDir?.startsWith('~/') ? join(homedir(), raw.dataDir.slice(2)) : resolve(dirname(file), raw.dataDir ?? './data');
  if (activeData(dataDir)) throw new Error(tr("onboarding.receiverAlreadyUsingConfigurationSetupMadeNo"));
  const releaseData = acquireLock(dataDir);
  let releaseReceiver: (() => void) | undefined;
  let connection: SetupConnection | undefined;
  const listeners = new Set<(e: FeishuEvent) => void>();
  const subscribe = (fn: (e: FeishuEvent) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
  const result: InitResult = { configured: false, verified: false, serviceInstalled: false, serviceReady: false };
  const stateFile = join(dataDir, 'onboarding', 'state.json');
  let state: any = existsSync(stateFile) ? readJson(stateFile) : {};
  const checkpoint = (phase: string) => {
    const configuration = digest(JSON.stringify(raw));
    if (state.configuration !== configuration) state = { configuration };
    state.phase = phase; state.updatedAt = new Date().toISOString(); atomicJson(stateFile, state);
  };
  try {
    ui.info(tr("onboarding.namoSetupConfigurationCredentialsStayMachineCtrl", file));
    if (editor.value) ui.info(tr("onboarding.existingConfigurationFoundUnknownFieldsAuthorizedUsers"));
    const reuse = !!editor.value && !!raw.feishu.appId && !!raw.codex.defaultProject && await ui.confirm(tr("onboarding.reuseExistingAgentProjectFeishuSettings"), true);
    if (!reuse) {
      ui.info(tr("onboarding.codexOnly"));
      const found = detectAgents(raw.codex?.bin ?? 'codex').find(a => a.id === 'codex');
      raw.agent = 'codex'; raw.codex ??= initialConfig(file).codex;
      raw.codex.readPaths ??= toolchainPaths();
      raw.codex.bin = await ui.text(tr("onboarding.codexExecutablePathCommand"), found?.path ?? raw.codex.bin ?? 'codex');
      for (;;) {
        const previous = raw.codex.projects?.[raw.codex.defaultProject];
        const current = previous ? resolve(dirname(file), previous) : process.cwd();
        const project = await ui.text(tr("onboarding.projectDirectoryAgentMayWork"), current);
        const name = raw.codex.defaultProject ?? 'app';
        const next = structuredClone(raw);
        next.codex.projects = { ...next.codex.projects, [name]: project.startsWith('~/') ? join(homedir(), project.slice(2)) : resolve(project) }; next.codex.defaultProject = name;
        try {
          // Validate without writing invalid paths to the user's configuration.
          const { realpathSync, statSync } = await import('node:fs');
          const { homedir } = await import('node:os');
          const p = realpathSync(next.codex.projects[name]);
          if (!statSync(p).isDirectory() || p === '/' || p === homedir()) throw new Error();
          next.codex.projects[name] = p; raw = next; break;
        } catch { ui.info(tr("onboarding.chooseExistingSpecificProjectDirectoryRootHome")); }
      }
      const dev = await ui.confirm(tr("onboarding.allowProjectEditsTestsLocalGitCommits"), raw.codex.sandbox === 'workspace-write');
      raw.codex.sandbox = dev ? 'workspace-write' : 'read-only'; raw.codex.allowLocalCommits = dev;
      raw.codex.networkAccess = await ui.confirm(tr("onboarding.allowNetworkAccessAgentCommands"), raw.codex.networkAccess === true);
      for (;;) {
        const domain = (await ui.text(tr("onboarding.platformFeishuLark"), raw.feishu?.domain ?? 'feishu')).toLowerCase();
        if (['feishu', 'lark'].includes(domain)) { raw.feishu.domain = domain; break; }
      }
      ui.info(tr("onboarding.createInternalAppEnableBotCapabilitiesCustom", raw.feishu.domain === 'lark' ? FEISHU_GUIDE.larkConsole : FEISHU_GUIDE.console));
      for (;;) {
        raw.feishu.appId = await ui.text('App ID', raw.feishu.appId ?? '');
        if (/^cli_[a-fA-F0-9]{16}$/.test(raw.feishu.appId)) break;
        ui.info(tr("onboarding.appIdShouldStartCliCopyApp"));
      }
      raw.feishu.appSecret = await ui.text(tr("onboarding.appSecretHiddenInput"), raw.feishu.appSecret ?? '', true);
    }
    parseConfig(raw,file); editor.save(raw); checkpoint('agent');
    let config = loadConfig(file);
    let checks = await deps.probe(config);
    for (const check of checks) ui.info(`${check.status === 'ok' ? '✓' : '!'} ${check.message}${check.next ? `\n  ${check.next}` : ''}`);
    if (checks.some(c => c.status === 'fail')) {
      if (checks.some(c => c.id === 'agent.auth' && c.status === 'fail') && await ui.confirm(tr("onboarding.signNamosIsolatedCodexEnvironmentUsingOfficial"))) {
        await deps.login(config); checks = await deps.probe(config);
      }
      if (checks.some(c => c.status === 'fail')) { ui.info(tr("onboarding.agentChecksNotPassedFixIssueRun")); return result; }
    }
    checkpoint('feishu');
    assertNoLegacyReceiver(config.feishu.appId);
    releaseReceiver = acquireLock(receiverDir(config.feishu.appId));
    connection = deps.connection(config);
    if (!await connection.credentials()) throw new Error(tr("onboarding.feishuCredentialValidationFailedCheckAppId"));
    ui.info(tr("onboarding.feishuCredentialsValidStartingSetupPairingConnection"));
    await connection.connect(e => { for (const fn of listeners) fn(e); });
    ui.info(tr("onboarding.setupConnectionOnlineKeepWindowOpenComplete", FEISHU_GUIDE.event, FEISHU_GUIDE.scopes.map(s => `   ${s}`).join('\n'), FEISHU_GUIDE.websocket));
    if (!await ui.confirm(tr("onboarding.youConfiguredSubscriptionsPublishedAppFoundBot"))) { ui.info(tr("onboarding.waitingPlatformSetupYouCanExitRun")); return result; }
    const bot = await connection.identity(); ui.info(tr("onboarding.botIdentified", bot.name));
    checkpoint('pairing');
    if (!config.feishu.access && (!config.feishu.allowedUserIds.length || await ui.confirm(tr("onboarding.pairAnotherUserExistingAuthorizedUsersRetained")))) {
      const candidate = await waitForPairing(subscribe, ui);
      if (!await ui.confirm(tr("onboarding.directMessageVerificationReceivedUserIdEnding", candidate.senderId.slice(-6)))) { ui.info(tr("onboarding.noNewUserWasAuthorized")); return result; }
      raw.feishu.allowedUserIds = [...new Set([...(raw.feishu.allowedUserIds ?? []), candidate.senderId])];
      parseConfig(raw,file); editor.save(raw); config = loadConfig(file); checkpoint('verification');
    }
    validateFeishu(config); result.configured = true;
    checkpoint('verification');
    if (state.verification?.status === 'complete') {
      result.verified = true; ui.info(tr("onboarding.configurationAlreadyCompleteVerificationReceiptModelMessaging"));
    } else if (await ui.confirm(tr("onboarding.runRealEndEndTestCallsCodex"))) {
      const interrupted = ['running', 'sending', 'unknown'].includes(state.verification?.status);
      if (interrupted && !await ui.confirm(tr("onboarding.previousTestOutcomeUnconfirmedCheckFeishuFirst"))) return result;
      const candidate = await waitForPairing(subscribe, ui, config.feishu.allowedUserIds);
      state.verification = { status: 'running', inputMessageId: candidate.messageId }; checkpoint('verification');
      if (!await deps.live(config)) throw new Error(tr("onboarding.realAgentTestFailedNoSuccessMessage"));
      const uuid = randomUUID();
      state.verification = { status: 'sending', inputMessageId: candidate.messageId, uuid }; checkpoint('verification');
      let receipt: string;
      try { receipt = await connection.send(candidate.chatId, tr("onboarding.namoSetupVerifiedMessageReceivedCodexExecution"), uuid); }
      catch { state.verification.status = 'unknown'; checkpoint('verification'); throw new Error(tr("onboarding.testReplyDeliveryUnconfirmedCheckFeishuFirst")); }
      state.verification = { status: 'complete', inputMessageId: candidate.messageId, receipt, uuid }; checkpoint('complete');
      result.verified = true; ui.info(tr("onboarding.feishuInboundCodexExecutionFeishuSendReceipt"));
    } else ui.info(tr("onboarding.endEndDeliveryNotVerifiedYetRun"));
  } finally { connection?.close(); releaseReceiver?.(); releaseData(); }
  if (result.configured) {
    const config = loadConfig(file);
    await optionalAssistantSetup(config,ui);
    if (process.platform === 'darwin' && await ui.confirm(tr("onboarding.installStartMacosBackgroundServiceLogin"))) {
      ui.info(tr("onboarding.installingServiceWaitingConnectionReadinessUpSeconds"));
      const service = await deps.install(config); result.serviceInstalled = true; result.serviceReady = service.ready;
      ui.info(service.ready ? tr("onboarding.backgroundServiceConnectedReady") : tr("onboarding.serviceRegisteredButConnectionReadinessUnconfirmedRun"));
    } else ui.info(tr("onboarding.startForegroundNamoStartConfig", JSON.stringify(file)));
    ui.info(tr("onboarding.configurationUsefulCommandsNamoStatusNamoDoctor", result.verified ? tr("onboarding.endEndVerificationComplete") : tr("onboarding.savedEndEndDeliveryNotYetVerified")));
  }
  return result;
}
