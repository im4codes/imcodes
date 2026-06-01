import type { SessionRecord } from '../store/session-store.js';
import { isKnownTestSessionLike } from '../../shared/test-session-guard.js';
import {
  WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON,
  WORKER_SESSION_SNAPSHOT_VERSION,
  WORKER_SESSION_SYNC_STATUS,
  type WorkerSessionSnapshot,
  type WorkerSessionSyncStatus,
  type WorkerSubSessionSnapshot,
  normalizeWorkerSessionRows,
  normalizeWorkerSubSessionRows,
} from '../../shared/worker-session-snapshot.js';

export type WorkerSessionSyncPlanInput =
  | { source: 'snapshot'; response: unknown }
  | { source: 'legacy'; sessions: unknown; subSessions: unknown; reason?: string };

export interface WorkerSessionSyncPlan {
  status: WorkerSessionSyncStatus;
  retryable: boolean;
  reason?: string;
  snapshotComplete: boolean;
  remoteSessionCount: number;
  remoteSubSessionCount: number;
  syncedCount: number;
  pendingMissingCount: number;
  issues: string[];
  mainUpserts: WorkerSessionSnapshot[];
  remoteTestSessions: WorkerSessionSnapshot[];
  remoteTestSubSessions: WorkerSubSessionSnapshot[];
  remoteMainExistenceNames: string[];
  remoteSubSessionNames: string[];
  startupPushAllowedNames: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function emptyDegradedPlan(reason: string, issues: string[] = []): WorkerSessionSyncPlan {
  return {
    status: WORKER_SESSION_SYNC_STATUS.DEGRADED,
    retryable: true,
    reason,
    snapshotComplete: false,
    remoteSessionCount: 0,
    remoteSubSessionCount: 0,
    syncedCount: 0,
    pendingMissingCount: 0,
    issues,
    mainUpserts: [],
    remoteTestSessions: [],
    remoteTestSubSessions: [],
    remoteMainExistenceNames: [],
    remoteSubSessionNames: [],
    startupPushAllowedNames: [],
  };
}

export function buildWorkerSessionSyncPlan(
  input: WorkerSessionSyncPlanInput,
  expectedServerId: string,
  localSessions: SessionRecord[],
): WorkerSessionSyncPlan {
  let sessionsInput: unknown;
  let subSessionsInput: unknown;
  let snapshotComplete = false;
  let status: WorkerSessionSyncStatus = WORKER_SESSION_SYNC_STATUS.DEGRADED;
  let retryable = true;
  let reason: string | undefined = input.source === 'legacy'
    ? (input.reason ?? WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON.LEGACY_RESPONSE)
    : WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON.INCOMPLETE_RESPONSE;

  if (input.source === 'legacy') {
    sessionsInput = input.sessions;
    subSessionsInput = input.subSessions;
  } else {
    const response = input.response;
    if (!isRecord(response)) {
      return emptyDegradedPlan(WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON.INVALID_ROW, ['snapshot: expected object']);
    }
    const responseServerId = response.serverId;
    if (typeof responseServerId === 'string' && responseServerId !== expectedServerId) {
      return emptyDegradedPlan(WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON.SERVER_ID_MISMATCH, [
        `snapshot.serverId: expected ${expectedServerId}, got ${responseServerId}`,
      ]);
    }
    if (response.complete !== true) {
      return emptyDegradedPlan(
        typeof response.reason === 'string' ? response.reason : WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON.INCOMPLETE_RESPONSE,
      );
    }
    if (response.version !== WORKER_SESSION_SNAPSHOT_VERSION) {
      return emptyDegradedPlan(WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON.INVALID_ROW, ['snapshot.version: unsupported']);
    }
    if (responseServerId !== expectedServerId) {
      return emptyDegradedPlan(WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON.SERVER_ID_MISMATCH, [
        'snapshot.serverId: missing or mismatched',
      ]);
    }
    sessionsInput = response.sessions;
    subSessionsInput = response.subSessions;
    snapshotComplete = true;
    status = WORKER_SESSION_SYNC_STATUS.APPLIED;
    retryable = false;
    reason = undefined;
  }

  const sessions = normalizeWorkerSessionRows(sessionsInput);
  const subSessions = normalizeWorkerSubSessionRows(subSessionsInput);
  if (!sessions.ok || !subSessions.ok) {
    return emptyDegradedPlan(WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON.INVALID_ROW, [
      ...sessions.issues,
      ...subSessions.issues,
    ]);
  }

  const remoteTestSessions = sessions.rows.filter((session) => isKnownTestSessionLike({
    name: session.name,
    projectName: session.project_name,
    projectDir: session.project_dir,
  }));
  const remoteTestSubSessions = subSessions.rows.filter((subSession) => isKnownTestSessionLike({
    name: subSession.id ? `deck_sub_${subSession.id}` : undefined,
    cwd: subSession.cwd,
    parentSession: subSession.parent_session,
  }));
  const nonTestSessions = sessions.rows.filter((session) => !isKnownTestSessionLike({
    name: session.name,
    projectName: session.project_name,
    projectDir: session.project_dir,
  }));
  const nonTestSubSessions = subSessions.rows.filter((subSession) => !isKnownTestSessionLike({
    name: subSession.id ? `deck_sub_${subSession.id}` : undefined,
    cwd: subSession.cwd,
    parentSession: subSession.parent_session,
  }));
  const remoteMainExistenceNames = Array.from(new Set(nonTestSessions.map((session) => session.name)));
  const remoteSubSessionNames = Array.from(new Set(nonTestSubSessions.map((subSession) => `deck_sub_${subSession.id}`)));
  const remoteMainExistence = new Set(remoteMainExistenceNames);
  const remoteSubExistence = new Set(remoteSubSessionNames);
  const pendingMissingCount = localSessions.filter((session) => {
    if (session.name.startsWith('deck_sub_')) return !remoteSubExistence.has(session.name);
    return !remoteMainExistence.has(session.name);
  }).length;
  const mainUpserts = nonTestSessions.filter((session) => session.state !== 'stopped');

  return {
    status,
    retryable,
    reason,
    snapshotComplete,
    remoteSessionCount: remoteMainExistenceNames.length,
    remoteSubSessionCount: remoteSubSessionNames.length,
    syncedCount: mainUpserts.length,
    pendingMissingCount,
    issues: [],
    mainUpserts,
    remoteTestSessions,
    remoteTestSubSessions,
    remoteMainExistenceNames,
    remoteSubSessionNames,
    startupPushAllowedNames: snapshotComplete ? remoteMainExistenceNames : [],
  };
}
