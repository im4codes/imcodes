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

function isReclaimableStorageKey(key: string): boolean {
  return key.startsWith(FILE_BROWSER_SNAPSHOT_KEY_PREFIX)
    || key.startsWith(TERMINAL_FRAME_STORAGE_PREFIX);
}

/**
 * Lower values are reclaimed first.
 *
 * Timeline snapshots are deliberately absent from this eviction list. They are
 * the only synchronous first-paint source after a page reload and belong to
 * independent chat windows: a write for one window (or an unrelated setting)
 * must never make another window blank. Terminal/file-browser frames are the
 * only caches cheap enough to reclaim automatically.
 */
function evictionPriority(key: string): number {
  if (key.startsWith(TERMINAL_FRAME_STORAGE_PREFIX)) return 0;
  return 1;
}

function collectReclaimableStorageKeys(storage: Storage, retainKey: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key || key === retainKey || !isReclaimableStorageKey(key)) continue;
    keys.push(key);
  }
  return keys.sort((left, right) => {
    const priorityDelta = evictionPriority(left) - evictionPriority(right);
    if (priorityDelta !== 0) return priorityDelta;
    const leftSize = storage.getItem(left)?.length ?? 0;
    const rightSize = storage.getItem(right)?.length ?? 0;
    return rightSize - leftSize;
  });
}

export function safeLocalStorageSetItem(
  key: string,
  value: string,
  options?: { clearOwnTimelineSnapshotOnFailure?: boolean },
): boolean {
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
  // A timeline write belongs to one chat window. It may self-shrink/self-clear
  // below, but it must not reclaim terminal or file snapshots that may belong
  // to another window. Non-timeline settings may still reclaim those cheaper
  // caches, while timeline snapshots remain protected in every case.
  const reclaimable = key.startsWith(TIMELINE_SNAPSHOT_STORAGE_PREFIX)
    ? []
    : collectReclaimableStorageKeys(storage, key);
  for (const candidate of reclaimable) {
    try {
      storage.removeItem(candidate);
      storage.setItem(key, value);
      return true;
    } catch (error) {
      if (!isQuotaExceededError(error)) return false;
    }
  }
  // Timeline windows own only their own bounded cache. If even the smallest
  // self-budgeted tail cannot be stored, the caller may discard THIS key — but
  // never another window's snapshot — before falling back to IDB/daemon.
  if (options?.clearOwnTimelineSnapshotOnFailure
    && key.startsWith(TIMELINE_SNAPSHOT_STORAGE_PREFIX)) {
    try { storage.removeItem(key); } catch { /* ignore */ }
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
