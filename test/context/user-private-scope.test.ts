import { describe, expect, it } from 'vitest';
import {
  contextBindingVisibleToRuntime,
  createContextNamespaceBinding,
} from '../../shared/memory-namespace.js';
import {
  expandSearchRequestScope,
  getMemoryScopePolicy,
  validateMemoryScopeIdentity,
} from '../../shared/memory-scope.js';

describe('user_private scope policy', () => {
  it('is owner-only and cross-project rather than project-bound personal memory', () => {
    const policy = getMemoryScopePolicy('user_private');
    expect(policy.projectBound).toBe(false);
    expect(policy.rawSourceAccess).toBe('owner_only');
    expect(policy.replication).toBe('owner_private_sync');
    expect(validateMemoryScopeIdentity('user_private', { user_id: 'user-1' })).toEqual({ ok: true });
    expect(validateMemoryScopeIdentity('user_private', { user_id: 'user-1', project_id: 'github.com/acme/repo' })).toEqual({ ok: true });
    expect(validateMemoryScopeIdentity('user_private', { user_id: 'user-1', workspace_id: 'ws-1' })).toMatchObject({ ok: false });
  });

  it('is visible only to the owning user across projects', () => {
    const prefs = createContextNamespaceBinding({
      scope: 'user_private',
      userId: 'user-1',
      name: 'prefs',
    });

    expect(contextBindingVisibleToRuntime(prefs, { userId: 'user-1', canonicalRepoId: 'github.com/acme/one' })).toBe(true);
    expect(contextBindingVisibleToRuntime(prefs, { userId: 'user-1', canonicalRepoId: 'github.com/acme/two' })).toBe(true);
    expect(contextBindingVisibleToRuntime(prefs, { userId: 'user-2', canonicalRepoId: 'github.com/acme/one' })).toBe(false);
  });

  it('keeps owner-private search alias limited to user_private and legacy personal', () => {
    expect(expandSearchRequestScope('owner_private')).toEqual(['user_private', 'personal']);
  });
});
