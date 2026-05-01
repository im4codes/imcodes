import {
  assertMemoryScopeIdentity,
  getMemoryScopePolicy,
  type MemoryScope,
  type MemoryScopeIdentity,
} from './memory-scope.js';
import type { ContextNamespace as LegacyContextNamespace } from './context-types.js';

export type MemoryNamespaceVisibility = 'owner_private' | 'shared_authorized';

export interface MemoryNamespaceInput {
  scope: MemoryScope;
  tenantId?: string;
  userId?: string;
  canonicalRepoId?: string;
  projectId?: string;
  workspaceId?: string;
  orgId?: string;
  rootSessionId?: string;
  sessionTreeId?: string;
  sessionId?: string;
  name?: string;
}

export interface ContextNamespace {
  scope: MemoryScope;
  key: string;
  visibility: MemoryNamespaceVisibility;
  tenantId?: string;
  userId?: string;
  projectId?: string;
  canonicalRepoId?: string;
  workspaceId?: string;
  orgId?: string;
  rootSessionId?: string;
  sessionTreeId?: string;
  sessionId?: string;
  name?: string;
}

export interface CanonicalNamespaceInput {
  scope: MemoryScope;
  localTenant?: string;
  tenantId?: string;
  userId?: string;
  canonicalRepoId?: string;
  projectId?: string;
  workspaceId?: string;
  orgId?: string;
  enterpriseId?: string;
  rootSessionId?: string;
  sessionTreeId?: string;
  sessionId?: string;
  key?: string;
  visibility?: 'private' | 'shared' | MemoryNamespaceVisibility;
  name?: string;
}

export interface ContextNamespaceBinding {
  localTenant: string;
  scope: MemoryScope;
  userId?: string;
  rootSessionId?: string;
  sessionTreeId?: string;
  sessionId?: string;
  workspaceId?: string;
  projectId?: string;
  orgId?: string;
  key: string;
  visibility: 'private' | 'shared';
}

function encodeNamespaceSegment(value: string): string {
  return encodeURIComponent(value.normalize('NFC').trim()).replace(/%2F/gi, '%252F');
}

function pushPart(parts: string[], label: string, value: string | undefined): void {
  if (typeof value === 'string' && value.trim().length > 0) {
    parts.push(`${label}:${encodeNamespaceSegment(value)}`);
  }
}

function scopeIdentityFor(input: MemoryNamespaceInput, projectId: string | undefined): MemoryScopeIdentity {
  return {
    tenant_id: input.tenantId,
    user_id: input.userId,
    project_id: projectId,
    workspace_id: input.workspaceId,
    org_id: input.orgId,
    root_session_id: input.rootSessionId,
    session_tree_id: input.sessionTreeId,
    session_id: input.sessionId,
  };
}

export function canonicalProjectIdForNamespace(input: Pick<MemoryNamespaceInput, 'canonicalRepoId' | 'projectId'>): string | undefined {
  return input.canonicalRepoId ?? input.projectId;
}

export function createMemoryNamespace(input: MemoryNamespaceInput): ContextNamespace {
  const projectId = canonicalProjectIdForNamespace(input);
  assertMemoryScopeIdentity(input.scope, scopeIdentityFor(input, projectId));

  const parts = [`scope:${input.scope}`];
  pushPart(parts, 'tenant', input.tenantId);
  pushPart(parts, 'user', input.userId);
  pushPart(parts, 'project', projectId);
  pushPart(parts, 'workspace', input.workspaceId);
  pushPart(parts, 'org', input.orgId);
  pushPart(parts, 'root_session', input.rootSessionId);
  pushPart(parts, 'session_tree', input.sessionTreeId);
  pushPart(parts, 'session', input.sessionId);
  pushPart(parts, 'name', input.name ?? 'default');

  const policy = getMemoryScopePolicy(input.scope);
  return {
    scope: input.scope,
    key: parts.join('/'),
    visibility: policy.ownerPrivate ? 'owner_private' : 'shared_authorized',
    tenantId: input.tenantId,
    userId: input.userId,
    projectId,
    canonicalRepoId: input.canonicalRepoId,
    workspaceId: input.workspaceId,
    orgId: input.orgId,
    rootSessionId: input.rootSessionId,
    sessionTreeId: input.sessionTreeId,
    sessionId: input.sessionId,
    name: input.name,
  };
}

export function createUserPrivateNamespace(input: Omit<MemoryNamespaceInput, 'scope' | 'projectId'> & { projectId?: string }): ContextNamespace {
  return createMemoryNamespace({ ...input, scope: 'user_private' });
}

export function createPersonalNamespace(input: Omit<MemoryNamespaceInput, 'scope'>): ContextNamespace {
  return createMemoryNamespace({ ...input, scope: 'personal' });
}

export function createProjectSharedNamespace(input: Omit<MemoryNamespaceInput, 'scope'>): ContextNamespace {
  return createMemoryNamespace({ ...input, scope: 'project_shared' });
}

export function createWorkspaceSharedNamespace(input: Omit<MemoryNamespaceInput, 'scope'>): ContextNamespace {
  return createMemoryNamespace({ ...input, scope: 'workspace_shared' });
}

export function createOrgSharedNamespace(input: Omit<MemoryNamespaceInput, 'scope'>): ContextNamespace {
  return createMemoryNamespace({ ...input, scope: 'org_shared' });
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stripGitSuffix(value: string): string {
  return value.endsWith('.git') ? value.slice(0, -4) : value;
}

export function normalizeCanonicalRepoId(raw: string | undefined): string | undefined {
  const value = clean(raw);
  if (!value) return undefined;
  const lower = value.toLowerCase();
  const sshMatch = lower.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) return stripGitSuffix(`${sshMatch[1]}/${sshMatch[2]}`).replace(/\/+/g, '/');
  try {
    const url = new URL(lower);
    if (url.hostname && url.pathname) {
      return stripGitSuffix(`${url.hostname}/${url.pathname.replace(/^\/+|\/+$/g, '')}`).replace(/\/+/g, '/');
    }
  } catch {
    // Plain canonical keys such as github.com/owner/repo are accepted below.
  }
  return stripGitSuffix(lower).replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

function bindingVisibility(input: CanonicalNamespaceInput, ownerPrivate: boolean): 'private' | 'shared' {
  if (input.visibility === 'private' || input.visibility === 'shared') return input.visibility;
  return ownerPrivate ? 'private' : 'shared';
}

export function buildNamespaceKey(input: CanonicalNamespaceInput): string {
  const projectId = normalizeCanonicalRepoId(input.canonicalRepoId ?? input.projectId);
  const parts = [
    'ctxns:v1',
    input.scope,
    clean(input.userId) ?? '',
    clean(input.orgId ?? input.enterpriseId) ?? '',
    clean(input.workspaceId) ?? '',
    projectId ?? '',
    clean(input.rootSessionId ?? input.sessionTreeId) ?? '',
    clean(input.sessionId) ?? '',
    clean(input.name ?? 'default') ?? 'default',
  ];
  return parts.map((part) => encodeURIComponent(part)).join(':');
}

export function createContextNamespaceBinding(input: CanonicalNamespaceInput): ContextNamespaceBinding {
  const projectId = normalizeCanonicalRepoId(input.canonicalRepoId ?? input.projectId);
  const orgId = clean(input.orgId ?? input.enterpriseId);
  assertMemoryScopeIdentity(input.scope, {
    tenant_id: input.tenantId ?? input.localTenant,
    user_id: input.userId,
    project_id: projectId,
    workspace_id: input.workspaceId,
    org_id: orgId,
    root_session_id: input.rootSessionId,
    session_tree_id: input.sessionTreeId,
    session_id: input.sessionId,
  });
  const policy = getMemoryScopePolicy(input.scope);
  return {
    localTenant: clean(input.localTenant ?? input.tenantId) ?? 'daemon-local',
    scope: input.scope,
    userId: clean(input.userId),
    rootSessionId: clean(input.rootSessionId),
    sessionTreeId: clean(input.sessionTreeId ?? input.rootSessionId),
    sessionId: clean(input.sessionId),
    workspaceId: clean(input.workspaceId),
    projectId,
    orgId,
    key: input.key?.trim() || buildNamespaceKey({ ...input, projectId }),
    visibility: bindingVisibility(input, policy.ownerPrivate),
  };
}

export function contextNamespaceToBinding(namespace: LegacyContextNamespace, options: {
  localTenant?: string;
  rootSessionId?: string;
  sessionTreeId?: string;
  sessionId?: string;
  key?: string;
} = {}): ContextNamespaceBinding {
  return createContextNamespaceBinding({
    localTenant: options.localTenant,
    scope: namespace.scope as MemoryScope,
    userId: namespace.userId,
    workspaceId: namespace.workspaceId,
    projectId: namespace.projectId,
    orgId: namespace.enterpriseId,
    enterpriseId: namespace.enterpriseId,
    rootSessionId: options.rootSessionId,
    sessionTreeId: options.sessionTreeId,
    sessionId: options.sessionId,
    key: options.key,
  });
}

export function bindingToContextNamespace(binding: ContextNamespaceBinding): LegacyContextNamespace {
  return {
    scope: binding.scope as LegacyContextNamespace['scope'],
    projectId: binding.projectId ?? '',
    userId: binding.userId,
    workspaceId: binding.workspaceId,
    enterpriseId: binding.orgId,
  };
}

export function bindSessionTreeContext<T extends CanonicalNamespaceInput>(input: T, rootSessionId: string, sessionId?: string): ContextNamespaceBinding {
  return createContextNamespaceBinding({
    ...input,
    rootSessionId,
    sessionTreeId: rootSessionId,
    sessionId,
  });
}

export function sameRootSessionTree(a: Pick<ContextNamespaceBinding, 'rootSessionId' | 'sessionTreeId'>, b: Pick<ContextNamespaceBinding, 'rootSessionId' | 'sessionTreeId'>): boolean {
  const aRoot = a.rootSessionId ?? a.sessionTreeId;
  const bRoot = b.rootSessionId ?? b.sessionTreeId;
  return Boolean(aRoot && bRoot && aRoot === bRoot);
}

export function sameCanonicalProject(a: Pick<ContextNamespaceBinding, 'projectId'>, b: Pick<ContextNamespaceBinding, 'projectId'>): boolean {
  return Boolean(a.projectId && b.projectId && normalizeCanonicalRepoId(a.projectId) === normalizeCanonicalRepoId(b.projectId));
}

export interface RuntimeContextBinding {
  userId?: string;
  projectId?: string;
  canonicalRepoId?: string;
  rootSessionId?: string;
  sessionTreeId?: string;
  sessionId?: string;
}

export function isSessionTreeBoundContext(binding: Pick<ContextNamespaceBinding, 'rootSessionId' | 'sessionTreeId' | 'sessionId'>): boolean {
  return Boolean(binding.rootSessionId || binding.sessionTreeId || binding.sessionId);
}

/**
 * Decide whether a namespace binding is visible to a runtime session without
 * introducing a new session-tree authorization scope.
 *
 * Session tree ids only bind context inside one tree. Cross-device project
 * visibility comes from canonical project identity (`canonicalRepoId` /
 * `projectId`), not from local paths, machine ids, or session ids.
 */
export function contextBindingVisibleToRuntime(
  binding: ContextNamespaceBinding,
  runtime: RuntimeContextBinding,
): boolean {
  const runtimeProjectId = normalizeCanonicalRepoId(runtime.canonicalRepoId ?? runtime.projectId);
  const runtimeBinding: Pick<ContextNamespaceBinding, 'projectId' | 'rootSessionId' | 'sessionTreeId'> = {
    projectId: runtimeProjectId,
    rootSessionId: clean(runtime.rootSessionId),
    sessionTreeId: clean(runtime.sessionTreeId ?? runtime.rootSessionId),
  };

  if (isSessionTreeBoundContext(binding)) {
    return sameRootSessionTree(binding, runtimeBinding);
  }

  if (binding.scope === 'user_private') {
    return Boolean(binding.userId && runtime.userId && binding.userId === runtime.userId);
  }
  if (binding.scope === 'personal') {
    return Boolean(
      binding.userId
      && runtime.userId
      && binding.userId === runtime.userId
      && sameCanonicalProject(binding, runtimeBinding),
    );
  }
  if (binding.scope === 'project_shared') {
    return sameCanonicalProject(binding, runtimeBinding);
  }
  // Workspace/org membership authorization is enforced by the caller/server
  // layer; this helper only prevents project/session identity drift.
  return true;
}
