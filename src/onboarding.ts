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
  return { version: 1, agent: 'codex', dataDir: join(dirname(file), 'data'), concurrency: 1,
    feishu: { appId: '', appSecret: '', appSecretEnv: 'FEISHU_APP_SECRET', allowedUserIds: [], allowedChatIds: [], requireMention: true, domain: 'feishu' },
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
    const timer = setTimeout(() => { cleanup(); reject(new Error(tr("配对码已过期，请重新运行 namo init；未授权任何新用户"))); }, 600_000);
    ui.signal?.addEventListener('abort', abort, { once: true });
    if (ui.signal?.aborted) { abort(); return; }
    ui.info(tr("请在飞书机器人的私聊中发送下面的单次代码（10 分钟有效）：\n{0}", challenge.code));
  });
}
export async function onboard(file: string, ui: Prompter, overrides: Partial<InitDeps> = {}): Promise<InitResult> {
  const deps = { ...defaults, ...overrides };
  const editor = new ConfigEditor(file);
  let raw = structuredClone(editor.value ?? initialConfig(file));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ['feishu', 'codex'].some(k => raw[k] != null && (typeof raw[k] !== 'object' || Array.isArray(raw[k])))) throw new Error(tr("配置结构无效，原文件未被覆盖"));
  if (raw.version !== undefined && raw.version !== 1) throw new Error(tr("配置版本不受支持，原文件未被覆盖"));
  raw.feishu ??= {}; raw.codex ??= {};
  const dataDir = raw.dataDir?.startsWith('~/') ? join(homedir(), raw.dataDir.slice(2)) : resolve(dirname(file), raw.dataDir ?? './data');
  if (activeData(dataDir)) throw new Error(tr("这份配置已有运行中的接收端。为保留当前服务，初始化未修改配置；先用 namo service stop 停止服务，或为其他应用指定 --config"));
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
    ui.info(tr("Namo 初始化 · 配置：{0}\n所有凭据仅保存在本机；Ctrl+C 后可重新运行继续。", file));
    if (editor.value) ui.info(tr("发现已有配置。保留未知字段、授权用户和数据；发生修改前自动备份原配置。"));
    const reuse = !!editor.value && !!raw.feishu.appId && !!raw.codex.defaultProject && await ui.confirm(tr("沿用现有 Agent、项目与飞书设置？"), true);
    if (!reuse) {
      ui.info(tr("首版执行后端：Codex（本地 CLI）。Claude Code 尚未适配；OpenClaw 属于已有 Gateway 服务，尚未接入。"));
      const found = detectAgents(raw.codex?.bin ?? 'codex').find(a => a.id === 'codex');
      raw.agent = 'codex'; raw.codex ??= initialConfig(file).codex;
      raw.codex.readPaths ??= toolchainPaths();
      raw.codex.bin = await ui.text(tr("Codex 可执行路径或命令"), found?.path ?? raw.codex.bin ?? 'codex');
      for (;;) {
        const previous = raw.codex.projects?.[raw.codex.defaultProject];
        const current = previous ? resolve(dirname(file), previous) : process.cwd();
        const project = await ui.text(tr("允许 Agent 工作的项目目录"), current);
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
        } catch { ui.info(tr("请选择存在的具体项目目录，不能使用根目录或主目录。")); }
      }
      const dev = await ui.confirm(tr("允许修改项目、运行测试和本地 Git 提交？（否则只读）"), raw.codex.sandbox === 'workspace-write');
      raw.codex.sandbox = dev ? 'workspace-write' : 'read-only'; raw.codex.allowLocalCommits = dev;
      raw.codex.networkAccess = await ui.confirm(tr("允许 Agent 命令联网？"), raw.codex.networkAccess === true);
      for (;;) {
        const domain = (await ui.text(tr("平台：feishu 或 lark"), raw.feishu?.domain ?? 'feishu')).toLowerCase();
        if (['feishu', 'lark'].includes(domain)) { raw.feishu.domain = domain; break; }
      }
      ui.info(tr("创建企业自建应用并开启机器人能力：{0}\n群自定义 webhook 机器人不支持本流程。", raw.feishu.domain === 'lark' ? FEISHU_GUIDE.larkConsole : FEISHU_GUIDE.console));
      for (;;) {
        raw.feishu.appId = await ui.text('App ID', raw.feishu.appId ?? '');
        if (/^cli_[a-fA-F0-9]{16}$/.test(raw.feishu.appId)) break;
        ui.info(tr("App ID 应为 cli_ 开头的应用标识，请从应用凭据页复制。"));
      }
      raw.feishu.appSecret = await ui.text(tr("App Secret（隐藏输入）"), raw.feishu.appSecret ?? '', true);
    }
    parseConfig(raw,file); editor.save(raw); checkpoint('agent');
    let config = loadConfig(file);
    let checks = await deps.probe(config);
    for (const check of checks) ui.info(`${check.status === 'ok' ? '✓' : '!'} ${check.message}${check.next ? `\n  ${check.next}` : ''}`);
    if (checks.some(c => c.status === 'fail')) {
      if (checks.some(c => c.id === 'agent.auth' && c.status === 'fail') && await ui.confirm(tr("现在通过官方浏览器流程登录 Namo 专用 Codex 环境？"))) {
        await deps.login(config); checks = await deps.probe(config);
      }
      if (checks.some(c => c.status === 'fail')) { ui.info(tr("Agent 检查尚未通过。修正后重新运行 namo init，已保存配置不会丢失。")); return result; }
    }
    checkpoint('feishu');
    assertNoLegacyReceiver(config.feishu.appId);
    releaseReceiver = acquireLock(receiverDir(config.feishu.appId));
    connection = deps.connection(config);
    if (!await connection.credentials()) throw new Error(tr("飞书凭据验证失败，请检查 App ID、Secret、所选平台和网络；重新运行 init 可修改设置"));
    ui.info(tr("✓ 飞书应用凭据有效。正在启动仅用于配置和配对的长连接，不会执行收到的任务。"));
    await connection.connect(e => { for (const fn of listeners) fn(e); });
    ui.info(tr("✓ 初始化长连接在线。请保持本窗口运行，在飞书后台完成：\n1. 事件与回调 → 使用长连接接收事件。\n2. 订阅 {0}。\n3. 申请以下消息权限，并设置应用可用范围：\n{1}\n4. 创建版本并发布；若需要管理员审批，请等待通过。\n指引：{2}", FEISHU_GUIDE.event, FEISHU_GUIDE.scopes.map(s => `   ${s}`).join('\n'), FEISHU_GUIDE.websocket));
    if (!await ui.confirm(tr("已配置订阅、发布应用，并能在飞书找到机器人？"))) { ui.info(tr("等待平台配置完成。退出不会丢失配置，稍后运行 namo init 继续。")); return result; }
    const bot = await connection.identity(); ui.info(tr("✓ 已识别机器人：{0}", bot.name));
    checkpoint('pairing');
    if (!config.feishu.access && (!config.feishu.allowedUserIds.length || await ui.confirm(tr("是否再配对一位用户？（已有授权用户保留）")))) {
      const candidate = await waitForPairing(subscribe, ui);
      if (!await ui.confirm(tr("收到私聊验证，用户标识末尾 {0}。允许此用户使用本地 Agent？", candidate.senderId.slice(-6)))) { ui.info(tr("没有新增授权用户。")); return result; }
      raw.feishu.allowedUserIds = [...new Set([...(raw.feishu.allowedUserIds ?? []), candidate.senderId])];
      parseConfig(raw,file); editor.save(raw); config = loadConfig(file); checkpoint('verification');
    }
    validateFeishu(config); result.configured = true;
    checkpoint('verification');
    if (state.verification?.status === 'complete') {
      result.verified = true; ui.info(tr("✓ 这份配置已有完整收发验证回执，不重复调用模型或发消息。"));
    } else if (await ui.confirm(tr("进行一次真实收发验证？会调用 Codex，可能消耗账号额度，并给已授权私聊发送测试回复。"))) {
      const interrupted = ['running', 'sending', 'unknown'].includes(state.verification?.status);
      if (interrupted && !await ui.confirm(tr("上次测试结果未确认。请先在飞书核实；确认允许重新测试（可能重复消息或消耗额度）？"))) return result;
      const candidate = await waitForPairing(subscribe, ui, config.feishu.allowedUserIds);
      state.verification = { status: 'running', inputMessageId: candidate.messageId }; checkpoint('verification');
      if (!await deps.live(config)) throw new Error(tr("真实 Agent 测试未通过；没有发送成功提示。请检查登录、模型额度与网络后再试"));
      const uuid = randomUUID();
      state.verification = { status: 'sending', inputMessageId: candidate.messageId, uuid }; checkpoint('verification');
      let receipt: string;
      try { receipt = await connection.send(candidate.chatId, tr("Namo 初始化验证通过：消息已接收，Codex 真实执行成功，本条回复用于验证出站链路。"), uuid); }
      catch { state.verification.status = 'unknown'; checkpoint('verification'); throw new Error(tr("测试回复的发送结果未确认，请先在飞书核实；重新运行不会自动重发或重跑模型")); }
      state.verification = { status: 'complete', inputMessageId: candidate.messageId, receipt, uuid }; checkpoint('complete');
      result.verified = true; ui.info(tr("✓ 飞书入站 → Codex 执行 → 飞书发送回执完整通过（不代表用户已读）。"));
    } else ui.info(tr("真实收发尚未验证；稍后可运行 namo init 继续。"));
  } finally { connection?.close(); releaseReceiver?.(); releaseData(); }
  if (result.configured) {
    const config = loadConfig(file);
    await optionalAssistantSetup(config,ui);
    if (process.platform === 'darwin' && await ui.confirm(tr("安装并启动 macOS 登录后自动运行的后台服务？"))) {
      ui.info(tr("正在安装服务并等待连接就绪（最多 90 秒）…"));
      const service = await deps.install(config); result.serviceInstalled = true; result.serviceReady = service.ready;
      ui.info(service.ready ? tr("✓ 后台服务已连接就绪。") : tr("服务已登记，但连接就绪尚未确认。请运行 namo service status / namo doctor / namo logs；不会把进程存在当成上线成功。"));
    } else ui.info(tr("前台启动：namo start --config {0}", JSON.stringify(file)));
    ui.info(tr("配置{0}。常用命令：namo status / namo doctor / namo logs", result.verified ? tr("及真实收发验证已完成") : tr("已保存，真实收发尚未验证")));
  }
  return result;
}
