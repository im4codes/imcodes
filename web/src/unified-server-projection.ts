import type { SharedEntrySummary } from './api.js';
import type { OnlineServerInfo } from './server-selection.js';
import { sortServersByPreference, type ServerOrderEntry } from './server-order.js';
import {
  classifyServerPresence,
  type SharedPresenceState,
  type SharedPresencePayload,
} from '@shared/tab-sharing.js';

export type { SharedPresenceState, SharedPresencePayload };
export { classifyServerPresence };

export interface UnifiedServerItem extends ServerOrderEntry {
  id: string;
  name: string;
  status: string;
  lastHeartbeatAt: number | null;
  daemonVersion?: string | null;
  latestDaemonVersion?: string | null;
  createdAt?: number;
  isSharedIn: boolean;
  sharedEntry?: SharedEntrySummary;
  server?: OnlineServerInfo;
  online: boolean;
  presence: SharedPresenceState;
}

export interface ServerPresenceObservation {
  status: string;
  lastHeartbeatAt: number | null;
  source: 'grant' | 'daemon' | 'pod-pong' | 'fallback';
}

/**
 * Coherently select the authoritative presence observation between a cached visited server
 * snapshot and an active shared grant.
 *
 * Rules:
 * 1. Status and heartbeat are kept TOGETHER as a coherent observation, never mixing
 *    an offline status from one source with a heartbeat timestamp from another.
 * 2. An authoritative DB grant presence wins over an older cached offline snapshot when
 *    grant.lastHeartbeatAt >= (server.lastHeartbeatAt ?? 0), permitting fresh recovery.
 * 3. WS pod-pong pings on visited servers are NOT daemon liveness and must not override
 *    authoritative DB grant presence.
 * 4. Newer genuine daemon disconnection / offline events from the visited session take
 *    precedence if their timestamp is strictly newer than the grant's heartbeat.
 * 5. If neither source carries a verified numeric heartbeat, the status falls back safely
 *    and classifies as 'unknown' rather than asserting offline.
 */
export function resolveCoherentPresenceObservation(
  server: OnlineServerInfo | null | undefined,
  grant: SharedEntrySummary | null | undefined,
): ServerPresenceObservation {
  const grantHeartbeat = typeof grant?.lastHeartbeatAt === 'number' && Number.isFinite(grant.lastHeartbeatAt) && grant.lastHeartbeatAt > 0
    ? grant.lastHeartbeatAt
    : null;
  const grantStatus = grant?.serverStatus ?? 'active';

  const serverHeartbeat = typeof server?.lastHeartbeatAt === 'number' && Number.isFinite(server.lastHeartbeatAt) && server.lastHeartbeatAt > 0
    ? server.lastHeartbeatAt
    : null;
  const serverStatus = server?.status ?? 'active';
  const serverIsPodPong = (server as { heartbeatSource?: string })?.heartbeatSource === 'pod-pong';

  // 1. Grant carries authoritative heartbeat from DB
  if (grantHeartbeat !== null) {
    if (serverIsPodPong || serverHeartbeat === null || grantHeartbeat >= serverHeartbeat) {
      return {
        status: grantStatus,
        lastHeartbeatAt: grantHeartbeat,
        source: 'grant',
      };
    }
    // Visited server has a newer genuine daemon event
    return {
      status: serverStatus,
      lastHeartbeatAt: serverHeartbeat,
      source: 'daemon',
    };
  }

  // 2. Grant has no heartbeat, but visited server has genuine daemon heartbeat
  if (serverHeartbeat !== null && !serverIsPodPong) {
    return {
      status: serverStatus,
      lastHeartbeatAt: serverHeartbeat,
      source: 'daemon',
    };
  }

  // 3. Neither carries an authoritative heartbeat (legacy peer or missing presence)
  return {
    status: grant?.serverStatus ?? server?.status ?? 'active',
    lastHeartbeatAt: null,
    source: 'fallback',
  };
}

export function getServerPresence(
  server: { status?: string | null; lastHeartbeatAt?: number | null; presence?: SharedPresenceState; heartbeatSource?: string | null } | null | undefined,
  now = Date.now(),
): SharedPresenceState {
  return classifyServerPresence(server, now);
}

function compareGrants(a: SharedEntrySummary, b: SharedEntrySummary): number {
  const kindScore = (kind: string) => (kind === 'server' ? 10 : 0);
  const roleScore = (role: string) => (role === 'participant' ? 2 : 1);
  const scoreA = kindScore(a.target.kind) + roleScore(a.role);
  const scoreB = kindScore(b.target.kind) + roleScore(b.role);
  if (scoreB !== scoreA) return scoreB - scoreA;
  return a.id.localeCompare(b.id);
}

/**
 * Project a unified server list combining owned/opened servers with active whole-server shared entries.
 * Deduplicates by serverId: owned servers take precedence and never downgrade ownership.
 * Non-owned servers in inventory retain their active shared grant to preserve scoped navigation proof.
 * Shared entries without prior verified heartbeat classify distinctly as presence: 'unknown'.
 */
export function projectUnifiedServerList<T extends OnlineServerInfo>(
  servers: readonly T[],
  sharedEntries: readonly SharedEntrySummary[],
  ownedServerIds: ReadonlySet<string>,
  serverOrder: readonly string[] = [],
  serverPinned: readonly string[] = [],
  now = Date.now(),
): UnifiedServerItem[] {
  // 1. Group active grants by serverId
  const activeGrants = sharedEntries.filter((entry) => entry.status === 'active');
  const grantsByServerId = new Map<string, SharedEntrySummary[]>();
  for (const grant of activeGrants) {
    const existing = grantsByServerId.get(grant.serverId);
    if (existing) {
      existing.push(grant);
    } else {
      grantsByServerId.set(grant.serverId, [grant]);
    }
  }

  const bestGrantByServerId = new Map<string, SharedEntrySummary>();
  for (const [serverId, list] of grantsByServerId.entries()) {
    list.sort(compareGrants);
    bestGrantByServerId.set(serverId, list[0]);
  }

  const seenServerIds = new Set<string>();
  const unifiedItems: UnifiedServerItem[] = [];

  // 2. Existing servers in inventory
  for (const server of servers) {
    const isOwned = ownedServerIds.has(server.id);
    if (isOwned) {
      seenServerIds.add(server.id);
      const presence = classifyServerPresence(server, now);
      unifiedItems.push({
        id: server.id,
        name: server.name,
        status: server.status,
        lastHeartbeatAt: server.lastHeartbeatAt,
        daemonVersion: (server as { daemonVersion?: string | null }).daemonVersion,
        latestDaemonVersion: (server as { latestDaemonVersion?: string | null }).latestDaemonVersion,
        createdAt: server.createdAt,
        isSharedIn: false,
        sharedEntry: undefined,
        server,
        presence,
        online: presence === 'online',
      });
    } else {
      // Non-owned server in inventory: only project if an active grant exists,
      // and carry its exact grant to preserve recheckable scoped share authority.
      const grant = bestGrantByServerId.get(server.id);
      if (grant) {
        seenServerIds.add(server.id);
        const displayName = (grant.target.kind === 'server' && grant.targetLabel && grant.targetLabel.trim())
          ? grant.targetLabel.trim()
          : (server.name || grant.serverName);

        const observation = resolveCoherentPresenceObservation(server, grant);
        const presence = classifyServerPresence(observation, now);

        unifiedItems.push({
          id: server.id,
          name: displayName,
          status: observation.status,
          lastHeartbeatAt: observation.lastHeartbeatAt,
          daemonVersion: (server as { daemonVersion?: string | null }).daemonVersion,
          latestDaemonVersion: (server as { latestDaemonVersion?: string | null }).latestDaemonVersion,
          createdAt: server.createdAt,
          isSharedIn: true,
          sharedEntry: grant,
          server: {
            ...server,
            status: observation.status,
            lastHeartbeatAt: observation.lastHeartbeatAt,
          },
          presence,
          online: presence === 'online',
        });
      }
    }
  }

  // 3. Newly discovered whole-server shares not yet in servers inventory
  for (const [serverId, grant] of bestGrantByServerId.entries()) {
    if (grant.target.kind !== 'server' || seenServerIds.has(serverId) || ownedServerIds.has(serverId)) {
      continue;
    }
    seenServerIds.add(serverId);
    const displayName = (grant.targetLabel && grant.targetLabel.trim())
      ? grant.targetLabel.trim()
      : grant.serverName;

    const observation = resolveCoherentPresenceObservation(null, grant);
    const presence = classifyServerPresence(observation, now);

    unifiedItems.push({
      id: grant.serverId,
      name: displayName,
      status: observation.status,
      lastHeartbeatAt: observation.lastHeartbeatAt,
      isSharedIn: true,
      sharedEntry: grant,
      presence,
      online: presence === 'online',
    });
  }

  // 4. Stable order respecting user preferences (pinned servers first, then order, then unranked)
  return sortServersByPreference(unifiedItems, serverOrder, serverPinned);
}

/**
 * Filter shared entries to only those that are NOT whole-server shares,
 * preserving restricted tab and subsession shares (e.g. university, jdzs, zhilan)
 * for the dedicated shared entries panel.
 */
export function filterRestrictedSharedEntries(
  sharedEntries: readonly SharedEntrySummary[],
): SharedEntrySummary[] {
  return sharedEntries.filter((entry) => entry.target.kind !== 'server');
}
