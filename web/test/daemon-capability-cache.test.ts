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
  setItem(key: string, value: string): void { this.store.set(key, value); }
}

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

  it('reads and writes capabilities per serverId', () => {
    const storage = new MockStorage();
    expect(readCachedDaemonCapabilities('srv-1', storage)).toBeNull();

    writeCachedDaemonCapabilities('srv-1', ['remote_desktop', 'login_screen'], storage);
    expect(readCachedDaemonCapabilities('srv-1', storage)).toEqual(['remote_desktop', 'login_screen']);

    // Another server is isolated
    expect(readCachedDaemonCapabilities('srv-2', storage)).toBeNull();
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
    expect(hasCachedDaemonCapabilities('srv-uncached', storage)).toBe(false);
    expect(readCachedDaemonCapabilities('srv-uncached', storage)).toBeNull();

    writeCachedDaemonCapabilities('srv-empty', [], storage);
    expect(hasCachedDaemonCapabilities('srv-empty', storage)).toBe(true);
    expect(readCachedDaemonCapabilities('srv-empty', storage)).toEqual([]);
  });

  it('sanitizes capabilities by trimming, filtering non-strings, and deduplicating', () => {
    const storage = new MockStorage();
    writeCachedDaemonCapabilities(
      'srv-1',
      [' remote_desktop ', '', 'remote_desktop', 'installable', null as unknown as string, '  '],
      storage,
    );
    expect(readCachedDaemonCapabilities('srv-1', storage)).toEqual(['remote_desktop', 'installable']);
  });

  it('bounds capacity to MAX_CACHED_SERVERS and evicts oldest updated server', () => {
    const storage = new MockStorage();
    for (let i = 0; i < MAX_CACHED_SERVERS + 5; i++) {
      writeCachedDaemonCapabilities(`srv-${i}`, [`cap-${i}`], storage);
    }
    const raw = JSON.parse(storage.getItem(DAEMON_CAPABILITY_CACHE_STORAGE_KEY)!) as Record<string, unknown>;
    expect(Object.keys(raw).length).toBe(MAX_CACHED_SERVERS);
    // Oldest servers (srv-0 .. srv-4) should have been evicted from storage
    expect(readCachedDaemonCapabilities('srv-0', storage)).toBeNull();
    expect(readCachedDaemonCapabilities(`srv-${MAX_CACHED_SERVERS + 4}`, storage)).toEqual([`cap-${MAX_CACHED_SERVERS + 4}`]);
  });

  it('clears specific server from cache without touching other servers', () => {
    const storage = new MockStorage();
    writeCachedDaemonCapabilities('srv-1', ['cap-1'], storage);
    writeCachedDaemonCapabilities('srv-2', ['cap-2'], storage);

    clearCachedDaemonCapabilities('srv-1', storage);
    expect(readCachedDaemonCapabilities('srv-1', storage)).toBeNull();
    expect(readCachedDaemonCapabilities('srv-2', storage)).toEqual(['cap-2']);
  });

  it('clears all cached daemon capabilities across memory and storage on logout', () => {
    const storage = new MockStorage();
    writeCachedDaemonCapabilities('srv-1', ['cap-1'], storage);
    writeCachedDaemonCapabilities('srv-2', ['cap-2'], storage);

    clearCachedDaemonCapabilities(undefined, storage);
    expect(storage.getItem(DAEMON_CAPABILITY_CACHE_STORAGE_KEY)).toBeNull();
    expect(readCachedDaemonCapabilities('srv-1', storage)).toBeNull();
    expect(readCachedDaemonCapabilities('srv-2', storage)).toBeNull();
  });

  it('handles corrupt JSON in storage safely without throwing', () => {
    const storage = new MockStorage();
    storage.setItem(DAEMON_CAPABILITY_CACHE_STORAGE_KEY, '{invalid json');
    expect(readCachedDaemonCapabilities('srv-1', storage)).toBeNull();

    // Writing overwrites corrupted payload gracefully
    writeCachedDaemonCapabilities('srv-1', ['recovered'], storage);
    expect(readCachedDaemonCapabilities('srv-1', storage)).toEqual(['recovered']);
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

    // In-memory caching works even if localStorage throws
    writeCachedDaemonCapabilities('srv-mem', ['mem_cap'], throwingStorage);
    expect(readCachedDaemonCapabilities('srv-mem', throwingStorage)).toEqual(['mem_cap']);

    clearCachedDaemonCapabilities(undefined, throwingStorage);
    expect(readCachedDaemonCapabilities('srv-mem', throwingStorage)).toBeNull();
  });
});
