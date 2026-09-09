import {
  SUPERVISION_CONTRACT_IDS,
} from '../../shared/supervision-config.js';
import { getSession, listSessions, type SessionRecord } from '../store/session-store.js';
import { resolvePeerAuditProviderFamily } from './peer-audit-candidates.js';
import {
  getSupervisionTaskRegistry,
  isSupervisionAssignmentContinuable,
  matchesDurableSupervisionParticipant,
  type PersistedSupervisionTaskAssignment,
  type PersistedSupervisionTaskAssignmentIdentity,
} from './supervision-state-store.js';

export const IMPLEMENTATION_HEARTBEAT_MESSAGE_ID_PREFIX = 'supervision-implementation-heartbeat:';
export const AUDIT_HEARTBEAT_MESSAGE_ID_PREFIX = 'supervision-audit-heartbeat:';
export const IMPLEMENTATION_HEARTBEAT_RUNTIME_RETRY_LIMIT = 6;
export type ImplementationHeartbeatAuthorityResult =
  | { status: 'authorized' }
  | { status: 'transient_unavailable' }
  | { status: 'quarantined' };

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

function liveIdentity(session: SessionRecord): PersistedSupervisionTaskAssignmentIdentity | undefined {
  if (session.state === 'stopped' || !session.name.trim()) return undefined;
  return {
    sessionName: session.name,
    sessionInstanceId: session.sessionInstanceId?.trim() ?? '',
    runtimeEpoch: session.runtimeEpoch?.trim() ?? '',
    agentType: session.agentType,
    providerFamily: resolvePeerAuditProviderFamily(session),
  };
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
  now?: number;
}): ImplementationHeartbeatAuthorityResult {
  const registry = getSupervisionTaskRegistry();
  const assignment = registry.getAssignment(input.assignmentId);
  const task = registry.getTaskRecord(input.taskId);
  if (!assignment || !task || assignment.taskId !== task.taskId) return { status: 'quarantined' };
  if (input.targetSessionName !== assignment.identity.sessionName) {
    parkUnresolvedOnce(input.taskId, assignment, 0, input.now ?? Date.now());
    return { status: 'quarantined' };
  }
  const candidates = listSessions().flatMap((session) => {
    const identity = liveIdentity(session);
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
  const targetIdentity = target && liveIdentity(target);
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
  now?: number;
}): boolean {
  return resolveImplementationHeartbeatDelivery(input).status === 'authorized';
}

type HeartbeatBinding = {
  kind: 'implementation' | 'audit';
  taskId: string;
  assignmentId: string;
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
      };
      action?: unknown;
    };
    if (!Array.isArray(value.contractRefs)
      || typeof value.binding?.taskId !== 'string'
      || typeof value.binding.assignmentId !== 'string') return undefined;
    if (value.contractRefs.includes(SUPERVISION_CONTRACT_IDS.IMPLEMENTATION_HEARTBEAT)
      && value.action === 'advance_safe_unfinished') {
      return { kind: 'implementation', taskId: value.binding.taskId, assignmentId: value.binding.assignmentId };
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

/** Gate both live FIFO drains and restart resend drains. Non-heartbeat traffic is untouched. */
export function authorizeQueuedSupervisionHeartbeatDelivery(input: {
  targetSessionName: string;
  clientMessageId: string;
  text: string;
  now?: number;
}): boolean {
  const looksLikeImplementation = input.clientMessageId.startsWith(IMPLEMENTATION_HEARTBEAT_MESSAGE_ID_PREFIX);
  const looksLikeAudit = input.clientMessageId.startsWith(AUDIT_HEARTBEAT_MESSAGE_ID_PREFIX);
  const looksLikeHeartbeat = looksLikeImplementation || looksLikeAudit;
  const binding = parseHeartbeatBinding(input.text);
  if (!looksLikeHeartbeat && !binding) return true;
  if (!looksLikeHeartbeat || !binding) return false;
  try {
    const registry = getSupervisionTaskRegistry();
    const assignment = registry.getAssignment(binding.assignmentId);
    const task = registry.getTaskRecord(binding.taskId);
    if (!assignment || !task || assignment.taskId !== task.taskId) return false;
    if (binding.kind === 'implementation') {
      if (!looksLikeImplementation || assignment.role !== 'implementer') return false;
    } else if (!looksLikeAudit
      || assignment.role !== 'auditor'
      || assignment.auditAttemptId !== binding.auditAttemptId
      || assignment.auditRevision !== binding.auditRevision) return false;
    // The shared continuation predicate in the authority resolver below is
    // the single task-current-revision fence. Keeping a second copy here made
    // one of the two guards mutation-invisible and allowed the two call sites
    // to drift without a load-bearing test.
    return authorizeImplementationHeartbeatDelivery({
      taskId: binding.taskId,
      assignmentId: binding.assignmentId,
      targetSessionName: input.targetSessionName,
      now: input.now,
    });
  } catch {
    // A registry outage is not authority. Preserve fail-closed delivery for the
    // control message while leaving ordinary queued user traffic untouched.
    return false;
  }
}
