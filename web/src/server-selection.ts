export interface SelectableServerInfo {
  id: string;
  name: string;
}

export interface OnlineServerInfo extends SelectableServerInfo {
  status: string;
  lastHeartbeatAt: number | null;
}

export interface NamedSessionInfo {
  name: string;
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
