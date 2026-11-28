import type { Database } from '../db/client.js';
import { getPodIdentity } from '../util/pod-identity.js';
import logger from '../util/logger.js';
import { WsBridge } from './bridge.js';

/** PostgreSQL NOTIFY/LISTEN channel carrying daemon WS rebalance hints across pods. */
export const DAEMON_REBALANCE_NOTIFY_CHANNEL = 'imcodes_daemon_rebalance';

/** RFC 6455 Service Restart — triggers prompt, clean daemon reconnect without credential revocation. */
export const DAEMON_REBALANCE_WS_CLOSE_CODE = 1012;
export const DAEMON_REBALANCE_WS_CLOSE_REASON = 'pod_rebalance';

const DEFAULT_MIN_CONNECTION_AGE_MS = 5_000;
const DEFAULT_PUBLISH_COOLDOWN_MS = 15_000;
const DEFAULT_KICK_COOLDOWN_MS = 15_000;
const DEFAULT_MAX_EVENT_AGE_MS = 30_000;
const DEFAULT_MAX_TRACKED_ENTRIES = 4_096;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface DaemonRebalanceNotification {
  serverId: string;
  requesterPodId: string;
  ts: number;
}

export interface RebalanceBridgeTarget {
  rebalanceDaemonConnection(minConnectionAgeMs?: number, requesterPodId?: string, now?: number): boolean;
}

export interface DaemonPodRebalancerOptions {
  podId?: () => string;
  now?: () => number;
  minConnectionAgeMs?: number;
  publishCooldownMs?: number;
  kickCooldownMs?: number;
  maxEventAgeMs?: number;
  maxTrackedEntries?: number;
  findBridge?: (serverId: string) => RebalanceBridgeTarget | undefined;
}

type QueryableDb = Pick<Database, 'query'>;

function isPostgresUrl(connectionString: string | undefined): connectionString is string {
  if (!connectionString) return false;
  const trimmed = connectionString.trim().toLowerCase();
  return trimmed.startsWith('postgres://') || trimmed.startsWith('postgresql://');
}

function recordBoundedTimestamp(
  map: Map<string, number>,
  key: string,
  now: number,
  ttlMs: number,
  maxEntries: number,
): void {
  if (maxEntries <= 0) return;
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxEntries) {
    for (const [existingKey, ts] of map) {
      if (now - ts >= ttlMs) {
        map.delete(existingKey);
      }
      if (map.size < maxEntries) break;
    }
    while (map.size >= maxEntries) {
      const oldestKey = map.keys().next().value;
      if (oldestKey === undefined) break;
      map.delete(oldestKey);
    }
  }
  map.set(key, now);
}

/**
 * Coordinates cross-pod daemon WebSocket rebalancing via PostgreSQL LISTEN/NOTIFY
 * when consistent-hash ring drift leaves a daemon pinned on Pod A while browser/HTTP
 * traffic for that server lands on Pod B.
 */
export class DaemonPodRebalancer {
  private readonly getPodId: () => string;
  private readonly getNow: () => number;
  private readonly minConnectionAgeMs: number;
  private readonly publishCooldownMs: number;
  private readonly kickCooldownMs: number;
  private readonly maxEventAgeMs: number;
  private readonly maxTrackedEntries: number;
  private readonly findBridge: (serverId: string) => RebalanceBridgeTarget | undefined;

  private readonly publishCooldowns = new Map<string, number>();
  private readonly kickCooldowns = new Map<string, number>();

  private running = false;
  private startGeneration = 0;
  private pgListening = false;
  private connectionString: string | undefined;
  private db: QueryableDb | null = null;
  private listenerClient: {
    query: (sql: string) => Promise<unknown>;
    on: (event: string, listener: (...args: any[]) => void) => void;
    end: () => Promise<unknown>;
  } | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  constructor(options?: DaemonPodRebalancerOptions) {
    this.getPodId = options?.podId ?? getPodIdentity;
    this.getNow = options?.now ?? (() => Date.now());
    this.minConnectionAgeMs = options?.minConnectionAgeMs ?? DEFAULT_MIN_CONNECTION_AGE_MS;
    this.publishCooldownMs = options?.publishCooldownMs ?? DEFAULT_PUBLISH_COOLDOWN_MS;
    this.kickCooldownMs = options?.kickCooldownMs ?? DEFAULT_KICK_COOLDOWN_MS;
    this.maxEventAgeMs = options?.maxEventAgeMs ?? DEFAULT_MAX_EVENT_AGE_MS;
    this.maxTrackedEntries = options?.maxTrackedEntries ?? DEFAULT_MAX_TRACKED_ENTRIES;
    this.findBridge = options?.findBridge ?? ((serverId) => WsBridge.find(serverId));
  }

  isPgListening(): boolean {
    return this.pgListening;
  }

  getPublishCooldownSize(): number {
    return this.publishCooldowns.size;
  }

  getKickCooldownSize(): number {
    return this.kickCooldowns.size;
  }

  async start(connectionString?: string, db?: Database): Promise<void> {
    this.connectionString = connectionString;
    this.db = db ?? null;
    this.running = true;
    const gen = ++this.startGeneration;
    if (!isPostgresUrl(connectionString)) {
      this.pgListening = false;
      return;
    }
    await this.connectPgListener(gen);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.startGeneration += 1;
    this.pgListening = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.listenerClient;
    this.listenerClient = null;
    if (client) {
      try {
        await client.end();
      } catch {
        // ignore listener shutdown errors
      }
    }
    this.publishCooldowns.clear();
    this.kickCooldowns.clear();
  }

  /**
   * Request a cross-pod daemon rebalance when an authenticated Pod B request
   * observes `!isDaemonConnected()` or `daemon_offline` for `serverId`.
   * Rate-limited per `serverId` and completely fire-and-forget.
   */
  requestDaemonRebalance(serverId: string, dbOverride?: Partial<QueryableDb> | null): void {
    if (typeof serverId !== 'string' || serverId.length === 0) return;

    const now = this.getNow();
    const lastPublished = this.publishCooldowns.get(serverId);
    if (lastPublished !== undefined && now - lastPublished < this.publishCooldownMs) {
      return;
    }

    const queryable: QueryableDb | null = (dbOverride && typeof dbOverride.query === 'function')
      ? (dbOverride as QueryableDb)
      : (this.db && typeof this.db.query === 'function')
        ? this.db
        : null;
    if (!queryable) return;

    recordBoundedTimestamp(
      this.publishCooldowns,
      serverId,
      now,
      this.publishCooldownMs,
      this.maxTrackedEntries,
    );

    const requesterPodId = this.getPodId();
    const payload = JSON.stringify({
      serverId,
      requesterPodId,
      ts: now,
    } satisfies DaemonRebalanceNotification);

    void queryable
      .query('SELECT pg_notify($1, $2)', [DAEMON_REBALANCE_NOTIFY_CHANNEL, payload])
      .catch((err) => {
        logger.debug({ serverId, requesterPodId, err }, 'Failed to publish daemon rebalance pg_notify (non-fatal)');
      });
  }

  /**
   * Process one PG NOTIFY payload on Pod A.
   * Returns true only if a sufficiently aged local daemon WS was closed.
   */
  handleNotificationPayload(raw: string): boolean {
    if (typeof raw !== 'string' || raw.length === 0) return false;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }

    if (!parsed || typeof parsed !== 'object') return false;
    const candidate = parsed as Partial<DaemonRebalanceNotification>;
    if (
      typeof candidate.serverId !== 'string'
      || candidate.serverId.length === 0
      || typeof candidate.requesterPodId !== 'string'
      || candidate.requesterPodId.length === 0
      || typeof candidate.ts !== 'number'
      || !Number.isFinite(candidate.ts)
    ) {
      return false;
    }

    const myPodId = this.getPodId();
    if (candidate.requesterPodId === myPodId) {
      return false;
    }

    const now = this.getNow();
    const eventAgeMs = now - candidate.ts;
    if (eventAgeMs > this.maxEventAgeMs) {
      return false;
    }

    const bridge = this.findBridge(candidate.serverId);
    if (!bridge) {
      return false;
    }

    const lastKick = this.kickCooldowns.get(candidate.serverId);
    if (lastKick !== undefined && now - lastKick < this.kickCooldownMs) {
      return false;
    }

    const closed = bridge.rebalanceDaemonConnection(
      this.minConnectionAgeMs,
      candidate.requesterPodId,
      now,
    );
    if (closed) {
      recordBoundedTimestamp(
        this.kickCooldowns,
        candidate.serverId,
        now,
        this.kickCooldownMs,
        this.maxTrackedEntries,
      );
    }
    return closed;
  }

  private async connectPgListener(gen: number): Promise<void> {
    if (!this.running || gen !== this.startGeneration || !isPostgresUrl(this.connectionString)) {
      return;
    }
    try {
      const pgModule = await import('pg');
      if (!this.running || gen !== this.startGeneration) return;
      const driver = (pgModule as {
        default?: { Client: new (opts: { connectionString: string }) => NonNullable<DaemonPodRebalancer['listenerClient']> };
        Client?: new (opts: { connectionString: string }) => NonNullable<DaemonPodRebalancer['listenerClient']>;
      }).default ?? (pgModule as unknown as {
        Client: new (opts: { connectionString: string }) => NonNullable<DaemonPodRebalancer['listenerClient']>;
      });

      const client = new driver.Client!({ connectionString: this.connectionString });
      this.listenerClient = client;

      client.on('notification', (msg: { channel?: string; payload?: string }) => {
        if (msg.channel !== DAEMON_REBALANCE_NOTIFY_CHANNEL || !msg.payload) return;
        this.handleNotificationPayload(msg.payload);
      });

      const onDisconnect = () => {
        if (this.listenerClient === client) {
          this.listenerClient = null;
          this.pgListening = false;
          try {
            void client.end();
          } catch {
            // ignore cleanup errors
          }
          this.schedulePgReconnect(gen);
        }
      };

      client.on('error', (err: unknown) => {
        logger.warn({ err }, 'Daemon rebalance PG LISTEN connection error');
        onDisconnect();
      });
      client.on('end', () => {
        onDisconnect();
      });

      await (client as unknown as { connect(): Promise<void> }).connect();
      if (!this.running || gen !== this.startGeneration) {
        try {
          await client.end();
        } catch {
          // ignore
        }
        return;
      }
      await client.query(`LISTEN ${DAEMON_REBALANCE_NOTIFY_CHANNEL}`);
      this.pgListening = true;
      this.reconnectAttempts = 0;
    } catch (err) {
      this.pgListening = false;
      this.listenerClient = null;
      logger.warn({ err }, 'Daemon rebalance PG LISTEN setup failed — retrying');
      this.schedulePgReconnect(gen);
    }
  }

  private schedulePgReconnect(gen: number): void {
    if (!this.running || gen !== this.startGeneration || !isPostgresUrl(this.connectionString)) {
      return;
    }
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 10);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectPgListener(gen);
    }, delay);
    this.reconnectTimer.unref?.();
  }
}

export const daemonPodRebalancer = new DaemonPodRebalancer();
