/**
 * Tests for the cross-server projection source routes:
 *
 *   - GET /api/memory/projection-owner?projectionId=...
 *   - GET /api/memory/sources?serverId=...&projectionId=...
 *
 * Both routes use the project's query-string `?serverId=` pod-sticky
 * convention. The projection-owner route is cloud-only (PG lookup scoped to
 * the authenticated user); the sources route is pod-sticky and forwards to
 * the daemon WS via `WsBridge.sendMemorySourcesRequest`.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { WsBridge } from '../src/ws/bridge.js';
import { MEMORY_WS } from '../../shared/memory-ws.js';

// ── Hoisted auth mock ────────────────────────────────────────────────────

const mockResolveServerRole = vi.fn<() => Promise<string>>();

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'member');
    await next();
  },
  resolveServerRole: (...args: unknown[]) => mockResolveServerRole(...args as []),
}));

vi.mock('../src/security/crypto.js', () => ({
  sha256Hex: (_s: string) => 'valid-hash',
  randomHex: (n: number) => 'a'.repeat(n * 2),
}));

// ── Mock WebSocket ───────────────────────────────────────────────────────

class MockWs extends EventEmitter {
  sent: string[] = [];
  closed = false;
  readyState = 1;
  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) {
      const err = new Error('socket closed');
      if (callback) { callback(err); return; }
      throw err;
    }
    this.sent.push(typeof data === 'string' ? data : data.toString());
    callback?.();
  }
  close() { this.closed = true; this.readyState = 3; this.emit('close'); }
}

// ── Test scaffolding ─────────────────────────────────────────────────────

function makeDb(overrides: Partial<Database> = {}): Database {
  return {
    queryOne: async () => null,
    query: async () => [],
    execute: async () => ({ changes: 0 }),
    exec: async () => {},
    close: async () => {},
    ...overrides,
  } as unknown as Database;
}

function makeEnv(db: Database): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'https://app.im.codes',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'test',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    DATABASE_URL: '',
  } as Env;
}

async function buildTestApp(db: Database) {
  const { memoryRoutes } = await import('../src/routes/memory.js');
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    if (!c.env) (c as unknown as { env: Env }).env = {} as Env;
    Object.assign(c.env, makeEnv(db));
    await next();
  });
  app.route('/api', memoryRoutes);
  return app;
}

async function flushAsync() {
  for (let i = 0; i < 5; i++) await new Promise((r) => process.nextTick(r));
}

async function authDaemon(bridge: WsBridge, daemon: MockWs, db: Database) {
  // Daemon auth flow expects: row from `SELECT token_hash FROM servers WHERE id`.
  const dbWithAuth = {
    ...db,
    queryOne: async () => ({ token_hash: 'valid-hash' }),
  } as unknown as Database;
  bridge.handleDaemonConnection(daemon as never, dbWithAuth, {} as never);
  daemon.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId: 'irrelevant', token: 'tok' })));
  await flushAsync();
}

// ── projection-owner ─────────────────────────────────────────────────────

describe('GET /api/memory/projection-owner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveServerRole.mockResolvedValue('owner');
  });
  afterEach(() => WsBridge.getAll().clear());

  it('400s when projectionId is missing', async () => {
    const app = await buildTestApp(makeDb());
    const res = await app.request('/api/memory/projection-owner');
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('projection_id_required');
  });

  it('returns originServerId for a projection owned by the caller', async () => {
    const db = makeDb({
      queryOne: async <T>() => ({ server_id: 'srv-owner' }) as T,
    });
    const app = await buildTestApp(db);
    const res = await app.request('/api/memory/projection-owner?projectionId=proj-1');
    expect(res.status).toBe(200);
    const body = await res.json() as { originServerId: string };
    expect(body.originServerId).toBe('srv-owner');
  });

  it('404s when the projection is unknown or not visible to the caller', async () => {
    const db = makeDb({
      queryOne: async () => null, // simulated cross-user / missing row
    });
    const app = await buildTestApp(db);
    const res = await app.request('/api/memory/projection-owner?projectionId=proj-1');
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('not_found');
  });
});

// ── memory/sources (pod-sticky proxy) ─────────────────────────────────────

describe('GET /api/memory/sources', () => {
  let serverId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveServerRole.mockResolvedValue('owner');
    serverId = `test-mem-${Math.random().toString(36).slice(2)}`;
  });
  afterEach(() => WsBridge.getAll().clear());

  it('400s when serverId is missing', async () => {
    const app = await buildTestApp(makeDb());
    const res = await app.request('/api/memory/sources?projectionId=proj-1');
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('server_id_required');
  });

  it('400s when projectionId is missing', async () => {
    const app = await buildTestApp(makeDb());
    const res = await app.request(`/api/memory/sources?serverId=${serverId}`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('projection_id_required');
  });

  it('403s when the caller does not own the serverId', async () => {
    mockResolveServerRole.mockResolvedValue('none');
    const app = await buildTestApp(makeDb());
    const res = await app.request(`/api/memory/sources?serverId=${serverId}&projectionId=proj-1`);
    expect(res.status).toBe(403);
  });

  it('409s when no daemon is connected for the target serverId', async () => {
    // No WsBridge.handleDaemonConnection — daemon is offline.
    WsBridge.get(serverId); // create the bridge but no socket attached
    const app = await buildTestApp(makeDb());
    const res = await app.request(`/api/memory/sources?serverId=${serverId}&projectionId=proj-1`);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('daemon_offline');
  });

  it('proxies the request to the daemon and returns the response', async () => {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    await authDaemon(bridge, daemon, makeDb());
    expect(bridge.isDaemonConnected()).toBe(true);

    const app = await buildTestApp(makeDb());

    // Snoop the daemon-side message so we can synthesize a reply with the
    // matching requestId. The route assigns a random requestId; we read it
    // off the wire.
    const requestArrived = new Promise<{ requestId: string; projectionId: string }>((resolve) => {
      const tick = () => {
        const sent = daemon.sent.find((s) => s.includes(MEMORY_WS.GET_SOURCES_REQUEST));
        if (sent) {
          const parsed = JSON.parse(sent) as { requestId: string; projectionId: string };
          resolve(parsed);
        } else {
          setImmediate(tick);
        }
      };
      tick();
    });

    const responsePromise = app.request(`/api/memory/sources?serverId=${serverId}&projectionId=proj-42`);
    const { requestId, projectionId } = await requestArrived;
    expect(projectionId).toBe('proj-42');

    // Simulate the daemon's reply.
    daemon.emit('message', Buffer.from(JSON.stringify({
      type: MEMORY_WS.GET_SOURCES_RESPONSE,
      requestId,
      status: 'ok',
      projectionId: 'proj-42',
      sourceEventCount: 2,
      sources: [
        { eventId: 'e1', status: 'archived', content: 'event one', eventType: 'chat.assistant', createdAt: 1 },
        { eventId: 'e2', status: 'archived', content: 'event two', eventType: 'chat.assistant', createdAt: 2 },
      ],
      partial: false,
      originServerId: serverId,
    })));
    await flushAsync();

    const res = await responsePromise;
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; sourceEventCount: number; originServerId: string };
    expect(body.status).toBe('ok');
    expect(body.sourceEventCount).toBe(2);
    expect(body.originServerId).toBe(serverId);
  });

  it('stamps originServerId on the response even when daemon omits it', async () => {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    await authDaemon(bridge, daemon, makeDb());
    const app = await buildTestApp(makeDb());

    const requestArrived = new Promise<{ requestId: string }>((resolve) => {
      const tick = () => {
        const sent = daemon.sent.find((s) => s.includes(MEMORY_WS.GET_SOURCES_REQUEST));
        if (sent) resolve(JSON.parse(sent) as { requestId: string });
        else setImmediate(tick);
      };
      tick();
    });
    const resPromise = app.request(`/api/memory/sources?serverId=${serverId}&projectionId=proj-1`);
    const { requestId } = await requestArrived;
    daemon.emit('message', Buffer.from(JSON.stringify({
      type: MEMORY_WS.GET_SOURCES_RESPONSE,
      requestId,
      status: 'ok',
      projectionId: 'proj-1',
      sourceEventCount: 0,
      sources: [],
      // Intentionally omit originServerId — the route must fill it from
      // the path so callers always see a non-empty value.
    })));
    await flushAsync();
    const res = await resPromise;
    const body = await res.json() as { originServerId: string };
    expect(body.originServerId).toBe(serverId);
  });
});
