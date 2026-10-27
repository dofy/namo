import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import type { Incoming } from './store.js';

import type { Audience, OrganizationAccess } from './access-contract.js';
export type { Audience, OrganizationAccess, ProjectAccess } from './access-contract.js';
const ID = /^[^\s\u0000-\u001f\u007f-\u009f]{1,512}$/u;
export function identityList(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 200 || raw.some(x => typeof x !== 'string' || !ID.test(x) || x === '*')) throw new Error('access_invalid_identity');
  return [...new Set(raw)].sort();
}
export function parseAudience(raw: unknown): Audience {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('access_invalid_audience');
  const v = raw as Record<string, unknown>;
  if (Object.keys(v).some(k => !['organization','userIds','chatIds','permission','repository'].includes(k)) || typeof v.organization !== 'boolean') throw new Error('access_invalid_audience');
  return { organization: v.organization, userIds: identityList(v.userIds), chatIds: identityList(v.chatIds) };
}
export function parseOrganization(raw: unknown): OrganizationAccess | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('access_invalid_organization');
  const v = raw as Record<string, unknown>;
  if (Object.keys(v).some(k => !['mode','tenantKey'].includes(k)) || v.mode !== 'organization' || typeof v.tenantKey !== 'string' || !ID.test(v.tenantKey)) throw new Error('access_invalid_organization');
  return { mode: 'organization', tenantKey: v.tenantKey };
}
export function admitted(f: Pick<Config['feishu'], 'allowedUserIds'|'allowedChatIds'|'access'>, userId: string, chatId: string, tenantKey?: string): boolean {
  return !!userId && (!f.allowedChatIds.length || f.allowedChatIds.includes(chatId))
    && (f.access ? tenantKey === f.access.tenantKey : f.allowedUserIds.includes(userId));
}
export function audienceAllows(a: Audience, m: Incoming): boolean {
  // A member's private grant never implies permission to publish in a group.
  return m.envelope?.chatType === 'group' ? a.organization || a.chatIds.includes(m.chatId)
    : m.envelope?.chatType === 'p2p' && (a.organization || a.userIds.includes(m.senderId));
}
export function projectAllowed(c: Config['codex'], f: Config['feishu'], m: Incoming, name: string): boolean {
  return !f.access || !!c.projectAccess?.[name] && audienceAllows(c.projectAccess[name], m);
}
export function executionPolicy(c: Config['codex'], f: Config['feishu'], m: Incoming, project?: string, github?: Config['github']): Config['codex'] {
  if (!f.access) return c;
  if (!admitted(f, m.senderId, m.chatId, m.envelope?.tenantKey) || project && !projectAllowed(c,f,m,project)) throw new Error('organization_access_denied');
  return { ...c, sandbox: project ? c.projectAccess![project].permission : 'read-only', networkAccess: false,
    allowLocalCommits: false, readPaths: [],
    accessScope: createHash('sha256').update(JSON.stringify({feishu:{appId:f.appId,access:f.access,chats:f.allowedChatIds},projects:c.projectAccess,github})).digest('hex') };
}
