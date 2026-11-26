/** Device-local tab snapshot helpers.  Server ids are part of the key so a
 * session/tab from one server can never become the default for another.
 *
 * The snapshot is the user's last deliberately opened tab on that server. It is
 * only ever written from an explicit user choice (see `setActiveSession`'s
 * `remember` option in app.tsx), never from an unresolved selection or from an
 * automatic fallback, so "nothing selected yet" or "the saved tab no longer
 * exists" cannot erase or replace it.
 *
 * Storage is bounded: an MRU index of server ids caps how many snapshots are
 * kept, evicting the least recently used one's key. */
export const SERVER_SESSION_INDEX_STORAGE_KEY = 'rcc_session_index_v1';
/** Far above any realistic server count; bounds stale keys left by deleted servers. */
export const MAX_REMEMBERED_SERVER_SESSIONS = 64;
const MAX_REMEMBERED_VALUE_LENGTH = 1_024;
const MAX_SERVER_ID_LENGTH = 512;

export function serverSessionStorageKey(serverId: string): string {
  return `rcc_session_${encodeURIComponent(serverId)}`;
}

export function readServerSession(serverId: string, storage: Storage = localStorage): string | null {
  if (!serverId) return null;
  try {
    const key = serverSessionStorageKey(serverId);
    // Read the pre-scoped spelling once for backwards compatibility with
    // older builds; all new writes use the encoded key.
    const legacyKey = `rcc_session_${serverId}`;
    const value = storage.getItem(key) ?? (legacyKey === key ? null : storage.getItem(legacyKey));
    return value && value.length <= MAX_REMEMBERED_VALUE_LENGTH ? value : null;
  } catch {
    return null;
  }
}

function readIndex(storage: Storage): string[] {
  try {
    const parsed = JSON.parse(storage.getItem(SERVER_SESSION_INDEX_STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => (
      typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_SERVER_ID_LENGTH
    )).slice(0, MAX_REMEMBERED_SERVER_SESSIONS);
  } catch {
    return [];
  }
}

function writeIndex(storage: Storage, index: readonly string[]): void {
  try {
    if (index.length === 0) storage.removeItem(SERVER_SESSION_INDEX_STORAGE_KEY);
    else storage.setItem(SERVER_SESSION_INDEX_STORAGE_KEY, JSON.stringify(index));
  } catch {
    // Quota/disabled storage: the snapshots themselves stay usable.
  }
}

/** The server whose tab was remembered most recently (the last one used), or null. */
export function readLastRememberedServerId(storage: Storage = localStorage): string | null {
  return readIndex(storage)[0] ?? null;
}

/**
 * Remember `sessionName` as the last tab of `serverId`. A null/empty name
 * deliberately forgets it (only used for an explicit "this server has no tab").
 * Callers must not pass a fallback or an unresolved selection here.
 */
export function writeServerSession(serverId: string, sessionName: string | null, storage: Storage = localStorage): void {
  if (!serverId || serverId.length > MAX_SERVER_ID_LENGTH) return;
  try {
    const key = serverSessionStorageKey(serverId);
    if (sessionName && sessionName.length <= MAX_REMEMBERED_VALUE_LENGTH) {
      storage.setItem(key, sessionName);
      const index = [serverId, ...readIndex(storage).filter((id) => id !== serverId)];
      for (const evicted of index.splice(MAX_REMEMBERED_SERVER_SESSIONS)) {
        storage.removeItem(serverSessionStorageKey(evicted));
      }
      writeIndex(storage, index);
    } else {
      storage.removeItem(key);
      writeIndex(storage, readIndex(storage).filter((id) => id !== serverId));
    }
  } catch {
    // Storage can be unavailable or quota-limited; route state remains usable.
  }
}
