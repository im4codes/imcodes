import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type WebSocket from 'ws';
import {
  DIRECT_FILE_TRANSFER_ERROR,
  DIRECT_FILE_TRANSFER_ICE_SERVERS,
  DIRECT_FILE_TRANSFER_LIMITS,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_STATE,
  validateDirectFileTransferBrowserMessage,
  validateDirectFileTransferDaemonMessage,
  type DirectFileTransferInit,
  type DirectFileTransferIceServerConfig,
} from '../../../shared/direct-file-transfer.js';
import { TURN_SERVICE_DEFAULTS } from '../../../shared/turn-service.js';

export interface DirectFileTransferIceServerAuthority {
  iceServers: DirectFileTransferIceServerConfig[];
  credentialExpiresAt?: number;
}

interface DirectFileTransferRoute {
  requestId: string;
  clientUploadId: string;
  socket: WebSocket;
  userId: string;
  daemonGeneration: number;
  capabilityHash: Buffer;
  expiresAt: number;
  hardExpiresAt?: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface DirectFileTransferRouterHooks {
  serverId(): string;
  daemonAvailable(): boolean;
  daemonSupportsDirect(): boolean;
  daemonSupportsAuthenticatedIce?(): boolean;
  daemonGeneration(): number;
  iceServers?(userId: string): DirectFileTransferIceServerAuthority;
  sendDaemon(message: Record<string, unknown>, generation: number): boolean;
  sendBrowser(socket: WebSocket, message: Record<string, unknown>): void;
}

function hashCapability(capability: string): Buffer {
  return createHash('sha256').update(capability, 'utf8').digest();
}

function capabilityMatches(record: DirectFileTransferRoute, capability: string): boolean {
  const actual = hashCapability(capability);
  return actual.length === record.capabilityHash.length && timingSafeEqual(actual, record.capabilityHash);
}

function mintOpaque(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Daemon `ServerLink.send()` wraps every outbound payload with a monotonically
 * increasing `seq`. The direct-transfer protocol deliberately rejects unknown
 * keys, so validate the protocol payload only after removing that trusted
 * transport envelope field. Keep this normalization daemon-side only: browser
 * frames must still satisfy the exact public schema as received.
 */
function unwrapDaemonTransportSequence(message: unknown): unknown {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const record = message as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'seq')) return message;
  if (!Number.isSafeInteger(record.seq) || (record.seq as number) <= 0) return message;
  const { seq: _seq, ...payload } = record;
  return payload;
}

export class DirectFileTransferRouter {
  private readonly routes = new Map<string, DirectFileTransferRoute>();
  private readonly uploadIds = new Map<string, string>();

  constructor(private readonly hooks: DirectFileTransferRouterHooks) {}

  handlesType(type: unknown): boolean {
    return typeof type === 'string' && type.startsWith('direct_file.');
  }

  handleBrowser(socket: WebSocket, userId: string, message: unknown): boolean {
    if (!this.handlesType((message as { type?: unknown } | null)?.type)) return false;
    const parsed = validateDirectFileTransferBrowserMessage(message);
    if (!parsed.ok) {
      const requestId = typeof (message as { requestId?: unknown } | null)?.requestId === 'string'
        ? (message as { requestId: string }).requestId
        : mintOpaque(12);
      this.sendError(socket, requestId, DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST, false);
      return true;
    }
    if (parsed.value.type === DIRECT_FILE_TRANSFER_MSG.INIT) {
      this.authorize(socket, userId, parsed.value);
      return true;
    }

    const route = this.routes.get(parsed.value.requestId);
    if (!route || route.socket !== socket || route.userId !== userId
      || route.expiresAt <= Date.now() || !capabilityMatches(route, parsed.value.capability)) {
      this.sendError(socket, parsed.value.requestId, DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY, false);
      return true;
    }
    if (route.daemonGeneration !== this.hooks.daemonGeneration()) {
      this.failRoute(route, DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE, true);
      return true;
    }
    if (!this.hooks.sendDaemon(parsed.value as unknown as Record<string, unknown>, route.daemonGeneration)) {
      this.failRoute(route, DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE, true);
      return true;
    }
    if (parsed.value.type === DIRECT_FILE_TRANSFER_MSG.CANCEL) this.deleteRoute(route);
    return true;
  }

  handleDaemon(message: unknown, daemonGeneration: number): boolean {
    if (!this.handlesType((message as { type?: unknown } | null)?.type)) return false;
    const payload = unwrapDaemonTransportSequence(message);
    const parsed = validateDirectFileTransferDaemonMessage(payload);
    if (!parsed.ok) {
      const requestId = typeof (message as { requestId?: unknown } | null)?.requestId === 'string'
        ? (message as { requestId: string }).requestId
        : undefined;
      const route = requestId ? this.routes.get(requestId) : undefined;
      if (route?.daemonGeneration === daemonGeneration) {
        // A malformed response from the authenticated daemon used to vanish
        // here, leaving the browser to report only an opaque negotiation
        // timeout. Fail the bound request immediately while preserving the
        // strict protocol boundary and relay fallback.
        this.failRoute(route, DIRECT_FILE_TRANSFER_ERROR.INTERNAL_ERROR, true);
      }
      return true;
    }
    const route = this.routes.get(parsed.value.requestId);
    const capability = 'capability' in parsed.value ? parsed.value.capability : undefined;
    if (!route || route.daemonGeneration !== daemonGeneration || !capability || !capabilityMatches(route, capability)) {
      return true;
    }
    if (route.expiresAt <= Date.now()) {
      this.failRoute(
        route,
        DIRECT_FILE_TRANSFER_ERROR.AUTHORITY_EXPIRED,
        true,
        route.hardExpiresAt !== undefined && route.expiresAt >= route.hardExpiresAt
          ? 'TURN credentials reached their absolute expiry; retry to obtain fresh credentials'
          : undefined,
      );
      return true;
    }
    if (parsed.value.type === DIRECT_FILE_TRANSFER_MSG.PROGRESS) {
      this.renewRouteAuthority(route);
    }
    const routed = parsed.value.type === DIRECT_FILE_TRANSFER_MSG.DONE
      ? { ...parsed.value, attachment: { ...parsed.value.attachment, serverId: this.hooks.serverId() } }
      : parsed.value.type === DIRECT_FILE_TRANSFER_MSG.STATUS && parsed.value.attachment
        ? { ...parsed.value, attachment: { ...parsed.value.attachment, serverId: this.hooks.serverId() } }
        : parsed.value;
    this.hooks.sendBrowser(route.socket, routed as unknown as Record<string, unknown>);
    if (parsed.value.type === DIRECT_FILE_TRANSFER_MSG.DONE
      || parsed.value.type === DIRECT_FILE_TRANSFER_MSG.ERROR
      || (parsed.value.type === DIRECT_FILE_TRANSFER_MSG.STATUS
        && parsed.value.state === DIRECT_FILE_TRANSFER_STATE.COMMITTED)) {
      this.deleteRoute(route);
    }
    return true;
  }

  setDaemonGeneration(generation: number): void {
    for (const route of [...this.routes.values()]) {
      if (route.daemonGeneration !== generation) {
        this.failRoute(route, DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE, true);
      }
    }
  }

  dropSocket(socket: WebSocket): void {
    for (const route of [...this.routes.values()]) {
      if (route.socket === socket) this.deleteRoute(route);
    }
  }

  private authorize(socket: WebSocket, userId: string, init: DirectFileTransferInit): void {
    if (!this.hooks.daemonAvailable()) {
      this.sendError(socket, init.requestId, DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE, true);
      return;
    }
    if (!this.hooks.daemonSupportsDirect()) {
      this.sendError(socket, init.requestId, DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE, true);
      return;
    }
    if (this.routes.has(init.requestId) || this.uploadIds.has(init.clientUploadId)) {
      this.sendError(socket, init.requestId, DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST, false, 'Duplicate upload identity');
      return;
    }
    if (this.routes.size >= DIRECT_FILE_TRANSFER_LIMITS.MAX_PER_DAEMON) {
      this.sendError(socket, init.requestId, DIRECT_FILE_TRANSFER_ERROR.TOO_MANY_TRANSFERS, true);
      return;
    }
    let browserCount = 0;
    for (const route of this.routes.values()) {
      if (route.socket === socket) browserCount++;
    }
    if (browserCount >= DIRECT_FILE_TRANSFER_LIMITS.MAX_PER_BROWSER) {
      this.sendError(socket, init.requestId, DIRECT_FILE_TRANSFER_ERROR.TOO_MANY_TRANSFERS, true);
      return;
    }

    const generation = this.hooks.daemonGeneration();
    const capability = mintOpaque();
    const now = Date.now();
    const resolvedIce = this.resolveIceServers(userId);
    const hardExpiresAt = resolvedIce.credentialExpiresAt === undefined
      ? undefined
      : resolvedIce.credentialExpiresAt - TURN_SERVICE_DEFAULTS.CREDENTIAL_EXPIRY_SAFETY_MS;
    const expiresAt = Math.min(
      now + DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS,
      hardExpiresAt ?? Number.MAX_SAFE_INTEGER,
    );
    if (expiresAt <= now) {
      this.sendError(socket, init.requestId, DIRECT_FILE_TRANSFER_ERROR.AUTHORITY_EXPIRED, true,
        'TURN credentials expired before the transfer could start; retry to obtain fresh credentials');
      return;
    }
    const timer = this.scheduleRouteExpiry(init.requestId, expiresAt);
    const route: DirectFileTransferRoute = {
      requestId: init.requestId,
      clientUploadId: init.clientUploadId,
      socket,
      userId,
      daemonGeneration: generation,
      capabilityHash: hashCapability(capability),
      expiresAt,
      ...(hardExpiresAt === undefined ? {} : { hardExpiresAt }),
      timer,
    };
    this.routes.set(route.requestId, route);
    this.uploadIds.set(route.clientUploadId, route.requestId);

    // sessionName is a browser→Server authorization hint for shared tabs. It
    // is intentionally removed before the strict daemon/browser transfer
    // authority is minted; the opaque route capability owns all later frames.
    const { sessionName: _sessionName, ...transferInit } = init;
    const authority = {
      ...transferInit,
      capability,
      expiresAt,
      iceServers: resolvedIce.iceServers,
    };
    const prepare = { ...authority, type: DIRECT_FILE_TRANSFER_MSG.PREPARE };
    if (!this.hooks.sendDaemon(prepare, generation)) {
      this.failRoute(route, DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE, true);
      return;
    }
    this.hooks.sendBrowser(socket, { ...authority, type: DIRECT_FILE_TRANSFER_MSG.AUTHORIZED });
  }

  private sendError(
    socket: WebSocket,
    requestId: string,
    error: string,
    retryable: boolean,
    detail?: string,
  ): void {
    this.hooks.sendBrowser(socket, {
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      requestId,
      error,
      retryable,
      ...(detail ? { detail: detail.slice(0, DIRECT_FILE_TRANSFER_LIMITS.ERROR_DETAIL_BYTES) } : {}),
    });
  }

  private resolveIceServers(userId: string): DirectFileTransferIceServerAuthority {
    if (!this.hooks.daemonSupportsAuthenticatedIce?.()) {
      return { iceServers: [...DIRECT_FILE_TRANSFER_ICE_SERVERS] };
    }
    try {
      const configured = this.hooks.iceServers?.(userId);
      return configured && configured.iceServers.length > 0
        ? configured
        : { iceServers: [...DIRECT_FILE_TRANSFER_ICE_SERVERS] };
    } catch {
      return { iceServers: [...DIRECT_FILE_TRANSFER_ICE_SERVERS] };
    }
  }

  private failRoute(route: DirectFileTransferRoute, error: string, retryable: boolean, detail?: string): void {
    this.sendError(route.socket, route.requestId, error, retryable, detail);
    this.deleteRoute(route);
  }

  private scheduleRouteExpiry(requestId: string, expiresAt: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const route = this.routes.get(requestId);
      if (route && route.expiresAt <= Date.now()) {
        const turnCredentialExpired = route.hardExpiresAt !== undefined && route.expiresAt >= route.hardExpiresAt;
        this.failRoute(
          route,
          DIRECT_FILE_TRANSFER_ERROR.AUTHORITY_EXPIRED,
          true,
          turnCredentialExpired
            ? 'TURN credentials reached their absolute expiry; retry to obtain fresh credentials'
            : undefined,
        );
      }
    }, Math.max(0, expiresAt - Date.now()));
    timer.unref?.();
    return timer;
  }

  private renewRouteAuthority(route: DirectFileTransferRoute): void {
    clearTimeout(route.timer);
    route.expiresAt = Math.min(
      Date.now() + DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS,
      route.hardExpiresAt ?? Number.MAX_SAFE_INTEGER,
    );
    route.timer = this.scheduleRouteExpiry(route.requestId, route.expiresAt);
  }

  private deleteRoute(route: DirectFileTransferRoute): void {
    clearTimeout(route.timer);
    this.routes.delete(route.requestId);
    if (this.uploadIds.get(route.clientUploadId) === route.requestId) this.uploadIds.delete(route.clientUploadId);
  }
}
