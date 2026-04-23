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
