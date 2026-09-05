import { createHash, randomUUID } from 'crypto';

export const SEND_DISPATCH_ID_PREFIX = 'send_dispatch_' as const;
export const SEND_MESSAGE_ID_PREFIX = 'send_message_' as const;

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const SEND_DISPATCH_ID_RE = new RegExp(`^${SEND_DISPATCH_ID_PREFIX}${UUID_PATTERN}$`);
const SEND_MESSAGE_ID_RE = new RegExp(`^${SEND_MESSAGE_ID_PREFIX}${UUID_PATTERN}$`);

export type SendDispatchId = `${typeof SEND_DISPATCH_ID_PREFIX}${string}`;
export type SendMessageId = `${typeof SEND_MESSAGE_ID_PREFIX}${string}`;

export function createSendDispatchId(): SendDispatchId {
  return `${SEND_DISPATCH_ID_PREFIX}${randomUUID()}`;
}

export function createSendMessageId(): SendMessageId {
  return `${SEND_MESSAGE_ID_PREFIX}${randomUUID()}`;
}

/** Stable identity for daemon-owned exactly-once control traffic. */
export function deterministicSendMessageId(seed: string): SendMessageId {
  const hex = createHash('sha256').update(seed).digest('hex');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return `${SEND_MESSAGE_ID_PREFIX}${uuid}`;
}

/** Exact delivery identity for one automatic-audit assignment generation. */
export function deterministicAutomaticAuditDeliveryMessageId(
  assignmentId: string,
  attemptId: string,
  generation: number,
): SendMessageId {
  if (!assignmentId.trim() || !attemptId.trim()
    || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('automatic audit delivery identity requires assignment, attempt, and positive generation');
  }
  return deterministicSendMessageId(generation === 1
    ? `auto-audit:${assignmentId}:${attemptId}`
    : `auto-audit-rebind:${assignmentId}:${attemptId}:${generation}`);
}

export function isSendDispatchId(value: unknown): value is SendDispatchId {
  return typeof value === 'string' && SEND_DISPATCH_ID_RE.test(value);
}

export function isSendMessageId(value: unknown): value is SendMessageId {
  return typeof value === 'string' && SEND_MESSAGE_ID_RE.test(value);
}
