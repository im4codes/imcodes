import { describe, expect, it } from 'vitest';
import type { SharedEntrySummary } from '../src/api.js';
import type { OnlineServerInfo } from '../src/server-selection.js';
import {
  projectUnifiedServerList,
  filterRestrictedSharedEntries,
} from '../src/unified-server-projection.js';

describe('projectUnifiedServerList', () => {
  const baseTimestamp = 1_700_000_000_000;

  const mockOwnedServer1: OnlineServerInfo = {
    id: 'server-owned-1',
    name: 'My Primary Server',
    status: 'online',
    lastHeartbeatAt: Date.now(),
    createdAt: baseTimestamp,
  };

  const mockOwnedServer2: OnlineServerInfo = {
    id: 'server-owned-2',
    name: 'Backup Node',
    status: 'online',
    lastHeartbeatAt: Date.now(),
    createdAt: baseTimestamp + 1000,
  };

  it('keeps owned servers in list with isSharedIn: false and preserves online status', () => {
    const ownedIds = new Set(['server-owned-1', 'server-owned-2']);
    const result = projectUnifiedServerList(
      [mockOwnedServer1, mockOwnedServer2],
      [],
      ownedIds,
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: 'server-owned-1',
      name: 'My Primary Server',
      isSharedIn: false,
      online: true,
      sharedEntry: undefined,
    });
    expect(result[0].server).toBe(mockOwnedServer1);
    expect(result[1]).toMatchObject({
      id: 'server-owned-2',
      name: 'Backup Node',
      isSharedIn: false,
      online: true,
      sharedEntry: undefined,
    });
    expect(result[1].server).toBe(mockOwnedServer2);
  });

  it('projects active whole-server shares into unified list with isSharedIn: true and online: false', () => {
    const ownedIds = new Set(['server-owned-1']);
    const sharedEntry: SharedEntrySummary = {
      id: 'share-grant-1',
      serverId: 'server-shared-remote',
      serverName: 'Remote Team Server',
      role: 'participant',
      status: 'active',
      target: { kind: 'server', serverId: 'server-shared-remote' },
      targetLabel: 'Remote Team Server',
    };

    const result = projectUnifiedServerList(
      [mockOwnedServer1],
      [sharedEntry],
      ownedIds,
    );

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('server-owned-1');
    expect(result[0].isSharedIn).toBe(false);

    expect(result[1]).toMatchObject({
      id: 'server-shared-remote',
      name: 'Remote Team Server',
      isSharedIn: true,
      online: false, // Unknown discovery heartbeat must not fake green dot
      sharedEntry,
    });
    expect(result[1].server).toBeUndefined();
  });

  it('gives ownership precedence when the same serverId is both owned and received as a share', () => {
    const ownedIds = new Set(['server-owned-1']);
    const selfShareEntry: SharedEntrySummary = {
      id: 'share-grant-self',
      serverId: 'server-owned-1',
      serverName: 'Server 1 Share Alias',
      role: 'viewer',
      status: 'active',
      target: { kind: 'server', serverId: 'server-owned-1' },
      targetLabel: 'Server 1',
    };

    const result = projectUnifiedServerList(
      [mockOwnedServer1],
      [selfShareEntry],
      ownedIds,
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('server-owned-1');
    expect(result[0].name).toBe('My Primary Server');
    // Ownership is never downgraded:
    expect(result[0].isSharedIn).toBe(false);
    expect(result[0].sharedEntry).toBeUndefined();
  });

  it('stably prioritizes participant grant over viewer grant when multiple grants exist for same server', () => {
    const ownedIds = new Set<string>();
    const viewerGrant: SharedEntrySummary = {
      id: 'share-grant-v',
      serverId: 'server-multi-grant',
      serverName: 'Multi Grant Server',
      role: 'viewer',
      status: 'active',
      target: { kind: 'server', serverId: 'server-multi-grant' },
      targetLabel: 'Viewer Grant',
    };
    const participantGrant: SharedEntrySummary = {
      id: 'share-grant-p',
      serverId: 'server-multi-grant',
      serverName: 'Multi Grant Server',
      role: 'participant',
      status: 'active',
      target: { kind: 'server', serverId: 'server-multi-grant' },
      targetLabel: 'Participant Grant',
    };

    const result = projectUnifiedServerList(
      [],
      [viewerGrant, participantGrant],
      ownedIds,
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('server-multi-grant');
    expect(result[0].isSharedIn).toBe(true);
    expect(result[0].sharedEntry?.id).toBe('share-grant-p');
    expect(result[0].sharedEntry?.role).toBe('participant');
  });

  it('stably breaks ties by grant id when multiple grants have identical roles', () => {
    const ownedIds = new Set<string>();
    const grantA: SharedEntrySummary = {
      id: 'grant-aaa',
      serverId: 'server-tie',
      serverName: 'Tie Server',
      role: 'viewer',
      status: 'active',
      target: { kind: 'server', serverId: 'server-tie' },
      targetLabel: 'Tie A',
    };
    const grantB: SharedEntrySummary = {
      id: 'grant-bbb',
      serverId: 'server-tie',
      serverName: 'Tie Server',
      role: 'viewer',
      status: 'active',
      target: { kind: 'server', serverId: 'server-tie' },
      targetLabel: 'Tie B',
    };

    // Regardless of insertion order, grant-aaa wins
    const result1 = projectUnifiedServerList([], [grantB, grantA], ownedIds);
    expect(result1[0].sharedEntry?.id).toBe('grant-aaa');

    const result2 = projectUnifiedServerList([], [grantA, grantB], ownedIds);
    expect(result2[0].sharedEntry?.id).toBe('grant-aaa');
  });

  it('ignores revoked, expired, or unavailable shares', () => {
    const ownedIds = new Set<string>();
    const revokedGrant: SharedEntrySummary = {
      id: 'grant-revoked',
      serverId: 'server-revoked',
      serverName: 'Revoked Server',
      role: 'participant',
      status: 'revoked',
      target: { kind: 'server', serverId: 'server-revoked' },
      targetLabel: 'Revoked',
    };
    const expiredGrant: SharedEntrySummary = {
      id: 'grant-expired',
      serverId: 'server-expired',
      serverName: 'Expired Server',
      role: 'participant',
      status: 'expired',
      target: { kind: 'server', serverId: 'server-expired' },
      targetLabel: 'Expired',
    };
    const activeGrant: SharedEntrySummary = {
      id: 'grant-active',
      serverId: 'server-active',
      serverName: 'Active Server',
      role: 'participant',
      status: 'active',
      target: { kind: 'server', serverId: 'server-active' },
      targetLabel: 'Active',
    };

    const result = projectUnifiedServerList(
      [],
      [revokedGrant, expiredGrant, activeGrant],
      ownedIds,
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('server-active');
  });

  it('does not project restricted tab/subsession shares into the whole-server list', () => {
    const ownedIds = new Set<string>();
    const tabShare: SharedEntrySummary = {
      id: 'share-tab-univ',
      serverId: 'server-restricted',
      serverName: 'University Machine',
      role: 'viewer',
      status: 'active',
      target: { kind: 'main', serverId: 'server-restricted', sessionName: 'university' },
      targetLabel: 'university',
    };
    const subShare: SharedEntrySummary = {
      id: 'share-sub-jdzs',
      serverId: 'server-restricted',
      serverName: 'University Machine',
      role: 'participant',
      status: 'active',
      target: { kind: 'subsession', serverId: 'server-restricted', sessionName: 'deck_sub_jdzs', subSessionId: 'jdzs' },
      targetLabel: 'jdzs',
    };

    const result = projectUnifiedServerList([], [tabShare, subShare], ownedIds);
    expect(result).toHaveLength(0);
  });

  it('retains visited unowned servers with their active scoped grant, and excludes them once the grant is revoked', () => {
    const ownedIds = new Set(['server-owned-1']);
    const visitedTabServer: OnlineServerInfo = {
      id: 'server-restricted-visited',
      name: 'Restricted Tab Machine',
      status: 'online',
      lastHeartbeatAt: Date.now(),
      createdAt: baseTimestamp + 3000,
    };
    const tabShare: SharedEntrySummary = {
      id: 'share-tab-scoped',
      serverId: 'server-restricted-visited',
      serverName: 'Restricted Tab Machine',
      role: 'viewer',
      status: 'active',
      target: { kind: 'main', serverId: 'server-restricted-visited', sessionName: 'deck_tab' },
      targetLabel: 'Restricted Tab',
    };
    // With active grant: retained with isSharedIn: true and its active sharedEntry
    const withGrant = projectUnifiedServerList(
      [mockOwnedServer1, visitedTabServer],
      [tabShare],
      ownedIds,
    );
    expect(withGrant).toHaveLength(2);
    const projectedVisited = withGrant.find((s) => s.id === 'server-restricted-visited')!;
    expect(projectedVisited.isSharedIn).toBe(true);
    expect(projectedVisited.name).toBe('Restricted Tab Machine');
    expect(projectedVisited.sharedEntry).toEqual(tabShare);

    // Once grant is revoked (not in active sharedEntries): visited unowned server is excluded
    const withoutGrant = projectUnifiedServerList(
      [mockOwnedServer1, visitedTabServer],
      [],
      ownedIds,
    );
    expect(withoutGrant).toHaveLength(1);
    expect(withoutGrant[0].id).toBe('server-owned-1');
  });

  it('marks previously opened shared servers in inventory with isSharedIn: true and real heartbeat', () => {
    const ownedIds = new Set(['server-owned-1']); // server-shared-visited is NOT in ownedIds
    const visitedSharedServer: OnlineServerInfo = {
      id: 'server-shared-visited',
      name: 'Opened Remote Server',
      status: 'online',
      lastHeartbeatAt: Date.now(), // verified heartbeat from opened server
      createdAt: baseTimestamp + 5000,
    };
    const activeGrant: SharedEntrySummary = {
      id: 'grant-visited',
      serverId: 'server-shared-visited',
      serverName: 'Opened Remote Server',
      role: 'participant',
      status: 'active',
      target: { kind: 'server', serverId: 'server-shared-visited' },
      targetLabel: 'Opened Remote Server',
    };

    const result = projectUnifiedServerList(
      [mockOwnedServer1, visitedSharedServer],
      [activeGrant],
      ownedIds,
    );

    expect(result).toHaveLength(2);
    const sharedItem = result.find((item) => item.id === 'server-shared-visited');
    expect(sharedItem).toBeDefined();
    expect(sharedItem!.isSharedIn).toBe(true);
    expect(sharedItem!.online).toBe(true); // Has real heartbeat
    expect(sharedItem!.sharedEntry?.id).toBe('grant-visited');
  });

  it('respects pinned servers preference placing pinned servers first', () => {
    const ownedIds = new Set(['server-owned-1', 'server-owned-2']);
    const sharedEntry: SharedEntrySummary = {
      id: 'grant-shared',
      serverId: 'server-shared-pin',
      serverName: 'Shared Pinned Server',
      role: 'participant',
      status: 'active',
      target: { kind: 'server', serverId: 'server-shared-pin' },
      targetLabel: 'Shared Pinned',
    };

    // Pin the shared server first
    const result = projectUnifiedServerList(
      [mockOwnedServer1, mockOwnedServer2],
      [sharedEntry],
      ownedIds,
      ['server-owned-1', 'server-owned-2', 'server-shared-pin'],
      ['server-shared-pin'],
    );

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('server-shared-pin');
    expect(result[0].isSharedIn).toBe(true);
    expect(result[1].id).toBe('server-owned-1');
    expect(result[2].id).toBe('server-owned-2');
  });

  it('projects discovered whole-server share as online: true when grant carries fresh authoritative heartbeat (<60s)', () => {
    const ownedIds = new Set(['server-owned-1']);
    const now = Date.now();
    const freshSharedEntry: SharedEntrySummary = {
      id: 'grant-shared-online',
      serverId: 'server-ai-207',
      serverName: 'ai-207',
      role: 'participant',
      status: 'active',
      target: { kind: 'server', serverId: 'server-ai-207' },
      targetLabel: 'ai-207',
      serverStatus: 'online',
      lastHeartbeatAt: now - 5_000,
    };

    const result = projectUnifiedServerList(
      [mockOwnedServer1],
      [freshSharedEntry],
      ownedIds,
    );

    expect(result).toHaveLength(2);
    const item = result.find((s) => s.id === 'server-ai-207')!;
    expect(item).toBeDefined();
    expect(item.isSharedIn).toBe(true);
    expect(item.online).toBe(true);
    expect(item.lastHeartbeatAt).toBe(now - 5_000);
  });

  it('projects discovered whole-server share as online: false when grant heartbeat is stale or serverStatus is offline', () => {
    const ownedIds = new Set(['server-owned-1']);
    const now = Date.now();
    const staleSharedEntry: SharedEntrySummary = {
      id: 'grant-stale',
      serverId: 'server-ai-208',
      serverName: 'ai-208',
      role: 'participant',
      status: 'active',
      target: { kind: 'server', serverId: 'server-ai-208' },
      targetLabel: 'ai-208',
      serverStatus: 'online',
      lastHeartbeatAt: now - 70_000,
    };
    const offlineSharedEntry: SharedEntrySummary = {
      id: 'grant-offline',
      serverId: 'server-ai-209',
      serverName: 'ai-209',
      role: 'participant',
      status: 'active',
      target: { kind: 'server', serverId: 'server-ai-209' },
      targetLabel: 'ai-209',
      serverStatus: 'offline',
      lastHeartbeatAt: now - 1_000,
    };

    const result = projectUnifiedServerList(
      [mockOwnedServer1],
      [staleSharedEntry, offlineSharedEntry],
      ownedIds,
    );

    const staleItem = result.find((s) => s.id === 'server-ai-208')!;
    expect(staleItem.online).toBe(false);

    const offlineItem = result.find((s) => s.id === 'server-ai-209')!;
    expect(offlineItem.online).toBe(false);
  });

  it('visited shared server left for >60s stays online when active grant provides fresh heartbeat, and follows online -> offline -> recovery', () => {
    const ownedIds = new Set(['server-owned-1']);
    const now = Date.now();
    const visitedSharedServer = {
      id: 'server-visited-shared',
      name: 'Visited Server',
      status: 'online',
      lastHeartbeatAt: now - 120_000, // 2 minutes ago — stale snapshot in inventory
    };

    // 1. Fresh grant heartbeat keeps it online
    const freshGrant: SharedEntrySummary = {
      id: 'grant-visited',
      serverId: 'server-visited-shared',
      serverName: 'Visited Server',
      role: 'participant',
      status: 'active',
      target: { kind: 'server', serverId: 'server-visited-shared' },
      targetLabel: 'Visited Server',
      serverStatus: 'online',
      lastHeartbeatAt: now - 5_000,
    };

    let result = projectUnifiedServerList(
      [mockOwnedServer1, visitedSharedServer],
      [freshGrant],
      ownedIds,
    );
    let item = result.find((s) => s.id === 'server-visited-shared')!;
    expect(item.online).toBe(true);
    expect(item.lastHeartbeatAt).toBe(now - 5_000);

    // 2. Grant heartbeat becomes stale -> turns offline
    const staleGrant: SharedEntrySummary = {
      ...freshGrant,
      lastHeartbeatAt: now - 80_000,
    };
    result = projectUnifiedServerList(
      [mockOwnedServer1, visitedSharedServer],
      [staleGrant],
      ownedIds,
    );
    item = result.find((s) => s.id === 'server-visited-shared')!;
    expect(item.online).toBe(false);

    // 3. Grant receives recovery heartbeat -> returns online
    const recoveredGrant: SharedEntrySummary = {
      ...freshGrant,
      lastHeartbeatAt: now - 2_000,
    };
    result = projectUnifiedServerList(
      [mockOwnedServer1, visitedSharedServer],
      [recoveredGrant],
      ownedIds,
    );
    item = result.find((s) => s.id === 'server-visited-shared')!;
    expect(item.online).toBe(true);
    expect(item.lastHeartbeatAt).toBe(now - 2_000);
  });
});

describe('filterRestrictedSharedEntries', () => {
  it('filters out whole-server shares and keeps tab and subsession entries', () => {
    const entries: SharedEntrySummary[] = [
      {
        id: '1',
        serverId: 's1',
        serverName: 'Server 1',
        role: 'participant',
        status: 'active',
        target: { kind: 'server', serverId: 's1' },
        targetLabel: 'Full Server 1',
      },
      {
        id: '2',
        serverId: 's2',
        serverName: 'Server 2',
        role: 'viewer',
        status: 'active',
        target: { kind: 'main', serverId: 's2', sessionName: 'university' },
        targetLabel: 'university',
      },
      {
        id: '3',
        serverId: 's2',
        serverName: 'Server 2',
        role: 'participant',
        status: 'active',
        target: { kind: 'subsession', serverId: 's2', sessionName: 'deck_sub_jdzs', subSessionId: 'jdzs' },
        targetLabel: 'jdzs',
      },
      {
        id: '4',
        serverId: 's3',
        serverName: 'Server 3',
        role: 'viewer',
        status: 'active',
        target: { kind: 'subsession', serverId: 's3', sessionName: 'deck_sub_zhilan', subSessionId: 'zhilan' },
        targetLabel: 'zhilan',
      },
    ];

    const restricted = filterRestrictedSharedEntries(entries);
    expect(restricted).toHaveLength(3);
    expect(restricted.map((r) => r.targetLabel)).toEqual(['university', 'jdzs', 'zhilan']);
  });
});
