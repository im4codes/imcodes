type ServerLike = {
  id: string;
  status: string;
  lastHeartbeatAt: number | null;
};

export function markServerLive<T extends ServerLike>(servers: T[], serverId: string | null | undefined, now = Date.now()): T[] {
  if (!serverId) return servers;
  return servers.map((server) => (
    server.id === serverId
      ? { ...server, status: 'online', lastHeartbeatAt: now }
      : server
  ));
}

export function markServerOffline<T extends ServerLike>(servers: T[], serverId: string | null | undefined): T[] {
  if (!serverId) return servers;
  return servers.map((server) => (
    server.id === serverId
      ? { ...server, status: 'offline' }
      : server
  ));
}

/**
 * Refresh `lastHeartbeatAt` without overriding an explicit offline status.
 * Used when a WS-level signal (e.g. pong) proves the server pod is reachable
 * but doesn't itself say anything new about daemon presence — we don't want
 * to re-online a server that was just marked offline by `MSG_DAEMON_OFFLINE`.
 */
export function touchServerHeartbeat<T extends ServerLike>(servers: T[], serverId: string | null | undefined, now = Date.now()): T[] {
  if (!serverId) return servers;
  return servers.map((server) => (
    server.id === serverId && server.status !== 'offline'
      ? { ...server, lastHeartbeatAt: now }
      : server
  ));
}
