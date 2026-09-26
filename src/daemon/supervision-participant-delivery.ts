import {
  SUPERVISION_AUDIT_HEARTBEAT_AUTOMATION_KIND,
  SUPERVISION_CONTRACT_IDS,
  SUPERVISION_IMPLEMENTATION_HEARTBEAT_AUTOMATION_KIND,
  isTerminalSupervisionTaskStatus,
} from '../../shared/supervision-config.js';
import {
  SUPERVISION_IMPLEMENTATION_CONTINUATION_EXHAUSTED_ERROR,
  SUPERVISION_IMPLEMENTATION_NO_PROGRESS_ERROR,
} from '../../shared/agent-delegation.js';
import { deterministicSendMessageId } from '../../shared/send-message-id.js';
import { isAssignmentStartRefusalError } from '../../shared/supervision-assignment-start.js';
import type { QueueSupervisionAdmission, QueueSupervisionReference } from '../../shared/transport-queue-types.js';
import { getSession, listSessions, type SessionRecord } from '../store/session-store.js';
import { resolvePeerAuditProviderFamily } from './peer-audit-candidates.js';
import {
  getSupervisionTaskRegistry,
  isSupervisionAssignmentContinuable,
  matchesDurableSupervisionParticipant,
  type PersistedSupervisionTaskAssignment,
  type PersistedSupervisionTaskAssignmentIdentity,
} from './supervision-state-store.js';

export const IMPLEMENTATION_HEARTBEAT_MESSAGE_ID_PREFIX = `${SUPERVISION_IMPLEMENTATION_HEARTBEAT_AUTOMATION_KIND}:`;
export const AUDIT_HEARTBEAT_MESSAGE_ID_PREFIX = `${SUPERVISION_AUDIT_HEARTBEAT_AUTOMATION_KIND}:`;
export const IMPLEMENTATION_HEARTBEAT_RUNTIME_RETRY_LIMIT = 6;
export type ImplementationHeartbeatAuthorityResult =
  | { status: 'authorized' }
  | { status: 'transient_unavailable' }
  | { status: 'quarantined' };
export type QueuedSupervisionAdmission = QueueSupervisionAdmission;

/** One durable project+session visibility predicate shared by sends and delivery. */
export function isExactContinuationEligible(input: {
  taskProjectName?: string;
  taskCurrentRevision?: string;
  assignment: Pick<PersistedSupervisionTaskAssignment,
    'role' | 'status' | 'required' | 'auditAttemptId' | 'auditRevision' | 'identity'>;
  targetProjectName?: string;
  targetIdentity: Partial<PersistedSupervisionTaskAssignmentIdentity>;
}): boolean {
  const { assignment, targetIdentity } = input;
  return matchesDurableSupervisionParticipant({
    taskProjectName: input.taskProjectName,
    assignmentSessionName: assignment.identity.sessionName,
    candidateProjectName: input.targetProjectName,
    candidateSessionName: targetIdentity.sessionName,
  }) && isSupervisionAssignmentContinuable({
    taskCurrentRevision: input.taskCurrentRevision,
    assignment,
  });
}

export function liveSupervisionIdentity(session: SessionRecord): PersistedSupervisionTaskAssignmentIdentity | undefined {
  if (session.state === 'stopped' || !session.name.trim()) return undefined;
  return {
    sessionName: session.name,
    sessionInstanceId: session.sessionInstanceId?.trim() ?? '',
    runtimeEpoch: session.runtimeEpoch?.trim() ?? '',
    agentType: session.agentType,
    providerFamily: resolvePeerAuditProviderFamily(session),
  };
}

function assignmentOwnsDurableTarget(input: {
  taskProjectName: string;
  taskCurrentRevision?: string;
  assignment: PersistedSupervisionTaskAssignment;
  target: SessionRecord;
}): boolean {
  const targetIdentity = liveSupervisionIdentity(input.target);
  return Boolean(targetIdentity) && isExactContinuationEligible({
    taskProjectName: input.taskProjectName,
    taskCurrentRevision: input.taskCurrentRevision,
    assignment: input.assignment,
    targetProjectName: input.target.projectName,
    targetIdentity: targetIdentity ?? {},
  });
}

function parkUnresolvedOnce(
  taskId: string,
  assignment: PersistedSupervisionTaskAssignment,
  candidateCount: number,
  now: number,
): void {
  if (assignment.blocker?.trim()) return;
  const kind = assignment.role === 'auditor'
    ? 'audit_heartbeat_identity_rebind_required'
    : 'implementation_heartbeat_identity_rebind_required';
  getSupervisionTaskRegistry().updateAssignment({
    assignmentId: assignment.assignmentId,
    identity: assignment.identity,
    blocker: JSON.stringify({
      kind,
      taskId,
      assignmentId: assignment.assignmentId,
      candidateCount,
      action: 'same_object_authoritative_rebind',
    }),
    now,
  });
}

function parkRevisionConflictOnce(
  taskId: string,
  assignment: PersistedSupervisionTaskAssignment,
  taskRevision: string | undefined,
  now: number,
): void {
  if (assignment.blocker?.trim()) return;
  getSupervisionTaskRegistry().updateAssignment({
    assignmentId: assignment.assignmentId,
    identity: assignment.identity,
    blocker: JSON.stringify({
      kind: 'implementation_heartbeat_revision_conflict',
      taskId,
      assignmentId: assignment.assignmentId,
      taskCurrentRevision: taskRevision ?? null,
      assignmentRevision: assignment.auditRevision ?? null,
      action: 'same_object_revision_reconcile',
    }),
    now,
  });
}

export function parkTransientRuntimeExhaustedOnce(input: {
  taskId: string;
  assignmentId: string;
  retryCount: number;
  now?: number;
}): void {
  const assignment = getSupervisionTaskRegistry().getAssignment(input.assignmentId);
  if (!assignment || assignment.taskId !== input.taskId || assignment.blocker?.trim()) return;
  const kind = assignment.role === 'auditor'
    ? 'audit_heartbeat_runtime_unavailable'
    : 'implementation_heartbeat_runtime_unavailable';
  getSupervisionTaskRegistry().updateAssignment({
    assignmentId: assignment.assignmentId,
    identity: assignment.identity,
    blocker: JSON.stringify({
      kind,
      taskId: input.taskId,
      assignmentId: input.assignmentId,
      retryCount: input.retryCount,
      action: 'same_object_runtime_rehydrate',
    }),
    now: input.now,
  });
}

/**
 * Resolve/rebind the assignment first, then authorize the concrete runtime.
 * An arbitrary ready session can never substitute for this exact target.
 */
export function resolveImplementationHeartbeatDelivery(input: {
  taskId: string;
  assignmentId: string;
  targetSessionName: string;
  /** Implementer continuations preserve every runtime fencing field. */
  requireExactIdentity?: boolean;
  now?: number;
}): ImplementationHeartbeatAuthorityResult {
  const registry = getSupervisionTaskRegistry();
  const assignment = registry.getAssignment(input.assignmentId);
  const task = registry.getTaskRecord(input.taskId);
  if (!assignment || !task || assignment.taskId !== task.taskId) return { status: 'quarantined' };
  // A delayed/replayed wake must never mutate a terminal object. Its durable
  // terminal state is already the authoritative explanation for rejection.
  if (isTerminalSupervisionTaskStatus(task.status)
    || isTerminalSupervisionTaskStatus(assignment.status)) return { status: 'quarantined' };
  if (input.targetSessionName !== assignment.identity.sessionName) {
    parkUnresolvedOnce(input.taskId, assignment, 0, input.now ?? Date.now());
    return { status: 'quarantined' };
  }
  const candidates = listSessions().flatMap((session) => {
    const identity = liveSupervisionIdentity(session);
    return identity && session.projectName?.trim()
      ? [{ projectName: session.projectName.trim(), identity }]
      : [];
  });
  // No registered runtime with the durable session name is a transient
  // absence. The watchdog owns bounded backoff; do not turn this into the
  // permanent non-participant quarantine used for a conflicting project.
  const sameSession = candidates.filter((candidate) => (
    candidate.identity.sessionName === assignment.identity.sessionName
  ));
  if (sameSession.length === 0) return { status: 'transient_unavailable' };
  if (input.requireExactIdentity) {
    const exact = sameSession.filter((candidate) => (
      candidate.projectName === task.projectName
      && candidate.identity.sessionInstanceId === assignment.identity.sessionInstanceId
      && candidate.identity.runtimeEpoch === assignment.identity.runtimeEpoch
      && candidate.identity.agentType === assignment.identity.agentType
      && candidate.identity.providerFamily === assignment.identity.providerFamily
    ));
    if (exact.length !== 1) {
      parkUnresolvedOnce(input.taskId, assignment, exact.length, input.now ?? Date.now());
      return { status: 'quarantined' };
    }
    if (task.currentRevision && assignment.auditRevision
      && task.currentRevision !== assignment.auditRevision) {
      parkRevisionConflictOnce(input.taskId, assignment, task.currentRevision, input.now ?? Date.now());
      return { status: 'quarantined' };
    }
    if (!isExactContinuationEligible({
      taskProjectName: task.projectName,
      taskCurrentRevision: task.currentRevision,
      assignment,
      targetProjectName: exact[0]?.projectName,
      targetIdentity: exact[0]?.identity ?? {},
    })) {
      parkUnresolvedOnce(input.taskId, assignment, exact.length, input.now ?? Date.now());
      return { status: 'quarantined' };
    }
    return { status: 'authorized' };
  }
  const converged = registry.convergeImplementationHeartbeatTarget({
    taskId: input.taskId,
    assignmentId: input.assignmentId,
    candidates,
    now: input.now,
  });
  if (!converged.ok) {
    parkUnresolvedOnce(input.taskId, assignment, sameSession.length, input.now ?? Date.now());
    return { status: 'quarantined' };
  }
  const target = getSession(input.targetSessionName);
  const targetIdentity = target && liveSupervisionIdentity(target);
  return targetIdentity && isExactContinuationEligible({
    taskProjectName: task.projectName,
    taskCurrentRevision: task.currentRevision,
    assignment: converged.value,
    targetProjectName: target?.projectName,
    targetIdentity,
  }) ? { status: 'authorized' } : { status: 'quarantined' };
}

export function authorizeImplementationHeartbeatDelivery(input: {
  taskId: string;
  assignmentId: string;
  targetSessionName: string;
  requireExactIdentity?: boolean;
  now?: number;
}): boolean {
  return resolveImplementationHeartbeatDelivery(input).status === 'authorized';
}

type HeartbeatBinding = {
  kind: 'implementation' | 'audit';
  taskId: string;
  assignmentId: string;
  revision?: string;
  auditAttemptId?: string;
  auditRevision?: string;
};

function parseHeartbeatBinding(text: string): HeartbeatBinding | undefined {
  try {
    const value = JSON.parse(text) as {
      contractRefs?: unknown;
      binding?: {
        taskId?: unknown;
        assignmentId?: unknown;
        auditAttemptId?: unknown;
        auditRevision?: unknown;
        revision?: unknown;
      };
      action?: unknown;
    };
    if (!Array.isArray(value.contractRefs)
      || typeof value.binding?.taskId !== 'string'
      || typeof value.binding.assignmentId !== 'string') return undefined;
    if (value.contractRefs.includes(SUPERVISION_CONTRACT_IDS.IMPLEMENTATION_HEARTBEAT)
      && value.action === 'advance_safe_unfinished') {
      return {
        kind: 'implementation', taskId: value.binding.taskId, assignmentId: value.binding.assignmentId,
        ...(typeof value.binding.revision === 'string' ? { revision: value.binding.revision } : {}),
      };
    }
    if (value.contractRefs.includes(SUPERVISION_CONTRACT_IDS.AUDIT_HEARTBEAT)
      && value.action === 'complete_exact_audit'
      && typeof value.binding.auditAttemptId === 'string'
      && typeof value.binding.auditRevision === 'string') {
      return {
        kind: 'audit',
        taskId: value.binding.taskId,
        assignmentId: value.binding.assignmentId,
        auditAttemptId: value.binding.auditAttemptId,
        auditRevision: value.binding.auditRevision,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseAuthorityRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify the final delivery edge. `stale` is an irreversible authority
 * mismatch and may be discarded; `retry` means durable authority still exists
 * but its live/runtime projection is temporarily unavailable.
 */
export function resolveQueuedSupervisionHeartbeatDelivery(input: {
  targetSessionName: string;
  clientMessageId: string;
  text: string;
  supervisionReference?: QueueSupervisionReference;
  now?: number;
}): QueuedSupervisionAdmission {
  if (input.supervisionReference) {
    try {
      const registry = getSupervisionTaskRegistry();
      const reference = input.supervisionReference;
      const task = registry.getTaskRecord(reference.taskId);
      const snapshot = registry.get(reference.taskId);
      const assignment = registry.getAssignment(reference.assignmentId);
      if (!task || !snapshot || !assignment || assignment.taskId !== task.taskId) return 'stale';
      const durableRevision = task.currentRevision ?? assignment.auditRevision ?? '';
      if (durableRevision !== reference.revision) return 'stale';
      if (isTerminalSupervisionTaskStatus(task.status)
        || isTerminalSupervisionTaskStatus(assignment.status)) return 'stale';

      if (reference.kind === 'implementation_blocker') {
        // Prove durable structural ownership before consulting its transient
        // live projection. A lagging/terminal/missing owner can never converge
        // through retry; only an otherwise-eligible owner's absent runtime can.
        const durableCoordinators = snapshot.assignments.filter((candidate) => (
          candidate.role === 'coordinator'
          && candidate.identity.sessionName === input.targetSessionName
          && isSupervisionAssignmentContinuable({
            taskCurrentRevision: task.currentRevision,
            assignment: candidate,
          })
        ));
        if (durableCoordinators.length !== 1) return 'stale';
        const target = getSession(input.targetSessionName);
        if (!target || target.state === 'stopped') return 'retry';
        if (target.role !== 'brain') return 'stale';
        if (!assignmentOwnsDurableTarget({
          taskProjectName: task.projectName,
          taskCurrentRevision: task.currentRevision,
          assignment: durableCoordinators[0]!,
          target,
        })) return 'stale';
        // Implementer dispositions persisted on the assignment itself. A refused
        // automatic start holds a still-delegated assignment; the no-progress
        // dispositions describe work that started. Each is admitted only while
        // its exact durable blocker still stands under its own lifecycle status.
        const startRefusal = isAssignmentStartRefusalError(reference.exactError);
        if (startRefusal
          || reference.exactError === SUPERVISION_IMPLEMENTATION_NO_PROGRESS_ERROR
          || reference.exactError === SUPERVISION_IMPLEMENTATION_CONTINUATION_EXHAUSTED_ERROR) {
          const heldStatus = startRefusal ? 'delegated' : 'implementing';
          if (assignment.role !== 'implementer' || assignment.status !== heldStatus
            || !assignment.blocker) return 'stale';
          const blocker = parseAuthorityRecord(assignment.blocker);
          if (!blocker) return 'stale';
          if (blocker.taskId !== reference.taskId
            || blocker.assignmentId !== reference.assignmentId
            || blocker.exactError !== reference.exactError
            || typeof blocker.blockerFingerprint !== 'string'
            || deterministicSendMessageId(`implementation-blocker:${blocker.blockerFingerprint}`)
              !== input.clientMessageId) return 'stale';
          return 'authorized';
        }

        if (task.blocker !== assignment.blocker || !task.blocker) return 'stale';
        const blocker = parseAuthorityRecord(task.blocker);
        if (!blocker) return 'stale';
        if (blocker.kind !== 'automatic_audit_routing'
          || blocker.taskId !== reference.taskId
          || blocker.assignmentId !== reference.assignmentId
          || (typeof blocker.revision === 'string' ? blocker.revision : '') !== durableRevision
          || blocker.exactError !== reference.exactError) return 'stale';
        return 'authorized';
      }

      if (reference.kind === 'exact_integration') {
        if (task.status !== 'ready_for_integration'
          || task.integrationOwnerAssignmentId !== assignment.assignmentId
          || assignment.role !== 'integration_owner'
          || assignment.status !== 'ready_for_integration') return 'stale';
        const target = getSession(input.targetSessionName);
        if (!target || target.state === 'stopped') return 'retry';
        if (target.role !== 'brain') return 'stale';
        return assignmentOwnsDurableTarget({
          taskProjectName: task.projectName,
          taskCurrentRevision: task.currentRevision,
          assignment,
          target,
        }) ? 'authorized' : 'stale';
      }
      return 'stale';
    } catch {
      // Only failures thrown by registry/session storage reach this boundary.
      // Malformed durable blocker bytes are parsed above and classified stale,
      // because no amount of retry can recreate the superseded authority.
      return 'retry';
    }
  }

  const looksLikeImplementation = input.clientMessageId.startsWith(IMPLEMENTATION_HEARTBEAT_MESSAGE_ID_PREFIX);
  const looksLikeAudit = input.clientMessageId.startsWith(AUDIT_HEARTBEAT_MESSAGE_ID_PREFIX);
  const looksLikeHeartbeat = looksLikeImplementation || looksLikeAudit;
  const binding = parseHeartbeatBinding(input.text);
  if (!looksLikeHeartbeat && !binding) return 'authorized';
  if (!looksLikeHeartbeat || !binding) return 'stale';
  try {
    const registry = getSupervisionTaskRegistry();
    const assignment = registry.getAssignment(binding.assignmentId);
    const task = registry.getTaskRecord(binding.taskId);
    if (!assignment || !task || assignment.taskId !== task.taskId) return 'stale';
    if (binding.kind === 'implementation') {
      if (!looksLikeImplementation || assignment.role !== 'implementer') return 'stale';
      const durableRevision = task.currentRevision ?? assignment.auditRevision;
      if (binding.revision !== durableRevision) return 'stale';
    } else if (!looksLikeAudit
      || assignment.role !== 'auditor'
      || assignment.auditAttemptId !== binding.auditAttemptId
      || assignment.auditRevision !== binding.auditRevision) return 'stale';
    // The shared continuation predicate in the authority resolver below is
    // the single task-current-revision fence. Keeping a second copy here made
    // one of the two guards mutation-invisible and allowed the two call sites
    // to drift without a load-bearing test.
    const resolved = resolveImplementationHeartbeatDelivery({
      taskId: binding.taskId,
      assignmentId: binding.assignmentId,
      targetSessionName: input.targetSessionName,
      ...(binding.kind === 'implementation' ? { requireExactIdentity: true } : {}),
      now: input.now,
    });
    return resolved.status === 'authorized'
      ? 'authorized'
      : resolved.status === 'transient_unavailable' ? 'retry' : 'stale';
  } catch {
    // A registry outage is not authority. Preserve fail-closed delivery for the
    // control message while leaving ordinary queued user traffic untouched.
    return 'retry';
  }
}

/** Boolean compatibility wrapper for callers that cannot retain retry state. */
export function authorizeQueuedSupervisionHeartbeatDelivery(
  input: Parameters<typeof resolveQueuedSupervisionHeartbeatDelivery>[0],
): boolean {
  return resolveQueuedSupervisionHeartbeatDelivery(input) === 'authorized';
}
