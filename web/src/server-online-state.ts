type ServerLike = {
  id: string;
  status: string;
  lastHeartbeatAt: number | null;
  statusObservedAt?: number | null;
};

export function markServerLive<T extends ServerLike>(servers: T[], serverId: string | null | undefined, now = Date.now()): T[] {
  if (!serverId) return servers;
  return servers.map((server) => (
    server.id === serverId
      ? { ...server, status: 'online', lastHeartbeatAt: now, statusObservedAt: now }
      : server
  ));
}

export function markServerOffline<T extends ServerLike>(servers: T[], serverId: string | null | undefined, now = Date.now()): T[] {
  if (!serverId) return servers;
  return servers.map((server) => (
    server.id === serverId
      ? { ...server, status: 'offline', statusObservedAt: now }
      : server
  ));
}

/**
 * A daemon-origin message proves the daemon is alive, not merely that the
 * browser can reach the server pod. Use this for `session_list`,
 * `daemon.online`, `daemon.reconnected`, and `daemon.stats`.
 */
export function markServerDaemonActivity<T extends ServerLike>(servers: T[], serverId: string | null | undefined, now = Date.now()): T[] {
  return markServerLive(servers, serverId, now);
}

export const SERVER_HEARTBEAT_TOUCH_MIN_INTERVAL_MS = 20_000;

/**
 * Refresh `lastHeartbeatAt` without overriding an explicit offline status.
 * Used when a WS-level signal (e.g. pong) proves the server pod is reachable
 * but doesn't itself say anything new about daemon presence — we don't want
 * to re-online a server that was just marked offline by `MSG_DAEMON_OFFLINE`.
 *
 * When `minIntervalMs > 0` and the target server already has a recent
 * `lastHeartbeatAt` within that window, returns the original `servers` array
 * reference so React/Preact state setters bail out without re-rendering.
 */
export function touchServerHeartbeat<T extends ServerLike>(
  servers: T[],
  serverId: string | null | undefined,
  now = Date.now(),
  minIntervalMs = 0,
): T[] {
  if (!serverId) return servers;
  let changed = false;
  const next = servers.map((server) => {
    if (server.id !== serverId || server.status === 'offline') return server;
    if (
      minIntervalMs > 0
      && server.lastHeartbeatAt !== null
      && now - server.lastHeartbeatAt >= 0
      && now - server.lastHeartbeatAt < minIntervalMs
    ) {
      return server;
    }
    changed = true;
    return { ...server, lastHeartbeatAt: now };
  });
  return changed ? next : servers;
}
