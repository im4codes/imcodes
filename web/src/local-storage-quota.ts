export const TIMELINE_SNAPSHOT_STORAGE_PREFIX = 'rcc_timeline_snapshot:';
export const FILE_BROWSER_SNAPSHOT_KEY_PREFIX = 'rcc_fb_snapshot_v1';
export const TERMINAL_FRAME_STORAGE_PREFIX = 'deck_frame_';

const QUOTA_EVICTION_PREFIXES = [
  TIMELINE_SNAPSHOT_STORAGE_PREFIX,
  FILE_BROWSER_SNAPSHOT_KEY_PREFIX,
  TERMINAL_FRAME_STORAGE_PREFIX,
];

function isQuotaExceededError(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false;
  return error.name === 'QuotaExceededError'
    || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error.code === 22
    || error.code === 1014;
}

function isVolatileStorageKey(key: string): boolean {
  return QUOTA_EVICTION_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function collectVolatileStorageKeys(storage: Storage, retainKey: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key || key === retainKey || !isVolatileStorageKey(key)) continue;
    keys.push(key);
  }
  return keys.sort((left, right) => {
    const leftSize = storage.getItem(left)?.length ?? 0;
    const rightSize = storage.getItem(right)?.length ?? 0;
    return rightSize - leftSize;
  });
}

function evictVolatileLocalStorageEntries(retainKey: string): void {
  const storage = window.localStorage;
  const keys = collectVolatileStorageKeys(storage, retainKey);
  for (const key of keys) storage.removeItem(key);
}

export function safeLocalStorageSetItem(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    if (!isQuotaExceededError(error)) return false;
  }

  try {
    evictVolatileLocalStorageEntries(key);
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeLocalStorageRemoveItem(key: string): boolean {
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
