import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import { localGhToken, parseLocalGh, type LocalGhConfig } from './github-local.js';
import { admitted, audienceAllows, parseAudience, type Audience } from './access.js';
import type { Config } from './config.js';
import type { Incoming } from './store.js';
import { GitHubReadError, GitHubRestAdapter, type GitHubObservation, type GitHubObservationAdapter,
  type GitHubTarget, type RequiredCheck } from './external-waits.js';

/** Explicit protected configuration; resolved credentials must never enter a prompt or public view. */
export interface GitHubAccessConfig {
  source?: 'token' | 'gh' | 'anonymous';
  localGh?: LocalGhConfig;
  token?: string;
  tokenEnv?: string;
  repositories: string[];
  allowedUserIds: string[];
  grants?: Array<Audience & {repository: string}>;
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
  if (Object.keys(value).some(key => !['source','localGh','token', 'tokenEnv', 'repositories', 'allowedUserIds','grants'].includes(key)))
    throw new GitHubAccessError('github_access_invalid_config');
  if (value.token !== undefined && value.tokenEnv !== undefined) throw new GitHubAccessError('github_access_ambiguous_credential');
  const repositories = list(value.repositories, 'repository'), allowedUserIds = list(value.allowedUserIds, 'user');
  let grants: GitHubAccessConfig['grants'];
  if (value.grants !== undefined) {
    if (!Array.isArray(value.grants) || value.grants.length>200 || repositories.length || allowedUserIds.length) throw new GitHubAccessError('github_access_invalid_scope');
    grants = value.grants.map(v=>({...parseAudience(v),repository:repository(v.repository)}));
    if (new Set(grants.map(g=>g.repository)).size!==grants.length) throw new GitHubAccessError('github_access_invalid_scope');
  }
  const shared = grants === undefined ? {} : {grants};
  if (value.source !== undefined && (typeof value.source!=='string' || !['token','gh','anonymous'].includes(value.source))) throw new GitHubAccessError('github_access_invalid_config');
  if (value.source === 'gh') {
    if (value.token !== undefined || value.tokenEnv !== undefined || repositories.length || grants===undefined && allowedUserIds.length !== 1)
      throw new GitHubAccessError('github_access_invalid_config');
    try { return { source:'gh', localGh:parseLocalGh(value.localGh), repositories, allowedUserIds, ...shared }; }
    catch { throw new GitHubAccessError('github_access_invalid_config'); }
  }
  if (value.localGh !== undefined) throw new GitHubAccessError('github_access_invalid_config');
  if (value.source === 'anonymous') {
    if (value.token !== undefined || value.tokenEnv !== undefined || repositories.length || allowedUserIds.length) throw new GitHubAccessError('github_access_invalid_config');
    return { source:'anonymous', repositories, allowedUserIds, ...shared };
  }
  if (value.tokenEnv !== undefined) {
    if (typeof value.tokenEnv !== 'string' || !TOKEN_ENV.test(value.tokenEnv)) throw new GitHubAccessError('github_access_invalid_environment');
    const resolved = Object.hasOwn(env, value.tokenEnv) ? env[value.tokenEnv] : undefined;
    return { repositories, allowedUserIds, tokenEnv: value.tokenEnv, token: token(resolved), ...shared };
  }
  return { repositories, allowedUserIds, token: token(value.token), ...shared };
}

export function publicGitHubAccess(config?: GitHubAccessConfig) {
  return { credentialConfigured: config?.source==='gh' || !!config?.token, credentialSource: config?.source==='gh' ? 'gh' : config?.tokenEnv ? 'environment' : config?.token ? 'token' : 'none',
    ...(config?.localGh ? { localGh:{login:config.localGh.login} } : {}),
    ...(config?.tokenEnv ? { tokenEnv: config.tokenEnv } : {}),
    repositories: [...(config?.repositories ?? [])], allowedUserIds: [...(config?.allowedUserIds ?? [])],
    ...(config?.grants ? {grants:structuredClone(config.grants)} : {}) };
}

/** Shared access binds a durable task to an explicit repository audience; legacy grants remain DM-only. */
export class ScopedGitHubAdapter implements GitHubObservationAdapter {
  private readonly config: GitHubAccessConfig | undefined;
  constructor(private readonly store: Store, config?: GitHubAccessConfig, private readonly fetcher?: typeof globalThis.fetch,
    private readonly ghToken: typeof localGhToken = localGhToken, private readonly feishu?: Config['feishu']) {
    // Clone the resolved configuration: callers cannot alter scope halfway through an observation.
    const parsed = config ? parseGitHubAccessConfig({...config,tokenEnv:undefined}) : undefined;
    this.config = parsed && config?.tokenEnv ? {...parsed,tokenEnv:config.tokenEnv} : parsed;
  }

  authorize(target: Readonly<GitHubTarget>, context?: GitHubAccessContext): string | undefined {
    const selected = repository(`${target.owner}/${target.repo}`);
    if (!this.config?.grants && this.config?.source!=='gh' && !this.config?.repositories.includes(selected)) return undefined;
    if (!context || !this.config || !this.config.grants && !this.config.allowedUserIds.includes(context.ownerId)) throw new GitHubAccessError('github_access_denied');
    const row = this.store.db.prepare(`SELECT t.ownerId,t.chatKey,i.senderId,i.chatId,i.chatKey AS inboxChatKey,i.envelope
      FROM tasks t JOIN inbox i ON i.key=t.inboxKey WHERE t.id=?`).get(context.taskId);
    if (!row || row.ownerId !== context.ownerId || row.senderId !== context.ownerId || row.chatId !== context.chatId
      || row.chatKey !== row.inboxChatKey) throw new GitHubAccessError('github_access_denied');
    let envelope: unknown;
    try { envelope = typeof row.envelope === 'string' ? JSON.parse(row.envelope) : undefined; } catch { /* Fail closed below. */ }
    if (!envelope || typeof envelope !== 'object') throw new GitHubAccessError('github_access_denied');
    if (this.config.grants) {
      const m = {senderId:context.ownerId,chatId:context.chatId,envelope} as Incoming;
      const grant = this.config.grants.find(g=>g.repository===selected);
      if (!this.feishu || row.chatKey!==`${this.feishu.appId}:${context.chatId}` || !admitted(this.feishu,m.senderId,m.chatId,m.envelope?.tenantKey)
        || !grant || !audienceAllows(grant,m)) throw new GitHubAccessError('github_access_denied');
    } else if ((envelope as {chatType?:unknown}).chatType!=='p2p') throw new GitHubAccessError('github_access_denied');
    if (this.config.source!=='gh' && this.config.source!=='anonymous' && !this.config.token) throw new GitHubAccessError('github_access_credential_missing');
    return createHash('sha256').update(JSON.stringify({ version: 1, token: this.config.token,
      ...(this.config.localGh ? {localGh:this.config.localGh} : {}),
      repositories: this.config.repositories, allowedUserIds: this.config.allowedUserIds, repository: selected,
      grants:this.config.grants, access:this.feishu?.access, chats:this.feishu?.allowedChatIds,
      taskId: context.taskId, ownerId: context.ownerId, chatId: context.chatId })).digest('hex');
  }

  async readPullRequest(target: Pick<GitHubTarget,'owner'|'repo'|'pullNumber'>, context: GitHubAccessContext, deadlineMs: number) {
    const selected = {...target,headSha:'0'.repeat(40)};
    const scope = this.authorize(selected,context);
    const local = this.config?.localGh;
    const credential = local ? await this.ghToken(local,deadlineMs) : scope ? this.config?.token : undefined;
    const adapter = new GitHubRestAdapter({...(credential?{token:credential}:{}),fetch:this.fetcher});
    if (local) {
      const account = await adapter.account(deadlineMs);
      if (account.id!==local.userId || account.login.toLowerCase()!==local.login.toLowerCase()) throw new GitHubAccessError('github_access_changed');
    }
    const result = await adapter.review(selected,deadlineMs);
    if (this.authorize(selected,context)!==scope) throw new GitHubAccessError('github_access_changed');
    return {snapshot:result,scope};
  }

  async observe(target: Readonly<GitHubTarget>, checks: readonly RequiredCheck[], deadlineMs: number,
    context?: GitHubAccessContext): Promise<ScopedGitHubObservation> {
    const selectedTarget = { owner: target.owner, repo: target.repo, pullNumber: target.pullNumber, headSha: target.headSha };
    const binding = context ? { ...context } : undefined;
    const selectedChecks = checks.map(check => ({ ...check }));
    const authorizationScope = this.authorize(selectedTarget, binding);
    let result: GitHubObservation;
    try {
      const local = this.config?.localGh;
      const credential = local ? await this.ghToken(local,deadlineMs) : authorizationScope ? this.config!.token : undefined;
      const adapter = new GitHubRestAdapter({ ...(credential ? {token:credential} : {}), fetch:this.fetcher });
      if (local) {
        const account = await adapter.account(deadlineMs);
        if (account.id!==local.userId || account.login.toLowerCase()!==local.login.toLowerCase()) throw new GitHubAccessError('github_access_changed');
      }
      result = await adapter.observe(selectedTarget, selectedChecks, deadlineMs);
    } catch (error) {
      throw new GitHubReadError(error instanceof GitHubReadError && READ_ERRORS.has(error.code) ? error.code : 'github_read_unknown');
    }
    // A task/chat binding may have changed while the HTTP calls were in flight.
    if (this.authorize(selectedTarget, binding) !== authorizationScope) throw new GitHubAccessError('github_access_changed');
    return { ...result, ...(authorizationScope ? { authorizationScope } : {}) };
  }

  async validateResume(observation: GitHubObservation, checks: readonly RequiredCheck[], context: GitHubAccessContext, deadlineMs: number): Promise<void> {
    if (this.config?.source!=='gh') return;
    // Logout or repository access revocation can happen without a config edit.
    const fresh = await this.observe(observation.target,checks,deadlineMs,context);
    const snapshot = (o: GitHubObservation) => JSON.stringify({target:o.target,pullState:o.pullState,checks:o.checks,authorizationScope:o.authorizationScope});
    if (snapshot(fresh)!==snapshot(observation)) throw new GitHubAccessError('github_access_changed');
  }
}
