import { describe, expect, it } from 'vitest';
import {
  findStaleTransitionEntries,
  findSyncContextStoreViolations,
  findSyncMemorySearchViolations,
  MEMORY_SEARCH_IMPORTERS,
  PERMANENT_IMPORTERS,
  TRANSITION_IMPORTERS,
} from '../../scripts/lint-no-sync-context-store.mjs';

describe('context-store exact-path import guard', () => {
  it('no daemon production module imports context-store.js outside the allowlist', () => {
    // Fails if a NEW module starts importing the synchronous store directly
    // instead of going through the async context-store-worker-client.
    expect(findSyncContextStoreViolations()).toEqual([]);
  });



  it('no daemon production module imports memory-search.js outside the centralized facades', () => {
    expect(findSyncMemorySearchViolations()).toEqual([]);
    expect([...MEMORY_SEARCH_IMPORTERS].sort()).toEqual([
      'context/memory-recall-client.ts',
      'index.ts',
    ]);
  });

  it('every TRANSITION allowlist entry still imports the store (no stale entries)', () => {
    // When a module finishes migrating to the async client it must be removed
    // from TRANSITION_IMPORTERS; a stale entry here flags that.
    expect(findStaleTransitionEntries()).toEqual([]);
  });

  it('the permanent allowlist is exactly the worker dispatch/recall layer + A1 exception + CLI', () => {
    // The STRICT END STATE: the only direct importers of the synchronous store
    // are (a) the worker + its shared dispatch/recall layer (which also serves as
    // the bounded in-process cold fallback), (b) the documented A1 sync exception
    // (`timeline-emitter` recordTurnUsage), and (c) the CLI. Tests live in
    // `test/` and are not scanned.
    expect([...PERMANENT_IMPORTERS].sort()).toEqual([
      'context/memory-recall-bounded.ts',
      'context/memory-recall-core.ts',
      'context/memory-search.ts',
      'daemon/timeline-emitter.ts',
      'index.ts',
      'store/context-store-op-handlers.ts',
      'store/context-store-worker.ts',
    ]);
  });

  it('the transition set is empty — every daemon caller reaches the store via the async client', () => {
    // Strict end state reached: no daemon CALLER module imports the sync store
    // directly; they all go through the async worker-client.
    expect(TRANSITION_IMPORTERS).toEqual([]);
  });

  it('allowlist sets do not overlap or duplicate', () => {
    const all = new Set([...PERMANENT_IMPORTERS, ...TRANSITION_IMPORTERS]);
    expect(all.size).toBe(PERMANENT_IMPORTERS.length + TRANSITION_IMPORTERS.length);
  });
});
