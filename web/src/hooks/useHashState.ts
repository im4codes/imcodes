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
 * sessionStorage preserves the route across reloads in this tab. localStorage
 * remains a last-resort fallback for a new tab with no explicit route.
 */

export interface HashState {
  serverId: string | null;
  sessionName: string | null;
  sharedEntryId: string | null;
}

const TAB_ROUTE_STORAGE_KEY = 'rcc_tab_route_v1';

interface StoredTabRoute extends HashState {
  version: 1;
}

function isStoredRouteString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function readTabRouteState(): HashState {
  try {
    const raw = sessionStorage.getItem(TAB_ROUTE_STORAGE_KEY);
    if (!raw) return { serverId: null, sessionName: null, sharedEntryId: null };
    const parsed = JSON.parse(raw) as Partial<StoredTabRoute>;
    if (parsed.version !== 1 || !isStoredRouteString(parsed.serverId, 512)) {
      return { serverId: null, sessionName: null, sharedEntryId: null };
    }
    return {
      serverId: parsed.serverId,
      sessionName: isStoredRouteString(parsed.sessionName, 1_024) ? parsed.sessionName : null,
      sharedEntryId: isStoredRouteString(parsed.sharedEntryId, 512) ? parsed.sharedEntryId : null,
    };
  } catch {
    return { serverId: null, sessionName: null, sharedEntryId: null };
  }
}

function writeTabRouteState(state: HashState): void {
  try {
    if (!state.serverId) {
      sessionStorage.removeItem(TAB_ROUTE_STORAGE_KEY);
      return;
    }
    const stored: StoredTabRoute = { version: 1, ...state };
    sessionStorage.setItem(TAB_ROUTE_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Browsing can continue from the URL when tab storage is unavailable.
  }
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
  writeTabRouteState({ serverId, sessionName, sharedEntryId });
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
 * Resolve one coherent route for this browser tab. Never combine a server from
 * the URL with a session last written by another tab through localStorage.
 */
export function resolveInitialRouteState(): HashState {
  const fromHash = readHashState();
  if (fromHash.serverId) return fromHash;

  const fromTab = readTabRouteState();
  if (fromTab.serverId) return fromTab;

  return {
    serverId: localStorage.getItem('rcc_server'),
    sessionName: localStorage.getItem('rcc_session'),
    sharedEntryId: null,
  };
}

/**
 * Resolve initial server ID from the coherent tab route.
 */
export function resolveInitialServerId(): string | null {
  return resolveInitialRouteState().serverId;
}

/**
 * Resolve initial session name from the coherent tab route.
 */
export function resolveInitialSessionName(): string | null {
  return resolveInitialRouteState().sessionName;
}
