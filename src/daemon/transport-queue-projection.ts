import { createHash } from 'node:crypto';
import type { PendingTransportMessage } from '../agent/transport-session-runtime.js';
import { SUPERVISION_IMPLEMENTATION_NO_PROGRESS_ERROR } from '../../shared/agent-delegation.js';
import { deterministicSendMessageId } from '../../shared/send-message-id.js';
import { containsProhibitedQueueProjectionField } from '../../shared/transport-queue-privacy.js';
import type { QueueSnapshot, QueueSupervisionReference } from '../../shared/transport-queue-types.js';
import { getTransportQueueStore } from './transport-queue-store.js';
import type { TransportQueueStore } from './transport-queue-store.js';
import { getSession } from '../store/session-store.js';
import { getSupervisionTaskRegistry } from './supervision-state-store.js';

type SupervisionQueueAuthority = {
  taskId: string;
  status: string;
  currentRevision?: string;
  assignments?: readonly {
    assignmentId: string;
    taskId: string;
    status: string;
    role?: string;
    auditRevision?: string;
    auditAttemptId?: string;
    blocker?: string;
  }[];
  auditReceipts?: readonly { revision: string; attemptId: string }[];
};

const TERMINAL_SUPERVISION_QUEUE_TASK_STATUSES = new Set(['finalized', 'cancelled']);
const LEGACY_SUPERVISION_SCAN_PAGE_SIZE = 101;
const LEGACY_SUPERVISION_SCAN_MAX_PAGES = 4;
const IMPLEMENTER_STATUS_CANDIDATES = [
  'delegated', 'implementing', 'validated', 'ready_for_audit', 'auditing', 'rework', 'waiting_for_brain',
] as const;

/**
 * Recover metadata for rows written before the structured column existed.
 * Matching uses only deterministic daemon message ids and registry state; the
 * human-readable queue body is deliberately not an input.
 */
export function resolveLegacySupervisionQueueReference(
  clientMessageId: string,
  tasks: readonly SupervisionQueueAuthority[],
): QueueSupervisionReference | undefined {
  const matches: QueueSupervisionReference[] = [];
  for (const task of tasks) {
    for (const assignment of task.assignments ?? []) {
      const revisions = new Set([
        task.currentRevision,
        assignment.auditRevision,
        ...(task.auditReceipts ?? []).map((receipt) => receipt.revision),
      ].filter((value): value is string => Boolean(value)));
      const attempts = new Set([
        assignment.auditAttemptId,
        ...(task.auditReceipts ?? []).map((receipt) => receipt.attemptId),
      ].filter((value): value is string => Boolean(value)));
      for (const revision of revisions) {
        for (const attemptId of attempts) {
          if (deterministicSendMessageId(`auto-integration:${assignment.assignmentId}:${revision}:${attemptId}`) === clientMessageId) {
            matches.push({ kind: 'exact_integration', taskId: task.taskId, assignmentId: assignment.assignmentId, revision });
          }
        }
        if (assignment.role !== 'implementer') continue;
        for (const status of IMPLEMENTER_STATUS_CANDIDATES) {
          const fingerprint = createHash('sha256').update(JSON.stringify({
            taskId: task.taskId,
            assignmentId: assignment.assignmentId,
            revision,
            status,
            exactError: SUPERVISION_IMPLEMENTATION_NO_PROGRESS_ERROR,
          })).digest('hex');
          if (deterministicSendMessageId(`implementation-blocker:${fingerprint}`) === clientMessageId) {
            matches.push({
              kind: 'implementation_blocker', taskId: task.taskId, assignmentId: assignment.assignmentId,
              revision,
              exactError: SUPERVISION_IMPLEMENTATION_NO_PROGRESS_ERROR,
            });
          }
        }
      }
    }
  }
  const unique = new Map(matches.map((reference) => [JSON.stringify(reference), reference]));
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

function backfillLegacySupervisionQueueReferences(store: TransportQueueStore, snapshot: QueueSnapshot): boolean {
  const legacy = snapshot.failedMessageEntries.filter((entry) => !entry.supervisionReference);
  if (legacy.length === 0) return false;
  const registry = getSupervisionTaskRegistry();
  const tasks: SupervisionQueueAuthority[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LEGACY_SUPERVISION_SCAN_MAX_PAGES; page += 1) {
    const batch = registry.list({
      includeArchived: true, history: true, limit: LEGACY_SUPERVISION_SCAN_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    tasks.push(...batch);
    if (batch.length < LEGACY_SUPERVISION_SCAN_PAGE_SIZE) break;
    cursor = batch[batch.length - 1]?.taskId;
    if (!cursor) break;
  }
  let changed = false;
  for (const entry of legacy) {
    const reference = resolveLegacySupervisionQueueReference(entry.clientMessageId, tasks);
    if (reference && store.attachSupervisionReference(snapshot.sessionName, entry.clientMessageId, reference)) changed = true;
  }
  return changed;
}

export function shouldDismissObsoleteSupervisionQueueEntry(
  reference: QueueSupervisionReference,
  task: SupervisionQueueAuthority | undefined,
): boolean {
  // A missing registry object is not proof that a message is obsolete. Keep it
  // visible rather than turning a transient/unavailable registry into data loss.
  if (!task || task.taskId !== reference.taskId) return false;
  if (TERMINAL_SUPERVISION_QUEUE_TASK_STATUSES.has(task.status)) return true;
  const assignment = task.assignments?.find((candidate) => (
    candidate.assignmentId === reference.assignmentId && candidate.taskId === reference.taskId
  ));
  if (!assignment) return true;
  if (reference.kind === 'exact_integration') {
    return Boolean(
      reference.revision
      && (reference.revision !== task.currentRevision || reference.revision !== assignment.auditRevision),
    );
  }
  // A no-progress notification remains retryable only while that exact blocker
  // is still authoritative. Once the assignment advanced or carries a different
  // REWORK/blocker, retrying the old notification would resurrect stale work.
  return (Boolean(task.currentRevision) && reference.revision !== task.currentRevision)
    || (Boolean(assignment.auditRevision) && reference.revision !== assignment.auditRevision)
    || !assignment.blocker?.includes(reference.exactError);
}

export function reconcileObsoleteSupervisionQueueFailures(
  store: TransportQueueStore,
  snapshot: QueueSnapshot,
  lookupTask: (taskId: string) => SupervisionQueueAuthority | undefined,
): boolean {
  let changed = false;
  for (const entry of snapshot.failedMessageEntries) {
    const reference = entry.supervisionReference;
    if (!reference || !shouldDismissObsoleteSupervisionQueueEntry(reference, lookupTask(reference.taskId))) continue;
    store.dismissFailed(snapshot.sessionName, entry.clientMessageId);
    changed = true;
  }
  return changed;
}

export type TransportQueueSnapshotSource =
  | 'command_handler'
  | 'session_manager'
  | 'transport_pending_snapshot'
  | 'session_list'
  | 'subsession_sync'
  | 'lifecycle'
  | 'send_tool'
  | 'p2p_orchestrator'
  | 'openspec_auto_deliver'
  | 'timeline_emitter'
  | 'server_bridge'
  | 'test'
  | string;

export interface LegacyTransportPendingMessageEntry {
  clientMessageId: string;
  text: string;
}

export interface LegacyTransportPendingQueueSnapshot {
  pendingMessages: string[];
  pendingEntries: LegacyTransportPendingMessageEntry[];
  failedEntries: LegacyTransportPendingMessageEntry[];
  pendingVersion: number;
  queueEpoch: string;
  queueAuthorityId: string;
  queueSnapshot: QueueSnapshot;
  source: 'sqlite';
}

export interface TransportPendingRuntimeSnapshot {
  pendingMessages?: string[];
  pendingEntries?: PendingTransportMessage[];
  pendingVersion?: number;
}

export type TransportQueueSnapshotPayload = {
  queueSnapshot: QueueSnapshot;
  queueEpoch: QueueSnapshot['queueEpoch'];
  queueAuthorityId: QueueSnapshot['queueAuthorityId'];
  pendingMessageVersion: QueueSnapshot['pendingMessageVersion'];
  /** Exact diagnostic alias; authority still requires epoch + authority id + version. */
  pendingCount: number;
  pendingMessageEntries: QueueSnapshot['pendingMessageEntries'];
  failedMessageEntries: QueueSnapshot['failedMessageEntries'];
  resetReason?: QueueSnapshot['resetReason'];
  dropReason?: QueueSnapshot['dropReason'];
  activityGeneration?: QueueSnapshot['activityGeneration'];
  degraded?: QueueSnapshot['degraded'];
  degradedReason?: QueueSnapshot['degradedReason'];
};

export function buildTransportQueueSnapshot(
  sessionName: string,
  source: TransportQueueSnapshotSource,
): QueueSnapshot {
  const store = getTransportQueueStore();
  const record = getSession(sessionName);
  const hasInstance = typeof record?.sessionInstanceId === 'string' && record.sessionInstanceId.length > 0;
  const hasEpoch = typeof record?.runtimeEpoch === 'string' && record.runtimeEpoch.length > 0;
  let snapshot = record && hasInstance === hasEpoch
    ? store.readSnapshotSafelyForRecipient(
        sessionName,
        hasInstance && hasEpoch
          ? { sessionInstanceId: record.sessionInstanceId!, runtimeEpoch: record.runtimeEpoch! }
          : null,
        source,
      )
    : store.readSnapshotSafely(sessionName, source);
  try {
    if (backfillLegacySupervisionQueueReferences(store, snapshot)) {
      snapshot = record && hasInstance === hasEpoch
        ? store.readSnapshotSafelyForRecipient(
            sessionName,
            hasInstance && hasEpoch
              ? { sessionInstanceId: record.sessionInstanceId!, runtimeEpoch: record.runtimeEpoch! }
              : null,
            source,
          )
        : store.readSnapshotSafely(sessionName, source);
    }
    const changed = reconcileObsoleteSupervisionQueueFailures(
      store,
      snapshot,
      (taskId) => getSupervisionTaskRegistry().get(taskId),
    );
    if (changed) {
      // Re-apply the recipient gate after mutation. dismissFailed returns a
      // store-wide snapshot, which must never become a public cross-generation
      // projection merely because a stale supervision card was retired.
      snapshot = record && hasInstance === hasEpoch
        ? store.readSnapshotSafelyForRecipient(
            sessionName,
            hasInstance && hasEpoch
              ? { sessionInstanceId: record.sessionInstanceId!, runtimeEpoch: record.runtimeEpoch! }
              : null,
            source,
          )
        : store.readSnapshotSafely(sessionName, source);
    }
  } catch {
    // Queue projection remains fail-closed: an unavailable registry never
    // authorizes deletion. Re-read because an earlier item in this bounded pass
    // may already have been durably dismissed before a later lookup failed.
    snapshot = record && hasInstance === hasEpoch
      ? store.readSnapshotSafelyForRecipient(
          sessionName,
          hasInstance && hasEpoch
            ? { sessionInstanceId: record.sessionInstanceId!, runtimeEpoch: record.runtimeEpoch! }
            : null,
          source,
        )
      : store.readSnapshotSafely(sessionName, source);
  }
  // A partial persisted identity proves no recipient at all. Preserve authority
  // metadata for convergence, but never expose queue text across that boundary.
  if (record && hasInstance !== hasEpoch) {
    return { ...snapshot, pendingMessageEntries: [], failedMessageEntries: [] };
  }
  if (containsProhibitedQueueProjectionField(snapshot)) {
    return {
      type: 'transport.queue.snapshot',
      sessionName: snapshot.sessionName,
      queueEpoch: snapshot.queueEpoch,
      queueAuthorityId: snapshot.queueAuthorityId,
      pendingMessageVersion: snapshot.pendingMessageVersion,
      pendingMessageEntries: [],
      failedMessageEntries: [],
      source,
      degraded: true,
      degradedReason: 'queue_projection_privacy_violation',
    };
  }
  return snapshot;
}

export function transportQueueSnapshotToPayload(snapshot: QueueSnapshot): TransportQueueSnapshotPayload {
  return {
    queueSnapshot: snapshot,
    queueEpoch: snapshot.queueEpoch,
    queueAuthorityId: snapshot.queueAuthorityId,
    pendingMessageVersion: snapshot.pendingMessageVersion,
    pendingCount: snapshot.pendingMessageEntries.length,
    pendingMessageEntries: snapshot.pendingMessageEntries,
    failedMessageEntries: snapshot.failedMessageEntries,
    ...(snapshot.resetReason ? { resetReason: snapshot.resetReason } : {}),
    ...(snapshot.dropReason ? { dropReason: snapshot.dropReason } : {}),
    ...(snapshot.activityGeneration !== undefined ? { activityGeneration: snapshot.activityGeneration } : {}),
    ...(snapshot.degraded !== undefined ? { degraded: snapshot.degraded } : {}),
    ...(snapshot.degradedReason ? { degradedReason: snapshot.degradedReason } : {}),
  };
}

export function buildTransportQueueSnapshotPayload(
  sessionName: string,
  source: TransportQueueSnapshotSource,
): TransportQueueSnapshotPayload {
  return transportQueueSnapshotToPayload(buildTransportQueueSnapshot(sessionName, source));
}

export function buildLegacyTransportPendingQueueSnapshot(
  sessionName: string,
  source: TransportQueueSnapshotSource,
): LegacyTransportPendingQueueSnapshot {
  const snapshot = buildTransportQueueSnapshot(sessionName, source);
  return {
    pendingMessages: snapshot.pendingMessageEntries.map((entry) => entry.text),
    pendingEntries: snapshot.pendingMessageEntries.map((entry) => ({
      clientMessageId: entry.clientMessageId,
      text: entry.text,
    })),
    failedEntries: snapshot.failedMessageEntries.map((entry) => ({
      clientMessageId: entry.clientMessageId,
      text: entry.text,
    })),
    pendingVersion: snapshot.pendingMessageVersion,
    queueEpoch: snapshot.queueEpoch,
    queueAuthorityId: snapshot.queueAuthorityId,
    queueSnapshot: snapshot,
    source: 'sqlite',
  };
}
