/**
 * Bounded LRU mapping a `projectionId` to the `originServerId` of the daemon
 * that produced it. Populated by `searchMcpMemoryRecall` as it returns hits
 * to the MCP layer; consumed by the `get_memory_sources` orchestrator to
 * decide whether to run a local SQLite lookup or pod-sticky route to a
 * different daemon.
 *
 * Why a process-local cache?
 *   - The cloud `/api/memory/projection-owner` endpoint is the durable
 *     source of truth, but every `get_memory_sources` call doesn't need to
 *     round-trip there. Once the daemon has seen a hit via search_memory it
 *     already knows the owner. The cache skips the redundant request.
 *   - Bounded so a long-running daemon cannot grow this map without limit.
 *   - LRU-style eviction: the oldest insert is dropped when the cap is hit.
 *     Map iteration order in V8 is insertion order, so deleting the first
 *     key is constant-time and gives correct LRU semantics if we re-insert
 *     on every read (which we do).
 *   - Non-persistent on purpose: restart penalty is one extra cloud round
 *     trip per projection, which is negligible compared to the operational
 *     cost of persisting and invalidating a local cache file.
 */

/** Cap chosen to comfortably hold the typical search-hit window without
 * letting a runaway loop blow up memory. ~64 bytes per entry × 2048 ≈ 128KB. */
export const MAX_PROJECTION_OWNER_CACHE_ENTRIES = 2048;

export interface ProjectionOwnerCache {
  /** Read and refresh recency. Returns undefined when no entry exists. */
  get(projectionId: string): string | undefined;
  /** Insert or refresh. No-op if either field is empty. */
  set(projectionId: string, originServerId: string): void;
  /** Forget the entry. Returns true if it existed. */
  delete(projectionId: string): boolean;
  /** Inspection only — tests use this; production code should not rely on it. */
  size(): number;
  /** Drop every entry. Used by tests; production code does not need it. */
  clear(): void;
}

export function createProjectionOwnerCache(maxEntries: number = MAX_PROJECTION_OWNER_CACHE_ENTRIES): ProjectionOwnerCache {
  const cap = Math.max(1, Math.trunc(maxEntries));
  const store = new Map<string, string>();

  return {
    get(projectionId: string): string | undefined {
      if (!projectionId) return undefined;
      const value = store.get(projectionId);
      if (value === undefined) return undefined;
      // Refresh recency by re-inserting so the entry moves to the tail.
      store.delete(projectionId);
      store.set(projectionId, value);
      return value;
    },
    set(projectionId: string, originServerId: string): void {
      if (!projectionId || !originServerId) return;
      // Re-insert so the entry moves to the tail regardless of whether it
      // already existed.
      if (store.has(projectionId)) store.delete(projectionId);
      store.set(projectionId, originServerId);
      // Evict from the head (oldest) until under the cap. The cap is large
      // enough that only one eviction per insert is expected once steady.
      while (store.size > cap) {
        const oldestKey = store.keys().next().value;
        if (oldestKey === undefined) break;
        store.delete(oldestKey);
      }
    },
    delete(projectionId: string): boolean {
      return store.delete(projectionId);
    },
    size(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
  };
}

/**
 * Process-wide singleton. The MCP daemon runs as a single Node process,
 * so a module-scope cache is correct — the search-side and tool-side both
 * import it and share the same map.
 */
export const projectionOwnerCache = createProjectionOwnerCache();
