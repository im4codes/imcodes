import type {
  AgentDelegationAuditRequest,
  AgentDelegationReplyAuthority,
} from '../../shared/agent-delegation.js';
import type { SendDispatchId, SendMessageId } from '../../shared/send-message-id.js';
import type { SessionRecord } from '../store/session-store.js';
import {
  getDelegationReplyStore,
  type CreatedDelegationReply,
  type DelegationReplyBoundIdentity,
} from './delegation-reply-store.js';

function boundIdentity(record: SessionRecord): DelegationReplyBoundIdentity | null {
  const sessionInstanceId = record.sessionInstanceId?.trim();
  const runtimeEpoch = record.runtimeEpoch?.trim();
  if (!sessionInstanceId || !runtimeEpoch) return null;
  return {
    sessionName: record.name,
    sessionInstanceId,
    runtimeEpoch,
  };
}

export function createDelegationReplyAuthority(input: {
  origin: SessionRecord | undefined;
  target: SessionRecord;
  dispatchId: SendDispatchId;
  messageId: SendMessageId;
  audit?: AgentDelegationAuditRequest;
  now?: number;
}): (CreatedDelegationReply & { authority: AgentDelegationReplyAuthority }) | null {
  const origin = input.origin ? boundIdentity(input.origin) : null;
  const target = boundIdentity(input.target);
  if (!origin || !target) return null;
  const created = getDelegationReplyStore().create({
    origin,
    target,
    dispatchId: input.dispatchId,
    messageId: input.messageId,
    ...(input.audit ? {
      purpose: input.audit.kind,
      auditAttemptId: input.audit.attemptId,
    } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return {
    ...created,
    authority: {
      delegationId: created.record.delegationId,
      replyCapability: created.replyCapability,
      ...(input.audit ? { audit: input.audit } : {}),
    },
  };
}

export function expireDelegationReplyAuthority(delegationId: string): void {
  getDelegationReplyStore().expire(delegationId);
}
