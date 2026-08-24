import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type WebSocket from 'ws';
import type { Database } from '../db/client.js';
import {
  canOperateControlledMachine,
  resolveRemoteDesktopHostAccess,
  type ControlledMachineAccessRow,
} from '../share/machine-access.js';
import {
  MACHINE_PRESENCE_STALENESS_MS,
  NODE_ROLE,
  type MachineAccessRole,
} from '../../../shared/remote-exec.js';
import { validateControlledNodeCapabilities } from '../../../shared/controlled-node-capabilities.js';
import {
  REMOTE_DESKTOP_AUDIT_EVENT,
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_ERROR,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_MODE_REASON,
  REMOTE_DESKTOP_STATE,
  REMOTE_DESKTOP_TERMINAL_REASON,
  validateRemoteDesktopBrowserMessage,
  validateRemoteDesktopDaemonMessage,
  type RemoteDesktopBrowserMessage,
  type RemoteDesktopAccessMode,
  type RemoteDesktopStart,
  type RemoteDesktopTerminalReason,
  type RemoteDesktopRoute as RemoteDesktopConnectionRoute,
} from '../../../shared/remote-desktop.js';
import { TURN_SERVICE_DEFAULTS } from '../../../shared/turn-service.js';
import {
  REMOTE_DESKTOP_ACTOR_SOURCE,
  REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND,
  REMOTE_DESKTOP_OUTBOX_EFFECT,
  REMOTE_DESKTOP_PRIVACY_LIMITS,
  isRemoteDesktopActorRenewable,
  type RemoteDesktopActor,
  type RemoteDesktopBootstrapProof,
  type RemoteDesktopOutboxEvent,
} from '../../../shared/remote-desktop-access.js';
import type { RemoteDesktopGuestOutboxAuthorityMatch } from '../services/remote-desktop-guest-outbox-worker.js';
import type { TurnIceServerAuthority } from './turn-credentials.js';
import { resolveHostIdForServer } from '../services/remote-desktop-host-identity.js';
import {
  PrivacyBarrierError,
  PRIVACY_REFUSAL,
  activateShieldedRouteReplacements,
  activateRouteTx,
  allocateRemoteDesktopRouteGeneration,
  closeRouteTx,
  getPrivacyState,
  joinShieldedRoute,
  reserveRouteTx,
} from '../services/remote-desktop-management-privacy.js';

/** Why an access row does not permit remote desktop; see `accessFault`. */
type RemoteDesktopAccessFault =
  | 'denied'
  | 'exec_disabled'
  | 'unsupported_platform'
  | 'offline'
  | 'capability';

type AccessResolver = (
  db: Database,
  userId: string,
  serverId: string,
  now: number,
) => Promise<ControlledMachineAccessRow | null>;

export interface RemoteDesktopRouterHooks {
  serverId(): string;
  database(): Database | null;
  daemonAvailable(): boolean;
  daemonSupportsRemoteDesktop(): boolean;
  featureEnabled?(): boolean;
  daemonGeneration(): number;
  allocateRouteGeneration?(db: Database): Promise<number>;
  iceServers(userId: string): TurnIceServerAuthority;
  sendDaemon(message: Record<string, unknown>, generation: number): boolean;
  sendBrowser(socket: WebSocket, message: Record<string, unknown>): void;
  resolveAccess?: AccessResolver;
  redeemGuestBootstrap?(input: {
    proof: RemoteDesktopBootstrapProof;
    routeGeneration: number;
    clientIp: string;
    now: number;
  }): Promise<{
    actor: RemoteDesktopActor;
    sessionId: string;
    routeGeneration: number;
    registryAuthority: RemoteDesktopRouteRegistryIdentity['authority'];
  } | null>;
  resolveGuestActor?(actor: RemoteDesktopActor, now: number): Promise<RemoteDesktopActor | null>;
  requestAttendedConsent?(input: {
    actor: RemoteDesktopActor;
    sessionId: string;
    routeGeneration: number;
    daemonGeneration: number;
    mode: RemoteDesktopAccessMode;
  }): Promise<boolean | 'approved' | 'denied' | 'timeout' | 'cancelled' | 'unavailable'>;
  cancelPendingGuestConsent?(
    actor: RemoteDesktopActor,
    cause: 'browser_disconnect' | 'authority_revoked' | 'privacy_epoch',
  ): Promise<void>;
  cancelHostAttendedConsents?(hostId: string): Promise<void>;
  /** True only when PREPARE+routeGeneration is guaranteed to create a
   * default-shielded route that cannot emit ordinary capture before the exact
   * management-privacy ACK. */
  supportsDefaultShieldedRoute?(): boolean;
  routeRegistry?: RemoteDesktopRouteRegistry;
  audit?(event: string, fields: Readonly<Record<string, string | number | boolean>>): void;
  now?(): number;
}

export interface RemoteDesktopRouteRegistryIdentity {
  hostId: string;
  routeGeneration: number;
  guestSessionId?: string;
  authority:
    | { actorSource: typeof REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT }
    | {
      actorSource:
        | typeof REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK
        | typeof REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK;
      actorAuditId: string;
      authorityGeneration: number;
      expiryRevision: number;
      commitRevision: number;
    }
    | {
      actorSource: typeof REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD;
      actorAuditId: string;
      sessionAuditId: string;
      passwordGeneration: number;
    };
}

export interface RemoteDesktopRouteRegistry {
  reserve(db: Database, input: {
    serverId: string;
    routeId: string;
    routeGeneration: number;
    now: number;
  }): Promise<RemoteDesktopRouteRegistryIdentity>;
  activate(db: Database, input: RemoteDesktopRouteRegistryIdentity & {
    routeId: string;
    now: number;
  }): Promise<void>;
  close(db: Database, input: RemoteDesktopRouteRegistryIdentity & {
    routeId: string;
    now: number;
  }): Promise<void>;
}

const postgresRouteRegistry: RemoteDesktopRouteRegistry = {
  reserve: (db, input) => db.transaction(async (tx) => {
    const hostId = await resolveHostIdForServer(tx, input.serverId);
    if (!hostId) throw new Error('remote_desktop_host_unmapped');
    await reserveRouteTx(tx, {
      hostId,
      routeId: input.routeId,
      routeGeneration: input.routeGeneration,
      actorSource: REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT,
      executionServerId: input.serverId,
      now: input.now,
    });
    return {
      hostId,
      routeGeneration: input.routeGeneration,
      authority: { actorSource: REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT },
    };
  }),
  activate: (db, input) => db.transaction(async (tx) => {
    await activateRouteTx(tx, input);
    if (input.guestSessionId) {
      await tx.execute(
        `UPDATE remote_desktop_guest_sessions
            SET state = 'active', connected_at = COALESCE(connected_at, $2), updated_at = $2
          WHERE id = $1 AND state = 'admitting'`,
        [input.guestSessionId, input.now],
      );
    }
  }),
  close: (db, input) => db.transaction(async (tx) => {
    await closeRouteTx(tx, input);
    if (input.guestSessionId) {
      await tx.execute(
        `UPDATE remote_desktop_guest_sessions
            SET state = 'closed', route_id = NULL, route_generation = NULL,
                closed_at = $2, updated_at = $2
          WHERE id = $1 AND state <> 'closed'`,
        [input.guestSessionId, input.now],
      );
    }
  }),
};

interface RemoteDesktopRoute {
  requestId: string;
  sessionId: string;
  socket: WebSocket;
  actor: RemoteDesktopActor;
  principalId: string;
  userId?: string;
  accessRole?: MachineAccessRole;
  daemonGeneration: number;
  daemonSuspended: boolean;
  capabilityHash: Buffer;
  createdAt: number;
  expiresAt: number;
  leaseExpiresAt: number;
  mode: RemoteDesktopAccessMode;
  inputEpoch: number;
  reconnectAttempt: number;
  state: string;
  statusReceived: boolean;
  workerInputEnabled: boolean;
  auditedInputEnabled: boolean;
  connectionRoute?: RemoteDesktopConnectionRoute;
  selectedDisplayId?: string;
  layoutRevision?: number;
  browserIceCandidates: number;
  daemonIceCandidates: number;
  signalWindowStartedAt: number;
  signalWindowCount: number;
  modeWindowStartedAt: number;
  modeWindowCount: number;
  offerCount: number;
  answerCount: number;
  revalidationInFlight: boolean;
  registryIdentity: RemoteDesktopRouteRegistryIdentity;
  registryCloseStarted: boolean;
  negotiationTimer: ReturnType<typeof setTimeout>;
  absoluteTimer: ReturnType<typeof setTimeout>;
  leaseTimer: ReturnType<typeof setTimeout>;
  renewalTimer: ReturnType<typeof setInterval>;
}

interface PendingGuestAdmission {
  actor: RemoteDesktopActor;
  sessionId: string;
  registryIdentity: RemoteDesktopRouteRegistryIdentity;
}

export interface RemoteDesktopRouterStats {
  active: number;
  controlling: number;
  admitted: number;
  rejected: number;
  dropped: number;
  terminated: number;
}

export interface RemoteDesktopSessionSummary {
  sessionId: string;
  mode: RemoteDesktopAccessMode;
  inputEpoch: number;
  state: string;
  createdAt: number;
  expiresAt: number;
  leaseExpiresAt: number;
  selectedDisplayId?: string;
  layoutRevision?: number;
}

export type RemoteDesktopOutboxApplyResult =
  | { status: 'applied' }
  | { status: 'duplicate' }
  | { status: 'not_owner' };

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

function hashCapability(capability: string): Buffer {
  return createHash('sha256').update(capability, 'utf8').digest();
}

function capabilityMatches(route: RemoteDesktopRoute, capability: string): boolean {
  const actual = hashCapability(capability);
  return actual.length === route.capabilityHash.length
    && timingSafeEqual(actual, route.capabilityHash);
}

function mintOpaque(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function unwrapDaemonTransportSequence(message: unknown): unknown {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const record = message as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'seq')) return message;
  if (!Number.isSafeInteger(record.seq) || (record.seq as number) <= 0) return message;
  const { seq: _sequence, ...payload } = record;
  return payload;
}

/**
 * Per-controlled-machine, in-memory authorization and signaling registry.
 * Media and input never traverse this class: after ICE/DTLS connects they flow
 * browser ↔ worker over SRTP/SCTP (direct first, TURN only as fallback).
 */
export class RemoteDesktopRouter {
  private readonly routesBySession = new Map<string, RemoteDesktopRoute>();
  private readonly sessionByRequest = new Map<string, string>();
  private readonly capabilityKey = randomBytes(32);
  private readonly startsBySocket = new Map<WebSocket, number[]>();
  private readonly startsByUser = new Map<string, number[]>();
  private readonly pendingGuestBySocket = new Map<WebSocket, PendingGuestAdmission>();
  private readonly guestPrincipalBySocket = new Map<WebSocket, string>();
  private machineStarts: number[] = [];
  private machineSignalWindowStartedAt = 0;
  private machineSignalWindowCount = 0;
  private auditWindowStartedAt = 0;
  private auditWindowCount = 0;
  private admissionQueue: Promise<void> = Promise.resolve();
  private readonly routeRegistry: RemoteDesktopRouteRegistry;
  private counters: Omit<RemoteDesktopRouterStats, 'active' | 'controlling'> = {
    admitted: 0,
    rejected: 0,
    dropped: 0,
    terminated: 0,
  };

  constructor(private readonly hooks: RemoteDesktopRouterHooks) {
    this.routeRegistry = hooks.routeRegistry ?? postgresRouteRegistry;
  }

  handlesType(type: unknown): boolean {
    return typeof type === 'string' && type.startsWith('remote_desktop.');
  }

  stats(): RemoteDesktopRouterStats {
    return {
      active: this.routesBySession.size,
      controlling: [...this.routesBySession.values()].filter((route) => (
        route.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL
      )).length,
      ...this.counters,
    };
  }

  async handleBrowser(socket: WebSocket, userId: string, message: unknown): Promise<boolean> {
    if (!this.handlesType((message as { type?: unknown } | null)?.type)) return false;
    const parsed = validateRemoteDesktopBrowserMessage(message);
    if (!parsed.ok) {
      const candidate = (message as { requestId?: unknown } | null)?.requestId;
      const requestId = typeof candidate === 'string' && REQUEST_ID_RE.test(candidate)
        ? candidate
        : mintOpaque(16);
      this.counters.rejected++;
      this.sendError(socket, requestId, REMOTE_DESKTOP_ERROR.INVALID_REQUEST, false);
      return true;
    }

    if (parsed.value.type === REMOTE_DESKTOP_MSG.START) {
      const operation = this.admissionQueue.then(() => this.authorize(socket, userId, parsed.value as RemoteDesktopStart));
      this.admissionQueue = operation.catch(() => {});
      await operation;
      return true;
    }

    await this.forwardBrowserSignal(socket, `account:${userId}`, parsed.value);
    return true;
  }

  async redeemGuestBootstrap(
    socket: WebSocket,
    proof: RemoteDesktopBootstrapProof,
    clientIp = '0.0.0.0',
  ): Promise<boolean> {
    if (this.pendingGuestBySocket.has(socket) || !this.hooks.redeemGuestBootstrap) return false;
    const daemonGeneration = this.hooks.daemonGeneration();
    if (!this.hooks.daemonAvailable() || !this.hooks.daemonSupportsRemoteDesktop()) return false;
    const db = this.hooks.database();
    if (!db) return false;
    const routeGeneration = await this.allocateRouteGeneration(db).catch(() => null);
    if (routeGeneration === null) return false;
    const redeemed = await this.hooks.redeemGuestBootstrap({
      proof,
      routeGeneration,
      clientIp,
      now: this.now(),
    }).catch(() => null);
    if (!redeemed || redeemed.routeGeneration !== routeGeneration
      || redeemed.actor.endpointGeneration !== daemonGeneration
      || daemonGeneration !== this.hooks.daemonGeneration()) return false;
    this.pendingGuestBySocket.set(socket, {
      actor: redeemed.actor,
      sessionId: redeemed.sessionId,
      registryIdentity: {
        hostId: redeemed.actor.hostId,
        routeGeneration: redeemed.routeGeneration,
        guestSessionId: redeemed.sessionId,
        authority: redeemed.registryAuthority,
      },
    });
    return true;
  }

  async handleGuestBrowser(socket: WebSocket, message: unknown): Promise<boolean> {
    if (!this.handlesType((message as { type?: unknown } | null)?.type)) return false;
    const parsed = validateRemoteDesktopBrowserMessage(message);
    if (!parsed.ok) {
      this.counters.rejected++;
      return true;
    }
    const pending = this.pendingGuestBySocket.get(socket);
    if (parsed.value.type === REMOTE_DESKTOP_MSG.START) {
      if (!pending) return true;
      const operation = this.admissionQueue.then(() => (
        this.authorizeGuest(socket, pending, parsed.value as RemoteDesktopStart)
      ));
      this.admissionQueue = operation.catch(() => {});
      await operation;
      return true;
    }
    await this.forwardBrowserSignal(socket, this.guestPrincipalBySocket.get(socket) ?? '', parsed.value);
    return true;
  }

  handleDaemon(message: unknown, daemonGeneration: number): boolean {
    if (!this.handlesType((message as { type?: unknown } | null)?.type)) return false;
    const payload = unwrapDaemonTransportSequence(message);
    const parsed = validateRemoteDesktopDaemonMessage(payload);
    if (!parsed.ok) {
      const record = message && typeof message === 'object' && !Array.isArray(message)
        ? message as Record<string, unknown>
        : null;
      const route = this.findRoute(record?.requestId, record?.sessionId);
      if (route?.daemonGeneration === daemonGeneration) {
        this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.PROTOCOL_ERROR, true);
      } else {
        this.counters.dropped++;
      }
      return true;
    }

    const route = this.routesBySession.get(parsed.value.sessionId);
    if (!route
      || route.requestId !== parsed.value.requestId
      || route.daemonGeneration !== daemonGeneration
      || route.daemonSuspended
      || !capabilityMatches(route, parsed.value.capability)
      || route.expiresAt <= this.now()) {
      this.counters.dropped++;
      return true;
    }
    if (!this.consumeSignalBudget(route)) {
      this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.PROTOCOL_ERROR, true);
      return true;
    }

    if (parsed.value.type === REMOTE_DESKTOP_MSG.MODE_STATE) {
      if (parsed.value.mode !== route.mode || parsed.value.inputEpoch !== route.inputEpoch) {
        this.counters.dropped++;
        return true;
      }
    }

    let outbound = parsed.value as unknown as Record<string, unknown>;
    if (parsed.value.type === REMOTE_DESKTOP_MSG.ANSWER) {
      if (route.answerCount >= route.offerCount) {
        this.counters.dropped++;
        return true;
      }
      route.answerCount++;
    } else if (parsed.value.type === REMOTE_DESKTOP_MSG.ICE) {
      route.daemonIceCandidates++;
      if (route.daemonIceCandidates > REMOTE_DESKTOP_LIMITS.MAX_ICE_CANDIDATES) {
        this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.PROTOCOL_ERROR, true);
        return true;
      }
    } else if (parsed.value.type === REMOTE_DESKTOP_MSG.STATUS) {
      if (parsed.value.mode !== route.mode || parsed.value.inputEpoch !== route.inputEpoch) {
        this.counters.dropped++;
        return true;
      }
      const previousState = route.state;
      route.state = parsed.value.state;
      route.statusReceived = true;
      route.workerInputEnabled = parsed.value.inputEnabled;
      route.connectionRoute = parsed.value.route;
      if (parsed.value.selectedDisplayId !== undefined
        && parsed.value.layoutRevision !== undefined) {
        const monitorChanged = route.selectedDisplayId !== undefined
          && (route.selectedDisplayId !== parsed.value.selectedDisplayId
            || route.layoutRevision !== parsed.value.layoutRevision);
        route.selectedDisplayId = parsed.value.selectedDisplayId;
        route.layoutRevision = parsed.value.layoutRevision;
        if (monitorChanged) {
          this.audit(REMOTE_DESKTOP_AUDIT_EVENT.DISPLAY_CHANGED, route, {
            selectedDisplayId: parsed.value.selectedDisplayId,
            layoutRevision: parsed.value.layoutRevision,
          });
        }
      }
      const effectiveInputEnabled = route.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL
        && parsed.value.inputEnabled;
      if (effectiveInputEnabled !== route.auditedInputEnabled) {
        route.auditedInputEnabled = effectiveInputEnabled;
        this.audit(REMOTE_DESKTOP_AUDIT_EVENT.INPUT_ENABLED, route, {
          enabled: effectiveInputEnabled,
          inputEpoch: route.inputEpoch,
        });
      }
      const stats = this.stats();
      // Aggregate collaboration counts come from the Server registry rather
      // than a potentially compromised worker. They remain metadata-only.
      outbound = {
        ...parsed.value,
        viewerCount: stats.active,
        controllerCount: stats.controlling,
      };
      if (parsed.value.state === REMOTE_DESKTOP_STATE.DIRECT
        || parsed.value.state === REMOTE_DESKTOP_STATE.RELAYED) {
        clearTimeout(route.negotiationTimer);
        if (previousState !== parsed.value.state) {
          this.audit(REMOTE_DESKTOP_AUDIT_EVENT.CONNECTED, route, {
            relayed: parsed.value.state === REMOTE_DESKTOP_STATE.RELAYED,
          });
        }
      }
    }

    this.hooks.sendBrowser(route.socket, outbound);
    if (parsed.value.type === REMOTE_DESKTOP_MSG.STATUS) {
      this.publishCollaborationCounts(route.sessionId);
    }
    if (parsed.value.type === REMOTE_DESKTOP_MSG.TERMINAL) {
      if (parsed.value.reason === REMOTE_DESKTOP_TERMINAL_REASON.STOPPED_BY_LOCAL_USER) {
        void this.hooks.cancelHostAttendedConsents?.(route.actor.hostId).catch(() => {});
      }
      this.audit(
        parsed.value.reason === REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED
          ? REMOTE_DESKTOP_AUDIT_EVENT.REVOKED
          : REMOTE_DESKTOP_AUDIT_EVENT.STOPPED,
        route,
        { reason: parsed.value.reason },
      );
      this.deleteRoute(route);
    }
    return true;
  }

  setDaemonGeneration(generation: number): void {
    for (const route of [...this.routesBySession.values()]) {
      if (route.daemonGeneration !== generation) {
        // A replacement connection is not itself authority to revive a route.
        // Freeze it until post-auth durable reconciliation either completes a
        // real shield acknowledgement or terminates it fail closed.
        route.daemonSuspended = true;
      }
    }
  }

  /** Keep old routes inert across a bounded daemon reconnect. */
  suspendDaemonGeneration(generation: number): void {
    for (const route of this.routesBySession.values()) {
      if (route.daemonGeneration === generation) route.daemonSuspended = true;
    }
  }

  /** Exact post-commit cancellation for pre-PREPARE rows removed by begin. */
  cancelPendingRoutes(hostId: string, routes: readonly { routeId: string; routeGeneration: number }[]): number {
    const keys = new Set(routes.map((route) => `${route.routeId}#${route.routeGeneration}`));
    let cancelled = 0;
    for (const [socket, pending] of [...this.pendingGuestBySocket.entries()]) {
      const key = `${pending.sessionId}#${pending.registryIdentity.routeGeneration}`;
      if (pending.registryIdentity.hostId !== hostId || !keys.has(key)) continue;
      this.pendingGuestBySocket.delete(socket);
      this.closePendingGuest(pending, 'privacy_epoch');
      this.sendError(socket, mintOpaque(16), REMOTE_DESKTOP_ERROR.CAPABILITY_UNAVAILABLE, true);
      try { socket.close(1012, 'retry'); } catch { /* already closed/test double */ }
      cancelled++;
    }
    for (const route of [...this.routesBySession.values()]) {
      const key = `${route.sessionId}#${route.registryIdentity.routeGeneration}`;
      if (route.registryIdentity.hostId !== hostId || !keys.has(key)) continue;
      this.sendError(route.socket, route.requestId, REMOTE_DESKTOP_ERROR.CAPABILITY_UNAVAILABLE, true);
      this.deleteRoute(route);
      cancelled++;
    }
    return cancelled;
  }

  /**
   * Rebind suspended in-memory routes to an authenticated replacement daemon.
   * Only a live, already-shielded epoch permits transparent recovery.  The
   * replacement PREPARE stays quarantined from the browser until the owning
   * Worker returns the exact new snapshot ACK; every other case terminates.
   */
  async reconcileDaemonReplacement(daemonGeneration: number): Promise<number> {
    const suspended = [...this.routesBySession.values()].filter((route) => (
      route.daemonSuspended && route.daemonGeneration !== daemonGeneration
    ));
    if (suspended.length === 0) return 0;
    const db = this.hooks.database();
    if (!db || !this.hooks.supportsDefaultShieldedRoute?.()) {
      for (const route of suspended) {
        this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED, false);
      }
      return 0;
    }

    const byHost = new Map<string, RemoteDesktopRoute[]>();
    for (const route of suspended) {
      const group = byHost.get(route.registryIdentity.hostId) ?? [];
      group.push(route);
      byHost.set(route.registryIdentity.hostId, group);
    }

    let recovered = 0;
    for (const [hostId, routes] of byHost) {
      try {
        if (routes.some((route) => (
          this.routesBySession.get(route.sessionId) !== route
          || route.expiresAt <= this.now()
          || route.leaseExpiresAt <= this.now()
        ))) throw new Error('route_replacement_authority_expired');
        const priorState = await getPrivacyState(db, hostId);
        if (!priorState?.epochId
          || (priorState.phase !== 'starting' && priorState.phase !== 'active')
          || priorState.executionServerId !== this.hooks.serverId()) {
          throw new Error('route_replacement_not_shielded');
        }
        const replacements = await Promise.all(routes.map(async (route) => ({
          previous: {
            routeId: route.sessionId,
            routeGeneration: route.registryIdentity.routeGeneration,
          },
          replacement: {
            routeId: route.sessionId,
            routeGeneration: await this.allocateRouteGeneration(db),
          },
        })));
        const state = await joinShieldedRoute(db, {
          hostId,
          epochId: priorState.epochId,
          executionServerId: this.hooks.serverId(),
          daemonGeneration,
          replacements,
          now: this.now(),
        });

        for (let index = 0; index < routes.length; index++) {
          const route = routes[index]!;
          const replacement = replacements[index]!.replacement;
          route.daemonGeneration = daemonGeneration;
          route.registryIdentity.routeGeneration = replacement.routeGeneration;
          route.actor = { ...route.actor, endpointGeneration: daemonGeneration } as RemoteDesktopActor;
          route.reconnectAttempt += 1;
          route.state = REMOTE_DESKTOP_STATE.PREPARING;
          route.workerInputEnabled = false;
          route.auditedInputEnabled = false;
          route.statusReceived = false;
        }
        // Only dispatch after every process-local identity mirrors the atomic
        // database replacement.  A send failure can then close the exact new
        // rows rather than leaking an unreferenced shielding incarnation.
        for (const route of routes) {
          const iceAuthority = this.hooks.iceServers(route.userId ?? route.actor.auditId);
          const capability = this.deriveCapability(route.requestId, route.sessionId);
          const authority = {
            requestId: route.requestId,
            sessionId: route.sessionId,
            capability,
            expiresAt: route.expiresAt,
            leaseExpiresAt: route.leaseExpiresAt,
            daemonGeneration,
            mode: route.mode,
            inputEpoch: route.inputEpoch,
            iceServers: iceAuthority.iceServers,
          };
          if (!this.hooks.sendDaemon({
            type: REMOTE_DESKTOP_MSG.PREPARE,
            ...authority,
            routeGeneration: route.registryIdentity.routeGeneration,
            reconnectAttempt: route.reconnectAttempt,
          }, daemonGeneration)) {
            throw new Error('replacement_prepare_failed');
          }
        }

        const waitDeadline = Date.now() + REMOTE_DESKTOP_PRIVACY_LIMITS.ROUTE_REPLACEMENT_ACK_MS;
        let acknowledged = false;
        while (Date.now() < waitDeadline) {
          if (routes.some((route) => this.routesBySession.get(route.sessionId) !== route)) break;
          const current = await getPrivacyState(db, hostId);
          if (current?.epochId !== state.epochId || current.revision !== state.revision) break;
          if (current.phase === 'active'
            && current.routeSnapshot.length === current.acknowledgedRoutes.length
            && current.routeSnapshot.every((expected) => current.acknowledgedRoutes.some((actual) => (
              actual.routeId === expected.routeId
              && actual.routeGeneration === expected.routeGeneration
            )))) {
            await activateShieldedRouteReplacements(db, {
              hostId,
              epochId: state.epochId!,
              revision: state.revision,
              routes: state.routeSnapshot,
              now: this.now(),
            });
            acknowledged = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!acknowledged) throw new Error('replacement_shield_ack_timeout');

        for (const route of routes) {
          if (this.routesBySession.get(route.sessionId) !== route
            || route.expiresAt <= this.now()
            || route.leaseExpiresAt <= this.now()) {
            throw new Error('route_replacement_authority_expired');
          }
          route.daemonSuspended = false;
          const capability = this.deriveCapability(route.requestId, route.sessionId);
          this.hooks.sendBrowser(route.socket, {
            type: REMOTE_DESKTOP_MSG.AUTHORIZED,
            requestId: route.requestId,
            sessionId: route.sessionId,
            capability,
            expiresAt: route.expiresAt,
            leaseExpiresAt: route.leaseExpiresAt,
            daemonGeneration,
            mode: route.mode,
            inputEpoch: route.inputEpoch,
            iceServers: this.hooks.iceServers(route.userId ?? route.actor.auditId).iceServers,
          });
          recovered++;
        }
      } catch {
        for (const route of routes) {
          this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED, false);
        }
      }
    }
    return recovered;
  }

  dropSocket(socket: WebSocket): void {
    this.startsBySocket.delete(socket);
    this.guestPrincipalBySocket.delete(socket);
    const pending = this.pendingGuestBySocket.get(socket);
    if (pending) {
      this.pendingGuestBySocket.delete(socket);
      this.closePendingGuest(pending, 'browser_disconnect');
    }
    for (const route of [...this.routesBySession.values()]) {
      if (route.socket === socket) {
        this.stopDaemon(route);
        this.audit(REMOTE_DESKTOP_AUDIT_EVENT.STOPPED, route, { browserDisconnected: true });
        this.deleteRoute(route);
      }
    }
  }

  stopAll(reason: RemoteDesktopTerminalReason = REMOTE_DESKTOP_TERMINAL_REASON.INTERNAL_ERROR): void {
    for (const route of [...this.routesBySession.values()]) this.failRoute(route, reason, true);
  }

  /** Re-resolve only this user's live grants after a share mutation commits. */
  async revalidateUser(userId: string): Promise<void> {
    const routes = [...this.routesBySession.values()].filter((route) => route.userId === userId);
    await Promise.all(routes.map((route) => this.renewLease(route)));
  }

  /** Metadata-only status; capabilities, signaling, ICE and input never leave the registry. */
  sessionsForUser(userId: string): RemoteDesktopSessionSummary[] {
    return [...this.routesBySession.values()]
      .filter((route) => route.userId === userId)
      .map((route) => ({
        sessionId: route.sessionId,
        mode: route.mode,
        inputEpoch: route.inputEpoch,
        state: route.state,
        createdAt: route.createdAt,
        expiresAt: route.expiresAt,
        leaseExpiresAt: route.leaseExpiresAt,
        ...(route.selectedDisplayId === undefined
          ? {}
          : { selectedDisplayId: route.selectedDisplayId }),
        ...(route.layoutRevision === undefined
          ? {}
          : { layoutRevision: route.layoutRevision }),
      }));
  }

  stopSessionForUser(userId: string, sessionId: string): boolean {
    const route = this.routesBySession.get(sessionId);
    if (!route || route.userId !== userId) return false;
    this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.STOPPED_BY_CONTROLLER, true);
    return true;
  }

  /**
   * Apply one already-authorized durable guest effect to the exact live
   * process-local route. The production adapter verifies the PostgreSQL
   * authority tuple before entering this method; this layer additionally
   * binds the side effect to the in-memory host + route generation so an
   * event can never land on a replacement route.
   */
  applyGuestOutboxEffect(
    event: RemoteDesktopOutboxEvent,
    routeId: string,
    routeGeneration: number,
    authority: RemoteDesktopGuestOutboxAuthorityMatch,
  ): RemoteDesktopOutboxApplyResult {
    const pendingEntry = [...this.pendingGuestBySocket.entries()].find(([, pending]) => (
      pending.sessionId === routeId
    ));
    if (pendingEntry) {
      const [socket, pending] = pendingEntry;
      if (!remoteDesktopOutboxAuthorityMatches(event, authority)
        || pending.registryIdentity.hostId !== event.hostId
        || !remoteDesktopRouteAuthorityTransitionMatches(pending.registryIdentity, event)
        || pending.registryIdentity.routeGeneration !== routeGeneration) {
        return { status: 'not_owner' };
      }
      // A pending route has not reached PREPARE and therefore cannot apply a
      // downgrade or deadline in place safely: its local-consent prompt may
      // already describe the old mode/deadline. Cancel the exact admission and
      // require a fresh bootstrap against current authority instead.
      this.pendingGuestBySocket.delete(socket);
      this.closePendingGuest(pending, 'authority_revoked');
      try { socket.close(1008, 'unavailable'); } catch { /* already closed/test double */ }
      return { status: 'applied' };
    }

    const route = this.routesBySession.get(routeId);
    if (!remoteDesktopOutboxAuthorityMatches(event, authority)
      || !route
      || route.registryIdentity.hostId !== event.hostId
      || !remoteDesktopRouteAuthorityTransitionMatches(route.registryIdentity, event)
      || route.registryIdentity.routeGeneration !== routeGeneration
      || route.daemonGeneration !== this.hooks.daemonGeneration()) {
      return { status: 'not_owner' };
    }

    if (event.effect === REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL) {
      this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED, true);
      return { status: 'applied' };
    }

    if (event.effect === REMOTE_DESKTOP_OUTBOX_EFFECT.DOWNGRADE) {
      if (route.mode === REMOTE_DESKTOP_ACCESS_MODE.VIEW) return { status: 'duplicate' };
      route.mode = REMOTE_DESKTOP_ACCESS_MODE.VIEW;
      route.inputEpoch += 1;
      const state = {
        ...this.modeState(route),
        reason: REMOTE_DESKTOP_MODE_REASON.AUTHORITY_LOST,
      };
      if (!this.hooks.sendDaemon(state, route.daemonGeneration)) {
        // Termination is stricter than a downgrade and prevents stale Control
        // from surviving a lost daemon generation.
        this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED, false);
      } else {
        this.publishCollaborationCounts();
      }
      return { status: 'applied' };
    }

    if (event.deadlineAt === undefined) return { status: 'not_owner' };
    const deadlineAt = Math.min(route.expiresAt, event.deadlineAt);
    if (deadlineAt === route.expiresAt) return { status: 'duplicate' };
    route.expiresAt = deadlineAt;
    clearTimeout(route.absoluteTimer);
    route.absoluteTimer = this.timer(() => {
      if (this.routesBySession.get(route.sessionId) === route) {
        this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_EXPIRED, true);
      }
    }, Math.max(0, deadlineAt - this.now()));

    if (deadlineAt <= this.now()) {
      this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_EXPIRED, true);
      return { status: 'applied' };
    }

    const nextLease = Math.min(route.leaseExpiresAt, deadlineAt);
    if (nextLease < route.leaseExpiresAt) {
      route.leaseExpiresAt = nextLease;
      clearTimeout(route.leaseTimer);
      route.leaseTimer = this.scheduleLeaseExpiry(route);
      if (!this.hooks.sendDaemon({
        type: REMOTE_DESKTOP_MSG.LEASE,
        requestId: route.requestId,
        sessionId: route.sessionId,
        capability: this.deriveCapability(route.requestId, route.sessionId),
        leaseExpiresAt: nextLease,
        daemonGeneration: route.daemonGeneration,
        routeGeneration: route.registryIdentity.routeGeneration,
        mode: route.mode,
        inputEpoch: route.inputEpoch,
      }, route.daemonGeneration)) {
        this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED, false);
      }
    }
    return { status: 'applied' };
  }

  private async authorize(socket: WebSocket, userId: string, start: RemoteDesktopStart): Promise<void> {
    if (!this.consumeStartBudget(socket, userId)) {
      this.reject(socket, start.requestId, REMOTE_DESKTOP_ERROR.SESSION_LIMIT, true);
      return;
    }
    this.auditRequest(userId);
    if (this.sessionByRequest.has(start.requestId)) {
      this.reject(socket, start.requestId, REMOTE_DESKTOP_ERROR.INVALID_REQUEST, false);
      return;
    }
    if (this.routesBySession.size >= REMOTE_DESKTOP_LIMITS.MAX_PER_MACHINE
      || this.routesBySession.size >= REMOTE_DESKTOP_LIMITS.MAX_PEER_CONNECTIONS_PER_WORKER
      || this.routesBySession.size >= REMOTE_DESKTOP_LIMITS.MAX_TURN_ALLOCATIONS_PER_MACHINE) {
      this.reject(socket, start.requestId, REMOTE_DESKTOP_ERROR.SESSION_LIMIT, true);
      return;
    }
    let socketCount = 0;
    let userCount = 0;
    for (const route of this.routesBySession.values()) {
      if (route.socket === socket) socketCount++;
      if (route.userId === userId) userCount++;
    }
    if (socketCount >= REMOTE_DESKTOP_LIMITS.MAX_PER_BROWSER
      || userCount >= REMOTE_DESKTOP_LIMITS.MAX_PER_USER) {
      this.reject(socket, start.requestId, REMOTE_DESKTOP_ERROR.SESSION_LIMIT, true);
      return;
    }
    if (this.hooks.featureEnabled?.() === false) {
      this.reject(socket, start.requestId, REMOTE_DESKTOP_ERROR.CAPABILITY_UNAVAILABLE, false);
      return;
    }
    if (!this.hooks.daemonAvailable()) {
      this.reject(socket, start.requestId, REMOTE_DESKTOP_ERROR.DAEMON_OFFLINE, true);
      return;
    }
    if (!this.hooks.daemonSupportsRemoteDesktop()) {
      this.reject(socket, start.requestId, REMOTE_DESKTOP_ERROR.CAPABILITY_UNAVAILABLE, true);
      return;
    }
    const db = this.hooks.database();
    if (!db) {
      this.reject(socket, start.requestId, REMOTE_DESKTOP_ERROR.INTERNAL_ERROR, true);
      return;
    }

    const generation = this.hooks.daemonGeneration();
    const queryStartedAt = this.now();
    let access: ControlledMachineAccessRow | null;
    try {
      access = await (this.hooks.resolveAccess ?? resolveRemoteDesktopHostAccess)(
        db,
        userId,
        this.hooks.serverId(),
        queryStartedAt,
      );
    } catch {
      this.reject(socket, start.requestId, REMOTE_DESKTOP_ERROR.INTERNAL_ERROR, true);
      return;
    }
    const authorizedAt = this.now();
    const accessError = this.admissionError(access, authorizedAt);
    if (accessError) {
      this.reject(socket, start.requestId, accessError.error, accessError.retryable);
      return;
    }
    if (generation !== this.hooks.daemonGeneration()
      || !this.hooks.daemonAvailable()
      || !this.hooks.daemonSupportsRemoteDesktop()) {
      this.reject(socket, start.requestId, REMOTE_DESKTOP_ERROR.DAEMON_OFFLINE, true);
      return;
    }
    // Serialize the DB await with the bounded machine registry so concurrent
    // starts cannot oversubscribe peer/encoder/TURN resources.
    if (this.routesBySession.size >= REMOTE_DESKTOP_LIMITS.MAX_PER_MACHINE
      || this.routesBySession.size >= REMOTE_DESKTOP_LIMITS.MAX_PEER_CONNECTIONS_PER_WORKER
      || this.routesBySession.size >= REMOTE_DESKTOP_LIMITS.MAX_TURN_ALLOCATIONS_PER_MACHINE) {
      this.reject(socket, start.requestId, REMOTE_DESKTOP_ERROR.SESSION_LIMIT, true);
      return;
    }

    let iceAuthority: TurnIceServerAuthority;
    try {
      iceAuthority = this.hooks.iceServers(userId);
    } catch {
      this.reject(socket, start.requestId, REMOTE_DESKTOP_ERROR.INTERNAL_ERROR, true);
      return;
    }
    const hardIceExpiry = iceAuthority.credentialExpiresAt === undefined
      ? Number.MAX_SAFE_INTEGER
      : iceAuthority.credentialExpiresAt - TURN_SERVICE_DEFAULTS.CREDENTIAL_EXPIRY_SAFETY_MS;
    const expiresAt = Math.min(
      authorizedAt + REMOTE_DESKTOP_LIMITS.ABSOLUTE_LIFETIME_MS,
      hardIceExpiry,
    );
    if (expiresAt <= authorizedAt) {
      this.reject(socket, start.requestId, REMOTE_DESKTOP_ERROR.AUTHORITY_EXPIRED, true);
      return;
    }

    const sessionId = mintOpaque();
    const capability = this.deriveCapability(start.requestId, sessionId);
    const routeGeneration = await this.allocateRouteGeneration(db).catch(() => null);
    if (routeGeneration === null) {
      this.reject(socket, start.requestId, REMOTE_DESKTOP_ERROR.INTERNAL_ERROR, true);
      return;
    }
    let registryIdentity: RemoteDesktopRouteRegistryIdentity;
    try {
      registryIdentity = await this.routeRegistry.reserve(db, {
        serverId: this.hooks.serverId(),
        routeId: sessionId,
        routeGeneration,
        now: authorizedAt,
      });
    } catch (error) {
      this.reject(
        socket,
        start.requestId,
        error instanceof PrivacyBarrierError && error.refusal === PRIVACY_REFUSAL.ROUTE_LIMIT
          ? REMOTE_DESKTOP_ERROR.SESSION_LIMIT
          : error instanceof PrivacyBarrierError
            ? REMOTE_DESKTOP_ERROR.CAPABILITY_UNAVAILABLE
            : REMOTE_DESKTOP_ERROR.INTERNAL_ERROR,
        true,
      );
      return;
    }
    const leaseExpiresAt = Math.min(
      authorizedAt + REMOTE_DESKTOP_LIMITS.LEASE_DURATION_MS,
      expiresAt,
    );
    const route = this.createRoute({
      requestId: start.requestId,
      sessionId,
      socket,
      userId,
      accessRole: access!.access_role,
      principalId: `account:${userId}`,
      actor: {
        source: REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT,
        auditId: userId,
        userId,
        hostId: registryIdentity.hostId,
        endpointGeneration: generation,
        modeCeiling: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        authorityGeneration: 0,
        expiryRevision: 0,
        expiresAt: 0,
      },
      daemonGeneration: generation,
      capability,
      createdAt: authorizedAt,
      expiresAt,
      leaseExpiresAt,
      // An admitted Owner/Participant session defaults to its own Control
      // authority. The worker still gates injection until all three WebRTC
      // DataChannels are open, and another peer's mode remains independent.
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      reconnectAttempt: start.reconnectAttempt ?? 0,
      registryIdentity,
    });
    this.routesBySession.set(sessionId, route);
    this.sessionByRequest.set(start.requestId, sessionId);

    // Promote the durable route before PREPARE. Marking it active slightly
    // early is conservative: a concurrent privacy epoch must shield or refuse
    // it. Sending PREPARE while it was still cancellable could start capture
    // after the shell had already concluded that no active route existed.
    try {
      await this.routeRegistry.activate(db, {
        ...registryIdentity,
        routeId: sessionId,
        now: this.now(),
      });
    } catch {
      this.deleteRoute(route);
      this.reject(socket, start.requestId, REMOTE_DESKTOP_ERROR.CAPABILITY_UNAVAILABLE, true);
      return;
    }

    const authority = {
      requestId: start.requestId,
      sessionId,
      capability,
      expiresAt,
      leaseExpiresAt,
      daemonGeneration: generation,
      mode: route.mode,
      inputEpoch: route.inputEpoch,
      iceServers: iceAuthority.iceServers,
    };
    if (!this.hooks.sendDaemon({
      type: REMOTE_DESKTOP_MSG.PREPARE,
      ...authority,
      routeGeneration: registryIdentity.routeGeneration,
      ...(route.reconnectAttempt > 0 ? { reconnectAttempt: route.reconnectAttempt } : {}),
    }, generation)) {
      this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED, false);
      return;
    }
    this.hooks.sendBrowser(socket, { type: REMOTE_DESKTOP_MSG.AUTHORIZED, ...authority });
    this.counters.admitted++;
    this.audit(REMOTE_DESKTOP_AUDIT_EVENT.ADMITTED, route, {
      reconnectAttempt: route.reconnectAttempt,
    });
    if (route.reconnectAttempt > 0) {
      this.audit(REMOTE_DESKTOP_AUDIT_EVENT.RECONNECTING, route, {
        reconnectAttempt: route.reconnectAttempt,
      });
    }
    this.publishCollaborationCounts();
  }

  private async authorizeGuest(
    socket: WebSocket,
    pending: PendingGuestAdmission,
    start: RemoteDesktopStart,
  ): Promise<void> {
    const principalId = `guest:${pending.actor.auditId}`;
    if (this.routesBySession.has(pending.sessionId)) {
      this.pendingGuestBySocket.delete(socket);
      this.reject(socket, start.requestId, REMOTE_DESKTOP_ERROR.SESSION_LIMIT, false);
      return;
    }
    if (this.pendingGuestBySocket.get(socket) !== pending
      || !this.consumeStartBudget(socket, principalId)
      || this.sessionByRequest.has(start.requestId)
      || this.routesBySession.size >= REMOTE_DESKTOP_LIMITS.MAX_PER_MACHINE
      || this.hooks.featureEnabled?.() === false
      || !this.hooks.daemonAvailable()
      || !this.hooks.daemonSupportsRemoteDesktop()) {
      this.rejectPendingGuest(socket, pending, start.requestId);
      return;
    }
    const db = this.hooks.database();
    const generation = this.hooks.daemonGeneration();
    if (!db || pending.actor.endpointGeneration !== generation) {
      this.rejectPendingGuest(socket, pending, start.requestId);
      return;
    }

    if (pending.actor.source === REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK) {
      const consentOutcome = await this.hooks.requestAttendedConsent?.({
        actor: pending.actor,
        sessionId: pending.sessionId,
        routeGeneration: pending.registryIdentity.routeGeneration,
        daemonGeneration: generation,
        mode: pending.actor.modeCeiling,
      }).catch(() => 'unavailable' as const) ?? 'unavailable';
      const approved = consentOutcome === true || consentOutcome === 'approved';
      if (!approved || this.pendingGuestBySocket.get(socket) !== pending
        || generation !== this.hooks.daemonGeneration()) {
        this.rejectPendingGuest(
          socket,
          pending,
          start.requestId,
          consentOutcome === 'timeout'
            ? REMOTE_DESKTOP_ERROR.NEGOTIATION_TIMEOUT
            : consentOutcome === 'cancelled'
              ? REMOTE_DESKTOP_ERROR.CONSENT_CANCELLED
            : consentOutcome === 'unavailable'
              ? REMOTE_DESKTOP_ERROR.CAPABILITY_UNAVAILABLE
              : REMOTE_DESKTOP_ERROR.ACCESS_DENIED,
        );
        return;
      }
    }

    let iceAuthority: TurnIceServerAuthority;
    try {
      iceAuthority = this.hooks.iceServers(pending.actor.auditId);
    } catch {
      this.rejectPendingGuest(socket, pending, start.requestId);
      return;
    }
    const now = this.now();
    const hardIceExpiry = iceAuthority.credentialExpiresAt === undefined
      ? Number.MAX_SAFE_INTEGER
      : iceAuthority.credentialExpiresAt - TURN_SERVICE_DEFAULTS.CREDENTIAL_EXPIRY_SAFETY_MS;
    const actorExpiry = pending.actor.expiresAt === 0 ? Number.MAX_SAFE_INTEGER : pending.actor.expiresAt;
    const expiresAt = Math.min(now + REMOTE_DESKTOP_LIMITS.ABSOLUTE_LIFETIME_MS, hardIceExpiry, actorExpiry);
    if (expiresAt <= now) {
      this.rejectPendingGuest(socket, pending, start.requestId);
      return;
    }
    const capability = this.deriveCapability(start.requestId, pending.sessionId);
    const route = this.createRoute({
      requestId: start.requestId,
      sessionId: pending.sessionId,
      socket,
      principalId,
      actor: pending.actor,
      daemonGeneration: generation,
      capability,
      createdAt: now,
      expiresAt,
      leaseExpiresAt: Math.min(now + REMOTE_DESKTOP_LIMITS.LEASE_DURATION_MS, expiresAt),
      mode: pending.actor.modeCeiling,
      inputEpoch: 1,
      reconnectAttempt: start.reconnectAttempt ?? 0,
      registryIdentity: pending.registryIdentity,
    });
    this.pendingGuestBySocket.delete(socket);
    this.guestPrincipalBySocket.set(socket, principalId);
    this.routesBySession.set(route.sessionId, route);
    this.sessionByRequest.set(route.requestId, route.sessionId);
    try {
      await this.routeRegistry.activate(db, {
        ...pending.registryIdentity,
        routeId: route.sessionId,
        now: this.now(),
      });
    } catch {
      this.deleteRoute(route);
      this.reject(socket, start.requestId, REMOTE_DESKTOP_ERROR.CAPABILITY_UNAVAILABLE, true);
      return;
    }
    const authority = {
      requestId: route.requestId,
      sessionId: route.sessionId,
      capability,
      expiresAt,
      leaseExpiresAt: route.leaseExpiresAt,
      daemonGeneration: generation,
      mode: route.mode,
      inputEpoch: route.inputEpoch,
      iceServers: iceAuthority.iceServers,
    };
    // For attended links this is intentionally after the one-use positive
    // consent hook and durable activation. No pre-consent path dispatches.
    if (!this.hooks.sendDaemon({
      type: REMOTE_DESKTOP_MSG.PREPARE,
      ...authority,
      routeGeneration: pending.registryIdentity.routeGeneration,
      ...(route.reconnectAttempt > 0 ? { reconnectAttempt: route.reconnectAttempt } : {}),
    }, generation)) {
      this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED, false);
      return;
    }
    this.hooks.sendBrowser(socket, { type: REMOTE_DESKTOP_MSG.AUTHORIZED, ...authority });
    this.counters.admitted++;
    this.audit(REMOTE_DESKTOP_AUDIT_EVENT.ADMITTED, route);
    this.publishCollaborationCounts();
  }

  /**
   * Why a resolved access row does not permit remote desktop, if it does not.
   *
   * Admission and continuous revalidation ask the same question and only differ
   * in how they report the answer, so they share this one classifier. They used
   * to carry a copy each, and the copies drifted the moment either learned
   * something new — a daemon host was admitted and then terminated seconds later
   * by the revalidation copy, which still applied the controlled-node checks.
   */
  private accessFault(
    access: ControlledMachineAccessRow | null,
    now: number,
  ): RemoteDesktopAccessFault | null {
    if (!access || !canOperateControlledMachine(access.access_role)) return 'denied';
    // A normal (FULL) daemon serves remote control from the same native worker,
    // but the controlled-node columns do not describe it: `exec_enabled` is the
    // controlled-node exec switch (and is false on daemon rows predating its
    // default flip), `os` is only recorded at controlled-node enrolment, and
    // `controlled_capabilities` is stored for controlled nodes alone. For a
    // daemon those three facts are instead proven live — it advertises the
    // remote-desktop capability only on win32 with the worker installed, which
    // `daemonSupportsRemoteDesktop()` checks before and after this admission.
    const controlledNode = access.node_role === NODE_ROLE.CONTROLLED;
    if (access.access_role !== 'owner'
      && access.access_expires_at !== null
      && (typeof access.access_expires_at !== 'number'
        || !Number.isSafeInteger(access.access_expires_at)
        || access.access_expires_at <= now)) {
      return 'denied';
    }
    if (controlledNode && !access.exec_enabled) return 'exec_disabled';
    if (controlledNode && access.os !== 'win') return 'unsupported_platform';
    if (access.status !== 'online'
      || typeof access.last_heartbeat_at !== 'number'
      || now - access.last_heartbeat_at >= MACHINE_PRESENCE_STALENESS_MS) {
      return 'offline';
    }
    if (controlledNode) {
      const capabilities = validateControlledNodeCapabilities(access.controlled_capabilities);
      if (!capabilities.ok || !capabilities.value.includes(REMOTE_DESKTOP_CAPABILITY)) {
        return 'capability';
      }
    }
    return null;
  }

  private admissionError(
    access: ControlledMachineAccessRow | null,
    now: number,
  ): { error: string; retryable: boolean } | null {
    switch (this.accessFault(access, now)) {
      case 'denied': return { error: REMOTE_DESKTOP_ERROR.ACCESS_DENIED, retryable: false };
      case 'exec_disabled': return { error: REMOTE_DESKTOP_ERROR.EXECUTION_DISABLED, retryable: false };
      case 'unsupported_platform': return { error: REMOTE_DESKTOP_ERROR.UNSUPPORTED_PLATFORM, retryable: false };
      case 'offline': return { error: REMOTE_DESKTOP_ERROR.DAEMON_OFFLINE, retryable: true };
      case 'capability': return { error: REMOTE_DESKTOP_ERROR.CAPABILITY_UNAVAILABLE, retryable: true };
      default: return null;
    }
  }

  private async forwardBrowserSignal(
    socket: WebSocket,
    principalId: string,
    message: Exclude<RemoteDesktopBrowserMessage, RemoteDesktopStart>,
  ): Promise<void> {
    const route = this.routesBySession.get(message.sessionId);
    if (!route
      || route.requestId !== message.requestId
      || route.socket !== socket
      || route.principalId !== principalId
      || route.daemonSuspended
      || route.daemonGeneration !== this.hooks.daemonGeneration()
      || route.expiresAt <= this.now()
      || !capabilityMatches(route, message.capability)) {
      this.counters.dropped++;
      this.sendError(socket, message.requestId, REMOTE_DESKTOP_ERROR.INVALID_AUTHORITY, false);
      return;
    }

    if (message.type === REMOTE_DESKTOP_MSG.CANCEL || message.type === REMOTE_DESKTOP_MSG.STOP) {
      // Aggregate byte counts are browser diagnostics metadata only. Never
      // forward them into the worker command surface, whose STOP envelope stays
      // exact and content-independent.
      this.hooks.sendDaemon({
        type: message.type,
        requestId: message.requestId,
        sessionId: message.sessionId,
        capability: message.capability,
      }, route.daemonGeneration);
      this.hooks.sendBrowser(socket, {
        type: REMOTE_DESKTOP_MSG.TERMINAL,
        requestId: route.requestId,
        sessionId: route.sessionId,
        capability: message.capability,
        reason: REMOTE_DESKTOP_TERMINAL_REASON.STOPPED_BY_CONTROLLER,
      });
      this.audit(REMOTE_DESKTOP_AUDIT_EVENT.STOPPED, route, {
        controllerRequested: true,
        ...(message.type === REMOTE_DESKTOP_MSG.STOP
          && message.aggregateBytesReceived !== undefined
          ? { aggregateBytesReceived: message.aggregateBytesReceived }
          : {}),
      });
      this.deleteRoute(route);
      return;
    }
    if (message.type === REMOTE_DESKTOP_MSG.MODE_SET) {
      if (route.actor.modeCeiling === REMOTE_DESKTOP_ACCESS_MODE.VIEW
        && message.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL) {
        this.counters.dropped++;
        this.sendError(socket, message.requestId, REMOTE_DESKTOP_ERROR.ACCESS_DENIED, false);
        return;
      }
      if (!this.consumeModeBudget(route)) {
        this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.PROTOCOL_ERROR, true);
        return;
      }
      const changed = message.mode !== route.mode;
      if (changed) {
        route.inputEpoch++;
        route.mode = message.mode;
      }
      const state = this.modeState(route);
      if (!this.hooks.sendDaemon(state, route.daemonGeneration)) {
        this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED, false);
        return;
      }
      if (changed) {
        this.publishCollaborationCounts();
      }
      // Worker echoes the applied MODE_STATE before the Web captures input.
      return;
    }
    if (!this.consumeSignalBudget(route)) {
      this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.PROTOCOL_ERROR, true);
      return;
    }
    if (message.type === REMOTE_DESKTOP_MSG.OFFER) {
      if (route.offerCount > REMOTE_DESKTOP_LIMITS.MAX_ICE_RESTARTS) {
        this.counters.dropped++;
        this.sendError(socket, message.requestId, REMOTE_DESKTOP_ERROR.INVALID_REQUEST, false);
        return;
      }
      const iceRestartAttempt = route.offerCount;
      route.offerCount++;
      if (iceRestartAttempt > 0) {
        await this.renewLease(route);
        if (this.routesBySession.get(route.sessionId) !== route
          || route.leaseExpiresAt <= this.now()
          || route.daemonGeneration !== this.hooks.daemonGeneration()) {
          return;
        }
        this.audit(REMOTE_DESKTOP_AUDIT_EVENT.RECONNECTING, route, {
          iceRestartAttempt,
        });
      }
      route.state = REMOTE_DESKTOP_STATE.CONNECTING;
    } else {
      route.browserIceCandidates++;
      if (route.browserIceCandidates > REMOTE_DESKTOP_LIMITS.MAX_ICE_CANDIDATES) {
        this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.PROTOCOL_ERROR, true);
        return;
      }
    }
    if (!this.hooks.sendDaemon(message as unknown as Record<string, unknown>, route.daemonGeneration)) {
      this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED, false);
    }
  }

  private createRoute(input: {
    requestId: string;
    sessionId: string;
    socket: WebSocket;
    actor: RemoteDesktopActor;
    principalId: string;
    userId?: string;
    accessRole?: MachineAccessRole;
    daemonGeneration: number;
    capability: string;
    createdAt: number;
    expiresAt: number;
    leaseExpiresAt: number;
    mode: RemoteDesktopAccessMode;
    inputEpoch: number;
    reconnectAttempt: number;
    registryIdentity: RemoteDesktopRouteRegistryIdentity;
  }): RemoteDesktopRoute {
    const route = {} as RemoteDesktopRoute;
    Object.assign(route, {
      ...input,
      capabilityHash: hashCapability(input.capability),
      daemonSuspended: false,
      state: REMOTE_DESKTOP_STATE.PREPARING,
      browserIceCandidates: 0,
      daemonIceCandidates: 0,
      signalWindowStartedAt: input.createdAt,
      signalWindowCount: 0,
      modeWindowStartedAt: input.createdAt,
      modeWindowCount: 0,
      offerCount: 0,
      answerCount: 0,
      revalidationInFlight: false,
      statusReceived: false,
      workerInputEnabled: false,
      auditedInputEnabled: false,
      connectionRoute: undefined,
      registryCloseStarted: false,
    });
    route.negotiationTimer = this.timer(() => {
      if (this.routesBySession.get(route.sessionId) === route) {
        this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.NEGOTIATION_TIMEOUT, true);
      }
    }, REMOTE_DESKTOP_LIMITS.NEGOTIATION_TIMEOUT_MS);
    route.absoluteTimer = this.timer(() => {
      if (this.routesBySession.get(route.sessionId) === route) {
        this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_EXPIRED, true);
      }
    }, Math.max(0, input.expiresAt - this.now()));
    route.leaseTimer = this.scheduleLeaseExpiry(route);
    route.renewalTimer = setInterval(() => { void this.renewLease(route); }, REMOTE_DESKTOP_LIMITS.LEASE_RENEW_INTERVAL_MS);
    route.renewalTimer.unref?.();
    return route;
  }

  private async renewLease(route: RemoteDesktopRoute): Promise<void> {
    if (this.routesBySession.get(route.sessionId) !== route || route.revalidationInFlight) return;
    if (route.daemonSuspended) return;
    if (this.hooks.featureEnabled?.() === false) {
      this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.CAPABILITY_UNAVAILABLE, true);
      return;
    }
    if (route.daemonGeneration !== this.hooks.daemonGeneration()
      || !this.hooks.daemonAvailable()
      || !this.hooks.daemonSupportsRemoteDesktop()) {
      this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED, false);
      return;
    }
    const db = this.hooks.database();
    if (!db) {
      this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED, true);
      return;
    }
    route.revalidationInFlight = true;
    if (route.actor.source === REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT) {
      let access: ControlledMachineAccessRow | null = null;
      try {
        access = await (this.hooks.resolveAccess ?? resolveRemoteDesktopHostAccess)(
          db,
          route.actor.userId,
          this.hooks.serverId(),
          this.now(),
        );
      } catch {
        // Fail closed below.
      } finally {
        route.revalidationInFlight = false;
      }
      if (this.routesBySession.get(route.sessionId) !== route) return;
      const terminalReason = this.revalidationFailure(access);
      if (terminalReason) {
        this.failRoute(route, terminalReason, true);
        return;
      }
    } else {
      let current: RemoteDesktopActor | null = null;
      try {
        current = await this.hooks.resolveGuestActor?.(route.actor, this.now()) ?? null;
      } catch {
        current = null;
      } finally {
        route.revalidationInFlight = false;
      }
      if (this.routesBySession.get(route.sessionId) !== route) return;
      if (!current || current.endpointGeneration !== route.daemonGeneration
        || !isRemoteDesktopActorRenewable(route.actor, current, this.now())) {
        this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED, true);
        return;
      }
      route.actor = current;
      if (current.modeCeiling === REMOTE_DESKTOP_ACCESS_MODE.VIEW
        && route.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL) {
        route.mode = REMOTE_DESKTOP_ACCESS_MODE.VIEW;
        route.inputEpoch += 1;
        if (!this.hooks.sendDaemon(this.modeState(route), route.daemonGeneration)) {
          this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED, false);
          return;
        }
      }
      if (current.expiresAt !== 0 && current.expiresAt < route.expiresAt) {
        route.expiresAt = current.expiresAt;
        clearTimeout(route.absoluteTimer);
        route.absoluteTimer = this.timer(() => {
          if (this.routesBySession.get(route.sessionId) === route) {
            this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_EXPIRED, true);
          }
        }, Math.max(0, route.expiresAt - this.now()));
      }
    }
    const now = this.now();
    const nextLease = Math.min(now + REMOTE_DESKTOP_LIMITS.LEASE_DURATION_MS, route.expiresAt);
    if (nextLease <= now) {
      this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_EXPIRED, true);
      return;
    }
    const capability = this.deriveCapability(route.requestId, route.sessionId);
    if (!this.hooks.sendDaemon({
      type: REMOTE_DESKTOP_MSG.LEASE,
      requestId: route.requestId,
      sessionId: route.sessionId,
      capability,
      leaseExpiresAt: nextLease,
      daemonGeneration: route.daemonGeneration,
      routeGeneration: route.registryIdentity.routeGeneration,
      mode: route.mode,
      inputEpoch: route.inputEpoch,
    }, route.daemonGeneration)) {
      this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED, false);
      return;
    }
    route.leaseExpiresAt = nextLease;
    clearTimeout(route.leaseTimer);
    route.leaseTimer = this.scheduleLeaseExpiry(route);
  }

  private revalidationFailure(access: ControlledMachineAccessRow | null): RemoteDesktopTerminalReason | null {
    switch (this.accessFault(access, this.now())) {
      case 'denied': return REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED;
      case 'exec_disabled': return REMOTE_DESKTOP_TERMINAL_REASON.EXECUTION_DISABLED;
      case 'unsupported_platform': return REMOTE_DESKTOP_TERMINAL_REASON.UNSUPPORTED_PLATFORM;
      case 'offline':
      case 'capability': return REMOTE_DESKTOP_TERMINAL_REASON.CAPABILITY_UNAVAILABLE;
      default: return null;
    }
  }

  private consumeStartBudget(socket: WebSocket, userId: string): boolean {
    const now = this.now();
    const cutoff = now - 60_000;
    const socketRecent = (this.startsBySocket.get(socket) ?? [])
      .filter((value) => value > cutoff);
    const userRecent = (this.startsByUser.get(userId) ?? [])
      .filter((value) => value > cutoff);
    const machineRecent = this.machineStarts.filter((value) => value > cutoff);
    this.startsBySocket.set(socket, socketRecent);
    this.startsByUser.set(userId, userRecent);
    this.machineStarts = machineRecent;
    if (socketRecent.length >= REMOTE_DESKTOP_LIMITS.MAX_STARTS_PER_MINUTE
      || userRecent.length >= REMOTE_DESKTOP_LIMITS.MAX_STARTS_PER_USER_PER_MINUTE
      || machineRecent.length >= REMOTE_DESKTOP_LIMITS.MAX_STARTS_PER_MACHINE_PER_MINUTE) {
      return false;
    }
    socketRecent.push(now);
    userRecent.push(now);
    machineRecent.push(now);
    return true;
  }

  private consumeSignalBudget(route: RemoteDesktopRoute): boolean {
    const now = this.now();
    if (now - route.signalWindowStartedAt >= 60_000) {
      route.signalWindowStartedAt = now;
      route.signalWindowCount = 0;
    }
    if (now - this.machineSignalWindowStartedAt >= 60_000) {
      this.machineSignalWindowStartedAt = now;
      this.machineSignalWindowCount = 0;
    }
    route.signalWindowCount++;
    this.machineSignalWindowCount++;
    return route.signalWindowCount <= REMOTE_DESKTOP_LIMITS.MAX_SIGNALING_PER_MINUTE
      && this.machineSignalWindowCount
        <= REMOTE_DESKTOP_LIMITS.MAX_SIGNALING_PER_MACHINE_PER_MINUTE;
  }

  private consumeModeBudget(route: RemoteDesktopRoute): boolean {
    const now = this.now();
    if (now - route.modeWindowStartedAt >= 60_000) {
      route.modeWindowStartedAt = now;
      route.modeWindowCount = 0;
    }
    route.modeWindowCount++;
    return route.modeWindowCount <= REMOTE_DESKTOP_LIMITS.MAX_MODE_CHANGES_PER_MINUTE;
  }

  private scheduleLeaseExpiry(route: RemoteDesktopRoute): ReturnType<typeof setTimeout> {
    return this.timer(() => {
      if (this.routesBySession.get(route.sessionId) === route
        && route.leaseExpiresAt <= this.now()) {
        this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.LEASE_EXPIRED, true);
      }
    }, Math.max(0, route.leaseExpiresAt - this.now()));
  }

  private timer(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(callback, delay);
    timer.unref?.();
    return timer;
  }

  private findRoute(requestId: unknown, sessionId: unknown): RemoteDesktopRoute | undefined {
    if (typeof sessionId === 'string') return this.routesBySession.get(sessionId);
    if (typeof requestId !== 'string') return undefined;
    const resolvedSession = this.sessionByRequest.get(requestId);
    return resolvedSession ? this.routesBySession.get(resolvedSession) : undefined;
  }

  private deriveCapability(requestId: string, sessionId: string): string {
    return createHmac('sha256', this.capabilityKey)
      .update(`${requestId}\0${sessionId}`, 'utf8')
      .digest('base64url');
  }

  private allocateRouteGeneration(db: Database): Promise<number> {
    return this.hooks.allocateRouteGeneration?.(db)
      ?? allocateRemoteDesktopRouteGeneration(db);
  }

  private modeState(route: RemoteDesktopRoute): Record<string, unknown> {
    return {
      type: REMOTE_DESKTOP_MSG.MODE_STATE,
      requestId: route.requestId,
      sessionId: route.sessionId,
      capability: this.deriveCapability(route.requestId, route.sessionId),
      mode: route.mode,
      inputEpoch: route.inputEpoch,
      reason: route.inputEpoch === 0
        ? REMOTE_DESKTOP_MODE_REASON.INITIAL
        : REMOTE_DESKTOP_MODE_REASON.USER_SELECTED,
    };
  }

  private stopDaemon(route: RemoteDesktopRoute): void {
    this.hooks.sendDaemon({
      type: REMOTE_DESKTOP_MSG.STOP,
      requestId: route.requestId,
      sessionId: route.sessionId,
      capability: this.deriveCapability(route.requestId, route.sessionId),
    }, route.daemonGeneration);
  }

  private failRoute(route: RemoteDesktopRoute, reason: RemoteDesktopTerminalReason, stopDaemon: boolean): void {
    if (this.routesBySession.get(route.sessionId) !== route) return;
    if (stopDaemon) this.stopDaemon(route);
    this.hooks.sendBrowser(route.socket, {
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      requestId: route.requestId,
      sessionId: route.sessionId,
      capability: this.deriveCapability(route.requestId, route.sessionId),
      reason,
    });
    this.audit(
      reason === REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED
        ? REMOTE_DESKTOP_AUDIT_EVENT.REVOKED
        : REMOTE_DESKTOP_AUDIT_EVENT.FAILED,
      route,
      {
        reason,
        state: route.state,
        offerCount: route.offerCount,
        answerCount: route.answerCount,
        browserIceCandidates: route.browserIceCandidates,
        daemonIceCandidates: route.daemonIceCandidates,
      },
    );
    this.deleteRoute(route);
  }

  private deleteRoute(route: RemoteDesktopRoute): void {
    this.closeRegisteredRoute(route);
    clearTimeout(route.negotiationTimer);
    clearTimeout(route.absoluteTimer);
    clearTimeout(route.leaseTimer);
    clearInterval(route.renewalTimer);
    this.routesBySession.delete(route.sessionId);
    if (this.sessionByRequest.get(route.requestId) === route.sessionId) {
      this.sessionByRequest.delete(route.requestId);
    }
    route.capabilityHash.fill(0);
    this.counters.terminated++;
    this.publishCollaborationCounts();
  }

  private closeRegisteredRoute(route: RemoteDesktopRoute): void {
    if (route.registryCloseStarted) return;
    route.registryCloseStarted = true;
    const db = this.hooks.database();
    if (!db) return;
    void this.routeRegistry.close(db, {
      ...route.registryIdentity,
      routeId: route.sessionId,
      now: this.now(),
    }).catch(() => {
      // A missed close stays fail-closed in durable state. Record only bounded
      // identifiers; recovery/reconciliation must never reopen admission based
      // on process-local belief.
      this.hooks.audit?.(REMOTE_DESKTOP_AUDIT_EVENT.FAILED, {
        serverId: this.hooks.serverId(),
        sessionId: route.sessionId,
        reason: 'route_registry_close_failed',
      });
    });
  }

  private publishCollaborationCounts(excludeSessionId?: string): void {
    const stats = this.stats();
    for (const route of this.routesBySession.values()) {
      if (!route.statusReceived || route.sessionId === excludeSessionId) continue;
      this.hooks.sendBrowser(route.socket, {
        type: REMOTE_DESKTOP_MSG.STATUS,
        requestId: route.requestId,
        sessionId: route.sessionId,
        capability: this.deriveCapability(route.requestId, route.sessionId),
        mode: route.mode,
        inputEpoch: route.inputEpoch,
        state: route.state,
        ...(route.connectionRoute === undefined ? {} : { route: route.connectionRoute }),
        ...(route.selectedDisplayId === undefined
          ? {}
          : { selectedDisplayId: route.selectedDisplayId }),
        ...(route.layoutRevision === undefined
          ? {}
          : { layoutRevision: route.layoutRevision }),
        inputEnabled: route.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL
          && route.workerInputEnabled,
        viewerCount: stats.active,
        controllerCount: stats.controlling,
      });
    }
  }

  private reject(socket: WebSocket, requestId: string, error: string, retryable: boolean): void {
    this.counters.rejected++;
    this.sendError(socket, requestId, error, retryable);
  }

  private rejectPendingGuest(
    socket: WebSocket,
    pending: PendingGuestAdmission,
    requestId: string,
    error: string = REMOTE_DESKTOP_ERROR.ACCESS_DENIED,
  ): void {
    if (this.pendingGuestBySocket.get(socket) === pending) {
      this.pendingGuestBySocket.delete(socket);
    }
    this.closePendingGuest(pending);
    this.reject(socket, requestId, error, false);
  }

  private closePendingGuest(
    pending: PendingGuestAdmission,
    cancellationCause?: 'browser_disconnect' | 'authority_revoked' | 'privacy_epoch',
  ): void {
    if (cancellationCause) {
      void this.hooks.cancelPendingGuestConsent?.(
        pending.actor,
        cancellationCause,
      ).catch(() => {});
    }
    const db = this.hooks.database();
    if (!db) return;
    void this.routeRegistry.close(db, {
      ...pending.registryIdentity,
      routeId: pending.sessionId,
      now: this.now(),
    }).catch(() => {});
  }

  private sendError(socket: WebSocket, requestId: string, error: string, retryable: boolean): void {
    this.hooks.sendBrowser(socket, {
      type: REMOTE_DESKTOP_MSG.ERROR,
      requestId,
      error,
      retryable,
    });
  }

  private auditRequest(userId: string): void {
    if (!this.consumeAuditBudget()) return;
    this.hooks.audit?.(REMOTE_DESKTOP_AUDIT_EVENT.REQUESTED, {
      serverId: this.hooks.serverId(),
      userId,
    });
  }

  private audit(
    event: string,
    route: RemoteDesktopRoute,
    extra: Readonly<Record<string, string | number | boolean>> = {},
  ): void {
    if (!this.consumeAuditBudget()) return;
    this.hooks.audit?.(event, {
      serverId: this.hooks.serverId(),
      actorSource: route.actor.source,
      actorAuditId: route.actor.auditId,
      ...(route.userId === undefined ? {} : { userId: route.userId }),
      ...(route.accessRole === undefined ? {} : { role: route.accessRole }),
      daemonGeneration: route.daemonGeneration,
      durationMs: Math.max(0, this.now() - route.createdAt),
      ...extra,
    });
  }

  private consumeAuditBudget(): boolean {
    const now = this.now();
    if (now - this.auditWindowStartedAt >= 60_000) {
      this.auditWindowStartedAt = now;
      this.auditWindowCount = 0;
    }
    this.auditWindowCount++;
    return this.auditWindowCount
      <= REMOTE_DESKTOP_LIMITS.MAX_AUDITS_PER_MACHINE_PER_MINUTE;
  }

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }
}

function remoteDesktopRouteAuthorityTransitionMatches(
  identity: RemoteDesktopRouteRegistryIdentity,
  event: RemoteDesktopOutboxEvent,
): boolean {
  const authority = identity.authority;
  if (event.authorityKind === REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.PASSWORD) {
    return authority.actorSource === REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD
      && authority.actorAuditId === event.actorAuditId
      && authority.sessionAuditId === event.sessionAuditId
      && authority.passwordGeneration < event.passwordGeneration;
  }
  if (authority.actorSource !== REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK
    && authority.actorSource !== REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK) return false;
  if (authority.actorAuditId !== event.actorAuditId
    || authority.commitRevision > event.commitRevision) return false;
  if (event.effect === REMOTE_DESKTOP_OUTBOX_EFFECT.DOWNGRADE) {
    return authority.authorityGeneration < event.authorityGeneration
      && authority.expiryRevision <= event.expiryRevision;
  }
  if (event.effect === REMOTE_DESKTOP_OUTBOX_EFFECT.DEADLINE_UPDATE) {
    return authority.authorityGeneration === event.authorityGeneration
      && authority.expiryRevision < event.expiryRevision;
  }
  return authority.authorityGeneration <= event.authorityGeneration
    && authority.expiryRevision <= event.expiryRevision;
}

function remoteDesktopOutboxAuthorityMatches(
  event: RemoteDesktopOutboxEvent,
  authority: RemoteDesktopGuestOutboxAuthorityMatch,
): boolean {
  if (!authority
    || event.authorityKind !== authority.authorityKind
    || event.actorAuditId !== authority.actorAuditId) return false;
  if (event.authorityKind === REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.PASSWORD) {
    return authority.authorityKind === REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.PASSWORD
      && event.sessionAuditId === authority.sessionAuditId
      && event.passwordGeneration === authority.passwordGeneration;
  }
  return authority.authorityKind === REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.LINK
    && event.authorityGeneration === authority.authorityGeneration
    && event.expiryRevision === authority.expiryRevision
    && event.commitRevision === authority.commitRevision;
}
