import { SUPERVISION_TASK_STATUS_CONTRACT_VERSION } from '@shared/supervision-config.js';
import {
  SUPERVISION_CONSOLE_DELTA_OPS,
  SUPERVISION_CONSOLE_EXECUTION_HEALTH,
  SUPERVISION_CONSOLE_SESSION_STATES,
  SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
  isValidSupervisionTaskConsoleAssignmentRow,
  isValidSupervisionTaskConsolePoolRow,
  isValidSupervisionTaskConsoleTaskRow,
  type SupervisionConsoleDeltaOp,
  type SupervisionConsolePairInfo,
  type SupervisionTaskConsoleAssignmentRow,
  type SupervisionTaskConsolePoolRow,
  type SupervisionTaskConsoleTaskRow,
} from '@shared/supervision-task-console.js';
import type { AuditSeverity } from '@shared/audit-convergence.js';
import { TASK_PAIR_STATUSES, type TaskPairFlag, type TaskPairStatus } from '@shared/task-pair.js';
import { TASK_PAIR_DECISION_KIND, type TaskPairDecisionRecord } from '@shared/task-pair-decision.js';
import type { TaskPairScheduling } from '@shared/task-pair-suspension.js';
import {
  SUPERVISION_TASK_CONSOLE_PHASE,
  SUPERVISION_TASK_CONSOLE_SYNC_STATE,
  type SupervisionTaskConsoleEventEvidence,
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
let storageOutOfSync = false;
const clearedAuthorities = new Set<string>();
const clearedUsers = new Set<string>();

const PAIR_STATUS_SET = new Set<string>(TASK_PAIR_STATUSES);
const SESSION_STATE_SET = new Set<string>(SUPERVISION_CONSOLE_SESSION_STATES);
const EXECUTION_HEALTH_SET = new Set<string>(SUPERVISION_CONSOLE_EXECUTION_HEALTH);
const DELTA_OP_SET = new Set<string>(SUPERVISION_CONSOLE_DELTA_OPS);
const DECISION_KIND_SET = new Set<string>(Object.values(TASK_PAIR_DECISION_KIND));

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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
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

function isValidDecisionRecord(value: unknown): value is TaskPairDecisionRecord {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || typeof value.project !== 'string' || typeof value.taskId !== 'string') return false;
  if (!isFiniteNumber(value.round) || typeof value.kind !== 'string' || !DECISION_KIND_SET.has(value.kind)) return false;
  if (typeof value.conclusion !== 'string' || typeof value.summary !== 'string'
    || typeof value.author !== 'string' || !isFiniteNumber(value.at)) return false;
  if (!isOptionalFiniteNumber(value.deliveryRound) || !isOptionalString(value.question)
    || !isOptionalString(value.recommendation) || !isOptionalString(value.requestId)
    || !isOptionalString(value.selectedOptionId) || !isOptionalString(value.idempotencyKey)) return false;
  if (value.related !== undefined && !isStringArray(value.related)) return false;
  if (value.options !== undefined) {
    if (!Array.isArray(value.options)) return false;
    for (const option of value.options) {
      if (!isRecord(option) || typeof option.id !== 'string' || typeof option.label !== 'string') return false;
    }
  }
  return true;
}

function isValidScheduling(value: unknown): value is TaskPairScheduling {
  if (!isRecord(value)) return false;
  if (!isFiniteNumber(value.epoch) || typeof value.manual !== 'boolean'
    || !isStringArray(value.dependsOn) || !isFiniteNumber(value.since)
    || typeof value.writer !== 'string') return false;
  if (!isOptionalString(value.note) || !isOptionalFiniteNumber(value.resumedAt)
    || !isOptionalFiniteNumber(value.resumeRetryAt) || !isOptionalFiniteNumber(value.dependencyCount)) return false;
  if (value.resumePending !== undefined && typeof value.resumePending !== 'boolean') return false;
  if (value.admitted !== undefined && typeof value.admitted !== 'boolean') return false;
  if (value.failureNotified !== undefined && typeof value.failureNotified !== 'boolean') return false;
  if (value.dependencyTitles !== undefined
    && (!isRecord(value.dependencyTitles) || !Object.values(value.dependencyTitles).every(isString))) return false;
  if (value.details !== undefined) {
    if (!isRecord(value.details)) return false;
    if (value.details.brief !== undefined) {
      const brief = value.details.brief;
      if (!isRecord(brief) || !isStringArray(brief.dependsOn) || !isOptionalString(brief.note)) return false;
      if (brief.dependencyTitles !== undefined
        && (!isRecord(brief.dependencyTitles) || !Object.values(brief.dependencyTitles).every(isString))) return false;
    }
  }
  return true;
}

function normalizePairInfo(value: unknown): SupervisionConsolePairInfo | null {
  if (!isRecord(value)) return null;
  if (typeof value.status !== 'string' || !PAIR_STATUS_SET.has(value.status)) return null;
  if (value.flags !== undefined && !isStringArray(value.flags)) return null;
  if (value.blocking !== undefined && !isStringArray(value.blocking)) return null;
  if (value.round !== undefined && !isFiniteNumber(value.round)) return null;
  if (value.lastVerdict !== undefined && value.lastVerdict !== 'PASS' && value.lastVerdict !== 'REWORK') return null;
  if (value.executorState !== undefined
    && (typeof value.executorState !== 'string' || !SESSION_STATE_SET.has(value.executorState))) return null;
  if (value.auditorState !== undefined
    && (typeof value.auditorState !== 'string' || !SESSION_STATE_SET.has(value.auditorState))) return null;
  if (value.waitingReason !== undefined && value.waitingReason !== null && typeof value.waitingReason !== 'string') return null;
  if (value.flagSides !== undefined
    && (!isRecord(value.flagSides) || !Object.values(value.flagSides).every(isString))) return null;
  if (value.severityCounts !== undefined
    && (!isRecord(value.severityCounts) || !Object.values(value.severityCounts).every(isFiniteNumber))) return null;
  if (value.checklist !== undefined && (
    !isRecord(value.checklist)
    || !isFiniteNumber(value.checklist.total)
    || !isFiniteNumber(value.checklist.implemented)
    || !isFiniteNumber(value.checklist.audited)
  )) return null;
  if (value.scheduling !== undefined && !isValidScheduling(value.scheduling)) return null;
  if (value.decisionRequest !== undefined && !isValidDecisionRecord(value.decisionRequest)) return null;
  if (value.latestDecision !== undefined && !isValidDecisionRecord(value.latestDecision)) return null;
  for (const field of [
    'brain', 'blockedNote', 'decisionRevision', 'executor', 'auditor',
    'executorLabel', 'executorModel', 'executorThinking',
    'auditorLabel', 'auditorModel', 'auditorThinking', 'brief', 'briefRevision',
  ] as const) {
    if (!isOptionalString(value[field])) return null;
  }
  for (const field of [
    'deliveryRound', 'createdAt', 'startedAt', 'updatedAt',
    'endedAt', 'queueOrder', 'queuePosition', 'lastNudgedAt',
  ] as const) {
    if (!isOptionalFiniteNumber(value[field])) return null;
  }
  const flags = value.flags ? [...(value.flags as TaskPairFlag[])] : [];
  const blocking = value.blocking ? [...(value.blocking as AuditSeverity[])] : [];
  const round = isFiniteNumber(value.round) ? value.round : 0;
  return {
    ...(value as unknown as SupervisionConsolePairInfo),
    status: value.status as TaskPairStatus,
    flags,
    blocking,
    round,
  };
}

function normalizeTaskRow(key: string, row: unknown): SupervisionTaskConsoleTaskRow | null {
  if (!isValidSupervisionTaskConsoleTaskRow(row) || row.taskId !== key) return null;
  const raw = row as unknown as Record<string, unknown>;
  if (raw.progress !== undefined && (
    !isRecord(raw.progress) || !isFiniteNumber(raw.progress.completed) || !isFiniteNumber(raw.progress.total)
  )) return null;
  if (!isOptionalFiniteNumber(raw.heartbeatAt)) return null;
  if (raw.titleAccess !== undefined && !isRecord(raw.titleAccess)) return null;
  for (const field of [
    'semanticKey', 'topLevelTaskId', 'objective', 'ownerSessionName', 'ownerAgentType',
    'observedModel', 'poolId', 'currentAction', 'nextAction', 'blocker',
    'checkpointId', 'auditAttemptId', 'auditRound', 'recoveryState',
    'recoveryReason', 'workspaceId', 'snapshotId', 'snapshotState',
  ] as const) {
    if (!isOptionalString(raw[field])) return null;
  }
  let pair: SupervisionConsolePairInfo | undefined;
  if (raw.pair !== undefined) {
    const normalizedPair = normalizePairInfo(raw.pair);
    if (!normalizedPair) return null;
    pair = normalizedPair;
  }
  return {
    ...row,
    ...(pair ? { pair } : {}),
  };
}

function normalizeAssignmentRow(key: string, row: unknown): SupervisionTaskConsoleAssignmentRow | null {
  if (!isValidSupervisionTaskConsoleAssignmentRow(row) || row.assignmentId !== key) return null;
  const raw = row as unknown as Record<string, unknown>;
  if (raw.awaitingExternalCi !== undefined && typeof raw.awaitingExternalCi !== 'boolean') return null;
  if (!isOptionalFiniteNumber(raw.heartbeatAt)) return null;
  if (raw.executionHealth !== undefined
    && (typeof raw.executionHealth !== 'string' || !EXECUTION_HEALTH_SET.has(raw.executionHealth))) return null;
  for (const field of [
    'role', 'ownerSessionName', 'ownerSessionLabel', 'ownerAgentType',
    'observedModel', 'observedThinking', 'observedProvider', 'poolId',
    'currentAction', 'nextAction', 'auditAttemptId', 'auditRound', 'blocker',
    'recoveryState', 'recoveryReason', 'workspaceId', 'snapshotId', 'checkpointId',
  ] as const) {
    if (!isOptionalString(raw[field])) return null;
  }
  return { ...row };
}

function normalizePools(raw: unknown): SupervisionTaskConsolePoolRow[] | null {
  if (!Array.isArray(raw)) return null;
  const pools: SupervisionTaskConsolePoolRow[] = [];
  for (const item of raw) {
    if (!isValidSupervisionTaskConsolePoolRow(item)) return null;
    pools.push({
      poolId: item.poolId,
      label: item.label,
      activeCount: item.activeCount,
      capacity: item.capacity,
    });
  }
  return pools;
}

function normalizeEventsByTask(
  raw: unknown,
): Record<string, readonly SupervisionTaskConsoleEventEvidence[]> | null {
  if (raw === undefined) return {};
  if (!isRecord(raw)) return null;
  const normalized: Record<string, readonly SupervisionTaskConsoleEventEvidence[]> = {};
  for (const [taskId, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) return null;
    const events: SupervisionTaskConsoleEventEvidence[] = [];
    for (const item of list) {
      if (!isRecord(item) || !isFiniteNumber(item.eventId) || !isFiniteNumber(item.projectionVersion)
        || typeof item.op !== 'string' || !DELTA_OP_SET.has(item.op)) {
        return null;
      }
      events.push({
        eventId: item.eventId,
        projectionVersion: item.projectionVersion,
        op: item.op as SupervisionConsoleDeltaOp,
      });
    }
    normalized[taskId] = events;
  }
  return normalized;
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
  if (!isFiniteNumber(state.projectionVersion)) return null;
  if (state.lastDurableEventId !== null && !isFiniteNumber(state.lastDurableEventId)) return null;
  if (typeof state.projectionEpoch !== 'string') return null;
  if (state.pairRevision !== null && !isFiniteNumber(state.pairRevision)) return null;
  if (typeof state.pairProjection !== 'boolean') return null;
  if (!isFiniteNumber(state.inertPairs)) return null;
  if (state.resyncGeneration !== undefined && !isFiniteNumber(state.resyncGeneration)) return null;
  if (state.lastSyncedAt !== undefined && state.lastSyncedAt !== null && !isFiniteNumber(state.lastSyncedAt)) return null;
  if (!isRecord(state.tasks) || !isRecord(state.assignments)) return null;

  const tasks: Record<string, SupervisionTaskConsoleTaskRow> = {};
  for (const [key, row] of Object.entries(state.tasks)) {
    const normalizedRow = normalizeTaskRow(key, row);
    if (!normalizedRow) return null;
    tasks[key] = normalizedRow;
  }
  const assignments: Record<string, SupervisionTaskConsoleAssignmentRow> = {};
  for (const [key, row] of Object.entries(state.assignments)) {
    const normalizedRow = normalizeAssignmentRow(key, row);
    if (!normalizedRow) return null;
    assignments[key] = normalizedRow;
  }
  const pools = normalizePools(state.pools);
  if (!pools) return null;
  const eventsByTask = normalizeEventsByTask(state.eventsByTask);
  if (!eventsByTask) return null;
  const lastSyncedAt = isFiniteNumber(state.lastSyncedAt) ? state.lastSyncedAt : null;
  const resyncGeneration = isFiniteNumber(state.resyncGeneration) ? state.resyncGeneration : 0;

  return snapshotForCache({
    schemaVersion: state.schemaVersion,
    statusContractVersion: state.statusContractVersion,
    scope: {
      projectName: authority.projectName,
      coordinatorSessionName: authority.coordinatorSessionName,
    },
    subscriptionId: null,
    phase: SUPERVISION_TASK_CONSOLE_PHASE.READY,
    hasAuthoritativeSnapshot: true,
    syncing: false,
    syncState: SUPERVISION_TASK_CONSOLE_SYNC_STATE.STALE,
    lastSyncedAt,
    projectionVersion: state.projectionVersion,
    lastDurableEventId: state.lastDurableEventId,
    projectionEpoch: state.projectionEpoch,
    pairRevision: state.pairRevision,
    pairProjection: state.pairProjection,
    inertPairs: state.inertPairs,
    tasks,
    assignments,
    eventsByTask,
    pools,
    resyncReason: null,
    resyncGeneration,
    error: null,
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
    if (!isFiniteNumber(item.accessedAt) || item.accessedAt < 0) continue;
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
  if (storageOutOfSync) return;
  const stored = readStoredProjections();
  for (const [key, entry] of stored) {
    if (clearedAuthorities.has(key) || clearedUsers.has(entry.authority.userId)) continue;
    const existing = projections.get(key);
    if (!existing || entry.accessedAt > existing.accessedAt) {
      projections.set(key, entry);
    }
  }
  evictOldestIfNeeded();
}

function tryRemovePersistedBlob(storage: Storage): boolean {
  try {
    storage.removeItem(SUPERVISION_TASK_CONSOLE_CACHE_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function persistProjections(): void {
  const storage = getCacheStorage();
  if (!storage) return;
  const sorted = [...projections.values()]
    .sort((left, right) => right.accessedAt - left.accessedAt)
    .slice(0, MAX_CACHED_AUTHORITIES);
  if (sorted.length === 0) {
    if (tryRemovePersistedBlob(storage)) {
      storageOutOfSync = false;
      clearedAuthorities.clear();
      clearedUsers.clear();
    } else {
      storageOutOfSync = true;
    }
    return;
  }
  let limit = sorted.length;
  while (limit > 0) {
    try {
      storage.setItem(SUPERVISION_TASK_CONSOLE_CACHE_STORAGE_KEY, JSON.stringify(sorted.slice(0, limit)));
      storageOutOfSync = false;
      clearedAuthorities.clear();
      clearedUsers.clear();
      return;
    } catch {
      limit = limit > 8 ? Math.floor(limit / 2) : limit - 1;
    }
  }
  // All persisted writes failed (e.g. quota exhausted): purge any pre-existing
  // blob so cleared entries cannot be resurrected from stale storage, while
  // keeping valid entries alive in memory for the current session.
  if (tryRemovePersistedBlob(storage)) {
    storageOutOfSync = false;
    clearedAuthorities.clear();
    clearedUsers.clear();
  } else {
    storageOutOfSync = true;
  }
}

export function readSupervisionTaskConsoleCache(
  authority: SupervisionTaskConsoleAuthority,
): SupervisionTaskConsoleReducerState | null {
  hydrateFromStorageOnce();
  const key = authorityKey(authority);
  let cached = projections.get(key);
  if (!cached && !storageOutOfSync && !clearedAuthorities.has(key) && !clearedUsers.has(authority.userId)) {
    const fromStorage = readStoredProjections().get(key);
    if (!fromStorage) return null;
    projections.set(key, fromStorage);
    evictOldestIfNeeded();
    cached = projections.get(key) ?? fromStorage;
  }
  if (!cached) return null;
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
  clearedAuthorities.delete(key);
  projections.set(key, { authority: { ...authority }, state: snapshotForCache(state), accessedAt: Date.now() });
  evictOldestIfNeeded();
  persistProjections();
}

export function clearSupervisionTaskConsoleCache(
  authority: SupervisionTaskConsoleAuthority,
): void {
  hydrateFromStorageOnce();
  const key = authorityKey(authority);
  projections.delete(key);
  clearedAuthorities.add(key);
  const storage = getCacheStorage();
  if (storage && !tryRemovePersistedBlob(storage)) {
    storageOutOfSync = true;
  }
  persistProjections();
}

export function clearSupervisionTaskConsoleCacheForUser(userId: string): void {
  hydrateFromStorageOnce();
  for (const [key, entry] of projections) {
    if (entry.authority.userId === userId) {
      projections.delete(key);
      clearedAuthorities.add(key);
    }
  }
  clearedUsers.add(userId);
  const storage = getCacheStorage();
  if (storage && !tryRemovePersistedBlob(storage)) {
    storageOutOfSync = true;
  }
  persistProjections();
}

export function clearAllSupervisionTaskConsoleCaches(): void {
  hydratedFromStorage = true;
  projections.clear();
  clearedAuthorities.clear();
  clearedUsers.clear();
  const storage = getCacheStorage();
  if (!storage) return;
  storageOutOfSync = !tryRemovePersistedBlob(storage);
}
