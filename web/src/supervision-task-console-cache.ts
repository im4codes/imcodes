import { SUPERVISION_TASK_STATUS_CONTRACT_VERSION } from '@shared/supervision-config.js';
import { SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION } from '@shared/supervision-task-console.js';
import {
  SUPERVISION_TASK_CONSOLE_PHASE,
  SUPERVISION_TASK_CONSOLE_SYNC_STATE,
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

export const SUPERVISION_TASK_CONSOLE_CACHE_STORAGE_KEY = 'rcc_supervision_console_cache_v1';
export const MAX_CACHED_AUTHORITIES = 48;
const projections = new Map<string, CachedProjection>();
let hydratedFromStorage = false;

function authorityKey(authority: SupervisionTaskConsoleAuthority): string {
  return JSON.stringify([
    authority.userId,
    authority.serverId,
    authority.projectName,
    authority.coordinatorSessionName,
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getCacheStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function snapshotForCache(state: SupervisionTaskConsoleReducerState): SupervisionTaskConsoleReducerState {
  return {
    ...state,
    subscriptionId: null,
    phase: SUPERVISION_TASK_CONSOLE_PHASE.READY,
    syncing: false,
    syncState: SUPERVISION_TASK_CONSOLE_SYNC_STATE.STALE,
    resyncReason: null,
    error: null,
  };
}

function isValidAuthority(value: unknown): value is SupervisionTaskConsoleAuthority {
  return isRecord(value)
    && typeof value.userId === 'string'
    && typeof value.serverId === 'string'
    && typeof value.projectName === 'string'
    && typeof value.coordinatorSessionName === 'string';
}

function normalizeStoredState(
  state: unknown,
  authority: SupervisionTaskConsoleAuthority,
): SupervisionTaskConsoleReducerState | null {
  if (!isRecord(state) || state.hasAuthoritativeSnapshot !== true) return null;
  if (!isRecord(state.scope)
    || state.scope.projectName !== authority.projectName
    || state.scope.coordinatorSessionName !== authority.coordinatorSessionName) {
    return null;
  }
  if (state.schemaVersion !== SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION) return null;
  if (state.statusContractVersion !== SUPERVISION_TASK_STATUS_CONTRACT_VERSION) return null;
  if (typeof state.projectionVersion !== 'number' || !Number.isFinite(state.projectionVersion)) return null;
  if (state.lastDurableEventId !== null
    && (typeof state.lastDurableEventId !== 'number' || !Number.isFinite(state.lastDurableEventId))) {
    return null;
  }
  if (typeof state.projectionEpoch !== 'string') return null;
  if (state.pairRevision !== null
    && (typeof state.pairRevision !== 'number' || !Number.isFinite(state.pairRevision))) {
    return null;
  }
  if (typeof state.pairProjection !== 'boolean') return null;
  if (typeof state.inertPairs !== 'number' || !Number.isFinite(state.inertPairs)) return null;
  if (!isRecord(state.tasks) || !isRecord(state.assignments) || !Array.isArray(state.pools)) return null;
  for (const row of Object.values(state.tasks)) {
    if (!isRecord(row) || typeof row.taskId !== 'string') return null;
  }
  const eventsByTask = isRecord(state.eventsByTask)
    ? (state.eventsByTask as SupervisionTaskConsoleReducerState['eventsByTask'])
    : {};
  const lastSyncedAt = typeof state.lastSyncedAt === 'number' && Number.isFinite(state.lastSyncedAt)
    ? state.lastSyncedAt
    : null;
  return snapshotForCache({
    ...(state as unknown as SupervisionTaskConsoleReducerState),
    scope: {
      projectName: authority.projectName,
      coordinatorSessionName: authority.coordinatorSessionName,
    },
    lastSyncedAt,
    eventsByTask,
  });
}

function readStoredProjections(): Map<string, CachedProjection> {
  const result = new Map<string, CachedProjection>();
  const storage = getCacheStorage();
  if (!storage) return result;
  let raw: string | null = null;
  try {
    raw = storage.getItem(SUPERVISION_TASK_CONSOLE_CACHE_STORAGE_KEY);
  } catch {
    return result;
  }
  if (!raw) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }
  if (!Array.isArray(parsed)) return result;
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    if (!isValidAuthority(item.authority)) continue;
    if (typeof item.accessedAt !== 'number' || !Number.isFinite(item.accessedAt) || item.accessedAt < 0) continue;
    const state = normalizeStoredState(item.state, item.authority);
    if (!state) continue;
    const authority: SupervisionTaskConsoleAuthority = {
      userId: item.authority.userId,
      serverId: item.authority.serverId,
      projectName: item.authority.projectName,
      coordinatorSessionName: item.authority.coordinatorSessionName,
    };
    const key = authorityKey(authority);
    const existing = result.get(key);
    if (!existing || item.accessedAt > existing.accessedAt) {
      result.set(key, { authority, state, accessedAt: item.accessedAt });
    }
  }
  return result;
}

function evictOldestIfNeeded(): void {
  if (projections.size <= MAX_CACHED_AUTHORITIES) return;
  const sorted = [...projections.entries()].sort((left, right) => right[1].accessedAt - left[1].accessedAt);
  projections.clear();
  for (const [key, entry] of sorted.slice(0, MAX_CACHED_AUTHORITIES)) {
    projections.set(key, entry);
  }
}

function hydrateFromStorageOnce(): void {
  if (hydratedFromStorage) return;
  hydratedFromStorage = true;
  const stored = readStoredProjections();
  for (const [key, entry] of stored) {
    const existing = projections.get(key);
    if (!existing || entry.accessedAt > existing.accessedAt) {
      projections.set(key, entry);
    }
  }
  evictOldestIfNeeded();
}

function persistProjections(): void {
  const storage = getCacheStorage();
  if (!storage) return;
  const sorted = [...projections.values()]
    .sort((left, right) => right.accessedAt - left.accessedAt)
    .slice(0, MAX_CACHED_AUTHORITIES);
  if (sorted.length === 0) {
    try {
      storage.removeItem(SUPERVISION_TASK_CONSOLE_CACHE_STORAGE_KEY);
    } catch {
      // Ignore storage access errors (private mode / quota restrictions).
    }
    return;
  }
  let limit = sorted.length;
  while (limit > 0) {
    try {
      storage.setItem(SUPERVISION_TASK_CONSOLE_CACHE_STORAGE_KEY, JSON.stringify(sorted.slice(0, limit)));
      return;
    } catch {
      limit = limit > 8 ? Math.floor(limit / 2) : limit - 1;
    }
  }
}

export function readSupervisionTaskConsoleCache(
  authority: SupervisionTaskConsoleAuthority,
): SupervisionTaskConsoleReducerState | null {
  hydrateFromStorageOnce();
  const key = authorityKey(authority);
  let cached = projections.get(key);
  if (!cached) {
    const fromStorage = readStoredProjections().get(key);
    if (!fromStorage) return null;
    projections.set(key, fromStorage);
    evictOldestIfNeeded();
    cached = projections.get(key) ?? fromStorage;
  }
  cached.accessedAt = Date.now();
  return snapshotForCache(cached.state);
}

export function writeSupervisionTaskConsoleCache(
  authority: SupervisionTaskConsoleAuthority,
  state: SupervisionTaskConsoleReducerState,
): void {
  if (!state.hasAuthoritativeSnapshot) return;
  hydrateFromStorageOnce();
  const key = authorityKey(authority);
  projections.set(key, { authority: { ...authority }, state: snapshotForCache(state), accessedAt: Date.now() });
  evictOldestIfNeeded();
  persistProjections();
}

export function clearSupervisionTaskConsoleCache(
  authority: SupervisionTaskConsoleAuthority,
): void {
  hydrateFromStorageOnce();
  projections.delete(authorityKey(authority));
  persistProjections();
}

export function clearSupervisionTaskConsoleCacheForUser(userId: string): void {
  hydrateFromStorageOnce();
  for (const [key, entry] of projections) {
    if (entry.authority.userId === userId) projections.delete(key);
  }
  persistProjections();
}

export function clearAllSupervisionTaskConsoleCaches(): void {
  hydratedFromStorage = true;
  projections.clear();
  const storage = getCacheStorage();
  if (!storage) return;
  try {
    storage.removeItem(SUPERVISION_TASK_CONSOLE_CACHE_STORAGE_KEY);
  } catch {
    // Ignore storage access errors.
  }
}
