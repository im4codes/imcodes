/**
 * Delivery policy for one session message.
 *
 * Omission is the safe/default append mode. `append` asks a capable provider
 * to inject the message at its next safe boundary in the active turn (or
 * starts it immediately when idle), with a durable FIFO fallback when the
 * provider cannot append. `queue` is opt-in and is the only mode that waits
 * for the current turn to finish.
 * Keep this module dependency-free so browser and daemon callers share the
 * exact value without pulling server-only contracts into the Web bundle.
 */
export const SESSION_SEND_DELIVERY_MODES = {
  APPEND: 'append',
  QUEUE: 'queue',
} as const;

export type SessionSendDeliveryMode =
  typeof SESSION_SEND_DELIVERY_MODES[keyof typeof SESSION_SEND_DELIVERY_MODES];

/** Account-scoped preference shared by every main/sub-session composer. */
export const SESSION_SEND_DELIVERY_USER_PREF_KEY = 'composer.delivery_mode' as const;

/** New accounts append directly unless the user explicitly chooses FIFO. */
export const DEFAULT_SESSION_SEND_DELIVERY_MODE: SessionSendDeliveryMode =
  SESSION_SEND_DELIVERY_MODES.APPEND;

/** Backward-compatible MCP names; both names reference the same value/type. */
export const MEMORY_MCP_SEND_DELIVERY_MODES = SESSION_SEND_DELIVERY_MODES;
export type MemoryMcpSendDeliveryMode = SessionSendDeliveryMode;

/** Why an APPEND is currently using the safe idle FIFO fallback. */
export const TRANSPORT_APPEND_FALLBACK_REASONS = {
  UNSUPPORTED: 'unsupported',
  ATTACHMENTS_UNSUPPORTED: 'attachments_unsupported',
  CONTROL_UNSUPPORTED: 'control_unsupported',
  STALE: 'stale',
} as const;
export type TransportAppendFallbackReason = typeof TRANSPORT_APPEND_FALLBACK_REASONS[keyof typeof TRANSPORT_APPEND_FALLBACK_REASONS];
export interface QueueDeliveryPolicy {
  deliveryMode?: SessionSendDeliveryMode;
  appendFallbackReason?: TransportAppendFallbackReason;
}

/** Whitelist only public policy, never the provider/private dispatch material. */
export function readQueueDeliveryPolicy(value: { deliveryMode?: unknown; appendFallbackReason?: unknown }): QueueDeliveryPolicy {
  return {
    ...(Object.values(SESSION_SEND_DELIVERY_MODES).includes(value.deliveryMode as SessionSendDeliveryMode)
      ? { deliveryMode: value.deliveryMode as SessionSendDeliveryMode } : {}),
    ...(Object.values(TRANSPORT_APPEND_FALLBACK_REASONS).includes(value.appendFallbackReason as TransportAppendFallbackReason)
      ? { appendFallbackReason: value.appendFallbackReason as TransportAppendFallbackReason } : {}),
  };
}

export const TRANSPORT_QUEUE_DELIVERY_LABEL_KEYS = {
  QUEUED: 'session.transport_send_queued',
  APPEND_PENDING: 'session.transport_append_pending',
  APPEND_FALLBACK: 'session.transport_append_fallback',
} as const;
export function queuedMessageDeliveryLabelKey(policy: QueueDeliveryPolicy): string {
  const safe = readQueueDeliveryPolicy(policy);
  if (safe.appendFallbackReason) return TRANSPORT_QUEUE_DELIVERY_LABEL_KEYS.APPEND_FALLBACK;
  return safe.deliveryMode === SESSION_SEND_DELIVERY_MODES.APPEND
    ? TRANSPORT_QUEUE_DELIVERY_LABEL_KEYS.APPEND_PENDING
    : TRANSPORT_QUEUE_DELIVERY_LABEL_KEYS.QUEUED;
}
