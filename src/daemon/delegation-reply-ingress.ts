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
        const finished = registry.finishAssignment({
          assignmentId,
          identity: auditAssignment.identity,
          revision,
          now: input.receivedAt,
        });
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
    if (!identityMatches(record.origin, currentOrigin) || !identityMatches(record.target, currentTarget)) {
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
  const currentOrigin = boundIdentity(getSession(received.record.origin.sessionName));
  const currentTarget = boundIdentity(getSession(received.record.target.sessionName));
  if ((!received.record.assignmentId && !identityMatches(received.record.target, currentTarget))
    || (!received.record.taskId && !identityMatches(received.record.origin, currentOrigin))) {
    getDelegationReplyStore().expire(received.record.delegationId);
    return { ok: false, error: AGENT_DELEGATION_REPLY_ERRORS.IDENTITY_MISMATCH };
  }
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
