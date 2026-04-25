export interface SelectableServerInfo {
  id: string;
  name: string;
}

export interface OnlineServerInfo extends SelectableServerInfo {
  status: string;
  lastHeartbeatAt: number | null;
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

export function isServerOnline(server: Pick<OnlineServerInfo, 'status' | 'lastHeartbeatAt'> | null | undefined): boolean {
  if (!server) return false;
  if (server.status === 'offline') return false;
  if (!server.lastHeartbeatAt) return false;
  return Date.now() - server.lastHeartbeatAt < 60_000;
}

export function hasSelectedServer(
  selectedServerId: string | null,
  servers: readonly SelectableServerInfo[],
): boolean {
  if (!selectedServerId) return false;
  return servers.some((server) => server.id === selectedServerId);
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
  const main = candidates.filter((candidate) => !candidate.isSubSession);
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
