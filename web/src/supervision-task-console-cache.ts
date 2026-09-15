import {
  SUPERVISION_TASK_CONSOLE_PHASE,
  type SupervisionTaskConsoleReducerState,
} from './supervision-task-console-reducer.js';

export interface SupervisionTaskConsoleAuthority {
  userId: string;
  serverId: string;
  projectName: string;
  coordinatorSessionName: string;
}

interface CachedProjection {
  authority: SupervisionTaskConsoleAuthority;
  state: SupervisionTaskConsoleReducerState;
  accessedAt: number;
}

const MAX_CACHED_AUTHORITIES = 12;
const projections = new Map<string, CachedProjection>();

function authorityKey(authority: SupervisionTaskConsoleAuthority): string {
  return JSON.stringify([
    authority.userId,
    authority.serverId,
    authority.projectName,
    authority.coordinatorSessionName,
  ]);
}

function snapshotForCache(state: SupervisionTaskConsoleReducerState): SupervisionTaskConsoleReducerState {
  return {
    ...state,
    subscriptionId: null,
    phase: SUPERVISION_TASK_CONSOLE_PHASE.READY,
    syncing: false,
    resyncReason: null,
    error: null,
  };
}

export function readSupervisionTaskConsoleCache(
  authority: SupervisionTaskConsoleAuthority,
): SupervisionTaskConsoleReducerState | null {
  const key = authorityKey(authority);
  const cached = projections.get(key);
  if (!cached) return null;
  cached.accessedAt = Date.now();
  return snapshotForCache(cached.state);
}

export function writeSupervisionTaskConsoleCache(
  authority: SupervisionTaskConsoleAuthority,
  state: SupervisionTaskConsoleReducerState,
): void {
  if (!state.hasAuthoritativeSnapshot) return;
  const key = authorityKey(authority);
  projections.set(key, { authority: { ...authority }, state: snapshotForCache(state), accessedAt: Date.now() });
  if (projections.size <= MAX_CACHED_AUTHORITIES) return;
  const oldest = [...projections.entries()].sort((left, right) => left[1].accessedAt - right[1].accessedAt)[0];
  if (oldest) projections.delete(oldest[0]);
}

export function clearSupervisionTaskConsoleCache(
  authority: SupervisionTaskConsoleAuthority,
): void {
  projections.delete(authorityKey(authority));
}

export function clearSupervisionTaskConsoleCacheForUser(userId: string): void {
  for (const [key, entry] of projections) {
    if (entry.authority.userId === userId) projections.delete(key);
  }
}

export function clearAllSupervisionTaskConsoleCaches(): void {
  projections.clear();
}
