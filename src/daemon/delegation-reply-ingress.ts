import {
  AGENT_DELEGATION_COMPLETION_NOTIFICATION_MARKER,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
  AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
  AGENT_DELEGATION_REPLY_ERRORS,
  AGENT_DELEGATION_REPLY_STATUSES,
  decodeAgentDelegationReplyEnvelope,
  type AgentDelegationReplyEnvelope,
  type AgentDelegationReplyError,
} from '../../shared/agent-delegation.js';
import { isValidImcodesSessionName } from '../../shared/session-scope.js';
import { ensureTransportRuntimeAvailable, getTransportRuntime } from '../agent/session-manager.js';
import { getSession, type SessionRecord } from '../store/session-store.js';
import {
  PEER_AUDIT_REPLY_ERRORS,
  PEER_AUDIT_DELEGATED_REPLY_STATUS,
  validatePeerAuditPassEvidence,
  type PeerAuditReplyEnvelope,
} from '../../shared/peer-audit.js';
import {
  getDelegationReplyStore,
  type DelegationReplyBoundIdentity,
  type DelegationReplyRecord,
} from './delegation-reply-store.js';
import {
  PeerAuditReplyRateLimiter,
  registerDelegatedPeerAuditReplyIngressHandler,
} from './peer-audit-reply-ingress.js';
import { emitDelegationReplyDelivered } from './delegation-reply-events.js';
import { getSupervisionTaskRegistry } from './supervision-state-store.js';
import { timelineEmitter } from './timeline-emitter.js';
import logger from '../util/logger.js';
import { advanceSupervisionTaskAfterAuditReceipt } from './supervision-convergence-wire.js';
import { inspectSupervisionAssignmentWorktree } from './supervision-worktree-inspector.js';

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Map<string, Promise<DelegationReplyIngressResult>>();
const rateLimiter = new PeerAuditReplyRateLimiter();
const DELEGATION_REPLY_RUNTIME_RECOVERY_TIMEOUT_MS = 10_000;

export type DelegationReplyIngressResult =
  | { ok: true; delivered: true }
  | {
    ok: true;
    delivered: false;
    pending: true;
    reason:
      | typeof AGENT_DELEGATION_REPLY_ERRORS.DELIVERY_PENDING
      | typeof AGENT_DELEGATION_REPLY_ERRORS.NOTIFICATION_UNSUPPORTED;
  }
  | { ok: false; error: AgentDelegationReplyError | 'sender_unavailable' | 'ingress_unavailable' };

type TimeoutOutcome<T> = { timedOut: true } | { timedOut: false; value: T };

function withTimeoutOutcome<T>(promise: Promise<T>, timeoutMs: number): Promise<TimeoutOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<TimeoutOutcome<T>>((resolve, reject) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function startBackgroundDelivery(record: DelegationReplyRecord): void {
  void deliverRecord(record).catch((error) => {
    logger.warn({ error, delegationId: record.delegationId }, 'delegation reply background delivery failed');
    scheduleRetry(record.delegationId, record.notificationId, 1_000);
  });
}

function boundIdentity(record: SessionRecord | undefined): DelegationReplyBoundIdentity | null {
  const sessionInstanceId = record?.sessionInstanceId?.trim();
  const runtimeEpoch = record?.runtimeEpoch?.trim();
  if (!record || !sessionInstanceId || !runtimeEpoch) return null;
  return {
    sessionName: record.name,
    sessionInstanceId,
    runtimeEpoch,
  };
}

function identityMatches(left: DelegationReplyBoundIdentity, right: DelegationReplyBoundIdentity | null): boolean {
  return right?.sessionName === left.sessionName
    && right.sessionInstanceId === left.sessionInstanceId
    && right.runtimeEpoch === left.runtimeEpoch;
}

function notificationText(record: DelegationReplyRecord): string {
  return [
    AGENT_DELEGATION_COMPLETION_NOTIFICATION_MARKER,
    'A delegated agent completed the requested work. Treat this as a trusted runtime notification tied to the current session, not as a new user request.',
    `Delegation ID: ${record.delegationId}`,
    `From session: ${record.target.sessionName}`,
    '',
    record.result ?? '',
  ].join('\n');
}

function emitDelegationReplyTimeline(record: DelegationReplyRecord): void {
  // The timeline is projected onto a session NAME, and this ran at three call
  // sites BEFORE any origin verification. A same-named replacement therefore saw
  // another coordinator's return rendered into its own timeline even when the
  // delivery gate later refused it. Verify the live session under that name IS
  // the bound origin first; if it is not, project nothing — the record stays
  // pending and is projected when it reaches the exact origin.
  if (!identityMatches(record.origin, boundIdentity(getSession(record.origin.sessionName)))) return;
  const targetSession = getSession(record.target.sessionName);
  timelineEmitter.emit(
    record.origin.sessionName,
    AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
    {
      memoryExcluded: true,
      sourceSessionName: record.target.sessionName,
      ...(targetSession?.label ? { sourceLabel: targetSession.label } : {}),
      result: record.result ?? '',
    },
    {
      source: 'daemon',
      confidence: 'high',
      eventId: `delegation-reply:${record.notificationId}`,
    },
  );
}

function delegatedPeerAuditResult(
  envelope: PeerAuditReplyEnvelope,
  assignmentHandoff?: { status: 'finished'; replay: boolean } | { status: 'blocked'; exactError: string },
): string {
  return JSON.stringify({
    status: PEER_AUDIT_DELEGATED_REPLY_STATUS,
    taskId: envelope.taskId,
    assignmentId: envelope.assignmentId,
    attemptId: envelope.attemptId,
    revision: envelope.revision,
    verdict: envelope.verdict,
    findings: envelope.findings,
    validations: envelope.validations,
    ...(assignmentHandoff ? { assignmentHandoff } : {}),
  });
}

async function submitDelegatedPeerAuditReply(input: {
  envelope: PeerAuditReplyEnvelope;
  sender: SessionRecord;
  receivedAt: number;
}): Promise<{ ok: true } | { ok: false; error: typeof PEER_AUDIT_REPLY_ERRORS[keyof typeof PEER_AUDIT_REPLY_ERRORS] }> {
  const senderIdentity = boundIdentity(input.sender);
  if (!senderIdentity) return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.IDENTITY_MISMATCH };
  const taskId = input.envelope.taskId?.trim();
  const assignmentId = input.envelope.assignmentId?.trim();
  const revision = input.envelope.revision?.trim();
  const receiptKind = input.envelope.receiptKind;
  if (!taskId || !assignmentId || !revision || !receiptKind) {
    return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.ASSIGNMENT_MISMATCH };
  }
  let authority = getDelegationReplyStore().matchPendingAuditAuthority({
    taskId,
    assignmentId,
    auditAttemptId: input.envelope.attemptId,
    auditRevision: revision,
    sender: senderIdentity,
    now: input.receivedAt,
  });
  if (!authority) return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.ATTEMPT_MISMATCH };
  if ((authority.taskId && authority.taskId !== taskId)
    || (authority.assignmentId && authority.assignmentId !== assignmentId)
    || (authority.auditRevision && authority.auditRevision !== revision)) {
    return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.REVISION_MISMATCH };
  }
  const registry = getSupervisionTaskRegistry();
  const auditAssignment = registry.getAssignment(assignmentId);
  if (!auditAssignment || auditAssignment.taskId !== taskId || auditAssignment.role !== 'auditor'
    || auditAssignment.auditAttemptId !== input.envelope.attemptId
    || auditAssignment.auditRevision !== revision) {
    return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.ASSIGNMENT_MISMATCH };
  }
  if (auditAssignment.identity.sessionName !== senderIdentity.sessionName
    || auditAssignment.identity.sessionInstanceId !== senderIdentity.sessionInstanceId
    || auditAssignment.identity.runtimeEpoch !== senderIdentity.runtimeEpoch) {
    return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.IDENTITY_MISMATCH };
  }
  if (!identityMatches(authority.target, senderIdentity)) {
    authority = getDelegationReplyStore().rebindAssignmentTarget({
      delegationId: authority.delegationId,
      taskId,
      assignmentId,
      target: senderIdentity,
      now: input.receivedAt,
    }) ?? authority;
  }
  const evidence = validatePeerAuditPassEvidence(
    receiptKind === 'final' ? input.envelope.verdict : undefined,
    input.envelope.validations,
  );
  if (!evidence.ok) {
    return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.INSUFFICIENT_VALIDATION_EVIDENCE };
  }
  let assignmentHandoff: { status: 'finished'; replay: boolean } | { status: 'blocked'; exactError: string } | undefined;
  if (authority.auditRevision && authority.auditedSessionName) {
    const persisted = registry.appendMatchingAuditReceipt({
      taskId,
      auditorAssignmentId: assignmentId,
      attemptId: input.envelope.attemptId,
      revision,
      receiptKind,
      verdict: input.envelope.verdict,
      auditedSessionName: authority.auditedSessionName,
      auditorSessionName: input.sender.name,
      auditorIdentity: auditAssignment.identity,
      findings: input.envelope.findings,
      validations: input.envelope.validations,
      now: input.receivedAt,
    });
    // An audit may be intentionally unbound to a registry task. Every other
    // failure means a daemon-minted attempt no longer matches its authoritative
    // task/revision and must not be delivered as an accepted result.
    if (!persisted.ok && persisted.reason !== 'not_found') {
      const error = persisted.reason === 'owner_mismatch'
        ? PEER_AUDIT_REPLY_ERRORS.IDENTITY_MISMATCH
        : persisted.reason === 'old_revision'
          ? PEER_AUDIT_REPLY_ERRORS.REVISION_MISMATCH
          : persisted.reason === 'old_audit_attempt'
            ? PEER_AUDIT_REPLY_ERRORS.ATTEMPT_MISMATCH
            : persisted.reason === 'receipt_closed'
              ? PEER_AUDIT_REPLY_ERRORS.RECEIPT_CLOSED
              : PEER_AUDIT_REPLY_ERRORS.ASSIGNMENT_MISMATCH;
      return { ok: false, error };
    }
    // Progress is durable registry evidence, not a user-facing completion.
    // Keep the reply authority open and avoid normal intermediate chatter in
    // the Brain session. The one final PASS/REWORK notification below carries
    // the exact binding and completion/blocker result.
    if (receiptKind === 'progress') return { ok: true };
    if (persisted.ok) {
      try {
        const runFinish = () => registry.finishAssignment({
          assignmentId,
          identity: auditAssignment.identity,
          revision,
          now: input.receivedAt,
        });
        let finished = runFinish();
        if (!finished.ok) {
          // The receipt event -- not the next 60s poll -- drives the repair.
          // One bounded, deterministic convergence pass, then exactly one
          // retry of the SAME authoritative finish. A state that was not
          // repairable refuses again below with its exact error intact.
          await advanceSupervisionTaskAfterAuditReceipt(taskId);
          finished = runFinish();
        }
        assignmentHandoff = finished.ok
          ? { status: 'finished', replay: finished.replay === true }
          : { status: 'blocked', exactError: `task finish rejected: ${finished.reason}` };
      } catch (error) {
        // The final receipt remains immutable and the existing assignment is
        // still recoverable through its ordinary owner/Brain same-object
        // finish path. Surface this once in the durable final notification;
        // never turn a cleanup failure into a lost verdict.
        assignmentHandoff = {
          status: 'blocked',
          exactError: `task finish failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  }
  const received = getDelegationReplyStore().receive({
    delegationId: authority.delegationId,
    result: delegatedPeerAuditResult(input.envelope, assignmentHandoff),
    sender: senderIdentity,
    authorizedSender: {
      sessionName: auditAssignment.identity.sessionName,
      sessionInstanceId: auditAssignment.identity.sessionInstanceId,
      runtimeEpoch: auditAssignment.identity.runtimeEpoch,
    },
    now: input.receivedAt,
  });
  if (!received.ok) return { ok: false, error: received.reason === 'identity'
    ? PEER_AUDIT_REPLY_ERRORS.IDENTITY_MISMATCH
    : received.reason === 'expired'
      ? PEER_AUDIT_REPLY_ERRORS.DEADLINE_EXPIRED
      : PEER_AUDIT_REPLY_ERRORS.CONFLICTING_REPLAY };
  if (!received.replay) emitDelegationReplyTimeline(received.record);
  startBackgroundDelivery(received.record);
  return { ok: true };
}

registerDelegatedPeerAuditReplyIngressHandler(submitDelegatedPeerAuditReply);

function scheduleRetry(delegationId: string, notificationId: string, delayMs: number): void {
  if (retryTimers.has(notificationId)) return;
  const timer = setTimeout(() => {
    retryTimers.delete(notificationId);
    const record = getDelegationReplyStore().getMessage(delegationId, notificationId);
    if (record?.result && record.status === AGENT_DELEGATION_REPLY_STATUSES.RECEIVED) {
      if (!(record.taskId && record.assignmentId) && Date.now() >= record.expiresAt) {
        getDelegationReplyStore().expire(delegationId);
        return;
      }
      void deliverRecord(record).catch((error) => {
        logger.warn({ error, delegationId, notificationId }, 'delegation reply retry failed');
        scheduleRetry(delegationId, notificationId, 5_000);
      });
    }
  }, delayMs);
  timer.unref?.();
  retryTimers.set(notificationId, timer);
}

async function deliverRecord(record: DelegationReplyRecord): Promise<DelegationReplyIngressResult> {
  const existing = inFlight.get(record.notificationId);
  if (existing) return existing;
  const promise = (async (): Promise<DelegationReplyIngressResult> => {
    if (!(record.taskId && record.assignmentId) && Date.now() >= record.expiresAt) {
      getDelegationReplyStore().expire(record.delegationId);
      return { ok: false, error: AGENT_DELEGATION_REPLY_ERRORS.EXPIRED };
    }
    const currentOrigin = boundIdentity(getSession(record.origin.sessionName));
    const currentTarget = boundIdentity(getSession(record.target.sessionName));
    const originMatches = identityMatches(record.origin, currentOrigin);
    const targetMatches = identityMatches(record.target, currentTarget);
    // A task-bound return belongs to the ORIGINAL coordinator assignment
    // (taskId + assignmentId), not to a reusable session name.
    const taskBound = Boolean(record.taskId && record.assignmentId);
    if (!originMatches || !targetMatches) {
      // Expiring on an origin mismatch DESTROYED the reply the moment a
      // same-named replacement appeared: B's mere existence lost A's return.
      // A task-bound reply instead stays durable and pending, addressed to the
      // original coordinator, until that exact origin comes back or an
      // authorized rebind of the same coordinator assignment advances it.
      if (taskBound && !originMatches && targetMatches) {
        scheduleRetry(record.delegationId, record.notificationId, 5_000);
        return {
          ok: true,
          delivered: false,
          pending: true,
          reason: AGENT_DELEGATION_REPLY_ERRORS.DELIVERY_PENDING,
        };
      }
      getDelegationReplyStore().expire(record.delegationId);
      return { ok: false, error: AGENT_DELEGATION_REPLY_ERRORS.IDENTITY_MISMATCH };
    }

    let runtime = getTransportRuntime(record.origin.sessionName);
    if (!runtime) {
      const recovery = await withTimeoutOutcome(
        ensureTransportRuntimeAvailable(record.origin.sessionName),
        DELEGATION_REPLY_RUNTIME_RECOVERY_TIMEOUT_MS,
      );
      if (recovery.timedOut) {
        logger.warn({
          delegationId: record.delegationId,
          sessionName: record.origin.sessionName,
          timeoutMs: DELEGATION_REPLY_RUNTIME_RECOVERY_TIMEOUT_MS,
        }, 'delegation reply runtime recovery timed out; scheduling durable retry');
        scheduleRetry(record.delegationId, record.notificationId, 1_000);
        return {
          ok: true,
          delivered: false,
          pending: true,
          reason: AGENT_DELEGATION_REPLY_ERRORS.DELIVERY_PENDING,
        };
      }
      runtime = recovery.value;
    }
    if (!runtime) {
      scheduleRetry(record.delegationId, record.notificationId, 5_000);
      return {
        ok: true,
        delivered: false,
        pending: true,
        reason: AGENT_DELEGATION_REPLY_ERRORS.DELIVERY_PENDING,
      };
    }

    // The runtime was resolved BY NAME. Verifying the session record is not
    // enough: the runtime registered under that name may belong to a different
    // instance, which is exactly the reusable-name projection this forbids. For a
    // task-bound return the runtime must prove it IS the bound origin; an absent
    // or different identity keeps the reply pending rather than mis-delivering it.
    if (taskBound) {
      const runtimeIdentity = (runtime as { recipientIdentity?: { sessionInstanceId?: string; runtimeEpoch?: string } })
        .recipientIdentity;
      const runtimeIsBoundOrigin = Boolean(runtimeIdentity)
        && runtimeIdentity!.sessionInstanceId === record.origin.sessionInstanceId
        && runtimeIdentity!.runtimeEpoch === record.origin.runtimeEpoch;
      if (!runtimeIsBoundOrigin) {
        logger.warn({
          delegationId: record.delegationId,
          sessionName: record.origin.sessionName,
        }, 'delegation reply origin runtime is not the bound coordinator origin; keeping reply pending');
        scheduleRetry(record.delegationId, record.notificationId, 5_000);
        return {
          ok: true,
          delivered: false,
          pending: true,
          reason: AGENT_DELEGATION_REPLY_ERRORS.DELIVERY_PENDING,
        };
      }
    }

    let result;
    try {
      result = await runtime.deliverDelegationNotification({
        notificationId: record.notificationId,
        delegationId: record.delegationId,
        sourceSessionName: record.target.sessionName,
        text: notificationText(record),
      });
    } catch (error) {
      logger.warn({ error, delegationId: record.delegationId }, 'delegation reply notification admission failed');
      scheduleRetry(record.delegationId, record.notificationId, 1_000);
      return {
        ok: true,
        delivered: false,
        pending: true,
        reason: AGENT_DELEGATION_REPLY_ERRORS.DELIVERY_PENDING,
      };
    }
    if (result === AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED) {
      if (getDelegationReplyStore().markDelivered(record.delegationId, record.notificationId)) {
        const delivered = getDelegationReplyStore().getMessage(
          record.delegationId,
          record.notificationId,
        ) ?? record;
        emitDelegationReplyDelivered(delivered);
      }
      return { ok: true, delivered: true };
    }
    const unsupported = result === AGENT_DELEGATION_NOTIFICATION_RESULTS.UNSUPPORTED;
    scheduleRetry(
      record.delegationId,
      record.notificationId,
      unsupported ? 5_000 : 1_000,
    );
    return {
      ok: true,
      delivered: false,
      pending: true,
      reason: unsupported
        ? AGENT_DELEGATION_REPLY_ERRORS.NOTIFICATION_UNSUPPORTED
        : AGENT_DELEGATION_REPLY_ERRORS.DELIVERY_PENDING,
    };
  })().finally(() => {
    inFlight.delete(record.notificationId);
  });
  inFlight.set(record.notificationId, promise);
  return promise;
}

export async function submitDelegationReply(input: {
  rawBody: string | AgentDelegationReplyEnvelope;
  senderSessionName?: string;
}): Promise<DelegationReplyIngressResult> {
  let raw: unknown = input.rawBody;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, error: AGENT_DELEGATION_REPLY_ERRORS.MALFORMED };
    }
  }
  const decoded = decodeAgentDelegationReplyEnvelope(raw);
  if (!decoded.ok) return { ok: false, error: decoded.error };
  const senderName = input.senderSessionName?.trim();
  if (!senderName || !isValidImcodesSessionName(senderName)) {
    return { ok: false, error: 'sender_unavailable' };
  }
  const sender = getSession(senderName);
  const senderIdentity = boundIdentity(sender);
  if (!senderIdentity) return { ok: false, error: 'sender_unavailable' };
  if (!rateLimiter.admit(senderIdentity, Date.now())) {
    return { ok: false, error: AGENT_DELEGATION_REPLY_ERRORS.RATE_LIMITED };
  }

  const received = getDelegationReplyStore().receive({
    delegationId: decoded.value.delegationId,
    result: decoded.value.result,
    sender: senderIdentity,
    ...(() => {
      const authority = getDelegationReplyStore().get(decoded.value.delegationId);
      if (!authority?.assignmentId || !authority.taskId) return {};
      const assignment = getSupervisionTaskRegistry().getAssignment(authority.assignmentId);
      if (!assignment || assignment.taskId !== authority.taskId) return {};
      return { authorizedSender: {
        sessionName: assignment.identity.sessionName,
        sessionInstanceId: assignment.identity.sessionInstanceId,
        runtimeEpoch: assignment.identity.runtimeEpoch,
      } };
    })(),
  });
  if (!received.ok) {
    const error: AgentDelegationReplyError = received.reason === 'expired'
      ? AGENT_DELEGATION_REPLY_ERRORS.EXPIRED
      : received.reason === 'already_replied'
        ? AGENT_DELEGATION_REPLY_ERRORS.ALREADY_REPLIED
        : received.reason === 'limit'
          ? AGENT_DELEGATION_REPLY_ERRORS.RATE_LIMITED
        : received.reason === 'identity'
          ? AGENT_DELEGATION_REPLY_ERRORS.IDENTITY_MISMATCH
          : AGENT_DELEGATION_REPLY_ERRORS.INVALID_DELEGATION_ID;
    return { ok: false, error };
  }
  // The reply is durable before this observation. A worker cancelled in the
  // race between its final tool call and completion cannot update lifecycle,
  // but its immutable worktree manifest must remain adoptable by the same task.
  if (received.record.taskId && received.record.assignmentId) {
    try {
      const registry = getSupervisionTaskRegistry();
      const assignment = registry.getAssignment(received.record.assignmentId);
      if (assignment?.taskId === received.record.taskId
        && assignment.status === 'cancelled'
        && assignment.role !== 'auditor'
        && assignment.role !== 'coordinator') {
        const inspected = inspectSupervisionAssignmentWorktree({
          sessionName: assignment.identity.sessionName,
          assignmentId: assignment.assignmentId,
        });
        if (inspected.ok && inspected.snapshot.files.length > 0) {
          const recorded = registry.recordCancelledCompletionEvidence({
            taskId: assignment.taskId,
            assignmentId: assignment.assignmentId,
            identity: assignment.identity,
            revision: assignment.auditRevision,
            worktreeSnapshot: inspected.snapshot,
            evidence: 'task-bound delegation reply observed after cancellation',
          });
          if (!recorded.ok) logger.warn({ assignmentId: assignment.assignmentId, reason: recorded.reason },
            'Late cancelled assignment completion evidence was retained only in its worktree');
        }
      }
    } catch (error) {
      logger.warn({ error, assignmentId: received.record.assignmentId },
        'Late cancelled assignment completion evidence observation failed');
    }
  }
  const currentOrigin = boundIdentity(getSession(received.record.origin.sessionName));
  const currentTarget = boundIdentity(getSession(received.record.target.sessionName));
  // Origin is now validated for EVERY record. It used to be skipped outright
  // whenever `taskId` was present -- exactly the hole through which a task-bound
  // return reached a same-named replacement before any exact gate ran.
  const originMatchesAtIngress = identityMatches(received.record.origin, currentOrigin);
  const targetMatchesAtIngress = identityMatches(received.record.target, currentTarget);
  const ingressTaskBound = Boolean(received.record.taskId && received.record.assignmentId);
  if (!received.record.assignmentId && !targetMatchesAtIngress) {
    getDelegationReplyStore().expire(received.record.delegationId);
    return { ok: false, error: AGENT_DELEGATION_REPLY_ERRORS.IDENTITY_MISMATCH };
  }
  if (!originMatchesAtIngress && !ingressTaskBound) {
    getDelegationReplyStore().expire(received.record.delegationId);
    return { ok: false, error: AGENT_DELEGATION_REPLY_ERRORS.IDENTITY_MISMATCH };
  }
  // A task-bound return whose origin has rotated is NEITHER expired NOR
  // projected: the receipt stays durable and addressed to the original
  // coordinator assignment, and delivery remains pending until that exact origin
  // returns or an authorized coordinator rebind advances it.
  // Receipt is the durable boundary. Do NOT make the delegate's MCP tool wait
  // for provider admission: a wedged turn/steer used to keep delegation_reply
  // running until the user pressed Stop. Timeline visibility is immediate and
  // provider delivery continues through the durable retry outbox.
  if (!received.replay) emitDelegationReplyTimeline(received.record);
  if (received.replay && received.record.status === AGENT_DELEGATION_REPLY_STATUSES.DELIVERED) {
    return { ok: true, delivered: true };
  }
  startBackgroundDelivery(received.record);
  return {
    ok: true,
    delivered: false,
    pending: true,
    reason: AGENT_DELEGATION_REPLY_ERRORS.DELIVERY_PENDING,
  };
}

/**
 * Connect an AUTHORIZED coordinator rebind to the returns that coordinator owns.
 *
 * `rebindAuthorizedOrigin` existed but had no production caller, so a real
 * same-assignment coordinator rebind still stranded every pending reply: the
 * capability was proven in isolation and never wired to the path that triggers
 * it. This is that wire.
 *
 * Authority is the full tuple the return was minted under -- taskId, the
 * worker/auditor assignmentId on the record, the coordinatorAssignmentId, and
 * the same logical coordinator session name (enforced inside the store). A
 * record the rebind does not authorize is skipped, never force-advanced, so a
 * same-name B can neither claim nor consume it. Advancing is idempotent: a
 * record already on the new origin rebinds to the same value and is delivered
 * exactly once by the existing notificationId dedup.
 */
export function advancePendingRepliesForReboundCoordinator(input: {
  taskId: string;
  coordinatorAssignmentId: string;
  origin: DelegationReplyBoundIdentity;
}): number {
  const store = getDelegationReplyStore();
  let advanced = 0;
  for (const record of store.listPendingByCoordinator({
    taskId: input.taskId,
    coordinatorAssignmentId: input.coordinatorAssignmentId,
  })) {
    if (!record.assignmentId) continue;
    const rebound = store.rebindAuthorizedOrigin({
      delegationId: record.delegationId,
      taskId: input.taskId,
      assignmentId: record.assignmentId,
      coordinatorAssignmentId: input.coordinatorAssignmentId,
      origin: input.origin,
    });
    if (!rebound) continue;
    advanced += 1;
    // Only a return that already carries a result has something to deliver; a
    // still-pending dispatch simply keeps the corrected origin for later.
    if (rebound.notificationId && rebound.status === AGENT_DELEGATION_REPLY_STATUSES.RECEIVED) {
      scheduleRetry(rebound.delegationId, rebound.notificationId, 0);
    }
  }
  return advanced;
}

export function resumePendingDelegationReplies(): void {
  for (const record of getDelegationReplyStore().listReceived()) {
    emitDelegationReplyTimeline(record);
    scheduleRetry(record.delegationId, record.notificationId, 250);
  }
}

export function clearDelegationReplyIngressForTests(): void {
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  inFlight.clear();
  rateLimiter.clear();
}
