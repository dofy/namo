import type { ApplyResult, ConfigValues, ConfigView, Diagnostic, Issue, ManagementState, ResolutionAction, TaskDetail } from '../src/ui-contract';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin', signal,
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || '请求未完成，请刷新后重试', response.status);
  return data as T;
}
export const api = {
  session: (code: string) => request('/api/session', { code }),
  state: (signal?: AbortSignal) => request<ManagementState>('/api/state', undefined, signal),
  task: (id: string, signal?: AbortSignal) => request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`, undefined, signal),
  issue: (id: string, signal?: AbortSignal) => request<Issue>(`/api/issues/${encodeURIComponent(id)}`, undefined, signal),
  save: (revision: string, patch: ConfigValues & { newSecret: string }) => request<ConfigView>('/api/config', { revision, patch }),
  apply: (revision: string) => request<ApplyResult>('/api/apply', { revision, confirmed: true }),
  cancel: (task: TaskDetail) => request('/api/cancel', { id: task.id, inputVersion: task.inputVersion, requestId: crypto.randomUUID() }),
  resolve: (issue: Issue, action: ResolutionAction, note: string) => request('/api/resolve', {
    subject: issue.subject, stamp: issue.stamp, action, note, requestId: crypto.randomUUID(), acknowledgeDuplicate: action === 'retry',
  }),
  diagnose: () => request<Diagnostic[]>('/api/diagnose', {}),
};
export const message = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试';
