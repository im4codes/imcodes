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

  it('evicts volatile cache entries and retries quota-limited writes', () => {
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
    expect(storage.getItem(`${TIMELINE_SNAPSHOT_STORAGE_PREFIX}server:session`)).toBeNull();
    expect(storage.getItem(`${FILE_BROWSER_SNAPSHOT_KEY_PREFIX}:cwd:1:0:server`)).toBeNull();
  });

  it('returns false without throwing when storage is still unavailable', () => {
    const storage = new FakeStorage();
    storage.alwaysThrow = true;
    installFakeStorage(storage);

    expect(() => safeLocalStorageSetItem('rcc_open_subs_deck_main', '["sub-1"]')).not.toThrow();
    expect(safeLocalStorageSetItem('rcc_open_subs_deck_main', '["sub-1"]')).toBe(false);
  });
});
