/**
 * Shared constants and types for the command-ack reliability protocol.
 *
 * This module is the single source of truth for:
 *   - New WS message types (`command.failed`, `daemon.online`, `daemon.offline`).
 *   - Failure reasons that cross daemon / server / web boundaries.
 *   - Timing constants (grace window, ack timeout, dedup TTL, outbox TTL/attempts).
 *
 * Import paths:
 *   daemon  : `../../shared/ack-protocol.js`
 *   server  : `../../../shared/ack-protocol.js`
 *   web     : `@shared/ack-protocol.js`
 *
 * Per CLAUDE.md, these string literals MUST NOT be duplicated at call sites.
 */

// ── WS message type strings ─────────────────────────────────────────────────

export const MSG_COMMAND_ACK = 'command.ack' as const;
export const MSG_COMMAND_FAILED = 'command.failed' as const;
export const MSG_DAEMON_ONLINE = 'daemon.online' as const;
export const MSG_DAEMON_OFFLINE = 'daemon.offline' as const;

// ── Failure reasons ─────────────────────────────────────────────────────────

export type AckFailureReason =
  | 'daemon_offline'
  | 'ack_timeout'
  | 'daemon_error';

export const ACK_FAILURE_DAEMON_OFFLINE: AckFailureReason = 'daemon_offline';
export const ACK_FAILURE_ACK_TIMEOUT: AckFailureReason = 'ack_timeout';
export const ACK_FAILURE_DAEMON_ERROR: AckFailureReason = 'daemon_error';

// ── command.ack error strings ───────────────────────────────────────────────

/** The daemon has already accepted or rejected this client-generated command id. */
export const COMMAND_ACK_ERROR_DUPLICATE_COMMAND_ID = 'duplicate_command_id' as const;

// ── Message payload shapes ──────────────────────────────────────────────────

export interface CommandFailedMessage {
  type: typeof MSG_COMMAND_FAILED;
  commandId: string;
  session: string;
  reason: AckFailureReason;
  retryable: boolean;
}

export interface DaemonOnlineMessage {
  type: typeof MSG_DAEMON_ONLINE;
}

export interface DaemonOfflineMessage {
  type: typeof MSG_DAEMON_OFFLINE;
}

// ── Timing constants ────────────────────────────────────────────────────────

/** How long the server waits after daemon WS close before declaring offline.
 *  Sized to cover real-world reconnect scenarios:
 *  - WiFi roaming / DHCP renewal: 3-8s
 *  - 4G/5G handoff: 2-5s
 *  - Server pod restart: 3-10s
 *  Previously 3s caused fast-fails on every transient blip even though the
 *  daemon would have come back fine. 10s gives the daemon a realistic window
 *  to reconnect before we surface failure to the user. */
export const RECONNECT_GRACE_MS = 10_000;

/** Per-command ack wait budget once the command has been dispatched to daemon.
 *  Higher than 5s to absorb cellular RTT spikes and CPU-stalled daemons during
 *  process spawn (Claude Code agent boot can take 2-3s on cold cache). */
export const ACK_TIMEOUT_MS = 8_000;

/** Number of daemon redispatches before surfacing ack_timeout to the browser.
 *  Total budget = ACK_TIMEOUT_MS * (RETRY_LIMIT + 1) = 8 * 6 = 48s, well within
 *  the client's optimistic timeout window. Higher retry count is critical when
 *  the daemon is briefly busy (file-system IO, agent spawn) and the first ack
 *  is delayed but not lost. */
export const ACK_TIMEOUT_RETRY_LIMIT = 5;

/** TTL for the server-side `seenCommandAcks` LRU that dedups replayed acks. */
export const ACK_DEDUP_TTL_MS = 5 * 60_000;

/** TTL for daemon outbox entries before GC drops them (crash-recovery upper bound). */
export const ACK_OUTBOX_TTL_MS = 10 * 60_000;

/** Max retry attempts per outbox entry before logger.error + drop. */
export const ACK_OUTBOX_MAX_ATTEMPTS = 10;

/** Upper bound on entries kept in the inflight map before forced GC. */
export const INFLIGHT_GC_TTL_MS = 60_000;
