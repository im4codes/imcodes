import { createServer, type Server as HttpServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { WebSocket } from 'ws';

const mockPgClients: FakePgClient[] = [];
vi.mock('pg', () => ({
  default: {
    Client: class MockPgClient extends EventEmitter {
      connectCalls = 0;
      endCalls = 0;
      queries: string[] = [];
      constructor() {
        super();
        const self = this as unknown as FakePgClient;
        self.connect = async () => { self.connectCalls += 1; };
        self.query = async (sql: string) => { self.queries.push(sql); return { rows: [] }; };
        self.end = async () => { self.endCalls += 1; };
        mockPgClients.push(self);
      }
    },
  },
}));

import { buildApp, setupWebSocketUpgrade } from '../src/index.js';
import { WsBridge } from '../src/ws/bridge.js';
import { healthCheckCron } from '../src/cron/health-check.js';
import { globalTaskHub } from '../src/services/global-task-hub.js';
import {
  DAEMON_REBALANCE_NOTIFY_CHANNEL,
  DAEMON_REBALANCE_WS_CLOSE_CODE,
  DAEMON_REBALANCE_WS_CLOSE_REASON,
  DaemonPodRebalancer,
  daemonPodRebalancer,
  type PgListenerClient,
} from '../src/ws/daemon-pod-rebalance.js';
import { authenticateDaemonServer } from '../src/security/daemon-auth.js';
import { sha256Hex, signJwt } from '../src/security/crypto.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { USER_STATUS } from '../../shared/user-status.js';
import { SERVER_ID_HEADER } from '../../shared/http-header-names.js';
import { TRANSPORT_MSG } from '../../shared/transport-events.js';
import { environment as baseEnvironment, signingKey, token as daemonToken, key as apiKey, headers as daemonHeaders } from './helpers/daemon-token-env.js';

interface FakePgClient extends EventEmitter, PgListenerClient {
  connectCalls: number;
  endCalls: number;
  queries: string[];
}

class ControlledPgClient extends EventEmitter implements PgListenerClient {
  connectCalls = 0;
  endCalls = 0;
  queries: string[] = [];
  connectImpl: () => Promise<void> = async () => {};
  queryImpl: (sql: string) => Promise<unknown> = async () => ({ rows: [] });
  endImpl: () => Promise<unknown> = async () => {};

  async connect(): Promise<void> {
    this.connectCalls += 1;
    return this.connectImpl();
  }

  async query(sql: string): Promise<unknown> {
    this.queries.push(sql);
    return this.queryImpl(sql);
  }

  async end(): Promise<unknown> {
    this.endCalls += 1;
    return this.endImpl();
  }
}

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1; // WebSocket.OPEN
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(data: string | Buffer, _opts?: unknown, cb?: (err?: Error) => void) {
    if (this.closed) {
      const err = new Error('socket closed');
      if (cb) {
        cb(err);
        return;
      }
      throw err;
    }
    this.sent.push(data);
    cb?.();
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.readyState = 3; // WebSocket.CLOSED
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close', code, Buffer.from(reason ?? ''));
  }
}

async function flushAsync() {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => process.nextTick(r));
  }
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeBridgeAuthDb(secret = 'daemon-secret'): Database {
  const tokenHash = sha256Hex(secret);
  const db = {
    queryOne: async (sql: string) => {
      if (sql.includes('token_hash')) {
        return {
          token_hash: tokenHash,
          owner_status: USER_STATUS.ACTIVE,
          node_role: 'full',
          revoked_at: null,
          user_id: 'user-1',
          name: 'srv-node',
        };
      }
      return null;
    },
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(db as unknown as Database),
    close: async () => {},
  };
  return db as unknown as Database;
}

/**
 * Stateful in-memory DB implementing the conditional SQL on `servers`
 * (`last_heartbeat_at`, `status`, `connected_providers`) plus an optional hook
 * to pause Pod A's close writes so Pod B's concurrent auth/provider writes can commit first.
 */
function makeStatefulServersDb(options: {
  serverId: string;
  secret: string;
  sharedRow?: {
    id: string;
    token_hash: string;
    owner_status: string;
    node_role: string;
    revoked_at: number | null;
    user_id: string;
    name: string;
    status: string;
    last_heartbeat_at: number | null;
    connected_providers: Record<string, boolean>;
  };
  onHeartbeatQuery?: () => Promise<void>;
}) {
  const tokenHash = sha256Hex(options.secret);
  const row = options.sharedRow ?? {
    id: options.serverId,
    token_hash: tokenHash,
    owner_status: USER_STATUS.ACTIVE,
    node_role: 'full',
    revoked_at: null as number | null,
    user_id: 'user-1',
    name: 'srv-node',
    status: 'offline' as string,
    last_heartbeat_at: null as number | null,
    connected_providers: {} as Record<string, boolean>,
  };

  const db = {
    row,
    queryOne: async (sql: string) => {
      if (sql.includes('token_hash')) {
        return { ...row };
      }
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("FROM servers WHERE status = 'online'")) {
        const cutoff = Number(params[0]);
        if (row.status === 'online' && (row.last_heartbeat_at === null || row.last_heartbeat_at < cutoff)) {
          return [{ id: row.id, name: row.name, user_id: row.user_id, last_heartbeat_at: row.last_heartbeat_at }];
        }
        return [];
      }
      return [];
    },
    execute: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('UPDATE servers SET last_heartbeat_at')) {
        if (options.onHeartbeatQuery) {
          await options.onHeartbeatQuery();
        }
        row.last_heartbeat_at = Number(params[0]);
        row.status = String(params[1]);
        return { changes: 1 };
      }
      if (sql.includes('UPDATE servers SET status = $1 WHERE id = $2')) {
        row.status = String(params[0]);
        return { changes: 1 };
      }
      if (sql.includes("UPDATE servers SET status = 'offline' WHERE id = $1")) {
        row.status = 'offline';
        return { changes: 1 };
      }
      if (sql.includes('UPDATE servers SET connected_providers') && sql.includes("'{}'::jsonb WHERE")) {
        row.connected_providers = {};
        return { changes: 1 };
      }
      if (sql.includes('UPDATE servers SET connected_providers = coalesce(connected_providers')) {
        if (sql.includes('|| $1::jsonb')) {
          const patch = JSON.parse(String(params[0])) as Record<string, boolean>;
          row.connected_providers = { ...row.connected_providers, ...patch };
        } else if (sql.includes('- $1')) {
          const next = { ...row.connected_providers };
          delete next[String(params[0])];
          row.connected_providers = next;
        }
        return { changes: 1 };
      }
      return { changes: 1 };
    },
    exec: async () => {},
    transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(db as unknown as Database),
    close: async () => {},
  };
  return db as unknown as Database & { row: typeof row };
}

async function connectAuthenticatedDaemon(
  serverId: string,
  secret = 'daemon-secret',
  db: Database = makeBridgeAuthDb(secret),
) {
  const bridge = WsBridge.get(serverId);
  const daemonWs = new MockWs();
  bridge.handleDaemonConnection(daemonWs as never, db, {
    JWT_SIGNING_KEY: signingKey,
  } as Env);
  daemonWs.emit('message', Buffer.from(JSON.stringify({
    type: 'auth',
    serverId,
    token: secret,
  })));
  await flushAsync();
  expect(bridge.isDaemonConnected()).toBe(true);
  return { bridge, daemonWs };
}

function makeRouteEnv(serverId = 'srv-1') {
  const base = baseEnvironment();
  const pgNotifies: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const baseQueryOne = base.DB.queryOne.bind(base.DB);
  const db = {
    queryOne: async (sql: string, params: unknown[] = []) => {
      const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (normalized.includes('from sessions where server_id = $1 and name = $2')) {
        return { exists: true, ok: 1 };
      }
      if (normalized.includes('from servers where id = $1')) {
        return {
          exists: true,
          owner_status: USER_STATUS.ACTIVE,
          actor_status: USER_STATUS.ACTIVE,
          id: serverId,
          token_hash: sha256Hex(daemonToken),
          user_id: 'user-1',
          team_id: null,
          node_role: 'full',
          revoked_at: null,
        };
      }
      if (normalized.includes('from shared_context_projections')) {
        return {
          id: 'proj-1',
          user_id: 'user-1',
          origin_server_id: serverId,
          project_id: 'proj-key',
          summary: '',
          content: '',
          tags: [],
          created_at: 1_000,
          updated_at: 1_000,
        };
      }
      if (normalized.includes('from server_users') || normalized.includes('from server_members')) {
        return { role: 'owner' };
      }
      return baseQueryOne(sql, params);
    },
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('pg_notify')) {
        pgNotifies.push({
          channel: String(params[0]),
          payload: JSON.parse(String(params[1])) as Record<string, unknown>,
        });
      }
      return [];
    },
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;

  const env: Env = {
    ...base,
    DB: db,
    SERVER_URL: 'http://localhost:3000',
    ALLOWED_ORIGINS: 'http://localhost:3000',
    NODE_ENV: 'development',
    BIND_HOST: '127.0.0.1',
    PORT: '0',
  };
  return { env, pgNotifies };
}

describe('DaemonPodRebalancer & cross-pod WS rebalance', () => {
  beforeEach(async () => {
    mockPgClients.length = 0;
    WsBridge.getAll().clear();
    await daemonPodRebalancer.stop();
  });

  afterEach(async () => {
    WsBridge.getAll().clear();
    await daemonPodRebalancer.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('closes aged daemon WS with 1012/pod_rebalance on cross-pod notify and leaves browser WS untouched', async () => {
    let nowMs = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const serverId = 'srv-rebalance-cross-pod';
    const { bridge, daemonWs } = await connectAuthenticatedDaemon(serverId);
    const browserWs = new MockWs();
    bridge.handleBrowserConnection(browserWs as never, 'user-1', makeBridgeAuthDb());

    // Advance past minConnectionAgeMs (5s) on Pod A.
    nowMs += 6_000;

    const notifies: Array<{ sql: string; params: unknown[] }> = [];
    const pgClient = new ControlledPgClient();
    const podB = new DaemonPodRebalancer({
      podId: () => 'pod-b',
      now: () => nowMs,
      pgClientFactory: () => pgClient,
    });
    const podA = new DaemonPodRebalancer({
      podId: () => 'pod-a',
      now: () => nowMs,
      pgClientFactory: () => new ControlledPgClient(),
    });

    await podB.start('postgres://pod-b.local/imcodes', {
      query: async (sql: string, params: unknown[] = []) => {
        notifies.push({ sql, params });
        return [];
      },
    } as unknown as Database);
    await podA.start('postgres://pod-a.local/imcodes');

    // Even if Pod B's LISTEN drops temporarily, publishing via pool still succeeds while started.
    pgClient.emit('error', new Error('listener hiccup'));
    expect(podB.isPgListening()).toBe(false);

    podB.requestDaemonRebalance(serverId);
    await flushAsync();

    expect(notifies).toHaveLength(1);
    expect(notifies[0]!.sql).toContain('pg_notify');
    expect(notifies[0]!.params[0]).toBe(DAEMON_REBALANCE_NOTIFY_CHANNEL);

    const handled = podA.handleNotificationPayload(String(notifies[0]!.params[1]));
    expect(handled).toBe(true);
    expect(daemonWs.closed).toBe(true);
    expect(daemonWs.closeCode).toBe(DAEMON_REBALANCE_WS_CLOSE_CODE);
    expect(daemonWs.closeReason).toBe(DAEMON_REBALANCE_WS_CLOSE_REASON);
    expect(browserWs.closed).toBe(false);

    await podA.stop();
    await podB.stop();
  });

  it('ignores self-notifications where requesterPodId matches local pod', async () => {
    let nowMs = 2_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const serverId = 'srv-self-ignore';
    const { daemonWs } = await connectAuthenticatedDaemon(serverId);
    nowMs += 10_000;

    const rebalancer = new DaemonPodRebalancer({
      podId: () => 'pod-a',
      now: () => nowMs,
    });
    const handled = rebalancer.handleNotificationPayload(JSON.stringify({
      serverId,
      requesterPodId: 'pod-a',
      ts: nowMs,
    }));

    expect(handled).toBe(false);
    expect(daemonWs.closed).toBe(false);
  });

  it('enforces min connection age, publish cooldown, kick cooldown, staleness cutoff, malformed input safety, and bounded maps', async () => {
    let nowMs = 3_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const serverId = 'srv-anti-flap';
    const { daemonWs } = await connectAuthenticatedDaemon(serverId);

    const podA = new DaemonPodRebalancer({
      podId: () => 'pod-a',
      now: () => nowMs,
      minConnectionAgeMs: 5_000,
      kickCooldownMs: 15_000,
      maxEventAgeMs: 30_000,
      maxTrackedEntries: 4,
    });

    // Fresh connection (< 5s): must NOT kick.
    nowMs += 2_000;
    expect(podA.handleNotificationPayload(JSON.stringify({
      serverId,
      requesterPodId: 'pod-b',
      ts: nowMs,
    }))).toBe(false);
    expect(daemonWs.closed).toBe(false);

    // Stale notification (> 30s): must ignore even once connection is aged.
    nowMs += 40_000;
    expect(podA.handleNotificationPayload(JSON.stringify({
      serverId,
      requesterPodId: 'pod-b',
      ts: nowMs - 31_000,
    }))).toBe(false);
    expect(daemonWs.closed).toBe(false);

    // Malformed payloads & unknown serverId: must ignore without creating bridges.
    expect(podA.handleNotificationPayload('not-json')).toBe(false);
    expect(podA.handleNotificationPayload(JSON.stringify({ serverId: '', requesterPodId: 'pod-b', ts: nowMs }))).toBe(false);
    expect(podA.handleNotificationPayload(JSON.stringify({ serverId: 'missing-srv', requesterPodId: 'pod-b', ts: nowMs }))).toBe(false);
    expect(WsBridge.find('missing-srv')).toBeUndefined();

    // Valid notification once connection >= 5s: kicks once.
    expect(podA.handleNotificationPayload(JSON.stringify({
      serverId,
      requesterPodId: 'pod-b',
      ts: nowMs,
    }))).toBe(true);
    expect(daemonWs.closed).toBe(true);

    // Reconnect daemon and confirm kick cooldown (15s) prevents immediate re-kick from Pod C.
    const { daemonWs: daemonWs2 } = await connectAuthenticatedDaemon(serverId);
    nowMs += 6_000;
    expect(podA.handleNotificationPayload(JSON.stringify({
      serverId,
      requesterPodId: 'pod-c',
      ts: nowMs,
    }))).toBe(false);
    expect(daemonWs2.closed).toBe(false);

    // Past 15s kick cooldown: next rebalance succeeds.
    nowMs += 10_000;
    expect(podA.handleNotificationPayload(JSON.stringify({
      serverId,
      requesterPodId: 'pod-c',
      ts: nowMs,
    }))).toBe(true);
    expect(daemonWs2.closed).toBe(true);

    // Publish cooldown + bounded map eviction.
    const emitted: string[] = [];
    const podB = new DaemonPodRebalancer({
      podId: () => 'pod-b',
      now: () => nowMs,
      publishCooldownMs: 15_000,
      maxTrackedEntries: 3,
      pgClientFactory: () => new ControlledPgClient(),
    });
    const fakeDb = {
      query: async (_sql: string, params: unknown[] = []) => {
        emitted.push(String(params[1]));
        return [];
      },
    } as unknown as Database;
    await podB.start('postgres://pod-b.local/imcodes', fakeDb);
    podB.requestDaemonRebalance('s-1', fakeDb);
    podB.requestDaemonRebalance('s-1', fakeDb); // suppressed within 15s
    expect(emitted).toHaveLength(1);
    nowMs += 15_000;
    podB.requestDaemonRebalance('s-1', fakeDb);
    expect(emitted).toHaveLength(2);

    podB.requestDaemonRebalance('s-2', fakeDb);
    podB.requestDaemonRebalance('s-3', fakeDb);
    podB.requestDaemonRebalance('s-4', fakeDb);
    expect(podB.getPublishCooldownSize()).toBe(3);
    await podB.stop();
  });

  it('never emits pg_notify when unstarted, PGlite/embedded, or after stop()', async () => {
    const querySpy = vi.fn(async () => []);
    const spyDb = { query: querySpy } as unknown as Database;
    const rebalancer = new DaemonPodRebalancer({
      podId: () => 'pod-a',
      pgClientFactory: () => new ControlledPgClient(),
    });

    // 1. Unstarted: even with querySpy dbOverride, zero pg_notify queries.
    rebalancer.requestDaemonRebalance('srv-unstarted', spyDb);
    expect(querySpy).not.toHaveBeenCalled();

    // 2. Absent / PGlite URL: zero pg_notify queries and no listener.
    await expect(rebalancer.start(undefined, spyDb)).resolves.toBeUndefined();
    expect(rebalancer.isPgListening()).toBe(false);
    rebalancer.requestDaemonRebalance('srv-no-url', spyDb);
    expect(querySpy).not.toHaveBeenCalled();

    await expect(rebalancer.start('pglite://embedded', spyDb)).resolves.toBeUndefined();
    expect(rebalancer.isPgListening()).toBe(false);
    rebalancer.requestDaemonRebalance('srv-pglite', spyDb);
    expect(querySpy).not.toHaveBeenCalled();

    // 3. Started with PG -> publishes once, then after stop() -> zero queries again.
    await rebalancer.start('postgres://pod-a.local/imcodes', spyDb);
    rebalancer.requestDaemonRebalance('srv-pg', spyDb);
    expect(querySpy).toHaveBeenCalledTimes(1);

    await rebalancer.stop();
    rebalancer.requestDaemonRebalance('srv-after-stop', spyDb);
    expect(querySpy).toHaveBeenCalledTimes(1);

    // 4. Failing pg_notify query inside running PG mode does not throw.
    const failingDb = {
      query: async () => {
        throw new Error('pg_notify temporary error');
      },
    } as unknown as Database;
    await rebalancer.start('postgres://pod-a.local/imcodes', failingDb);
    expect(() => rebalancer.requestDaemonRebalance('srv-fail', failingDb)).not.toThrow();
    await flushAsync();
    await rebalancer.stop();
  });

  it('retires PG listener cleanly on LISTEN failure, async end rejection, timeout, in-flight stop(), and reconnects', async () => {
    vi.useFakeTimers();

    // 1. connect succeeds, LISTEN rejects -> end() called once and reconnect scheduled.
    const clients: ControlledPgClient[] = [];
    const rebalancer1 = new DaemonPodRebalancer({
      podId: () => 'pod-a',
      pgClientFactory: () => {
        const c = new ControlledPgClient();
        if (clients.length === 0) {
          c.queryImpl = async () => {
            throw new Error('LISTEN failed');
          };
          c.endImpl = async () => {
            throw new Error('end() async reject should be absorbed');
          };
        }
        clients.push(c);
        return c;
      },
    });
    await rebalancer1.start('postgres://pod-a.local/imcodes');
    expect(rebalancer1.isPgListening()).toBe(false);
    expect(clients[0]!.endCalls).toBe(1);

    // Reconnect fires cleanly after initial 1000ms backoff and establishes LISTEN.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clients).toHaveLength(2);
    expect(rebalancer1.isPgListening()).toBe(true);

    // Listener error/end retires client idempotently (even if end/error both fire) and reconnects.
    clients[1]!.emit('error', new Error('connection reset'));
    clients[1]!.emit('end');
    expect(clients[1]!.endCalls).toBe(1);
    expect(rebalancer1.isPgListening()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clients).toHaveLength(3);
    expect(rebalancer1.isPgListening()).toBe(true);
    await rebalancer1.stop();
    expect(clients[2]!.endCalls).toBe(1);

    // 2. stop() racing an in-flight LISTEN -> when LISTEN later resolves, client retires and isPgListening stays false.
    const listenDeferred = createDeferred<void>();
    const raceClient = new ControlledPgClient();
    raceClient.queryImpl = () => listenDeferred.promise;
    const rebalancer2 = new DaemonPodRebalancer({
      podId: () => 'pod-a',
      pgClientFactory: () => raceClient,
    });
    const startPromise = rebalancer2.start('postgres://pod-a.local/imcodes');
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(raceClient.connectCalls).toBe(1);
    expect(raceClient.queries).toHaveLength(1);

    await rebalancer2.stop();
    expect(raceClient.endCalls).toBe(1);
    listenDeferred.resolve();
    await startPromise;
    expect(rebalancer2.isPgListening()).toBe(false);
    expect(raceClient.endCalls).toBe(1);

    // 3. connect() hang hits bounded connectTimeoutMs, retires client, and retries.
    const timeoutClients: ControlledPgClient[] = [];
    const rebalancer3 = new DaemonPodRebalancer({
      podId: () => 'pod-a',
      connectTimeoutMs: 500,
      pgClientFactory: () => {
        const c = new ControlledPgClient();
        if (timeoutClients.length === 0) {
          c.connectImpl = () => new Promise<void>(() => {});
        }
        timeoutClients.push(c);
        return c;
      },
    });
    const timedStart = rebalancer3.start('postgres://pod-a.local/imcodes');
    await vi.advanceTimersByTimeAsync(500);
    await timedStart;
    expect(timeoutClients[0]!.endCalls).toBe(1);
    expect(rebalancer3.isPgListening()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(timeoutClients).toHaveLength(2);
    expect(rebalancer3.isPgListening()).toBe(true);
    await rebalancer3.stop();
  });

  it('triggers PG notify ONLY on authenticated /api/server/:serverId/... routes when PG started and never on flat or unauthenticated routes', async () => {
    const serverId = 'srv-route-1';
    const { env, pgNotifies } = makeRouteEnv(serverId);
    await daemonPodRebalancer.start('postgres://pod-b.local/imcodes', env.DB);

    // 1. Unauthenticated HTTP request must NOT emit rebalance.
    const unauthRes = await buildApp(env).request(`/api/server/${serverId}/timeline/history?sessionName=deck_proj_brain`);
    expect(unauthRes.status).toBe(401);
    expect(pgNotifies).toHaveLength(0);

    // 2. Non-path daemon auth (e.g., outbound.ts passing serverId = null) must NOT emit rebalance.
    const nonPathApp = new Hono<{ Bindings: Env }>();
    nonPathApp.post('/api/outbound', async (c) => {
      const authed = await authenticateDaemonServer(c, null);
      return c.json({ ok: authed.ok });
    });
    const outboundRes = await nonPathApp.request('/api/outbound', {
      method: 'POST',
      headers: { Authorization: daemonHeaders.Authorization },
    }, env);
    expect(outboundRes.status).toBe(200);
    expect(pgNotifies).toHaveLength(0);

    // 3. Flat routes outside /api/server/:serverId/... (session-identities, memory/sources) must NOT emit rebalance.
    const identityRes = await buildApp(env).request(`/api/session-identities?scope=project&scopeKey=proj-1&serverId=${serverId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(identityRes.status).toBe(409);
    expect(pgNotifies).toHaveLength(0);

    const memoryRes = await buildApp(env).request(`/api/memory/sources?serverId=${serverId}&projectionId=proj-1&projectId=proj-key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(memoryRes.status).toBe(409);
    expect(pgNotifies).toHaveLength(0);

    // 4. Path-bound daemon auth on /api/server/:id/... when local daemon WS is absent emits rebalance.
    const daemonRouteApp = new Hono<{ Bindings: Env }>();
    daemonRouteApp.get('/api/server/:id/sessions', async (c) => {
      const authed = await authenticateDaemonServer(c, c.req.param('id'));
      return c.json({ ok: authed.ok });
    });
    const daemonRes = await daemonRouteApp.request(`/api/server/${serverId}/sessions`, {
      headers: { Authorization: daemonHeaders.Authorization, [SERVER_ID_HEADER]: serverId },
    }, env);
    expect(daemonRes.status).toBe(200);
    expect(pgNotifies).toHaveLength(1);
    expect(pgNotifies[0]!.payload.serverId).toBe(serverId);

    // 5. Authenticated Watch daemon_offline route on /api/server/:id/... emits rebalance.
    await daemonPodRebalancer.stop();
    await daemonPodRebalancer.start('postgres://pod-b.local/imcodes', env.DB);
    const watchRes = await buildApp(env).request(
      `/api/server/${serverId}/timeline/history?sessionName=deck_proj_brain`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    expect(watchRes.status).toBe(503);
    expect(await watchRes.json()).toEqual({ error: 'daemon_offline' });
    expect(pgNotifies).toHaveLength(2);
    expect(pgNotifies[1]!.payload.serverId).toBe(serverId);

    // 6. Authenticated /api/server/:id/session/send when !isDaemonConnected emits rebalance.
    await daemonPodRebalancer.stop();
    await daemonPodRebalancer.start('postgres://pod-b.local/imcodes', env.DB);
    const sendRes = await buildApp(env).request(`/api/server/${serverId}/session/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ session: 'deck_proj_brain', message: 'hi' }),
    });
    expect(sendRes.status).toBe(200);
    expect(pgNotifies).toHaveLength(3);
    expect(pgNotifies[2]!.payload.serverId).toBe(serverId);

    // 7. When daemon IS connected locally on this pod, authenticateDaemonServer must NOT emit rebalance.
    await daemonPodRebalancer.stop();
    await daemonPodRebalancer.start('postgres://pod-b.local/imcodes', env.DB);
    await connectAuthenticatedDaemon(serverId, daemonToken);
    await daemonRouteApp.request(`/api/server/${serverId}/sessions`, {
      headers: { Authorization: daemonHeaders.Authorization, [SERVER_ID_HEADER]: serverId },
    }, env);
    expect(pgNotifies).toHaveLength(3);
  });

  it('triggers PG notify on authenticated browser WS upgrade when local daemon is disconnected', async () => {
    const serverId = 'srv-ws-upgrade-1';
    const { env, pgNotifies } = makeRouteEnv(serverId);
    await daemonPodRebalancer.start('postgres://pod-b.local/imcodes', env.DB);
    const httpServer: HttpServer = createServer();
    setupWebSocketUpgrade(httpServer, env);

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      // Unauthenticated WS ticket must reject and NOT emit rebalance.
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${port}/api/server/${serverId}/ws?ticket=invalid`,
          { origin: 'http://localhost:3000' },
        );
        ws.once('unexpected-response', () => resolve());
        ws.once('error', () => resolve());
      });
      expect(pgNotifies).toHaveLength(0);

      // Authenticated member browser WS upgrade when daemon is NOT on this pod triggers rebalance.
      const memberTicket = await signJwt(
        { sub: 'user-1', sid: serverId, jti: 'jti-rebalance-1', type: 'ws-ticket' },
        signingKey,
        60,
      );
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${port}/api/server/${serverId}/ws?ticket=${encodeURIComponent(memberTicket)}`,
          { origin: 'http://localhost:3000' },
        );
        ws.once('open', () => {
          ws.close();
          resolve();
        });
        ws.once('unexpected-response', (_req, res) => reject(new Error(`Unexpected status ${res.statusCode}`)));
        ws.once('error', reject);
      });
      await flushAsync();
      expect(pgNotifies).toHaveLength(1);
      expect(pgNotifies[0]!.payload.serverId).toBe(serverId);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('keeps shared online/provider state intact on 1012 rebalance close under heartbeat interleaving, preserves normal close offline marking, and expires un-reconnected servers via healthCheckCron', async () => {
    const serverId = 'srv-handoff-race';
    const hbGateA = createDeferred<void>();
    let gateHbA = true;

    const dbA = makeStatefulServersDb({
      serverId,
      secret: 'secret',
      onHeartbeatQuery: async () => {
        if (gateHbA) {
          gateHbA = false;
          await hbGateA.promise;
        }
      },
    });
    const dbB = makeStatefulServersDb({
      serverId,
      secret: 'secret',
      sharedRow: dbA.row,
    });

    const notifySpy = vi.spyOn(globalTaskHub, 'notifyServerState').mockResolvedValue();

    // 1. Pod A authenticates while its DB heartbeat write is still in-flight, and receives provider status.
    let nowMs = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const bridgeA = WsBridge.get(serverId);
    const wsA = new MockWs();
    bridgeA.handleDaemonConnection(wsA as never, dbA, { JWT_SIGNING_KEY: signingKey } as Env);
    wsA.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token: 'secret' })));
    await flushAsync();
    expect(bridgeA.isDaemonConnected()).toBe(true);

    // 2. Advance past minConnectionAgeMs (5s) and close Pod A via 1012 rebalance.
    nowMs = 7_000;
    expect(bridgeA.rebalanceDaemonConnection(5_000, 'pod-b', nowMs)).toBe(true);
    expect(wsA.closeCode).toBe(DAEMON_REBALANCE_WS_CLOSE_CODE);
    expect(bridgeA.isDaemonConnected()).toBe(false);

    // Move WsBridge singleton to model separate Pod B process.
    WsBridge.getAll().delete(serverId);

    // 3. Pod B authenticates and sets provider status BEFORE Pod A's delayed heartbeat promise settles.
    nowMs = 7_050;
    const bridgeB = WsBridge.get(serverId);
    const wsB = new MockWs();
    bridgeB.handleDaemonConnection(wsB as never, dbB, { JWT_SIGNING_KEY: signingKey } as Env);
    wsB.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token: 'secret' })));
    await flushAsync();
    wsB.emit('message', Buffer.from(JSON.stringify({
      type: TRANSPORT_MSG.PROVIDER_STATUS,
      providerId: 'claude-code',
      connected: true,
    })));
    await flushAsync();

    // Release Pod A's stalled heartbeat task and flush everything.
    hbGateA.resolve();
    await flushAsync();

    // Pod A's 1012 rebalance close must NOT emit offline status, provider clear, or globalTaskHub offline notify.
    expect(dbA.row.status).toBe('online');
    expect(dbA.row.connected_providers).toEqual({ 'claude-code': true });
    expect(notifySpy.mock.calls.some(([, sid, online]) => sid === serverId && online === false)).toBe(false);

    // 4. Un-reconnected 1012 close: if a server closed via 1012 never reconnects anywhere,
    // healthCheckCron marks it offline once its heartbeat expires (> 10 minutes).
    nowMs += 10_000;
    expect(bridgeB.rebalanceDaemonConnection(5_000, 'pod-c', nowMs)).toBe(true);
    await flushAsync();
    expect(dbA.row.status).toBe('online'); // not prematurely marked offline by rebalance close

    nowMs += 10 * 60 * 1000 + 1; // past HEARTBEAT_TIMEOUT_MS (10 minutes)
    await healthCheckCron({ DB: dbB } as unknown as Env);
    expect(dbA.row.status).toBe('offline');

    // 5. Normal non-rebalance socket close still marks status offline, clears providers, and emits global offline notify immediately.
    WsBridge.getAll().delete(serverId);
    const { bridge: bridgeC, daemonWs: wsC } = await connectAuthenticatedDaemon(serverId, 'secret', dbB);
    wsC.emit('message', Buffer.from(JSON.stringify({
      type: TRANSPORT_MSG.PROVIDER_STATUS,
      providerId: 'codex',
      connected: true,
    })));
    await flushAsync();
    expect(dbA.row.status).toBe('online');
    expect(dbA.row.connected_providers['codex']).toBe(true);

    notifySpy.mockClear();
    wsC.close(1006, 'network drop');
    await flushAsync();
    expect(bridgeC.isDaemonConnected()).toBe(false);
    expect(dbA.row.status).toBe('offline');
    expect(dbA.row.connected_providers).toEqual({});
    expect(notifySpy.mock.calls.some(([, sid, online]) => sid === serverId && online === false)).toBe(true);
  });
});
