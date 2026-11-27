import { createHash } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import type { Database } from '../db/client.js';
import {
  PORT_FORWARD_ERRORS,
  PORT_FORWARD_LIMITS,
  PORT_FORWARD_MSG,
  type PortForwardTransport,
  type PortForwardTransportPref,
  type PortForwardTunnelSummary,
  type PortForwardWireMessage,
} from '../../../shared/port-forward.js';

export type PortForwardClusterStatus = 'preparing' | 'connecting' | 'active' | 'closing' | 'closed';

export type PortForwardRelayHop = 'to_coordinator' | 'to_endpoint';

export type PortForwardRemoteCloseAckOutcome = 'confirmed' | 'timed_out' | 'missing' | 'error';

export type PortForwardCoordinatorAdoptResult =
  | { outcome: 'adopted'; record: PortForwardClusterTunnelRecord }
  | { outcome: 'already_closed' }
  | { outcome: 'lost_race'; record: PortForwardClusterTunnelRecord }
  | { outcome: 'not_found' };

export interface PortForwardEndpointPresence {
  serverId: string;
  podId: string;
  generation: number;
  updatedAt: number;
}

export interface PortForwardClusterTunnelRecord {
  tunnelId: string;
  userId: string;
  coordinatorPodId: string;
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
  status: PortForwardClusterStatus;
  activeConnections: number;
  bytesSent: number;
  bytesReceived: number;
  label?: string;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
}

export type PortForwardRelayDirection = 'l2t' | 't2l';

export type PortForwardClusterBusMessage =
  | {
      kind: 'to_endpoint';
      serverId: string;
      expectedPodId?: string;
      expectedGeneration: number;
      frame: PortForwardWireMessage;
      tunnelId?: string;
      direction?: PortForwardRelayDirection;
      coordinatorPodId?: string;
    }
  | {
      kind: 'to_coordinator';
      tunnelId: string;
      fromServerId: string;
      fromPodId: string;
      fromGeneration: number;
      frame: PortForwardWireMessage;
      direction?: PortForwardRelayDirection;
    }
  | {
      kind: 'relay_drained';
      tunnelId: string;
      direction: PortForwardRelayDirection;
      hop: PortForwardRelayHop;
      queuedBytes: number;
    }
  | {
      kind: 'daemon_disconnected';
      tunnelId: string;
      serverId: string;
      podId: string;
      generation: number;
    }
  | {
      kind: 'close_delivery_failed';
      tunnelId: string;
      serverId: string;
      podId: string;
      generation: number;
    }
  | {
      kind: 'close_tunnel';
      tunnelId: string;
      reason: string;
      requestId?: string;
      replyPodId?: string;
    }
  | {
      kind: 'close_tunnel_ack';
      requestId: string;
      tunnelId: string;
      ok: boolean;
      outcome: PortForwardRemoteCloseAckOutcome;
    };

export type PortForwardClusterEnqueueResult =
  | { ok: true; queuedBytes: number; highWater: boolean }
  | { ok: false; overflow: true; queuedBytes: number };

export type PortForwardClusterBusHandler = (message: PortForwardClusterBusMessage) => void | Promise<void>;

export interface PortForwardClusterStore {
  registerEndpoint(podId: string, serverId: string, generation: number): Promise<void>;
  unregisterEndpoint(podId: string, serverId: string, generation: number): Promise<void>;
  getEndpoint(serverId: string): Promise<PortForwardEndpointPresence | null>;
  tryCreateTunnel(
    record: PortForwardClusterTunnelRecord,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  updateTunnel(
    tunnelId: string,
    patch: Partial<Pick<
      PortForwardClusterTunnelRecord,
      'coordinatorPodId' | 'status' | 'transportMode' | 'boundListenPort' | 'activeConnections' | 'bytesSent' | 'bytesReceived' | 'updatedAt'
    >>,
  ): Promise<void>;
  markTunnelClosed(tunnelId: string, updatedAt?: number): Promise<void>;
  tryAdoptCoordinator(
    tunnelId: string,
    expectedCoordinatorPodId: string,
    expectedUpdatedAt: number,
    newCoordinatorPodId: string,
    now?: number,
  ): Promise<PortForwardCoordinatorAdoptResult>;
  getTunnel(tunnelId: string): Promise<PortForwardClusterTunnelRecord | null>;
  listActiveTunnels(userId: string, filterServerId?: string): Promise<PortForwardTunnelSummary[]>;
  listOpenTunnelsForUser(userId: string, filterServerId?: string): Promise<PortForwardClusterTunnelRecord[]>;
  listOpenTunnelsForEndpoint(serverId: string, generation: number, podId?: string): Promise<PortForwardClusterTunnelRecord[]>;
  subscribePod(podId: string, handler: PortForwardClusterBusHandler): () => void;
  sendToPod(targetPodId: string, message: PortForwardClusterBusMessage): Promise<void>;
  enqueueBusMessage(
    targetPodId: string,
    message: PortForwardClusterBusMessage,
  ): Promise<PortForwardClusterEnqueueResult>;
  cleanupTunnelMessages(tunnelId: string): Promise<void>;
  reclaimStaleMessages(now?: number): Promise<number>;
  getQueuedBytes?(tunnelId: string, direction: PortForwardRelayDirection, hop?: PortForwardRelayHop): Promise<number>;
  setPodDrainPausedForTests?(podId: string, paused: boolean): Promise<void>;
  start?(podId: string, handler: PortForwardClusterBusHandler): Promise<void>;
  stop?(podId: string): Promise<void>;
}

export function tunnelRecordToSummary(record: PortForwardClusterTunnelRecord): PortForwardTunnelSummary {
  const listenPort = record.boundListenPort ?? record.requestedListenPort;
  return {
    tunnelId: record.tunnelId,
    listenNode: record.listenNode,
    listenServerId: record.listenServerId,
    ...(record.listenNodeId ? { listenNodeId: record.listenNodeId } : {}),
    listenHost: PORT_FORWARD_LIMITS.LISTEN_HOST,
    listenPort,
    localEndpoint: `${PORT_FORWARD_LIMITS.LISTEN_HOST}:${listenPort}`,
    targetNode: record.targetNode,
    targetServerId: record.targetServerId,
    ...(record.targetNodeId ? { targetNodeId: record.targetNodeId } : {}),
    targetHost: record.targetHost,
    targetPort: record.targetPort,
    transportMode: record.transportMode ?? 'relay',
    activeConnections: record.activeConnections,
    bytesSent: record.bytesSent,
    bytesReceived: record.bytesReceived,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.label ? { label: record.label } : {}),
  };
}

function classifyRelayAccounting(message: PortForwardClusterBusMessage): {
  isRelayData: boolean;
  tunnelId?: string;
  direction?: PortForwardRelayDirection;
  hop?: PortForwardRelayHop;
  byteSize: number;
  coordinatorPodId?: string;
} {
  if ((message.kind === 'to_endpoint' || message.kind === 'to_coordinator')
    && message.frame.type === PORT_FORWARD_MSG.RELAY_FRAME) {
    return {
      isRelayData: true,
      tunnelId: message.frame.tunnelId,
      direction: message.direction ?? 'l2t',
      hop: message.kind,
      byteSize: Buffer.byteLength(message.frame.data, 'utf8'),
      coordinatorPodId: message.kind === 'to_endpoint' ? message.coordinatorPodId : undefined,
    };
  }
  const tunnelId = 'tunnelId' in message && typeof message.tunnelId === 'string'
    ? message.tunnelId
    : undefined;
  return {
    isRelayData: false,
    ...(tunnelId ? { tunnelId } : {}),
    byteSize: 0,
  };
}

interface InMemoryQueuedItem {
  seq: number;
  targetPodId: string;
  tunnelId?: string;
  direction?: PortForwardRelayDirection;
  hop?: PortForwardRelayHop;
  byteSize: number;
  expiresAt: number;
  coordinatorPodId?: string;
  message: PortForwardClusterBusMessage;
}

/**
 * In-memory authoritative cluster store & ordered/bounded pod message bus.
 * Uses explicit per-pod FIFO queues and byte/TTL accounting mirroring PostgreSQL semantics.
 */
export class InMemoryPortForwardClusterStore implements PortForwardClusterStore {
  private readonly endpoints = new Map<string, PortForwardEndpointPresence>();
  private readonly tunnels = new Map<string, PortForwardClusterTunnelRecord>();
  private readonly subscribers = new Map<string, PortForwardClusterBusHandler>();
  private readonly podQueues = new Map<string, InMemoryQueuedItem[]>();
  private readonly drainingPods = new Set<string>();
  private readonly pausedPods = new Set<string>();
  private nextSeq = 1;

  async registerEndpoint(podId: string, serverId: string, generation: number): Promise<void> {
    this.endpoints.set(serverId, { serverId, podId, generation, updatedAt: Date.now() });
  }

  async unregisterEndpoint(podId: string, serverId: string, generation: number): Promise<void> {
    const existing = this.endpoints.get(serverId);
    if (existing && existing.podId === podId && existing.generation === generation) {
      this.endpoints.delete(serverId);
    }
    const q = this.podQueues.get(podId);
    if (q) {
      for (let i = q.length - 1; i >= 0; i--) {
        const item = q[i]!;
        if (item.message.kind === 'to_endpoint'
          && item.message.serverId === serverId
          && item.message.expectedGeneration === generation) {
          q.splice(i, 1);
        }
      }
    }
  }

  async getEndpoint(serverId: string): Promise<PortForwardEndpointPresence | null> {
    return this.endpoints.get(serverId) ?? null;
  }

  async tryCreateTunnel(record: PortForwardClusterTunnelRecord): Promise<{ ok: true } | { ok: false; error: string }> {
    const now = Date.now();
    await this.reclaimStaleMessages(now);
    let userCount = 0;
    let listenCount = 0;
    let targetCount = 0;
    for (const existing of this.tunnels.values()) {
      if (existing.status === 'closed' || existing.expiresAt <= now) continue;
      if (existing.userId === record.userId) userCount += 1;
      if (existing.listenServerId === record.listenServerId || existing.targetServerId === record.listenServerId) {
        listenCount += 1;
      }
      if (existing.listenServerId === record.targetServerId || existing.targetServerId === record.targetServerId) {
        targetCount += 1;
      }
    }
    if (userCount >= PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_USER) {
      return { ok: false, error: `user tunnel limit (${PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_USER}) exceeded` };
    }
    if (listenCount >= PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_NODE || targetCount >= PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_NODE) {
      return { ok: false, error: `node tunnel limit (${PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_NODE}) exceeded` };
    }
    this.tunnels.set(record.tunnelId, { ...record });
    return { ok: true };
  }

  async updateTunnel(
    tunnelId: string,
    patch: Partial<Pick<
      PortForwardClusterTunnelRecord,
      'coordinatorPodId' | 'status' | 'transportMode' | 'boundListenPort' | 'activeConnections' | 'bytesSent' | 'bytesReceived' | 'updatedAt'
    >>,
  ): Promise<void> {
    const existing = this.tunnels.get(tunnelId);
    if (!existing) return;
    Object.assign(existing, patch);
  }

  async markTunnelClosed(tunnelId: string, updatedAt = Date.now()): Promise<void> {
    const existing = this.tunnels.get(tunnelId);
    if (existing) {
      existing.status = 'closed';
      existing.updatedAt = updatedAt;
    }
    await this.cleanupTunnelMessages(tunnelId);
  }

  async tryAdoptCoordinator(
    tunnelId: string,
    expectedCoordinatorPodId: string,
    expectedUpdatedAt: number,
    newCoordinatorPodId: string,
    now = Date.now(),
  ): Promise<PortForwardCoordinatorAdoptResult> {
    const existing = this.tunnels.get(tunnelId);
    if (!existing) return { outcome: 'not_found' };
    if (existing.status === 'closed') return { outcome: 'already_closed' };
    if (existing.coordinatorPodId !== expectedCoordinatorPodId || existing.updatedAt !== expectedUpdatedAt) {
      return { outcome: 'lost_race', record: { ...existing } };
    }
    existing.coordinatorPodId = newCoordinatorPodId;
    existing.status = 'closing';
    existing.updatedAt = Math.max(now, expectedUpdatedAt + 1);
    return { outcome: 'adopted', record: { ...existing } };
  }

  async getTunnel(tunnelId: string): Promise<PortForwardClusterTunnelRecord | null> {
    const t = this.tunnels.get(tunnelId);
    return t ? { ...t } : null;
  }

  async listActiveTunnels(userId: string, filterServerId?: string): Promise<PortForwardTunnelSummary[]> {
    const now = Date.now();
    const out: PortForwardTunnelSummary[] = [];
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.userId !== userId || tunnel.status !== 'active' || tunnel.expiresAt <= now) continue;
      if (filterServerId
        && tunnel.listenServerId !== filterServerId
        && tunnel.targetServerId !== filterServerId) {
        continue;
      }
      out.push(tunnelRecordToSummary(tunnel));
      if (out.length >= PORT_FORWARD_LIMITS.MAX_LIST_TUNNELS) break;
    }
    return out;
  }

  async listOpenTunnelsForUser(userId: string, filterServerId?: string): Promise<PortForwardClusterTunnelRecord[]> {
    const out: PortForwardClusterTunnelRecord[] = [];
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.userId !== userId || tunnel.status === 'closed') continue;
      if (filterServerId
        && tunnel.listenServerId !== filterServerId
        && tunnel.targetServerId !== filterServerId) {
        continue;
      }
      out.push({ ...tunnel });
    }
    return out;
  }

  async listOpenTunnelsForEndpoint(serverId: string, generation: number, podId?: string): Promise<PortForwardClusterTunnelRecord[]> {
    const out: PortForwardClusterTunnelRecord[] = [];
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.status === 'closed') continue;
      const matchesListen = tunnel.listenServerId === serverId
        && tunnel.listenGeneration === generation
        && (!podId || tunnel.listenPodId === podId);
      const matchesTarget = tunnel.targetServerId === serverId
        && tunnel.targetGeneration === generation
        && (!podId || tunnel.targetPodId === podId);
      if (matchesListen || matchesTarget) out.push({ ...tunnel });
    }
    return out;
  }

  subscribePod(podId: string, handler: PortForwardClusterBusHandler): () => void {
    this.subscribers.set(podId, handler);
    return () => {
      if (this.subscribers.get(podId) === handler) this.subscribers.delete(podId);
    };
  }

  async getQueuedBytes(
    tunnelId: string,
    direction: PortForwardRelayDirection,
    hop?: PortForwardRelayHop,
  ): Promise<number> {
    const now = Date.now();
    let total = 0;
    for (const q of this.podQueues.values()) {
      for (const item of q) {
        if (
          item.tunnelId === tunnelId
          && item.direction === direction
          && (!hop || item.hop === hop)
          && item.expiresAt > now
        ) {
          total += item.byteSize;
        }
      }
    }
    return total;
  }

  async cleanupTunnelMessages(tunnelId: string): Promise<void> {
    for (const q of this.podQueues.values()) {
      for (let i = q.length - 1; i >= 0; i--) {
        const item = q[i]!;
        if (item.tunnelId === tunnelId
          && (item.message.kind === 'to_endpoint' || item.message.kind === 'to_coordinator')) {
          q.splice(i, 1);
        }
      }
    }
  }

  private pushControlMessageDirect(targetPodId: string, message: PortForwardClusterBusMessage): void {
    let q = this.podQueues.get(targetPodId);
    if (!q) {
      q = [];
      this.podQueues.set(targetPodId, q);
    }
    const now = Date.now();
    q.push({
      seq: this.nextSeq++,
      targetPodId,
      ...(typeof (message as { tunnelId?: unknown }).tunnelId === 'string'
        ? { tunnelId: (message as { tunnelId: string }).tunnelId }
        : {}),
      byteSize: 0,
      expiresAt: now + PORT_FORWARD_LIMITS.CLUSTER_RELAY_MSG_TTL_MS,
      message,
    });
    this.scheduleDrain(targetPodId);
  }

  private notifyExpiredOpenTunnels(tunnelIds: Iterable<string>): void {
    for (const tunnelId of tunnelIds) {
      const tunnel = this.tunnels.get(tunnelId);
      if (!tunnel || tunnel.status === 'closing' || tunnel.status === 'closed') continue;
      this.pushControlMessageDirect(tunnel.coordinatorPodId, {
        kind: 'close_tunnel',
        tunnelId,
        reason: 'relay_message_expired',
      });
    }
  }

  async reclaimStaleMessages(now = Date.now()): Promise<number> {
    let removed = 0;
    const expiredRelayTunnels = new Set<string>();
    for (const [podId, q] of this.podQueues.entries()) {
      for (let i = q.length - 1; i >= 0; i--) {
        const item = q[i]!;
        const closedTunnel = item.tunnelId ? this.tunnels.get(item.tunnelId)?.status === 'closed' : false;
        const deadEndpoint = item.message.kind === 'to_endpoint'
          && !this.endpoints.has(item.message.serverId)
          && item.message.frame.type === PORT_FORWARD_MSG.RELAY_FRAME;
        if (item.expiresAt <= now) {
          if (item.byteSize > 0
            && item.tunnelId
            && (item.message.kind === 'to_coordinator' || item.message.kind === 'to_endpoint')) {
            expiredRelayTunnels.add(item.tunnelId);
          }
          q.splice(i, 1);
          removed += 1;
        } else if ((closedTunnel && (item.message.kind === 'to_endpoint' || item.message.kind === 'to_coordinator')) || deadEndpoint) {
          q.splice(i, 1);
          removed += 1;
        }
      }
      if (q.length === 0) this.podQueues.delete(podId);
    }
    if (expiredRelayTunnels.size > 0) {
      this.notifyExpiredOpenTunnels(expiredRelayTunnels);
    }
    return removed;
  }

  async setPodDrainPausedForTests(podId: string, paused: boolean): Promise<void> {
    if (paused) {
      this.pausedPods.add(podId);
    } else {
      this.pausedPods.delete(podId);
      this.scheduleDrain(podId);
    }
  }

  async stop(podId: string): Promise<void> {
    this.pausedPods.delete(podId);
    this.subscribers.delete(podId);
    this.podQueues.delete(podId);
  }

  async sendToPod(targetPodId: string, message: PortForwardClusterBusMessage): Promise<void> {
    await this.enqueueBusMessage(targetPodId, message);
  }

  async enqueueBusMessage(
    targetPodId: string,
    message: PortForwardClusterBusMessage,
  ): Promise<PortForwardClusterEnqueueResult> {
    const now = Date.now();
    await this.reclaimStaleMessages(now);
    const acc = classifyRelayAccounting(message);
    let currentBytes = 0;

    if (acc.isRelayData && acc.tunnelId && acc.direction && acc.hop) {
      currentBytes = await this.getQueuedBytes(acc.tunnelId, acc.direction, acc.hop);
      if (currentBytes + acc.byteSize > PORT_FORWARD_LIMITS.CLUSTER_RELAY_HARD_CAP_BYTES) {
        return { ok: false, overflow: true, queuedBytes: currentBytes };
      }
    }

    let q = this.podQueues.get(targetPodId);
    if (!q) {
      q = [];
      this.podQueues.set(targetPodId, q);
    }
    q.push({
      seq: this.nextSeq++,
      targetPodId,
      ...(acc.tunnelId ? { tunnelId: acc.tunnelId } : {}),
      ...(acc.direction ? { direction: acc.direction } : {}),
      ...(acc.hop ? { hop: acc.hop } : {}),
      byteSize: acc.byteSize,
      expiresAt: now + PORT_FORWARD_LIMITS.CLUSTER_RELAY_MSG_TTL_MS,
      ...(acc.coordinatorPodId ? { coordinatorPodId: acc.coordinatorPodId } : {}),
      message,
    });

    const totalAfter = currentBytes + acc.byteSize;
    this.scheduleDrain(targetPodId);
    return {
      ok: true,
      queuedBytes: totalAfter,
      highWater: acc.isRelayData && totalAfter >= PORT_FORWARD_LIMITS.CLUSTER_RELAY_HIGH_WATER_BYTES,
    };
  }

  private scheduleDrain(podId: string): void {
    if (this.drainingPods.has(podId) || this.pausedPods.has(podId)) return;
    const handler = this.subscribers.get(podId);
    if (!handler) return;
    this.drainingPods.add(podId);
    queueMicrotask(() => {
      void this.drainPodQueue(podId).finally(() => {
        this.drainingPods.delete(podId);
        const remaining = this.podQueues.get(podId);
        if (remaining && remaining.length > 0 && !this.pausedPods.has(podId) && this.subscribers.has(podId)) {
          this.scheduleDrain(podId);
        }
      });
    });
  }

  private async drainPodQueue(podId: string): Promise<void> {
    const q = this.podQueues.get(podId);
    if (!q) return;
    const drainedPairs = new Map<string, {
      tunnelId: string;
      direction: PortForwardRelayDirection;
      hop: PortForwardRelayHop;
      coordinatorPodId?: string;
    }>();

    const expiredRelayTunnels = new Set<string>();
    while (q.length > 0 && !this.pausedPods.has(podId)) {
      const handler = this.subscribers.get(podId);
      if (!handler) break;
      const item = q.shift()!;
      if (item.expiresAt <= Date.now()) {
        if (item.byteSize > 0
          && item.tunnelId
          && (item.message.kind === 'to_coordinator' || item.message.kind === 'to_endpoint')) {
          expiredRelayTunnels.add(item.tunnelId);
        }
        continue;
      }
      if (item.tunnelId && item.direction && item.hop && item.byteSize > 0) {
        drainedPairs.set(`${item.tunnelId}:${item.direction}:${item.hop}`, {
          tunnelId: item.tunnelId,
          direction: item.direction,
          hop: item.hop,
          coordinatorPodId: item.coordinatorPodId,
        });
      }
      await handler(item.message);
    }

    if (expiredRelayTunnels.size > 0) {
      this.notifyExpiredOpenTunnels(expiredRelayTunnels);
    }

    for (const pair of drainedPairs.values()) {
      const remainingBytes = await this.getQueuedBytes(pair.tunnelId, pair.direction, pair.hop);
      if (remainingBytes <= PORT_FORWARD_LIMITS.CLUSTER_RELAY_LOW_WATER_BYTES) {
        const coordinatorPodId = pair.coordinatorPodId ?? this.tunnels.get(pair.tunnelId)?.coordinatorPodId;
        if (coordinatorPodId) {
          await this.enqueueBusMessage(coordinatorPodId, {
            kind: 'relay_drained',
            tunnelId: pair.tunnelId,
            direction: pair.direction,
            hop: pair.hop,
            queuedBytes: remainingBytes,
          });
        }
      }
    }
  }
}

const PG_BUS_CHANNEL = 'imcodes_port_forward_bus';

function advisoryLockKey64(key: string): string {
  const digest = createHash('sha256').update(key).digest();
  return digest.readBigInt64BE(0).toString();
}

interface PgTunnelRow {
  tunnel_id: string;
  user_id: string;
  coordinator_pod_id: string;
  listen_node: string;
  listen_server_id: string;
  listen_node_id: string | null;
  listen_pod_id?: string | null;
  listen_generation: number | string;
  requested_listen_port: number;
  bound_listen_port: number | null;
  target_node: string;
  target_server_id: string;
  target_node_id: string | null;
  target_pod_id?: string | null;
  target_generation: number | string;
  target_host: string;
  target_port: number;
  transport_pref: PortForwardTransportPref;
  transport_mode: PortForwardTransport | null;
  status: PortForwardClusterStatus;
  active_connections: number;
  bytes_sent: number | string;
  bytes_received: number | string;
  label: string | null;
  created_at: number | string;
  expires_at: number | string;
  updated_at: number | string;
}

function rowToTunnelRecord(row: PgTunnelRow): PortForwardClusterTunnelRecord {
  return {
    tunnelId: row.tunnel_id,
    userId: row.user_id,
    coordinatorPodId: row.coordinator_pod_id,
    listenNode: row.listen_node,
    listenServerId: row.listen_server_id,
    ...(row.listen_node_id ? { listenNodeId: row.listen_node_id } : {}),
    listenPodId: row.listen_pod_id ?? '',
    listenGeneration: Number(row.listen_generation),
    requestedListenPort: row.requested_listen_port,
    boundListenPort: row.bound_listen_port,
    targetNode: row.target_node,
    targetServerId: row.target_server_id,
    ...(row.target_node_id ? { targetNodeId: row.target_node_id } : {}),
    targetPodId: row.target_pod_id ?? '',
    targetGeneration: Number(row.target_generation),
    targetHost: row.target_host,
    targetPort: row.target_port,
    transportPref: row.transport_pref,
    transportMode: row.transport_mode,
    status: row.status,
    activeConnections: row.active_connections,
    bytesSent: Number(row.bytes_sent),
    bytesReceived: Number(row.bytes_received),
    ...(row.label ? { label: row.label } : {}),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Authoritative PostgreSQL-backed cluster store & ordered/bounded cross-pod bus.
 */
export class PostgresPortForwardClusterStore implements PortForwardClusterStore {
  private readonly subscribers = new Map<string, PortForwardClusterBusHandler>();
  private readonly pausedPods = new Set<string>();
  private readonly listeners = new Map<string, {
    stop(): Promise<void>;
    wake(): void;
  }>();

  constructor(
    private readonly db: Database,
    private readonly connectionString?: string,
  ) {}

  async registerEndpoint(podId: string, serverId: string, generation: number): Promise<void> {
    const now = Date.now();
    await this.db.execute(
      `INSERT INTO port_forward_endpoints (server_id, pod_id, generation, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (server_id) DO UPDATE
         SET pod_id = EXCLUDED.pod_id,
             generation = EXCLUDED.generation,
             updated_at = EXCLUDED.updated_at`,
      [serverId, podId, generation, now],
    );
  }

  async unregisterEndpoint(podId: string, serverId: string, generation: number): Promise<void> {
    await this.db.execute(
      `DELETE FROM port_forward_endpoints
        WHERE server_id = $1 AND pod_id = $2 AND generation = $3`,
      [serverId, podId, generation],
    );
    await this.db.execute(
      `DELETE FROM port_forward_bus_messages
        WHERE target_pod_id = $1
          AND kind = 'to_endpoint'
          AND payload->>'serverId' = $2
          AND (payload->>'expectedGeneration')::bigint = $3`,
      [podId, serverId, generation],
    );
  }

  async getEndpoint(serverId: string): Promise<PortForwardEndpointPresence | null> {
    const row = await this.db.queryOne<{
      server_id: string;
      pod_id: string;
      generation: number | string;
      updated_at: number | string;
    }>(
      `SELECT server_id, pod_id, generation, updated_at
         FROM port_forward_endpoints
        WHERE server_id = $1
        LIMIT 1`,
      [serverId],
    );
    if (!row) return null;
    return {
      serverId: row.server_id,
      podId: row.pod_id,
      generation: Number(row.generation),
      updatedAt: Number(row.updated_at),
    };
  }

  async tryCreateTunnel(record: PortForwardClusterTunnelRecord): Promise<{ ok: true } | { ok: false; error: string }> {
    const now = Date.now();
    return this.db.transaction(async (tx) => {
      const lockKeys = Array.from(new Set([
        `pf_user:${record.userId}`,
        `pf_srv:${record.listenServerId}`,
        `pf_srv:${record.targetServerId}`,
      ])).sort();
      for (const k of lockKeys) {
        await tx.execute('SELECT pg_advisory_xact_lock($1::bigint)', [advisoryLockKey64(k)]);
      }

      const userRow = await tx.queryOne<{ cnt: number | string }>(
        `SELECT COUNT(*)::int AS cnt FROM port_forward_tunnels
          WHERE user_id = $1 AND status <> 'closed' AND expires_at > $2`,
        [record.userId, now],
      );
      if (Number(userRow?.cnt ?? 0) >= PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_USER) {
        return { ok: false as const, error: `user tunnel limit (${PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_USER}) exceeded` };
      }

      const nodeRow = await tx.queryOne<{ listen_cnt: number | string; target_cnt: number | string }>(
        `SELECT
            COUNT(*) FILTER (WHERE listen_server_id = $1 OR target_server_id = $1)::int AS listen_cnt,
            COUNT(*) FILTER (WHERE listen_server_id = $2 OR target_server_id = $2)::int AS target_cnt
           FROM port_forward_tunnels
          WHERE status <> 'closed' AND expires_at > $3
            AND (listen_server_id = $1 OR target_server_id = $1 OR listen_server_id = $2 OR target_server_id = $2)`,
        [record.listenServerId, record.targetServerId, now],
      );
      if (Number(nodeRow?.listen_cnt ?? 0) >= PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_NODE
        || Number(nodeRow?.target_cnt ?? 0) >= PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_NODE) {
        return { ok: false as const, error: `node tunnel limit (${PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_NODE}) exceeded` };
      }

      await tx.execute(
        `INSERT INTO port_forward_tunnels (
           tunnel_id, user_id, coordinator_pod_id,
           listen_node, listen_server_id, listen_node_id, listen_pod_id, listen_generation,
           requested_listen_port, bound_listen_port,
           target_node, target_server_id, target_node_id, target_pod_id, target_generation,
           target_host, target_port, transport_pref, transport_mode,
           status, active_connections, bytes_sent, bytes_received, label,
           created_at, expires_at, updated_at
         ) VALUES (
           $1, $2, $3,
           $4, $5, $6, $7, $8,
           $9, $10,
           $11, $12, $13, $14, $15,
           $16, $17, $18, $19,
           $20, $21, $22, $23, $24,
           $25, $26, $27
         )`,
        [
          record.tunnelId,
          record.userId,
          record.coordinatorPodId,
          record.listenNode,
          record.listenServerId,
          record.listenNodeId ?? null,
          record.listenPodId,
          record.listenGeneration,
          record.requestedListenPort,
          record.boundListenPort,
          record.targetNode,
          record.targetServerId,
          record.targetNodeId ?? null,
          record.targetPodId,
          record.targetGeneration,
          record.targetHost,
          record.targetPort,
          record.transportPref,
          record.transportMode,
          record.status,
          record.activeConnections,
          record.bytesSent,
          record.bytesReceived,
          record.label ?? null,
          record.createdAt,
          record.expiresAt,
          record.updatedAt,
        ],
      );
      return { ok: true as const };
    });
  }

  async updateTunnel(
    tunnelId: string,
    patch: Partial<Pick<
      PortForwardClusterTunnelRecord,
      'coordinatorPodId' | 'status' | 'transportMode' | 'boundListenPort' | 'activeConnections' | 'bytesSent' | 'bytesReceived' | 'updatedAt'
    >>,
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.coordinatorPodId !== undefined) push('coordinator_pod_id', patch.coordinatorPodId);
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.transportMode !== undefined) push('transport_mode', patch.transportMode);
    if (patch.boundListenPort !== undefined) push('bound_listen_port', patch.boundListenPort);
    if (patch.activeConnections !== undefined) push('active_connections', patch.activeConnections);
    if (patch.bytesSent !== undefined) push('bytes_sent', patch.bytesSent);
    if (patch.bytesReceived !== undefined) push('bytes_received', patch.bytesReceived);
    push('updated_at', patch.updatedAt ?? Date.now());
    params.push(tunnelId);
    await this.db.execute(
      `UPDATE port_forward_tunnels SET ${sets.join(', ')} WHERE tunnel_id = $${params.length} AND status <> 'closed'`,
      params,
    );
  }

  async markTunnelClosed(tunnelId: string, updatedAt = Date.now()): Promise<void> {
    await this.db.execute(
      `UPDATE port_forward_tunnels SET status = 'closed', updated_at = $1 WHERE tunnel_id = $2`,
      [updatedAt, tunnelId],
    );
    await this.cleanupTunnelMessages(tunnelId);
  }

  async tryAdoptCoordinator(
    tunnelId: string,
    expectedCoordinatorPodId: string,
    expectedUpdatedAt: number,
    newCoordinatorPodId: string,
    now = Date.now(),
  ): Promise<PortForwardCoordinatorAdoptResult> {
    const nextUpdatedAt = Math.max(now, expectedUpdatedAt + 1);
    return this.db.transaction(async (tx): Promise<PortForwardCoordinatorAdoptResult> => {
      const updated = await tx.queryOne<PgTunnelRow>(
        `UPDATE port_forward_tunnels
            SET coordinator_pod_id = $1,
                status = 'closing',
                updated_at = $2
          WHERE tunnel_id = $3
            AND coordinator_pod_id = $4
            AND updated_at = $5
            AND status <> 'closed'
          RETURNING *`,
        [newCoordinatorPodId, nextUpdatedAt, tunnelId, expectedCoordinatorPodId, expectedUpdatedAt],
      );
      if (updated) {
        return { outcome: 'adopted', record: rowToTunnelRecord(updated) };
      }
      const current = await tx.queryOne<PgTunnelRow>(
        `SELECT * FROM port_forward_tunnels WHERE tunnel_id = $1 LIMIT 1`,
        [tunnelId],
      );
      if (!current) return { outcome: 'not_found' };
      if (current.status === 'closed') return { outcome: 'already_closed' };
      return { outcome: 'lost_race', record: rowToTunnelRecord(current) };
    });
  }

  async getTunnel(tunnelId: string): Promise<PortForwardClusterTunnelRecord | null> {
    const row = await this.db.queryOne<PgTunnelRow>(
      `SELECT * FROM port_forward_tunnels WHERE tunnel_id = $1 LIMIT 1`,
      [tunnelId],
    );
    return row ? rowToTunnelRecord(row) : null;
  }

  async listActiveTunnels(userId: string, filterServerId?: string): Promise<PortForwardTunnelSummary[]> {
    const now = Date.now();
    const rows = filterServerId
      ? await this.db.query<PgTunnelRow>(
          `SELECT * FROM port_forward_tunnels
            WHERE user_id = $1 AND status = 'active' AND expires_at > $2
              AND (listen_server_id = $3 OR target_server_id = $3)
            ORDER BY created_at ASC
            LIMIT $4`,
          [userId, now, filterServerId, PORT_FORWARD_LIMITS.MAX_LIST_TUNNELS],
        )
      : await this.db.query<PgTunnelRow>(
          `SELECT * FROM port_forward_tunnels
            WHERE user_id = $1 AND status = 'active' AND expires_at > $2
            ORDER BY created_at ASC
            LIMIT $3`,
          [userId, now, PORT_FORWARD_LIMITS.MAX_LIST_TUNNELS],
        );
    return rows.map((row) => tunnelRecordToSummary(rowToTunnelRecord(row)));
  }

  async listOpenTunnelsForUser(userId: string, filterServerId?: string): Promise<PortForwardClusterTunnelRecord[]> {
    const rows = filterServerId
      ? await this.db.query<PgTunnelRow>(
          `SELECT * FROM port_forward_tunnels
            WHERE user_id = $1 AND status <> 'closed'
              AND (listen_server_id = $2 OR target_server_id = $2)`,
          [userId, filterServerId],
        )
      : await this.db.query<PgTunnelRow>(
          `SELECT * FROM port_forward_tunnels WHERE user_id = $1 AND status <> 'closed'`,
          [userId],
        );
    return rows.map(rowToTunnelRecord);
  }

  async listOpenTunnelsForEndpoint(serverId: string, generation: number, podId?: string): Promise<PortForwardClusterTunnelRecord[]> {
    const rows = podId
      ? await this.db.query<PgTunnelRow>(
          `SELECT * FROM port_forward_tunnels
            WHERE status <> 'closed'
              AND ((listen_server_id = $1 AND listen_pod_id = $2 AND listen_generation = $3)
                OR (target_server_id = $1 AND target_pod_id = $2 AND target_generation = $3))`,
          [serverId, podId, generation],
        )
      : await this.db.query<PgTunnelRow>(
          `SELECT * FROM port_forward_tunnels
            WHERE status <> 'closed'
              AND ((listen_server_id = $1 AND listen_generation = $2)
                OR (target_server_id = $1 AND target_generation = $2))`,
          [serverId, generation],
        );
    return rows.map(rowToTunnelRecord);
  }

  async getQueuedBytes(
    tunnelId: string,
    direction: PortForwardRelayDirection,
    hop?: PortForwardRelayHop,
  ): Promise<number> {
    const row = hop
      ? await this.db.queryOne<{ total: number | string }>(
          `SELECT COALESCE(SUM(byte_size), 0)::int AS total
             FROM port_forward_bus_messages
            WHERE tunnel_id = $1 AND direction = $2 AND kind = $3 AND (expires_at = 0 OR expires_at > $4)`,
          [tunnelId, direction, hop, Date.now()],
        )
      : await this.db.queryOne<{ total: number | string }>(
          `SELECT COALESCE(SUM(byte_size), 0)::int AS total
             FROM port_forward_bus_messages
            WHERE tunnel_id = $1 AND direction = $2 AND (expires_at = 0 OR expires_at > $3)`,
          [tunnelId, direction, Date.now()],
        );
    return Number(row?.total ?? 0);
  }

  async cleanupTunnelMessages(tunnelId: string): Promise<void> {
    await this.db.execute(
      `DELETE FROM port_forward_bus_messages
        WHERE tunnel_id = $1 AND kind IN ('to_endpoint', 'to_coordinator')`,
      [tunnelId],
    );
  }

  async reclaimStaleMessages(now = Date.now()): Promise<number> {
    const closeExpiresAt = now + PORT_FORWARD_LIMITS.CLUSTER_RELAY_MSG_TTL_MS;
    const row = await this.db.queryOne<{ deleted_count: number | string; notified_pods: string[] | null }>(
      `WITH deleted AS (
         DELETE FROM port_forward_bus_messages m
          WHERE (m.expires_at > 0 AND m.expires_at <= $1::bigint)
             OR (m.tunnel_id IS NOT NULL AND m.kind IN ('to_endpoint', 'to_coordinator') AND EXISTS (
               SELECT 1 FROM port_forward_tunnels t
                WHERE t.tunnel_id = m.tunnel_id AND (t.status = 'closed' OR t.expires_at <= $1::bigint)
             ))
          RETURNING m.seq,
            CASE
              WHEN m.expires_at > 0 AND m.expires_at <= $1::bigint
               AND m.byte_size > 0
               AND m.kind IN ('to_endpoint', 'to_coordinator')
               AND m.tunnel_id IS NOT NULL
              THEN m.tunnel_id
              ELSE NULL
            END AS expired_tunnel_id
       ),
       inserted_close AS (
         INSERT INTO port_forward_bus_messages (
           target_pod_id, kind, tunnel_id, direction, byte_size, expires_at, payload, created_at
         )
         SELECT DISTINCT
           t.coordinator_pod_id,
           'close_tunnel',
           t.tunnel_id,
           NULL,
           0,
           $2::bigint,
           jsonb_build_object('kind', 'close_tunnel', 'tunnelId', t.tunnel_id, 'reason', 'relay_message_expired'),
           $1::bigint
         FROM deleted d
         JOIN port_forward_tunnels t ON t.tunnel_id = d.expired_tunnel_id
         WHERE d.expired_tunnel_id IS NOT NULL
           AND t.status NOT IN ('closing', 'closed')
         RETURNING target_pod_id
       )
       SELECT
         (SELECT COUNT(*)::int FROM deleted) AS deleted_count,
         ARRAY(SELECT DISTINCT target_pod_id FROM inserted_close) AS notified_pods`,
      [now, closeExpiresAt],
    );
    for (const coordinatorPodId of row?.notified_pods ?? []) {
      await this.notifyPod(coordinatorPodId);
    }
    return Number(row?.deleted_count ?? 0);
  }

  async setPodDrainPausedForTests(podId: string, paused: boolean): Promise<void> {
    if (paused) {
      this.pausedPods.add(podId);
    } else {
      this.pausedPods.delete(podId);
      this.listeners.get(podId)?.wake();
    }
  }

  subscribePod(podId: string, handler: PortForwardClusterBusHandler): () => void {
    this.subscribers.set(podId, handler);
    return () => {
      if (this.subscribers.get(podId) === handler) this.subscribers.delete(podId);
    };
  }

  async sendToPod(targetPodId: string, message: PortForwardClusterBusMessage): Promise<void> {
    await this.enqueueBusMessage(targetPodId, message);
  }

  async enqueueBusMessage(
    targetPodId: string,
    message: PortForwardClusterBusMessage,
  ): Promise<PortForwardClusterEnqueueResult> {
    const now = Date.now();
    const acc = classifyRelayAccounting(message);
    const expiresAt = now + PORT_FORWARD_LIMITS.CLUSTER_RELAY_MSG_TTL_MS;

    if (acc.isRelayData && acc.tunnelId && acc.direction && acc.hop) {
      const hop = acc.hop;
      const notifiedPods = new Set<string>();
      const result = await this.db.transaction(async (tx): Promise<PortForwardClusterEnqueueResult> => {
        await tx.execute('SELECT pg_advisory_xact_lock($1::bigint)', [
          advisoryLockKey64(`pf_q:${acc.tunnelId}:${acc.direction}:${hop}`),
        ]);
        const expiredRow = await tx.queryOne<{ notified_pods: string[] | null }>(
          `WITH deleted AS (
             DELETE FROM port_forward_bus_messages m
              WHERE (m.expires_at > 0 AND m.expires_at <= $1::bigint)
                 OR (m.tunnel_id = $2::text AND m.kind IN ('to_endpoint', 'to_coordinator') AND EXISTS (
                   SELECT 1 FROM port_forward_tunnels t WHERE t.tunnel_id = $2::text AND t.status = 'closed'
                 ))
              RETURNING CASE
                WHEN m.expires_at > 0 AND m.expires_at <= $1::bigint
                 AND m.byte_size > 0
                 AND m.kind IN ('to_endpoint', 'to_coordinator')
                 AND m.tunnel_id IS NOT NULL
                THEN m.tunnel_id
                ELSE NULL
              END AS expired_tunnel_id
           ),
           inserted_close AS (
             INSERT INTO port_forward_bus_messages (
               target_pod_id, kind, tunnel_id, direction, byte_size, expires_at, payload, created_at
             )
             SELECT DISTINCT
               t.coordinator_pod_id,
               'close_tunnel',
               t.tunnel_id,
               NULL,
               0,
               $3::bigint,
               jsonb_build_object('kind', 'close_tunnel', 'tunnelId', t.tunnel_id, 'reason', 'relay_message_expired'),
               $1::bigint
             FROM deleted d
             JOIN port_forward_tunnels t ON t.tunnel_id = d.expired_tunnel_id
             WHERE d.expired_tunnel_id IS NOT NULL
               AND t.status NOT IN ('closing', 'closed')
             RETURNING target_pod_id
           )
           SELECT ARRAY(SELECT DISTINCT target_pod_id FROM inserted_close) AS notified_pods`,
          [now, acc.tunnelId, expiresAt],
        );
        for (const p of expiredRow?.notified_pods ?? []) {
          notifiedPods.add(p);
        }
        const row = await tx.queryOne<{ total: number | string }>(
          `SELECT COALESCE(SUM(byte_size), 0)::int AS total
             FROM port_forward_bus_messages
            WHERE tunnel_id = $1 AND direction = $2 AND kind = $3`,
          [acc.tunnelId, acc.direction, hop],
        );
        const currentBytes = Number(row?.total ?? 0);
        if (currentBytes + acc.byteSize > PORT_FORWARD_LIMITS.CLUSTER_RELAY_HARD_CAP_BYTES) {
          return { ok: false, overflow: true, queuedBytes: currentBytes };
        }
        await tx.execute(
          `INSERT INTO port_forward_bus_messages (target_pod_id, kind, tunnel_id, direction, byte_size, expires_at, payload, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
          [
            targetPodId,
            message.kind,
            acc.tunnelId,
            acc.direction,
            acc.byteSize,
            expiresAt,
            JSON.stringify(message),
            now,
          ],
        );
        const totalAfter = currentBytes + acc.byteSize;
        return {
          ok: true,
          queuedBytes: totalAfter,
          highWater: totalAfter >= PORT_FORWARD_LIMITS.CLUSTER_RELAY_HIGH_WATER_BYTES,
        };
      });
      for (const p of notifiedPods) {
        await this.notifyPod(p);
      }
      if (!result.ok) return result;
      await this.notifyPod(targetPodId);
      return result;
    }

    await this.db.execute(
      `INSERT INTO port_forward_bus_messages (target_pod_id, kind, tunnel_id, direction, byte_size, expires_at, payload, created_at)
       VALUES ($1, $2, $3, $4, 0, $5, $6::jsonb, $7)`,
      [
        targetPodId,
        message.kind,
        acc.tunnelId ?? null,
        acc.direction ?? null,
        expiresAt,
        JSON.stringify(message),
        now,
      ],
    );
    await this.notifyPod(targetPodId);
    return { ok: true, queuedBytes: 0, highWater: false };
  }

  private async notifyPod(targetPodId: string): Promise<void> {
    try {
      await this.db.execute('SELECT pg_notify($1, $2)', [PG_BUS_CHANNEL, targetPodId]);
    } catch {
      // Poller fallback drains queued messages even if pg_notify fails.
    }
    this.listeners.get(targetPodId)?.wake();
  }

  async start(podId: string, handler: PortForwardClusterBusHandler): Promise<void> {
    this.subscribePod(podId, handler);
    if (this.listeners.has(podId)) return;

    let stopped = false;
    let draining = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pgClient: PgClient | null = null;

    const drainPod = async () => {
      if (stopped || draining || this.pausedPods.has(podId)) return;
      draining = true;
      try {
        const drainNow = Date.now();
        const drainCloseExpiresAt = drainNow + PORT_FORWARD_LIMITS.CLUSTER_RELAY_MSG_TTL_MS;
        const expiredRow = await this.db.queryOne<{ notified_pods: string[] | null }>(
          `WITH deleted AS (
             DELETE FROM port_forward_bus_messages
              WHERE target_pod_id = $1::text AND expires_at > 0 AND expires_at <= $2::bigint
              RETURNING CASE
                WHEN byte_size > 0 AND kind IN ('to_endpoint', 'to_coordinator') AND tunnel_id IS NOT NULL
                THEN tunnel_id
                ELSE NULL
              END AS expired_tunnel_id
           ),
           inserted_close AS (
             INSERT INTO port_forward_bus_messages (
               target_pod_id, kind, tunnel_id, direction, byte_size, expires_at, payload, created_at
             )
             SELECT DISTINCT
               t.coordinator_pod_id,
               'close_tunnel',
               t.tunnel_id,
               NULL,
               0,
               $3::bigint,
               jsonb_build_object('kind', 'close_tunnel', 'tunnelId', t.tunnel_id, 'reason', 'relay_message_expired'),
               $2::bigint
             FROM deleted d
             JOIN port_forward_tunnels t ON t.tunnel_id = d.expired_tunnel_id
             WHERE d.expired_tunnel_id IS NOT NULL
               AND t.status NOT IN ('closing', 'closed')
             RETURNING target_pod_id
           )
           SELECT ARRAY(SELECT DISTINCT target_pod_id FROM inserted_close) AS notified_pods`,
          [podId, drainNow, drainCloseExpiresAt],
        );
        for (const p of expiredRow?.notified_pods ?? []) {
          await this.notifyPod(p);
        }
        for (;;) {
          if (stopped || this.pausedPods.has(podId)) break;
          const rows = await this.db.query<{
            seq: number | string;
            kind: string;
            tunnel_id: string | null;
            direction: PortForwardRelayDirection | null;
            byte_size: number;
            payload: PortForwardClusterBusMessage;
          }>(
            `DELETE FROM port_forward_bus_messages
              WHERE seq IN (
                SELECT seq FROM port_forward_bus_messages
                 WHERE target_pod_id = $1
                 ORDER BY seq ASC
                 LIMIT 32
              )
              RETURNING seq, kind, tunnel_id, direction, byte_size, payload`,
            [podId],
          );
          if (rows.length === 0) break;
          rows.sort((a, b) => Number(a.seq) - Number(b.seq));
          const drainedPairs = new Map<string, {
            tunnelId: string;
            direction: PortForwardRelayDirection;
            hop: PortForwardRelayHop;
            coordinatorPodId?: string;
          }>();

          for (const row of rows) {
            const payload = typeof row.payload === 'string'
              ? JSON.parse(row.payload) as PortForwardClusterBusMessage
              : row.payload;
            const hop = row.kind === 'to_coordinator' || row.kind === 'to_endpoint' ? row.kind : null;
            if (row.tunnel_id && row.direction && hop && Number(row.byte_size) > 0) {
              drainedPairs.set(`${row.tunnel_id}:${row.direction}:${hop}`, {
                tunnelId: row.tunnel_id,
                direction: row.direction,
                hop,
                coordinatorPodId: payload.kind === 'to_endpoint' ? payload.coordinatorPodId : undefined,
              });
            }
            await handler(payload);
          }

          for (const pair of drainedPairs.values()) {
            const remainingBytes = await this.getQueuedBytes(pair.tunnelId, pair.direction, pair.hop);
            if (remainingBytes <= PORT_FORWARD_LIMITS.CLUSTER_RELAY_LOW_WATER_BYTES) {
              const coordinatorPodId = pair.coordinatorPodId
                ?? (await this.getTunnel(pair.tunnelId))?.coordinatorPodId;
              if (coordinatorPodId) {
                await this.enqueueBusMessage(coordinatorPodId, {
                  kind: 'relay_drained',
                  tunnelId: pair.tunnelId,
                  direction: pair.direction,
                  hop: pair.hop,
                  queuedBytes: remainingBytes,
                });
              }
            }
          }
          if (rows.length < 32) break;
        }
      } catch {
        // Retry cleanly on next wake / poll tick.
      } finally {
        draining = false;
      }
    };

    const schedulePoll = (delayMs: number) => {
      if (stopped || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void drainPod().finally(() => schedulePoll(25));
      }, delayMs);
      timer.unref?.();
    };

    const connStr = this.connectionString;
    if (connStr) {
      const connectListener = async () => {
        if (stopped) return;
        const pgMod = await import('pg');
        if (stopped) return;
        const ClientCtor = (pgMod.default?.Client ?? pgMod.Client) as (new (opts: { connectionString: string }) => PgClient) | undefined;
        if (!ClientCtor) return;
        const client = new ClientCtor({ connectionString: connStr });
        pgClient = client;
        client.on('notification', (n) => {
          if (n.channel === PG_BUS_CHANNEL && (!n.payload || n.payload === podId)) {
            void drainPod();
          }
        });
        client.on('error', () => {
          if (pgClient === client) {
            pgClient = null;
            void client.end().catch(() => {});
          }
        });
        try {
          await client.connect();
          if (stopped) {
            await client.end().catch(() => {});
            return;
          }
          await client.query(`LISTEN ${PG_BUS_CHANNEL}`);
          void drainPod();
        } catch {
          if (pgClient === client) pgClient = null;
          await client.end().catch(() => {});
        }
      };
      void connectListener();
    }

    schedulePoll(10);
    this.listeners.set(podId, {
      wake: () => { void drainPod(); },
      stop: async () => {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        const c = pgClient;
        pgClient = null;
        if (c) await c.end().catch(() => {});
        this.pausedPods.delete(podId);
        this.subscribers.delete(podId);
      },
    });
  }

  async stop(podId: string): Promise<void> {
    const entry = this.listeners.get(podId);
    if (entry) {
      this.listeners.delete(podId);
      await entry.stop();
    }
    this.pausedPods.delete(podId);
    this.subscribers.delete(podId);
    await this.db.execute(
      `DELETE FROM port_forward_bus_messages WHERE target_pod_id = $1 AND kind = 'to_endpoint'`,
      [podId],
    ).catch(() => {});
  }
}

export const PORT_FORWARD_CLUSTER_ERRORS = PORT_FORWARD_ERRORS;
