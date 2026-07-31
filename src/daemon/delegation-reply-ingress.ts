import {
  AGENT_DELEGATION_COMPLETION_NOTIFICATION_MARKER,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
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
import logger from '../util/logger.js';

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Map<string, Promise<DelegationReplyIngressResult>>();
const rateLimiter = new PeerAuditReplyRateLimiter();

export type DelegationReplyIngressResult =
  | { ok: true; delivered: true }
  | { ok: true; delivered: false; pending: true; reason: 'active_notification_unsupported' | 'runtime_stale' }
  | { ok: false; error: AgentDelegationReplyError | 'sender_unavailable' | 'ingress_unavailable' };

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

function scheduleRetry(delegationId: string, delayMs: number): void {
  if (retryTimers.has(delegationId)) return;
  const timer = setTimeout(() => {
    retryTimers.delete(delegationId);
    const record = getDelegationReplyStore().get(delegationId);
    if (record?.result && record.status === AGENT_DELEGATION_REPLY_STATUSES.RECEIVED) {
      if (Date.now() >= record.expiresAt) {
        getDelegationReplyStore().expire(delegationId);
        return;
      }
      void deliverRecord(record).catch((error) => {
        logger.warn({ error, delegationId }, 'delegation reply retry failed');
        scheduleRetry(delegationId, 5_000);
      });
    }
  }, delayMs);
  timer.unref?.();
  retryTimers.set(delegationId, timer);
}

async function deliverRecord(record: DelegationReplyRecord): Promise<DelegationReplyIngressResult> {
  const existing = inFlight.get(record.delegationId);
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
      runtime = await ensureTransportRuntimeAvailable(record.origin.sessionName);
    }
    if (!runtime) {
      scheduleRetry(record.delegationId, 5_000);
      return { ok: true, delivered: false, pending: true, reason: 'runtime_stale' };
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
      scheduleRetry(record.delegationId, 1_000);
      return { ok: true, delivered: false, pending: true, reason: 'runtime_stale' };
    }
    if (result === AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED) {
      if (getDelegationReplyStore().markDelivered(record.delegationId)) {
        const delivered = getDelegationReplyStore().get(record.delegationId) ?? record;
        emitDelegationReplyDelivered(delivered);
      }
      return { ok: true, delivered: true };
    }
    const unsupported = result === AGENT_DELEGATION_NOTIFICATION_RESULTS.UNSUPPORTED;
    scheduleRetry(record.delegationId, unsupported ? 5_000 : 1_000);
    return {
      ok: true,
      delivered: false,
      pending: true,
      reason: unsupported ? 'active_notification_unsupported' : 'runtime_stale',
    };
  })().finally(() => {
    inFlight.delete(record.delegationId);
  });
  inFlight.set(record.delegationId, promise);
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
        : received.reason === 'identity'
          ? AGENT_DELEGATION_REPLY_ERRORS.IDENTITY_MISMATCH
          : received.reason === 'capability'
            ? AGENT_DELEGATION_REPLY_ERRORS.INVALID_CAPABILITY
            : AGENT_DELEGATION_REPLY_ERRORS.INVALID_DELEGATION_ID;
    return { ok: false, error };
  }
  return deliverRecord(received.record);
}

export function resumePendingDelegationReplies(): void {
  for (const record of getDelegationReplyStore().listReceived()) {
    scheduleRetry(record.delegationId, 250);
  }
}

export function clearDelegationReplyIngressForTests(): void {
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  inFlight.clear();
  rateLimiter.clear();
}
