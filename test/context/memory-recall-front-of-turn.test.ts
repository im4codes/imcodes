import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';

/**
 * Front-of-turn recall façade owner-mode gating (OpenSpec
 * context-store-worker-isolation, REWORK pass).
 *
 * `searchLocalMemorySemanticFrontOfTurn` / `selectStartupMemoryForBootstrap`:
 *   - worker when warm;
 *   - worker NOT warm + `isProductionOwner === true` -> bounded EMPTY
 *     (`emptyMemorySearchResult()` / `[]`), and the in-process reader is NEVER
 *     touched (no main-thread `ensureDb()` in the warming / self-heal window);
 *   - worker NOT warm + `isProductionOwner === false` (tests / CLI) -> the
 *     in-process `searchLocalMemorySemantic` / `selectStartupMemoryItems`.
 *
 * We mock the worker client so `isReady` is always false (the via-worker hop
 * returns null) and make `isProductionOwner` configurable per test, then spy on
 * the in-process modules to assert exactly which branch ran.
 */

const { fakeClient } = vi.hoisted(() => ({
  fakeClient: {
    isReady: false,
    isProductionOwner: false,
  } as { isReady: boolean; isProductionOwner: boolean },
}));

vi.mock('../../src/store/context-store-worker-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/store/context-store-worker-client.js')>();
  return {
    ...actual,
    getContextStoreClient: () => fakeClient,
  };
});

const searchLocalMemorySemanticMock = vi.fn();
vi.mock('../../src/context/memory-search.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/context/memory-search.js')>();
  return {
    ...actual,
    searchLocalMemorySemantic: (...args: unknown[]) => searchLocalMemorySemanticMock(...args),
  };
});

const selectStartupMemoryItemsMock = vi.fn();
vi.mock('../../src/context/startup-memory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/context/startup-memory.js')>();
  return {
    ...actual,
    selectStartupMemoryItems: (...args: unknown[]) => selectStartupMemoryItemsMock(...args),
  };
});

import {
  emptyMemorySearchResult,
  searchLocalMemorySemanticFrontOfTurn,
  selectStartupMemoryForBootstrap,
} from '../../src/context/memory-recall-client.js';

const NAMESPACE: ContextNamespace = {
  scope: 'project_shared',
  projectId: 'github.com/acme/repo',
  enterpriseId: 'ent-1',
};

const SAMPLE_ITEM = {
  id: 'in-process-1',
  type: 'processed' as const,
  projectId: 'codedeck',
  scope: 'personal' as const,
  summary: 'In-process reader result',
  createdAt: 1,
};

describe('front-of-turn recall façade owner-mode gating', () => {
  beforeEach(() => {
    fakeClient.isReady = false; // via-worker hop always returns null in these tests
    fakeClient.isProductionOwner = false;
    searchLocalMemorySemanticMock.mockReset();
    selectStartupMemoryItemsMock.mockReset();
    searchLocalMemorySemanticMock.mockResolvedValue({
      items: [SAMPLE_ITEM],
      stats: emptyMemorySearchResult().stats,
    });
    selectStartupMemoryItemsMock.mockReturnValue([SAMPLE_ITEM]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // B1: production owner + worker not warm -> bounded EMPTY, no in-process read.
  it('searchLocalMemorySemanticFrontOfTurn returns bounded empty in production-owner mode without touching the in-process reader', async () => {
    fakeClient.isProductionOwner = true;
    const result = await searchLocalMemorySemanticFrontOfTurn({
      namespace: NAMESPACE,
      query: 'worker isolation context store',
      limit: 5,
    });
    expect(result.items).toHaveLength(0);
    expect(result).toEqual(emptyMemorySearchResult());
    expect(searchLocalMemorySemanticMock).not.toHaveBeenCalled();
  });

  // B2: not a production owner (tests/CLI) -> the in-process reader runs.
  it('searchLocalMemorySemanticFrontOfTurn falls back to the in-process reader when not a production owner', async () => {
    fakeClient.isProductionOwner = false;
    const result = await searchLocalMemorySemanticFrontOfTurn({
      namespace: NAMESPACE,
      query: 'worker isolation context store',
      limit: 5,
    });
    expect(searchLocalMemorySemanticMock).toHaveBeenCalledTimes(1);
    expect(result.items.map((i) => i.id)).toEqual(['in-process-1']);
  });

  // B3 (production): selectStartupMemoryForBootstrap -> [] with no in-process call.
  it('selectStartupMemoryForBootstrap returns empty in production-owner mode without touching the in-process selection', async () => {
    fakeClient.isProductionOwner = true;
    const result = await selectStartupMemoryForBootstrap(NAMESPACE, { totalLimit: 20 });
    expect(result).toEqual([]);
    expect(selectStartupMemoryItemsMock).not.toHaveBeenCalled();
  });

  // B3 (tests/CLI): selectStartupMemoryForBootstrap -> in-process selection runs.
  it('selectStartupMemoryForBootstrap falls back to the in-process selection when not a production owner', async () => {
    fakeClient.isProductionOwner = false;
    const result = await selectStartupMemoryForBootstrap(NAMESPACE, { totalLimit: 20 });
    expect(selectStartupMemoryItemsMock).toHaveBeenCalledTimes(1);
    expect(result.map((i) => i.id)).toEqual(['in-process-1']);
  });
});
