export const TIMELINE_SNAPSHOT_STORAGE_PREFIX = 'rcc_timeline_snapshot:';
export const FILE_BROWSER_SNAPSHOT_KEY_PREFIX = 'rcc_fb_snapshot_v1';
export const TERMINAL_FRAME_STORAGE_PREFIX = 'deck_frame_';
/** Keep a single composer draft bounded so one paste cannot consume the tab's entire session store. */
export const COMPOSER_DRAFT_MAX_CHARS = 64 * 1024;

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

function getSessionStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
  } catch { /* fall through to the global shim/implementation */ }
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

// Keep a bounded in-memory copy when a browser refuses all sessionStorage
// writes. This survives composer unmount/remount during a tab switch without
// evicting any other session's persisted draft.
const sessionDraftFallback = new Map<string, string>();
// A fallback value is authoritative only while the corresponding storage
// write is known to be unavailable.  Once storage is readable and has no key,
// do not resurrect a stale value from an earlier component instance.
const sessionDraftFallbackPending = new Set<string>();
const sessionDraftFallbackStorage = new Map<string, Storage | null>();

/** Session-storage counterpart used by transient composer state. */
export function safeSessionStorageGetItem(key: string): string | null {
  const storage = getSessionStorage();
  if (storage) {
    try {
      const persisted = storage.getItem(key);
      if (persisted !== null) return persisted;
      if (!sessionDraftFallbackPending.has(key)) return null;
      if (sessionDraftFallbackStorage.get(key) !== storage) return null;
    } catch { /* use the in-memory copy below */ }
  }
  return sessionDraftFallback.get(key) ?? null;
}

/**
 * Persist a draft without allowing a large paste or a full tab store to take
 * down a tab during a React unmount.  Only the current draft key may be
 * removed on retry; other sessions' drafts are never evicted.
 */
export function safeSessionStorageSetItem(
  key: string,
  value: string,
  maxLength = COMPOSER_DRAFT_MAX_CHARS,
): boolean {
  const bounded = value.length > maxLength ? value.slice(0, maxLength) : value;
  // Keep the latest bounded value before touching storage, so quota/security
  // failures leave a recoverable draft for a same-page remount.
  sessionDraftFallback.set(key, bounded);
  sessionDraftFallbackPending.add(key);
  const storage = getSessionStorage();
  sessionDraftFallbackStorage.set(key, storage);
  if (!storage) return false;
  try {
    // Bound before the first write as well as on quota retry. A successful
    // write must never allow one paste to consume the entire session store.
    storage.setItem(key, bounded);
    sessionDraftFallbackPending.delete(key);
    return true;
  } catch (error) {
    if (!isQuotaExceededError(error)) return false;
  }
  try {
    storage.setItem(key, bounded);
    sessionDraftFallbackPending.delete(key);
    return true;
  } catch (error) {
    if (!isQuotaExceededError(error)) return false;
  }
  // Replacing a very large value can itself exceed a strict implementation's
  // temporary quota. Removing only this key makes the compact retry possible
  // without deleting another session's data.
  try { storage.removeItem(key); } catch { return false; }
  try {
    storage.setItem(key, bounded);
    sessionDraftFallbackPending.delete(key);
    return true;
  } catch { return false; }
}

export function safeSessionStorageRemoveItem(key: string): boolean {
  sessionDraftFallback.delete(key);
  sessionDraftFallbackPending.delete(key);
  sessionDraftFallbackStorage.delete(key);
  const storage = getSessionStorage();
  if (!storage) return false;
  try { storage.removeItem(key); return true; } catch { return false; }
}
