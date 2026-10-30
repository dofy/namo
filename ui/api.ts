import type { ApprovalAction, ApprovalList, ApprovalView, McpConnectionPatch, CodexUpdateStatus, ServiceLog, MigrationInspection, ServiceAccessPatch } from '../src/ui-contract';
import { t as tr, getLocale } from './i18n';
import type { ApplyResult, AssistantView, AssistantValues, BrowseOptions, ConfigValues, ConfigView, GitHubConfigPatch, Dashboard, Diagnostic, Issue, ManagementState, MemoryMutation, MemoryViewState, PageResult, ProfileValues, ResolutionAction, ScheduleListItem, SessionSummary, TaskDetail, TaskList, UserProfile } from '../src/ui-contract';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin', signal,
    headers: { 'Accept-Language': getLocale(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || tr("api.requestIncompleteRefreshTryAgain"), response.status);
  return data as T;
}
export const api = {
  organization:()=>request<{tenantKey:string;name:string}>('/api/organization',{}),
  mcpOAuthScopes:(revision:string,url:string)=>request<{scopes:string[];recommended:string[];published:boolean;issuer:string}>('/api/mcp-oauth-scopes',{revision,url}),
  cancelMcpOAuth:(id:string)=>request('/api/mcp-oauth-cancel',{id}),
  startMcpOAuth:(revision:string,id:string,draft?:McpConnectionPatch)=>request<{url:string;issuer:string}>('/api/mcp-oauth-start',{revision,id,draft}),
  codexMcp:()=>request<{revision:string;entries:{id:string;transport:'remote'|'stdio'|'unsupported';host?:string;importable:boolean;requiresOwnAuth:boolean;duplicateOf?:string;reason?:string}[]}>('/api/codex-mcp'),
  importCodexMcp:(revision:string,sourceRevision:string,ids:string[])=>request<ConfigView>('/api/codex-mcp-import',{revision,sourceRevision,ids}),
  testMcp:(revision:string,id:string)=>request<{toolCount:number}>('/api/mcp-test',{revision,id}),
  saveMcp:(revision:string,mcpConnections:McpConnectionPatch[])=>request<ConfigView>('/api/config',{revision,patch:{mcpConnections}}),
  saveAccess:(revision:string,patch:ServiceAccessPatch)=>request<ConfigView>('/api/config',{revision,patch}),
  assistantSave: (version:number,values:AssistantValues)=>request<AssistantView>('/api/assistant',{action:'save',version,values}),
  assistantReset: (version:number)=>request<AssistantView>('/api/assistant',{action:'reset',version}),
  assistantPreview: (values:AssistantValues)=>request<string>('/api/assistant',{action:'preview',values}),
  memories: (ownerId?:string,signal?:AbortSignal)=>request<MemoryViewState>(`/api/memories${ownerId?`?ownerId=${encodeURIComponent(ownerId)}`:''}`,undefined,signal),
  memory: (mutation:MemoryMutation)=>request<MemoryViewState>('/api/memories',{action:mutation.action,ownerId:mutation.ownerId,input:mutation.action==='save'?mutation.input:
    mutation.action==='import'?mutation.input:mutation.action==='correct'?{id:mutation.id,version:mutation.version,text:mutation.text}:{id:mutation.id,version:mutation.version}}),
  session: (code: string) => request('/api/session', { code }),
  state: (signal?: AbortSignal) => request<ManagementState>('/api/state', undefined, signal),
  models: (signal?: AbortSignal) => request<{id:string;name:string;isDefault:boolean}[]>('/api/models', undefined, signal),
  codexUpdate: (signal?: AbortSignal) => request<CodexUpdateStatus>('/api/codex-update', undefined, signal),
  changeCodexUpdate: (configRevision: string, action: 'check' | 'upgrade' | 'automatic' | 'rollback', enabled?: boolean) =>
    request<CodexUpdateStatus>('/api/codex-update', { action, configRevision, ...(enabled === undefined ? {} : { enabled }) }),
  tasks: (query: string, signal?: AbortSignal) => request<TaskList>(`/api/tasks?${query}`, undefined, signal),
  schedules: (query: string, signal?: AbortSignal) => request<PageResult<ScheduleListItem>>(`/api/schedules?${query}`, undefined, signal),
  sessions: (query: string, signal?: AbortSignal) => request<PageResult<SessionSummary>>(`/api/sessions?${query}`, undefined, signal),
  dashboard: (signal?: AbortSignal) => request<Dashboard>('/api/dashboard', undefined, signal),
  browseOptions: (signal?: AbortSignal) => request<BrowseOptions>('/api/browse-options', undefined, signal),
  task: (id: string, signal?: AbortSignal) => request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`, undefined, signal),
  issue: (id: string, signal?: AbortSignal) => request<Issue>(`/api/issues/${encodeURIComponent(id)}`, undefined, signal),
  save: (revision: string, patch: ConfigValues & { newSecret: string }) => request<ConfigView>('/api/config', { revision, patch }),
  saveGitHub: (revision: string, patch: GitHubConfigPatch) => request<ConfigView>('/api/config', { revision, patch }),
  apply: (revision: string) => request<ApplyResult>('/api/apply', { revision, confirmed: true }),
  cancel: (task: TaskDetail) => request('/api/cancel', { id: task.id, inputVersion: task.inputVersion, requestId: crypto.randomUUID() }),
  resolve: (issue: Issue, action: ResolutionAction, note: string) => request('/api/resolve', {
    subject: issue.subject, stamp: issue.stamp, action, note, requestId: crypto.randomUUID(), acknowledgeDuplicate: action === 'retry',
  }),
  diagnose: (live = false) => request<Diagnostic[]>('/api/diagnose', { live, confirmed: live }),
  logs: () => request<ServiceLog[]>('/api/logs'),
  approvals: () => request<ApprovalList>('/api/approvals'),
  approval: (input: ApprovalAction) => request<ApprovalView>('/api/approvals', input),
  inspectMigration: (sourceFile: string, sourceInstanceId: string) => request<MigrationInspection>('/api/migration-inspect', { sourceFile, sourceInstanceId }),
  saveProfile: (configRevision: string, profile: UserProfile, patch: ProfileValues) => request<UserProfile>('/api/profiles', { configRevision, userId: profile.userId, version: profile.version, patch }),
  saveUserModel: (configRevision: string, profile: UserProfile, model: string) => request<{model:string}>('/api/user-model', {configRevision,userId:profile.userId,expected:profile.defaultModel ?? '',model}),
};
export const message = (error: unknown) => error instanceof Error ? error.message : tr("api.actionIncompletePleaseTryAgain");
