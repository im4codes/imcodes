import { describe, it, expect, beforeEach } from 'vitest';
import {
  readCachedDaemonCapabilities,
  hasCachedDaemonCapabilities,
  writeCachedDaemonCapabilities,
  clearCachedDaemonCapabilities,
  buildAccountScope,
  __resetDaemonCapabilityCacheForTests,
  DAEMON_CAPABILITY_CACHE_STORAGE_KEY,
  MAX_CACHED_SERVERS,
} from '../src/daemon-capability-cache.js';

class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null; }
  removeItem(key: string): void { this.store.delete(key); }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
}

const DEFAULT_SCOPE = 'http://localhost:8080#user_1';

describe('daemon-capability-cache', () => {
  beforeEach(() => {
    __resetDaemonCapabilityCacheForTests();
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  it('builds account scope safely from baseUrl and userId', () => {
    expect(buildAccountScope('http://LocalHost:8080/ ', ' user_1 ')).toBe('http://localhost:8080/#user_1');
    expect(buildAccountScope('', 'user_1')).toBe('');
    expect(buildAccountScope(null, undefined)).toBe('');
  });

  it('strictly refuses to read or write cache without explicit accountScope', () => {
    const storage = new MockStorage();
    // Without accountScope, writing does nothing
    writeCachedDaemonCapabilities('srv-unscoped', ['remote_desktop'], { storage });
    expect(readCachedDaemonCapabilities('srv-unscoped', { storage })).toBeNull();
    expect(hasCachedDaemonCapabilities('srv-unscoped', { storage })).toBe(false);
    expect(storage.getItem(DAEMON_CAPABILITY_CACHE_STORAGE_KEY)).toBeNull();

    // With explicit scope, writing succeeds
    writeCachedDaemonCapabilities('srv-unscoped', ['remote_desktop'], { storage, accountScope: DEFAULT_SCOPE });
    expect(readCachedDaemonCapabilities('srv-unscoped', { storage, accountScope: DEFAULT_SCOPE })).toEqual(['remote_desktop']);
    expect(hasCachedDaemonCapabilities('srv-unscoped', { storage, accountScope: DEFAULT_SCOPE })).toBe(true);
  });

  it('reads and writes capabilities per serverId within account scope', () => {
    const storage = new MockStorage();
    const opts = { storage, accountScope: DEFAULT_SCOPE };
    expect(readCachedDaemonCapabilities('srv-1', opts)).toBeNull();

    writeCachedDaemonCapabilities('srv-1', ['remote_desktop', 'login_screen'], opts);
    expect(readCachedDaemonCapabilities('srv-1', opts)).toEqual(['remote_desktop', 'login_screen']);

    // Another server is isolated
    expect(readCachedDaemonCapabilities('srv-2', opts)).toBeNull();
  });

  it('isolates capabilities between different account scopes on the same serverId', () => {
    const storage = new MockStorage();
    const scopeUser1 = buildAccountScope('http://localhost', 'user-1');
    const scopeUser2 = buildAccountScope('http://localhost', 'user-2');

    writeCachedDaemonCapabilities('srv-shared', ['remote_desktop'], { storage, accountScope: scopeUser1 });
    expect(readCachedDaemonCapabilities('srv-shared', { storage, accountScope: scopeUser1 })).toEqual(['remote_desktop']);

    // User 2 sees null (cache miss) for the same serverId
    expect(readCachedDaemonCapabilities('srv-shared', { storage, accountScope: scopeUser2 })).toBeNull();
    expect(hasCachedDaemonCapabilities('srv-shared', { storage, accountScope: scopeUser2 })).toBe(false);

    // User 2 writes their own capabilities
    writeCachedDaemonCapabilities('srv-shared', ['login_screen'], { storage, accountScope: scopeUser2 });
    expect(readCachedDaemonCapabilities('srv-shared', { storage, accountScope: scopeUser1 })).toEqual(['remote_desktop']);
    expect(readCachedDaemonCapabilities('srv-shared', { storage, accountScope: scopeUser2 })).toEqual(['login_screen']);
  });

  it('distinguishes cached empty array from cache miss in hasCachedDaemonCapabilities', () => {
    const storage = new MockStorage();
    const opts = { storage, accountScope: DEFAULT_SCOPE };
    expect(hasCachedDaemonCapabilities('srv-uncached', opts)).toBe(false);
    expect(readCachedDaemonCapabilities('srv-uncached', opts)).toBeNull();

    writeCachedDaemonCapabilities('srv-empty', [], opts);
    expect(hasCachedDaemonCapabilities('srv-empty', opts)).toBe(true);
    expect(readCachedDaemonCapabilities('srv-empty', opts)).toEqual([]);
  });

  it('sanitizes capabilities by trimming, filtering non-strings, and deduplicating', () => {
    const storage = new MockStorage();
    const opts = { storage, accountScope: DEFAULT_SCOPE };
    writeCachedDaemonCapabilities(
      'srv-1',
      [' remote_desktop ', '', 'remote_desktop', 'installable', null as unknown as string, '  '],
      opts,
    );
    expect(readCachedDaemonCapabilities('srv-1', opts)).toEqual(['remote_desktop', 'installable']);
  });

  it('bounds capacity to MAX_CACHED_SERVERS and evicts oldest updated server', () => {
    const storage = new MockStorage();
    for (let i = 0; i < MAX_CACHED_SERVERS + 5; i++) {
      writeCachedDaemonCapabilities(`srv-${i}`, [`cap-${i}`], { storage, accountScope: DEFAULT_SCOPE });
    }
    const raw = JSON.parse(storage.getItem(DAEMON_CAPABILITY_CACHE_STORAGE_KEY)!) as Record<string, unknown>;
    expect(Object.keys(raw).length).toBe(MAX_CACHED_SERVERS);
    // Oldest servers (srv-0 .. srv-4) should have been evicted from storage
    expect(readCachedDaemonCapabilities('srv-0', { storage, accountScope: DEFAULT_SCOPE })).toBeNull();
    expect(readCachedDaemonCapabilities(`srv-${MAX_CACHED_SERVERS + 4}`, { storage, accountScope: DEFAULT_SCOPE })).toEqual([`cap-${MAX_CACHED_SERVERS + 4}`]);
  });

  it('clears specific server from cache without touching other servers', () => {
    const storage = new MockStorage();
    const opts = { storage, accountScope: DEFAULT_SCOPE };
    writeCachedDaemonCapabilities('srv-1', ['cap-1'], opts);
    writeCachedDaemonCapabilities('srv-2', ['cap-2'], opts);

    clearCachedDaemonCapabilities('srv-1', opts);
    expect(readCachedDaemonCapabilities('srv-1', opts)).toBeNull();
    expect(readCachedDaemonCapabilities('srv-2', opts)).toEqual(['cap-2']);
  });

  it('clears all cached daemon capabilities across memory and storage on logout', () => {
    const storage = new MockStorage();
    writeCachedDaemonCapabilities('srv-1', ['cap-1'], { storage, accountScope: DEFAULT_SCOPE });
    writeCachedDaemonCapabilities('srv-2', ['cap-2'], { storage, accountScope: DEFAULT_SCOPE });

    clearCachedDaemonCapabilities(undefined, { storage });
    expect(storage.getItem(DAEMON_CAPABILITY_CACHE_STORAGE_KEY)).toBeNull();
    expect(readCachedDaemonCapabilities('srv-1', { storage, accountScope: DEFAULT_SCOPE })).toBeNull();
    expect(readCachedDaemonCapabilities('srv-2', { storage, accountScope: DEFAULT_SCOPE })).toBeNull();
  });

  it('handles corrupt JSON in storage safely without throwing', () => {
    const storage = new MockStorage();
    const opts = { storage, accountScope: DEFAULT_SCOPE };
    storage.setItem(DAEMON_CAPABILITY_CACHE_STORAGE_KEY, '{invalid json');
    expect(readCachedDaemonCapabilities('srv-1', opts)).toBeNull();

    // Writing overwrites corrupted payload gracefully
    writeCachedDaemonCapabilities('srv-1', ['recovered'], opts);
    expect(readCachedDaemonCapabilities('srv-1', opts)).toEqual(['recovered']);
  });

  it('falls back to memory cache when storage throws or is unavailable', () => {
    const throwingStorage = {
      getItem() { throw new Error('SecurityError: storage disabled'); },
      setItem() { throw new Error('QuotaExceededError'); },
      removeItem() { throw new Error('SecurityError: storage disabled'); },
      clear() {},
      length: 0,
      key() { return null; },
    } as unknown as Storage;
    const opts = { storage: throwingStorage, accountScope: DEFAULT_SCOPE };

    // In-memory caching works even if localStorage throws
    writeCachedDaemonCapabilities('srv-mem', ['mem_cap'], opts);
    expect(readCachedDaemonCapabilities('srv-mem', opts)).toEqual(['mem_cap']);

    clearCachedDaemonCapabilities(undefined, opts);
    expect(readCachedDaemonCapabilities('srv-mem', opts)).toBeNull();
  });
});
