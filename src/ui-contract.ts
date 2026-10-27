import type { Audience, OrganizationAccess, ProjectAccess } from './access-contract.js';
/** Browser-visible projections only. Never include configuration or auth secrets. */
export const uiRoutes = { dashboard: '/', tasks: '/tasks', sessions: '/sessions', settings: '/settings', assistant: '/assistant', memory: '/memory', profiles: '/profiles', connections: '/connections' } as const;
export type UiPage = keyof typeof uiRoutes;

export interface ConfigValues {
  projectAccess?: Record<string, ProjectAccess>;
  projects: Record<string, string>;
  defaultProject: string;
  sandbox: 'read-only' | 'workspace-write';
  networkAccess: boolean;
  allowLocalCommits: boolean;
  concurrency: number;
  model: string;
  bin: string;
  timeoutMs: number;
  readPaths: string[];
  denyPaths: string[];
  cards: boolean;
  requireMention: boolean;
  reactions?: boolean;
  progressUpdates?: boolean;
  progressDelayMs?: number;
  progressIntervalMs?: number;
  progressHeartbeatMs?: number;
}
export interface ConfigView {
  revision: string;
  valid: boolean;
  application: 'stopped' | 'unknown' | 'applied' | 'pending';
  values: ConfigValues;
  file: string;
  feishu: { appId: string; domain: string; secretConfigured: boolean; pairedUsers: number; restrictedChats: number; access?:OrganizationAccess|null; allowedUserIds?:string[]; allowedChatIds?:string[] };
  agents: AgentRegistryView;
  github?: { mode?:'simple';ownerUserId?:string;credentialConfigured:boolean; credentialSource:string; localGh?:{login:string}; tokenEnv?:string; repositories:string[]; allowedUserIds:string[]; grants?:Array<Audience & {repository:string}> };
}
export interface GitHubConfigPatch { github: {mode?:'simple';ownerUserId?:string;source?:'gh'|'token'|'anonymous';repositories:string[];allowedUserIds:string[];grants?:Array<Audience & {repository:string}>};newGithubToken?:string;clearGithubToken?:boolean }
export type AgentAdapter = 'codex' | 'claude' | 'cursor';
export interface AgentProfileSpecView {
  adapter: AgentAdapter;
  enabled?: boolean;
  bin?: string;
  model?: string;
  timeoutMs?: number;
}
export interface AgentProfileView {
  id: string;
  adapter: AgentAdapter;
  enabled: boolean;
  bin: string;
  home: string;
  model?: string;
  timeoutMs: number;
  revision: string;
  available: boolean;
}
export interface AgentRegistryView {
  defaultProfile: string;
  memoryProfile: 'codex';
  profiles: AgentProfileView[];
  specs: Record<string, AgentProfileSpecView>;
}
export interface AgentRegistryPatch {
  agents: {
    defaultProfile?: string;
    memoryProfile?: 'codex';
    profiles?: Record<string, AgentProfileSpecView>;
  };
}
export interface TaskSummary {
  id: string; workstreamId: string; project: string | null; state: string; inputVersion: number;
  startedAt: number | null; finishedAt: number | null; error: string | null;
}
export interface TaskListItem extends TaskSummary {
  title: string; ownerId: string; ownerName: string; createdAt: number;
}
export interface SessionSummary {
  id: string; title: string; latestTitle: string; ownerId: string; ownerName: string; project: string | null;
  createdAt: number; lastActiveAt: number; taskCount: number; current: boolean;
  state: 'running' | 'waiting' | 'queued' | 'idle';
}
export interface BrowseOptions {
  users: { id: string; name: string }[]; projects: string[];
}
export interface PageResult<T> { items: T[]; total: number; page: number; pageSize: number; pages: number }
export interface TaskList extends PageResult<TaskListItem> { session: SessionSummary | null }
export interface Dashboard {
  generatedAt: number; timeZone: string; today: number; weekStart: number;
  totalTasks: number; totalSessions: number; activeUsers: number;
  running: number; waiting: number; queued: number; completedToday: number;
  successRate: number | null; averageDurationMs: number | null;
  failed: number; deliveryIssues: number;
  daily: { date: string; from: number; count: number }[];
  recent: TaskListItem[];
}
export type ResolutionAction = 'received' | 'retry' | 'dismiss' | 'reviewed';
export interface Issue {
  subject: string; stamp: string; type: 'delivery' | 'task'; state: string; taskId?: string;
  error?: string; content?: string; reviewed: boolean; actionable: boolean;
  actions: ResolutionAction[]; guidance: string;
  history: { action: string; note: string; createdAt: number }[];
}
export interface AssistantValues {
  name:string; role:string; personality:string; defaultLanguage:'auto'|'zh-CN'|'en-US'; replyLength:'concise'|'balanced'|'detailed'; conclusionFirst:boolean; technicalDetail:'essential'|'balanced'|'deep'; emoji:'never'|'sparingly'|'freely'; useProfile:boolean;
}
export interface AssistantView { schema:1; version:number; updatedAt:number|null; active:boolean; values:AssistantValues }
export type MemoryViewKind = 'preference' | 'user_fact' | 'project_knowledge' | 'task_summary' | 'history_quote' | 'handoff';
export type MemoryViewStatus = 'active' | 'pending_review' | 'disabled' | 'deleted';
export interface MemoryViewScope { kind:'owner'|'project'|'chat'|'global'|'local'; ownerId:string; project:string|null; chatKey:string|null }
export interface MemoryViewItem {
  id:string; version:number; kind:MemoryViewKind; status:MemoryViewStatus; scope:MemoryViewScope;
  source:{kind:string;ref:string}; text:string|null; usable:boolean; contentChars:number;
  visibility?:{privacy:'shared'|'private'|'chat';chatKey:string|null};
  createdAt:number; updatedAt:number; expiresAt:number|null;
}
export interface MemoryImportCandidate {
  migrationId:string;candidateId:string;candidateKind:'assistant'|'identity'|'user'|'memory'|'instructions'|'history';
  memoryKind:Exclude<MemoryViewKind,'handoff'>|null;source:{instanceId:string;version:string;accountId:string;fingerprint:string};
  name:string;bytes:number;fingerprint:string;eligible:boolean;reason?:string;
  imports:{scope:MemoryViewScope;memoryId:string;status:MemoryViewStatus;importedAt:number}[];
}
export interface MemoryViewState {
  available:boolean; reason?:string; ownerId:string; owners:{id:string;label:string}[];
  projects:string[]; chats:{chatKey:string;project:string|null}[]; items:MemoryViewItem[];imports:MemoryImportCandidate[];
  limits:{entryChars:number;ownerEntries:number;ownerChars:number;scopeEntries:number;scopeChars:number};
}
export type MemoryMutation =
  | {action:'save';ownerId:string;input:{kind:Exclude<MemoryViewKind,'handoff'>;scope:MemoryViewScope;text:string}}
  | {action:'import';ownerId:string;input:{migrationId:string;candidateId:string;fingerprint:string;scope:MemoryViewScope}}
  | {action:'correct';ownerId:string;id:string;version:number;text:string}
  | {action:'disable'|'delete'|'activate';ownerId:string;id:string;version:number};
export interface ManagementState {
  assistant?: AssistantView;
  service: { running?: boolean; ready?: boolean; connection?: string;
    release?: { installed?: string; running?: string; matches?: boolean; verified?: boolean } };
  config: ConfigView;
  database: {
    schema: number; tasks: TaskSummary[]; issues: Issue[];
    workstreams: { id: string; project: string | null; createdAt: number }[];
  };
  recoveryAvailable: boolean;
  profiles: ProfileState;
}
export interface ProfileIdentity { channel: 'feishu' | 'lark'; appId: string; userId: string }
export interface ProfileValues { name: string; language: string; timezone: string }
export interface ProfileChange {
  version: number; fields: (keyof ProfileValues)[]; source: 'self' | 'local-owner'; sourceRef: string | null; createdAt: number;
}
export interface UserProfile extends ProfileIdentity, ProfileValues {
  version: number; updatedAt: number | null; changes: ProfileChange[];
}
export interface ProfileState { available: boolean; reason?: string; configRevision: string; entries: UserProfile[] }
export interface TaskDetail {
  id: string; workstream: string; project: string | null; cwd: string; execution: string; inputVersion: number;
  startedAt: number | null; finishedAt: number | null; error: string | null;
  title?: string; ownerId?: string; ownerName?: string; createdAt?: number;
  messages: { role: string; version: number; dispatch: string }[];
  runs: { id: string; inputVersion: number; state: string; startedAt: number; finishedAt: number | null; error: string | null }[];
  delivery: { kind: string; part: number; state: string; error: string | null }[];
  results: { content: string; state: string; part: number }[];
  evidence?: RunEvidence[];
  waits?: { id: string; runId: string; question: string; state: string; createdAt: number; settledAt: number | null }[];
  runners?: { runId: string; state: string; pid: number | null; createdAt: number; updatedAt: number; error: string | null;
    events: { kind: string; createdAt: number }[] }[];
}
export type EvidenceStatus = 'running' | 'completed' | 'failed' | 'declined' | 'unknown';
export interface EvidenceFile { path: string; action: 'add' | 'update' | 'delete'; movedTo?: string; existsAtFinish?: boolean }
export interface EvidenceItem {
  id: string; kind: 'command' | 'files' | 'artifact' | 'tool'; status: EvidenceStatus;
  label: string; cwd?: string; exitCode?: number; durationMs?: number;
  files?: EvidenceFile[]; path?: string; existsAtFinish?: boolean; limited?: boolean;
}
export interface RunEvidence {
  version: 1; runId: string; state: 'collecting' | 'finished' | 'partial'; truncated: boolean;
  items: EvidenceItem[];
  git: { before: string | null; after: string | null; status: 'unavailable' | 'unchanged' | 'changed' };
}
export interface Diagnostic { id: string; status: 'ok' | 'warn' | 'fail'; message: string; next?: string }
export interface ApplyResult { ready: boolean; config: ConfigView; message: string }

export interface ServiceAccessPatch { serviceAccess: {access:OrganizationAccess|null;allowedUserIds:string[];allowedChatIds:string[]}; projectAccess?:Record<string,ProjectAccess> }
