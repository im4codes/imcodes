import { describe, expect, it } from 'vitest';
import type { SharedEntrySummary } from '../src/api.js';
import type { SubSession } from '../src/hooks/useSubSessions.js';
import type { SessionInfo } from '../src/types.js';
import {
  buildSharedServerSubSessionStates,
  findSharedEntryForServerSubSession,
  findSharedEntryForServerTab,
  getDirectSharedSubSessions,
  mergeSharedServerSessions,
  mergeSharedServerSubSessions,
  resolvePreferredSharedEntryForServer,
  resolveRestrictedSubSessionClick,
} from '../src/shared-server-tabs.js';

function makeMainEntry(overrides: Partial<SharedEntrySummary> & { id: string; sessionName: string }): SharedEntrySummary {
  const { id, sessionName, ...rest } = overrides;
  return {
    id,
    serverId: 'srv-shared',
    serverName: 'Shared Server',
    role: 'viewer',
    status: 'active',
    target: { kind: 'main', serverId: 'srv-shared', sessionName },
    targetLabel: sessionName,
    ...rest,
  };
}

function makeSubEntry(overrides: Partial<SharedEntrySummary> & { id: string; subSessionId: string }): SharedEntrySummary {
  const { id, subSessionId, ...rest } = overrides;
  return {
    id,
    serverId: 'srv-shared',
    serverName: 'Shared Server',
    role: 'viewer',
    status: 'active',
    target: { kind: 'subsession', serverId: 'srv-shared', subSessionId },
    targetLabel: `Sub ${subSessionId}`,
    ...rest,
  };
}

function makeSubSession(id: string, parentSession: string | null): SubSession {
  return {
    id,
    serverId: 'srv-shared',
    type: 'shell',
    runtimeType: 'process',
    providerId: null,
    providerSessionId: null,
    shellBin: null,
    cwd: null,
    label: `Sub ${id}`,
    closedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ccSessionId: null,
    geminiSessionId: null,
    parentSession,
    description: null,
    ccPresetId: null,
    supervisionMode: null,
    sessionName: `deck_sub_${id}`,
    state: 'idle',
  };
}

describe('shared-server-tabs projection & routing', () => {
  it('merges all active sibling main shares on a non-owned server and preserves them across narrow live updates', () => {
    const entryA = makeMainEntry({
      id: 'g-a',
      sessionName: 'deck_projA_brain',
      role: 'participant',
      targetLabel: 'Project A',
      sessionState: 'running',
      agentType: 'claude-code',
    });
    const entryB = makeMainEntry({
      id: 'g-b',
      sessionName: 'deck_projB_brain',
      role: 'viewer',
      targetLabel: 'Project B',
      sessionState: 'idle',
      agentType: 'codex-sdk',
    });
    const entryC = makeMainEntry({
      id: 'g-c',
      sessionName: 'deck_projC_brain',
      role: 'viewer',
      targetLabel: 'Project C',
    });

    const liveA: SessionInfo = {
      name: 'deck_projA_brain',
      project: 'projA',
      role: 'brain',
      agentType: 'claude-code',
      state: 'running',
      label: 'Project A Live',
      sharedState: {
        targetKind: 'main',
        effectiveRole: 'participant',
        status: 'active',
        scopeLabel: 'Project A',
      },
    };
    const cachedB: SessionInfo = {
      name: 'deck_projB_brain',
      project: 'projB',
      role: 'brain',
      agentType: 'codex-sdk',
      state: 'idle',
      label: 'Project B Cached',
    };

    const merged = mergeSharedServerSessions({
      serverId: 'srv-shared',
      isOwnedServer: false,
      activeTarget: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_projA_brain' },
      sharedEntries: [entryA, entryB, entryC],
      liveSessions: [liveA],
      cachedSessions: new Map([[cachedB.name, cachedB]]),
    });

    expect(merged.map((s) => s.name)).toEqual([
      'deck_projA_brain',
      'deck_projB_brain',
      'deck_projC_brain',
    ]);
    expect(merged[0]?.label).toBe('Project A Live');
    expect(merged[0]?.sharedState?.effectiveRole).toBe('participant');
    // Preserves previously cached live label for inactive sibling B
    expect(merged[1]?.label).toBe('Project B Cached');
    expect(merged[1]?.sharedState?.effectiveRole).toBe('viewer');
    // Unvisited sibling C still shows metadata from discovery entry (falling back cleanly if state omitted)
    expect(merged[2]?.agentType).toBe('unknown');
    expect(merged[2]?.state).toBe('unknown');
    expect(merged[2]?.sharedState?.effectiveRole).toBe('viewer');
  });

  it('does not synthesize duplicate tabs for owned servers or full kind=server shares', () => {
    const entryA = makeMainEntry({ id: 'g-a', sessionName: 'deck_projA_brain' });
    const entryB = makeMainEntry({ id: 'g-b', sessionName: 'deck_projB_brain' });
    const liveA: SessionInfo = {
      name: 'deck_projA_brain',
      project: 'projA',
      role: 'brain',
      agentType: 'codex',
      state: 'idle',
    };

    expect(mergeSharedServerSessions({
      serverId: 'srv-shared',
      isOwnedServer: false,
      activeTarget: { kind: 'server', serverId: 'srv-shared' },
      sharedEntries: [entryA, entryB],
      liveSessions: [liveA],
    })).toEqual([liveA]);

    expect(mergeSharedServerSessions({
      serverId: 'srv-shared',
      isOwnedServer: true,
      activeTarget: null,
      sharedEntries: [entryA, entryB],
      liveSessions: [liveA],
    })).toEqual([liveA]);
  });

  it('deduplicates multiple grants for the same session/subsession preferring participant over viewer', () => {
    const viewerMain = makeMainEntry({ id: 'g-v', sessionName: 'deck_alpha_brain', role: 'viewer' });
    const participantMain = makeMainEntry({ id: 'g-p', sessionName: 'deck_alpha_brain', role: 'participant' });
    const viewerSub = makeSubEntry({ id: 's-v', subSessionId: 'sub1', role: 'viewer', parentSessionName: 'deck_alpha_brain' });
    const participantSub = makeSubEntry({ id: 's-p', subSessionId: 'sub1', role: 'participant', parentSessionName: 'deck_alpha_brain' });

    const merged = mergeSharedServerSessions({
      serverId: 'srv-shared',
      isOwnedServer: false,
      activeTarget: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_alpha_brain' },
      sharedEntries: [viewerMain, participantMain],
      liveSessions: [],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.sharedState?.effectiveRole).toBe('participant');
    expect(findSharedEntryForServerTab([viewerMain, participantMain], 'srv-shared', 'deck_alpha_brain')?.id).toBe('g-p');
    expect(findSharedEntryForServerSubSession([viewerSub, participantSub], 'srv-shared', 'sub1')?.id).toBe('s-p');
  });

  it('merges subsession-only grants into SessionTree with synthetic parent rows and accurate role states', () => {
    const mainEntry = makeMainEntry({ id: 'g-main', sessionName: 'deck_projA_brain', role: 'viewer' });
    const subOnlyEntry = makeSubEntry({
      id: 'g-sub',
      subSessionId: 'subB1',
      role: 'participant',
      targetLabel: 'Sub B1',
      agentType: 'codex-sdk',
      parentSessionName: 'deck_projB_brain',
    });

    const mergedSessions = mergeSharedServerSessions({
      serverId: 'srv-shared',
      isOwnedServer: false,
      activeTarget: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_projA_brain' },
      sharedEntries: [mainEntry, subOnlyEntry],
      liveSessions: [],
    });
    expect(mergedSessions.map((s) => s.name)).toEqual(['deck_projA_brain', 'deck_projB_brain']);
    expect(mergedSessions[1]?.sharedState).toMatchObject({
      targetKind: 'subsession',
      effectiveRole: 'participant',
    });

    const mergedSubs = mergeSharedServerSubSessions({
      serverId: 'srv-shared',
      isOwnedServer: false,
      activeTarget: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_projA_brain' },
      sharedEntries: [mainEntry, subOnlyEntry],
      liveSubSessions: [],
    });
    expect(mergedSubs.map((s) => s.id)).toEqual(['subB1']);
    expect(mergedSubs[0]?.parentSession).toBe('deck_projB_brain');

    const states = buildSharedServerSubSessionStates({
      serverId: 'srv-shared',
      isOwnedServer: false,
      activeTarget: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_projA_brain' },
      sharedEntries: [mainEntry, subOnlyEntry],
      subSessions: mergedSubs,
      baseStates: new Map(),
      activeDispatchIds: new Map(),
    });
    expect(states.get('subB1')?.effectiveRole).toBe('participant');
    // Clicking the synthetic parent tab resolves to its child subsession grant
    expect(findSharedEntryForServerTab([mainEntry, subOnlyEntry], 'srv-shared', 'deck_projB_brain')?.id).toBe('g-sub');
  });

  it('drops revoked sibling tabs and caches immediately on discovery refresh', () => {
    const entryA = makeMainEntry({ id: 'g-a', sessionName: 'deck_projA_brain' });
    const entryB = makeMainEntry({ id: 'g-b', sessionName: 'deck_projB_brain' });
    const cachedA: SessionInfo = {
      name: 'deck_projA_brain',
      project: 'projA',
      role: 'brain',
      agentType: 'codex',
      state: 'idle',
    };
    const cachedB: SessionInfo = {
      name: 'deck_projB_brain',
      project: 'projB',
      role: 'brain',
      agentType: 'codex',
      state: 'idle',
    };

    // Counterexample: cachedB must NOT survive once entryB is removed from active sharedEntries
    const mergedAfterRevoke = mergeSharedServerSessions({
      serverId: 'srv-shared',
      isOwnedServer: false,
      activeTarget: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_projA_brain' },
      sharedEntries: [entryA],
      liveSessions: [cachedA],
      cachedSessions: new Map([[cachedA.name, cachedA], [cachedB.name, cachedB]]),
    });
    expect(mergedAfterRevoke.map((s) => s.name)).toEqual(['deck_projA_brain']);
    expect(entryB.id).toBe('g-b');
  });

  it('remembers last valid entry on server revisit and falls back cleanly when revoked', () => {
    const entryA = makeMainEntry({ id: 'g-a', sessionName: 'deck_projA_brain', role: 'participant' });
    const entryB = makeMainEntry({ id: 'g-b', sessionName: 'deck_projB_brain', role: 'viewer' });

    const remembered = resolvePreferredSharedEntryForServer([entryA, entryB], 'srv-shared', 'g-b', entryA);
    expect(remembered?.id).toBe('g-b');

    const fallbackAfterRevoke = resolvePreferredSharedEntryForServer([entryA], 'srv-shared', 'g-b', entryB);
    expect(fallbackAfterRevoke?.id).toBe('g-a');
  });

  it('routes subsession clicks accurately for sibling grants and viewer->participant privilege upgrades', () => {
    const mainViewer = makeMainEntry({ id: 'g-main-v', sessionName: 'deck_projA_brain', role: 'viewer' });
    const childViewer = makeSubSession('sub1', 'deck_projA_brain');
    const directParticipantSub = makeSubEntry({
      id: 'g-sub-p',
      subSessionId: 'sub1',
      role: 'participant',
      parentSessionName: 'deck_projA_brain',
    });
    const otherParentChild = makeSubSession('subB', 'deck_projB_brain');
    const mainB = makeMainEntry({ id: 'g-main-b', sessionName: 'deck_projB_brain', role: 'viewer' });

    // On viewer main share, clicking child covered by a higher-role direct participant grant switches share target
    expect(resolveRestrictedSubSessionClick({
      entries: [mainViewer, directParticipantSub, mainB],
      serverId: 'srv-shared',
      isOwnedServer: false,
      activeTarget: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_projA_brain' },
      activeEntryId: 'g-main-v',
      subSessionId: 'sub1',
      subSessions: [childViewer, otherParentChild],
    })).toEqual({ action: 'open', entry: directParticipantSub });

    // On participant main share, clicking covered child without higher grant opens locally
    expect(resolveRestrictedSubSessionClick({
      entries: [{ ...mainViewer, role: 'participant' }],
      serverId: 'srv-shared',
      isOwnedServer: false,
      activeTarget: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_projA_brain' },
      activeEntryId: 'g-main-v',
      subSessionId: 'sub1',
      subSessions: [childViewer, otherParentChild],
    })).toEqual({ action: 'local' });

    // Clicking child of an inactive main grant switches to that parent main grant with openSubSessionId
    expect(resolveRestrictedSubSessionClick({
      entries: [mainViewer, mainB],
      serverId: 'srv-shared',
      isOwnedServer: false,
      activeTarget: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_projA_brain' },
      activeEntryId: 'g-main-v',
      subSessionId: 'subB',
      subSessions: [childViewer, otherParentChild],
    })).toEqual({ action: 'open', entry: mainB, openSubSessionId: 'subB' });
  });

  it('surfaces parentless, legacy-omitted, and nested deck_sub_* subsession shares via getDirectSharedSubSessions', () => {
    const orphanSub = makeSubEntry({
      id: 'g-orphan',
      subSessionId: 'subOrphan',
      role: 'participant',
      targetLabel: 'Orphan Sub',
    });
    const nestedSub = makeSubEntry({
      id: 'g-nested',
      subSessionId: 'subNested',
      role: 'viewer',
      targetLabel: 'Nested Sub',
      parentSessionName: 'deck_sub_parentOnly',
    });

    const mergedSessions = mergeSharedServerSessions({
      serverId: 'srv-shared',
      isOwnedServer: false,
      activeTarget: { kind: 'subsession', serverId: 'srv-shared', subSessionId: 'subOrphan' },
      sharedEntries: [orphanSub, nestedSub],
      liveSessions: [],
    });
    expect(mergedSessions).toEqual([]);

    const mergedSubs = mergeSharedServerSubSessions({
      serverId: 'srv-shared',
      isOwnedServer: false,
      activeTarget: { kind: 'subsession', serverId: 'srv-shared', subSessionId: 'subOrphan' },
      sharedEntries: [orphanSub, nestedSub],
      liveSubSessions: [],
    });
    expect(mergedSubs.map((s) => s.id)).toEqual(['subOrphan', 'subNested']);

    const directSubs = getDirectSharedSubSessions({
      serverId: 'srv-shared',
      isOwnedServer: false,
      activeTarget: { kind: 'subsession', serverId: 'srv-shared', subSessionId: 'subOrphan' },
      sessions: mergedSessions,
      subSessions: mergedSubs,
    });
    expect(directSubs.map((s) => s.id)).toEqual(['subOrphan', 'subNested']);
  });

  it('preserves authoritative participant coverage over narrower overlapping viewer grant and evicts on empty loaded discovery', () => {
    const narrowViewer = makeMainEntry({ id: 'g-v', sessionName: 'deck_projA_brain', role: 'viewer' });
    const liveAuthorized: SessionInfo = {
      name: 'deck_projA_brain',
      project: 'projA',
      role: 'brain',
      agentType: 'claude-code',
      state: 'running',
      sharedState: {
        targetKind: 'main',
        effectiveRole: 'participant',
        status: 'active',
        scopeLabel: 'Project A',
      },
    };

    const mergedOverlapping = mergeSharedServerSessions({
      serverId: 'srv-shared',
      isOwnedServer: false,
      activeTarget: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_projA_brain' },
      activeCoverageRole: 'participant',
      sharedEntries: [narrowViewer],
      activeEntryRevoked: false,
      liveSessions: [liveAuthorized],
    });
    expect(mergedOverlapping[0]?.sharedState?.effectiveRole).toBe('participant');

    // When active entry is confirmed revoked and zero active grants remain, stale live rows are evicted
    expect(mergeSharedServerSessions({
      serverId: 'srv-shared',
      isOwnedServer: false,
      activeTarget: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_projA_brain' },
      sharedEntries: [],
      activeEntryRevoked: true,
      liveSessions: [liveAuthorized],
    })).toEqual([]);

    // Excluded denied IDs are skipped in fallback resolution
    const entryC = makeMainEntry({ id: 'g-c', sessionName: 'deck_projC_brain', role: 'viewer' });
    expect(resolvePreferredSharedEntryForServer(
      [narrowViewer, entryC],
      'srv-shared',
      'g-v',
      narrowViewer,
      new Set(['g-v']),
    )?.id).toBe('g-c');
  });
});
