import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type WebSocket from 'ws';
import { signJwt, verifyJwt } from '../security/crypto.js';
import logger from '../util/logger.js';
import { incrementCounter } from '../util/metrics.js';
import {
  DIRECT_FILE_TRANSFER_DIRECTION,
  DIRECT_FILE_TRANSFER_ERROR,
  DIRECT_FILE_TRANSFER_ERROR_SCOPE,
  DIRECT_FILE_TRANSFER_ICE_SERVERS,
  DIRECT_FILE_TRANSFER_LIMITS,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
  DIRECT_FILE_TRANSFER_RESUME_TICKET_TYPE,
  DIRECT_FILE_TRANSFER_TERMINAL_STATE,
  isDirectFileTransferMessageType,
  isLegacyDirectFileTransferMessageType,
  validateDirectFileTransferBrowserMessage,
  validateDirectFileTransferDaemonMessage,
  validateDirectFileTransferResumeTicketClaims,
  type DirectFileTransferAttemptBinding,
  type DirectFileTransferDaemonMessage,
  type DirectFileTransferDirection,
  type DirectFileTransferError,
  type DirectFileTransferIceServerConfig,
  type DirectFileTransferLeaseRebind,
  type DirectFileTransferLeasePrepared,
  type DirectFileTransferOperationInit,
  type DirectFileTransferResumeTicketClaims,
  type DirectFileTransferCancel,
  type DirectFileTransferStatusQuery,
  type DirectFileTransferLeaseIce,
  type DirectFileTransferLeaseOffer,
  type DirectFileTransferStatus,
  type DirectFileTransferTerminal,
  type DirectFileTransferOperationError,
} from '../../../shared/direct-file-transfer.js';

type BoundBrowserMessage = DirectFileTransferCancel
  | DirectFileTransferStatusQuery;
type LeaseBrowserSignal = DirectFileTransferLeaseOffer | DirectFileTransferLeaseIce;
type OperationDaemonMessage = DirectFileTransferStatus
  | DirectFileTransferTerminal
  | DirectFileTransferOperationError;

/**
 * Telemetry labels are deliberately closed sets.  Do not put identifiers or
 * browser/daemon supplied values in these labels: direct-file control frames
 * routinely carry paths, filenames, opaque handles, tickets and SDP/ICE.
 */
type LeaseMetricEvent = 'created' | 'reused' | 'ready' | 'rebind_requested'
  | 'rebound' | 'prepare_send_failed' | 'rebind_prepare_send_failed';
type AttemptMetricEvent = 'authorized' | 'prepare_send_failed' | 'canceled'
  | 'succeeded' | 'terminal_failed' | 'failed' | 'retry_exhausted';
type StatusRecoveryMetricEvent = 'queried' | 'responded' | 'send_failed' | 'timed_out';
type ControlRelayDirection = 'browser_to_daemon' | 'daemon_to_browser'
  | 'server_to_daemon' | 'server_to_browser';
type ControlRelayFamily = 'lease_prepare' | 'lease_ready' | 'lease_rebound' | 'lease_signal'
  | 'operation_prepare' | 'operation_authorized' | 'cancel' | 'status'
  | 'terminal' | 'error';

export interface DirectFileTransferIceServerAuthority {
  iceServers: DirectFileTransferIceServerConfig[];
  credentialExpiresAt?: number;
}

interface DirectFileTransferLeaseRoute {
  leaseId: string;
  browserTabId: string;
  userId: string;
  daemonGeneration: number;
  leaseGeneration: number;
  resumeTicket: string;
  ticketExpiresAt: number;
  authorityExpiresAt: number;
  iceServers: DirectFileTransferIceServerConfig[];
  socket?: WebSocket;
  lastActivityAt: number;
  /** Server-authoritative inactivity deadline, never armed while an attempt is active. */
  idleExpiresAt: number;
  needsRebind: boolean;
  prepared: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface DirectFileTransferOperationRoute {
  key: string;
  leaseId: string;
  operationId: string;
  direction: DirectFileTransferDirection;
  sessionName?: string;
  descriptor: string;
  currentRequestId: string;
  terminal: boolean;
}

interface DirectFileTransferAttemptRoute {
  requestId: string;
  attemptId: string;
  attempt: number;
  operationKey: string;
  leaseId: string;
  /**
   * Data-channel attempts outlive a control-link rebind.  Keep the generation
   * that authorized this exact authority immutable, rather than replacing it
   * with the lease's newer control generation during rebind.
   */
  daemonGeneration: number;
  authorityHash: Buffer;
  authorityExpiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/** A post-restart status query has no pod-local attempt state by design. */
interface DirectFileTransferRecoveryQueryRoute {
  binding: DirectFileTransferAttemptBinding;
  leaseId: string;
  timer: ReturnType<typeof setTimeout>;
}

type PendingLeaseRequest = {
  leaseId: string;
  /** Which browser acknowledgement Server emits after daemon peer preparation. */
  mode: 'init' | 'rebind';
};

export interface DirectFileTransferRouterHooks {
  serverId(): string;
  daemonAvailable(): boolean;
  daemonSupportsDirect(): boolean;
  daemonGeneration(): number;
  resumeTicketSigningKey(): string | null;
  iceServers?(userId: string): DirectFileTransferIceServerAuthority;
  sendDaemon(message: Record<string, unknown>, generation: number): boolean;
  sendBrowser(socket: WebSocket, message: Record<string, unknown>): void;
  now?(): number;
}

function hashOpaque(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function opaqueMatches(expected: Buffer, supplied: string): boolean {
  const actual = hashOpaque(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function mintOpaque(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function unwrapDaemonTransportSequence(message: unknown): unknown {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const record = message as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'seq')) return message;
  if (!Number.isSafeInteger(record.seq) || (record.seq as number) <= 0) return message;
  const { seq: _seq, ...payload } = record;
  return payload;
}

function operationKey(leaseId: string, operationId: string): string {
  return `${leaseId}:${operationId}`;
}

function operationDescriptor(init: DirectFileTransferOperationInit): string {
  if (init.direction === DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD) {
    return JSON.stringify({
      direction: init.direction,
      sessionName: init.sessionName,
      filename: init.filename,
      size: init.size,
      mime: init.mime,
      sha256: init.sha256,
    });
  }
  return JSON.stringify({
    direction: init.direction,
    sessionName: init.sessionName,
    previewHandle: init.previewHandle,
  });
}

/**
 * Pod-local direct-file control plane.  The Server never carries a data chunk:
 * it creates an inert lease, grants one exact attempt authority at a time, and
 * singlecasts signaling/status only to the browser socket bound to that lease.
 * Browser socket loss deliberately does not close the lease; a signed ticket
 * can bind it again after a Server/WebSocket restart while WebRTC keeps moving.
 */
export class DirectFileTransferRouter {
  private readonly leases = new Map<string, DirectFileTransferLeaseRoute>();
  private readonly operations = new Map<string, DirectFileTransferOperationRoute>();
  private readonly attempts = new Map<string, DirectFileTransferAttemptRoute>();
  private readonly recoveryQueries = new Map<string, DirectFileTransferRecoveryQueryRoute>();
  private readonly leaseRequestIds = new Map<string, PendingLeaseRequest>();

  constructor(private readonly hooks: DirectFileTransferRouterHooks) {}

  handlesType(type: unknown): boolean {
    return isDirectFileTransferMessageType(type) || isLegacyDirectFileTransferMessageType(type);
  }

  handleBrowser(socket: WebSocket, userId: string, message: unknown): boolean {
    const type = (message as { type?: unknown } | null)?.type;
    if (!this.handlesType(type)) return false;

    if (isLegacyDirectFileTransferMessageType(type)) {
      this.sendLeaseError(socket, this.requestIdFrom(message), DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST, false);
      return true;
    }

    const parsed = validateDirectFileTransferBrowserMessage(message);
    if (!parsed.ok) {
      this.sendLeaseError(socket, this.requestIdFrom(message), DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST, false);
      return true;
    }

    switch (parsed.value.type) {
      case DIRECT_FILE_TRANSFER_MSG.LEASE_INIT:
        this.createLease(socket, userId, parsed.value);
        return true;
      case DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND:
        this.rebindLease(socket, userId, parsed.value);
        return true;
      case DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT:
        this.authorizeOperation(socket, userId, parsed.value);
        return true;
      case DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER:
      case DIRECT_FILE_TRANSFER_MSG.LEASE_ICE:
        this.forwardLeaseSignal(socket, userId, parsed.value);
        return true;
      case DIRECT_FILE_TRANSFER_MSG.CANCEL:
      case DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY:
        this.forwardBoundBrowserMessage(socket, userId, parsed.value);
        return true;
      default:
        this.sendLeaseError(socket, this.requestIdFrom(message), DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST, false);
        return true;
    }
  }

  handleDaemon(message: unknown, daemonGeneration: number): boolean {
    const type = (message as { type?: unknown } | null)?.type;
    if (!this.handlesType(type)) return false;
    if (isLegacyDirectFileTransferMessageType(type)) return true;

    const payload = unwrapDaemonTransportSequence(message);
    const parsed = validateDirectFileTransferDaemonMessage(payload);
    if (!parsed.ok) {
      this.failMalformedDaemonFrame(payload, daemonGeneration);
      return true;
    }

    if (parsed.value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_REBOUND) {
      this.handleLeaseRebound(parsed.value, daemonGeneration);
      return true;
    }

    if (parsed.value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED) {
      this.handleLeasePrepared(parsed.value, daemonGeneration);
      return true;
    }

    if (parsed.value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER
      || parsed.value.type === DIRECT_FILE_TRANSFER_MSG.LEASE_ICE) {
      this.handleDaemonLeaseSignal(parsed.value, daemonGeneration);
      return true;
    }

    if (parsed.value.type === DIRECT_FILE_TRANSFER_MSG.ERROR && parsed.value.scope === DIRECT_FILE_TRANSFER_ERROR_SCOPE.LEASE) {
      const pending = this.leaseRequestIds.get(parsed.value.requestId);
      const lease = pending ? this.leases.get(pending.leaseId) : undefined;
      if (lease && lease.daemonGeneration === daemonGeneration) {
        this.sendLeaseError(lease.socket, parsed.value.requestId, parsed.value.error, parsed.value.retryable, parsed.value.detail);
        this.leaseRequestIds.delete(parsed.value.requestId);
      }
      return true;
    }

    const recovery = this.recoveryQueries.get(parsed.value.requestId);
    if (recovery && this.daemonMessageMatchesRecovery(parsed.value, recovery, daemonGeneration)) {
      const lease = this.leases.get(recovery.leaseId);
      // A terminal recovery is the first point at which this fresh Server pod
      // knows the browser's old attempt ended. Start and propagate a new idle
      // window before the browser consumes the authoritative outcome.
      if (lease && this.isTerminalOperationMessage(parsed.value)) this.touchLease(lease);
      if (lease?.socket) this.hooks.sendBrowser(lease.socket, this.withServerAttachment(parsed.value, lease));
      this.observeStatusRecovery('responded');
      this.observeControlRelay('daemon_to_browser', 'status');
      this.deleteRecoveryQuery(recovery);
      return true;
    }

    const attempt = this.attempts.get(parsed.value.requestId);
    if (!attempt || !this.daemonMessageMatchesAttempt(parsed.value, attempt, daemonGeneration)) return true;
    const lease = this.leases.get(attempt.leaseId);
    const operation = this.operations.get(attempt.operationKey);
    if (!lease || !operation) return true;

    this.touchLease(lease);
    if (parsed.value.type === DIRECT_FILE_TRANSFER_MSG.TERMINAL) {
      operation.terminal = true;
      this.observeAttempt(
        parsed.value.state === DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED ? 'succeeded' : 'terminal_failed',
        operation.direction,
        attempt.attempt,
      );
      this.deleteAttempt(attempt);
    } else if (parsed.value.type === DIRECT_FILE_TRANSFER_MSG.ERROR) {
      if (!parsed.value.retryable) operation.terminal = true;
      this.observeAttempt(
        parsed.value.retryable && attempt.attempt >= DIRECT_FILE_TRANSFER_LIMITS.MAX_ATTEMPTS
          ? 'retry_exhausted'
          : 'failed',
        operation.direction,
        attempt.attempt,
      );
      this.deleteAttempt(attempt);
    } else if (parsed.value.type === DIRECT_FILE_TRANSFER_MSG.STATUS
      && (parsed.value.state === DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED
        || parsed.value.state === DIRECT_FILE_TRANSFER_TERMINAL_STATE.CANCELED
        || parsed.value.state === DIRECT_FILE_TRANSFER_TERMINAL_STATE.FAILED)) {
      operation.terminal = true;
      this.observeAttempt(
        parsed.value.state === DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED ? 'succeeded' : 'terminal_failed',
        operation.direction,
        attempt.attempt,
      );
      this.deleteAttempt(attempt);
    }
    // deleteAttempt() touches the lease only after the final active attempt is
    // removed. Attach that fresh Server deadline to every final outcome;
    // otherwise an ERROR followed by a dropped daemon TERMINAL would leave the
    // browser with the stale READY deadline.
    const routed = this.withServerAttachment(parsed.value, lease);
    if (lease.socket) this.hooks.sendBrowser(lease.socket, routed);
    this.observeControlRelay(
      'daemon_to_browser',
      parsed.value.type === DIRECT_FILE_TRANSFER_MSG.STATUS
        ? 'status'
        : parsed.value.type === DIRECT_FILE_TRANSFER_MSG.TERMINAL
          ? 'terminal'
          : 'error',
    );
    return true;
  }

  /**
   * A daemon control-link reconnect is not a data-plane failure.  Preserve
   * established WebRTC channels and wait for explicit browser rebind before
   * accepting new attempts under the new daemon generation.
   */
  setDaemonGeneration(generation: number): void {
    for (const lease of this.leases.values()) {
      if (lease.daemonGeneration !== generation) {
        // Move the control-plane route immediately.  Existing data-channel
        // attempts retain their own immutable generation and may still report
        // terminal/error through this new control link before the browser has
        // completed its lease rebind.
        lease.daemonGeneration = generation;
        lease.needsRebind = true;
        lease.prepared = false;
      }
    }
  }

  /** Browser WebSocket loss is recoverable: retain lease/operation state until TTL. */
  dropSocket(socket: WebSocket): void {
    for (const lease of this.leases.values()) {
      if (lease.socket === socket) {
        lease.socket = undefined;
        this.touchLease(lease);
      }
    }
  }

  private createLease(
    socket: WebSocket,
    userId: string,
    init: Extract<ReturnType<typeof validateDirectFileTransferBrowserMessage>, { ok: true }>['value'] & { type: typeof DIRECT_FILE_TRANSFER_MSG.LEASE_INIT },
  ): void {
    if (init.serverId !== this.hooks.serverId()) {
      this.sendLeaseError(socket, init.requestId, DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY, false);
      return;
    }
    if (!this.hooks.daemonAvailable()) {
      this.sendLeaseError(socket, init.requestId, DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE, true);
      return;
    }
    if (!this.hooks.daemonSupportsDirect()) {
      this.sendLeaseError(socket, init.requestId, DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE, true);
      return;
    }
    const signingKey = this.hooks.resumeTicketSigningKey();
    if (!signingKey) {
      this.sendLeaseError(socket, init.requestId, DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR, true);
      return;
    }

    const now = this.now();
    const existing = [...this.leases.values()].find((lease) => (
      lease.userId === userId && lease.browserTabId === init.browserTabId
      && lease.prepared && !lease.needsRebind && lease.ticketExpiresAt > now
    ));
    if (existing) {
      existing.socket = socket;
      this.touchLease(existing);
      this.observeLease('reused');
      this.sendLeaseReady(socket, init.requestId, existing);
      return;
    }

    const generation = this.hooks.daemonGeneration();
    const resolvedIce = this.resolveIceServers(userId);
    const ticketExpiresAt = now + DIRECT_FILE_TRANSFER_LIMITS.RESUME_TICKET_TTL_MS;
    const authorityExpiresAt = now + DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS;
    const leaseId = mintOpaque(24);
    const claims: DirectFileTransferResumeTicketClaims = {
      type: DIRECT_FILE_TRANSFER_RESUME_TICKET_TYPE,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      userId,
      browserTabId: init.browserTabId,
      serverId: this.hooks.serverId(),
      leaseId,
      leaseGeneration: 1,
      expiresAt: ticketExpiresAt,
    };
    const resumeTicket = signJwt(
      claims as unknown as Record<string, unknown>,
      signingKey,
      Math.ceil(DIRECT_FILE_TRANSFER_LIMITS.RESUME_TICKET_TTL_MS / 1000),
    );
    const lease = this.newLeaseRoute({
      leaseId,
      browserTabId: init.browserTabId,
      userId,
      daemonGeneration: generation,
      leaseGeneration: 1,
      resumeTicket,
      ticketExpiresAt,
      authorityExpiresAt,
      iceServers: resolvedIce.iceServers,
      socket,
      lastActivityAt: now,
      idleExpiresAt: now + DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS,
      needsRebind: false,
      prepared: false,
    });
    this.leases.set(lease.leaseId, lease);
    this.observeLease('created');
    this.leaseRequestIds.set(init.requestId, { leaseId: lease.leaseId, mode: 'init' });
    const prepare = {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: init.requestId,
      serverId: this.hooks.serverId(),
      browserTabId: lease.browserTabId,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: lease.daemonGeneration,
      expiresAt: lease.ticketExpiresAt,
      iceServers: lease.iceServers,
    };
    if (!this.hooks.sendDaemon(prepare, generation)) {
      this.deleteLease(lease);
      this.observeLease('prepare_send_failed');
      this.sendLeaseError(socket, init.requestId, DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE, true);
      return;
    }
    this.observeControlRelay('server_to_daemon', 'lease_prepare');
    // LEASE_READY is deliberately deferred until the daemon has acknowledged
    // LEASE_PREPARE.  Until then there is no peer to which an inert browser
    // offer could safely be relayed.
  }

  private rebindLease(socket: WebSocket, userId: string, rebind: DirectFileTransferLeaseRebind): void {
    if (rebind.serverId !== this.hooks.serverId() || !this.hooks.daemonAvailable()) {
      this.sendLeaseError(socket, rebind.requestId, rebind.serverId === this.hooks.serverId()
        ? DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE
        : DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY, rebind.serverId === this.hooks.serverId());
      return;
    }
    const claims = this.verifyTicket(rebind.resumeTicket);
    if (!claims || claims.userId !== userId || claims.browserTabId !== rebind.browserTabId
      || claims.serverId !== rebind.serverId || claims.leaseId !== rebind.leaseId
      || claims.leaseGeneration !== rebind.leaseGeneration || claims.expiresAt <= this.now()) {
      this.sendLeaseError(socket, rebind.requestId, DIRECT_FILE_TRANSFER_ERROR.LEASE_REBIND_FAILED, false);
      return;
    }

    const current = this.leases.get(claims.leaseId);
    if (current && (current.userId !== userId || current.browserTabId !== claims.browserTabId
      || current.leaseGeneration !== claims.leaseGeneration)) {
      this.sendLeaseError(socket, rebind.requestId, DIRECT_FILE_TRANSFER_ERROR.LEASE_REBIND_FAILED, false);
      return;
    }
    const generation = this.hooks.daemonGeneration();
    const lease = current ?? this.newLeaseRoute({
      leaseId: claims.leaseId,
      browserTabId: claims.browserTabId,
      userId,
      daemonGeneration: generation,
      leaseGeneration: claims.leaseGeneration,
      resumeTicket: rebind.resumeTicket,
      ticketExpiresAt: claims.expiresAt,
      authorityExpiresAt: this.now() + DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS,
      iceServers: this.resolveIceServers(userId).iceServers,
      socket,
      lastActivityAt: this.now(),
      idleExpiresAt: this.now() + DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS,
      needsRebind: true,
      prepared: false,
    });
    if (!current) this.leases.set(lease.leaseId, lease);
    lease.socket = socket;
    lease.daemonGeneration = generation;
    // A signed ticket restores only the Server-side route.  Do not accept a
    // new offer, operation, or status request until this generation has
    // explicitly acknowledged the rebind on the daemon control link.
    lease.needsRebind = true;
    lease.prepared = false;
    this.touchLease(lease);
    this.observeLease('rebind_requested');
    this.leaseRequestIds.set(rebind.requestId, { leaseId: lease.leaseId, mode: 'rebind' });
    // A reconnecting Server has no right to assume the daemon's old peer is
    // still present.  LEASE_PREPARE is daemon-only and idempotently creates or
    // reuses that inert peer; a browser ticket is never forwarded or logged.
    const prepare = {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: rebind.requestId,
      serverId: this.hooks.serverId(),
      browserTabId: lease.browserTabId,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: lease.daemonGeneration,
      expiresAt: lease.ticketExpiresAt,
      iceServers: lease.iceServers,
    };
    if (!this.hooks.sendDaemon(prepare, generation)) {
      this.leaseRequestIds.delete(rebind.requestId);
      this.observeLease('rebind_prepare_send_failed');
      this.sendLeaseError(socket, rebind.requestId, DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE, true);
      return;
    }
    this.observeControlRelay('server_to_daemon', 'lease_prepare');
  }

  private authorizeOperation(socket: WebSocket, userId: string, init: DirectFileTransferOperationInit): void {
    const lease = this.leases.get(init.leaseId);
    if (!lease || lease.socket !== socket || lease.userId !== userId || lease.browserTabId !== init.browserTabId
      || init.serverId !== this.hooks.serverId() || init.leaseGeneration !== lease.leaseGeneration) {
      this.sendOperationError(socket, init, DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY, false);
      return;
    }
    if (lease.needsRebind || init.daemonGeneration !== this.hooks.daemonGeneration()
      || init.daemonGeneration !== lease.daemonGeneration) {
      this.sendOperationError(socket, init, DIRECT_FILE_TRANSFER_ERROR.STALE_DAEMON_GENERATION, true);
      return;
    }
    if (!this.hooks.daemonAvailable()) {
      this.sendOperationError(socket, init, DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE, true);
      return;
    }
    if (!this.hooks.daemonSupportsDirect()) {
      this.sendOperationError(socket, init, DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE, true);
      return;
    }
    const key = operationKey(lease.leaseId, init.operationId);
    const descriptor = operationDescriptor(init);
    const existing = this.operations.get(key);
    if (existing && (existing.direction !== init.direction || existing.descriptor !== descriptor || existing.terminal)) {
      this.sendOperationError(socket, init, DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST, false);
      return;
    }
    if ([...this.attempts.values()].filter((attempt) => attempt.leaseId === lease.leaseId).length
      >= DIRECT_FILE_TRANSFER_LIMITS.MAX_ACTIVE_CHANNELS_PER_LEASE) {
      this.sendOperationError(socket, init, DIRECT_FILE_TRANSFER_ERROR.TOO_MANY_CHANNELS, true);
      return;
    }
    if (existing) {
      const prior = this.attempts.get(existing.currentRequestId);
      if (prior) this.deleteAttempt(prior);
    }
    const operation = existing ?? {
      key,
      leaseId: lease.leaseId,
      operationId: init.operationId,
      direction: init.direction,
      ...(init.sessionName ? { sessionName: init.sessionName } : {}),
      descriptor,
      currentRequestId: init.requestId,
      terminal: false,
    };
    operation.currentRequestId = init.requestId;
    this.operations.set(key, operation);

    const authority = mintOpaque();
    const authorityExpiresAt = Math.min(lease.authorityExpiresAt, this.now() + DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS);
    const attempt = this.newAttemptRoute({
      requestId: init.requestId,
      attemptId: init.attemptId,
      attempt: init.attempt,
      operationKey: key,
      leaseId: lease.leaseId,
      daemonGeneration: lease.daemonGeneration,
      authorityHash: hashOpaque(authority),
      authorityExpiresAt,
    });
    this.attempts.set(attempt.requestId, attempt);
    this.touchLease(lease);
    this.observeAttempt('authorized', init.direction, init.attempt);

    const authorityMessage = {
      ...init,
      daemonGeneration: lease.daemonGeneration,
      authority,
      authorityExpiresAt,
      channelLabel: `direct-file-${init.attemptId}`,
      iceServers: lease.iceServers,
    };
    const prepare = { ...authorityMessage, type: DIRECT_FILE_TRANSFER_MSG.PREPARE };
    if (!this.hooks.sendDaemon(prepare, lease.daemonGeneration)) {
      this.deleteAttempt(attempt);
      this.observeAttempt('prepare_send_failed', init.direction, init.attempt);
      this.sendOperationError(
        socket,
        init,
        DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE,
        true,
        undefined,
        lease.idleExpiresAt,
      );
      return;
    }
    this.observeControlRelay('server_to_daemon', 'operation_prepare');
    this.hooks.sendBrowser(socket, {
      ...authorityMessage,
      type: DIRECT_FILE_TRANSFER_MSG.AUTHORIZED,
    });
    this.observeControlRelay('server_to_browser', 'operation_authorized');
  }

  private forwardBoundBrowserMessage(
    socket: WebSocket,
    userId: string,
    message: BoundBrowserMessage,
  ): void {
    if (message.type === DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY) {
      this.forwardStatusQuery(socket, userId, message);
      return;
    }
    const attempt = this.attempts.get(message.requestId);
    if (!attempt || attempt.attemptId !== message.attemptId || attempt.leaseId !== message.leaseId
      || !opaqueMatches(attempt.authorityHash, message.authority)) {
      this.sendBoundErrorForMessage(socket, message, DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY, false);
      return;
    }
    const lease = this.leases.get(attempt.leaseId);
    const operation = this.operations.get(attempt.operationKey);
    if (!lease || !operation || lease.socket !== socket || lease.userId !== userId
      || (lease.browserTabId !== message.browserTabId
        || lease.leaseGeneration !== message.leaseGeneration
        || message.serverId !== this.hooks.serverId()
        // A CANCEL must preserve the immutable binding of the active
        // data-channel authority across control-link rebind.  It is relayed
        // over the current daemon control connection below, but the daemon
        // ledger validates the original attempt generation in the frame.
        || message.daemonGeneration !== attempt.daemonGeneration)
      || operation.currentRequestId !== message.requestId) {
      this.sendBoundErrorForMessage(socket, message, DIRECT_FILE_TRANSFER_ERROR.STALE_ATTEMPT, true);
      return;
    }
    if (!this.hooks.sendDaemon(message as unknown as Record<string, unknown>, lease.daemonGeneration)) {
      this.deleteAttempt(attempt);
      this.sendBoundErrorForMessage(
        socket,
        message,
        DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE,
        true,
        lease.idleExpiresAt,
      );
      return;
    }
    if (message.type === DIRECT_FILE_TRANSFER_MSG.CANCEL) {
      operation.terminal = true;
      this.deleteAttempt(attempt);
      this.observeAttempt('canceled', operation.direction, attempt.attempt);
      // The daemon may acknowledge the cancel after this route has been
      // removed.  Give the browser a Server-authored terminal outcome now so
      // it can settle the operation and adopt the freshly re-armed lease
      // deadline without waiting for a frame we will intentionally drop.
      this.sendServerTerminal(
        socket,
        this.attemptBinding(lease, operation, attempt),
        DIRECT_FILE_TRANSFER_TERMINAL_STATE.CANCELED,
        lease.idleExpiresAt,
      );
    } else {
      this.touchLease(lease);
    }
    this.observeControlRelay('browser_to_daemon', 'cancel');
  }

  /**
   * A Server restart intentionally loses pod-local attempts.  Status recovery
   * must therefore authenticate the re-bound lease and relay the exact query
   * to the daemon ledger without trying to resurrect an old authority.  The
   * daemon owns the durable operation correlation and returns no bytes.
   */
  private forwardStatusQuery(socket: WebSocket, userId: string, message: DirectFileTransferStatusQuery): void {
    const lease = this.leases.get(message.leaseId);
    if (!lease || lease.socket !== socket || lease.userId !== userId
      || lease.browserTabId !== message.browserTabId
      || lease.leaseGeneration !== message.leaseGeneration
      || message.serverId !== this.hooks.serverId()
      || message.daemonGeneration !== lease.daemonGeneration
      || lease.needsRebind || !lease.prepared) {
      this.sendBoundErrorForMessage(socket, message, DIRECT_FILE_TRANSFER_ERROR.STALE_ATTEMPT, true);
      return;
    }
    if (!this.hooks.daemonAvailable() || !this.hooks.daemonSupportsDirect()) {
      this.sendBoundErrorForMessage(
        socket,
        message,
        DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE,
        true,
        lease.idleExpiresAt,
      );
      return;
    }
    const current = this.recoveryQueries.get(message.requestId);
    if (current) this.deleteRecoveryQuery(current);
    const recovery = this.newRecoveryQuery(message);
    this.recoveryQueries.set(message.requestId, recovery);
    this.observeStatusRecovery('queried');
    if (!this.hooks.sendDaemon(message as unknown as Record<string, unknown>, lease.daemonGeneration)) {
      this.deleteRecoveryQuery(recovery);
      this.observeStatusRecovery('send_failed');
      this.sendBoundErrorForMessage(
        socket,
        message,
        DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE,
        true,
        lease.idleExpiresAt,
      );
      return;
    }
    this.observeControlRelay('browser_to_daemon', 'status');
    this.touchLease(lease);
  }

  private forwardLeaseSignal(socket: WebSocket, userId: string, message: LeaseBrowserSignal): void {
    const lease = this.leases.get(message.leaseId);
    // Keep ownership and lease identity fail-closed: a different browser, user,
    // server, tab, or lease generation must never learn whether a daemon peer
    // exists.  A matching lease that is merely between PREPARE/REBIND is a
    // transport race, however.  Reporting that as invalid_authority made the
    // browser treat a recoverable renegotiation as terminal and skip its
    // documented retry-then-HTTP fallback.
    if (!lease || lease.socket !== socket || lease.userId !== userId
      || message.serverId !== this.hooks.serverId()
      || message.browserTabId !== lease.browserTabId
      || message.leaseGeneration !== lease.leaseGeneration) {
      this.sendLeaseError(socket, message.requestId, DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY, false);
      return;
    }
    if (!lease.prepared || lease.needsRebind || message.daemonGeneration !== lease.daemonGeneration) {
      this.sendLeaseError(socket, message.requestId, DIRECT_FILE_TRANSFER_ERROR.STALE_DAEMON_GENERATION, true);
      return;
    }
    if (!this.hooks.sendDaemon(message as unknown as Record<string, unknown>, lease.daemonGeneration)) {
      this.sendLeaseError(socket, message.requestId, DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE, true);
      return;
    }
    this.observeControlRelay('browser_to_daemon', 'lease_signal');
  }

  private handleDaemonLeaseSignal(
    message: Extract<DirectFileTransferDaemonMessage,
      { type: typeof DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER | typeof DIRECT_FILE_TRANSFER_MSG.LEASE_ICE }>,
    daemonGeneration: number,
  ): void {
    const lease = this.leases.get(message.leaseId);
    if (!lease || !lease.socket || !lease.prepared || lease.needsRebind
      || daemonGeneration !== lease.daemonGeneration
      || message.serverId !== this.hooks.serverId()
      || message.browserTabId !== lease.browserTabId
      || message.leaseGeneration !== lease.leaseGeneration
      || message.daemonGeneration !== lease.daemonGeneration) return;
    const socket = lease.socket;
    this.hooks.sendBrowser(socket, message as unknown as Record<string, unknown>);
    this.observeControlRelay('daemon_to_browser', 'lease_signal');
  }

  private handleLeaseRebound(
    message: Extract<DirectFileTransferDaemonMessage, { type: typeof DIRECT_FILE_TRANSFER_MSG.LEASE_REBOUND }>,
    daemonGeneration: number,
  ): void {
    const pending = this.leaseRequestIds.get(message.requestId);
    const lease = pending ? this.leases.get(pending.leaseId) : undefined;
    if (!lease || lease.daemonGeneration !== daemonGeneration || message.serverId !== this.hooks.serverId()
      || message.leaseId !== lease.leaseId || message.leaseGeneration !== lease.leaseGeneration
      || message.browserTabId !== lease.browserTabId) return;

    lease.needsRebind = false;
    lease.prepared = true;
    lease.daemonGeneration = daemonGeneration;
    for (const attempt of this.attempts.values()) {
      if (attempt.leaseId === lease.leaseId) {
        // The daemon preserved the peer; recovery status now uses its current control generation.
        const operation = this.operations.get(attempt.operationKey);
        if (operation) operation.currentRequestId = attempt.requestId;
      }
    }
    this.leaseRequestIds.delete(message.requestId);
    // This acknowledgement confirms an already accepted rebind. It must not
    // extend that rebind's server-authoritative idle budget.
    this.observeLease('rebound');
    if (lease.socket) {
      this.hooks.sendBrowser(lease.socket, {
        ...message,
        daemonGeneration,
        resumeTicket: lease.resumeTicket,
        expiresAt: lease.ticketExpiresAt,
        idleExpiresAt: lease.idleExpiresAt,
        iceServers: lease.iceServers,
      });
      this.observeControlRelay('server_to_browser', 'lease_rebound');
    }
  }

  private handleLeasePrepared(message: DirectFileTransferLeasePrepared, daemonGeneration: number): void {
    const pending = this.leaseRequestIds.get(message.requestId);
    const lease = pending ? this.leases.get(pending.leaseId) : undefined;
    if (!pending || !lease || lease.daemonGeneration !== daemonGeneration
      || message.serverId !== this.hooks.serverId()
      || message.browserTabId !== lease.browserTabId
      || message.leaseId !== lease.leaseId
      || message.leaseGeneration !== lease.leaseGeneration
      || message.daemonGeneration !== lease.daemonGeneration) return;
    lease.prepared = true;
    lease.needsRebind = false;
    this.leaseRequestIds.delete(message.requestId);
    // The idle window is authoritative from accepted LEASE_INIT/REBIND, not
    // from a potentially delayed daemon peer-preparation acknowledgement.
    // Re-arming here would let a wedged PREPARE extend an otherwise expired
    // lease without another browser action.
    this.observeLease(pending.mode === 'init' ? 'ready' : 'rebound');
    if (!lease.socket) return;
    if (pending.mode === 'init') {
      this.sendLeaseReady(lease.socket, message.requestId, lease);
      this.observeControlRelay('server_to_browser', 'lease_ready');
      return;
    }
    this.hooks.sendBrowser(lease.socket, {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_REBOUND,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: message.requestId,
      serverId: this.hooks.serverId(),
      browserTabId: lease.browserTabId,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: lease.daemonGeneration,
      resumeTicket: lease.resumeTicket,
      expiresAt: lease.ticketExpiresAt,
      idleExpiresAt: lease.idleExpiresAt,
      iceServers: lease.iceServers,
    });
    this.observeControlRelay('server_to_browser', 'lease_rebound');
  }

  private daemonMessageMatchesAttempt(
    message: OperationDaemonMessage,
    attempt: DirectFileTransferAttemptRoute,
    daemonGeneration: number,
  ): boolean {
    const lease = this.leases.get(attempt.leaseId);
    const operation = this.operations.get(attempt.operationKey);
    // Rebind gates new operations, negotiation and status recovery, but it
    // must not discard a terminal/error from an already-authorized data
    // attempt.  That attempt remains tied to its immutable generation below.
    if (!lease || !operation || daemonGeneration !== lease.daemonGeneration) return false;
    return message.serverId === this.hooks.serverId()
      && message.browserTabId === lease.browserTabId
      && message.leaseId === lease.leaseId
      && message.leaseGeneration === lease.leaseGeneration
      // The WebSocket/control generation is current (checked above), while a
      // surviving data attempt retains the generation in which its authority
      // was minted.  Terminal/error must therefore match the immutable route,
      // not the re-bound lease's generation.
      && message.daemonGeneration === attempt.daemonGeneration
      && message.requestId === attempt.requestId
      && message.attemptId === attempt.attemptId
      && message.attempt === attempt.attempt
      && message.operationId === operation.operationId
      && message.direction === operation.direction;
  }

  private daemonMessageMatchesRecovery(
    message: OperationDaemonMessage,
    recovery: DirectFileTransferRecoveryQueryRoute,
    daemonGeneration: number,
  ): boolean {
    const lease = this.leases.get(recovery.leaseId);
    const binding = recovery.binding;
    return !!lease && !lease.needsRebind && daemonGeneration === lease.daemonGeneration
      && message.serverId === this.hooks.serverId()
      && message.browserTabId === lease.browserTabId
      && message.leaseId === lease.leaseId
      && message.leaseGeneration === lease.leaseGeneration
      && message.daemonGeneration === lease.daemonGeneration
      && message.requestId === binding.requestId
      && message.attemptId === binding.attemptId
      && message.attempt === binding.attempt
      && message.direction === binding.direction
      && message.operationId === binding.operationId;
  }

  private failMalformedDaemonFrame(payload: unknown, daemonGeneration: number): void {
    const record = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : undefined;
    const requestId = typeof record?.requestId === 'string' ? record.requestId : undefined;
    if (!requestId) return;
    const attempt = this.attempts.get(requestId);
    if (attempt) {
      const lease = this.leases.get(attempt.leaseId);
      const operation = this.operations.get(attempt.operationKey);
      // Removing the attempt first re-arms the reusable lease before we emit
      // the final server error.  A malformed daemon frame must not leave the
      // browser holding an expired READY deadline.
      this.deleteAttempt(attempt);
      if (lease && operation && lease.daemonGeneration === daemonGeneration && lease.socket) {
        this.sendOperationError(
          lease.socket,
          this.attemptBinding(lease, operation, attempt),
          DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR,
          true,
          undefined,
          lease.idleExpiresAt,
        );
      }
      return;
    }
    const recovery = this.recoveryQueries.get(requestId);
    if (recovery) {
      const lease = this.leases.get(recovery.leaseId);
      if (lease?.daemonGeneration === daemonGeneration && lease.socket) {
        this.sendOperationError(
          lease.socket,
          recovery.binding,
          DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR,
          true,
          undefined,
          lease.idleExpiresAt,
        );
      }
      this.deleteRecoveryQuery(recovery);
      return;
    }
    const pending = this.leaseRequestIds.get(requestId);
    const lease = pending ? this.leases.get(pending.leaseId) : undefined;
    if (lease && lease.daemonGeneration === daemonGeneration) {
      this.sendLeaseError(lease.socket, requestId, DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR, true);
    }
  }

  /**
   * The daemon may never choose an idle deadline.  Every terminal/status
   * response receives this Server-authored field so the browser updates the
   * same lease expiry the router will enforce.  File metadata remains attached
   * only after replacing its server id at the trust boundary.
   */
  private withServerAttachment(
    message: DirectFileTransferDaemonMessage,
    lease: DirectFileTransferLeaseRoute,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...message };
    if (this.isTerminalOperationMessage(message)
      || (message.type === DIRECT_FILE_TRANSFER_MSG.ERROR
        && message.scope === DIRECT_FILE_TRANSFER_ERROR_SCOPE.OPERATION)) {
      result.idleExpiresAt = lease.idleExpiresAt;
    }
    if ('attachment' in message && message.attachment) {
      result.attachment = { ...message.attachment, serverId: this.hooks.serverId() };
    }
    return result;
  }

  private isTerminalOperationMessage(message: DirectFileTransferDaemonMessage): boolean {
    return message.type === DIRECT_FILE_TRANSFER_MSG.TERMINAL
      || (message.type === DIRECT_FILE_TRANSFER_MSG.STATUS
        && (message.state === DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED
          || message.state === DIRECT_FILE_TRANSFER_TERMINAL_STATE.CANCELED
          || message.state === DIRECT_FILE_TRANSFER_TERMINAL_STATE.FAILED));
  }

  private sendLeaseReady(socket: WebSocket, requestId: string, lease: DirectFileTransferLeaseRoute): void {
    this.hooks.sendBrowser(socket, {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_READY,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId,
      serverId: this.hooks.serverId(),
      browserTabId: lease.browserTabId,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: lease.daemonGeneration,
      resumeTicket: lease.resumeTicket,
      expiresAt: lease.ticketExpiresAt,
      idleExpiresAt: lease.idleExpiresAt,
      iceServers: lease.iceServers,
    });
  }

  private sendLeaseError(
    socket: WebSocket | undefined,
    requestId: string,
    error: DirectFileTransferError,
    retryable: boolean,
    detail?: string,
  ): void {
    if (!socket) return;
    this.hooks.sendBrowser(socket, {
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.LEASE,
      requestId,
      error,
      retryable,
      ...(detail ? { detail: detail.slice(0, DIRECT_FILE_TRANSFER_LIMITS.ERROR_DETAIL_BYTES) } : {}),
    });
  }

  private sendOperationError(
    socket: WebSocket | undefined,
    binding: DirectFileTransferAttemptBinding,
    error: DirectFileTransferError,
    retryable: boolean,
    detail?: string,
    idleExpiresAt?: number,
  ): void {
    if (!socket) return;
    this.hooks.sendBrowser(socket, {
      ...binding,
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.OPERATION,
      error,
      retryable,
      ...(detail ? { detail: detail.slice(0, DIRECT_FILE_TRANSFER_LIMITS.ERROR_DETAIL_BYTES) } : {}),
      ...(idleExpiresAt === undefined ? {} : { idleExpiresAt }),
    });
  }

  private sendBoundErrorForMessage(
    socket: WebSocket,
    message: BoundBrowserMessage,
    error: DirectFileTransferError,
    retryable: boolean,
    idleExpiresAt?: number,
  ): void {
    this.sendOperationError(socket, message, error, retryable, undefined, idleExpiresAt);
  }

  /**
   * Cancellation is terminal at the Server authority boundary.  The daemon's
   * later terminal acknowledgement is intentionally ignored after route
   * cleanup, so this server-authored frame is the browser's definitive
   * outcome and carries the fresh reusable-lease deadline.
   */
  private sendServerTerminal(
    socket: WebSocket | undefined,
    binding: DirectFileTransferAttemptBinding,
    state: typeof DIRECT_FILE_TRANSFER_TERMINAL_STATE.CANCELED,
    idleExpiresAt: number,
  ): void {
    if (!socket) return;
    this.hooks.sendBrowser(socket, {
      ...binding,
      type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      state,
      idleExpiresAt,
    });
    this.observeControlRelay('server_to_browser', 'terminal');
  }

  private requestIdFrom(message: unknown): string {
    const candidate = message && typeof message === 'object' && !Array.isArray(message)
      ? (message as Record<string, unknown>).requestId
      : undefined;
    return typeof candidate === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(candidate)
      ? candidate
      : mintOpaque(12);
  }

  private resolveIceServers(userId: string): DirectFileTransferIceServerAuthority {
    try {
      const configured = this.hooks.iceServers?.(userId);
      return configured && configured.iceServers.length > 0
        ? configured
        : { iceServers: [...DIRECT_FILE_TRANSFER_ICE_SERVERS] };
    } catch {
      return { iceServers: [...DIRECT_FILE_TRANSFER_ICE_SERVERS] };
    }
  }

  private verifyTicket(ticket: string): DirectFileTransferResumeTicketClaims | null {
    const key = this.hooks.resumeTicketSigningKey();
    if (!key) return null;
    const raw = verifyJwt(ticket, key);
    if (!raw) return null;
    const parsed = validateDirectFileTransferResumeTicketClaims(raw);
    return parsed.ok ? parsed.value : null;
  }

  private newLeaseRoute(input: Omit<DirectFileTransferLeaseRoute, 'timer'>): DirectFileTransferLeaseRoute {
    const lease = {} as DirectFileTransferLeaseRoute;
    Object.assign(lease, input, { timer: undefined });
    lease.timer = this.scheduleLeaseExpiry(lease);
    return lease;
  }

  private newAttemptRoute(input: Omit<DirectFileTransferAttemptRoute, 'timer'>): DirectFileTransferAttemptRoute {
    const attempt = {} as DirectFileTransferAttemptRoute;
    Object.assign(attempt, input, { timer: undefined as unknown as ReturnType<typeof setTimeout> });
    const wait = Math.max(0, attempt.authorityExpiresAt - this.now());
    attempt.timer = setTimeout(() => {
      const current = this.attempts.get(attempt.requestId);
      if (current !== attempt || current.authorityExpiresAt > this.now()) return;
      const lease = this.leases.get(current.leaseId);
      const operation = this.operations.get(current.operationKey);
      if (operation) {
        this.observeAttempt(
          current.attempt >= DIRECT_FILE_TRANSFER_LIMITS.MAX_ATTEMPTS ? 'retry_exhausted' : 'failed',
          operation.direction,
          current.attempt,
        );
      }
      this.deleteAttempt(current);
      if (lease && operation && lease.socket) {
        this.sendOperationError(
          lease.socket,
          this.attemptBinding(lease, operation, current),
          DIRECT_FILE_TRANSFER_ERROR.AUTHORITY_EXPIRED,
          true,
          undefined,
          lease.idleExpiresAt,
        );
      }
    }, wait);
    attempt.timer.unref?.();
    return attempt;
  }

  private newRecoveryQuery(binding: DirectFileTransferAttemptBinding): DirectFileTransferRecoveryQueryRoute {
    const recovery = {} as DirectFileTransferRecoveryQueryRoute;
    const timer = setTimeout(() => {
      const current = this.recoveryQueries.get(binding.requestId);
      if (current !== recovery) return;
      const lease = this.leases.get(current.leaseId);
      if (lease?.socket) {
        this.sendOperationError(
          lease.socket,
          current.binding,
          DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE,
          true,
          undefined,
          lease.idleExpiresAt,
        );
      }
      this.observeStatusRecovery('timed_out');
      this.deleteRecoveryQuery(current);
    }, DIRECT_FILE_TRANSFER_LIMITS.STATUS_RECOVERY_DEADLINE_MS);
    timer.unref?.();
    Object.assign(recovery, { binding, leaseId: binding.leaseId, timer });
    return recovery;
  }

  /**
   * Active transfers have their own authority deadline.  In particular, do
   * not arm an idle timer for them: an expiry callback would otherwise observe
   * the still-active attempt and reschedule its already-past deadline at 0ms.
   */
  private scheduleLeaseExpiry(lease: DirectFileTransferLeaseRoute): ReturnType<typeof setTimeout> | undefined {
    if (this.hasActiveAttempt(lease.leaseId)) return undefined;
    const now = this.now();
    const deadline = Math.min(lease.idleExpiresAt, lease.ticketExpiresAt);
    const timer = setTimeout(() => {
      const current = this.leases.get(lease.leaseId);
      if (!current || current !== lease) return;
      current.timer = undefined;
      if (this.hasActiveAttempt(current.leaseId)) return;
      const currentNow = this.now();
      if (currentNow < current.ticketExpiresAt && currentNow < current.idleExpiresAt) {
        current.timer = this.scheduleLeaseExpiry(current);
        return;
      }
      this.deleteLease(current);
    }, Math.max(0, deadline - now));
    timer.unref?.();
    return timer;
  }

  private touchLease(lease: DirectFileTransferLeaseRoute): void {
    const now = this.now();
    lease.lastActivityAt = now;
    lease.idleExpiresAt = now + DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS;
    if (lease.timer) clearTimeout(lease.timer);
    lease.timer = this.scheduleLeaseExpiry(lease);
  }

  private deleteAttempt(attempt: DirectFileTransferAttemptRoute): void {
    clearTimeout(attempt.timer);
    if (this.attempts.get(attempt.requestId) !== attempt) return;
    this.attempts.delete(attempt.requestId);
    const lease = this.leases.get(attempt.leaseId);
    if (lease && !this.hasActiveAttempt(lease.leaseId)) this.touchLease(lease);
  }

  private hasActiveAttempt(leaseId: string): boolean {
    return [...this.attempts.values()].some((attempt) => attempt.leaseId === leaseId);
  }

  private deleteRecoveryQuery(recovery: DirectFileTransferRecoveryQueryRoute): void {
    clearTimeout(recovery.timer);
    if (this.recoveryQueries.get(recovery.binding.requestId) === recovery) {
      this.recoveryQueries.delete(recovery.binding.requestId);
    }
  }

  private deleteLease(lease: DirectFileTransferLeaseRoute): void {
    if (lease.timer) clearTimeout(lease.timer);
    if (this.leases.get(lease.leaseId) === lease) this.leases.delete(lease.leaseId);
    for (const [requestId, pending] of this.leaseRequestIds) {
      if (pending.leaseId === lease.leaseId) this.leaseRequestIds.delete(requestId);
    }
    for (const attempt of [...this.attempts.values()]) {
      if (attempt.leaseId === lease.leaseId) this.deleteAttempt(attempt);
    }
    for (const recovery of [...this.recoveryQueries.values()]) {
      if (recovery.leaseId === lease.leaseId) this.deleteRecoveryQuery(recovery);
    }
    for (const [key, operation] of this.operations) {
      if (operation.leaseId === lease.leaseId) this.operations.delete(key);
    }
  }

  private attemptBinding(
    lease: DirectFileTransferLeaseRoute,
    operation: DirectFileTransferOperationRoute,
    attempt: DirectFileTransferAttemptRoute,
  ): DirectFileTransferAttemptBinding {
    return {
      serverId: this.hooks.serverId(),
      browserTabId: lease.browserTabId,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: attempt.daemonGeneration,
      requestId: attempt.requestId,
      attemptId: attempt.attemptId,
      attempt: attempt.attempt,
      direction: operation.direction,
      operationId: operation.operationId,
    };
  }

  /**
   * Only bounded enum/numeric values reach telemetry.  In particular this
   * deliberately excludes user ids, lease/operation/request ids, filenames,
   * preview handles, tickets, authorities, SDP, ICE and byte payloads.
   */
  private observeLease(event: LeaseMetricEvent): void {
    incrementCounter('direct_file_transfer_lease_total', { event });
    logger.info({ event }, 'Direct file transfer lease lifecycle');
  }

  private observeAttempt(event: AttemptMetricEvent, direction: DirectFileTransferDirection, attempt: number): void {
    const labels = { event, direction, attempt: String(attempt) };
    incrementCounter('direct_file_transfer_attempt_total', labels);
    logger.info(labels, 'Direct file transfer attempt lifecycle');
  }

  private observeStatusRecovery(event: StatusRecoveryMetricEvent): void {
    incrementCounter('direct_file_transfer_status_recovery_total', { event });
    logger.info({ event }, 'Direct file transfer status recovery');
  }

  private observeControlRelay(direction: ControlRelayDirection, family: ControlRelayFamily): void {
    // This is an explicit control-plane metric: it intentionally records no
    // byte count because direct file payloads never traverse this router.
    incrementCounter('direct_file_transfer_control_relay_total', { direction, family });
  }

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }
}
