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
  type PortForwardRelayDirection,
  type PortForwardRemoteCloseAckOutcome,
} from './port-forward-cluster.js';

export interface PortForwardBridgeEndpoint {
  isDaemonConnected(): boolean;
  daemonConnectionGeneration(): number;
  trySendPortForward(message: Record<string, unknown>, expectedGeneration?: number): boolean;
}

export type PortForwardBridgeLookup = (serverId: string) => PortForwardBridgeEndpoint | undefined;
export type PortForwardIceServerProvider = (userId: string) => DirectFileTransferIceServerConfig[];
export type PortForwardCloseSideState = 'pending' | 'acked' | 'offline' | 'timed_out';
export type PortForwardSendFailureReason = 'offline' | 'generation_mismatch' | 'overflow' | 'write_failed' | 'cancelled';
export interface PortForwardCloseSettlement {
  confirmed: boolean;
  listen: PortForwardCloseSideState;
  target: PortForwardCloseSideState;
}

function isCloseSideSettledConfirmed(state: PortForwardCloseSideState): boolean {
  return state === 'acked' || state === 'offline';
}

interface EndpointMembershipTarget {
  listenServerId: string;
  listenPodId: string;
  listenGeneration: number;
  targetServerId: string;
  targetPodId: string;
  targetGeneration: number;
  status: 'preparing' | 'connecting' | 'active' | 'closing' | 'closed';
  transportPref: PortForwardTransportPref;
  transportMode: PortForwardTransport | null;
}

function resolveEndpointMemberRole(
  tunnel: Pick<
    EndpointMembershipTarget,
    'listenServerId' | 'listenPodId' | 'listenGeneration' | 'targetServerId' | 'targetPodId' | 'targetGeneration'
  >,
  fromServerId: string,
  fromPodId: string,
  fromGeneration: number,
): PortForwardRole | null {
  if (tunnel.listenServerId === fromServerId
    && (!tunnel.listenPodId || tunnel.listenPodId === fromPodId)
    && tunnel.listenGeneration === fromGeneration) {
    return PORT_FORWARD_ROLE.LISTEN;
  }
  if (tunnel.targetServerId === fromServerId
    && (!tunnel.targetPodId || tunnel.targetPodId === fromPodId)
    && tunnel.targetGeneration === fromGeneration) {
    return PORT_FORWARD_ROLE.TARGET;
  }
  return null;
}

const HOP2_DELIVERY_RETRY_DELAYS_MS = [15, 30, 60, 120] as const;

function isMessageAdmissibleForStatus(
  tunnel: Pick<EndpointMembershipTarget, 'status' | 'transportPref' | 'transportMode'>,
  msgType: PortForwardWireMessage['type'],
  requireRelayModeForCached = false,
): boolean {
  if (tunnel.status === 'closed') return false;
  if (tunnel.status === 'closing') {
    return msgType === PORT_FORWARD_MSG.CLOSE_ACK || msgType === PORT_FORWARD_MSG.CLOSE;
  }
  if (msgType === PORT_FORWARD_MSG.RELAY_FRAME) {
    if (tunnel.transportPref === 'p2p_only') return false;
    if (!requireRelayModeForCached) {
      return tunnel.status === 'connecting' || (tunnel.status === 'active' && tunnel.transportMode === 'relay');
    }
    return tunnel.status === 'preparing'
      || tunnel.status === 'connecting'
      || (tunnel.status === 'active' && tunnel.transportMode === 'relay');
  }
  return true;
}

const CLUSTER_RELAY_RETRY_DELAYS_MS = [15, 45] as const;

function delayMs(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    t.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface BoundedQueueItem {
  byteSize: number;
  isRelayData: boolean;
  run: (signal: AbortSignal) => Promise<void>;
}

interface BoundedQueueBucket {
  items: BoundedQueueItem[];
  queuedBytes: number;
  draining: boolean;
  memHighWater: boolean;
  cancelled: boolean;
  abortController: AbortController;
}

interface IngressSenderPressure {
  tunnelId: string;
  serverId: string;
  generation: number;
  memPaused: boolean;
  hop1DbPaused: boolean;
  sentPaused: boolean;
}

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
  status: 'preparing' | 'connecting' | 'active' | 'closing' | 'closed';
  listenReady: boolean;
  listenCandidates: PortForwardCandidate[];
  listenPublicKey: string | null;
  listenKeyProof: string | null;
  listenIdentityPublicKey: string | null;
  listenIdentitySignature: string | null;
  targetReady: boolean;
  targetCandidates: PortForwardCandidate[];
  targetPublicKey: string | null;
  targetKeyProof: string | null;
  targetIdentityPublicKey: string | null;
  targetIdentitySignature: string | null;
  connectDispatchedToListen: boolean;
  l2tBackpressured: boolean;
  t2lBackpressured: boolean;
  l2tOutMemPaused: boolean;
  l2tHop1Paused: boolean;
  l2tHop2Paused: boolean;
  t2lOutMemPaused: boolean;
  t2lHop1Paused: boolean;
  t2lHop2Paused: boolean;
  activeConnections: number;
  bytesSent: number;
  bytesReceived: number;
  createdAt: number;
  expiresAt: number;
  prepareTimer: ReturnType<typeof setTimeout> | null;
  establishTimer: ReturnType<typeof setTimeout> | null;
  ttlTimer: ReturnType<typeof setTimeout> | null;
  closeAckTimer: ReturnType<typeof setTimeout> | null;
  listenCloseState: PortForwardCloseSideState;
  targetCloseState: PortForwardCloseSideState;
  closeSettled: boolean;
  closePromise: Promise<PortForwardCloseSettlement> | null;
  resolveClose: ((res: PortForwardCloseSettlement) => void) | null;
  resolveOpen: ((result: PortForwardRouterOpenResult) => void) | null;
}

export interface PortForwardRouterOptions {
  podId?: string;
  clusterStore?: PortForwardClusterStore;
  lookupBridge?: PortForwardBridgeLookup;
  getIceServers?: PortForwardIceServerProvider;
  prepareTimeoutMs?: number;
  establishTimeoutMs?: number;
  closeAckTimeoutMs?: number;
}

export class PortForwardRouter {
  private readonly tunnels = new Map<string, ActiveServerTunnel>();
  private readonly closingTunnels = new Map<string, ActiveServerTunnel>();
  private readonly pendingRemoteCloses = new Map<
    string,
    (res: { ok: boolean; outcome: PortForwardRemoteCloseAckOutcome }) => void
  >();
  private readonly inboundQueues = new Map<string, BoundedQueueBucket>();
  private readonly preAuthQueues = new Map<string, BoundedQueueBucket>();
  private readonly outboundQueues = new Map<string, BoundedQueueBucket>();
  private readonly remoteDeliveryQueues = new Map<string, BoundedQueueBucket>();
  private readonly ingressPressure = new Map<string, IngressSenderPressure>();
  private readonly authorizedRemoteRoutes = new Map<string, PortForwardClusterTunnelRecord>();
  private readonly closedDeliveryTombstones = new Set<string>();
  private readonly inFlightAdoptions = new Map<string, Promise<{ confirmed: boolean; tunnelId: string }>>();
  private podId: string;
  private clusterStore: PortForwardClusterStore;
  private hasSharedClusterStore: boolean;
  private unsubscribeBus: (() => void) | null = null;
  private lookupBridge: PortForwardBridgeLookup;
  private getIceServers: PortForwardIceServerProvider;
  private prepareTimeoutMs: number;
  private establishTimeoutMs: number;
  private closeAckTimeoutMs: number;

  constructor(options: PortForwardRouterOptions = {}) {
    this.podId = options.podId ?? `pod_${randomBytes(6).toString('hex')}`;
    this.clusterStore = options.clusterStore ?? new InMemoryPortForwardClusterStore();
    this.hasSharedClusterStore = options.clusterStore !== undefined;
    this.lookupBridge = options.lookupBridge ?? (() => undefined);
    this.getIceServers = options.getIceServers ?? (() => []);
    this.prepareTimeoutMs = options.prepareTimeoutMs ?? PORT_FORWARD_LIMITS.PREPARE_TIMEOUT_MS;
    this.establishTimeoutMs = options.establishTimeoutMs ?? PORT_FORWARD_LIMITS.ESTABLISH_TIMEOUT_MS;
    this.closeAckTimeoutMs = options.closeAckTimeoutMs ?? PORT_FORWARD_LIMITS.CLOSE_ACK_TIMEOUT_MS;
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
    if (options.closeAckTimeoutMs !== undefined) this.closeAckTimeoutMs = options.closeAckTimeoutMs;
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
    for (const [reqId, resolve] of this.pendingRemoteCloses.entries()) {
      this.pendingRemoteCloses.delete(reqId);
      resolve({ ok: false, outcome: 'missing' });
    }
    for (const key of [...this.inboundQueues.keys()]) this.cancelQueueBucket(this.inboundQueues, key);
    for (const key of [...this.outboundQueues.keys()]) this.cancelQueueBucket(this.outboundQueues, key);
    for (const key of [...this.preAuthQueues.keys()]) this.cancelQueueBucket(this.preAuthQueues, key);
    for (const key of [...this.remoteDeliveryQueues.keys()]) this.cancelQueueBucket(this.remoteDeliveryQueues, key);
    this.authorizedRemoteRoutes.clear();
    this.closedDeliveryTombstones.clear();
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

  private markDeliveryTombstone(key: string): void {
    if (this.closedDeliveryTombstones.has(key)) return;
    if (this.closedDeliveryTombstones.size >= 4096) {
      const oldest = this.closedDeliveryTombstones.values().next().value;
      if (oldest !== undefined) this.closedDeliveryTombstones.delete(oldest);
    }
    this.closedDeliveryTombstones.add(key);
  }

  private cancelQueueBucket(buckets: Map<string, BoundedQueueBucket>, key: string): void {
    const bucket = buckets.get(key);
    if (!bucket) return;
    bucket.cancelled = true;
    bucket.items.length = 0;
    bucket.queuedBytes = 0;
    bucket.memHighWater = false;
    bucket.abortController.abort();
    buckets.delete(key);
  }

  private cancelBucketsByPrefix(buckets: Map<string, BoundedQueueBucket>, prefix: string): void {
    for (const key of [...buckets.keys()]) {
      if (key.startsWith(prefix)) this.cancelQueueBucket(buckets, key);
    }
  }

  private cancelBucketsBySuffix(buckets: Map<string, BoundedQueueBucket>, suffix: string): void {
    for (const key of [...buckets.keys()]) {
      if (key.endsWith(suffix)) {
        this.markDeliveryTombstone(key);
        this.cancelQueueBucket(buckets, key);
      }
    }
  }

  private cleanupRelayStateForTunnel(tunnelId: string): void {
    const prefix = `${tunnelId}:`;
    this.cancelBucketsByPrefix(this.inboundQueues, prefix);
    this.cancelBucketsByPrefix(this.outboundQueues, prefix);
    this.cancelBucketsByPrefix(this.remoteDeliveryQueues, prefix);
    for (const key of this.ingressPressure.keys()) {
      if (key.startsWith(prefix)) this.ingressPressure.delete(key);
    }
    for (const key of this.authorizedRemoteRoutes.keys()) {
      if (key.startsWith(prefix)) this.authorizedRemoteRoutes.delete(key);
    }
  }

  private isCoordinatorPausedForSender(tunnelId: string, senderServerId: string): boolean {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) return false;
    if (senderServerId === tunnel.listenServerId) {
      return tunnel.l2tOutMemPaused || tunnel.l2tHop1Paused || tunnel.l2tHop2Paused;
    }
    if (senderServerId === tunnel.targetServerId) {
      return tunnel.t2lOutMemPaused || tunnel.t2lHop1Paused || tunnel.t2lHop2Paused;
    }
    return false;
  }

  private syncIngressSenderPressure(
    tunnelId: string,
    serverId: string,
    generation: number,
    patch: { memPaused?: boolean; hop1DbPaused?: boolean },
  ): void {
    const key = `${tunnelId}:${serverId}`;
    const entry = this.ingressPressure.get(key) ?? {
      tunnelId,
      serverId,
      generation,
      memPaused: false,
      hop1DbPaused: false,
      sentPaused: false,
    };
    entry.generation = generation;
    if (patch.memPaused !== undefined) entry.memPaused = patch.memPaused;
    if (patch.hop1DbPaused !== undefined) entry.hop1DbPaused = patch.hop1DbPaused;
    this.ingressPressure.set(key, entry);

    const localPaused = entry.memPaused || entry.hop1DbPaused;
    if (localPaused) {
      if (!entry.sentPaused) {
        entry.sentPaused = true;
        this.lookupBridge(serverId)?.trySendPortForward({
          type: PORT_FORWARD_MSG.RELAY_BACKPRESSURE,
          tunnelId,
          paused: true,
        }, generation);
      }
      return;
    }

    if (entry.sentPaused) {
      // If coordinator is on this pod, don't unpause while coordinator outbound/hop2 is paused.
      if (this.isCoordinatorPausedForSender(tunnelId, serverId)) return;
      entry.sentPaused = false;
      this.lookupBridge(serverId)?.trySendPortForward({
        type: PORT_FORWARD_MSG.RELAY_BACKPRESSURE,
        tunnelId,
        paused: false,
      }, generation);
    }
  }

  private async updateCoordinatorPressure(
    tunnel: ActiveServerTunnel,
    direction: PortForwardRelayDirection,
    patch: { outMemPaused?: boolean; hop1Paused?: boolean; hop2Paused?: boolean },
  ): Promise<void> {
    if (tunnel.status === 'closing' || tunnel.status === 'closed') return;
    if (direction === 'l2t') {
      if (patch.outMemPaused !== undefined) tunnel.l2tOutMemPaused = patch.outMemPaused;
      if (patch.hop1Paused !== undefined) tunnel.l2tHop1Paused = patch.hop1Paused;
      if (patch.hop2Paused !== undefined) tunnel.l2tHop2Paused = patch.hop2Paused;
    } else {
      if (patch.outMemPaused !== undefined) tunnel.t2lOutMemPaused = patch.outMemPaused;
      if (patch.hop1Paused !== undefined) tunnel.t2lHop1Paused = patch.hop1Paused;
      if (patch.hop2Paused !== undefined) tunnel.t2lHop2Paused = patch.hop2Paused;
    }

    const senderPodId = direction === 'l2t' ? tunnel.listenPodId : tunnel.targetPodId;
    const senderServerId = direction === 'l2t' ? tunnel.listenServerId : tunnel.targetServerId;
    const senderGeneration = direction === 'l2t' ? tunnel.listenGeneration : tunnel.targetGeneration;
    const ingressEntry = this.ingressPressure.get(`${tunnel.tunnelId}:${senderServerId}`);
    const localIngressPaused = senderPodId === this.podId
      && Boolean(ingressEntry?.memPaused || ingressEntry?.hop1DbPaused);
    const shouldPause = direction === 'l2t'
      ? (tunnel.l2tOutMemPaused || tunnel.l2tHop1Paused || tunnel.l2tHop2Paused || localIngressPaused)
      : (tunnel.t2lOutMemPaused || tunnel.t2lHop1Paused || tunnel.t2lHop2Paused || localIngressPaused);
    const bpKey = direction === 'l2t' ? 'l2tBackpressured' : 't2lBackpressured';
    if (shouldPause === tunnel[bpKey]) return;
    tunnel[bpKey] = shouldPause;

    if (senderPodId === this.podId && ingressEntry) {
      ingressEntry.sentPaused = shouldPause;
    }
    await this.sendToEndpoint(senderPodId, senderServerId, senderGeneration, {
      type: PORT_FORWARD_MSG.RELAY_BACKPRESSURE,
      tunnelId: tunnel.tunnelId,
      paused: shouldPause,
    });
  }

  private enqueueBounded(
    buckets: Map<string, BoundedQueueBucket>,
    key: string,
    opts: {
      byteSize: number;
      isRelayData: boolean;
      run: (signal: AbortSignal) => Promise<void>;
      onHighWater?: () => void;
      onLowWater?: () => void;
    },
  ): { ok: true } | { ok: false; overflow: true } {
    let bucket = buckets.get(key);
    if (!bucket || bucket.cancelled) {
      bucket = {
        items: [],
        queuedBytes: 0,
        draining: false,
        memHighWater: false,
        cancelled: false,
        abortController: new AbortController(),
      };
      buckets.set(key, bucket);
    }

    if (opts.isRelayData) {
      if (bucket.queuedBytes + opts.byteSize > PORT_FORWARD_LIMITS.CLUSTER_RELAY_HARD_CAP_BYTES) {
        // Reject overflow cleanly and purge queued relay data frames so memory never grows unboundedly.
        bucket.items = bucket.items.filter((it) => !it.isRelayData);
        bucket.queuedBytes = 0;
        return { ok: false, overflow: true };
      }
      bucket.queuedBytes += opts.byteSize;
      if (!bucket.memHighWater && bucket.queuedBytes >= PORT_FORWARD_LIMITS.CLUSTER_RELAY_HIGH_WATER_BYTES) {
        bucket.memHighWater = true;
        opts.onHighWater?.();
      }
    }

    bucket.items.push({
      byteSize: opts.byteSize,
      isRelayData: opts.isRelayData,
      run: opts.run,
    });

    if (!bucket.draining) {
      bucket.draining = true;
      void (async () => {
        try {
          while (!bucket.cancelled && bucket.items.length > 0) {
            const item = bucket.items.shift()!;
            if (bucket.cancelled || bucket.abortController.signal.aborted) break;
            try {
              await item.run(bucket.abortController.signal);
            } catch {
              // Item-level errors are handled inside each task.
            } finally {
              if (!bucket.cancelled && item.isRelayData) {
                bucket.queuedBytes = Math.max(0, bucket.queuedBytes - item.byteSize);
                if (bucket.memHighWater && bucket.queuedBytes <= PORT_FORWARD_LIMITS.CLUSTER_RELAY_LOW_WATER_BYTES) {
                  bucket.memHighWater = false;
                  opts.onLowWater?.();
                }
              }
            }
          }
        } finally {
          bucket.draining = false;
          if ((bucket.cancelled || (bucket.items.length === 0 && bucket.queuedBytes === 0 && !bucket.memHighWater))
            && buckets.get(key) === bucket) {
            buckets.delete(key);
          }
        }
      })();
    }

    return { ok: true };
  }

  private async closeTunnelForOverflow(
    tunnelId: string,
    reason: string,
    knownRecord?: PortForwardClusterTunnelRecord,
  ): Promise<void> {
    const localTunnel = this.tunnels.get(tunnelId);
    if (localTunnel) {
      await this.closeTunnelInternal(localTunnel, reason, true, true);
      return;
    }
    const record = knownRecord ?? (await this.clusterStore.getTunnel(tunnelId).catch(() => null));
    if (!record || record.status === 'closing' || record.status === 'closed') return;
    if (record.coordinatorPodId === this.podId) {
      const t = this.tunnels.get(tunnelId);
      if (t) await this.closeTunnelInternal(t, reason, true, true);
      return;
    }
    await this.clusterStore.sendToPod(record.coordinatorPodId, {
      kind: 'close_tunnel',
      tunnelId,
      reason,
    }).catch(() => {});
  }

  onDaemonConnected(serverId: string, generation: number): void {
    void this.clusterStore.registerEndpoint(this.podId, serverId, generation).catch(() => {});
  }

  onDaemonDisconnected(serverId: string, generation: number): void {
    void this.clusterStore.unregisterEndpoint(this.podId, serverId, generation).catch(() => {});
    const suffix = `:${serverId}:${this.podId}:${generation}`;
    for (const key of this.authorizedRemoteRoutes.keys()) {
      if (key.endsWith(suffix)) this.authorizedRemoteRoutes.delete(key);
    }
    this.cancelBucketsBySuffix(this.inboundQueues, suffix);
    this.cancelBucketsBySuffix(this.remoteDeliveryQueues, suffix);
    this.cancelQueueBucket(this.preAuthQueues, `${serverId}:${this.podId}:${generation}`);

    for (const tunnel of [...this.tunnels.values()]) {
      if (tunnel.status === 'closed') continue;
      const isListen = tunnel.listenServerId === serverId
        && tunnel.listenPodId === this.podId
        && tunnel.listenGeneration === generation;
      const isTarget = tunnel.targetServerId === serverId
        && tunnel.targetPodId === this.podId
        && tunnel.targetGeneration === generation;
      if (!isListen && !isTarget) continue;

      if (tunnel.resolveOpen) {
        this.failPendingTunnel(
          tunnel,
          503,
          PORT_FORWARD_ERRORS.NODE_OFFLINE,
          isListen ? 'listen node disconnected' : 'target node disconnected',
        );
      } else {
        void this.closeTunnelInternal(
          tunnel,
          isListen ? 'listen_node_disconnected' : 'target_node_disconnected',
          !isListen,
          !isTarget,
        );
      }
    }

    for (const closing of [...this.closingTunnels.values()]) {
      const isListen = closing.listenServerId === serverId
        && closing.listenPodId === this.podId
        && closing.listenGeneration === generation;
      const isTarget = closing.targetServerId === serverId
        && closing.targetPodId === this.podId
        && closing.targetGeneration === generation;
      if (isListen && (closing.listenCloseState === 'pending' || closing.listenCloseState === 'timed_out')) {
        closing.listenCloseState = 'offline';
        this.maybeSettleClose(closing);
      }
      if (isTarget && (closing.targetCloseState === 'pending' || closing.targetCloseState === 'timed_out')) {
        closing.targetCloseState = 'offline';
        this.maybeSettleClose(closing);
      }
    }

    if (this.hasSharedClusterStore) {
      void this.notifyRemoteCoordinatorsOfDisconnect(serverId, generation);
    }
  }

  private async notifyRemoteCoordinatorsOfDisconnect(serverId: string, generation: number): Promise<void> {
    try {
      const affected = await this.clusterStore.listOpenTunnelsForEndpoint(serverId, generation, this.podId);
      for (const record of affected) {
        if (record.coordinatorPodId === this.podId) continue;
        await this.clusterStore.sendToPod(record.coordinatorPodId, {
          kind: 'daemon_disconnected',
          tunnelId: record.tunnelId,
          serverId,
          podId: this.podId,
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
    if (remote.podId === this.podId) {
      return localBridge && localBridge.isDaemonConnected()
        ? { podId: this.podId, generation: localBridge.daemonConnectionGeneration() }
        : null;
    }
    return { podId: remote.podId, generation: remote.generation };
  }

  private async deliverToLiveBridgeWithRetry(
    serverId: string,
    expectedGeneration: number,
    frame: PortForwardWireMessage,
    abortSignal?: AbortSignal,
  ): Promise<'delivered' | PortForwardSendFailureReason> {
    const isRelayData = frame.type === PORT_FORWARD_MSG.RELAY_FRAME;
    const tombstoneKey = `${frame.tunnelId}:${serverId}:${this.podId}:${expectedGeneration}`;
    const isCancelled = () =>
      Boolean(abortSignal?.aborted) || (isRelayData && this.closedDeliveryTombstones.has(tombstoneKey));
    const retryDelays = isRelayData ? HOP2_DELIVERY_RETRY_DELAYS_MS : [];
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      if (isCancelled()) return 'cancelled';
      const bridge = this.lookupBridge(serverId);
      if (!bridge || !bridge.isDaemonConnected()) return 'offline';
      if (bridge.daemonConnectionGeneration() !== expectedGeneration) return 'generation_mismatch';
      if (isCancelled()) return 'cancelled';
      const ok = bridge.trySendPortForward(frame as unknown as Record<string, unknown>, expectedGeneration);
      if (ok) return 'delivered';
      if (isCancelled()) return 'cancelled';
      if (!bridge.isDaemonConnected()) return 'offline';
      if (bridge.daemonConnectionGeneration() !== expectedGeneration) return 'generation_mismatch';
      if (attempt < retryDelays.length) {
        const local = this.tunnels.get(frame.tunnelId) ?? this.closingTunnels.get(frame.tunnelId);
        if (local && (local.status === 'closing' || local.status === 'closed')) {
          return 'cancelled';
        }
        const continued = await delayMs(retryDelays[attempt]!, abortSignal);
        if (!continued || isCancelled()) return 'cancelled';
      }
    }
    return 'write_failed';
  }

  private async sendToEndpoint(
    podId: string,
    serverId: string,
    expectedGeneration: number,
    frame: PortForwardWireMessage,
    relayMeta?: { tunnelId: string; direction: PortForwardRelayDirection },
    expectedPodId?: string,
  ): Promise<{ sent: boolean; overflow: boolean; highWater: boolean; failureReason?: PortForwardSendFailureReason }> {
    if (podId === this.podId) {
      const outcome = await this.deliverToLiveBridgeWithRetry(serverId, expectedGeneration, frame);
      if (outcome === 'delivered') {
        return { sent: true, overflow: false, highWater: false };
      }
      return { sent: false, overflow: false, highWater: false, failureReason: outcome };
    }
    const maxAttempts = relayMeta ? CLUSTER_RELAY_RETRY_DELAYS_MS.length + 1 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (relayMeta) {
        const local = this.tunnels.get(relayMeta.tunnelId) ?? this.closingTunnels.get(relayMeta.tunnelId);
        if (local && (local.status === 'closing' || local.status === 'closed')) {
          return { sent: false, overflow: false, highWater: false, failureReason: 'write_failed' };
        }
      }
      try {
        const res = await this.clusterStore.enqueueBusMessage(podId, {
          kind: 'to_endpoint',
          serverId,
          expectedPodId: expectedPodId ?? podId,
          expectedGeneration,
          frame,
          ...(typeof (frame as { tunnelId?: unknown }).tunnelId === 'string'
            ? { tunnelId: (frame as { tunnelId: string }).tunnelId, coordinatorPodId: this.podId }
            : {}),
          ...(relayMeta ? {
            tunnelId: relayMeta.tunnelId,
            direction: relayMeta.direction,
            coordinatorPodId: this.podId,
          } : {}),
        });
        if (!res.ok) {
          return { sent: false, overflow: true, highWater: false, failureReason: 'overflow' };
        }
        return { sent: true, overflow: false, highWater: res.highWater };
      } catch {
        if (attempt + 1 < maxAttempts) {
          await delayMs(CLUSTER_RELAY_RETRY_DELAYS_MS[attempt]!);
          continue;
        }
        return { sent: false, overflow: false, highWater: false, failureReason: 'write_failed' };
      }
    }
    return { sent: false, overflow: false, highWater: false, failureReason: 'write_failed' };
  }

  private async handleBusMessage(msg: PortForwardClusterBusMessage): Promise<void> {
    switch (msg.kind) {
      case 'to_endpoint': {
        if (msg.expectedPodId && msg.expectedPodId !== this.podId) return;
        const deliveryKey = msg.tunnelId
          ? `${msg.tunnelId}:${msg.serverId}:${this.podId}:${msg.expectedGeneration}`
          : null;

        if (msg.frame.type === PORT_FORWARD_MSG.CLOSE) {
          if (deliveryKey) {
            this.markDeliveryTombstone(deliveryKey);
            this.cancelQueueBucket(this.remoteDeliveryQueues, deliveryKey);
          }
          const bridge = this.lookupBridge(msg.serverId);
          if (!bridge || !bridge.isDaemonConnected() || bridge.daemonConnectionGeneration() !== msg.expectedGeneration) {
            if (msg.tunnelId && msg.coordinatorPodId) {
              await this.clusterStore.sendToPod(msg.coordinatorPodId, {
                kind: 'daemon_disconnected',
                tunnelId: msg.tunnelId,
                serverId: msg.serverId,
                podId: this.podId,
                generation: msg.expectedGeneration,
              }).catch(() => {});
            }
            return;
          }
          const ok = bridge.trySendPortForward(msg.frame as unknown as Record<string, unknown>, msg.expectedGeneration);
          if (!ok) {
            const stillMatchingLive = bridge.isDaemonConnected()
              && bridge.daemonConnectionGeneration() === msg.expectedGeneration;
            if (!stillMatchingLive && msg.tunnelId && msg.coordinatorPodId) {
              await this.clusterStore.sendToPod(msg.coordinatorPodId, {
                kind: 'daemon_disconnected',
                tunnelId: msg.tunnelId,
                serverId: msg.serverId,
                podId: this.podId,
                generation: msg.expectedGeneration,
              }).catch(() => {});
            } else if (stillMatchingLive && msg.tunnelId && msg.coordinatorPodId) {
              await this.clusterStore.sendToPod(msg.coordinatorPodId, {
                kind: 'close_delivery_failed',
                tunnelId: msg.tunnelId,
                serverId: msg.serverId,
                podId: this.podId,
                generation: msg.expectedGeneration,
              }).catch(() => {});
            }
          }
          return;
        }

        if (msg.frame.type === PORT_FORWARD_MSG.RELAY_FRAME && deliveryKey) {
          if (this.closedDeliveryTombstones.has(deliveryKey)) return;
          const byteSize = Buffer.byteLength(msg.frame.data, 'utf8');
          const relayFrame = msg.frame;
          const reportRelayDeliveryFailure = async (reason: string) => {
            this.markDeliveryTombstone(deliveryKey);
            this.cancelQueueBucket(this.remoteDeliveryQueues, deliveryKey);
            const bridge = this.lookupBridge(msg.serverId);
            if (bridge && bridge.isDaemonConnected() && bridge.daemonConnectionGeneration() === msg.expectedGeneration) {
              const roleGuess = msg.direction === 'l2t' ? PORT_FORWARD_ROLE.TARGET : PORT_FORWARD_ROLE.LISTEN;
              bridge.trySendPortForward({
                type: PORT_FORWARD_MSG.CLOSE,
                tunnelId: relayFrame.tunnelId,
                reason,
                role: roleGuess,
              }, msg.expectedGeneration);
            }
            if (msg.coordinatorPodId) {
              await this.clusterStore.sendToPod(msg.coordinatorPodId, {
                kind: 'close_tunnel',
                tunnelId: relayFrame.tunnelId,
                reason,
              }).catch(() => {});
            } else {
              await this.closeTunnelForOverflow(relayFrame.tunnelId, reason).catch(() => {});
            }
          };
          const enqueued = this.enqueueBounded(this.remoteDeliveryQueues, deliveryKey, {
            byteSize,
            isRelayData: true,
            run: async (signal) => {
              if (signal.aborted || this.closedDeliveryTombstones.has(deliveryKey)) return;
              const outcome = await this.deliverToLiveBridgeWithRetry(
                msg.serverId,
                msg.expectedGeneration,
                relayFrame,
                signal,
              );
              if (outcome === 'delivered' || outcome === 'cancelled') return;
              if (outcome === 'offline' || outcome === 'generation_mismatch') {
                this.markDeliveryTombstone(deliveryKey);
                this.cancelQueueBucket(this.remoteDeliveryQueues, deliveryKey);
                this.onDaemonDisconnected(msg.serverId, msg.expectedGeneration);
                if (msg.coordinatorPodId) {
                  await this.clusterStore.sendToPod(msg.coordinatorPodId, {
                    kind: 'daemon_disconnected',
                    tunnelId: relayFrame.tunnelId,
                    serverId: msg.serverId,
                    podId: this.podId,
                    generation: msg.expectedGeneration,
                  }).catch(() => {});
                }
                return;
              }
              await reportRelayDeliveryFailure('relay_delivery_failed');
            },
          });
          if (!enqueued.ok) {
            await reportRelayDeliveryFailure('relay_delivery_overflow');
          }
          return;
        }

        const bridge = this.lookupBridge(msg.serverId);
        if (!bridge || !bridge.isDaemonConnected() || bridge.daemonConnectionGeneration() !== msg.expectedGeneration) {
          this.onDaemonDisconnected(msg.serverId, msg.expectedGeneration);
          return;
        }
        const ok = bridge.trySendPortForward(msg.frame as unknown as Record<string, unknown>, msg.expectedGeneration);
        if (!ok) {
          const stillMatchingLive = bridge.isDaemonConnected()
            && bridge.daemonConnectionGeneration() === msg.expectedGeneration;
          if (!stillMatchingLive) {
            this.onDaemonDisconnected(msg.serverId, msg.expectedGeneration);
          }
        }
        return;
      }

      case 'to_coordinator': {
        const active = this.tunnels.get(msg.tunnelId) ?? this.closingTunnels.get(msg.tunnelId);
        if (!active) return;
        this.processCoordinatorMessage(active, msg.fromServerId, msg.fromPodId, msg.fromGeneration, msg.frame);
        return;
      }

      case 'relay_drained': {
        const tunnel = this.tunnels.get(msg.tunnelId);
        if (msg.hop === 'to_coordinator') {
          if (tunnel && tunnel.status === 'active' && tunnel.transportMode === 'relay') {
            const senderPodId = msg.direction === 'l2t' ? tunnel.listenPodId : tunnel.targetPodId;
            const senderServerId = msg.direction === 'l2t' ? tunnel.listenServerId : tunnel.targetServerId;
            const senderGeneration = msg.direction === 'l2t' ? tunnel.listenGeneration : tunnel.targetGeneration;
            await this.updateCoordinatorPressure(tunnel, msg.direction, { hop1Paused: false });
            const stillPausedOnCoordinator = msg.direction === 'l2t'
              ? (tunnel.l2tOutMemPaused || tunnel.l2tHop2Paused)
              : (tunnel.t2lOutMemPaused || tunnel.t2lHop2Paused);
            if (!stillPausedOnCoordinator) {
              if (senderPodId !== this.podId) {
                await this.clusterStore.sendToPod(senderPodId, {
                  kind: 'relay_drained',
                  tunnelId: msg.tunnelId,
                  direction: msg.direction,
                  hop: 'to_coordinator',
                  queuedBytes: msg.queuedBytes,
                });
              } else {
                this.syncIngressSenderPressure(msg.tunnelId, senderServerId, senderGeneration, { hop1DbPaused: false });
              }
            }
          } else {
            // Non-coordinator ingress pod received clearance from coordinator.
            for (const entry of this.ingressPressure.values()) {
              if (entry.tunnelId === msg.tunnelId && entry.hop1DbPaused) {
                this.syncIngressSenderPressure(entry.tunnelId, entry.serverId, entry.generation, { hop1DbPaused: false });
              }
            }
          }
          return;
        }

        if (!tunnel || tunnel.status !== 'active' || tunnel.transportMode !== 'relay') return;
        await this.updateCoordinatorPressure(tunnel, msg.direction, { hop2Paused: false });
        const senderServerId = msg.direction === 'l2t' ? tunnel.listenServerId : tunnel.targetServerId;
        const senderPodId = msg.direction === 'l2t' ? tunnel.listenPodId : tunnel.targetPodId;
        const senderGeneration = msg.direction === 'l2t' ? tunnel.listenGeneration : tunnel.targetGeneration;
        const stillPausedAfterHop2 = msg.direction === 'l2t'
          ? (tunnel.l2tOutMemPaused || tunnel.l2tHop1Paused)
          : (tunnel.t2lOutMemPaused || tunnel.t2lHop1Paused);
        if (!stillPausedAfterHop2) {
          if (senderPodId !== this.podId) {
            await this.clusterStore.sendToPod(senderPodId, {
              kind: 'relay_drained',
              tunnelId: msg.tunnelId,
              direction: msg.direction,
              hop: 'to_coordinator',
              queuedBytes: msg.queuedBytes,
            });
          } else {
            this.syncIngressSenderPressure(msg.tunnelId, senderServerId, senderGeneration, { hop1DbPaused: false });
          }
        }
        return;
      }

      case 'close_delivery_failed': {
        const closing = this.closingTunnels.get(msg.tunnelId) ?? this.tunnels.get(msg.tunnelId);
        if (closing && closing.status === 'closing') {
          const isListen = closing.listenServerId === msg.serverId
            && closing.listenPodId === msg.podId
            && closing.listenGeneration === msg.generation;
          const isTarget = closing.targetServerId === msg.serverId
            && closing.targetPodId === msg.podId
            && closing.targetGeneration === msg.generation;
          if (isListen && closing.listenCloseState === 'pending') {
            closing.listenCloseState = 'timed_out';
            this.maybeSettleClose(closing);
          }
          if (isTarget && closing.targetCloseState === 'pending') {
            closing.targetCloseState = 'timed_out';
            this.maybeSettleClose(closing);
          }
        }
        return;
      }

      case 'daemon_disconnected': {
        const active = this.tunnels.get(msg.tunnelId);
        if (active && active.status !== 'closing' && active.status !== 'closed') {
          const isListen = active.listenServerId === msg.serverId
            && active.listenPodId === msg.podId
            && active.listenGeneration === msg.generation;
          const isTarget = active.targetServerId === msg.serverId
            && active.targetPodId === msg.podId
            && active.targetGeneration === msg.generation;
          if (!isListen && !isTarget) return;
          if (active.resolveOpen) {
            this.failPendingTunnel(
              active,
              503,
              PORT_FORWARD_ERRORS.NODE_OFFLINE,
              isListen ? 'listen node disconnected' : 'target node disconnected',
            );
          } else {
            void this.closeTunnelInternal(
              active,
              isListen ? 'listen_node_disconnected' : 'target_node_disconnected',
              !isListen,
              !isTarget,
            );
          }
          return;
        }
        const closing = this.closingTunnels.get(msg.tunnelId);
        if (closing) {
          const isListen = closing.listenServerId === msg.serverId
            && closing.listenPodId === msg.podId
            && closing.listenGeneration === msg.generation;
          const isTarget = closing.targetServerId === msg.serverId
            && closing.targetPodId === msg.podId
            && closing.targetGeneration === msg.generation;
          if (isListen && (closing.listenCloseState === 'pending' || closing.listenCloseState === 'timed_out')) {
            closing.listenCloseState = 'offline';
            this.maybeSettleClose(closing);
          }
          if (isTarget && (closing.targetCloseState === 'pending' || closing.targetCloseState === 'timed_out')) {
            closing.targetCloseState = 'offline';
            this.maybeSettleClose(closing);
          }
        }
        return;
      }

      case 'close_tunnel': {
        const local = this.tunnels.get(msg.tunnelId) ?? this.closingTunnels.get(msg.tunnelId);
        const sendAck = (ok: boolean, outcome: PortForwardRemoteCloseAckOutcome) => {
          if (msg.requestId && msg.replyPodId) {
            void this.clusterStore.sendToPod(msg.replyPodId, {
              kind: 'close_tunnel_ack',
              requestId: msg.requestId,
              tunnelId: msg.tunnelId,
              ok,
              outcome,
            }).catch(() => {});
          }
        };
        if (local) {
          // Do NOT await inside drainPod: CLOSE_ACK arrives through the same pod bus queue!
          void this.failPendingOrCloseTunnel(
            local,
            409,
            PORT_FORWARD_ERRORS.TUNNEL_NOT_FOUND,
            msg.reason,
          ).then(
            (res) => sendAck(res.confirmed, res.confirmed ? 'confirmed' : 'timed_out'),
            () => sendAck(false, 'timed_out'),
          );
        } else {
          const adopting = this.inFlightAdoptions.get(msg.tunnelId);
          if (adopting) {
            void adopting.then(
              (res) => sendAck(res.confirmed, res.confirmed ? 'confirmed' : 'timed_out'),
              () => sendAck(false, 'timed_out'),
            );
            return;
          }
          void (async () => {
            let record: PortForwardClusterTunnelRecord | null;
            try {
              record = await this.clusterStore.getTunnel(msg.tunnelId);
            } catch {
              sendAck(false, 'error');
              return;
            }
            if (!record) {
              sendAck(false, 'error');
              return;
            }
            if (record.status === 'closed') {
              sendAck(true, 'confirmed');
              return;
            }
            sendAck(false, 'missing');
          })();
        }
        return;
      }

      case 'close_tunnel_ack': {
        const resolve = this.pendingRemoteCloses.get(msg.requestId);
        if (resolve) {
          this.pendingRemoteCloses.delete(msg.requestId);
          resolve({ ok: msg.ok, outcome: msg.outcome });
        }
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
        listenIdentityPublicKey: null,
        listenIdentitySignature: null,
        targetReady: false,
        targetCandidates: [],
        targetPublicKey: null,
        targetKeyProof: null,
        targetIdentityPublicKey: null,
        targetIdentitySignature: null,
        connectDispatchedToListen: false,
        l2tBackpressured: false,
        t2lBackpressured: false,
        l2tOutMemPaused: false,
        l2tHop1Paused: false,
        l2tHop2Paused: false,
        t2lOutMemPaused: false,
        t2lHop1Paused: false,
        t2lHop2Paused: false,
        activeConnections: 0,
        bytesSent: 0,
        bytesReceived: 0,
        createdAt,
        expiresAt,
        prepareTimer: null,
        establishTimer: null,
        ttlTimer: null,
        closeAckTimer: null,
        listenCloseState: 'pending',
        targetCloseState: 'pending',
        closeSettled: false,
        closePromise: null,
        resolveClose: null,
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
        if (!sentListen.sent || !sentTarget.sent) {
          this.failPendingTunnel(
            tunnel,
            503,
            PORT_FORWARD_ERRORS.NODE_OFFLINE,
            !sentListen.sent
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

  private async sendRemoteCloseAndAwaitAck(
    record: PortForwardClusterTunnelRecord,
    reason: string,
  ): Promise<{ ok: boolean; outcome: PortForwardRemoteCloseAckOutcome }> {
    const requestId = randomBytes(8).toString('hex');
    const ackPromise = new Promise<{ ok: boolean; outcome: PortForwardRemoteCloseAckOutcome }>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingRemoteCloses.delete(requestId)) {
          resolve({ ok: false, outcome: 'missing' });
        }
      }, this.closeAckTimeoutMs + 500);
      timer.unref?.();
      this.pendingRemoteCloses.set(requestId, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
    });

    try {
      await this.clusterStore.sendToPod(record.coordinatorPodId, {
        kind: 'close_tunnel',
        requestId,
        replyPodId: this.podId,
        tunnelId: record.tunnelId,
        reason,
      });
    } catch {
      this.pendingRemoteCloses.delete(requestId);
      return { ok: false, outcome: 'error' };
    }

    return ackPromise;
  }

  private async followRemoteCoordinatorClose(
    record: PortForwardClusterTunnelRecord,
    reason: string,
  ): Promise<{ confirmed: boolean; tunnelId: string }> {
    // Bounded single-shot follow: never re-enter closeTunnelRecordAndAwait or inFlightAdoptions on timeout/missing.
    const ack = await this.sendRemoteCloseAndAwaitAck(record, reason);
    return { confirmed: ack.ok, tunnelId: record.tunnelId };
  }

  private async closeTunnelRecordAndAwait(
    record: PortForwardClusterTunnelRecord,
    reason: string,
  ): Promise<{ confirmed: boolean; tunnelId: string }> {
    const localTunnel = this.tunnels.get(record.tunnelId) ?? this.closingTunnels.get(record.tunnelId);
    if (localTunnel) {
      const settled = await this.failPendingOrCloseTunnel(
        localTunnel,
        409,
        PORT_FORWARD_ERRORS.TUNNEL_NOT_FOUND,
        reason,
      );
      return { confirmed: settled.confirmed, tunnelId: record.tunnelId };
    }

    if (record.coordinatorPodId !== this.podId) {
      const ack = await this.sendRemoteCloseAndAwaitAck(record, reason);
      if (ack.ok) {
        return { confirmed: true, tunnelId: record.tunnelId };
      }
      if (ack.outcome !== 'missing') {
        return { confirmed: false, tunnelId: record.tunnelId };
      }
    }

    const existingAdoption = this.inFlightAdoptions.get(record.tunnelId);
    if (existingAdoption) {
      return existingAdoption;
    }

    const runAdoption = async (): Promise<{ confirmed: boolean; tunnelId: string }> => {
      // Coordinator is absent or dead: atomically adopt ownership via CAS against (coordinatorPodId, updatedAt).
      // Any read/write failure or lost race NEVER assumes offline or builds a duplicate closing instance!
      let fresh: PortForwardClusterTunnelRecord | null;
      try {
        fresh = await this.clusterStore.getTunnel(record.tunnelId);
      } catch {
        return { confirmed: false, tunnelId: record.tunnelId };
      }
      if (!fresh) {
        return { confirmed: false, tunnelId: record.tunnelId };
      }
      if (fresh.status === 'closed') {
        return { confirmed: true, tunnelId: record.tunnelId };
      }
      if (fresh.coordinatorPodId !== record.coordinatorPodId && fresh.coordinatorPodId !== this.podId) {
        return this.followRemoteCoordinatorClose(fresh, reason);
      }
      if (!fresh.listenPodId || !fresh.targetPodId) {
        await this.clusterStore.updateTunnel(fresh.tunnelId, { status: 'closing' }).catch(() => {});
        return { confirmed: false, tunnelId: fresh.tunnelId };
      }

      let adoptRes;
      try {
        adoptRes = await this.clusterStore.tryAdoptCoordinator(
          fresh.tunnelId,
          fresh.coordinatorPodId,
          fresh.updatedAt,
          this.podId,
        );
      } catch {
        return { confirmed: false, tunnelId: fresh.tunnelId };
      }

      if (adoptRes.outcome === 'already_closed') {
        return { confirmed: true, tunnelId: fresh.tunnelId };
      }
      if (adoptRes.outcome === 'not_found') {
        return { confirmed: false, tunnelId: fresh.tunnelId };
      }
      if (adoptRes.outcome === 'lost_race') {
        const winner = adoptRes.record;
        if (winner.coordinatorPodId === this.podId) {
          const localWinner = this.tunnels.get(winner.tunnelId) ?? this.closingTunnels.get(winner.tunnelId);
          if (localWinner) {
            const settled = await this.failPendingOrCloseTunnel(
              localWinner,
              409,
              PORT_FORWARD_ERRORS.TUNNEL_NOT_FOUND,
              reason,
            );
            return { confirmed: settled.confirmed, tunnelId: winner.tunnelId };
          }
          return { confirmed: false, tunnelId: winner.tunnelId };
        }
        return this.followRemoteCoordinatorClose(winner, reason);
      }

      const adoptedRecord = adoptRes.record;
      const existingLocal = this.tunnels.get(adoptedRecord.tunnelId) ?? this.closingTunnels.get(adoptedRecord.tunnelId);
      if (existingLocal) {
        const settled = await this.failPendingOrCloseTunnel(
          existingLocal,
          409,
          PORT_FORWARD_ERRORS.TUNNEL_NOT_FOUND,
          reason,
        );
        return { confirmed: settled.confirmed, tunnelId: adoptedRecord.tunnelId };
      }

      const adopted: ActiveServerTunnel = {
        tunnelId: adoptedRecord.tunnelId,
        userId: adoptedRecord.userId,
        listenNode: adoptedRecord.listenNode,
        listenServerId: adoptedRecord.listenServerId,
        ...(adoptedRecord.listenNodeId ? { listenNodeId: adoptedRecord.listenNodeId } : {}),
        listenPodId: adoptedRecord.listenPodId,
        listenGeneration: adoptedRecord.listenGeneration,
        requestedListenPort: adoptedRecord.requestedListenPort,
        boundListenPort: adoptedRecord.boundListenPort,
        targetNode: adoptedRecord.targetNode,
        targetServerId: adoptedRecord.targetServerId,
        ...(adoptedRecord.targetNodeId ? { targetNodeId: adoptedRecord.targetNodeId } : {}),
        targetPodId: adoptedRecord.targetPodId,
        targetGeneration: adoptedRecord.targetGeneration,
        targetHost: adoptedRecord.targetHost,
        targetPort: adoptedRecord.targetPort,
        transportPref: adoptedRecord.transportPref,
        transportMode: adoptedRecord.transportMode,
        listenEstablishedMode: adoptedRecord.transportMode,
        targetEstablishedMode: adoptedRecord.transportMode,
        ...(adoptedRecord.label ? { label: adoptedRecord.label } : {}),
        status: 'active',
        listenReady: true,
        listenCandidates: [],
        listenPublicKey: null,
        listenKeyProof: null,
        listenIdentityPublicKey: null,
        listenIdentitySignature: null,
        targetReady: true,
        targetCandidates: [],
        targetPublicKey: null,
        targetKeyProof: null,
        targetIdentityPublicKey: null,
        targetIdentitySignature: null,
        connectDispatchedToListen: true,
        l2tBackpressured: false,
        t2lBackpressured: false,
        l2tOutMemPaused: false,
        l2tHop1Paused: false,
        l2tHop2Paused: false,
        t2lOutMemPaused: false,
        t2lHop1Paused: false,
        t2lHop2Paused: false,
        activeConnections: adoptedRecord.activeConnections,
        bytesSent: adoptedRecord.bytesSent,
        bytesReceived: adoptedRecord.bytesReceived,
        createdAt: adoptedRecord.createdAt,
        expiresAt: adoptedRecord.expiresAt,
        prepareTimer: null,
        establishTimer: null,
        ttlTimer: null,
        closeAckTimer: null,
        listenCloseState: 'pending',
        targetCloseState: 'pending',
        closeSettled: false,
        closePromise: null,
        resolveClose: null,
        resolveOpen: null,
      };
      const settled = await this.closeTunnelInternal(adopted, reason, true, true);
      return { confirmed: settled.confirmed, tunnelId: adoptedRecord.tunnelId };
    };

    const adoptionPromise = runAdoption().finally(() => {
      if (this.inFlightAdoptions.get(record.tunnelId) === adoptionPromise) {
        this.inFlightAdoptions.delete(record.tunnelId);
      }
    });
    this.inFlightAdoptions.set(record.tunnelId, adoptionPromise);
    return adoptionPromise;
  }

  async closeTunnelForUser(
    userId: string,
    tunnelId: string,
    reason = 'closed_by_user',
  ): Promise<
    | { ok: true; closedTunnelIds: string[] }
    | {
        ok: false;
        status: number;
        reason: PortForwardErrorCode;
        error: string;
        closedTunnelIds?: string[];
        unconfirmedTunnelIds?: string[];
      }
  > {
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
    const res = await this.closeTunnelRecordAndAwait(record, reason);
    if (!res.confirmed) {
      return {
        ok: false,
        status: 504,
        reason: PORT_FORWARD_ERRORS.TIMEOUT,
        error: `close confirmation timed out for tunnel "${tunnelId}" before endpoint socket release`,
        closedTunnelIds: [],
        unconfirmedTunnelIds: [tunnelId],
      };
    }
    return { ok: true, closedTunnelIds: [tunnelId] };
  }

  async closeAllForUser(
    userId: string,
    nodeServerId?: string,
    reason = 'closed_by_user',
  ): Promise<{ confirmed: boolean; closedTunnelIds: string[]; unconfirmedTunnelIds: string[] }> {
    const openTunnels = await this.clusterStore.listOpenTunnelsForUser(userId, nodeServerId);
    const results = await Promise.all(openTunnels.map((record) => this.closeTunnelRecordAndAwait(record, reason)));
    const closedTunnelIds = results.filter((r) => r.confirmed).map((r) => r.tunnelId);
    const unconfirmedTunnelIds = results.filter((r) => !r.confirmed).map((r) => r.tunnelId);
    return {
      confirmed: unconfirmedTunnelIds.length === 0,
      closedTunnelIds,
      unconfirmedTunnelIds,
    };
  }

  handleDaemonMessage(fromServerId: string, fromGeneration: number, raw: unknown): boolean {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const type = (raw as { type?: unknown }).type;
    if (!isPortForwardMessageType(type)) return false;

    const parsed = validatePortForwardWireMessage(raw);
    if (!parsed.ok) return true;
    const msg = parsed.value;

    const isRelayData = msg.type === PORT_FORWARD_MSG.RELAY_FRAME;
    const byteSize = isRelayData ? Buffer.byteLength(msg.data, 'utf8') : 0;
    const localTunnel = this.tunnels.get(msg.tunnelId) ?? this.closingTunnels.get(msg.tunnelId);

    // Gate local coordinator admission SYNCHRONOUSLY before touching any tunnel-scoped queue, pressure, or overflow close!
    if (localTunnel) {
      const memberRole = resolveEndpointMemberRole(localTunnel, fromServerId, this.podId, fromGeneration);
      if (!memberRole || !isMessageAdmissibleForStatus(localTunnel, msg.type, false)) {
        return true;
      }
      if (msg.type === PORT_FORWARD_MSG.CLOSE_ACK) {
        this.processCoordinatorMessage(localTunnel, fromServerId, this.podId, fromGeneration, msg);
        return true;
      }
      const key = `${msg.tunnelId}:${fromServerId}:${this.podId}:${fromGeneration}`;
      const enqueued = this.enqueueBounded(this.inboundQueues, key, {
        byteSize,
        isRelayData,
        onHighWater: () => {
          this.syncIngressSenderPressure(msg.tunnelId, fromServerId, fromGeneration, { memPaused: true });
        },
        onLowWater: () => {
          this.syncIngressSenderPressure(msg.tunnelId, fromServerId, fromGeneration, { memPaused: false });
        },
        run: async () => {
          const current = this.tunnels.get(msg.tunnelId) ?? this.closingTunnels.get(msg.tunnelId);
          if (!current) return;
          this.processCoordinatorMessage(current, fromServerId, this.podId, fromGeneration, msg);
        },
      });
      if (!enqueued.ok) {
        this.syncIngressSenderPressure(msg.tunnelId, fromServerId, fromGeneration, { memPaused: true });
        void this.closeTunnelInternal(localTunnel, 'ingress_queue_overflow', true, true);
      }
      return true;
    }

    if (!this.hasSharedClusterStore) return true;

    const routeKey = `${msg.tunnelId}:${fromServerId}:${this.podId}:${fromGeneration}`;
    const connKey = `${fromServerId}:${this.podId}:${fromGeneration}`;
    const cachedRecord = this.authorizedRemoteRoutes.get(routeKey);
    const pendingPreAuth = this.preAuthQueues.get(connKey);

    if (cachedRecord && (!pendingPreAuth || pendingPreAuth.items.length === 0)) {
      if (!resolveEndpointMemberRole(cachedRecord, fromServerId, this.podId, fromGeneration)
        || !isMessageAdmissibleForStatus(cachedRecord, msg.type, true)) {
        return true;
      }
      const enqueued = this.enqueueBounded(this.inboundQueues, routeKey, {
        byteSize,
        isRelayData,
        onHighWater: () => {
          this.syncIngressSenderPressure(msg.tunnelId, fromServerId, fromGeneration, { memPaused: true });
        },
        onLowWater: () => {
          this.syncIngressSenderPressure(msg.tunnelId, fromServerId, fromGeneration, { memPaused: false });
        },
        run: async () => {
          await this.forwardVerifiedMessageToCoordinator(fromServerId, fromGeneration, msg, cachedRecord);
        },
      });
      if (!enqueued.ok) {
        this.syncIngressSenderPressure(msg.tunnelId, fromServerId, fromGeneration, { memPaused: true });
        void this.abortVerifiedTunnelOnStorageFailure(cachedRecord, fromServerId, fromGeneration, 'ingress_queue_overflow');
      }
      return true;
    }

    // Unverified remote endpoint or ordered behind an in-flight verification on this exact connection:
    // NEVER key queues by tunnelId, NEVER signal backpressure on tunnelId, and NEVER close unverified tunnelIds.
    const preAuth = this.enqueueBounded(this.preAuthQueues, connKey, {
      byteSize,
      isRelayData,
      run: async () => {
        const localNow = this.tunnels.get(msg.tunnelId) ?? this.closingTunnels.get(msg.tunnelId);
        if (localNow) {
          if (!resolveEndpointMemberRole(localNow, fromServerId, this.podId, fromGeneration)
            || !isMessageAdmissibleForStatus(localNow, msg.type, false)) {
            return;
          }
          this.processCoordinatorMessage(localNow, fromServerId, this.podId, fromGeneration, msg);
          return;
        }
        const existingCached = this.authorizedRemoteRoutes.get(routeKey);
        const record = await this.lookupTunnelForIngress(msg.tunnelId, isRelayData, existingCached);
        if (!record) return;
        const memberRole = resolveEndpointMemberRole(record, fromServerId, this.podId, fromGeneration);
        if (!memberRole) return;
        if (!isMessageAdmissibleForStatus(record, msg.type, true)) {
          if (record.status === 'closed' || record.status === 'closing') {
            this.authorizedRemoteRoutes.delete(routeKey);
          }
          return;
        }
        this.authorizedRemoteRoutes.set(routeKey, record);
        await this.dispatchVerifiedRemoteToCoordinator(record, fromServerId, fromGeneration, msg);
      },
    });
    if (!preAuth.ok && cachedRecord) {
      void this.abortVerifiedTunnelOnStorageFailure(cachedRecord, fromServerId, fromGeneration, 'ingress_queue_overflow');
    }
    return true;
  }

  private async lookupTunnelForIngress(
    tunnelId: string,
    isRelayData: boolean,
    knownRecord?: PortForwardClusterTunnelRecord,
  ): Promise<PortForwardClusterTunnelRecord | null> {
    const maxAttempts = isRelayData && knownRecord ? CLUSTER_RELAY_RETRY_DELAYS_MS.length + 1 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.clusterStore.getTunnel(tunnelId);
      } catch {
        if (attempt + 1 < maxAttempts) {
          await delayMs(CLUSTER_RELAY_RETRY_DELAYS_MS[attempt]!);
          continue;
        }
        if (knownRecord) {
          await this.abortVerifiedTunnelOnStorageFailure(
            knownRecord,
            knownRecord.listenServerId,
            knownRecord.listenGeneration,
            'cluster_store_error',
          );
        }
        return null;
      }
    }
    return null;
  }

  private async abortVerifiedTunnelOnStorageFailure(
    record: PortForwardClusterTunnelRecord,
    fromServerId: string,
    fromGeneration: number,
    reason: string,
  ): Promise<void> {
    const routeKey = `${record.tunnelId}:${fromServerId}:${this.podId}:${fromGeneration}`;
    this.authorizedRemoteRoutes.delete(routeKey);
    const role = resolveEndpointMemberRole(record, fromServerId, this.podId, fromGeneration);
    if (role) {
      const bridge = this.lookupBridge(fromServerId);
      if (bridge && bridge.isDaemonConnected() && bridge.daemonConnectionGeneration() === fromGeneration) {
        bridge.trySendPortForward({
          type: PORT_FORWARD_MSG.CLOSE,
          tunnelId: record.tunnelId,
          reason,
          role,
        }, fromGeneration);
      }
    }
    await this.closeTunnelForOverflow(record.tunnelId, reason, record);
  }

  private async forwardVerifiedMessageToCoordinator(
    fromServerId: string,
    fromGeneration: number,
    msg: PortForwardWireMessage,
    knownRecord: PortForwardClusterTunnelRecord,
  ): Promise<void> {
    const routeKey = `${msg.tunnelId}:${fromServerId}:${this.podId}:${fromGeneration}`;
    const isRelayData = msg.type === PORT_FORWARD_MSG.RELAY_FRAME;
    let record: PortForwardClusterTunnelRecord | null = null;
    const maxLookupAttempts = isRelayData ? CLUSTER_RELAY_RETRY_DELAYS_MS.length + 1 : 1;
    for (let attempt = 0; attempt < maxLookupAttempts; attempt++) {
      try {
        record = await this.clusterStore.getTunnel(msg.tunnelId);
        break;
      } catch {
        if (attempt + 1 < maxLookupAttempts) {
          await delayMs(CLUSTER_RELAY_RETRY_DELAYS_MS[attempt]!);
          continue;
        }
        await this.abortVerifiedTunnelOnStorageFailure(knownRecord, fromServerId, fromGeneration, 'cluster_store_error');
        return;
      }
    }
    if (!record) {
      this.authorizedRemoteRoutes.delete(routeKey);
      return;
    }
    const role = resolveEndpointMemberRole(record, fromServerId, this.podId, fromGeneration);
    if (!role) return;
    if (!isMessageAdmissibleForStatus(record, msg.type, true)) {
      if (record.status === 'closed' || record.status === 'closing') {
        this.authorizedRemoteRoutes.delete(routeKey);
      }
      return;
    }
    this.authorizedRemoteRoutes.set(routeKey, record);
    await this.dispatchVerifiedRemoteToCoordinator(record, fromServerId, fromGeneration, msg);
  }

  private async dispatchVerifiedRemoteToCoordinator(
    record: PortForwardClusterTunnelRecord,
    fromServerId: string,
    fromGeneration: number,
    msg: PortForwardWireMessage,
  ): Promise<void> {
    if (record.coordinatorPodId === this.podId) {
      const localTunnel = this.tunnels.get(msg.tunnelId) ?? this.closingTunnels.get(msg.tunnelId);
      if (localTunnel) {
        this.processCoordinatorMessage(localTunnel, fromServerId, this.podId, fromGeneration, msg);
      }
      return;
    }

    const isRelayData = msg.type === PORT_FORWARD_MSG.RELAY_FRAME;
    const direction: PortForwardRelayDirection | undefined =
      isRelayData
        ? (fromServerId === record.listenServerId ? 'l2t' : 't2l')
        : undefined;
    const maxAttempts = isRelayData ? CLUSTER_RELAY_RETRY_DELAYS_MS.length + 1 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const enqueued = await this.clusterStore.enqueueBusMessage(record.coordinatorPodId, {
          kind: 'to_coordinator',
          tunnelId: msg.tunnelId,
          fromServerId,
          fromPodId: this.podId,
          fromGeneration,
          frame: msg,
          ...(direction ? { direction } : {}),
        });
        if (!enqueued.ok) {
          this.syncIngressSenderPressure(msg.tunnelId, fromServerId, fromGeneration, { hop1DbPaused: true });
          await this.abortVerifiedTunnelOnStorageFailure(record, fromServerId, fromGeneration, 'cluster_queue_overflow');
          return;
        }
        if (enqueued.highWater) {
          this.syncIngressSenderPressure(msg.tunnelId, fromServerId, fromGeneration, { hop1DbPaused: true });
        }
        return;
      } catch {
        if (attempt + 1 < maxAttempts) {
          await delayMs(CLUSTER_RELAY_RETRY_DELAYS_MS[attempt]!);
          const fresh = await this.clusterStore.getTunnel(msg.tunnelId).catch(() => null);
          if (fresh && (fresh.status === 'closing' || fresh.status === 'closed')) {
            return;
          }
          continue;
        }
        if (isRelayData) {
          await this.abortVerifiedTunnelOnStorageFailure(record, fromServerId, fromGeneration, 'cluster_queue_error');
        }
        return;
      }
    }
  }

  private processCoordinatorMessage(
    tunnel: ActiveServerTunnel,
    fromServerId: string,
    fromPodId: string,
    fromGeneration: number,
    msg: PortForwardWireMessage,
  ): void {
    const senderRole = resolveEndpointMemberRole(tunnel, fromServerId, fromPodId, fromGeneration);
    if (!senderRole) return;

    if (msg.type === PORT_FORWARD_MSG.CLOSE_ACK) {
      if (msg.role !== senderRole) return;
      if (senderRole === PORT_FORWARD_ROLE.LISTEN) {
        if (tunnel.listenCloseState === 'pending' || tunnel.listenCloseState === 'timed_out') {
          tunnel.listenCloseState = 'acked';
        }
      } else if (tunnel.targetCloseState === 'pending' || tunnel.targetCloseState === 'timed_out') {
        tunnel.targetCloseState = 'acked';
      }
      this.maybeSettleClose(tunnel);
      return;
    }

    if (tunnel.status === 'closing' || tunnel.status === 'closed') return;

    switch (msg.type) {
      case PORT_FORWARD_MSG.READY: {
        if (tunnel.status !== 'preparing' || msg.role !== senderRole) return;
        if (senderRole === PORT_FORWARD_ROLE.LISTEN) {
          tunnel.listenReady = true;
          tunnel.listenCandidates = msg.candidates;
          tunnel.listenPublicKey = msg.publicKey;
          tunnel.listenKeyProof = msg.keyProof;
          tunnel.listenIdentityPublicKey = msg.identityPublicKey;
          tunnel.listenIdentitySignature = msg.identitySignature;
          tunnel.boundListenPort = msg.listenPort ?? null;
        } else {
          tunnel.targetReady = true;
          tunnel.targetCandidates = msg.candidates;
          tunnel.targetPublicKey = msg.publicKey;
          tunnel.targetKeyProof = msg.keyProof;
          tunnel.targetIdentityPublicKey = msg.identityPublicKey;
          tunnel.targetIdentitySignature = msg.identitySignature;
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
          this.dispatchConnectToTarget(tunnel);
        }
        return;
      }

      case PORT_FORWARD_MSG.TARGET_READY: {
        if (tunnel.status !== 'connecting' || senderRole !== PORT_FORWARD_ROLE.TARGET) return;
        if (tunnel.connectDispatchedToListen) return;
        tunnel.connectDispatchedToListen = true;
        this.dispatchConnectToListen(tunnel);
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
          void this.closeTunnelInternal(tunnel, 'ttl_expired', true, true);
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
          void this.closeTunnelInternal(
            tunnel,
            msg.reason ?? 'remote_closed',
            senderRole !== PORT_FORWARD_ROLE.LISTEN,
            senderRole !== PORT_FORWARD_ROLE.TARGET,
          );
        }
        return;
      }

      case PORT_FORWARD_MSG.RELAY_FRAME: {
        if (tunnel.transportPref === 'p2p_only') return;
        if (tunnel.status !== 'connecting' && !(tunnel.status === 'active' && tunnel.transportMode === 'relay')) {
          return;
        }

        const direction: PortForwardRelayDirection = senderRole === PORT_FORWARD_ROLE.LISTEN ? 'l2t' : 't2l';
        const peerPodId = senderRole === PORT_FORWARD_ROLE.LISTEN ? tunnel.targetPodId : tunnel.listenPodId;
        const peerServerId = senderRole === PORT_FORWARD_ROLE.LISTEN ? tunnel.targetServerId : tunnel.listenServerId;
        const peerGeneration = senderRole === PORT_FORWARD_ROLE.LISTEN ? tunnel.targetGeneration : tunnel.listenGeneration;
        const byteSize = Buffer.byteLength(msg.data, 'utf8');

        const enqueued = this.enqueueBounded(this.outboundQueues, `${tunnel.tunnelId}:${direction}`, {
          byteSize,
          isRelayData: true,
          onHighWater: () => {
            void this.updateCoordinatorPressure(tunnel, direction, { outMemPaused: true });
          },
          onLowWater: () => {
            void this.updateCoordinatorPressure(tunnel, direction, { outMemPaused: false });
          },
          run: async (signal) => {
            const isClosedNow = () => signal.aborted || tunnel.status === 'closing' || tunnel.status === 'closed';
            if (isClosedNow()) return;
            const res = await this.sendToEndpoint(
              peerPodId,
              peerServerId,
              peerGeneration,
              {
                type: PORT_FORWARD_MSG.RELAY_FRAME,
                tunnelId: tunnel.tunnelId,
                data: msg.data,
              },
              { tunnelId: tunnel.tunnelId, direction },
            );
            if (isClosedNow() || res.failureReason === 'cancelled') return;
            if (res.overflow) {
              void this.closeTunnelInternal(tunnel, 'cluster_queue_overflow', true, true);
              return;
            }
            if (!res.sent) {
              this.failPendingOrCloseTunnel(
                tunnel,
                503,
                PORT_FORWARD_ERRORS.NODE_OFFLINE,
                'peer_send_failed',
              );
              return;
            }
            if (res.highWater) {
              await this.updateCoordinatorPressure(tunnel, direction, { hop2Paused: true });
            }
          },
        });
        if (!enqueued.ok) {
          void this.closeTunnelInternal(tunnel, 'cluster_queue_overflow', true, true);
        }
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

  private dispatchConnectToTarget(tunnel: ActiveServerTunnel): void {
    if (!tunnel.listenPublicKey
      || !tunnel.listenKeyProof
      || !tunnel.listenIdentityPublicKey
      || !tunnel.listenIdentitySignature
      || !tunnel.targetPublicKey
      || !tunnel.targetKeyProof
      || !tunnel.targetIdentityPublicKey
      || !tunnel.targetIdentitySignature) {
      this.failPendingTunnel(tunnel, 502, PORT_FORWARD_ERRORS.INTERNAL_ERROR, 'missing endpoint keys or signatures');
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

    void this.sendToEndpoint(tunnel.targetPodId, tunnel.targetServerId, tunnel.targetGeneration, {
      type: PORT_FORWARD_MSG.CONNECT,
      tunnelId: tunnel.tunnelId,
      role: PORT_FORWARD_ROLE.TARGET,
      peerCandidates: tunnel.listenCandidates,
      peerPublicKey: tunnel.listenPublicKey,
      peerKeyProof: tunnel.listenKeyProof,
      peerIdentityPublicKey: tunnel.listenIdentityPublicKey,
      peerIdentitySignature: tunnel.listenIdentitySignature,
      transport: tunnel.transportPref,
    }).then((res) => {
      if (tunnel.status === 'closed') return;
      if (!res.sent) {
        this.failPendingTunnel(tunnel, 503, PORT_FORWARD_ERRORS.NODE_OFFLINE, 'target disconnected during connect');
      }
    });
  }

  private dispatchConnectToListen(tunnel: ActiveServerTunnel): void {
    if (tunnel.status !== 'connecting'
      || !tunnel.targetPublicKey
      || !tunnel.targetKeyProof
      || !tunnel.targetIdentityPublicKey
      || !tunnel.targetIdentitySignature) {
      return;
    }

    void this.sendToEndpoint(tunnel.listenPodId, tunnel.listenServerId, tunnel.listenGeneration, {
      type: PORT_FORWARD_MSG.CONNECT,
      tunnelId: tunnel.tunnelId,
      role: PORT_FORWARD_ROLE.LISTEN,
      peerCandidates: tunnel.targetCandidates,
      peerPublicKey: tunnel.targetPublicKey,
      peerKeyProof: tunnel.targetKeyProof,
      peerIdentityPublicKey: tunnel.targetIdentityPublicKey,
      peerIdentitySignature: tunnel.targetIdentitySignature,
      transport: tunnel.transportPref,
    }).then((res) => {
      if (tunnel.status === 'closed') return;
      if (!res.sent) {
        this.failPendingTunnel(tunnel, 503, PORT_FORWARD_ERRORS.NODE_OFFLINE, 'listen disconnected during connect');
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
  ): Promise<PortForwardCloseSettlement> {
    const resolve = tunnel.resolveOpen;
    tunnel.resolveOpen = null;
    const p = this.closeTunnelInternal(tunnel, reason, true, true);
    resolve?.({ ok: false, status, reason, error });
    return p;
  }

  private failPendingOrCloseTunnel(
    tunnel: ActiveServerTunnel,
    pendingStatus: number,
    pendingReason: PortForwardErrorCode,
    reason: string,
  ): Promise<PortForwardCloseSettlement> {
    if (tunnel.resolveOpen) {
      return this.failPendingTunnel(tunnel, pendingStatus, pendingReason, reason);
    }
    return this.closeTunnelInternal(tunnel, reason, true, true);
  }

  private maybeSettleClose(tunnel: ActiveServerTunnel): void {
    const confirmed = isCloseSideSettledConfirmed(tunnel.listenCloseState)
      && isCloseSideSettledConfirmed(tunnel.targetCloseState);
    if (tunnel.resolveClose) {
      if (tunnel.listenCloseState !== 'pending' && tunnel.targetCloseState !== 'pending') {
        if (tunnel.closeAckTimer) {
          clearTimeout(tunnel.closeAckTimer);
          tunnel.closeAckTimer = null;
        }
        tunnel.closeSettled = true;
        const resolve = tunnel.resolveClose;
        tunnel.resolveClose = null;
        const finalize = async () => {
          if (confirmed) {
            tunnel.status = 'closed';
            this.closingTunnels.delete(tunnel.tunnelId);
            this.cleanupRelayStateForTunnel(tunnel.tunnelId);
            await this.clusterStore.markTunnelClosed(tunnel.tunnelId).catch(() => {});
          }
          resolve({
            confirmed,
            listen: tunnel.listenCloseState,
            target: tunnel.targetCloseState,
          });
        };
        void finalize();
      }
      return;
    }

    // Late confirmation arriving after a previous CLOSE_ACK timeout.
    if (confirmed && tunnel.status === 'closing') {
      tunnel.status = 'closed';
      this.closingTunnels.delete(tunnel.tunnelId);
      this.cleanupRelayStateForTunnel(tunnel.tunnelId);
      void this.clusterStore.markTunnelClosed(tunnel.tunnelId).catch(() => {});
    }
  }

  private closeTunnelInternal(
    tunnel: ActiveServerTunnel,
    reason: string,
    notifyListen: boolean,
    notifyTarget: boolean,
  ): Promise<PortForwardCloseSettlement> {
    if (tunnel.closePromise && (!tunnel.closeSettled || tunnel.status === 'closed')) {
      return tunnel.closePromise;
    }

    const retryingTimedOutClose = tunnel.status === 'closing' && tunnel.closeSettled;
    tunnel.status = 'closing';
    tunnel.closeSettled = false;
    this.tunnels.delete(tunnel.tunnelId);
    this.markDeliveryTombstone(`${tunnel.tunnelId}:${tunnel.listenServerId}:${tunnel.listenPodId}:${tunnel.listenGeneration}`);
    this.markDeliveryTombstone(`${tunnel.tunnelId}:${tunnel.targetServerId}:${tunnel.targetPodId}:${tunnel.targetGeneration}`);
    this.cancelBucketsByPrefix(this.inboundQueues, `${tunnel.tunnelId}:`);
    this.cancelBucketsByPrefix(this.outboundQueues, `${tunnel.tunnelId}:`);
    this.cancelBucketsByPrefix(this.remoteDeliveryQueues, `${tunnel.tunnelId}:`);
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
    if (tunnel.resolveOpen) {
      const resolve = tunnel.resolveOpen;
      tunnel.resolveOpen = null;
      resolve({ ok: false, status: 409, reason: PORT_FORWARD_ERRORS.TUNNEL_NOT_FOUND, error: reason });
    }

    const sendListenClose = retryingTimedOutClose
      ? tunnel.listenCloseState === 'timed_out'
      : notifyListen;
    const sendTargetClose = retryingTimedOutClose
      ? tunnel.targetCloseState === 'timed_out'
      : notifyTarget;

    if (!retryingTimedOutClose) {
      tunnel.listenCloseState = notifyListen ? 'pending' : 'offline';
      tunnel.targetCloseState = notifyTarget ? 'pending' : 'offline';
    } else {
      if (tunnel.listenCloseState === 'timed_out') tunnel.listenCloseState = 'pending';
      if (tunnel.targetCloseState === 'timed_out') tunnel.targetCloseState = 'pending';
    }

    tunnel.closePromise = new Promise<PortForwardCloseSettlement>((resolveClose) => {
      tunnel.resolveClose = resolveClose;
      this.closingTunnels.set(tunnel.tunnelId, tunnel);

      if (tunnel.closeAckTimer) {
        clearTimeout(tunnel.closeAckTimer);
        tunnel.closeAckTimer = null;
      }
      tunnel.closeAckTimer = setTimeout(() => {
        if (tunnel.listenCloseState === 'pending') tunnel.listenCloseState = 'timed_out';
        if (tunnel.targetCloseState === 'pending') tunnel.targetCloseState = 'timed_out';
        this.maybeSettleClose(tunnel);
      }, this.closeAckTimeoutMs);
      tunnel.closeAckTimer.unref?.();

      const closeSide = async (
        side: 'listen' | 'target',
        shouldNotify: boolean,
        expectedPodId: string,
        serverId: string,
        generation: number,
      ) => {
        if (!shouldNotify) return;
        const setSideState = (state: PortForwardCloseSideState) => {
          if (side === 'listen' && tunnel.listenCloseState === 'pending') tunnel.listenCloseState = state;
          if (side === 'target' && tunnel.targetCloseState === 'pending') tunnel.targetCloseState = state;
          this.maybeSettleClose(tunnel);
        };
        // Send CLOSE strictly to the connection-bound (expectedPodId, generation) created at openTunnel,
        // NEVER redirecting to a replacement pod/connection that merely shares serverId & local generation.
        const res = await this.sendToEndpoint(
          expectedPodId,
          serverId,
          generation,
          {
            type: PORT_FORWARD_MSG.CLOSE,
            tunnelId: tunnel.tunnelId,
            reason,
            role: side === 'listen' ? PORT_FORWARD_ROLE.LISTEN : PORT_FORWARD_ROLE.TARGET,
          },
          undefined,
          expectedPodId,
        );
        if (!res.sent) {
          if (res.failureReason === 'offline' || res.failureReason === 'generation_mismatch') {
            setSideState('offline');
          } else {
            setSideState('timed_out');
          }
        }
      };

      void (async () => {
        await this.clusterStore.updateTunnel(tunnel.tunnelId, { status: 'closing' }).catch(() => {});
        await Promise.all([
          closeSide('listen', sendListenClose, tunnel.listenPodId, tunnel.listenServerId, tunnel.listenGeneration),
          closeSide('target', sendTargetClose, tunnel.targetPodId, tunnel.targetServerId, tunnel.targetGeneration),
        ]);
        this.maybeSettleClose(tunnel);
      })();
    });

    return tunnel.closePromise;
  }

  private toSummary(tunnel: ActiveServerTunnel): PortForwardTunnelSummary {
    return tunnelRecordToSummary({
      tunnelId: tunnel.tunnelId,
      userId: tunnel.userId,
      coordinatorPodId: this.podId,
      listenNode: tunnel.listenNode,
      listenServerId: tunnel.listenServerId,
      ...(tunnel.listenNodeId ? { listenNodeId: tunnel.listenNodeId } : {}),
      listenPodId: tunnel.listenPodId,
      listenGeneration: tunnel.listenGeneration,
      requestedListenPort: tunnel.requestedListenPort,
      boundListenPort: tunnel.boundListenPort,
      targetNode: tunnel.targetNode,
      targetServerId: tunnel.targetServerId,
      ...(tunnel.targetNodeId ? { targetNodeId: tunnel.targetNodeId } : {}),
      targetPodId: tunnel.targetPodId,
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
