/**
 * End-to-end integration: GET /api/memory/sources → WsBridge → daemon WS
 * RPC → reply → HTTP response.
 *
 * Earlier tests cover each layer in isolation. This one wires up:
 *   - a real Hono app with the new memory routes
 *   - a real WsBridge with a connected (mocked) daemon WebSocket
 *   - a real handler dispatcher that responds with the daemon-side reply
 *     shape (no actual daemon process — just the wire envelope)
 *
 * The point is to catch wiring breakage between the route, the bridge's
 * pendingMemorySourcesRequests correlation map, and the
 * MEMORY_WS.GET_SOURCES_REQUEST/RESPONSE type names.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { WsBridge } from '../src/ws/bridge.js';
import { MEMORY_WS } from '../../shared/memory-ws.js';

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

class MockDaemonWs extends EventEmitter {
  sent: string[] = [];
  closed = false;
  readyState = 1;
  /**
   * Echoes every memory.get_sources_request as a successful response with
   * a fixed payload. The route correlates by requestId, so as long as we
   * round-trip that field correctly, the HTTP caller sees a 200.
   */
  autoReply: { partial?: boolean; sourceEventCount?: number } | null = {
    sourceEventCount: 1,
    partial: false,
  };
  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) {
      const err = new Error('socket closed');
      if (callback) { callback(err); return; }
      throw err;
    }
    const str = typeof data === 'string' ? data : data.toString();
    this.sent.push(str);
    callback?.();
    if (!this.autoReply) return;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(str); } catch { return; }
    if (parsed.type !== MEMORY_WS.GET_SOURCES_REQUEST) return;
    const reply = {
      type: MEMORY_WS.GET_SOURCES_RESPONSE,
      requestId: parsed.requestId,
      status: 'ok',
      projectionId: parsed.projectionId,
      sourceEventCount: this.autoReply.sourceEventCount ?? 0,
      sources: this.autoReply.sourceEventCount && this.autoReply.sourceEventCount > 0
        ? Array.from({ length: this.autoReply.sourceEventCount }, (_, i) => ({
            eventId: `evt-${i}`,
            status: 'archived' as const,
            content: `event content ${i}`,
            eventType: 'chat.assistant',
            createdAt: i,
          }))
        : [],
      ...(typeof this.autoReply.partial === 'boolean' ? { partial: this.autoReply.partial } : {}),
      originServerId: parsed.expectedServerId,
    };
    // Defer to the next tick so the route's pending-map entry exists by
    // the time the reply arrives.
    setImmediate(() => {
      this.emit('message', Buffer.from(JSON.stringify(reply)));
    });
  }
  close() { this.closed = true; this.readyState = 3; this.emit('close'); }
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

function makeProjectionRow(input: {
  id: string;
  serverId: string;
  projectId?: string;
  summary?: string | null;
  sourceEventIds?: string[];
}): Record<string, unknown> {
  return {
    id: input.id,
    server_id: input.serverId,
    project_id: input.projectId ?? 'repo-1',
    source_event_ids_json: input.sourceEventIds ?? [`evt-${input.id}`],
    summary: input.summary === undefined ? `authorized projection ${input.id}` : input.summary,
    content_json: {},
    origin: 'chat_compacted',
    created_at: 123,
  };
}

function makeDb(projectionRow?: Record<string, unknown>): Database {
  return {
    queryOne: async <T>(sql: string, params: unknown[] = []) => {
      if (sql.toLowerCase().includes('from shared_context_projections')) {
        const serverOk = !sql.includes('server_id = $') || params.includes(projectionRow?.server_id);
        const projectOk = !sql.includes('project_id = $') || params.includes(projectionRow?.project_id);
        return projectionRow && params[0] === projectionRow.id && serverOk && projectOk
          ? projectionRow as T
          : null as T;
      }
      return { token_hash: 'valid-hash' } as T;
    },
    query: async () => [],
    execute: async () => ({ changes: 0 }),
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;
}

async function buildApp(db: Database) {
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

async function authDaemon(bridge: WsBridge, daemon: MockDaemonWs, db: Database) {
  bridge.handleDaemonConnection(daemon as never, db, {} as never);
  daemon.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId: 'unused', token: 'tok' })));
  await flushAsync();
}

describe('end-to-end cross-server source resolution', () => {
  let serverId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveServerRole.mockResolvedValue('owner');
    serverId = `e2e-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => WsBridge.getAll().clear());

  it('routes a request all the way to the daemon and back to HTTP', async () => {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockDaemonWs();
    await authDaemon(bridge, daemon, makeDb());

    const app = await buildApp(makeDb(makeProjectionRow({ id: 'proj-e2e', serverId })));
    const res = await app.request(`/api/memory/sources?serverId=${serverId}&projectionId=proj-e2e&projectId=repo-1`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      status: string;
      projectionId: string;
      sourceEventCount: number;
      sources: Array<{ eventId: string; content: string }>;
      originServerId: string;
    };
    expect(body.status).toBe('ok');
    expect(body.projectionId).toBe('proj-e2e');
    expect(body.sourceEventCount).toBe(1);
    expect(body.sources[0].content).toBe('event content 0');
    expect(body.originServerId).toBe(serverId);

    // Sanity-check the wire: the daemon received exactly one request with
    // the expected envelope.
    const requests = daemon.sent
      .map((s) => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; } })
      .filter((m): m is Record<string, unknown> => m?.type === MEMORY_WS.GET_SOURCES_REQUEST);
    expect(requests).toHaveLength(1);
    expect(requests[0].projectionId).toBe('proj-e2e');
    expect(requests[0].expectedProjectId).toBe('repo-1');
    // requestId must be present (route generates it)
    expect(typeof requests[0].requestId).toBe('string');
  });

  it('preserves partial=true on the end-to-end response', async () => {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockDaemonWs();
    daemon.autoReply = { sourceEventCount: 0, partial: true };
    await authDaemon(bridge, daemon, makeDb());

    const app = await buildApp(makeDb(makeProjectionRow({ id: 'proj-partial', serverId })));
    const res = await app.request(`/api/memory/sources?serverId=${serverId}&projectionId=proj-partial&projectId=repo-1`);
    expect(res.status).toBe(200);
    const body = await res.json() as { partial: boolean };
    expect(body.partial).toBe(true);
  });

  it('returns 409 when the daemon WS disconnects before reply', async () => {
    vi.useFakeTimers();
    try {
      const bridge = WsBridge.get(serverId);
      const daemon = new MockDaemonWs();
      daemon.autoReply = null; // don't auto-respond — force timeout
      await authDaemon(bridge, daemon, makeDb());

      const app = await buildApp(makeDb(makeProjectionRow({
        id: 'proj-stuck',
        serverId,
        summary: null,
        sourceEventIds: [],
      })));
      const requestPromise = app.request(`/api/memory/sources?serverId=${serverId}&projectionId=proj-stuck&projectId=repo-1`);
      // Advance past the route's 8s timeout.
      await vi.advanceTimersByTimeAsync(9000);
      const res = await requestPromise;
      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('daemon_offline');
    } finally {
      vi.useRealTimers();
    }
  });
});
