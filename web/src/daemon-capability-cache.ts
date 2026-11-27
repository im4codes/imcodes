export const DAEMON_CAPABILITY_CACHE_STORAGE_KEY = 'imcodes_daemon_capability_cache_v1';
export const MAX_CACHED_SERVERS = 32;

export interface CachedDaemonCapabilityBucket {
  updatedAt: number;
  capabilities: string[];
}

export type DaemonCapabilityCachePayload = Record<string, CachedDaemonCapabilityBucket>;

export interface DaemonCapabilityCacheOptions {
  accountScope?: string | null;
  storage?: Storage;
}

const memoryCache = new Map<string, { updatedAt: number; capabilities: string[] }>();
let lastUpdatedAt = 0;

function nextTimestamp(): number {
  const now = Date.now();
  lastUpdatedAt = now > lastUpdatedAt ? now : lastUpdatedAt + 1;
  return lastUpdatedAt;
}

/**
 * Builds a deterministic account scope key from authenticated baseUrl and userId.
 * Used to isolate daemon capability caches across different user accounts on the same machine.
 */
export function buildAccountScope(baseUrl?: string | null, userId?: string | null): string {
  const b = typeof baseUrl === 'string' ? baseUrl.trim().toLowerCase() : '';
  const u = typeof userId === 'string' ? userId.trim() : '';
  if (!b || !u) return '';
  return `${b}#${u}`;
}

function normalizeOptions(options?: DaemonCapabilityCacheOptions | Storage): {
  accountScope?: string | null;
  storage?: Storage;
} {
  if (!options) return {};
  if ('getItem' in options && typeof options.getItem === 'function') {
    return { storage: options as Storage };
  }
  return options as DaemonCapabilityCacheOptions;
}

function resolveStorage(explicit?: Storage): Storage | null {
  if (explicit !== undefined) return explicit;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function toCacheKey(serverId: string, accountScope?: string | null): string {
  const scope = typeof accountScope === 'string' && accountScope.trim() ? accountScope.trim() : 'global';
  return `${scope}::${serverId}`;
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
    for (const [key, bucket] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key || !bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
      const b = bucket as { updatedAt?: unknown; capabilities?: unknown };
      const capabilities = sanitizeCapabilities(b.capabilities);
      out[key] = {
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
 * Read cached daemon capabilities for an owned server within the current account scope.
 * Returns `string[]` on hit (which can be `[]` if cached as empty), or `null` on cache miss.
 * Never throws on missing, restricted, or corrupt storage.
 */
export function readCachedDaemonCapabilities(
  serverId: string | null | undefined,
  options?: DaemonCapabilityCacheOptions | Storage,
): string[] | null {
  if (!serverId) return null;
  const { accountScope, storage } = normalizeOptions(options);
  const cacheKey = toCacheKey(serverId, accountScope);
  const mem = memoryCache.get(cacheKey);
  if (mem) {
    return [...mem.capabilities];
  }
  const target = resolveStorage(storage);
  if (!target) return null;
  const store = readCacheStore(target);
  const bucket = store[cacheKey];
  if (!bucket || !Array.isArray(bucket.capabilities)) return null;
  const caps = [...bucket.capabilities];
  memoryCache.set(cacheKey, {
    updatedAt: bucket.updatedAt,
    capabilities: caps,
  });
  return caps;
}

/**
 * Returns whether cached daemon capabilities exist for this server within the account scope.
 * Note: A cached empty capability list `[]` still returns `true` (valid hit), distinguishing
 * from an unvisited/uncached server (`null`).
 */
export function hasCachedDaemonCapabilities(
  serverId: string | null | undefined,
  options?: DaemonCapabilityCacheOptions | Storage,
): boolean {
  return readCachedDaemonCapabilities(serverId, options) !== null;
}

/**
 * Persist daemon capabilities for an owned server into memory and storage within the account scope,
 * bounded to `MAX_CACHED_SERVERS` entries.
 */
export function writeCachedDaemonCapabilities(
  serverId: string | null | undefined,
  capabilities: readonly string[],
  options?: DaemonCapabilityCacheOptions | Storage,
): void {
  if (!serverId) return;
  const { accountScope, storage } = normalizeOptions(options);
  const cacheKey = toCacheKey(serverId, accountScope);
  const sanitized = sanitizeCapabilities(capabilities);
  const now = nextTimestamp();
  memoryCache.set(cacheKey, {
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
  store[cacheKey] = {
    updatedAt: now,
    capabilities: sanitized,
  };
  writeCacheStore(target, store);
}

/**
 * Clear cached daemon capabilities for a specific server (if provided) or all servers across memory
 * and storage (e.g. on user logout / auth expiry to prevent cross-account leakage).
 */
export function clearCachedDaemonCapabilities(
  serverId?: string | null,
  options?: DaemonCapabilityCacheOptions | Storage,
): void {
  const { accountScope, storage } = normalizeOptions(options);
  if (serverId) {
    const targetKey = toCacheKey(serverId, accountScope);
    memoryCache.delete(targetKey);
    // Also if no accountScope specified, delete any key ending with ::${serverId}
    if (!accountScope) {
      for (const k of Array.from(memoryCache.keys())) {
        if (k.endsWith(`::${serverId}`)) memoryCache.delete(k);
      }
    }
    const target = resolveStorage(storage);
    if (!target) return;
    const store = readCacheStore(target);
    let changed = false;
    if (targetKey in store) {
      delete store[targetKey];
      changed = true;
    }
    if (!accountScope) {
      for (const k of Object.keys(store)) {
        if (k.endsWith(`::${serverId}`)) {
          delete store[k];
          changed = true;
        }
      }
    }
    if (changed) {
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
