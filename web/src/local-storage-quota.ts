export const TIMELINE_SNAPSHOT_STORAGE_PREFIX = 'rcc_timeline_snapshot:';
export const FILE_BROWSER_SNAPSHOT_KEY_PREFIX = 'rcc_fb_snapshot_v1';
export const TERMINAL_FRAME_STORAGE_PREFIX = 'deck_frame_';

function isQuotaExceededError(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false;
  return error.name === 'QuotaExceededError'
    || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error.code === 22
    || error.code === 1014;
}

function isVolatileStorageKey(key: string): boolean {
  return key.startsWith(TIMELINE_SNAPSHOT_STORAGE_PREFIX)
    || key.startsWith(FILE_BROWSER_SNAPSHOT_KEY_PREFIX)
    || key.startsWith(TERMINAL_FRAME_STORAGE_PREFIX);
}

/**
 * Lower values are reclaimed first.
 *
 * Timeline snapshots are the only synchronous first-paint source after a page
 * reload. IndexedDB can refill them later, but that asynchronous gap is visible
 * as a blank chat when the user switches windows. Terminal/file-browser frames
 * are therefore cheaper to lose and must never evict every timeline snapshot
 * merely because one unrelated preference write encountered quota pressure.
 */
function evictionPriority(key: string): number {
  if (key.startsWith(TERMINAL_FRAME_STORAGE_PREFIX)) return 0;
  if (key.startsWith(FILE_BROWSER_SNAPSHOT_KEY_PREFIX)) return 1;
  return 2;
}

function timelineSnapshotNewestTimestamp(storage: Storage, key: string): number {
  if (!key.startsWith(TIMELINE_SNAPSHOT_STORAGE_PREFIX)) return 0;
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return 0;
    let newest = 0;
    for (const candidate of parsed) {
      if (!candidate || typeof candidate !== 'object') continue;
      const ts = (candidate as { ts?: unknown }).ts;
      if (typeof ts === 'number' && Number.isFinite(ts)) newest = Math.max(newest, ts);
    }
    return newest;
  } catch {
    // Corrupt/unreadable snapshots have no first-paint value and are the oldest.
    return 0;
  }
}

function collectVolatileStorageKeys(storage: Storage, retainKey: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key || key === retainKey || !isVolatileStorageKey(key)) continue;
    keys.push(key);
  }
  return keys.sort((left, right) => {
    const priorityDelta = evictionPriority(left) - evictionPriority(right);
    if (priorityDelta !== 0) return priorityDelta;
    if (left.startsWith(TIMELINE_SNAPSHOT_STORAGE_PREFIX)
      && right.startsWith(TIMELINE_SNAPSHOT_STORAGE_PREFIX)) {
      const ageDelta = timelineSnapshotNewestTimestamp(storage, left)
        - timelineSnapshotNewestTimestamp(storage, right);
      if (ageDelta !== 0) return ageDelta;
    }
    const leftSize = storage.getItem(left)?.length ?? 0;
    const rightSize = storage.getItem(right)?.length ?? 0;
    return rightSize - leftSize;
  });
}

export function safeLocalStorageSetItem(key: string, value: string): boolean {
  const storage = window.localStorage;
  try {
    storage.setItem(key, value);
    return true;
  } catch (error) {
    if (!isQuotaExceededError(error)) return false;
  }

  // Reclaim the minimum necessary space. The previous implementation removed
  // every volatile entry before a single retry, so one full-store write erased
  // all other sessions' synchronous timeline seeds. Switching back to any of
  // those sessions then had to wait for IndexedDB and painted a blank pane.
  for (const candidate of collectVolatileStorageKeys(storage, key)) {
    try {
      storage.removeItem(candidate);
      storage.setItem(key, value);
      return true;
    } catch (error) {
      if (!isQuotaExceededError(error)) return false;
    }
  }
  return false;
}

export function safeLocalStorageRemoveItem(key: string): boolean {
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
