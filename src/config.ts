import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { configFile } from './paths.js';

export interface Config {
  file: string;
  dataDir: string;
  feishu: {
    appId: string; appSecret: string; allowedUserIds: string[];
    allowedChatIds: string[]; requireMention: boolean; domain: 'feishu' | 'lark';
  };
  codex: {
    bin: string; home: string; model?: string; timeoutMs: number;
    sandbox: 'read-only' | 'workspace-write';
    projects?: Record<string, string>; defaultProject?: string;
    networkAccess?: boolean; readPaths?: string[]; denyPaths?: string[]; allowLocalCommits?: boolean;
  };
  concurrency: number;
  agent?: 'codex';
}

export function loadConfig(file?: string): Config {
  const absolute = configFile(file);
  const d = JSON.parse(readFileSync(absolute, 'utf8'));
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('配置必须是 JSON 对象');
  if (d.version !== undefined && d.version !== 1) throw new Error('配置版本不受支持，请使用对应版本的 Namo；没有自动覆盖配置');
  const path = (p: string) => p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(dirname(absolute), p);
  const list = (v: unknown, name: string): string[] => {
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim())) throw new Error(`${name} 必须是字符串数组`);
    return [...new Set(v as string[])];
  };
  const f = d.feishu ?? {};
  const c = d.codex ?? {};
  if (d.agent !== undefined && d.agent !== 'codex') throw new Error('当前版本只支持 codex；Claude Code 和 OpenClaw Gateway 尚未接入');
  for (const [name, value] of Object.entries({ dataDir: d.dataDir, 'feishu.appId': f.appId,
    'feishu.appSecret': f.appSecret, 'feishu.appSecretEnv': f.appSecretEnv, 'codex.bin': c.bin,
    'codex.home': c.home, 'codex.model': c.model })) {
    if (value !== undefined && typeof value !== 'string') throw new Error(`${name} 必须是字符串`);
  }
  if (f.domain !== undefined && !['feishu', 'lark'].includes(f.domain)) throw new Error('feishu.domain 只能是 feishu 或 lark');
  if (f.requireMention !== undefined && typeof f.requireMention !== 'boolean') throw new Error('feishu.requireMention 必须是布尔值');
  if (d.dataDir === '' || c.home === '' || c.bin === '') throw new Error('dataDir、codex.home、codex.bin 不能是空字符串');
  const concurrency = d.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('concurrency 必须在 1–8 之间');
  if (!['read-only', 'workspace-write'].includes(c.sandbox ?? 'read-only')) throw new Error('codex.sandbox 只能是 read-only 或 workspace-write');
  const timeoutMs = c.timeoutMs ?? 600_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 7_200_000) throw new Error('codex.timeoutMs 必须在 1000–7200000 之间');
  const dataDir = path(d.dataDir ?? './data');
  if (c.networkAccess !== undefined && typeof c.networkAccess !== 'boolean') throw new Error('codex.networkAccess 必须是布尔值');
  if (c.allowLocalCommits !== undefined && typeof c.allowLocalCommits !== 'boolean') throw new Error('codex.allowLocalCommits 必须是布尔值');
  if (c.allowLocalCommits === true && c.sandbox !== 'workspace-write') throw new Error('本地提交需要 codex.sandbox 为 workspace-write');
  const projects: Record<string, string> = {};
  if (c.projects !== undefined && (!c.projects || typeof c.projects !== 'object' || Array.isArray(c.projects))) throw new Error('codex.projects 必须是项目名到目录的对象');
  for (const [name, value] of Object.entries(c.projects ?? {})) {
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(name) || typeof value !== 'string' || !value.trim()) throw new Error('项目名只能包含字母、数字、下划线和连字符，目录不能为空');
    const dir = realpathSync(path(value));
    if (!statSync(dir).isDirectory() || dir === '/' || dir === homedir()) throw new Error('项目必须是存在的具体目录，不能使用根目录或主目录');
    projects[name] = dir;
  }
  if (c.defaultProject !== undefined && (typeof c.defaultProject !== 'string' || !Object.hasOwn(projects, c.defaultProject))) throw new Error('codex.defaultProject 必须指向已配置项目');
  if (Object.keys(projects).length && !c.defaultProject) throw new Error('配置项目后必须指定 codex.defaultProject');
  return {
    file: absolute, dataDir, concurrency, agent: 'codex',
    feishu: {
      appId: f.appId ?? '',
      appSecret: f.appSecret || process.env[f.appSecretEnv ?? 'FEISHU_APP_SECRET'] || '',
      allowedUserIds: list(f.allowedUserIds ?? [], 'feishu.allowedUserIds'),
      allowedChatIds: list(f.allowedChatIds ?? [], 'feishu.allowedChatIds'),
      requireMention: f.requireMention !== false,
      domain: f.domain === 'lark' ? 'lark' : 'feishu',
    },
    codex: {
      bin: c.bin && (c.bin.includes('/') || c.bin.includes('\\')) ? path(c.bin) : c.bin ?? 'codex', home: path(c.home ?? `${dataDir}/codex-home`),
      model: c.model || undefined, timeoutMs, sandbox: c.sandbox ?? 'read-only',
      projects, defaultProject: c.defaultProject, networkAccess: c.networkAccess ?? false,
      allowLocalCommits: c.allowLocalCommits ?? false,
      readPaths: list(c.readPaths ?? [], 'codex.readPaths').map(p => realpathSync(path(p))),
      denyPaths: [...new Set([absolute, dataDir, path(c.home ?? `${dataDir}/codex-home`),
        ...list(c.denyPaths ?? [], 'codex.denyPaths').map(path)])],
    },
  };
}

export function validateFeishu(config: Config): void {
  if (!config.feishu.appId || !config.feishu.appSecret) throw new Error('请在 config.local.json 填写飞书 appId 和 appSecret，或设置 appSecretEnv 指向的环境变量');
  if (!config.feishu.allowedUserIds.length) throw new Error('请填写 feishu.allowedUserIds（允许使用 bot 的用户 open_id）；空数组拒绝所有人');
}
