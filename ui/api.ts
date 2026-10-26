import { t as tr, getLocale } from './i18n';
import type { ApplyResult, BrowseOptions, ConfigValues, ConfigView, Dashboard, Diagnostic, Issue, ManagementState, PageResult, ProfileValues, ResolutionAction, SessionSummary, TaskDetail, TaskList, UserProfile } from '../src/ui-contract';

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
  if (!response.ok) throw new ApiError(data.error || tr("请求未完成，请刷新后重试"), response.status);
  return data as T;
}
export const api = {
  session: (code: string) => request('/api/session', { code }),
  state: (signal?: AbortSignal) => request<ManagementState>('/api/state', undefined, signal),
  tasks: (query: string, signal?: AbortSignal) => request<TaskList>(`/api/tasks?${query}`, undefined, signal),
  sessions: (query: string, signal?: AbortSignal) => request<PageResult<SessionSummary>>(`/api/sessions?${query}`, undefined, signal),
  dashboard: (signal?: AbortSignal) => request<Dashboard>('/api/dashboard', undefined, signal),
  browseOptions: (signal?: AbortSignal) => request<BrowseOptions>('/api/browse-options', undefined, signal),
  task: (id: string, signal?: AbortSignal) => request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`, undefined, signal),
  issue: (id: string, signal?: AbortSignal) => request<Issue>(`/api/issues/${encodeURIComponent(id)}`, undefined, signal),
  save: (revision: string, patch: ConfigValues & { newSecret: string }) => request<ConfigView>('/api/config', { revision, patch }),
  apply: (revision: string) => request<ApplyResult>('/api/apply', { revision, confirmed: true }),
  cancel: (task: TaskDetail) => request('/api/cancel', { id: task.id, inputVersion: task.inputVersion, requestId: crypto.randomUUID() }),
  resolve: (issue: Issue, action: ResolutionAction, note: string) => request('/api/resolve', {
    subject: issue.subject, stamp: issue.stamp, action, note, requestId: crypto.randomUUID(), acknowledgeDuplicate: action === 'retry',
  }),
  diagnose: () => request<Diagnostic[]>('/api/diagnose', {}),
  saveProfile: (configRevision: string, profile: UserProfile, patch: ProfileValues) => request<UserProfile>('/api/profiles', { configRevision, userId: profile.userId, version: profile.version, patch }),
};
export const message = (error: unknown) => error instanceof Error ? error.message : tr("操作未完成，请重试");
