/**
 * Peer-audit response unicast router — server/src/ws/bridge.ts helper.
 *
 * Bound the daemon → browser response surface for the three peer-audit RPCs
 * (list_candidates, quick_start, cancel). Default behaviour today is
 * `broadcastToBrowsers`, which violates minimum disclosure and lets other
 * tabs receive peer-audit metadata that does not belong to them.
 *
 * Contract (see openspec/changes/lightweight-peer-supervision-audit):
 *   - Keyed routes: `<responseType>:<commandId>` → originating socket.
 *   - Capacity bounded per socket and globally; LRU/age eviction.
 *   - TTL on every route; expiry drops silently.
 *   - Daemon generation: routes bound to a stale generation are dropped.
 *   - On originating socket close / error: routes cleared (see
 *   `cleanupBrowserSocket`).
 *   - Late or mismatched responses are dropped, NOT broadcast.
 *   - Cross-checked against `PEER_AUDIT_MESSAGES` so unknown response types
 *   fall through (we never claim a route for a non-peer-audit type).
 */

import { randomUUID } from 'node:crypto';
import { PEER_AUDIT_MESSAGES } from '../../../shared/peer-audit.js';

export const PEER_AUDIT_ROUTE_RESPONSE_TYPES = new Set<string>([
  PEER_AUDIT_MESSAGES.CANDIDATES,
  PEER_AUDIT_MESSAGES.QUICK_RESULT,
  PEER_AUDIT_MESSAGES.CANCEL_RESULT,
]);

/**
 * Routing key for the pending-routes map. Always `<type>\u0000<commandId>`.
 * The NUL byte is illegal in canonical peer-audit type names and command
 * ids (which are UUID-derived), so collision-free.
 */
export function peerAuditRouteKey(responseType: string, commandId: string): string {
  return `${responseType}\u0000${commandId}`;
}

export interface PeerAuditRouteEntry {
  socket: import('ws').WebSocket;
  commandId: string;
  requestType: string;
  responseType: string;
  daemonGeneration: number;
  createdAt: number;
  timer: NodeJS.Timeout;
}

export interface PeerAuditRouteInsertLimits {
  perSocket: number;
  global: number;
  ttlMs: number;
}

export const DEFAULT_PEER_AUDIT_ROUTE_LIMITS: PeerAuditRouteInsertLimits = {
  perSocket: 32,
  global: 1024,
  ttlMs: 30_000,
};

/** Counter label prefix for the route drop reasons. */
export const PEER_AUDIT_ROUTE_DROP_REASONS = {
  UNKNOWN_RESPONSE_TYPE: 'unknown_response_type',
  MISSING_COMMAND_ID: 'missing_command_id',
  NO_ROUTE: 'no_route',
  TYPE_MISMATCH: 'type_mismatch',
  COMMAND_ID_MISMATCH: 'command_id_mismatch',
  GENERATION_MISMATCH: 'generation_mismatch',
  EXPIRED: 'expired',
  PER_SOCKET_CAP: 'per_socket_cap',
  GLOBAL_CAP: 'global_cap',
  SOCKET_CLOSED: 'socket_closed',
  DUPLICATE_ROUTE: 'duplicate_route',
} as const;

export type PeerAuditRouteDropReason =
  (typeof PEER_AUDIT_ROUTE_DROP_REASONS)[keyof typeof PEER_AUDIT_ROUTE_DROP_REASONS];

export interface PeerAuditRouteSink {
  /** Send a serialised response to a single socket. */
  send(socket: import('ws').WebSocket, json: string): void;
  /** Increment a low-cardinality metric. */
  increment(metric: string, tags?: Record<string, string>): void;
  /** Structured log line. */
  logWarn(scope: string, fields: Record<string, unknown>, message: string): void;
}

export interface PeerAuditRouteInsertResult {
  ok: boolean;
  reason?: PeerAuditRouteDropReason;
}

export class PeerAuditUnicastRouter {
  private readonly routes = new Map<string, PeerAuditRouteEntry>();
  private readonly perSocketCount = new Map<import('ws').WebSocket, number>();
  /** Generation observed at insertion time; bumped by the host on reconnect. */
  private currentDaemonGeneration: number;

  constructor(
    private readonly limits: PeerAuditRouteInsertLimits = DEFAULT_PEER_AUDIT_ROUTE_LIMITS,
    initialDaemonGeneration = 0,
    private readonly sink: PeerAuditRouteSink,
  ) {
    this.currentDaemonGeneration = initialDaemonGeneration;
  }

  setDaemonGeneration(generation: number): void {
    this.currentDaemonGeneration = generation;
    // All routes bound to a stale generation must be dropped; their answers
    // will reference a daemon instance the browser no longer trusts.
    for (const [key, entry] of this.routes) {
      if (entry.daemonGeneration !== generation) {
        this.#clearTimer(entry);
        this.routes.delete(key);
        this.#decrementSocketCount(entry.socket);
        this.sink.increment('peer_audit.bridge.route_dropped', { reason: PEER_AUDIT_ROUTE_DROP_REASONS.GENERATION_MISMATCH });
      }
    }
  }

  /**
   * Reserve a route. Returns ok=false when limits are reached or the
   * response type is not a peer-audit RPC.
   */
  insert(input: {
    socket: import('ws').WebSocket;
    commandId: string;
    requestType: string;
    responseType: string;
  }): PeerAuditRouteInsertResult {
    if (!PEER_AUDIT_ROUTE_RESPONSE_TYPES.has(input.responseType)) {
      this.sink.increment('peer_audit.bridge.route_dropped', { reason: PEER_AUDIT_ROUTE_DROP_REASONS.UNKNOWN_RESPONSE_TYPE });
      return { ok: false, reason: PEER_AUDIT_ROUTE_DROP_REASONS.UNKNOWN_RESPONSE_TYPE };
    }
    if (!input.commandId || input.commandId.length > 256) {
      this.sink.increment('peer_audit.bridge.route_dropped', { reason: PEER_AUDIT_ROUTE_DROP_REASONS.MISSING_COMMAND_ID });
      return { ok: false, reason: PEER_AUDIT_ROUTE_DROP_REASONS.MISSING_COMMAND_ID };
    }
    const key = peerAuditRouteKey(input.responseType, input.commandId);
    if (this.routes.has(key)) {
      // Never let a second browser claim another tab's in-flight command id.
      // UUIDs make accidental collisions negligible, but this boundary must
      // still fail closed against a malicious/replayed command.
      this.sink.logWarn('peer_audit.bridge.duplicate_route_key', { responseType: input.responseType, commandId: input.commandId }, 'peer-audit route key already pending — rejecting');
      this.sink.increment('peer_audit.bridge.route_dropped', { reason: PEER_AUDIT_ROUTE_DROP_REASONS.DUPLICATE_ROUTE });
      return { ok: false, reason: PEER_AUDIT_ROUTE_DROP_REASONS.DUPLICATE_ROUTE };
    }
    if (this.routes.size >= this.limits.global) {
      this.#evictOldest();
      if (this.routes.size >= this.limits.global) {
        this.sink.increment('peer_audit.bridge.route_dropped', { reason: PEER_AUDIT_ROUTE_DROP_REASONS.GLOBAL_CAP });
        return { ok: false, reason: PEER_AUDIT_ROUTE_DROP_REASONS.GLOBAL_CAP };
      }
    }
    const perSocket = this.perSocketCount.get(input.socket) ?? 0;
    if (perSocket >= this.limits.perSocket) {
      // Per-socket cap is strict: a single browser socket must not hold an
      // unbounded number of pending peer-audit responses. Evicting to make
      // room would discard the oldest in-flight RPC for that browser, which
      // is worse than refusing the new one — fail closed.
      this.sink.increment('peer_audit.bridge.route_dropped', { reason: PEER_AUDIT_ROUTE_DROP_REASONS.PER_SOCKET_CAP });
      return { ok: false, reason: PEER_AUDIT_ROUTE_DROP_REASONS.PER_SOCKET_CAP };
    }
    const timer = setTimeout(() => {
      const entry = this.routes.get(key);
      if (!entry) return;
      this.#clearTimer(entry);
      this.routes.delete(key);
      this.#decrementSocketCount(entry.socket);
      this.sink.increment('peer_audit.bridge.route_dropped', { reason: PEER_AUDIT_ROUTE_DROP_REASONS.EXPIRED });
    }, this.limits.ttlMs);
    const entry: PeerAuditRouteEntry = {
      socket: input.socket,
      commandId: input.commandId,
      requestType: input.requestType,
      responseType: input.responseType,
      daemonGeneration: this.currentDaemonGeneration,
      createdAt: Date.now(),
      timer,
    };
    this.routes.set(key, entry);
    this.perSocketCount.set(input.socket, (this.perSocketCount.get(input.socket) ?? 0) + 1);
    return { ok: true };
  }

  /**
   * Resolve a daemon response to its originating socket and consume the
   * route. Returns the socket if a valid route exists; otherwise null and
   * records the drop reason.
   */
  resolve(message: { type?: unknown; commandId?: unknown }): { socket: import('ws').WebSocket } | null {
    const type = typeof message.type === 'string' ? message.type : '';
    const commandId = typeof message.commandId === 'string' ? message.commandId : '';
    if (!PEER_AUDIT_ROUTE_RESPONSE_TYPES.has(type)) {
      // Not a peer-audit response — caller will handle default routing.
      return null;
    }
    if (!commandId) {
      this.sink.increment('peer_audit.bridge.route_dropped', { reason: PEER_AUDIT_ROUTE_DROP_REASONS.MISSING_COMMAND_ID });
      return null;
    }
    // Walk all routes for the originating commandId regardless of type to
    // detect type-mismatch distinctly from no-route. This matters because a
    // daemon reply may legitimately race with the browser's own retries.
    let match: PeerAuditRouteEntry | undefined;
    for (const [key, candidate] of this.routes) {
      if (candidate.commandId !== commandId) continue;
      match = candidate;
      if (candidate.responseType !== type) {
        this.sink.increment('peer_audit.bridge.route_dropped', { reason: PEER_AUDIT_ROUTE_DROP_REASONS.TYPE_MISMATCH });
        this.#clearTimer(candidate);
        this.routes.delete(key);
        this.#decrementSocketCount(candidate.socket);
        return null;
      }
      break;
    }
    if (!match) {
      this.sink.increment('peer_audit.bridge.route_dropped', { reason: PEER_AUDIT_ROUTE_DROP_REASONS.NO_ROUTE });
      return null;
    }
    if (match.commandId !== commandId) {
      this.sink.increment('peer_audit.bridge.route_dropped', { reason: PEER_AUDIT_ROUTE_DROP_REASONS.COMMAND_ID_MISMATCH });
      return null;
    }
    if (match.daemonGeneration !== this.currentDaemonGeneration) {
      const key = peerAuditRouteKey(type, commandId);
      this.#clearTimer(match);
      this.routes.delete(key);
      this.#decrementSocketCount(match.socket);
      this.sink.increment('peer_audit.bridge.route_dropped', { reason: PEER_AUDIT_ROUTE_DROP_REASONS.GENERATION_MISMATCH });
      return null;
    }
    // Consume once.
    const key = peerAuditRouteKey(type, commandId);
    this.#clearTimer(match);
    this.routes.delete(key);
    this.#decrementSocketCount(match.socket);
    return { socket: match.socket };
  }

  /**
   * Drop every route that originates from a closed / errored socket. Called
   * by the bridge `cleanupBrowserSocket` path.
   */
  dropSocket(socket: import('ws').WebSocket): void {
    for (const [key, entry] of [...this.routes]) {
      if (entry.socket !== socket) continue;
      this.#clearTimer(entry);
      this.routes.delete(key);
      this.sink.increment('peer_audit.bridge.route_dropped', { reason: PEER_AUDIT_ROUTE_DROP_REASONS.SOCKET_CLOSED });
    }
    this.perSocketCount.delete(socket);
  }

  /** Release exactly one reservation after a synchronous forward failure. */
  drop(responseType: string, commandId: string, socket: import('ws').WebSocket): boolean {
    const key = peerAuditRouteKey(responseType, commandId);
    const entry = this.routes.get(key);
    if (!entry || entry.socket !== socket) return false;
    this.#clearTimer(entry);
    this.routes.delete(key);
    this.#decrementSocketCount(socket);
    return true;
  }

  /**
   * Produce a cryptographically unique command id. Exposed so callers can
   * use the same entropy source the route key is constructed from.
   */
  static mintCommandId(): string {
    return `peer_audit_${randomUUID()}`;
  }

  /** Test/diagnostic accessor. */
  size(): number {
    return this.routes.size;
  }

  /** Test/diagnostic accessor. */
  has(type: string, commandId: string): boolean {
    return this.routes.has(peerAuditRouteKey(type, commandId));
  }

  #clearTimer(entry: PeerAuditRouteEntry): void {
    clearTimeout(entry.timer);
  }

  #decrementSocketCount(socket: import('ws').WebSocket): void {
    const current = this.perSocketCount.get(socket) ?? 0;
    if (current <= 1) {
      this.perSocketCount.delete(socket);
    } else {
      this.perSocketCount.set(socket, current - 1);
    }
  }

  #evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.routes) {
      if (entry.createdAt < oldestAt) {
        oldestAt = entry.createdAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) return;
    const entry = this.routes.get(oldestKey)!;
    this.#clearTimer(entry);
    this.routes.delete(oldestKey);
    this.#decrementSocketCount(entry.socket);
    this.sink.increment('peer_audit.bridge.route_dropped', { reason: PEER_AUDIT_ROUTE_DROP_REASONS.GLOBAL_CAP });
  }

}
