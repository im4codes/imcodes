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
  getDelegationReplyStore,
  type DelegationReplyBoundIdentity,
  type DelegationReplyRecord,
} from './delegation-reply-store.js';
import { PeerAuditReplyRateLimiter } from './peer-audit-reply-ingress.js';
import { emitDelegationReplyDelivered } from './delegation-reply-events.js';
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

function scheduleRetry(delegationId: string, notificationId: string, delayMs: number): void {
  if (retryTimers.has(notificationId)) return;
  const timer = setTimeout(() => {
    retryTimers.delete(notificationId);
    const record = getDelegationReplyStore().getMessage(delegationId, notificationId);
    if (record?.result && record.status === AGENT_DELEGATION_REPLY_STATUSES.RECEIVED) {
      if (Date.now() >= record.expiresAt) {
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
    if (Date.now() >= record.expiresAt) {
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
    replyCapability: decoded.value.replyCapability,
    result: decoded.value.result,
    sender: senderIdentity,
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
          : received.reason === 'capability'
            ? AGENT_DELEGATION_REPLY_ERRORS.INVALID_CAPABILITY
            : AGENT_DELEGATION_REPLY_ERRORS.INVALID_DELEGATION_ID;
    return { ok: false, error };
  }
  const currentOrigin = boundIdentity(getSession(received.record.origin.sessionName));
  const currentTarget = boundIdentity(getSession(received.record.target.sessionName));
  if (!identityMatches(received.record.origin, currentOrigin)
    || !identityMatches(received.record.target, currentTarget)) {
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
