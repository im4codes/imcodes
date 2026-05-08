export const MEMORY_MANAGEMENT_CONTEXT_FIELD = '_memoryManagementContext' as const;

export const MEMORY_MANAGEMENT_ROLES = ['user', 'workspace_admin', 'org_admin'] as const;
export type MemoryManagementRole = (typeof MEMORY_MANAGEMENT_ROLES)[number];

export interface MemoryManagementBoundProject {
  projectDir?: string;
  canonicalRepoId?: string;
  workspaceId?: string;
  orgId?: string;
}

export interface AuthenticatedMemoryManagementContext {
  actorId: string;
  userId: string;
  role: MemoryManagementRole;
  serverId?: string;
  requestId?: string;
  boundProjects?: readonly MemoryManagementBoundProject[];
  source: 'server_bridge' | 'local_daemon';
}

export function isMemoryManagementRole(value: unknown): value is MemoryManagementRole {
  return typeof value === 'string' && (MEMORY_MANAGEMENT_ROLES as readonly string[]).includes(value);
}

export function isAuthenticatedMemoryManagementContext(value: unknown): value is AuthenticatedMemoryManagementContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.actorId === 'string'
    && record.actorId.trim().length > 0
    && typeof record.userId === 'string'
    && record.userId.trim().length > 0
    && isMemoryManagementRole(record.role)
    && (record.source === 'server_bridge' || record.source === 'local_daemon');
}
