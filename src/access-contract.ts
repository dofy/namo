// Browser-safe access policy contracts.
export interface Audience { organization: boolean; userIds: string[]; chatIds: string[] }
export interface OrganizationAccess { mode: 'organization'; tenantKey: string }
export interface ProjectAccess extends Audience { permission: 'read-only' | 'workspace-write' }
