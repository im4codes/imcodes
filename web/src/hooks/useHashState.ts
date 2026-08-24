/**
 * Hash-based URL state for server and session selection.
 *
 * Format: #/{serverId}  or  #/{serverId}/{sessionName}
 * Shared entries add a tab-local discriminator:
 * #/{serverId}/{sessionName}?shared={shareEntryId}
 *
 * Each browser tab can independently track its own server+session via the URL hash,
 * so multiple tabs no longer collide through shared localStorage.
 *
 * localStorage remains the fallback when no hash is present (e.g. first visit, bookmarks).
 */

export interface HashState {
  serverId: string | null;
  sessionName: string | null;
  sharedEntryId: string | null;
}

export function readHashState(): HashState {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!raw) return { serverId: null, sessionName: null, sharedEntryId: null };
  const queryIndex = raw.indexOf('?');
  const path = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  const query = queryIndex >= 0 ? raw.slice(queryIndex + 1) : '';
  const parts = path.split('/');
  try {
    const serverId = decodeURIComponent(parts[0] || '') || null;
    const sessionName = parts.length > 1 ? decodeURIComponent(parts[1]) || null : null;
    const rawSharedEntryId = new URLSearchParams(query).get('shared');
    const sharedEntryId = rawSharedEntryId
      && rawSharedEntryId.length <= 512
      && !/[\u0000-\u001f\u007f]/.test(rawSharedEntryId)
      ? rawSharedEntryId
      : null;
    return { serverId, sessionName, sharedEntryId };
  } catch {
    return { serverId: null, sessionName: null, sharedEntryId: null };
  }
}

export function writeHashState(
  serverId: string | null,
  sessionName: string | null,
  sharedEntryId: string | null = null,
): void {
  let hash = '';
  if (serverId) {
    hash = `#/${encodeURIComponent(serverId)}`;
    if (sessionName) {
      hash += `/${encodeURIComponent(sessionName)}`;
    }
    if (sharedEntryId) {
      hash += `?${new URLSearchParams({ shared: sharedEntryId }).toString()}`;
    }
  }
  // Use replaceState to avoid polluting browser history with every session switch
  if (window.location.hash !== hash) {
    history.replaceState(null, '', hash || window.location.pathname + window.location.search);
  }
}

/**
 * Resolve initial server ID: hash takes priority, then localStorage fallback.
 */
export function resolveInitialServerId(): string | null {
  const fromHash = readHashState().serverId;
  if (fromHash) return fromHash;
  return localStorage.getItem('rcc_server');
}

/**
 * Resolve initial session name: hash takes priority, then localStorage fallback.
 */
export function resolveInitialSessionName(): string | null {
  const fromHash = readHashState().sessionName;
  if (fromHash) return fromHash;
  return localStorage.getItem('rcc_session');
}
