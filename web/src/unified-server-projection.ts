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

function compareWholeServerGrants(a: SharedEntrySummary, b: SharedEntrySummary): number {
  const roleScore = (role: string) => (role === 'participant' ? 2 : 1);
  const scoreDiff = roleScore(b.role) - roleScore(a.role);
  if (scoreDiff !== 0) return scoreDiff;
  return a.id.localeCompare(b.id);
}

/**
 * Project a unified server list combining owned/opened servers with active whole-server shared entries.
 * Deduplicates by serverId: owned servers take precedence and never downgrade ownership.
 * Discovered shared entries without prior verified heartbeat default to online: false.
 */
export function projectUnifiedServerList<T extends OnlineServerInfo>(
  servers: readonly T[],
  sharedEntries: readonly SharedEntrySummary[],
  ownedServerIds: ReadonlySet<string>,
  serverOrder: readonly string[] = [],
  serverPinned: readonly string[] = [],
): UnifiedServerItem[] {
  // 1. Group active whole-server grants by serverId
  const activeServerGrants = sharedEntries.filter(
    (entry): entry is SharedEntrySummary & { target: { kind: 'server' } } =>
      entry.status === 'active' && entry.target.kind === 'server',
  );

  const grantsByServerId = new Map<string, SharedEntrySummary[]>();
  for (const grant of activeServerGrants) {
    const existing = grantsByServerId.get(grant.serverId);
    if (existing) {
      existing.push(grant);
    } else {
      grantsByServerId.set(grant.serverId, [grant]);
    }
  }

  const bestGrantByServerId = new Map<string, SharedEntrySummary>();
  for (const [serverId, list] of grantsByServerId.entries()) {
    list.sort(compareWholeServerGrants);
    bestGrantByServerId.set(serverId, list[0]);
  }

  const seenServerIds = new Set<string>();
  const unifiedItems: UnifiedServerItem[] = [];

  // 2. Existing servers in inventory
  for (const server of servers) {
    seenServerIds.add(server.id);
    const isOwned = ownedServerIds.has(server.id);
    const isSharedIn = !isOwned;
    const sharedEntry = isSharedIn ? bestGrantByServerId.get(server.id) : undefined;
    const displayName = (isSharedIn && sharedEntry?.targetLabel?.trim())
      ? sharedEntry.targetLabel.trim()
      : server.name;
    unifiedItems.push({
      id: server.id,
      name: displayName,
      status: server.status,
      lastHeartbeatAt: server.lastHeartbeatAt,
      daemonVersion: (server as { daemonVersion?: string | null }).daemonVersion,
      latestDaemonVersion: (server as { latestDaemonVersion?: string | null }).latestDaemonVersion,
      createdAt: server.createdAt,
      isSharedIn,
      sharedEntry,
      server: isOwned ? server : server,
      online: isServerOnline(server),
    });
  }

  // 3. Newly discovered whole-server shares not yet in servers inventory
  for (const [serverId, grant] of bestGrantByServerId.entries()) {
    if (seenServerIds.has(serverId) || ownedServerIds.has(serverId)) {
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
