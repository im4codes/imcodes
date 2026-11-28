import { createServer, type Server as HttpServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { WebSocket } from 'ws';
import { buildApp, setupWebSocketUpgrade } from '../src/index.js';
import { WsBridge } from '../src/ws/bridge.js';
import {
  DAEMON_REBALANCE_NOTIFY_CHANNEL,
  DAEMON_REBALANCE_WS_CLOSE_CODE,
  DAEMON_REBALANCE_WS_CLOSE_REASON,
  DaemonPodRebalancer,
  daemonPodRebalancer,
} from '../src/ws/daemon-pod-rebalance.js';
import { authenticateDaemonServer } from '../src/security/daemon-auth.js';
import { sha256Hex, signJwt } from '../src/security/crypto.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { USER_STATUS } from '../../shared/user-status.js';
import { SERVER_ID_HEADER } from '../../shared/http-header-names.js';
import { environment as baseEnvironment, signingKey, token as daemonToken, key as apiKey, headers as daemonHeaders } from './helpers/daemon-token-env.js';

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
    this.emit('close');
  }
}

async function flushAsync() {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => process.nextTick(r));
  }
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

async function connectAuthenticatedDaemon(serverId: string, secret = 'daemon-secret') {
  const bridge = WsBridge.get(serverId);
  const daemonWs = new MockWs();
  bridge.handleDaemonConnection(daemonWs as never, makeBridgeAuthDb(secret), {
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
    const podB = new DaemonPodRebalancer({
      podId: () => 'pod-b',
      now: () => nowMs,
    });
    const podA = new DaemonPodRebalancer({
      podId: () => 'pod-a',
      now: () => nowMs,
    });

    podB.requestDaemonRebalance(serverId, {
      query: async (sql: string, params: unknown[] = []) => {
        notifies.push({ sql, params });
        return [];
      },
    });
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
    });
    const fakeDb = {
      query: async (_sql: string, params: unknown[] = []) => {
        emitted.push(String(params[1]));
        return [];
      },
    };
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
  });

  it('degrades safely when PostgreSQL is unavailable (PGlite/embedded or failing query)', async () => {
    const rebalancer = new DaemonPodRebalancer({ podId: () => 'pod-a' });
    await expect(rebalancer.start(undefined)).resolves.toBeUndefined();
    expect(rebalancer.isPgListening()).toBe(false);

    await expect(rebalancer.start('pglite://embedded')).resolves.toBeUndefined();
    expect(rebalancer.isPgListening()).toBe(false);

    // DB without .query or rejecting .query must never throw synchronously or reject unhandled.
    expect(() => rebalancer.requestDaemonRebalance('srv-1', {} as Database)).not.toThrow();
    expect(() => rebalancer.requestDaemonRebalance('srv-1', {
      query: async () => {
        throw new Error('function pg_notify does not exist');
      },
    })).not.toThrow();
    await flushAsync();
    await expect(rebalancer.stop()).resolves.toBeUndefined();
  });

  it('triggers PG notify on authenticated daemon-auth, watch, session-mgmt, and never on unauthenticated or non-path requests', async () => {
    const { env, pgNotifies } = makeRouteEnv('srv-route-1');

    // 1. Unauthenticated HTTP request must NOT emit rebalance.
    const unauthRes = await buildApp(env).request('/api/server/srv-route-1/timeline/history?sessionName=deck_proj_brain');
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

    // 3. Path-bound daemon auth when local daemon WS is absent emits rebalance.
    const daemonRouteApp = new Hono<{ Bindings: Env }>();
    daemonRouteApp.get('/api/server/:id/sessions', async (c) => {
      const authed = await authenticateDaemonServer(c, c.req.param('id'));
      return c.json({ ok: authed.ok });
    });
    const daemonRes = await daemonRouteApp.request('/api/server/srv-route-1/sessions', {
      headers: { Authorization: daemonHeaders.Authorization, [SERVER_ID_HEADER]: 'srv-route-1' },
    }, env);
    expect(daemonRes.status).toBe(200);
    expect(pgNotifies).toHaveLength(1);
    expect(pgNotifies[0]!.payload.serverId).toBe('srv-route-1');

    // Reset singleton cooldown and verify authenticated Watch daemon_offline route emits rebalance.
    await daemonPodRebalancer.stop();
    const watchRes = await buildApp(env).request(
      '/api/server/srv-route-1/timeline/history?sessionName=deck_proj_brain',
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );
    expect(watchRes.status).toBe(503);
    expect(await watchRes.json()).toEqual({ error: 'daemon_offline' });
    expect(pgNotifies).toHaveLength(2);
    expect(pgNotifies[1]!.payload.serverId).toBe('srv-route-1');

    // Reset singleton cooldown and verify authenticated /session/send when !isDaemonConnected emits rebalance.
    await daemonPodRebalancer.stop();
    const sendRes = await buildApp(env).request('/api/server/srv-route-1/session/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ session: 'deck_proj_brain', message: 'hi' }),
    });
    expect(sendRes.status).toBe(200);
    expect(pgNotifies).toHaveLength(3);
    expect(pgNotifies[2]!.payload.serverId).toBe('srv-route-1');

    // When daemon IS connected locally on this pod, authenticateDaemonServer must NOT emit rebalance.
    await daemonPodRebalancer.stop();
    await connectAuthenticatedDaemon('srv-route-1', daemonToken);
    await daemonRouteApp.request('/api/server/srv-route-1/sessions', {
      headers: { Authorization: daemonHeaders.Authorization, [SERVER_ID_HEADER]: 'srv-route-1' },
    }, env);
    expect(pgNotifies).toHaveLength(3);
  });

  it('triggers PG notify on authenticated browser WS upgrade when local daemon is disconnected', async () => {
    const serverId = 'srv-ws-upgrade-1';
    const { env, pgNotifies } = makeRouteEnv(serverId);
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
});
