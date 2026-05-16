import { randomUUID } from 'crypto';

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

export function isSendDispatchId(value: unknown): value is SendDispatchId {
  return typeof value === 'string' && SEND_DISPATCH_ID_RE.test(value);
}

export function isSendMessageId(value: unknown): value is SendMessageId {
  return typeof value === 'string' && SEND_MESSAGE_ID_RE.test(value);
}
