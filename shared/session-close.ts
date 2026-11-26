/**
 * Closing a sub-session: the contract shared by the `session_close` MCP tool and the daemon that enforces it.
 *
 * Nothing closes a session on its own. A session carries its memory, so reusing it is faster than starting another: a pair that ends
 * leaves its executor and auditor open, and only an explicit `session_close` (the user, or a Brain acting on purpose) removes one.
 *
 * "Close" is the existing soft close and nothing harsher: the runtime is stopped, its resources released, the server stamps
 * `sub_sessions.closed_at`, revokes the shares and tells every browser to drop the row (`subsession.removed`). No row is ever
 * deleted, and the user can bring the session back from the UI.
 */

export const SESSION_CLOSE_STATUS = {
  CLOSED: 'closed',
  /** The session was already gone: closing is idempotent. */
  ALREADY_CLOSED: 'already_closed',
  /** The rules refused the close; nothing was stopped. `reason` says which rule. */
  REFUSED: 'refused',
  /** The close was attempted and the runtime could not be stopped cleanly. */
  FAILED: 'failed',
} as const;
export type SessionCloseStatus = typeof SESSION_CLOSE_STATUS[keyof typeof SESSION_CLOSE_STATUS];

export const SESSION_CLOSE_REFUSAL = {
  /** Brains and main sessions, and anything that is not a `deck_sub_*` child, can never be closed by this tool. */
  NOT_A_SUB_SESSION: 'not_a_sub_session',
  /** Execution clones have their own lifecycle: `destroy_execution_clone`, by their creator. */
  EXECUTION_CLONE: 'execution_clone',
  SELF: 'cannot_close_self',
  /** The caller did not create the session and is not the Brain that owns it. */
  NOT_AUTHORIZED: 'not_authorized',
  /** A session nobody created automatically: only its Brain may close it, and only when `confirmUserCreated` says so. */
  USER_CREATED_NEEDS_CONFIRMATION: 'user_created_needs_confirmation',
  /** The session is the executor or auditor of a pair that has not ended (started or queued). */
  OPEN_PAIR: 'open_pair',
  TURN_RUNNING: 'turn_running',
  /** Messages are waiting in the session's queue, so closing would silently drop them. */
  QUEUED_MESSAGES: 'queued_messages',
  /** `force` is the Brain's override; a creator that is not the Brain may not use it. */
  FORCE_NOT_PERMITTED: 'force_not_permitted',
} as const;
export type SessionCloseRefusal = typeof SESSION_CLOSE_REFUSAL[keyof typeof SESSION_CLOSE_REFUSAL];

/** Refusals that `force` (Brain only) overrides. Authorization and kind refusals are never overridable. */
export const SESSION_CLOSE_FORCEABLE_REFUSALS: readonly SessionCloseRefusal[] = Object.freeze([
  SESSION_CLOSE_REFUSAL.OPEN_PAIR,
  SESSION_CLOSE_REFUSAL.TURN_RUNNING,
  SESSION_CLOSE_REFUSAL.QUEUED_MESSAGES,
]);

/** Why the caller may close the target. Recorded in the audit line and returned to the caller. */
export const SESSION_CLOSE_AUTHORITY = {
  CREATOR: 'creator',
  BRAIN: 'brain',
} as const;
export type SessionCloseAuthority = typeof SESSION_CLOSE_AUTHORITY[keyof typeof SESSION_CLOSE_AUTHORITY];

/** What the close would throw away, reported to the caller whenever `force` overrides a refusal (never silent). */
export interface SessionCloseDiscarded {
  openPairs: string[];
  turnWasRunning: boolean;
  queuedMessages: number;
}

export interface SessionCloseRequest {
  /** Exact session name (no label, no wildcard). */
  target: string;
  /** Brain-only override of `open_pair`, `turn_running` and `queued_messages`. The response lists what was discarded. */
  force?: boolean;
  /** Brain-only acknowledgement that the target was not created automatically (a user's own session). */
  confirmUserCreated?: boolean;
}

export type SessionCloseResult =
  | { status: typeof SESSION_CLOSE_STATUS.CLOSED; target: string; authority: SessionCloseAuthority; serverNotified: boolean; forced: boolean; discarded?: SessionCloseDiscarded }
  | { status: typeof SESSION_CLOSE_STATUS.ALREADY_CLOSED; target: string }
  | { status: typeof SESSION_CLOSE_STATUS.REFUSED; target: string; reason: SessionCloseRefusal; detail: string }
  | { status: typeof SESSION_CLOSE_STATUS.FAILED; target: string; error: string };
