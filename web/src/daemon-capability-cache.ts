export const DAEMON_CAPABILITY_CACHE_STORAGE_KEY = 'imcodes_daemon_capability_cache_v1';
export const MAX_CACHED_SERVERS = 32;

export interface CachedDaemonCapabilityBucket {
  updatedAt: number;
  capabilities: string[];
}

export type DaemonCapabilityCachePayload = Record<string, CachedDaemonCapabilityBucket>;

const memoryCache = new Map<string, { updatedAt: number; capabilities: string[] }>();
let lastUpdatedAt = 0;

function nextTimestamp(): number {
  const now = Date.now();
  lastUpdatedAt = now > lastUpdatedAt ? now : lastUpdatedAt + 1;
  return lastUpdatedAt;
}

function resolveStorage(explicit?: Storage): Storage | null {
  if (explicit !== undefined) return explicit;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function sanitizeCapabilities(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const sanitized: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        sanitized.push(trimmed);
      }
    }
  }
  return sanitized;
}

function readCacheStore(storage: Storage): DaemonCapabilityCachePayload {
  try {
    const raw = storage.getItem(DAEMON_CAPABILITY_CACHE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: DaemonCapabilityCachePayload = {};
    for (const [serverId, bucket] of Object.entries(parsed as Record<string, unknown>)) {
      if (!serverId || !bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
      const b = bucket as { updatedAt?: unknown; capabilities?: unknown };
      const capabilities = sanitizeCapabilities(b.capabilities);
      out[serverId] = {
        updatedAt: typeof b.updatedAt === 'number' && Number.isFinite(b.updatedAt) ? b.updatedAt : 0,
        capabilities,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeCacheStore(storage: Storage, payload: DaemonCapabilityCachePayload): void {
  try {
    const entries = Object.entries(payload);
    if (entries.length === 0) {
      storage.removeItem(DAEMON_CAPABILITY_CACHE_STORAGE_KEY);
      return;
    }
    if (entries.length > MAX_CACHED_SERVERS) {
      entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      entries.length = MAX_CACHED_SERVERS;
    }
    const bounded: DaemonCapabilityCachePayload = Object.fromEntries(entries);
    storage.setItem(DAEMON_CAPABILITY_CACHE_STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    // Storage quota exceeded or unavailable — degrade gracefully.
  }
}

/**
 * Read cached daemon capabilities for an owned server.
 * Returns `string[]` on hit, or `null` on cache miss (server not yet cached).
 * Never throws on missing, restricted, or corrupt storage.
 */
export function readCachedDaemonCapabilities(
  serverId: string | null | undefined,
  storage?: Storage,
): string[] | null {
  if (!serverId) return null;
  const mem = memoryCache.get(serverId);
  if (mem) {
    return [...mem.capabilities];
  }
  const target = resolveStorage(storage);
  if (!target) return null;
  const store = readCacheStore(target);
  const bucket = store[serverId];
  if (!bucket || !Array.isArray(bucket.capabilities)) return null;
  const caps = [...bucket.capabilities];
  memoryCache.set(serverId, {
    updatedAt: bucket.updatedAt,
    capabilities: caps,
  });
  return caps;
}

/**
 * Persist daemon capabilities for an owned server into memory and storage,
 * bounded to `MAX_CACHED_SERVERS` servers.
 */
export function writeCachedDaemonCapabilities(
  serverId: string | null | undefined,
  capabilities: readonly string[],
  storage?: Storage,
): void {
  if (!serverId) return;
  const sanitized = sanitizeCapabilities(capabilities);
  const now = nextTimestamp();
  memoryCache.set(serverId, {
    updatedAt: now,
    capabilities: [...sanitized],
  });
  if (memoryCache.size > MAX_CACHED_SERVERS) {
    const oldest = Array.from(memoryCache.entries()).sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (oldest) memoryCache.delete(oldest[0]);
  }
  const target = resolveStorage(storage);
  if (!target) return;
  const store = readCacheStore(target);
  store[serverId] = {
    updatedAt: now,
    capabilities: sanitized,
  };
  writeCacheStore(target, store);
}

/**
 * Clear cached daemon capabilities for a specific server (if provided) or all servers
 * (e.g. on user logout to prevent cross-account leakage).
 */
export function clearCachedDaemonCapabilities(
  serverId?: string | null,
  storage?: Storage,
): void {
  if (serverId) {
    memoryCache.delete(serverId);
    const target = resolveStorage(storage);
    if (!target) return;
    const store = readCacheStore(target);
    if (serverId in store) {
      delete store[serverId];
      writeCacheStore(target, store);
    }
    return;
  }
  memoryCache.clear();
  try {
    const target = resolveStorage(storage);
    target?.removeItem(DAEMON_CAPABILITY_CACHE_STORAGE_KEY);
  } catch {
    // Ignore restricted/unavailable storage.
  }
}

/** Test-only helper to reset memory-level cache between test cases */
export function __resetDaemonCapabilityCacheForTests(): void {
  memoryCache.clear();
  lastUpdatedAt = 0;
}
