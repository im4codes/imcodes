import { describe, expect, it } from 'vitest';
import {
  canPromoteMemoryScope,
  expandSearchRequestScope,
  isMemoryScope,
  isSearchRequestScope,
  validateMemoryScopeIdentity,
} from '../../shared/memory-scope.js';

describe('scope migration compatibility', () => {
  it('preserves legacy personal as project-bound owner-private memory', () => {
    expect(isMemoryScope('personal')).toBe(true);
    expect(validateMemoryScopeIdentity('personal', { user_id: 'user-1', project_id: 'github.com/acme/repo' })).toEqual({ ok: true });
    expect(validateMemoryScopeIdentity('personal', { user_id: 'user-1' })).toMatchObject({ ok: false });
    expect(expandSearchRequestScope('owner_private')).toContain('personal');
  });

  it('rejects old/ad hoc scope strings instead of silently widening visibility', () => {
    for (const scope of ['global', 'session_tree', 'memory_note', 'namespace_tier_global']) {
      expect(isMemoryScope(scope)).toBe(false);
      expect(isSearchRequestScope(scope)).toBe(false);
    }
  });

  it('requires explicit authorized promotion rather than automatic private-to-shared widening', () => {
    expect(canPromoteMemoryScope('personal', 'project_shared')).toBe(true);
    expect(canPromoteMemoryScope('user_private', 'project_shared')).toBe(true);
    expect(canPromoteMemoryScope('project_shared', 'personal')).toBe(false);
  });
});
