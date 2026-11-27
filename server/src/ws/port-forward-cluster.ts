import { createHash } from 'node:crypto';
import pg from 'pg';
import type { Database } from '../db/client.js';
import {
  PORT_FORWARD_ERRORS,
  PORT_FORWARD_LIMITS,
  type PortForwardTransport,
  type PortForwardTransportPref,
  type PortForwardTunnelSummary,
  type PortForwardWireMessage,
} from '../../../shared/port-forward.js';

export type PortForwardClusterStatus = 'preparing' | 'connecting' | 'active' | 'closed';

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
  listenGeneration: number;
  requestedListenPort: number;
  boundListenPort: number | null;
  targetNode: string;
  targetServerId: string;
  targetNodeId?: string;
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

export type PortForwardClusterBusMessage =
  | {
      kind: 'to_endpoint';
      serverId: string;
      expectedGeneration: number;
      frame: PortForwardWireMessage;
    }
  | {
      kind: 'to_coordinator';
      tunnelId: string;
      fromServerId: string;
      fromGeneration: number;
      frame: PortForwardWireMessage;
    }
  | {
      kind: 'daemon_disconnected';
      tunnelId: string;
      serverId: string;
      generation: number;
    }
  | {
      kind: 'close_tunnel';
      tunnelId: string;
      reason: string;
    };

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
      'status' | 'transportMode' | 'boundListenPort' | 'activeConnections' | 'bytesSent' | 'bytesReceived' | 'updatedAt'
    >>,
  ): Promise<void>;
  markTunnelClosed(tunnelId: string, updatedAt?: number): Promise<void>;
  getTunnel(tunnelId: string): Promise<PortForwardClusterTunnelRecord | null>;
  listActiveTunnels(userId: string, filterServerId?: string): Promise<PortForwardTunnelSummary[]>;
  listOpenTunnelsForUser(userId: string, filterServerId?: string): Promise<PortForwardClusterTunnelRecord[]>;
  listOpenTunnelsForEndpoint(serverId: string, generation: number): Promise<PortForwardClusterTunnelRecord[]>;
  subscribePod(podId: string, handler: PortForwardClusterBusHandler): () => void;
  sendToPod(targetPodId: string, message: PortForwardClusterBusMessage): Promise<void>;
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

/**
 * In-memory authoritative cluster store & pod message bus.
 * Shared across multiple pod instances in multi-pod unit tests, or used
 * per-router as default standalone store when no database is attached.
 */
export class InMemoryPortForwardClusterStore implements PortForwardClusterStore {
  private readonly endpoints = new Map<string, PortForwardEndpointPresence>();
  private readonly tunnels = new Map<string, PortForwardClusterTunnelRecord>();
  private readonly subscribers = new Map<string, PortForwardClusterBusHandler>();

  async registerEndpoint(podId: string, serverId: string, generation: number): Promise<void> {
    this.endpoints.set(serverId, { serverId, podId, generation, updatedAt: Date.now() });
  }

  async unregisterEndpoint(podId: string, serverId: string, generation: number): Promise<void> {
    const existing = this.endpoints.get(serverId);
    if (existing && existing.podId === podId && existing.generation === generation) {
      this.endpoints.delete(serverId);
    }
  }

  async getEndpoint(serverId: string): Promise<PortForwardEndpointPresence | null> {
    return this.endpoints.get(serverId) ?? null;
  }

  async tryCreateTunnel(record: PortForwardClusterTunnelRecord): Promise<{ ok: true } | { ok: false; error: string }> {
    const now = Date.now();
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
      'status' | 'transportMode' | 'boundListenPort' | 'activeConnections' | 'bytesSent' | 'bytesReceived' | 'updatedAt'
    >>,
  ): Promise<void> {
    const existing = this.tunnels.get(tunnelId);
    if (!existing) return;
    Object.assign(existing, patch);
  }

  async markTunnelClosed(tunnelId: string, updatedAt = Date.now()): Promise<void> {
    const existing = this.tunnels.get(tunnelId);
    if (!existing) return;
    existing.status = 'closed';
    existing.updatedAt = updatedAt;
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

  async listOpenTunnelsForEndpoint(serverId: string, generation: number): Promise<PortForwardClusterTunnelRecord[]> {
    const out: PortForwardClusterTunnelRecord[] = [];
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.status === 'closed') continue;
      const matchesListen = tunnel.listenServerId === serverId && tunnel.listenGeneration === generation;
      const matchesTarget = tunnel.targetServerId === serverId && tunnel.targetGeneration === generation;
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

  async sendToPod(targetPodId: string, message: PortForwardClusterBusMessage): Promise<void> {
    const handler = this.subscribers.get(targetPodId);
    if (!handler) return;
    queueMicrotask(() => {
      void handler(message);
    });
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
  listen_generation: number | string;
  requested_listen_port: number;
  bound_listen_port: number | null;
  target_node: string;
  target_server_id: string;
  target_node_id: string | null;
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
    listenGeneration: Number(row.listen_generation),
    requestedListenPort: row.requested_listen_port,
    boundListenPort: row.bound_listen_port,
    targetNode: row.target_node,
    targetServerId: row.target_server_id,
    ...(row.target_node_id ? { targetNodeId: row.target_node_id } : {}),
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
 * Authoritative PostgreSQL-backed cluster store & cross-pod bus.
 * Uses `port_forward_endpoints`, `port_forward_tunnels`, and `port_forward_bus_messages`
 * with PG advisory locks for cross-pod quota integrity and `pg_notify` + polling fallback.
 */
export class PostgresPortForwardClusterStore implements PortForwardClusterStore {
  private readonly subscribers = new Map<string, PortForwardClusterBusHandler>();
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
      // Acquire deterministic sorted advisory locks for user + listen + target servers so concurrent pods serialize quota checks cleanly.
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
           listen_node, listen_server_id, listen_node_id, listen_generation,
           requested_listen_port, bound_listen_port,
           target_node, target_server_id, target_node_id, target_generation,
           target_host, target_port, transport_pref, transport_mode,
           status, active_connections, bytes_sent, bytes_received, label,
           created_at, expires_at, updated_at
         ) VALUES (
           $1, $2, $3,
           $4, $5, $6, $7,
           $8, $9,
           $10, $11, $12, $13,
           $14, $15, $16, $17,
           $18, $19, $20, $21, $22,
           $23, $24, $25
         )`,
        [
          record.tunnelId,
          record.userId,
          record.coordinatorPodId,
          record.listenNode,
          record.listenServerId,
          record.listenNodeId ?? null,
          record.listenGeneration,
          record.requestedListenPort,
          record.boundListenPort,
          record.targetNode,
          record.targetServerId,
          record.targetNodeId ?? null,
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
      'status' | 'transportMode' | 'boundListenPort' | 'activeConnections' | 'bytesSent' | 'bytesReceived' | 'updatedAt'
    >>,
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
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

  async listOpenTunnelsForEndpoint(serverId: string, generation: number): Promise<PortForwardClusterTunnelRecord[]> {
    const rows = await this.db.query<PgTunnelRow>(
      `SELECT * FROM port_forward_tunnels
        WHERE status <> 'closed'
          AND ((listen_server_id = $1 AND listen_generation = $2)
            OR (target_server_id = $1 AND target_generation = $2))`,
      [serverId, generation],
    );
    return rows.map(rowToTunnelRecord);
  }

  subscribePod(podId: string, handler: PortForwardClusterBusHandler): () => void {
    this.subscribers.set(podId, handler);
    return () => {
      if (this.subscribers.get(podId) === handler) this.subscribers.delete(podId);
    };
  }

  async sendToPod(targetPodId: string, message: PortForwardClusterBusMessage): Promise<void> {
    const localHandler = this.subscribers.get(targetPodId);
    if (localHandler) {
      queueMicrotask(() => {
        void localHandler(message);
      });
      return;
    }
    await this.db.execute(
      `INSERT INTO port_forward_bus_messages (target_pod_id, kind, payload, created_at)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [targetPodId, message.kind, JSON.stringify(message), Date.now()],
    );
    try {
      await this.db.execute('SELECT pg_notify($1, $2)', [PG_BUS_CHANNEL, targetPodId]);
    } catch {
      // Poller fallback drains queued messages even if pg_notify fails.
    }
    const localListener = this.listeners.get(targetPodId);
    localListener?.wake();
  }

  async start(podId: string, handler: PortForwardClusterBusHandler): Promise<void> {
    this.subscribePod(podId, handler);
    if (this.listeners.has(podId)) return;

    let stopped = false;
    let draining = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pgClient: pg.Client | null = null;

    const drainPod = async () => {
      if (stopped || draining) return;
      draining = true;
      try {
        for (;;) {
          if (stopped) break;
          const rows = await this.db.query<{ seq: number | string; payload: PortForwardClusterBusMessage }>(
            `DELETE FROM port_forward_bus_messages
              WHERE seq IN (
                SELECT seq FROM port_forward_bus_messages
                 WHERE target_pod_id = $1
                 ORDER BY seq ASC
                 LIMIT 64
              )
              RETURNING seq, payload`,
            [podId],
          );
          if (rows.length === 0) break;
          rows.sort((a, b) => Number(a.seq) - Number(b.seq));
          for (const row of rows) {
            const payload = typeof row.payload === 'string'
              ? JSON.parse(row.payload) as PortForwardClusterBusMessage
              : row.payload;
            await handler(payload);
          }
          if (rows.length < 64) break;
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

    if (this.connectionString) {
      const connectListener = async () => {
        if (stopped) return;
        const client = new pg.Client({ connectionString: this.connectionString });
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
    this.subscribers.delete(podId);
  }
}

export const PORT_FORWARD_CLUSTER_ERRORS = PORT_FORWARD_ERRORS;
