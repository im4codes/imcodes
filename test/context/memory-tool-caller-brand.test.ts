import { describe, expect, it } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';
import {
  _createInternalMemoryToolCaller,
  chatSearchFts,
  createMemoryToolCaller,
  type MemoryToolCaller,
} from '../../src/context/memory-read-tools.js';

describe('memory tool caller branding', () => {
  const namespace: ContextNamespace = { scope: 'personal', projectId: 'repo', userId: 'user-1' };

  function compileGuard(): void {
    // @ts-expect-error MemoryToolCaller must be factory-created because the brand is not forgeable.
    const direct: MemoryToolCaller = { userId: 'user-1', namespace };
    void direct;
  }

  it('constructs frozen public and internal callers through factories', () => {
    compileGuard();
    const caller = createMemoryToolCaller({ userId: 'user-1', namespace });
    expect(caller.userId).toBe('user-1');
    expect(caller.namespace).toBe(namespace);
    expect(Object.isFrozen(caller)).toBe(true);

    const internal = _createInternalMemoryToolCaller({ userId: 'user-1' });
    expect(internal.allowGlobalOwnerSearch).toBe(true);
    expect(Object.isFrozen(internal)).toBe(true);
  });

  it('rejects invalid factory input and unbranded callers at runtime', () => {
    expect(() => createMemoryToolCaller({ userId: '', namespace })).toThrow('invalid caller');
    const unbranded = { userId: 'user-1', namespace } as MemoryToolCaller;
    expect(() => chatSearchFts('needle', 1, unbranded)).toThrow(/factory-created caller/);
  });
});
