import type { SharedEntrySummary } from './api.js';
import { isServerOnline, type OnlineServerInfo } from './server-selection.js';
import { sortServersByPreference, type ServerOrderEntry } from './server-order.js';

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
 * Discovered whole-server shared entries without prior verified heartbeat default to online: false.
 */
export function projectUnifiedServerList<T extends OnlineServerInfo>(
  servers: readonly T[],
  sharedEntries: readonly SharedEntrySummary[],
  ownedServerIds: ReadonlySet<string>,
  serverOrder: readonly string[] = [],
  serverPinned: readonly string[] = [],
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
        online: isServerOnline(server),
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
        unifiedItems.push({
          id: server.id,
          name: displayName,
          status: server.status,
          lastHeartbeatAt: server.lastHeartbeatAt,
          daemonVersion: (server as { daemonVersion?: string | null }).daemonVersion,
          latestDaemonVersion: (server as { latestDaemonVersion?: string | null }).latestDaemonVersion,
          createdAt: server.createdAt,
          isSharedIn: true,
          sharedEntry: grant,
          online: isServerOnline(server),
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
    unifiedItems.push({
      id: grant.serverId,
      name: displayName,
      status: 'active',
      lastHeartbeatAt: null,
      isSharedIn: true,
      sharedEntry: grant,
      online: false, // Unknown heartbeat, do not fake green dot
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
