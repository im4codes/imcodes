/** Daemon-side TTL cache for repo data. */

const DEFAULT_TTL_MS = 30_000;    // 30s for successful results
const ERROR_TTL_MS = 5_000;       // 5s for error states

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
  ttlMs: number;
  projectDir: string;
}

export class RepoCache {
  private store = new Map<string, CacheEntry<unknown>>();

  static buildKey(projectDir: string, resource: string, params?: Record<string, unknown>): string {
    const paramStr = params ? JSON.stringify(params, Object.keys(params).sort()) : '';
    return `${projectDir}:${resource}:${paramStr}`;
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > entry.ttlMs) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, projectDir: string, errorState = false): void {
    this.store.set(key, {
      data,
      cachedAt: Date.now(),
      ttlMs: errorState ? ERROR_TTL_MS : DEFAULT_TTL_MS,
      projectDir,
    });
  }

  /** Invalidate entries for a projectDir, optionally scoped to a resource. */
  invalidate(projectDir: string, resource?: string): void {
    const prefix = resource ? `${projectDir}:${resource}:` : `${projectDir}:`;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  invalidateAll(): void {
    this.store.clear();
  }
}

export const repoCache = new RepoCache();
