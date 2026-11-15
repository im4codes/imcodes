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
import {
  mergeMachineAuthority,
  type TurnMachineAuthorityContext,
} from './machine-authority.js';
import { captureDelegationOriginAuthority } from './machine-authority-send.js';

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
  auditRevision?: string;
  taskId?: string;
  assignmentId?: string;
  /** The task's ORIGINAL coordinator assignment; the durable return's authority. */
  coordinatorAssignmentId?: string;
  originAuthority?: TurnMachineAuthorityContext;
  fallbackOwnerMachineAuthority?: string;
  now?: number;
}): (CreatedDelegationReply & { authority: AgentDelegationReplyAuthority }) | null {
  const origin = input.origin ? boundIdentity(input.origin) : null;
  const target = boundIdentity(input.target);
  if (!origin || !target) return null;
  const capturedOriginAuthority = captureDelegationOriginAuthority(
    origin.sessionName,
    input.fallbackOwnerMachineAuthority,
  );
  const effectiveOriginAuthority = input.originAuthority
    ? mergeMachineAuthority(capturedOriginAuthority, input.originAuthority)
    : capturedOriginAuthority;
  const created = getDelegationReplyStore().create({
    origin,
    target,
    dispatchId: input.dispatchId,
    messageId: input.messageId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
    ...(input.coordinatorAssignmentId ? { coordinatorAssignmentId: input.coordinatorAssignmentId } : {}),
    ...(effectiveOriginAuthority ? { originAuthority: effectiveOriginAuthority } : {}),
    ...(input.audit ? {
      purpose: input.audit.kind,
      auditAttemptId: input.audit.attemptId,
      auditedSessionName: input.audit.auditedSessionName,
      ...(input.auditRevision ? { auditRevision: input.auditRevision } : {}),
    } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return {
    ...created,
    authority: {
      delegationId: created.record.delegationId,
      ...(input.audit ? { audit: {
        ...input.audit,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
        ...(input.coordinatorAssignmentId ? { coordinatorAssignmentId: input.coordinatorAssignmentId } : {}),
    ...(input.coordinatorAssignmentId ? { coordinatorAssignmentId: input.coordinatorAssignmentId } : {}),
        ...(input.auditRevision ? { revision: input.auditRevision } : {}),
      } } : {}),
    },
  };
}

export function expireDelegationReplyAuthority(delegationId: string): void {
  getDelegationReplyStore().expire(delegationId);
}
