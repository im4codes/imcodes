import type { SharedEntrySummary } from './api.js';
import type { SubSession } from './hooks/useSubSessions.js';
import { isNavigableMainSession, parseMainSessionName, resolveSharedSessionProject } from './session-list-merge.js';
import type { SharedStateSummary, ShareRole, ShareTarget } from './tab-sharing-ui.js';
import type { SessionInfo } from './types.js';
import { getSessionRuntimeType } from '@shared/agent-types.js';

function shareRoleRank(role: ShareRole): number {
  return role === 'participant' ? 2 : 1;
}

export function shareTargetsEqual(
  a: ShareTarget | null | undefined,
  b: ShareTarget | null | undefined,
): boolean {
  if (!a || !b || a.kind !== b.kind || a.serverId !== b.serverId) return false;
  if (a.kind === 'server') return true;
  if (a.kind === 'main' && b.kind === 'main') return a.sessionName === b.sessionName;
  if (a.kind === 'subsession' && b.kind === 'subsession') return a.subSessionId === b.subSessionId;
  return false;
}

function shareEntryPriorityRank(entry: SharedEntrySummary): number {
  if (entry.target.kind === 'server') return 30;
  return (entry.role === 'participant' ? 20 : 10) + (entry.target.kind === 'main' ? 2 : 1);
}

export function isActiveRestrictedSharedServer(params: {
  serverId: string | null | undefined;
  isOwnedServer: boolean;
  activeTarget: ShareTarget | null;
}): boolean {
  if (!params.serverId || params.isOwnedServer || !params.activeTarget) return false;
  return params.activeTarget.serverId === params.serverId && params.activeTarget.kind !== 'server';
}

export function filterActiveSharedEntriesForServer(
  entries: readonly SharedEntrySummary[],
  serverId: string | null | undefined,
  excludedEntryIds?: ReadonlySet<string>,
): SharedEntrySummary[] {
  if (!serverId) return [];
  return entries.filter(
    (entry) => entry.status === 'active'
      && entry.serverId === serverId
      && !excludedEntryIds?.has(entry.id),
  );
}

/**
 * Resolve the highest-privilege active share entry for a main session tab on a
 * shared-in server (`participant > viewer`). Falls back to a child `subsession`
 * share when the main row is a synthetic parent container for a sub-session-only share.
 */
export function findSharedEntryForServerTab(
  entries: readonly SharedEntrySummary[],
  serverId: string | null | undefined,
  sessionName: string,
  subSessions?: readonly SubSession[],
  excludedEntryIds?: ReadonlySet<string>,
): SharedEntrySummary | null {
  const active = filterActiveSharedEntriesForServer(entries, serverId, excludedEntryIds);
  let bestMain: SharedEntrySummary | null = null;
  for (const entry of active) {
    if (entry.target.kind !== 'main' || entry.target.sessionName !== sessionName) continue;
    if (!bestMain || shareRoleRank(entry.role) > shareRoleRank(bestMain.role)) {
      bestMain = entry;
    }
  }
  if (bestMain) return bestMain;

  let bestSub: SharedEntrySummary | null = null;
  for (const entry of active) {
    if (entry.target.kind !== 'subsession') continue;
    const targetSubId = entry.target.subSessionId;
    const matchesParent = entry.parentSessionName === sessionName
      || Boolean(subSessions?.some((sub) => sub.id === targetSubId && sub.parentSession === sessionName));
    if (!matchesParent) continue;
    if (!bestSub || shareRoleRank(entry.role) > shareRoleRank(bestSub.role)) {
      bestSub = entry;
    }
  }
  return bestSub;
}

/**
 * Resolve the highest-privilege active share entry for a specific sub-session
 * on a shared-in server (`participant > viewer`).
 */
export function findSharedEntryForServerSubSession(
  entries: readonly SharedEntrySummary[],
  serverId: string | null | undefined,
  subSessionId: string,
  excludedEntryIds?: ReadonlySet<string>,
): SharedEntrySummary | null {
  const active = filterActiveSharedEntriesForServer(entries, serverId, excludedEntryIds);
  let best: SharedEntrySummary | null = null;
  for (const entry of active) {
    if (entry.target.kind !== 'subsession' || entry.target.subSessionId !== subSessionId) continue;
    if (!best || shareRoleRank(entry.role) > shareRoleRank(best.role)) {
      best = entry;
    }
  }
  return best;
}

/**
 * Choose which grant to open when switching back into a shared server:
 * prefer the last active valid grant for that server, then the passed fallback
 * entry if still active, then the highest-priority active grant on that server.
 */
export function resolvePreferredSharedEntryForServer(
  entries: readonly SharedEntrySummary[],
  serverId: string | null | undefined,
  preferredEntryId: string | null | undefined,
  fallbackEntry?: SharedEntrySummary | null,
  excludedEntryIds?: ReadonlySet<string>,
): SharedEntrySummary | null {
  const active = filterActiveSharedEntriesForServer(entries, serverId, excludedEntryIds);
  if (active.length === 0) return null;
  if (preferredEntryId) {
    const remembered = active.find((entry) => entry.id === preferredEntryId);
    if (remembered) return remembered;
  }
  if (fallbackEntry && fallbackEntry.serverId === serverId) {
    const activeFallback = active.find((entry) => entry.id === fallbackEntry.id);
    if (activeFallback) return activeFallback;
  }
  let best = active[0]!;
  for (let i = 1; i < active.length; i += 1) {
    const candidate = active[i]!;
    if (shareEntryPriorityRank(candidate) > shareEntryPriorityRank(best)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Determine whether clicking a sub-session on a restricted shared-in server
 * requires switching the active share grant via `/api/shares/open` (and which
 * entry to open), or can open locally under the current grant.
 */
export function resolveRestrictedSubSessionClick(params: {
  entries: readonly SharedEntrySummary[];
  serverId: string | null | undefined;
  isOwnedServer: boolean;
  activeTarget: ShareTarget | null;
  activeEntryId: string | null;
  activeCoverageRole?: ShareRole | null;
  authorizedScopedSubIds?: ReadonlySet<string>;
  subSessionId: string;
  subSessions: readonly SubSession[];
  excludedEntryIds?: ReadonlySet<string>;
}): { action: 'local' } | { action: 'none' } | { action: 'open'; entry: SharedEntrySummary; openSubSessionId?: string } {
  const {
    entries,
    serverId,
    isOwnedServer,
    activeTarget,
    activeEntryId,
    activeCoverageRole,
    authorizedScopedSubIds,
    subSessionId,
    subSessions,
    excludedEntryIds,
  } = params;
  if (!serverId || !isActiveRestrictedSharedServer({ serverId, isOwnedServer, activeTarget })) {
    return { action: 'local' };
  }
  const sub = subSessions.find((item) => item.id === subSessionId);
  const directSubEntry = findSharedEntryForServerSubSession(entries, serverId, subSessionId, excludedEntryIds);
  const activeRole: ShareRole = activeCoverageRole
    ?? entries.find((entry) => entry.id === activeEntryId)?.role
    ?? 'viewer';

  const alreadyOnDirectSub = Boolean(
    directSubEntry
    && activeTarget?.kind === 'subsession'
    && activeTarget.subSessionId === subSessionId
    && activeEntryId === directSubEntry.id,
  );
  if (alreadyOnDirectSub) return { action: 'local' };

  const isCoveredByActiveScope = Boolean(
    authorizedScopedSubIds?.has(subSessionId)
    && (activeTarget?.kind === 'main' || activeTarget?.kind === 'subsession' || activeTarget?.kind === 'server'),
  );
  const coveredByMainAtSameOrHigherRole = Boolean(
    (isCoveredByActiveScope
      || (authorizedScopedSubIds === undefined
        && activeTarget?.kind === 'main'
        && sub?.parentSession === activeTarget.sessionName))
    && (!directSubEntry || shareRoleRank(directSubEntry.role) <= shareRoleRank(activeRole)),
  );
  if (coveredByMainAtSameOrHigherRole) return { action: 'local' };

  if (directSubEntry) {
    return { action: 'open', entry: directSubEntry };
  }
  if (sub?.parentSession) {
    const parentEntry = findSharedEntryForServerTab(entries, serverId, sub.parentSession, subSessions, excludedEntryIds);
    if (parentEntry) {
      return { action: 'open', entry: parentEntry, openSubSessionId: subSessionId };
    }
  }
  return { action: 'none' };
}

function buildBestMainGrantMap(activeEntries: readonly SharedEntrySummary[]): Map<string, SharedEntrySummary> {
  const map = new Map<string, SharedEntrySummary>();
  for (const entry of activeEntries) {
    if (entry.target.kind !== 'main') continue;
    const existing = map.get(entry.target.sessionName);
    if (!existing || shareRoleRank(entry.role) > shareRoleRank(existing.role)) {
      map.set(entry.target.sessionName, entry);
    }
  }
  return map;
}

function buildBestSubGrantMap(activeEntries: readonly SharedEntrySummary[]): Map<string, SharedEntrySummary> {
  const map = new Map<string, SharedEntrySummary>();
  for (const entry of activeEntries) {
    if (entry.target.kind !== 'subsession') continue;
    const existing = map.get(entry.target.subSessionId);
    if (!existing || shareRoleRank(entry.role) > shareRoleRank(existing.role)) {
      map.set(entry.target.subSessionId, entry);
    }
  }
  return map;
}

/**
 * Merge live/opened sessions with cached sibling states and active restricted
 * share grants belonging to the same shared-in server so switching tabs or
 * receiving narrow WS `session_list` frames never drops sibling shared tabs.
 */
export function mergeSharedServerSessions(params: {
  serverId: string | null | undefined;
  isOwnedServer: boolean;
  activeTarget: ShareTarget | null;
  activeCoverageRole?: ShareRole | null;
  sharedEntries: readonly SharedEntrySummary[];
  activeEntryRevoked?: boolean;
  excludedEntryIds?: ReadonlySet<string>;
  revokedSessionNames?: ReadonlySet<string>;
  liveSessions: readonly SessionInfo[];
  cachedSessions?: ReadonlyMap<string, SessionInfo>;
}): SessionInfo[] {
  const {
    serverId,
    isOwnedServer,
    activeTarget,
    activeCoverageRole,
    sharedEntries,
    activeEntryRevoked,
    excludedEntryIds,
    revokedSessionNames,
    liveSessions,
    cachedSessions,
  } = params;
  if (!isActiveRestrictedSharedServer({ serverId, isOwnedServer, activeTarget })) {
    return [...liveSessions];
  }
  const activeEntries = filterActiveSharedEntriesForServer(sharedEntries, serverId, excludedEntryIds);
  if (activeEntries.length === 0) {
    // Only evict live rows when the current entry was confirmed revoked/denied;
    // a temporarily empty discovery inventory during direct URL restore must
    // preserve the opened session returned by /api/shares/open.
    return activeEntryRevoked && activeTarget !== null ? [] : [...liveSessions];
  }
  if (activeTarget === null && activeEntries.some((entry) => entry.target.kind === 'server')) {
    return [...liveSessions];
  }

  const bestMainGrants = buildBestMainGrantMap(activeEntries);
  const subParentGrants = new Map<string, SharedEntrySummary>();
  for (const entry of activeEntries) {
    if (entry.target.kind !== 'subsession' || !entry.parentSessionName) continue;
    if (bestMainGrants.has(entry.parentSessionName)) continue;
    const parsedParent = parseMainSessionName(entry.parentSessionName);
    if (!isNavigableMainSession({ name: entry.parentSessionName, role: parsedParent?.role ?? 'brain' })) continue;
    const existing = subParentGrants.get(entry.parentSessionName);
    if (!existing || shareRoleRank(entry.role) > shareRoleRank(existing.role)) {
      subParentGrants.set(entry.parentSessionName, entry);
    }
  }

  const liveByName = new Map<string, SessionInfo>();
  for (const live of liveSessions) {
    liveByName.set(live.name, live);
  }

  const merged: SessionInfo[] = [];
  const seenNames = new Set<string>();

  const applyMainGrantOverlay = (
    session: SessionInfo,
    entry: SharedEntrySummary,
    isLiveSession: boolean,
  ): SessionInfo => {
    // For the currently opened main target, the live open/WS coverage role is
    // authoritative: never upgrade a confirmed viewer connection with a stale
    // participant discovery entry, and never downgrade overlapping server
    // participant coverage to a narrow viewer entry.
    const isAuthoritativeActiveMain = isLiveSession && (
      activeTarget?.kind === 'main' && activeTarget.sessionName === session.name
    );
    const effectiveRole: ShareRole = isAuthoritativeActiveMain
      ? (activeCoverageRole ?? session.sharedState?.effectiveRole ?? entry.role)
      : entry.role;
    const nextSharedState: SharedStateSummary = session.sharedState
      ? {
          ...session.sharedState,
          effectiveRole,
          scopeLabel: isAuthoritativeActiveMain
            ? (session.sharedState.scopeLabel ?? entry.targetLabel)
            : entry.targetLabel,
        }
      : {
          targetKind: 'main',
          effectiveRole,
          status: 'active',
          scopeLabel: entry.targetLabel,
          activeDispatchId: null,
        };
    return { ...session, sharedState: nextSharedState };
  };

  for (const [sessionName, entry] of bestMainGrants) {
    const live = liveByName.get(sessionName);
    if (live) {
      // While focused on a child `subsession`, the parent main session acts as a
      // navigation container (`targetKind === 'subsession'`); keep its navigation
      // grant badge while `SessionPane` binds pane write controls strictly to exact
      // main/server authorization.
      merged.push(applyMainGrantOverlay(live, entry, true));
      seenNames.add(sessionName);
      continue;
    }
    const cached = cachedSessions?.get(sessionName);
    if (cached) {
      merged.push(applyMainGrantOverlay(cached, entry, false));
      seenNames.add(sessionName);
      continue;
    }
    const parsed = parseMainSessionName(sessionName);
    merged.push({
      name: sessionName,
      project: resolveSharedSessionProject(sessionName, entry.targetLabel),
      role: parsed?.role ?? 'brain',
      agentType: entry.agentType || 'unknown',
      state: (entry.sessionState as SessionInfo['state']) || 'unknown',
      label: entry.targetLabel && entry.targetLabel !== sessionName ? entry.targetLabel : null,
      sharedState: {
        targetKind: 'main',
        effectiveRole: entry.role,
        status: 'active',
        scopeLabel: entry.targetLabel,
        activeDispatchId: null,
      },
    });
    seenNames.add(sessionName);
  }

  for (const [parentName, subEntry] of subParentGrants) {
    if (seenNames.has(parentName)) continue;
    const live = liveByName.get(parentName);
    if (live) {
      merged.push(live);
      seenNames.add(parentName);
      continue;
    }
    const cached = cachedSessions?.get(parentName);
    if (cached) {
      merged.push(cached);
      seenNames.add(parentName);
      continue;
    }
    const parsed = parseMainSessionName(parentName);
    merged.push({
      name: parentName,
      project: resolveSharedSessionProject(parentName, parentName),
      role: parsed?.role ?? 'brain',
      agentType: 'unknown',
      state: 'unknown',
      label: null,
      sharedState: {
        targetKind: 'subsession',
        effectiveRole: subEntry.role,
        status: 'active',
        scopeLabel: subEntry.targetLabel,
        activeDispatchId: null,
      },
    });
    seenNames.add(parentName);
  }

  for (const live of liveSessions) {
    if (seenNames.has(live.name)) continue;
    if (revokedSessionNames?.has(live.name)) continue;
    merged.push(live);
    seenNames.add(live.name);
  }

  return merged;
}

/**
 * Merge live opened sub-sessions with cached sibling sub-sessions and active
 * `subsession` share grants on the same shared-in server so sibling shared
 * sub-sessions appear together in SessionTree.
 */
export function mergeSharedServerSubSessions(params: {
  serverId: string | null | undefined;
  isOwnedServer: boolean;
  activeTarget: ShareTarget | null;
  sharedEntries: readonly SharedEntrySummary[];
  activeEntryRevoked?: boolean;
  excludedEntryIds?: ReadonlySet<string>;
  revokedSubSessionIds?: ReadonlySet<string>;
  liveSubSessions: readonly SubSession[];
  cachedSubSessions?: ReadonlyMap<string, SubSession>;
}): SubSession[] {
  const {
    serverId,
    isOwnedServer,
    activeTarget,
    sharedEntries,
    activeEntryRevoked,
    excludedEntryIds,
    revokedSubSessionIds,
    liveSubSessions,
    cachedSubSessions,
  } = params;
  if (!isActiveRestrictedSharedServer({ serverId, isOwnedServer, activeTarget }) || !serverId) {
    return [...liveSubSessions];
  }
  const activeEntries = filterActiveSharedEntriesForServer(sharedEntries, serverId, excludedEntryIds);
  if (activeEntries.length === 0) {
    return activeEntryRevoked && activeTarget !== null ? [] : [...liveSubSessions];
  }
  if (activeTarget === null && activeEntries.some((entry) => entry.target.kind === 'server')) {
    return [...liveSubSessions];
  }

  const bestMainGrants = buildBestMainGrantMap(activeEntries);
  const bestSubGrants = buildBestSubGrantMap(activeEntries);
  const liveById = new Map<string, SubSession>();
  for (const live of liveSubSessions) {
    liveById.set(live.id, live);
  }

  const merged: SubSession[] = [];
  const seenIds = new Set<string>();

  for (const [subId, entry] of bestSubGrants) {
    const live = liveById.get(subId);
    if (live) {
      merged.push(live);
      seenIds.add(subId);
      continue;
    }
    const cached = cachedSubSessions?.get(subId);
    if (cached) {
      merged.push(cached);
      seenIds.add(subId);
      continue;
    }
    const agentType = entry.agentType || 'unknown';
    const runtimeType = getSessionRuntimeType(agentType);
    merged.push({
      id: subId,
      serverId,
      type: agentType,
      runtimeType,
      providerId: runtimeType === 'transport' ? agentType : null,
      providerSessionId: null,
      shellBin: null,
      cwd: null,
      label: entry.targetLabel || null,
      closedAt: null,
      createdAt: 0,
      updatedAt: 0,
      ccSessionId: null,
      geminiSessionId: null,
      parentSession: entry.parentSessionName ?? null,
      description: null,
      ccPresetId: null,
      supervisionMode: null,
      sessionName: `deck_sub_${subId}`,
      state: 'unknown',
    });
    seenIds.add(subId);
  }

  for (const live of liveSubSessions) {
    if (seenIds.has(live.id)) continue;
    if (revokedSubSessionIds?.has(live.id)) continue;
    merged.push(live);
    seenIds.add(live.id);
  }

  if (cachedSubSessions) {
    for (const [subId, cached] of cachedSubSessions) {
      if (seenIds.has(subId)) continue;
      if (bestSubGrants.has(subId) || (cached.parentSession && bestMainGrants.has(cached.parentSession))) {
        merged.push(cached);
        seenIds.add(subId);
      }
    }
  }

  return merged;
}

/**
 * Extract sub-sessions on a restricted shared-in server whose parent is absent or
 * not present among `sessions` (e.g. parentless sub-sessions, older servers omitting
 * `parentSessionName`, or nested `deck_sub_*` sub-sessions without an outer main tab).
 */
export function getDirectSharedSubSessions(params: {
  serverId: string | null | undefined;
  isOwnedServer: boolean;
  activeTarget: ShareTarget | null;
  sessions: readonly SessionInfo[];
  subSessions: readonly SubSession[];
}): SubSession[] {
  if (!isActiveRestrictedSharedServer(params)) return [];
  const mainNames = new Set(params.sessions.map((session) => session.name));
  return params.subSessions.filter(
    (sub) => !sub.parentSession || !mainNames.has(sub.parentSession),
  );
}

/**
 * Overlay direct `subsession` grant badges (`viewer` vs `participant`) onto
 * sub-sessions on an active restricted shared server while preserving the
 * authoritative opened coverage role on covered targets.
 */
export function buildSharedServerSubSessionStates(params: {
  serverId: string | null | undefined;
  isOwnedServer: boolean;
  activeTarget: ShareTarget | null;
  activeCoverageRole?: ShareRole | null;
  authorizedScopedSubIds?: ReadonlySet<string>;
  sharedEntries: readonly SharedEntrySummary[];
  excludedEntryIds?: ReadonlySet<string>;
  subSessions: readonly SubSession[];
  baseStates: ReadonlyMap<string, SharedStateSummary>;
  activeDispatchIds: ReadonlyMap<string, string>;
  /**
   * 'connection' (default): reports the effective role enforced on the currently
   * active WS connection so open panes stay strictly read-only on downgrade.
   * 'navigation': reports higher switchable direct grant roles for tree badges.
   */
  mode?: 'connection' | 'navigation';
}): Map<string, SharedStateSummary> {
  const states = new Map<string, SharedStateSummary>(params.baseStates);
  if (!isActiveRestrictedSharedServer({
    serverId: params.serverId,
    isOwnedServer: params.isOwnedServer,
    activeTarget: params.activeTarget,
  })) {
    return states;
  }
  const activeEntries = filterActiveSharedEntriesForServer(
    params.sharedEntries,
    params.serverId,
    params.excludedEntryIds,
  );
  const bestSubGrants = buildBestSubGrantMap(activeEntries);
  for (const sub of params.subSessions) {
    const grant = bestSubGrants.get(sub.id);
    const isDirectActiveSub = params.activeTarget?.kind === 'subsession'
      && params.activeTarget.subSessionId === sub.id;
    const isCoveredByActiveScope = Boolean(
      (params.activeTarget?.kind === 'main' || params.activeTarget?.kind === 'subsession')
      && (params.authorizedScopedSubIds?.has(sub.id)
        || (params.authorizedScopedSubIds === undefined
          && params.activeTarget.kind === 'main'
          && sub.parentSession === params.activeTarget.sessionName)),
    );

    if (!grant && !isDirectActiveSub && !isCoveredByActiveScope) continue;

    const activeRole = params.activeCoverageRole ?? 'viewer';
    let effectiveRole: ShareRole;
    if (isDirectActiveSub) {
      effectiveRole = params.activeCoverageRole ?? grant?.role ?? 'viewer';
    } else if (isCoveredByActiveScope) {
      effectiveRole = params.mode === 'navigation'
        && grant
        && shareRoleRank(grant.role) > shareRoleRank(activeRole)
        ? grant.role
        : activeRole;
    } else {
      effectiveRole = grant!.role;
    }

    const existing = states.get(sub.id);
    const summary: SharedStateSummary = {
      targetKind: 'subsession',
      effectiveRole,
      status: 'active',
      scopeLabel: grant?.targetLabel ?? existing?.scopeLabel ?? sub.label ?? sub.type,
      activeDispatchId: params.activeDispatchIds.get(sub.sessionName) ?? null,
    };
    states.set(sub.id, summary);
    states.set(sub.sessionName, summary);
  }
  return states;
}
