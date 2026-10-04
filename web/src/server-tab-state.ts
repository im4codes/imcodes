/** Device-local tab snapshot helpers.  Server ids are part of the key so a
 * session/tab from one server can never become the default for another. */
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
    return value && value.length <= 1_024 ? value : null;
  } catch {
    return null;
  }
}

export function writeServerSession(serverId: string, sessionName: string | null, storage: Storage = localStorage): void {
  if (!serverId) return;
  try {
    const key = serverSessionStorageKey(serverId);
    if (sessionName && sessionName.length <= 1_024) storage.setItem(key, sessionName);
    else storage.removeItem(key);
  } catch {
    // Storage can be unavailable or quota-limited; route state remains usable.
  }
}
