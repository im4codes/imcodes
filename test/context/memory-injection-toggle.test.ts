import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';

const { store, runMock } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const runMock = vi.fn(async (op: string, args: unknown[] = []) => {
    if (op === 'getContextMeta') return store.get(args[0] as string);
    if (op === 'setContextMeta') {
      store.set(args[0] as string, args[1] as string);
      return undefined;
    }
    throw new Error(`unexpected op: ${op}`);
  });
  return { store, runMock };
});

vi.mock('../../src/store/context-store-worker-client.js', () => ({
  getContextStoreClient: () => ({ run: runMock }),
}));

import {
  isMemoryInjectionEnabled,
  memoryInjectionMetaKey,
  setMemoryInjectionEnabled,
} from '../../src/context/memory-injection-toggle.js';

const NAMESPACE: ContextNamespace = { scope: 'personal', projectId: 'repo-1' };
const OTHER_NAMESPACE: ContextNamespace = { scope: 'personal', projectId: 'repo-2' };

describe('memory injection toggle', () => {
  beforeEach(() => {
    store.clear();
    runMock.mockClear();
  });

  afterEach(() => {
    store.clear();
  });

  it('defaults to enabled for a namespace that has never been set ("默认放开")', async () => {
    await expect(isMemoryInjectionEnabled(NAMESPACE)).resolves.toBe(true);
  });

  it('round-trips a disabled setting through the context_meta-backed store', async () => {
    await setMemoryInjectionEnabled(NAMESPACE, false);
    await expect(isMemoryInjectionEnabled(NAMESPACE)).resolves.toBe(false);
    expect(store.get(memoryInjectionMetaKey(NAMESPACE))).toBe('0');
  });

  it('re-enables after being disabled', async () => {
    await setMemoryInjectionEnabled(NAMESPACE, false);
    await setMemoryInjectionEnabled(NAMESPACE, true);
    await expect(isMemoryInjectionEnabled(NAMESPACE)).resolves.toBe(true);
    expect(store.get(memoryInjectionMetaKey(NAMESPACE))).toBe('1');
  });

  it('scopes the toggle per namespace — disabling one project leaves another untouched', async () => {
    await setMemoryInjectionEnabled(NAMESPACE, false);
    await expect(isMemoryInjectionEnabled(OTHER_NAMESPACE)).resolves.toBe(true);
    expect(memoryInjectionMetaKey(NAMESPACE)).not.toBe(memoryInjectionMetaKey(OTHER_NAMESPACE));
  });
});
