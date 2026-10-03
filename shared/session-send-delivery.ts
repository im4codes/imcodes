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
