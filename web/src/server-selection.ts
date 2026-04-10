export interface SelectableServerInfo {
  id: string;
  name: string;
}

export interface NamedSessionInfo {
  name: string;
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
