export const MEMORY_SCOPES = ['user_private', 'personal', 'project_shared', 'workspace_shared', 'org_shared'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export type OwnerPrivateMemoryScope = 'user_private' | 'personal';
export type ReplicableSharedProjectionScope = 'project_shared' | 'workspace_shared' | 'org_shared';
export type AuthoredContextScope = 'project_shared' | 'workspace_shared' | 'org_shared';

export const OWNER_PRIVATE_MEMORY_SCOPES = ['user_private', 'personal'] as const satisfies readonly OwnerPrivateMemoryScope[];
export const REPLICABLE_SHARED_PROJECTION_SCOPES = [
  'project_shared',
  'workspace_shared',
  'org_shared',
] as const satisfies readonly ReplicableSharedProjectionScope[];
export const AUTHORED_CONTEXT_SCOPES = [
  'project_shared',
  'workspace_shared',
  'org_shared',
] as const satisfies readonly AuthoredContextScope[];
export const SYNCED_PROJECTION_MEMORY_SCOPES = [
  'personal',
  ...REPLICABLE_SHARED_PROJECTION_SCOPES,
] as const satisfies readonly (OwnerPrivateMemoryScope | ReplicableSharedProjectionScope)[];
export type SharedContextProjectionScope = (typeof SYNCED_PROJECTION_MEMORY_SCOPES)[number];

export const SEARCH_REQUEST_SCOPE_ALIASES = ['owner_private', 'shared', 'all_authorized'] as const;
export type SearchRequestScopeAlias = (typeof SEARCH_REQUEST_SCOPE_ALIASES)[number];
export type SearchRequestScope = SearchRequestScopeAlias | MemoryScope;

export const MEMORY_SCOPE_IDENTITY_FIELDS = [
  'tenant_id',
  'user_id',
  'project_id',
  'workspace_id',
  'org_id',
  'root_session_id',
  'session_tree_id',
  'session_id',
] as const;
export type MemoryScopeIdentityField = (typeof MEMORY_SCOPE_IDENTITY_FIELDS)[number];

export type MemoryReplicationBehavior =
  | 'daemon_local'
  | 'owner_private_sync'
  | 'shared_projection'
  | 'authored_context';

export type RawSourceAccessPolicy = 'owner_only' | 'authorized_members' | 'admin_only' | 'none';

export interface MemoryScopePolicy {
  scope: MemoryScope;
  ownerPrivate: boolean;
  requiredIdentityFields: readonly MemoryScopeIdentityField[];
  optionalIdentityFields: readonly MemoryScopeIdentityField[];
  forbiddenIdentityFields: readonly MemoryScopeIdentityField[];
  replication: MemoryReplicationBehavior;
  requestExpansions: readonly SearchRequestScopeAlias[];
  rawSourceAccess: RawSourceAccessPolicy;
  promotionTargets: readonly MemoryScope[];
  defaultSearchIncluded: boolean;
  projectBound: boolean;
}

export type MemoryScopeIdentity = Partial<Record<MemoryScopeIdentityField, string | null | undefined>>;

const PRIVATE_PROMOTION_TARGETS = ['project_shared', 'workspace_shared', 'org_shared'] as const satisfies readonly MemoryScope[];

export const MEMORY_SCOPE_POLICIES = {
  user_private: {
    scope: 'user_private',
    ownerPrivate: true,
    requiredIdentityFields: ['user_id'],
    optionalIdentityFields: ['tenant_id', 'project_id', 'root_session_id', 'session_tree_id', 'session_id'],
    forbiddenIdentityFields: ['workspace_id', 'org_id'],
    replication: 'owner_private_sync',
    requestExpansions: ['owner_private', 'all_authorized'],
    rawSourceAccess: 'owner_only',
    promotionTargets: ['personal', ...PRIVATE_PROMOTION_TARGETS],
    defaultSearchIncluded: true,
    projectBound: false,
  },
  personal: {
    scope: 'personal',
    ownerPrivate: true,
    requiredIdentityFields: ['user_id', 'project_id'],
    optionalIdentityFields: ['tenant_id', 'root_session_id', 'session_tree_id', 'session_id'],
    forbiddenIdentityFields: ['workspace_id', 'org_id'],
    replication: 'daemon_local',
    requestExpansions: ['owner_private', 'all_authorized'],
    rawSourceAccess: 'owner_only',
    promotionTargets: PRIVATE_PROMOTION_TARGETS,
    defaultSearchIncluded: true,
    projectBound: true,
  },
  project_shared: {
    scope: 'project_shared',
    ownerPrivate: false,
    requiredIdentityFields: ['project_id'],
    optionalIdentityFields: ['tenant_id', 'workspace_id', 'org_id', 'root_session_id', 'session_tree_id', 'session_id'],
    forbiddenIdentityFields: [],
    replication: 'shared_projection',
    requestExpansions: ['shared', 'all_authorized'],
    rawSourceAccess: 'authorized_members',
    promotionTargets: ['workspace_shared', 'org_shared'],
    defaultSearchIncluded: true,
    projectBound: true,
  },
  workspace_shared: {
    scope: 'workspace_shared',
    ownerPrivate: false,
    requiredIdentityFields: ['workspace_id'],
    optionalIdentityFields: ['tenant_id', 'project_id', 'org_id', 'root_session_id', 'session_tree_id', 'session_id'],
    forbiddenIdentityFields: [],
    replication: 'shared_projection',
    requestExpansions: ['shared', 'all_authorized'],
    rawSourceAccess: 'authorized_members',
    promotionTargets: ['org_shared'],
    defaultSearchIncluded: true,
    projectBound: false,
  },
  org_shared: {
    scope: 'org_shared',
    ownerPrivate: false,
    requiredIdentityFields: ['org_id'],
    optionalIdentityFields: ['tenant_id', 'project_id', 'workspace_id', 'root_session_id', 'session_tree_id', 'session_id'],
    forbiddenIdentityFields: [],
    replication: 'authored_context',
    requestExpansions: ['shared', 'all_authorized'],
    rawSourceAccess: 'authorized_members',
    promotionTargets: [],
    defaultSearchIncluded: true,
    projectBound: false,
  },
} as const satisfies Record<MemoryScope, MemoryScopePolicy>;

const MEMORY_SCOPE_SET: ReadonlySet<string> = new Set(MEMORY_SCOPES);
const OWNER_PRIVATE_MEMORY_SCOPE_SET: ReadonlySet<string> = new Set(OWNER_PRIVATE_MEMORY_SCOPES);
const REPLICABLE_SHARED_PROJECTION_SCOPE_SET: ReadonlySet<string> = new Set(REPLICABLE_SHARED_PROJECTION_SCOPES);
const SHARED_CONTEXT_PROJECTION_SCOPE_SET: ReadonlySet<string> = new Set(SYNCED_PROJECTION_MEMORY_SCOPES);
const AUTHORED_CONTEXT_SCOPE_SET: ReadonlySet<string> = new Set(AUTHORED_CONTEXT_SCOPES);
const SEARCH_REQUEST_SCOPE_SET: ReadonlySet<string> = new Set([...MEMORY_SCOPES, ...SEARCH_REQUEST_SCOPE_ALIASES]);

function hasIdentityField(identity: MemoryScopeIdentity, field: MemoryScopeIdentityField): boolean {
  const value = identity[field];
  return typeof value === 'string' && value.trim().length > 0;
}

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === 'string' && MEMORY_SCOPE_SET.has(value);
}

export function isSearchRequestScope(value: unknown): value is SearchRequestScope {
  return typeof value === 'string' && SEARCH_REQUEST_SCOPE_SET.has(value);
}

export function getMemoryScopePolicy(scope: MemoryScope): MemoryScopePolicy {
  return MEMORY_SCOPE_POLICIES[scope];
}

export function isOwnerPrivateMemoryScope(scope: MemoryScope): scope is OwnerPrivateMemoryScope {
  return OWNER_PRIVATE_MEMORY_SCOPE_SET.has(scope);
}

export function isSharedProjectionScope(scope: MemoryScope): scope is ReplicableSharedProjectionScope {
  return REPLICABLE_SHARED_PROJECTION_SCOPE_SET.has(scope);
}

export function isReplicableSharedProjectionScope(value: unknown): value is ReplicableSharedProjectionScope {
  return typeof value === 'string' && REPLICABLE_SHARED_PROJECTION_SCOPE_SET.has(value);
}

export function isSharedContextProjectionScope(value: unknown): value is SharedContextProjectionScope {
  return typeof value === 'string' && SHARED_CONTEXT_PROJECTION_SCOPE_SET.has(value);
}

export function isAuthoredContextScope(value: unknown): value is AuthoredContextScope {
  return typeof value === 'string' && AUTHORED_CONTEXT_SCOPE_SET.has(value);
}

export function expandSearchRequestScope(requestScope: SearchRequestScope): readonly MemoryScope[] {
  if (isMemoryScope(requestScope)) return [requestScope];
  switch (requestScope) {
    case 'owner_private':
      return OWNER_PRIVATE_MEMORY_SCOPES;
    case 'shared':
      return REPLICABLE_SHARED_PROJECTION_SCOPES;
    case 'all_authorized':
      return MEMORY_SCOPES;
  }
}

export function validateMemoryScopeIdentity(scope: MemoryScope, identity: MemoryScopeIdentity): { ok: true } | { ok: false; reason: string } {
  const policy = getMemoryScopePolicy(scope);
  const missing = policy.requiredIdentityFields.filter((field) => !hasIdentityField(identity, field));
  if (missing.length > 0) {
    return { ok: false, reason: `Missing required identity field(s) for ${scope}: ${missing.join(', ')}` };
  }
  const forbidden = policy.forbiddenIdentityFields.filter((field) => hasIdentityField(identity, field));
  if (forbidden.length > 0) {
    return { ok: false, reason: `Forbidden identity field(s) for ${scope}: ${forbidden.join(', ')}` };
  }
  return { ok: true };
}

export function assertMemoryScopeIdentity(scope: MemoryScope, identity: MemoryScopeIdentity): void {
  const result = validateMemoryScopeIdentity(scope, identity);
  if (!result.ok) throw new Error(result.reason);
}

export function canPromoteMemoryScope(fromScope: MemoryScope, toScope: MemoryScope): boolean {
  return getMemoryScopePolicy(fromScope).promotionTargets.includes(toScope);
}
