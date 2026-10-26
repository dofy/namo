/** Browser-visible projections only. Never include configuration or auth secrets. */
export interface ConfigValues {
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
}
export interface ConfigView {
  revision: string;
  valid: boolean;
  application: 'stopped' | 'unknown' | 'applied' | 'pending';
  values: ConfigValues;
  file: string;
  feishu: { appId: string; domain: string; secretConfigured: boolean; pairedUsers: number; restrictedChats: number };
}
export interface TaskSummary {
  id: string; workstreamId: string; project: string | null; state: string; inputVersion: number;
  startedAt: number | null; finishedAt: number | null; error: string | null;
}
export type ResolutionAction = 'received' | 'retry' | 'dismiss' | 'reviewed';
export interface Issue {
  subject: string; stamp: string; type: 'delivery' | 'task'; state: string; taskId?: string;
  error?: string; content?: string; reviewed: boolean; actionable: boolean;
  actions: ResolutionAction[]; guidance: string;
  history: { action: string; note: string; createdAt: number }[];
}
export interface ManagementState {
  service: { running?: boolean; ready?: boolean; connection?: string };
  config: ConfigView;
  database: {
    schema: number; tasks: TaskSummary[]; issues: Issue[];
    workstreams: { id: string; project: string | null; createdAt: number }[];
  };
  recoveryAvailable: boolean;
}
export interface TaskDetail {
  id: string; workstream: string; project: string | null; cwd: string; execution: string; inputVersion: number;
  startedAt: number | null; finishedAt: number | null; error: string | null;
  messages: { role: string; version: number; dispatch: string }[];
  runs: { id: string; inputVersion: number; state: string; startedAt: number; finishedAt: number | null; error: string | null }[];
  delivery: { kind: string; part: number; state: string; error: string | null }[];
  results: { content: string; state: string; part: number }[];
}
export interface Diagnostic { id: string; status: 'ok' | 'warn' | 'fail'; message: string; next?: string }
export interface ApplyResult { ready: boolean; config: ConfigView; message: string }
