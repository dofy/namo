import { parseAgentRegistry, type AgentRegistryConfig } from './agent-registry.js';
import { t as tr } from './locale.js';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { configFile } from './paths.js';
import { parseGitHubAccessConfig, type GitHubAccessConfig } from './github-access.js';
import { parseMcpConnections, type McpConnection } from './mcp-connections.js';
import { parseOrganization, parseAudience, type OrganizationAccess, type ProjectAccess } from './access.js';

export interface Config {
  file: string;
  dataDir: string;
  feishu: {
    appId: string; appSecret: string; allowedUserIds: string[];
    access?: OrganizationAccess;
    allowedChatIds: string[]; requireMention: boolean; domain: 'feishu' | 'lark';
    cards?: boolean; reactions?: boolean; progressUpdates?: boolean;
    progressDelayMs?: number; progressIntervalMs?: number; progressHeartbeatMs?: number;
  };
  codex: {
    bin: string; home: string; model?: string; allowedModels?: string[]; dailyTurnLimit?:number; timeoutMs: number;
    sandbox: 'read-only' | 'workspace-write';
    projects?: Record<string, string>; defaultProject?: string;
    projectAccess?: Record<string, ProjectAccess>; accessScope?: string; managedMcp?: boolean;
    networkAccess?: boolean; explicitDenyPaths?:string[]; readPaths?: string[]; denyPaths?: string[]; allowLocalCommits?: boolean;
  };
  gitApprovals?: {
    gitBin?: string; sshCommand?: string; maxTtlMs: number;
    remotes: Array<{ name: string; url: string; transport: 'https' | 'ssh' | 'local-test'; credentialHelpers?: string[] }>;
  };
  concurrency: number;
  retention?: { enabled:true; inboxDays:number };
  github?: GitHubAccessConfig;
  mcpConnections?: McpConnection[];
  agent?: 'codex';
  agents?: AgentRegistryConfig;
}

export function loadConfig(file?: string): Config {
  const absolute = configFile(file);
  const d = JSON.parse(readFileSync(absolute, 'utf8'));
  return parseConfig(d, absolute);
}
export function parseConfig(d: any, absolute: string): Config {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(tr("config.configurationMustJsonObject"));
  if (d.version !== undefined && d.version !== 1) throw new Error(tr("config.unsupportedConfigurationVersionUseMatchingVersionNamo"));
  const path = (p: string) => p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(dirname(absolute), p);
  const list = (v: unknown, name: string): string[] => {
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim())) throw new Error(tr("config.mustArrayStrings", name));
    return [...new Set(v as string[])];
  };
  const f = d.feishu ?? {};
  const c = d.codex ?? {};
  const retention=d.retention;
  if(retention?.enabled===true&&retention?.acknowledgeRedaction===true&&(typeof retention!=='object'||Array.isArray(retention)||Object.keys(retention).some(k=>!['enabled','inboxDays','acknowledgeRedaction'].includes(k))||!Number.isSafeInteger(retention.inboxDays)||retention.inboxDays<1||retention.inboxDays>3650))throw new Error('retention_invalid');
  const allowedModels=list(c.allowedModels??[],'codex.allowedModels');
  if(allowedModels.length>100 || allowedModels.some(model=>!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)))throw new Error('codex_allowed_models_invalid');
  const github=parseGitHubAccessConfig(d.github,process.env);
  const pairedUserIds=list(f.allowedUserIds??[],'feishu.allowedUserIds');
  if(github?.mode==='simple' && !pairedUserIds.includes(github.ownerUserId!))throw new Error('github_owner_not_paired');
  const access = parseOrganization(f.access);
  if(c.dailyTurnLimit!==undefined&&(!Number.isSafeInteger(c.dailyTurnLimit)||c.dailyTurnLimit<0||c.dailyTurnLimit>10000))throw new Error('codex_daily_turn_limit_invalid');
  if(!access && github?.allowedUserIds.some(id=>!pairedUserIds.includes(id)))throw new Error('github_access_user_not_paired');
  const mcpConnections = parseMcpConnections(d.mcpConnections);
  const g = d.gitApprovals ?? {};
  if (!g || typeof g !== 'object' || Array.isArray(g)) throw new Error('gitApprovals must be an object');
  if (d.agent !== undefined && d.agent !== 'codex') throw new Error(tr("config.codexOnly"));
  for (const [name, value] of Object.entries({ dataDir: d.dataDir, 'feishu.appId': f.appId,
    'feishu.appSecret': f.appSecret, 'feishu.appSecretEnv': f.appSecretEnv, 'codex.bin': c.bin,
    'codex.home': c.home, 'codex.model': c.model, 'gitApprovals.gitBin': g.gitBin, 'gitApprovals.sshCommand': g.sshCommand })) {
    if (value !== undefined && typeof value !== 'string') throw new Error(tr("config.mustString", name));
  }
  if (f.domain !== undefined && !['feishu', 'lark'].includes(f.domain)) throw new Error(tr("config.feishuDomainMustFeishuLark"));
  if (f.requireMention !== undefined && typeof f.requireMention !== 'boolean') throw new Error(tr("config.feishuRequirementionMustBoolean"));
  if (f.cards !== undefined && typeof f.cards !== 'boolean') throw new Error(tr("config.feishuCardsMustBoolean"));
  for (const key of ['reactions','progressUpdates']) if (f[key] !== undefined && typeof f[key] !== 'boolean') throw new Error(`feishu.${key} must be boolean`);
  for (const [key,min,max] of [['progressDelayMs',0,120000],['progressIntervalMs',5000,60000],['progressHeartbeatMs',30000,300000]] as const) if (f[key] !== undefined && (!Number.isSafeInteger(f[key]) || f[key]<min || f[key]>max)) throw new Error(`feishu.${key} must be between ${min} and ${max}`);
  if (d.dataDir === '' || c.home === '' || c.bin === '') throw new Error(tr("config.datadirCodexHomeCodexBinMustNot"));
  const concurrency = d.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error(tr("config.concurrencyMustBetween"));
  if (!['read-only', 'workspace-write'].includes(c.sandbox ?? 'read-only')) throw new Error(tr("config.codexSandboxMustReadWorkspaceWrite"));
  const timeoutMs = c.timeoutMs ?? 600_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 7_200_000) throw new Error(tr("config.codexTimeoutmsMustBetween"));
  const dataDir = path(d.dataDir ?? './data');
  if (c.networkAccess !== undefined && typeof c.networkAccess !== 'boolean') throw new Error(tr("config.codexNetworkaccessMustBoolean"));
  if (c.allowLocalCommits !== undefined && typeof c.allowLocalCommits !== 'boolean') throw new Error(tr("config.codexAllowlocalcommitsMustBoolean"));
  if (c.allowLocalCommits === true && c.sandbox !== 'workspace-write') throw new Error(tr("config.localCommitsRequireCodexSandboxWorkspaceWrite"));
  const projects: Record<string, string> = {};
  if (c.projects !== undefined && (!c.projects || typeof c.projects !== 'object' || Array.isArray(c.projects))) throw new Error(tr("config.codexProjectsMustMapProjectNamesDirectories"));
  for (const [name, value] of Object.entries(c.projects ?? {})) {
    if (['__proto__','prototype','constructor'].includes(name) || !/^[a-zA-Z0-9_-]{1,48}$/.test(name) || typeof value !== 'string' || !value.trim()) throw new Error(tr("config.projectNamesMayContainLettersNumbersUnderscores"));
    const dir = realpathSync(path(value));
    if (!statSync(dir).isDirectory() || dir === '/' || dir === homedir()) throw new Error(tr("config.projectMustExistingSpecificDirectoryNotRoot"));
    projects[name] = dir;
  }
  for (const connection of mcpConnections) if (connection.projects.some(name => !Object.hasOwn(projects,name))) throw new Error('mcp_unknown_project');
  if (c.defaultProject !== undefined && (typeof c.defaultProject !== 'string' || !Object.hasOwn(projects, c.defaultProject))) throw new Error(tr("config.codexDefaultprojectMustReferenceConfiguredProject"));
  if (Object.keys(projects).length && !c.defaultProject) throw new Error(tr("config.setCodexDefaultprojectProjectsConfigured"));
  const projectAccess: Record<string, ProjectAccess> = {};
  if (c.projectAccess !== undefined && (!c.projectAccess || typeof c.projectAccess !== 'object' || Array.isArray(c.projectAccess))) throw new Error('project_access_invalid');
  for (const [name, raw] of Object.entries(c.projectAccess ?? {})) {
    if (!Object.hasOwn(projects,name)) throw new Error('project_access_unknown_project');
    const audience = parseAudience(raw), permission = (raw as any).permission;
    if (!['read-only','workspace-write'].includes(permission)) throw new Error('project_access_invalid_permission');
    projectAccess[name] = {...audience,permission};
  }
  if (g.maxTtlMs !== undefined && (!Number.isSafeInteger(g.maxTtlMs) || g.maxTtlMs < 1_000 || g.maxTtlMs > 900_000)) throw new Error('gitApprovals.maxTtlMs must be between 1000 and 900000');
  if (g.remotes !== undefined && !Array.isArray(g.remotes)) throw new Error('gitApprovals.remotes must be an array');
  const gitRemotes: NonNullable<Config['gitApprovals']>['remotes'] = [];
  const remoteNames = new Set<string>();
  for (const value of g.remotes ?? []) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.name) || remoteNames.has(value.name) ||
      typeof value.url !== 'string' || !value.url || !['https', 'ssh', 'local-test'].includes(value.transport) ||
      value.credentialHelpers !== undefined && (!Array.isArray(value.credentialHelpers) || value.credentialHelpers.some((helper: unknown) => typeof helper !== 'string' || !helper))) {
      throw new Error('Each gitApprovals remote needs a unique safe name, URL, transport, and string credentialHelpers');
    }
    remoteNames.add(value.name); gitRemotes.push({ name: value.name, url: value.url, transport: value.transport, credentialHelpers: value.credentialHelpers ? [...new Set(value.credentialHelpers as string[])] : undefined });
  }
  return {
    file: absolute, dataDir, concurrency, agent: 'codex', github, mcpConnections, ...(retention?.enabled===true&&retention?.acknowledgeRedaction===true?{retention:{enabled:true as const,inboxDays:retention.inboxDays}}:{}),
    agents: parseAgentRegistry(d.agents, dirname(absolute)),
    feishu: {
      appId: f.appId ?? '',
      appSecret: f.appSecret || process.env[f.appSecretEnv ?? 'FEISHU_APP_SECRET'] || '',
      allowedUserIds: pairedUserIds,
      ...(access ? {access} : {}),
      allowedChatIds: list(f.allowedChatIds ?? [], 'feishu.allowedChatIds'),
      requireMention: f.requireMention !== false,
      cards: f.cards === true, reactions:f.reactions!==false, progressUpdates:f.progressUpdates!==false,
      progressDelayMs:f.progressDelayMs??200, progressIntervalMs:f.progressIntervalMs??5000, progressHeartbeatMs:f.progressHeartbeatMs??30000,
      domain: f.domain === 'lark' ? 'lark' : 'feishu',
    },
    codex: {
      bin: c.bin && (c.bin.includes('/') || c.bin.includes('\\')) ? path(c.bin) : c.bin ?? 'codex', home: path(c.home ?? `${dataDir}/codex-home`),
      model: c.model || undefined, allowedModels, dailyTurnLimit:c.dailyTurnLimit??(access?100:0), timeoutMs, sandbox: c.sandbox ?? 'read-only',
      projects, defaultProject: c.defaultProject, networkAccess: c.networkAccess ?? false,
      ...(c.projectAccess !== undefined ? {projectAccess} : {}),
      allowLocalCommits: c.allowLocalCommits ?? false,
      readPaths: list(c.readPaths ?? [], 'codex.readPaths').map(p => realpathSync(path(p))),
      explicitDenyPaths:list(c.denyPaths??[], 'codex.denyPaths').map(path),
      denyPaths: [...new Set([absolute, dataDir, path(c.home ?? `${dataDir}/codex-home`),
        ...list(c.denyPaths ?? [], 'codex.denyPaths').map(path)])],
    },
    gitApprovals: { gitBin: g.gitBin ? path(g.gitBin) : undefined, sshCommand: g.sshCommand ? path(g.sshCommand) : undefined,
      maxTtlMs: g.maxTtlMs ?? 900_000, remotes: gitRemotes },
  };
}

export function validateFeishu(config: Config): void {
  if (!config.feishu.appId || !config.feishu.appSecret) throw new Error(tr("config.setFeishuAppidAppsecretConfigLocalJson"));
  if (!config.feishu.access && !config.feishu.allowedUserIds.length) throw new Error(tr("config.setFeishuAlloweduseridsAllowedUsersOpenId"));
}
