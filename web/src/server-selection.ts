import { isWorkerSessionName } from './session-list-merge.js';
import { classifyServerPresence, SERVER_PRESENCE_STALENESS_MS } from '@shared/tab-sharing.js';

export { SERVER_PRESENCE_STALENESS_MS };

export interface SelectableServerInfo {
  id: string;
  name: string;
}

export interface OnlineServerInfo extends SelectableServerInfo {
  status: string;
  lastHeartbeatAt: number | null;
  statusObservedAt?: number | null;
  createdAt?: number;
}

export interface NamedSessionInfo {
  name: string;
}

export interface RecentSessionCandidate {
  serverId: string;
  sessionName: string;
  previewUpdatedAt?: number | null;
  isSubSession?: boolean | null;
}

export interface AutoEntrySelection {
  serverId: string;
  sessionName: string | null;
}

/** Resolve a remembered tab against the current server's navigable sessions. */
export function resolveServerSessionSnapshot(
  serverId: string,
  rememberedSession: string | null | undefined,
  candidates: readonly RecentSessionCandidate[],
  fallbackRememberedSession?: string | null,
): string | null {
  const serverCandidates = candidates.filter((candidate) => candidate.serverId === serverId);
  const isNavigable = (candidate: RecentSessionCandidate): boolean => (
    !candidate.isSubSession && !isWorkerSessionName(candidate.sessionName)
  );
  if (rememberedSession && serverCandidates.some((candidate) => (
    candidate.sessionName === rememberedSession && isNavigable(candidate)
  ))) {
    return rememberedSession;
  }
  if (fallbackRememberedSession && serverCandidates.some((candidate) => (
    candidate.sessionName === fallbackRememberedSession && isNavigable(candidate)
  ))) {
    return fallbackRememberedSession;
  }
  return pickMostRecentMainSession(serverCandidates)?.sessionName ?? null;
}

export function isServerOnline(
  server: Pick<OnlineServerInfo, 'status' | 'lastHeartbeatAt'> | null | undefined,
  now = Date.now(),
): boolean {
  return classifyServerPresence(server, now) === 'online';
}

export function hasSelectedServer(
  selectedServerId: string | null,
  servers: readonly SelectableServerInfo[],
): boolean {
  if (!selectedServerId) return false;
  return servers.some((server) => server.id === selectedServerId);
}

/** Refresh full-server data without dropping visited, still-shared navigation entries.
 * This list is not an ownership/coverage grant; callers keep that authority separate.
 */
export function mergeServerNavigation<T extends SelectableServerInfo>(
  incoming: readonly T[],
  previous: readonly T[],
  activeSharedServerIds: ReadonlySet<string>,
  options?: { requestStartedAt?: number },
): T[] {
  const previousMap = new Map(previous.map((server) => [server.id, server]));
  const mergedIncoming = incoming.map((server) => {
    const prev = previousMap.get(server.id);
    if (!prev) return server;

    const prevAny = prev as Record<string, unknown>;
    const currAny = server as Record<string, unknown>;

    // Explicit offline on incoming takes effect immediately.
    // If previous was explicitly offline with a local observed timestamp (e.g. from local disconnect),
    // retain statusObservedAt so subsequent in-flight responses sent before that disconnect cannot resurrect it.
    if (currAny.status === 'offline') {
      const prevObservedAt = typeof prevAny.statusObservedAt === 'number' ? prevAny.statusObservedAt : null;
      if (prevAny.status === 'offline' && prevObservedAt !== null && typeof currAny.statusObservedAt !== 'number') {
        return {
          ...server,
          statusObservedAt: prevObservedAt,
        };
      }
      return server;
    }

    const prevObservedAt = typeof prevAny.statusObservedAt === 'number' ? prevAny.statusObservedAt : null;
    const requestStartedAt = options?.requestStartedAt ?? null;

    // If previous was explicitly offline:
    // If a local offline event happened AFTER this REST request started, the incoming response
    // was in-flight while the offline event occurred (stale relative to the local event), so preserve offline!
    // But if the request started AFTER or at the local offline event, the REST response is authoritative
    // and recovers online with its server heartbeat (even if server pod clock lags behind browser).
    if (prevAny.status === 'offline') {
      if (requestStartedAt !== null && prevObservedAt !== null && requestStartedAt < prevObservedAt) {
        return prev;
      }
    }

    // Do not regress fresh live heartbeat with older REST timestamp, unless previous was offline
    const prevHb = typeof prevAny.lastHeartbeatAt === 'number' ? prevAny.lastHeartbeatAt : null;
    const currHb = typeof currAny.lastHeartbeatAt === 'number' ? currAny.lastHeartbeatAt : null;
    if (prevAny.status !== 'offline' && prevHb !== null && (currHb === null || prevHb > currHb)) {
      return {
        ...server,
        lastHeartbeatAt: prevHb,
      };
    }

    return server;
  });

  const ids = new Set(mergedIncoming.map((server) => server.id));
  return [...mergedIncoming, ...previous.filter((server) => {
    if (ids.has(server.id) || !activeSharedServerIds.has(server.id)) return false;
    ids.add(server.id);
    return true;
  })];
}

export function getSelectedServerName(
  selectedServerId: string | null,
  servers: readonly SelectableServerInfo[],
  fallbackName: string | null,
): string | null {
  if (!selectedServerId) return null;
  if (servers.length === 0) return fallbackName;
  return servers.find((server) => server.id === selectedServerId)?.name ?? null;
}

export function shouldResetSelectedServer(
  selectedServerId: string | null,
  servers: readonly SelectableServerInfo[],
  serversLoaded: boolean,
): boolean {
  if (!selectedServerId || !serversLoaded) return false;
  return !hasSelectedServer(selectedServerId, servers);
}

export function shouldShowInitialConnectingGate(
  authReady: boolean,
  selectedServerId: string | null,
  connected: boolean,
  sessionsLoaded: boolean,
): boolean {
  return Boolean(authReady && selectedServerId && !sessionsLoaded && !connected);
}

export function hasResolvedActiveSession(
  activeSession: string | null,
  sessions: readonly NamedSessionInfo[],
): boolean {
  if (!activeSession) return false;
  return sessions.some((session) => session.name === activeSession);
}

export function pickMostRecentMainSession(
  candidates: readonly RecentSessionCandidate[],
): AutoEntrySelection | null {
  const main = candidates.filter((candidate) =>
    !candidate.isSubSession && !isWorkerSessionName(candidate.sessionName),
  );
  if (main.length === 0) return null;
  const [best] = [...main].sort((a, b) => {
    const bTs = typeof b.previewUpdatedAt === 'number' ? b.previewUpdatedAt : -1;
    const aTs = typeof a.previewUpdatedAt === 'number' ? a.previewUpdatedAt : -1;
    if (bTs !== aTs) return bTs - aTs;
    return a.sessionName.localeCompare(b.sessionName);
  });
  return best ? { serverId: best.serverId, sessionName: best.sessionName } : null;
}

export function pickAutoEntryServer(
  servers: readonly OnlineServerInfo[],
  savedServerId?: string | null,
): AutoEntrySelection | null {
  if (servers.length === 0) return null;
  const saved = savedServerId ? servers.find((server) => server.id === savedServerId) : undefined;
  const selected = saved
    ?? [...servers].sort((a, b) => {
      const aOnline = isServerOnline(a) ? 1 : 0;
      const bOnline = isServerOnline(b) ? 1 : 0;
      if (bOnline !== aOnline) return bOnline - aOnline;
      const bCreated = typeof b.createdAt === 'number' ? b.createdAt : 0;
      const aCreated = typeof a.createdAt === 'number' ? a.createdAt : 0;
      if (bCreated !== aCreated) return bCreated - aCreated;
      return a.name.localeCompare(b.name);
    })[0];
  return selected ? { serverId: selected.id, sessionName: null } : null;
}

export type DaemonBadgeState = 'online' | 'connecting' | 'offline';

export function getDaemonBadgeState(
  connected: boolean,
  connecting: boolean,
  daemonOnline: boolean,
  selectedServer: Pick<OnlineServerInfo, 'status' | 'lastHeartbeatAt'> | null | undefined,
): DaemonBadgeState {
  if (connected) {
    return daemonOnline || isServerOnline(selectedServer) ? 'online' : 'offline';
  }
  return connecting ? 'connecting' : 'offline';
}
