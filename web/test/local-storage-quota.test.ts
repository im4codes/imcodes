import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FILE_BROWSER_SNAPSHOT_KEY_PREFIX,
  TIMELINE_SNAPSHOT_STORAGE_PREFIX,
  safeLocalStorageSetItem,
} from '../src/local-storage-quota.js';

class FakeStorage implements Storage {
  private readonly store = new Map<string, string>();
  setCalls = 0;
  alwaysThrow = false;
  throwFirstQuota = false;
  maxTotalLength = Number.POSITIVE_INFINITY;

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.setCalls += 1;
    if (this.alwaysThrow || (this.throwFirstQuota && this.setCalls === 1)) {
      throw new DOMException('localStorage quota exceeded', 'QuotaExceededError');
    }
    const previousLength = this.store.get(key)?.length ?? 0;
    const totalLength = Array.from(this.store.values()).reduce((sum, item) => sum + item.length, 0);
    if (totalLength - previousLength + value.length > this.maxTotalLength) {
      throw new DOMException('localStorage quota exceeded', 'QuotaExceededError');
    }
    this.store.set(key, value);
  }
}

describe('safeLocalStorageSetItem', () => {
  let originalLocalStorage: Storage;

  beforeEach(() => {
    originalLocalStorage = window.localStorage;
  });

  afterEach(() => {
    Object.defineProperty(window, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
    });
    originalLocalStorage.clear();
  });

  function installFakeStorage(storage: FakeStorage): void {
    Object.defineProperty(window, 'localStorage', {
      value: storage,
      configurable: true,
    });
  }

  it('evicts only the minimum lower-priority cache entries needed for a quota-limited write', () => {
    const storage = new FakeStorage();
    storage.setItem(`${TIMELINE_SNAPSHOT_STORAGE_PREFIX}server:session`, 'x'.repeat(100));
    storage.setItem(`${FILE_BROWSER_SNAPSHOT_KEY_PREFIX}:cwd:1:0:server`, 'y'.repeat(50));
    storage.setItem('rcc_auth', 'keep');
    storage.setCalls = 0;
    storage.throwFirstQuota = true;
    installFakeStorage(storage);

    expect(safeLocalStorageSetItem('rcc_open_subs_deck_main', '["sub-1","sub-2"]')).toBe(true);

    expect(storage.getItem('rcc_open_subs_deck_main')).toBe('["sub-1","sub-2"]');
    expect(storage.getItem('rcc_auth')).toBe('keep');
    // Timeline is the synchronous chat first-paint source, so the cheaper file
    // browser snapshot goes first and a successful retry stops immediately.
    expect(storage.getItem(`${TIMELINE_SNAPSHOT_STORAGE_PREFIX}server:session`)).toBe('x'.repeat(100));
    expect(storage.getItem(`${FILE_BROWSER_SNAPSHOT_KEY_PREFIX}:cwd:1:0:server`)).toBeNull();
  });

  it('never evicts another chat window snapshot to satisfy an unrelated write', () => {
    const storage = new FakeStorage();
    const snapshot = (ts: number, padding: number): string => JSON.stringify([{ ts, text: 'x'.repeat(padding) }]);
    const oldestKey = `${TIMELINE_SNAPSHOT_STORAGE_PREFIX}server:oldest`;
    const middleKey = `${TIMELINE_SNAPSHOT_STORAGE_PREFIX}server:middle`;
    const newestKey = `${TIMELINE_SNAPSHOT_STORAGE_PREFIX}server:newest`;
    storage.setItem(oldestKey, snapshot(1, 60));
    storage.setItem(middleKey, snapshot(2, 60));
    storage.setItem(newestKey, snapshot(3, 60));
    const existingLength = [oldestKey, middleKey, newestKey]
      .reduce((sum, key) => sum + (storage.getItem(key)?.length ?? 0), 0);
    storage.maxTotalLength = existingLength + 10;
    installFakeStorage(storage);

    expect(safeLocalStorageSetItem('rcc_session', 'new-session-value')).toBe(false);

    expect(storage.getItem(oldestKey)).not.toBeNull();
    expect(storage.getItem(middleKey)).not.toBeNull();
    expect(storage.getItem(newestKey)).not.toBeNull();
    expect(storage.getItem('rcc_session')).toBeNull();
  });

  it('preserves the current and peer window snapshots when refreshing the current one exceeds quota', () => {
    const storage = new FakeStorage();
    const currentKey = `${TIMELINE_SNAPSHOT_STORAGE_PREFIX}server:current`;
    const peerKey = `${TIMELINE_SNAPSHOT_STORAGE_PREFIX}server:peer`;
    storage.setItem(currentKey, 'current-old');
    storage.setItem(peerKey, 'peer-history');
    storage.maxTotalLength = 'current-old'.length + 'peer-history'.length;
    installFakeStorage(storage);

    expect(safeLocalStorageSetItem(currentKey, 'current-new-and-larger', {
      clearOwnTimelineSnapshotOnFailure: true,
    })).toBe(false);
    expect(storage.getItem(currentKey)).toBeNull();
    expect(storage.getItem(peerKey)).toBe('peer-history');
  });

  it('does not evict another window file cache for a timeline write', () => {
    const storage = new FakeStorage();
    const timelineKey = `${TIMELINE_SNAPSHOT_STORAGE_PREFIX}server:current`;
    const fileKey = `${FILE_BROWSER_SNAPSHOT_KEY_PREFIX}:cwd:1:0:server`;
    storage.setItem(fileKey, 'peer-file-window');
    storage.maxTotalLength = 'peer-file-window'.length;
    installFakeStorage(storage);

    expect(safeLocalStorageSetItem(timelineKey, 'timeline', {
      clearOwnTimelineSnapshotOnFailure: true,
    })).toBe(false);
    expect(storage.getItem(timelineKey)).toBeNull();
    expect(storage.getItem(fileKey)).toBe('peer-file-window');
  });

  it('returns false without throwing when storage is still unavailable', () => {
    const storage = new FakeStorage();
    storage.alwaysThrow = true;
    installFakeStorage(storage);

    expect(() => safeLocalStorageSetItem('rcc_open_subs_deck_main', '["sub-1"]')).not.toThrow();
    expect(safeLocalStorageSetItem('rcc_open_subs_deck_main', '["sub-1"]')).toBe(false);
  });
});
