import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import { GitHubReadError, GitHubRestAdapter, type GitHubObservation, type GitHubObservationAdapter,
  type GitHubTarget, type RequiredCheck } from './external-waits.js';

/** Explicit protected configuration; resolved credentials must never enter a prompt or public view. */
export interface GitHubAccessConfig {
  token?: string;
  tokenEnv?: string;
  repositories: string[];
  allowedUserIds: string[];
}

export interface GitHubAccessContext { taskId: string; ownerId: string; chatId: string }
export type ScopedGitHubObservation = GitHubObservation & { authorizationScope?: string };

export class GitHubAccessError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'GitHubAccessError'; }
}

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const USER = /^[^\u0000-\u0020\u007f-\u009f\u202a-\u202e\u2066-\u2069]{1,512}$/u;
const TOKEN = /^[\x21-\x7e]{1,4096}$/;
const TOKEN_ENV = /^NAMO_GITHUB_[A-Z][A-Z0-9_]{0,119}$/;
const READ_ERRORS = new Set(['github_fetch_unavailable', 'github_adapter_invalid_options', 'github_timeout',
  'github_rate_limited', 'github_read_failed', 'github_response_too_large', 'github_invalid_response', 'github_read_unknown']);

function repository(value: unknown): string {
  if (typeof value !== 'string' || !REPOSITORY.test(value) || ['.', '..'].includes(value.split('/')[1]!))
    throw new GitHubAccessError('github_access_invalid_repository');
  return value.toLowerCase();
}

function list(value: unknown, kind: 'repository' | 'user'): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw new GitHubAccessError('github_access_invalid_scope');
  return [...new Set(value.map(item => {
    if (kind === 'repository') return repository(item);
    if (typeof item !== 'string' || !USER.test(item) || item === '*') throw new GitHubAccessError('github_access_invalid_user');
    return item;
  }))].sort();
}

function token(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new GitHubAccessError('github_access_invalid_credential');
  return value;
}

/** No ambient credentials: callers must explicitly provide both raw settings and the environment to resolve. */
export function parseGitHubAccessConfig(raw: unknown, env: Readonly<Record<string, string | undefined>> = {}): GitHubAccessConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GitHubAccessError('github_access_invalid_config');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['token', 'tokenEnv', 'repositories', 'allowedUserIds'].includes(key)))
    throw new GitHubAccessError('github_access_invalid_config');
  if (value.token !== undefined && value.tokenEnv !== undefined) throw new GitHubAccessError('github_access_ambiguous_credential');
  const repositories = list(value.repositories, 'repository'), allowedUserIds = list(value.allowedUserIds, 'user');
  if (value.tokenEnv !== undefined) {
    if (typeof value.tokenEnv !== 'string' || !TOKEN_ENV.test(value.tokenEnv)) throw new GitHubAccessError('github_access_invalid_environment');
    const resolved = Object.hasOwn(env, value.tokenEnv) ? env[value.tokenEnv] : undefined;
    return { repositories, allowedUserIds, tokenEnv: value.tokenEnv, token: token(resolved) };
  }
  return { repositories, allowedUserIds, token: token(value.token) };
}

export function publicGitHubAccess(config?: GitHubAccessConfig) {
  return { credentialConfigured: !!config?.token, credentialSource: config?.tokenEnv ? 'environment' : config?.token ? 'token' : 'none',
    ...(config?.tokenEnv ? { tokenEnv: config.tokenEnv } : {}),
    repositories: [...(config?.repositories ?? [])], allowedUserIds: [...(config?.allowedUserIds ?? [])] };
}

/** A private credential is usable only for an exact repository and a verified owner task in a direct message. */
export class ScopedGitHubAdapter implements GitHubObservationAdapter {
  private readonly config: GitHubAccessConfig | undefined;
  constructor(private readonly store: Store, config?: GitHubAccessConfig, private readonly fetcher?: typeof globalThis.fetch) {
    // Clone the resolved configuration: callers cannot alter scope halfway through an observation.
    this.config = config ? { repositories: list(config.repositories, 'repository'), allowedUserIds: list(config.allowedUserIds, 'user'),
      token: token(config.token), ...(config.tokenEnv ? { tokenEnv: config.tokenEnv } : {}) } : undefined;
  }

  authorize(target: Readonly<GitHubTarget>, context?: GitHubAccessContext): string | undefined {
    const selected = repository(`${target.owner}/${target.repo}`);
    if (!this.config?.repositories.includes(selected)) return undefined;
    if (!context || !this.config.allowedUserIds.includes(context.ownerId)) throw new GitHubAccessError('github_access_denied');
    const row = this.store.db.prepare(`SELECT t.ownerId,t.chatKey,i.senderId,i.chatId,i.chatKey AS inboxChatKey,i.envelope
      FROM tasks t JOIN inbox i ON i.key=t.inboxKey WHERE t.id=?`).get(context.taskId);
    if (!row || row.ownerId !== context.ownerId || row.senderId !== context.ownerId || row.chatId !== context.chatId
      || row.chatKey !== row.inboxChatKey) throw new GitHubAccessError('github_access_denied');
    let envelope: unknown;
    try { envelope = typeof row.envelope === 'string' ? JSON.parse(row.envelope) : undefined; } catch { /* Fail closed below. */ }
    if (!envelope || typeof envelope !== 'object' || (envelope as { chatType?: unknown }).chatType !== 'p2p')
      throw new GitHubAccessError('github_access_denied');
    if (!this.config.token) throw new GitHubAccessError('github_access_credential_missing');
    return createHash('sha256').update(JSON.stringify({ version: 1, token: this.config.token,
      repositories: this.config.repositories, allowedUserIds: this.config.allowedUserIds, repository: selected,
      taskId: context.taskId, ownerId: context.ownerId, chatId: context.chatId })).digest('hex');
  }

  async observe(target: Readonly<GitHubTarget>, checks: readonly RequiredCheck[], deadlineMs: number,
    context?: GitHubAccessContext): Promise<ScopedGitHubObservation> {
    const selectedTarget = { owner: target.owner, repo: target.repo, pullNumber: target.pullNumber, headSha: target.headSha };
    const binding = context ? { ...context } : undefined;
    const selectedChecks = checks.map(check => ({ ...check }));
    const authorizationScope = this.authorize(selectedTarget, binding);
    let result: GitHubObservation;
    try {
      result = await new GitHubRestAdapter({ ...(authorizationScope ? { token: this.config!.token } : {}), fetch: this.fetcher })
        .observe(selectedTarget, selectedChecks, deadlineMs);
    } catch (error) {
      throw new GitHubReadError(error instanceof GitHubReadError && READ_ERRORS.has(error.code) ? error.code : 'github_read_unknown');
    }
    // A task/chat binding may have changed while the HTTP calls were in flight.
    if (this.authorize(selectedTarget, binding) !== authorizationScope) throw new GitHubAccessError('github_access_changed');
    return { ...result, ...(authorizationScope ? { authorizationScope } : {}) };
  }
}
