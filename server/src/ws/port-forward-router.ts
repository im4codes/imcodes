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
  type PortForwardWireMessage,
} from '../../../shared/port-forward.js';
import {
  InMemoryPortForwardClusterStore,
  tunnelRecordToSummary,
  type PortForwardClusterBusMessage,
  type PortForwardClusterStore,
  type PortForwardClusterTunnelRecord,
} from './port-forward-cluster.js';

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
  listenPodId: string;
  listenGeneration: number;
  requestedListenPort: number;
  boundListenPort: number | null;
  targetNode: string;
  targetServerId: string;
  targetNodeId?: string;
  targetPodId: string;
  targetGeneration: number;
  targetHost: string;
  targetPort: number;
  transportPref: PortForwardTransportPref;
  transportMode: PortForwardTransport | null;
  listenEstablishedMode: PortForwardTransport | null;
  targetEstablishedMode: PortForwardTransport | null;
  label?: string;
  status: 'preparing' | 'connecting' | 'active' | 'closed';
  listenReady: boolean;
  listenCandidates: PortForwardCandidate[];
  listenPublicKey: string | null;
  listenKeyProof: string | null;
  targetReady: boolean;
  targetCandidates: PortForwardCandidate[];
  targetPublicKey: string | null;
  targetKeyProof: string | null;
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
  podId?: string;
  clusterStore?: PortForwardClusterStore;
  lookupBridge?: PortForwardBridgeLookup;
  getIceServers?: PortForwardIceServerProvider;
  prepareTimeoutMs?: number;
  establishTimeoutMs?: number;
}

export class PortForwardRouter {
  private readonly tunnels = new Map<string, ActiveServerTunnel>();
  private podId: string;
  private clusterStore: PortForwardClusterStore;
  private hasSharedClusterStore: boolean;
  private unsubscribeBus: (() => void) | null = null;
  private lookupBridge: PortForwardBridgeLookup;
  private getIceServers: PortForwardIceServerProvider;
  private prepareTimeoutMs: number;
  private establishTimeoutMs: number;

  constructor(options: PortForwardRouterOptions = {}) {
    this.podId = options.podId ?? `pod_${randomBytes(6).toString('hex')}`;
    this.clusterStore = options.clusterStore ?? new InMemoryPortForwardClusterStore();
    this.hasSharedClusterStore = options.clusterStore !== undefined;
    this.lookupBridge = options.lookupBridge ?? (() => undefined);
    this.getIceServers = options.getIceServers ?? (() => []);
    this.prepareTimeoutMs = options.prepareTimeoutMs ?? PORT_FORWARD_LIMITS.PREPARE_TIMEOUT_MS;
    this.establishTimeoutMs = options.establishTimeoutMs ?? PORT_FORWARD_LIMITS.ESTABLISH_TIMEOUT_MS;
    this.bindBusSubscription();
  }

  getPodId(): string {
    return this.podId;
  }

  configure(options: PortForwardRouterOptions): void {
    const podChanged = options.podId !== undefined && options.podId !== this.podId;
    const storeChanged = options.clusterStore !== undefined && options.clusterStore !== this.clusterStore;
    if (options.podId !== undefined) this.podId = options.podId;
    if (options.clusterStore !== undefined) {
      this.clusterStore = options.clusterStore;
      this.hasSharedClusterStore = true;
    }
    if (podChanged || storeChanged) {
      this.bindBusSubscription();
    }
    if (options.lookupBridge) this.lookupBridge = options.lookupBridge;
    if (options.getIceServers) this.getIceServers = options.getIceServers;
    if (options.prepareTimeoutMs !== undefined) this.prepareTimeoutMs = options.prepareTimeoutMs;
    if (options.establishTimeoutMs !== undefined) this.establishTimeoutMs = options.establishTimeoutMs;
  }

  async startCluster(): Promise<void> {
    if (this.clusterStore.start) {
      await this.clusterStore.start(this.podId, (msg) => this.handleBusMessage(msg));
    } else {
      this.bindBusSubscription();
    }
  }

  async stopCluster(): Promise<void> {
    this.unsubscribeBus?.();
    this.unsubscribeBus = null;
    if (this.clusterStore.stop) {
      await this.clusterStore.stop(this.podId);
    }
    for (const tunnel of [...this.tunnels.values()]) {
      this.failPendingOrCloseTunnel(
        tunnel,
        503,
        PORT_FORWARD_ERRORS.NODE_OFFLINE,
        'server shutting down',
      );
    }
  }

  private bindBusSubscription(): void {
    this.unsubscribeBus?.();
    this.unsubscribeBus = this.clusterStore.subscribePod(this.podId, (msg) => this.handleBusMessage(msg));
  }

  onDaemonConnected(serverId: string, generation: number): void {
    void this.clusterStore.registerEndpoint(this.podId, serverId, generation).catch(() => {});
  }

  onDaemonDisconnected(serverId: string, generation: number): void {
    void this.clusterStore.unregisterEndpoint(this.podId, serverId, generation).catch(() => {});

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

    if (this.hasSharedClusterStore) {
      void this.notifyRemoteCoordinatorsOfDisconnect(serverId, generation);
    }
  }

  private async notifyRemoteCoordinatorsOfDisconnect(serverId: string, generation: number): Promise<void> {
    try {
      const affected = await this.clusterStore.listOpenTunnelsForEndpoint(serverId, generation);
      for (const record of affected) {
        if (record.coordinatorPodId === this.podId) continue;
        await this.clusterStore.sendToPod(record.coordinatorPodId, {
          kind: 'daemon_disconnected',
          tunnelId: record.tunnelId,
          serverId,
          generation,
        });
      }
    } catch {
      // Best-effort cross-pod cleanup notification.
    }
  }

  private async resolveEndpoint(serverId: string): Promise<{ podId: string; generation: number } | null> {
    const localBridge = this.lookupBridge(serverId);
    if (localBridge && localBridge.isDaemonConnected()) {
      return { podId: this.podId, generation: localBridge.daemonConnectionGeneration() };
    }
    if (!this.hasSharedClusterStore) return null;
    const remote = await this.clusterStore.getEndpoint(serverId);
    if (!remote) return null;
    // If cluster store points to THIS pod, trust only live local WsBridge state!
    if (remote.podId === this.podId) {
      return localBridge && localBridge.isDaemonConnected()
        ? { podId: this.podId, generation: localBridge.daemonConnectionGeneration() }
        : null;
    }
    return { podId: remote.podId, generation: remote.generation };
  }

  private async sendToEndpoint(
    podId: string,
    serverId: string,
    expectedGeneration: number,
    frame: PortForwardWireMessage,
  ): Promise<boolean> {
    if (podId === this.podId) {
      const bridge = this.lookupBridge(serverId);
      if (!bridge || !bridge.isDaemonConnected()) return false;
      return bridge.trySendPortForward(frame as unknown as Record<string, unknown>, expectedGeneration);
    }
    try {
      await this.clusterStore.sendToPod(podId, {
        kind: 'to_endpoint',
        serverId,
        expectedGeneration,
        frame,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async handleBusMessage(msg: PortForwardClusterBusMessage): Promise<void> {
    switch (msg.kind) {
      case 'to_endpoint': {
        const bridge = this.lookupBridge(msg.serverId);
        if (!bridge || !bridge.isDaemonConnected()) {
          // Stale endpoint presence or disconnected locally: notify disconnect so coordinator tears down.
          if (msg.frame.type !== PORT_FORWARD_MSG.CLOSE) {
            this.onDaemonDisconnected(msg.serverId, msg.expectedGeneration);
          }
          return;
        }
        const ok = bridge.trySendPortForward(msg.frame as unknown as Record<string, unknown>, msg.expectedGeneration);
        if (!ok && msg.frame.type !== PORT_FORWARD_MSG.CLOSE) {
          this.onDaemonDisconnected(msg.serverId, msg.expectedGeneration);
        }
        return;
      }

      case 'to_coordinator': {
        const tunnel = this.tunnels.get(msg.tunnelId);
        if (!tunnel || tunnel.status === 'closed') return;
        this.processCoordinatorMessage(tunnel, msg.fromServerId, msg.fromGeneration, msg.frame);
        return;
      }

      case 'daemon_disconnected': {
        const tunnel = this.tunnels.get(msg.tunnelId);
        if (!tunnel || tunnel.status === 'closed') return;
        const isListen = tunnel.listenServerId === msg.serverId && tunnel.listenGeneration === msg.generation;
        const isTarget = tunnel.targetServerId === msg.serverId && tunnel.targetGeneration === msg.generation;
        if (!isListen && !isTarget) return;
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
        return;
      }

      case 'close_tunnel': {
        const tunnel = this.tunnels.get(msg.tunnelId);
        if (!tunnel || tunnel.status === 'closed') return;
        this.failPendingOrCloseTunnel(
          tunnel,
          409,
          PORT_FORWARD_ERRORS.TUNNEL_NOT_FOUND,
          msg.reason,
        );
        return;
      }
    }
  }

  async openTunnel(input: PortForwardRouterOpenInput): Promise<PortForwardRouterOpenResult> {
    const [listenEp, targetEp] = await Promise.all([
      this.resolveEndpoint(input.listenServerId),
      this.resolveEndpoint(input.targetServerId),
    ]);
    if (!listenEp) {
      return {
        ok: false,
        status: 503,
        reason: PORT_FORWARD_ERRORS.NODE_OFFLINE,
        error: `listen node "${input.listenNode}" is offline`,
      };
    }
    if (!targetEp) {
      return {
        ok: false,
        status: 503,
        reason: PORT_FORWARD_ERRORS.NODE_OFFLINE,
        error: `target node "${input.targetNode}" is offline`,
      };
    }

    const tunnelId = `pf_${randomBytes(16).toString('hex')}`;
    const capability = randomBytes(32).toString('base64url');
    const iceServers = this.getIceServers(input.userId);
    const createdAt = Date.now();
    const ttlMs = input.ttlSeconds * 1000;
    const expiresAt = createdAt + ttlMs;

    const clusterRecord: PortForwardClusterTunnelRecord = {
      tunnelId,
      userId: input.userId,
      coordinatorPodId: this.podId,
      listenNode: input.listenNode,
      listenServerId: input.listenServerId,
      ...(input.listenNodeId ? { listenNodeId: input.listenNodeId } : {}),
      listenGeneration: listenEp.generation,
      requestedListenPort: input.listenPort,
      boundListenPort: null,
      targetNode: input.targetNode,
      targetServerId: input.targetServerId,
      ...(input.targetNodeId ? { targetNodeId: input.targetNodeId } : {}),
      targetGeneration: targetEp.generation,
      targetHost: input.targetHost,
      targetPort: input.targetPort,
      transportPref: input.transport,
      transportMode: null,
      status: 'preparing',
      activeConnections: 0,
      bytesSent: 0,
      bytesReceived: 0,
      ...(input.label ? { label: input.label } : {}),
      createdAt,
      expiresAt,
      updatedAt: createdAt,
    };

    const quota = await this.clusterStore.tryCreateTunnel(clusterRecord);
    if (!quota.ok) {
      return {
        ok: false,
        status: 429,
        reason: PORT_FORWARD_ERRORS.LIMIT_EXCEEDED,
        error: quota.error,
      };
    }

    return new Promise<PortForwardRouterOpenResult>((resolveOpen) => {
      const tunnel: ActiveServerTunnel = {
        tunnelId,
        userId: input.userId,
        listenNode: input.listenNode,
        listenServerId: input.listenServerId,
        ...(input.listenNodeId ? { listenNodeId: input.listenNodeId } : {}),
        listenPodId: listenEp.podId,
        listenGeneration: listenEp.generation,
        requestedListenPort: input.listenPort,
        boundListenPort: null,
        targetNode: input.targetNode,
        targetServerId: input.targetServerId,
        ...(input.targetNodeId ? { targetNodeId: input.targetNodeId } : {}),
        targetPodId: targetEp.podId,
        targetGeneration: targetEp.generation,
        targetHost: input.targetHost,
        targetPort: input.targetPort,
        transportPref: input.transport,
        transportMode: null,
        listenEstablishedMode: null,
        targetEstablishedMode: null,
        ...(input.label ? { label: input.label } : {}),
        status: 'preparing',
        listenReady: false,
        listenCandidates: [],
        listenPublicKey: null,
        listenKeyProof: null,
        targetReady: false,
        targetCandidates: [],
        targetPublicKey: null,
        targetKeyProof: null,
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

      void Promise.all([
        this.sendToEndpoint(listenEp.podId, input.listenServerId, listenEp.generation, {
          type: PORT_FORWARD_MSG.PREPARE,
          tunnelId,
          role: PORT_FORWARD_ROLE.LISTEN,
          capability,
          selfServerId: input.listenServerId,
          peerServerId: input.targetServerId,
          listenHost: PORT_FORWARD_LIMITS.LISTEN_HOST,
          listenPort: input.listenPort,
          transport: input.transport,
          iceServers,
          ttlMs,
        }),
        this.sendToEndpoint(targetEp.podId, input.targetServerId, targetEp.generation, {
          type: PORT_FORWARD_MSG.PREPARE,
          tunnelId,
          role: PORT_FORWARD_ROLE.TARGET,
          capability,
          selfServerId: input.targetServerId,
          peerServerId: input.listenServerId,
          targetHost: input.targetHost,
          targetPort: input.targetPort,
          transport: input.transport,
          iceServers,
          ttlMs,
        }),
      ]).then(([sentListen, sentTarget]) => {
        if (tunnel.status === 'closed') return;
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
    });
  }

  async listTunnels(userId: string, nodeServerId?: string): Promise<PortForwardTunnelSummary[]> {
    return this.clusterStore.listActiveTunnels(userId, nodeServerId);
  }

  async closeTunnelForUser(
    userId: string,
    tunnelId: string,
    reason = 'closed_by_user',
  ): Promise<{ ok: true; closedTunnelIds: string[] } | { ok: false; status: number; reason: PortForwardErrorCode; error: string }> {
    const record = await this.clusterStore.getTunnel(tunnelId);
    if (!record || record.status === 'closed') {
      return {
        ok: false,
        status: 404,
        reason: PORT_FORWARD_ERRORS.TUNNEL_NOT_FOUND,
        error: `tunnel "${tunnelId}" not found`,
      };
    }
    if (record.userId !== userId) {
      return {
        ok: false,
        status: 403,
        reason: PORT_FORWARD_ERRORS.TARGET_FORBIDDEN,
        error: `tunnel "${tunnelId}" is not owned by caller`,
      };
    }
    await this.clusterStore.markTunnelClosed(tunnelId);
    const localTunnel = this.tunnels.get(tunnelId);
    if (localTunnel) {
      this.failPendingOrCloseTunnel(
        localTunnel,
        409,
        PORT_FORWARD_ERRORS.TUNNEL_NOT_FOUND,
        reason,
      );
    } else if (record.coordinatorPodId !== this.podId) {
      await this.clusterStore.sendToPod(record.coordinatorPodId, {
        kind: 'close_tunnel',
        tunnelId,
        reason,
      });
    }
    return { ok: true, closedTunnelIds: [tunnelId] };
  }

  async closeAllForUser(userId: string, nodeServerId?: string, reason = 'closed_by_user'): Promise<string[]> {
    const openTunnels = await this.clusterStore.listOpenTunnelsForUser(userId, nodeServerId);
    const closedIds: string[] = [];
    for (const record of openTunnels) {
      await this.clusterStore.markTunnelClosed(record.tunnelId);
      const localTunnel = this.tunnels.get(record.tunnelId);
      if (localTunnel) {
        this.failPendingOrCloseTunnel(
          localTunnel,
          409,
          PORT_FORWARD_ERRORS.TUNNEL_NOT_FOUND,
          reason,
        );
      } else if (record.coordinatorPodId !== this.podId) {
        await this.clusterStore.sendToPod(record.coordinatorPodId, {
          kind: 'close_tunnel',
          tunnelId: record.tunnelId,
          reason,
        });
      }
      closedIds.push(record.tunnelId);
    }
    return closedIds;
  }

  handleDaemonMessage(fromServerId: string, fromGeneration: number, raw: unknown): boolean {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const type = (raw as { type?: unknown }).type;
    if (!isPortForwardMessageType(type)) return false;

    const parsed = validatePortForwardWireMessage(raw);
    if (!parsed.ok) return true;
    const msg = parsed.value;

    const localTunnel = this.tunnels.get(msg.tunnelId);
    if (localTunnel) {
      if (localTunnel.status !== 'closed') {
        this.processCoordinatorMessage(localTunnel, fromServerId, fromGeneration, msg);
      }
      return true;
    }

    if (this.hasSharedClusterStore) {
      void this.forwardMessageToCoordinator(fromServerId, fromGeneration, msg);
    }
    return true;
  }

  private async forwardMessageToCoordinator(
    fromServerId: string,
    fromGeneration: number,
    msg: PortForwardWireMessage,
  ): Promise<void> {
    try {
      const record = await this.clusterStore.getTunnel(msg.tunnelId);
      if (!record || record.status === 'closed') return;
      if (record.coordinatorPodId === this.podId) {
        const localTunnel = this.tunnels.get(msg.tunnelId);
        if (localTunnel && localTunnel.status !== 'closed') {
          this.processCoordinatorMessage(localTunnel, fromServerId, fromGeneration, msg);
        }
        return;
      }
      await this.clusterStore.sendToPod(record.coordinatorPodId, {
        kind: 'to_coordinator',
        tunnelId: msg.tunnelId,
        fromServerId,
        fromGeneration,
        frame: msg,
      });
    } catch {
      // Ignore transient cluster lookup failure on closing tunnel.
    }
  }

  private processCoordinatorMessage(
    tunnel: ActiveServerTunnel,
    fromServerId: string,
    fromGeneration: number,
    msg: PortForwardWireMessage,
  ): void {
    if (tunnel.status === 'closed') return;

    const senderRole: PortForwardRole | null =
      tunnel.listenServerId === fromServerId && tunnel.listenGeneration === fromGeneration
        ? PORT_FORWARD_ROLE.LISTEN
        : tunnel.targetServerId === fromServerId && tunnel.targetGeneration === fromGeneration
          ? PORT_FORWARD_ROLE.TARGET
          : null;
    if (!senderRole) return;

    switch (msg.type) {
      case PORT_FORWARD_MSG.READY: {
        if (tunnel.status !== 'preparing' || msg.role !== senderRole) return;
        if (senderRole === PORT_FORWARD_ROLE.LISTEN) {
          tunnel.listenReady = true;
          tunnel.listenCandidates = msg.candidates;
          tunnel.listenPublicKey = msg.publicKey;
          tunnel.listenKeyProof = msg.keyProof;
          tunnel.boundListenPort = msg.listenPort ?? null;
        } else {
          tunnel.targetReady = true;
          tunnel.targetCandidates = msg.candidates;
          tunnel.targetPublicKey = msg.publicKey;
          tunnel.targetKeyProof = msg.keyProof;
        }
        if (tunnel.listenReady && tunnel.targetReady) {
          if (tunnel.prepareTimer) {
            clearTimeout(tunnel.prepareTimer);
            tunnel.prepareTimer = null;
          }
          tunnel.status = 'connecting';
          void this.clusterStore.updateTunnel(tunnel.tunnelId, {
            status: 'connecting',
            boundListenPort: tunnel.boundListenPort,
          }).catch(() => {});
          this.dispatchConnect(tunnel);
        }
        return;
      }

      case PORT_FORWARD_MSG.ESTABLISHED: {
        if (tunnel.status !== 'connecting' || msg.role !== senderRole) return;
        if (senderRole === PORT_FORWARD_ROLE.LISTEN) {
          tunnel.listenEstablishedMode = msg.transportMode;
          if (msg.listenPort !== undefined) tunnel.boundListenPort = msg.listenPort;
        } else {
          tunnel.targetEstablishedMode = msg.transportMode;
        }

        // Synchronize activation: BOTH endpoints must confirm the exact same transportMode!
        if (!tunnel.listenEstablishedMode || !tunnel.targetEstablishedMode) return;
        if (tunnel.listenEstablishedMode !== tunnel.targetEstablishedMode) {
          this.failPendingTunnel(
            tunnel,
            502,
            PORT_FORWARD_ERRORS.INTERNAL_ERROR,
            `transport mode mismatch (${tunnel.listenEstablishedMode} vs ${tunnel.targetEstablishedMode})`,
          );
          return;
        }

        if (tunnel.establishTimer) {
          clearTimeout(tunnel.establishTimer);
          tunnel.establishTimer = null;
        }
        tunnel.status = 'active';
        tunnel.transportMode = tunnel.listenEstablishedMode;
        void this.clusterStore.updateTunnel(tunnel.tunnelId, {
          status: 'active',
          transportMode: tunnel.transportMode,
          boundListenPort: tunnel.boundListenPort,
        }).catch(() => {});

        const remainingTtlMs = Math.max(1_000, tunnel.expiresAt - Date.now());
        tunnel.ttlTimer = setTimeout(() => {
          this.closeTunnelInternal(tunnel, 'ttl_expired', true, true);
        }, remainingTtlMs);
        tunnel.ttlTimer.unref?.();

        this.settleOpenSuccess(tunnel);
        return;
      }

      case PORT_FORWARD_MSG.ERROR: {
        const status = errorStatusForCode(msg.reason);
        this.failPendingTunnel(
          tunnel,
          status,
          msg.reason,
          msg.error ?? msg.reason,
        );
        return;
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
        return;
      }

      case PORT_FORWARD_MSG.RELAY_FRAME: {
        // Phase + policy gate:
        // - Forbidden when transportPref === 'p2p_only'
        // - Forbidden while 'preparing' or 'closed'
        // - Forbidden once active under direct_tcp / direct_udp_p2p
        if (tunnel.transportPref === 'p2p_only') return;
        if (tunnel.status !== 'connecting' && !(tunnel.status === 'active' && tunnel.transportMode === 'relay')) {
          return;
        }

        const peerPodId = senderRole === PORT_FORWARD_ROLE.LISTEN ? tunnel.targetPodId : tunnel.listenPodId;
        const peerServerId = senderRole === PORT_FORWARD_ROLE.LISTEN ? tunnel.targetServerId : tunnel.listenServerId;
        const peerGeneration = senderRole === PORT_FORWARD_ROLE.LISTEN ? tunnel.targetGeneration : tunnel.listenGeneration;

        void this.sendToEndpoint(peerPodId, peerServerId, peerGeneration, {
          type: PORT_FORWARD_MSG.RELAY_FRAME,
          tunnelId: tunnel.tunnelId,
          data: msg.data,
        }).then((sent) => {
          if (!sent && tunnel.status !== 'closed') {
            this.failPendingOrCloseTunnel(
              tunnel,
              503,
              PORT_FORWARD_ERRORS.NODE_OFFLINE,
              'peer_send_failed',
            );
          }
        });
        return;
      }

      case PORT_FORWARD_MSG.STATS: {
        if (senderRole !== PORT_FORWARD_ROLE.LISTEN) return;
        tunnel.activeConnections = msg.activeConnections;
        tunnel.bytesSent = msg.bytesSent;
        tunnel.bytesReceived = msg.bytesReceived;
        void this.clusterStore.updateTunnel(tunnel.tunnelId, {
          activeConnections: msg.activeConnections,
          bytesSent: msg.bytesSent,
          bytesReceived: msg.bytesReceived,
        }).catch(() => {});
        return;
      }
    }
  }

  private dispatchConnect(tunnel: ActiveServerTunnel): void {
    if (!tunnel.listenPublicKey || !tunnel.listenKeyProof || !tunnel.targetPublicKey || !tunnel.targetKeyProof) {
      this.failPendingTunnel(tunnel, 502, PORT_FORWARD_ERRORS.INTERNAL_ERROR, 'missing endpoint public keys');
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

    void Promise.all([
      this.sendToEndpoint(tunnel.targetPodId, tunnel.targetServerId, tunnel.targetGeneration, {
        type: PORT_FORWARD_MSG.CONNECT,
        tunnelId: tunnel.tunnelId,
        role: PORT_FORWARD_ROLE.TARGET,
        peerCandidates: tunnel.listenCandidates,
        peerPublicKey: tunnel.listenPublicKey,
        peerKeyProof: tunnel.listenKeyProof,
        transport: tunnel.transportPref,
      }),
      this.sendToEndpoint(tunnel.listenPodId, tunnel.listenServerId, tunnel.listenGeneration, {
        type: PORT_FORWARD_MSG.CONNECT,
        tunnelId: tunnel.tunnelId,
        role: PORT_FORWARD_ROLE.LISTEN,
        peerCandidates: tunnel.targetCandidates,
        peerPublicKey: tunnel.targetPublicKey,
        peerKeyProof: tunnel.targetKeyProof,
        transport: tunnel.transportPref,
      }),
    ]).then(([sentTarget, sentListen]) => {
      if (tunnel.status === 'closed') return;
      if (!sentTarget || !sentListen) {
        this.failPendingTunnel(tunnel, 503, PORT_FORWARD_ERRORS.NODE_OFFLINE, 'node disconnected during connect');
      }
    });
  }

  private settleOpenSuccess(tunnel: ActiveServerTunnel): void {
    const resolve = tunnel.resolveOpen;
    tunnel.resolveOpen = null;
    resolve?.({ ok: true, tunnel: this.toSummary(tunnel) });
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

  private failPendingOrCloseTunnel(
    tunnel: ActiveServerTunnel,
    pendingStatus: number,
    pendingReason: PortForwardErrorCode,
    reason: string,
  ): void {
    if (tunnel.resolveOpen) {
      this.failPendingTunnel(tunnel, pendingStatus, pendingReason, reason);
    } else {
      this.closeTunnelInternal(tunnel, reason, true, true);
    }
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
    // Safety net: ensure openTunnel can NEVER remain unsettled if closeTunnelInternal was called directly.
    if (tunnel.resolveOpen) {
      const resolve = tunnel.resolveOpen;
      tunnel.resolveOpen = null;
      resolve({ ok: false, status: 409, reason: PORT_FORWARD_ERRORS.TUNNEL_NOT_FOUND, error: reason });
    }
    void this.clusterStore.markTunnelClosed(tunnel.tunnelId).catch(() => {});

    if (notifyListen) {
      void this.sendToEndpoint(tunnel.listenPodId, tunnel.listenServerId, tunnel.listenGeneration, {
        type: PORT_FORWARD_MSG.CLOSE,
        tunnelId: tunnel.tunnelId,
        reason,
      });
    }
    if (notifyTarget) {
      void this.sendToEndpoint(tunnel.targetPodId, tunnel.targetServerId, tunnel.targetGeneration, {
        type: PORT_FORWARD_MSG.CLOSE,
        tunnelId: tunnel.tunnelId,
        reason,
      });
    }
  }

  private toSummary(tunnel: ActiveServerTunnel): PortForwardTunnelSummary {
    return tunnelRecordToSummary({
      tunnelId: tunnel.tunnelId,
      userId: tunnel.userId,
      coordinatorPodId: this.podId,
      listenNode: tunnel.listenNode,
      listenServerId: tunnel.listenServerId,
      ...(tunnel.listenNodeId ? { listenNodeId: tunnel.listenNodeId } : {}),
      listenGeneration: tunnel.listenGeneration,
      requestedListenPort: tunnel.requestedListenPort,
      boundListenPort: tunnel.boundListenPort,
      targetNode: tunnel.targetNode,
      targetServerId: tunnel.targetServerId,
      ...(tunnel.targetNodeId ? { targetNodeId: tunnel.targetNodeId } : {}),
      targetGeneration: tunnel.targetGeneration,
      targetHost: tunnel.targetHost,
      targetPort: tunnel.targetPort,
      transportPref: tunnel.transportPref,
      transportMode: tunnel.transportMode,
      status: tunnel.status,
      activeConnections: tunnel.activeConnections,
      bytesSent: tunnel.bytesSent,
      bytesReceived: tunnel.bytesReceived,
      ...(tunnel.label ? { label: tunnel.label } : {}),
      createdAt: tunnel.createdAt,
      expiresAt: tunnel.expiresAt,
      updatedAt: Date.now(),
    });
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
