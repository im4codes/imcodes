import { randomBytes } from 'node:crypto';
import type { DirectFileTransferIceServerConfig } from '../../../shared/direct-file-transfer.js';
import {
  PORT_FORWARD_ERRORS,
  PORT_FORWARD_LIMITS,
  PORT_FORWARD_MSG,
  PORT_FORWARD_ROLE,
  isPortForwardMessageType,
  validatePortForwardWireMessage,
  type PortForwardCandidate,
  type PortForwardErrorCode,
  type PortForwardRole,
  type PortForwardTransport,
  type PortForwardTransportPref,
  type PortForwardTunnelSummary,
} from '../../../shared/port-forward.js';

export interface PortForwardBridgeEndpoint {
  isDaemonConnected(): boolean;
  daemonConnectionGeneration(): number;
  trySendPortForward(message: Record<string, unknown>, expectedGeneration?: number): boolean;
}

export type PortForwardBridgeLookup = (serverId: string) => PortForwardBridgeEndpoint | undefined;
export type PortForwardIceServerProvider = (userId: string) => DirectFileTransferIceServerConfig[];

export interface PortForwardRouterOpenInput {
  userId: string;
  listenNode: string;
  listenServerId: string;
  listenNodeId?: string;
  listenPort: number;
  targetNode: string;
  targetServerId: string;
  targetNodeId?: string;
  targetHost: string;
  targetPort: number;
  ttlSeconds: number;
  transport: PortForwardTransportPref;
  label?: string;
}

export type PortForwardRouterOpenResult =
  | { ok: true; tunnel: PortForwardTunnelSummary }
  | { ok: false; status: number; reason: PortForwardErrorCode; error: string };

interface ActiveServerTunnel {
  tunnelId: string;
  userId: string;
  listenNode: string;
  listenServerId: string;
  listenNodeId?: string;
  listenGeneration: number;
  requestedListenPort: number;
  boundListenPort: number | null;
  targetNode: string;
  targetServerId: string;
  targetNodeId?: string;
  targetGeneration: number;
  targetHost: string;
  targetPort: number;
  capability: string;
  transportPref: PortForwardTransportPref;
  transportMode: PortForwardTransport | null;
  label?: string;
  status: 'preparing' | 'connecting' | 'active' | 'closed';
  listenReady: boolean;
  listenCandidates: PortForwardCandidate[];
  targetReady: boolean;
  targetCandidates: PortForwardCandidate[];
  activeConnections: number;
  bytesSent: number;
  bytesReceived: number;
  createdAt: number;
  expiresAt: number;
  prepareTimer: ReturnType<typeof setTimeout> | null;
  establishTimer: ReturnType<typeof setTimeout> | null;
  ttlTimer: ReturnType<typeof setTimeout> | null;
  resolveOpen: ((result: PortForwardRouterOpenResult) => void) | null;
}

export interface PortForwardRouterOptions {
  lookupBridge?: PortForwardBridgeLookup;
  getIceServers?: PortForwardIceServerProvider;
  prepareTimeoutMs?: number;
  establishTimeoutMs?: number;
}

export class PortForwardRouter {
  private readonly tunnels = new Map<string, ActiveServerTunnel>();
  private lookupBridge: PortForwardBridgeLookup;
  private getIceServers: PortForwardIceServerProvider;
  private prepareTimeoutMs: number;
  private establishTimeoutMs: number;

  constructor(options: PortForwardRouterOptions = {}) {
    this.lookupBridge = options.lookupBridge ?? (() => undefined);
    this.getIceServers = options.getIceServers ?? (() => []);
    this.prepareTimeoutMs = options.prepareTimeoutMs ?? PORT_FORWARD_LIMITS.PREPARE_TIMEOUT_MS;
    this.establishTimeoutMs = options.establishTimeoutMs ?? PORT_FORWARD_LIMITS.ESTABLISH_TIMEOUT_MS;
  }

  configure(options: PortForwardRouterOptions): void {
    if (options.lookupBridge) this.lookupBridge = options.lookupBridge;
    if (options.getIceServers) this.getIceServers = options.getIceServers;
    if (options.prepareTimeoutMs !== undefined) this.prepareTimeoutMs = options.prepareTimeoutMs;
    if (options.establishTimeoutMs !== undefined) this.establishTimeoutMs = options.establishTimeoutMs;
  }

  async openTunnel(input: PortForwardRouterOpenInput): Promise<PortForwardRouterOpenResult> {
    let userCount = 0;
    let listenCount = 0;
    let targetCount = 0;
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.status === 'closed') continue;
      if (tunnel.userId === input.userId) userCount += 1;
      if (tunnel.listenServerId === input.listenServerId || tunnel.targetServerId === input.listenServerId) {
        listenCount += 1;
      }
      if (tunnel.listenServerId === input.targetServerId || tunnel.targetServerId === input.targetServerId) {
        targetCount += 1;
      }
    }

    if (userCount >= PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_USER) {
      return {
        ok: false,
        status: 429,
        reason: PORT_FORWARD_ERRORS.LIMIT_EXCEEDED,
        error: `user tunnel limit (${PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_USER}) exceeded`,
      };
    }
    if (listenCount >= PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_NODE || targetCount >= PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_NODE) {
      return {
        ok: false,
        status: 429,
        reason: PORT_FORWARD_ERRORS.LIMIT_EXCEEDED,
        error: `node tunnel limit (${PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_NODE}) exceeded`,
      };
    }

    const listenBridge = this.lookupBridge(input.listenServerId);
    if (!listenBridge || !listenBridge.isDaemonConnected()) {
      return {
        ok: false,
        status: 503,
        reason: PORT_FORWARD_ERRORS.NODE_OFFLINE,
        error: `listen node "${input.listenNode}" is offline`,
      };
    }

    const targetBridge = this.lookupBridge(input.targetServerId);
    if (!targetBridge || !targetBridge.isDaemonConnected()) {
      return {
        ok: false,
        status: 503,
        reason: PORT_FORWARD_ERRORS.NODE_OFFLINE,
        error: `target node "${input.targetNode}" is offline`,
      };
    }

    const listenGeneration = listenBridge.daemonConnectionGeneration();
    const targetGeneration = targetBridge.daemonConnectionGeneration();
    const tunnelId = `pf_${randomBytes(16).toString('hex')}`;
    const capability = randomBytes(32).toString('base64url');
    const iceServers = this.getIceServers(input.userId);
    const createdAt = Date.now();
    const ttlMs = input.ttlSeconds * 1000;
    const expiresAt = createdAt + ttlMs;

    return new Promise<PortForwardRouterOpenResult>((resolveOpen) => {
      const tunnel: ActiveServerTunnel = {
        tunnelId,
        userId: input.userId,
        listenNode: input.listenNode,
        listenServerId: input.listenServerId,
        ...(input.listenNodeId ? { listenNodeId: input.listenNodeId } : {}),
        listenGeneration,
        requestedListenPort: input.listenPort,
        boundListenPort: null,
        targetNode: input.targetNode,
        targetServerId: input.targetServerId,
        ...(input.targetNodeId ? { targetNodeId: input.targetNodeId } : {}),
        targetGeneration,
        targetHost: input.targetHost,
        targetPort: input.targetPort,
        capability,
        transportPref: input.transport,
        transportMode: null,
        ...(input.label ? { label: input.label } : {}),
        status: 'preparing',
        listenReady: false,
        listenCandidates: [],
        targetReady: false,
        targetCandidates: [],
        activeConnections: 0,
        bytesSent: 0,
        bytesReceived: 0,
        createdAt,
        expiresAt,
        prepareTimer: null,
        establishTimer: null,
        ttlTimer: null,
        resolveOpen,
      };
      this.tunnels.set(tunnelId, tunnel);

      tunnel.prepareTimer = setTimeout(() => {
        const missingSide = !tunnel.targetReady && tunnel.listenReady
          ? 'target node did not respond to port_forward.prepare (unsupported or timed out)'
          : !tunnel.listenReady && tunnel.targetReady
            ? 'listen node did not respond to port_forward.prepare (unsupported or timed out)'
            : 'nodes did not respond to port_forward.prepare (unsupported or timed out)';
        this.failPendingTunnel(
          tunnel,
          422,
          PORT_FORWARD_ERRORS.TARGET_UNSUPPORTED,
          missingSide,
        );
      }, this.prepareTimeoutMs);
      tunnel.prepareTimer.unref?.();

      const sentListen = listenBridge.trySendPortForward({
        type: PORT_FORWARD_MSG.PREPARE,
        tunnelId,
        role: PORT_FORWARD_ROLE.LISTEN,
        capability,
        listenHost: PORT_FORWARD_LIMITS.LISTEN_HOST,
        listenPort: input.listenPort,
        transport: input.transport,
        iceServers,
        ttlMs,
      }, listenGeneration);

      const sentTarget = sentListen && targetBridge.trySendPortForward({
        type: PORT_FORWARD_MSG.PREPARE,
        tunnelId,
        role: PORT_FORWARD_ROLE.TARGET,
        capability,
        targetHost: input.targetHost,
        targetPort: input.targetPort,
        transport: input.transport,
        iceServers,
        ttlMs,
      }, targetGeneration);

      if (!sentListen || !sentTarget) {
        this.failPendingTunnel(
          tunnel,
          503,
          PORT_FORWARD_ERRORS.NODE_OFFLINE,
          !sentListen
            ? `listen node "${input.listenNode}" disconnected during prepare`
            : `target node "${input.targetNode}" disconnected during prepare`,
        );
      }
    });
  }

  listTunnels(userId: string, nodeServerId?: string): PortForwardTunnelSummary[] {
    const out: PortForwardTunnelSummary[] = [];
    const now = Date.now();
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.userId !== userId || tunnel.status !== 'active') continue;
      if (tunnel.expiresAt <= now) continue;
      if (nodeServerId
        && tunnel.listenServerId !== nodeServerId
        && tunnel.targetServerId !== nodeServerId) {
        continue;
      }
      out.push(this.toSummary(tunnel));
      if (out.length >= PORT_FORWARD_LIMITS.MAX_LIST_TUNNELS) break;
    }
    return out;
  }

  closeTunnelForUser(
    userId: string,
    tunnelId: string,
    reason = 'closed_by_user',
  ): { ok: true; closedTunnelIds: string[] } | { ok: false; status: number; reason: PortForwardErrorCode; error: string } {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel || tunnel.status === 'closed') {
      return {
        ok: false,
        status: 404,
        reason: PORT_FORWARD_ERRORS.TUNNEL_NOT_FOUND,
        error: `tunnel "${tunnelId}" not found`,
      };
    }
    if (tunnel.userId !== userId) {
      return {
        ok: false,
        status: 403,
        reason: PORT_FORWARD_ERRORS.TARGET_FORBIDDEN,
        error: `tunnel "${tunnelId}" is not owned by caller`,
      };
    }
    this.closeTunnelInternal(tunnel, reason, true, true);
    return { ok: true, closedTunnelIds: [tunnelId] };
  }

  closeAllForUser(userId: string, nodeServerId?: string, reason = 'closed_by_user'): string[] {
    const closedIds: string[] = [];
    for (const tunnel of [...this.tunnels.values()]) {
      if (tunnel.userId !== userId || tunnel.status === 'closed') continue;
      if (nodeServerId
        && tunnel.listenServerId !== nodeServerId
        && tunnel.targetServerId !== nodeServerId) {
        continue;
      }
      this.closeTunnelInternal(tunnel, reason, true, true);
      closedIds.push(tunnel.tunnelId);
    }
    return closedIds;
  }

  onDaemonDisconnected(serverId: string, generation: number): void {
    for (const tunnel of [...this.tunnels.values()]) {
      if (tunnel.status === 'closed') continue;
      const isListen = tunnel.listenServerId === serverId && tunnel.listenGeneration === generation;
      const isTarget = tunnel.targetServerId === serverId && tunnel.targetGeneration === generation;
      if (!isListen && !isTarget) continue;

      if (tunnel.resolveOpen) {
        this.failPendingTunnel(
          tunnel,
          503,
          PORT_FORWARD_ERRORS.NODE_OFFLINE,
          isListen ? 'listen node disconnected' : 'target node disconnected',
        );
      } else {
        this.closeTunnelInternal(
          tunnel,
          isListen ? 'listen_node_disconnected' : 'target_node_disconnected',
          !isListen,
          !isTarget,
        );
      }
    }
  }

  handleDaemonMessage(fromServerId: string, fromGeneration: number, raw: unknown): boolean {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const type = (raw as { type?: unknown }).type;
    if (!isPortForwardMessageType(type)) return false;

    const parsed = validatePortForwardWireMessage(raw);
    if (!parsed.ok) return true;
    const msg = parsed.value;
    const tunnel = this.tunnels.get(msg.tunnelId);
    if (!tunnel || tunnel.status === 'closed') return true;

    const senderRole: PortForwardRole | null =
      tunnel.listenServerId === fromServerId && tunnel.listenGeneration === fromGeneration
        ? PORT_FORWARD_ROLE.LISTEN
        : tunnel.targetServerId === fromServerId && tunnel.targetGeneration === fromGeneration
          ? PORT_FORWARD_ROLE.TARGET
          : null;
    if (!senderRole) return true;

    switch (msg.type) {
      case PORT_FORWARD_MSG.READY: {
        if (tunnel.status !== 'preparing' || msg.role !== senderRole) return true;
        if (senderRole === PORT_FORWARD_ROLE.LISTEN) {
          tunnel.listenReady = true;
          tunnel.listenCandidates = msg.candidates;
          tunnel.boundListenPort = msg.listenPort ?? null;
        } else {
          tunnel.targetReady = true;
          tunnel.targetCandidates = msg.candidates;
        }
        if (tunnel.listenReady && tunnel.targetReady) {
          if (tunnel.prepareTimer) {
            clearTimeout(tunnel.prepareTimer);
            tunnel.prepareTimer = null;
          }
          tunnel.status = 'connecting';
          this.dispatchConnect(tunnel);
        }
        return true;
      }

      case PORT_FORWARD_MSG.ESTABLISHED: {
        if (senderRole !== PORT_FORWARD_ROLE.LISTEN || tunnel.status !== 'connecting') return true;
        if (tunnel.establishTimer) {
          clearTimeout(tunnel.establishTimer);
          tunnel.establishTimer = null;
        }
        tunnel.status = 'active';
        tunnel.transportMode = msg.transportMode;
        tunnel.boundListenPort = msg.listenPort;
        const remainingTtlMs = Math.max(1_000, tunnel.expiresAt - Date.now());
        tunnel.ttlTimer = setTimeout(() => {
          this.closeTunnelInternal(tunnel, 'ttl_expired', true, true);
        }, remainingTtlMs);
        tunnel.ttlTimer.unref?.();

        const resolve = tunnel.resolveOpen;
        tunnel.resolveOpen = null;
        resolve?.({ ok: true, tunnel: this.toSummary(tunnel) });
        return true;
      }

      case PORT_FORWARD_MSG.ERROR: {
        const status = errorStatusForCode(msg.reason);
        this.failPendingTunnel(
          tunnel,
          status,
          msg.reason,
          msg.error ?? msg.reason,
        );
        return true;
      }

      case PORT_FORWARD_MSG.CLOSE: {
        if (tunnel.resolveOpen) {
          this.failPendingTunnel(
            tunnel,
            502,
            PORT_FORWARD_ERRORS.INTERNAL_ERROR,
            msg.reason ?? 'tunnel closed by endpoint',
          );
        } else {
          this.closeTunnelInternal(
            tunnel,
            msg.reason ?? 'remote_closed',
            senderRole !== PORT_FORWARD_ROLE.LISTEN,
            senderRole !== PORT_FORWARD_ROLE.TARGET,
          );
        }
        return true;
      }

      case PORT_FORWARD_MSG.RELAY_FRAME: {
        // Security boundary: reject relay frames if tunnel was explicitly opened as p2p_only.
        if (tunnel.transportPref === 'p2p_only') return true;
        const peerServerId = senderRole === PORT_FORWARD_ROLE.LISTEN
          ? tunnel.targetServerId
          : tunnel.listenServerId;
        const peerGeneration = senderRole === PORT_FORWARD_ROLE.LISTEN
          ? tunnel.targetGeneration
          : tunnel.listenGeneration;
        const peerBridge = this.lookupBridge(peerServerId);
        if (!peerBridge || !peerBridge.isDaemonConnected()) {
          this.closeTunnelInternal(tunnel, 'peer_disconnected', senderRole === PORT_FORWARD_ROLE.LISTEN, senderRole === PORT_FORWARD_ROLE.TARGET);
          return true;
        }
        const sent = peerBridge.trySendPortForward({
          type: PORT_FORWARD_MSG.RELAY_FRAME,
          tunnelId: tunnel.tunnelId,
          data: msg.data,
        }, peerGeneration);
        if (!sent) {
          this.closeTunnelInternal(tunnel, 'peer_send_failed', true, true);
        }
        return true;
      }

      case PORT_FORWARD_MSG.STATS: {
        if (senderRole !== PORT_FORWARD_ROLE.LISTEN) return true;
        tunnel.activeConnections = msg.activeConnections;
        tunnel.bytesSent = msg.bytesSent;
        tunnel.bytesReceived = msg.bytesReceived;
        return true;
      }

      default:
        return true;
    }
  }

  private dispatchConnect(tunnel: ActiveServerTunnel): void {
    const listenBridge = this.lookupBridge(tunnel.listenServerId);
    const targetBridge = this.lookupBridge(tunnel.targetServerId);
    if (!listenBridge || !targetBridge || !listenBridge.isDaemonConnected() || !targetBridge.isDaemonConnected()) {
      this.failPendingTunnel(tunnel, 503, PORT_FORWARD_ERRORS.NODE_OFFLINE, 'node disconnected before connect');
      return;
    }

    tunnel.establishTimer = setTimeout(() => {
      this.failPendingTunnel(
        tunnel,
        504,
        PORT_FORWARD_ERRORS.TIMEOUT,
        'port forward establishment timed out',
      );
    }, this.establishTimeoutMs);
    tunnel.establishTimer.unref?.();

    const sentTarget = targetBridge.trySendPortForward({
      type: PORT_FORWARD_MSG.CONNECT,
      tunnelId: tunnel.tunnelId,
      role: PORT_FORWARD_ROLE.TARGET,
      peerCandidates: tunnel.listenCandidates,
      transport: tunnel.transportPref,
    }, tunnel.targetGeneration);

    const sentListen = sentTarget && listenBridge.trySendPortForward({
      type: PORT_FORWARD_MSG.CONNECT,
      tunnelId: tunnel.tunnelId,
      role: PORT_FORWARD_ROLE.LISTEN,
      peerCandidates: tunnel.targetCandidates,
      transport: tunnel.transportPref,
    }, tunnel.listenGeneration);

    if (!sentTarget || !sentListen) {
      this.failPendingTunnel(tunnel, 503, PORT_FORWARD_ERRORS.NODE_OFFLINE, 'node disconnected during connect');
    }
  }

  private failPendingTunnel(
    tunnel: ActiveServerTunnel,
    status: number,
    reason: PortForwardErrorCode,
    error: string,
  ): void {
    const resolve = tunnel.resolveOpen;
    tunnel.resolveOpen = null;
    this.closeTunnelInternal(tunnel, reason, true, true);
    resolve?.({ ok: false, status, reason, error });
  }

  private closeTunnelInternal(
    tunnel: ActiveServerTunnel,
    reason: string,
    notifyListen: boolean,
    notifyTarget: boolean,
  ): void {
    if (tunnel.status === 'closed') return;
    tunnel.status = 'closed';
    this.tunnels.delete(tunnel.tunnelId);
    if (tunnel.prepareTimer) {
      clearTimeout(tunnel.prepareTimer);
      tunnel.prepareTimer = null;
    }
    if (tunnel.establishTimer) {
      clearTimeout(tunnel.establishTimer);
      tunnel.establishTimer = null;
    }
    if (tunnel.ttlTimer) {
      clearTimeout(tunnel.ttlTimer);
      tunnel.ttlTimer = null;
    }
    if (notifyListen) {
      const listenBridge = this.lookupBridge(tunnel.listenServerId);
      listenBridge?.trySendPortForward({
        type: PORT_FORWARD_MSG.CLOSE,
        tunnelId: tunnel.tunnelId,
        reason,
      }, tunnel.listenGeneration);
    }
    if (notifyTarget) {
      const targetBridge = this.lookupBridge(tunnel.targetServerId);
      targetBridge?.trySendPortForward({
        type: PORT_FORWARD_MSG.CLOSE,
        tunnelId: tunnel.tunnelId,
        reason,
      }, tunnel.targetGeneration);
    }
  }

  private toSummary(tunnel: ActiveServerTunnel): PortForwardTunnelSummary {
    const listenPort = tunnel.boundListenPort ?? tunnel.requestedListenPort;
    return {
      tunnelId: tunnel.tunnelId,
      listenNode: tunnel.listenNode,
      listenServerId: tunnel.listenServerId,
      ...(tunnel.listenNodeId ? { listenNodeId: tunnel.listenNodeId } : {}),
      listenHost: PORT_FORWARD_LIMITS.LISTEN_HOST,
      listenPort,
      localEndpoint: `${PORT_FORWARD_LIMITS.LISTEN_HOST}:${listenPort}`,
      targetNode: tunnel.targetNode,
      targetServerId: tunnel.targetServerId,
      ...(tunnel.targetNodeId ? { targetNodeId: tunnel.targetNodeId } : {}),
      targetHost: tunnel.targetHost,
      targetPort: tunnel.targetPort,
      transportMode: tunnel.transportMode ?? 'relay',
      activeConnections: tunnel.activeConnections,
      bytesSent: tunnel.bytesSent,
      bytesReceived: tunnel.bytesReceived,
      createdAt: tunnel.createdAt,
      expiresAt: tunnel.expiresAt,
      ...(tunnel.label ? { label: tunnel.label } : {}),
    };
  }
}

function errorStatusForCode(reason: PortForwardErrorCode): number {
  switch (reason) {
    case PORT_FORWARD_ERRORS.INVALID_REQUEST:
      return 400;
    case PORT_FORWARD_ERRORS.SCOPED_AUTH:
    case PORT_FORWARD_ERRORS.TARGET_FORBIDDEN:
    case PORT_FORWARD_ERRORS.EXEC_DISABLED:
      return 403;
    case PORT_FORWARD_ERRORS.NODE_NOT_FOUND:
    case PORT_FORWARD_ERRORS.TUNNEL_NOT_FOUND:
      return 404;
    case PORT_FORWARD_ERRORS.LISTEN_PORT_IN_USE:
    case PORT_FORWARD_ERRORS.NODE_AMBIGUOUS:
      return 409;
    case PORT_FORWARD_ERRORS.TARGET_UNSUPPORTED:
      return 422;
    case PORT_FORWARD_ERRORS.LIMIT_EXCEEDED:
    case PORT_FORWARD_ERRORS.RATE_LIMITED:
      return 429;
    case PORT_FORWARD_ERRORS.P2P_FAILED:
      return 502;
    case PORT_FORWARD_ERRORS.NODE_OFFLINE:
      return 503;
    case PORT_FORWARD_ERRORS.TIMEOUT:
      return 504;
    default:
      return 500;
  }
}

export const defaultPortForwardRouter = new PortForwardRouter();
