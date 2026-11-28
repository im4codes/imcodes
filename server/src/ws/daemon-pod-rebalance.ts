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
const DEFAULT_PG_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_PG_LISTEN_TIMEOUT_MS = 5_000;
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

export interface PgListenerClient {
  connect(): Promise<unknown>;
  query: (sql: string) => Promise<unknown>;
  on: (event: string, listener: (...args: any[]) => void) => void;
  end: () => Promise<unknown>;
}

export interface DaemonPodRebalancerOptions {
  podId?: () => string;
  now?: () => number;
  minConnectionAgeMs?: number;
  publishCooldownMs?: number;
  kickCooldownMs?: number;
  maxEventAgeMs?: number;
  maxTrackedEntries?: number;
  connectTimeoutMs?: number;
  listenTimeoutMs?: number;
  findBridge?: (serverId: string) => RebalanceBridgeTarget | undefined;
  pgClientFactory?: (connectionString: string) => PgListenerClient;
}

type QueryableDb = Pick<Database, 'query'>;

function isPostgresUrl(connectionString: string | undefined): connectionString is string {
  if (!connectionString) return false;
  const trimmed = connectionString.trim().toLowerCase();
  return trimmed.startsWith('postgres://') || trimmed.startsWith('postgresql://');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  private readonly connectTimeoutMs: number;
  private readonly listenTimeoutMs: number;
  private readonly findBridge: (serverId: string) => RebalanceBridgeTarget | undefined;
  private readonly pgClientFactory?: (connectionString: string) => PgListenerClient;

  private readonly publishCooldowns = new Map<string, number>();
  private readonly kickCooldowns = new Map<string, number>();
  private readonly retiredClients = new WeakSet<PgListenerClient>();

  private running = false;
  private startGeneration = 0;
  private pgListening = false;
  private connectionString: string | undefined;
  private db: QueryableDb | null = null;
  private listenerClient: PgListenerClient | null = null;
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
    this.connectTimeoutMs = options?.connectTimeoutMs ?? DEFAULT_PG_CONNECT_TIMEOUT_MS;
    this.listenTimeoutMs = options?.listenTimeoutMs ?? DEFAULT_PG_LISTEN_TIMEOUT_MS;
    this.findBridge = options?.findBridge ?? ((serverId) => WsBridge.find(serverId));
    this.pgClientFactory = options?.pgClientFactory;
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
    this.stopReconnectTimer();
    const prevClient = this.listenerClient;
    this.listenerClient = null;
    this.startGeneration += 1;
    this.pgListening = false;
    this.connectionString = connectionString;
    this.db = db ?? null;
    this.running = true;
    this.reconnectAttempts = 0;
    const gen = this.startGeneration;
    if (prevClient) {
      await this.retireClient(prevClient);
    }
    if (!this.running || gen !== this.startGeneration || !isPostgresUrl(connectionString)) {
      return;
    }
    await this.connectPgListener(gen);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.startGeneration += 1;
    this.pgListening = false;
    this.connectionString = undefined;
    this.db = null;
    this.stopReconnectTimer();
    const client = this.listenerClient;
    this.listenerClient = null;
    await this.retireClient(client);
    this.publishCooldowns.clear();
    this.kickCooldowns.clear();
  }

  /**
   * Request a cross-pod daemon rebalance when an authenticated `/api/server/:serverId/...`
   * request on Pod B observes `!isDaemonConnected()` or `daemon_offline` for `serverId`.
   * Rate-limited per `serverId`, gated on an active PostgreSQL runtime, and fire-and-forget.
   */
  requestDaemonRebalance(serverId: string, dbOverride?: Partial<QueryableDb> | null): void {
    if (typeof serverId !== 'string' || serverId.length === 0) return;
    if (!this.running || !isPostgresUrl(this.connectionString)) return;

    const now = this.getNow();
    const lastPublished = this.publishCooldowns.get(serverId);
    if (lastPublished !== undefined && now - lastPublished < this.publishCooldownMs) {
      return;
    }

    const queryable: QueryableDb | null = (this.db && typeof this.db.query === 'function')
      ? this.db
      : (dbOverride && typeof dbOverride.query === 'function')
        ? (dbOverride as QueryableDb)
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

  private stopReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async createClient(connectionString: string): Promise<PgListenerClient> {
    if (this.pgClientFactory) {
      return this.pgClientFactory(connectionString);
    }
    const pgModule = await import('pg');
    const driver = (pgModule as unknown as {
      default?: { Client: new (opts: { connectionString: string }) => PgListenerClient };
      Client?: new (opts: { connectionString: string }) => PgListenerClient;
    }).default ?? (pgModule as unknown as {
      Client: new (opts: { connectionString: string }) => PgListenerClient;
    });
    return new driver.Client!({ connectionString });
  }

  private retireClient(client: PgListenerClient | null): Promise<void> {
    if (!client) return Promise.resolve();
    if (this.listenerClient === client) {
      this.listenerClient = null;
      this.pgListening = false;
    }
    if (this.retiredClients.has(client)) return Promise.resolve();
    this.retiredClients.add(client);
    try {
      return Promise.resolve(client.end()).then(() => undefined, () => undefined);
    } catch {
      return Promise.resolve();
    }
  }

  private isActiveClient(gen: number, client: PgListenerClient): boolean {
    return this.running && gen === this.startGeneration && this.listenerClient === client;
  }

  private async connectPgListener(gen: number): Promise<void> {
    if (!this.running || gen !== this.startGeneration || !isPostgresUrl(this.connectionString)) {
      return;
    }
    let client: PgListenerClient | null = null;
    try {
      client = await this.createClient(this.connectionString);
      if (!this.running || gen !== this.startGeneration) {
        await this.retireClient(client);
        return;
      }
      this.listenerClient = client;

      client.on('notification', (msg: { channel?: string; payload?: string }) => {
        if (!client || !this.isActiveClient(gen, client)) return;
        if (msg.channel !== DAEMON_REBALANCE_NOTIFY_CHANNEL || !msg.payload) return;
        this.handleNotificationPayload(msg.payload);
      });

      const onDisconnect = () => {
        if (!client) return;
        const wasCurrent = this.isActiveClient(gen, client);
        void this.retireClient(client);
        if (wasCurrent) {
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

      await withTimeout(
        client.connect(),
        this.connectTimeoutMs,
        'daemon_rebalance_pg_connect_timeout',
      );
      if (!this.isActiveClient(gen, client)) {
        await this.retireClient(client);
        return;
      }

      await withTimeout(
        client.query(`LISTEN ${DAEMON_REBALANCE_NOTIFY_CHANNEL}`),
        this.listenTimeoutMs,
        'daemon_rebalance_pg_listen_timeout',
      );
      if (!this.isActiveClient(gen, client)) {
        await this.retireClient(client);
        return;
      }

      this.pgListening = true;
      this.reconnectAttempts = 0;
    } catch (err) {
      await this.retireClient(client);
      if (!this.running || gen !== this.startGeneration) {
        return;
      }
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
