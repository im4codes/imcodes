import { describe, expect, it } from 'vitest';
import { MEMORY_ORIGINS, RESERVED_MEMORY_ORIGINS, assertMemoryOrigin, isMemoryOrigin, requireExplicitMemoryOrigin } from '../../shared/memory-origin.js';
import {
  MEMORY_SCOPES,
  AUTHORED_CONTEXT_SCOPES,
  OWNER_PRIVATE_MEMORY_SCOPES,
  REPLICABLE_SHARED_PROJECTION_SCOPES,
  SYNCED_PROJECTION_MEMORY_SCOPES,
  canPromoteMemoryScope,
  expandSearchRequestScope,
  getMemoryScopePolicy,
  isMemoryScope,
  isSearchRequestScope,
  validateMemoryScopeIdentity,
  type AuthoredContextScope,
  type OwnerPrivateMemoryScope,
  type ReplicableSharedProjectionScope,
} from '../../shared/memory-scope.js';
import {
  canonicalProjectIdForNamespace,
  createMemoryNamespace,
  createPersonalNamespace,
  createProjectSharedNamespace,
  createUserPrivateNamespace,
} from '../../shared/memory-namespace.js';
import {
  OBSERVATION_CLASSES,
  assertObservationContent,
  isObservationClass,
  validateObservationContent,
} from '../../shared/memory-observation.js';

function acceptsOwnerPrivateScope(scope: OwnerPrivateMemoryScope): OwnerPrivateMemoryScope {
  return scope;
}

function acceptsSharedProjectionScope(scope: ReplicableSharedProjectionScope): ReplicableSharedProjectionScope {
  return scope;
}

function acceptsAuthoredContextScope(scope: AuthoredContextScope): AuthoredContextScope {
  return scope;
}

describe('memory origin and scope shared contracts', () => {
  it('defines closed origins and reserves quick_search_cache without making it emit-safe', () => {
    expect(MEMORY_ORIGINS).toEqual(['chat_compacted', 'user_note', 'skill_import', 'manual_pin', 'agent_learned', 'md_ingest']);
    expect(RESERVED_MEMORY_ORIGINS).toEqual(['quick_search_cache']);
    expect(isMemoryOrigin('md_ingest')).toBe(true);
    expect(isMemoryOrigin('quick_search_cache')).toBe(false);
    expect(requireExplicitMemoryOrigin('user_note')).toBe('user_note');
    expect(() => requireExplicitMemoryOrigin(undefined)).toThrow(/Missing explicit memory origin/);
    expect(() => assertMemoryOrigin('quick_search_cache')).toThrow(/Reserved memory origin/);
  });

  it('defines the closed scope registry and narrow subtype unions', () => {
    expect(MEMORY_SCOPES).toEqual(['user_private', 'personal', 'project_shared', 'workspace_shared', 'org_shared']);
    expect(OWNER_PRIVATE_MEMORY_SCOPES).toEqual(['user_private', 'personal']);
    expect(REPLICABLE_SHARED_PROJECTION_SCOPES).toEqual(['project_shared', 'workspace_shared', 'org_shared']);
    expect(AUTHORED_CONTEXT_SCOPES).toEqual(['project_shared', 'workspace_shared', 'org_shared']);
    expect(SYNCED_PROJECTION_MEMORY_SCOPES).toEqual(['personal', 'project_shared', 'workspace_shared', 'org_shared']);
    expect(isMemoryScope('session_tree')).toBe(false);
    expect(isSearchRequestScope('owner_private')).toBe(true);
    expect(acceptsOwnerPrivateScope('user_private')).toBe('user_private');
    expect(acceptsOwnerPrivateScope('personal')).toBe('personal');
    expect(acceptsSharedProjectionScope('project_shared')).toBe('project_shared');
    expect(acceptsAuthoredContextScope('org_shared')).toBe('org_shared');
  });

  it('expands request scopes through shared policy helpers', () => {
    expect(expandSearchRequestScope('owner_private')).toEqual(['user_private', 'personal']);
    expect(expandSearchRequestScope('shared')).toEqual(['project_shared', 'workspace_shared', 'org_shared']);
    expect(expandSearchRequestScope('all_authorized')).toEqual(MEMORY_SCOPES);
    expect(expandSearchRequestScope('project_shared')).toEqual(['project_shared']);
  });

  it('validates required and forbidden identity fields per scope', () => {
    expect(validateMemoryScopeIdentity('user_private', { user_id: 'u1' })).toEqual({ ok: true });
    expect(validateMemoryScopeIdentity('user_private', { user_id: 'u1', project_id: 'github.com/acme/repo' })).toEqual({ ok: true });
    expect(validateMemoryScopeIdentity('personal', { user_id: 'u1' })).toMatchObject({ ok: false });
    expect(validateMemoryScopeIdentity('personal', { user_id: 'u1', project_id: 'github.com/acme/repo' })).toEqual({ ok: true });
    expect(validateMemoryScopeIdentity('project_shared', { project_id: 'github.com/acme/repo' })).toEqual({ ok: true });
    expect(validateMemoryScopeIdentity('workspace_shared', { workspace_id: 'w1' })).toEqual({ ok: true });
    expect(validateMemoryScopeIdentity('org_shared', { org_id: 'o1' })).toEqual({ ok: true });
  });

  it('records replication, raw-source, and promotion policies', () => {
    expect(getMemoryScopePolicy('user_private')).toMatchObject({ ownerPrivate: true, projectBound: false, rawSourceAccess: 'owner_only' });
    expect(getMemoryScopePolicy('project_shared')).toMatchObject({ ownerPrivate: false, rawSourceAccess: 'authorized_members' });
    expect(canPromoteMemoryScope('personal', 'project_shared')).toBe(true);
    expect(canPromoteMemoryScope('project_shared', 'personal')).toBe(false);
  });

  it('builds canonical namespace keys without introducing ad hoc tiers', () => {
    const userPrivate = createUserPrivateNamespace({ tenantId: 'local', userId: 'u1', name: 'prefs' });
    expect(userPrivate.key).toBe('scope:user_private/tenant:local/user:u1/name:prefs');
    expect(userPrivate.projectId).toBeUndefined();

    const personal = createPersonalNamespace({ userId: 'u1', canonicalRepoId: 'github.com/acme/repo', projectId: 'local-path', rootSessionId: 'root-1' });
    expect(personal.projectId).toBe('github.com/acme/repo');
    expect(personal.key).toContain('project:github.com%252Facme%252Frepo');
    expect(personal.key).toContain('root_session:root-1');

    const shared = createProjectSharedNamespace({ canonicalRepoId: 'github.com/acme/repo', workspaceId: 'w1', sessionTreeId: 'tree-1' });
    expect(shared.visibility).toBe('shared_authorized');
    expect(shared.key).toContain('session_tree:tree-1');

    expect(canonicalProjectIdForNamespace({ canonicalRepoId: 'canonical', projectId: 'fallback' })).toBe('canonical');
    expect(() => createMemoryNamespace({ scope: 'personal', userId: 'u1' })).toThrow(/project_id/);
  });

  it('defines observation classes and validates canonical JSON content', () => {
    expect(OBSERVATION_CLASSES).toContain('note');
    expect(isObservationClass('memory_note')).toBe(false);
    expect(assertObservationContent('note', { text: 'Manual note', tags: ['ops'] })).toMatchObject({ text: 'Manual note' });
    expect(validateObservationContent('note', { class: 'memory_note', text: 'bad alias' })).toMatchObject({ ok: false });
    expect(validateObservationContent('fact', { text: '' })).toMatchObject({ ok: false });
  });
});
