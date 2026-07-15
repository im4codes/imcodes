import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { buildApp } from '../src/index.js';
import { WsBridge } from '../src/ws/bridge.js';
import { LocalWebPreviewRegistry } from '../src/preview/registry.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { sha256Hex } from '../src/security/crypto.js';
import {
  PREVIEW_ACCESS_TOKEN_QUERY_PARAM,
  PREVIEW_ERROR,
  PREVIEW_MSG,
  PREVIEW_BINARY_FRAME,
  packPreviewBinaryFrame,
} from '../../shared/preview-types.js';

/**
 * Availability side-effect contract (S1/N3, audit run 394c114e-11f).
 *
 * The HTTP preview proxy MUST NOT slide a preview's TTL (`touch`) when the
 * daemon is OFFLINE — otherwise an owner polling/refreshing a preview whose
 * daemon is long-offline keeps it alive (occupies a per-user slot) until the
 * absolute hard ceiling. The TTL slide (`commitAuthorizedAccess`) is committed
 * only AFTER the daemon-online gate. The in-flight 503 (daemon online) still
 * slides the TTL — it is transient load shedding, and the request was a
 * legitimately-authorized, about-to-be-forwarded request.
 */

type ServerRow = { id: string; user_id: string; team_id: string | null; token_hash: string };
type ApiKeyRow = { id: string; user_id: string; key_hash: string; revoked_at: number | null; grace_expires_at: number | null };

function makeMemDb() {
  const servers = new Map<string, ServerRow>();
  const apiKeys = new Map<string, ApiKeyRow>();

  const db: Database & {
    seedServer: (row: ServerRow) => void;
    seedApiKey: (row: ApiKeyRow) => void;
  } = {
    seedServer: (row) => servers.set(row.id, row),
    seedApiKey: (row) => apiKeys.set(row.id, row),
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
      const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (s.includes('select token_hash, user_id') && s.includes('from servers where id = $1')) {
        const row = servers.get(params[0] as string);
        return (row ? { token_hash: row.token_hash, user_id: row.user_id, node_role: 'full', revoked_at: null } : null) as T | null;
      }
      if (s.includes('select team_id, user_id from servers where id = $1')) {
        const row = servers.get(params[0] as string);
        return (row ? { team_id: row.team_id, user_id: row.user_id } : null) as T | null;
      }
      if (s.includes('select id, user_id from api_keys')) {
        const keyHash = params[0] as string;
        const now = params[1] as number;
        for (const row of apiKeys.values()) {
          if (row.key_hash === keyHash && row.revoked_at === null && (row.grace_expires_at === null || row.grace_expires_at > now)) {
            return ({ id: row.id, user_id: row.user_id } as T);
          }
        }
        return null;
      }
      if (s.includes('select role from team_members')) {
        return null;
      }
      return null;
    },
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    close: async () => {},
  } as any;

  return db;
}

function makeEnv(db: Database): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'http://localhost:3000',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'development',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
  };
}

/**
 * Minimal mock daemon WS. By default it auto-answers each `preview.request`
 * with a fast 200 so the relay resolves (used to keep the in-flight slot
 * occupied is NOT needed here; we only need the request to be forwarded).
 */
class MockDaemonWs extends EventEmitter {
  closed = false;
  readyState = 1; // OPEN
  autoRespond = true;

  send(data: string | Buffer, optsOrCb?: unknown, callback?: (err?: Error) => void): void {
    const cb = typeof optsOrCb === 'function' ? (optsOrCb as (e?: Error) => void) : callback;
    if (this.closed) { cb?.(new Error('closed')); return; }
    cb?.();
    if (this.autoRespond && typeof data === 'string') {
      let msg: Record<string, unknown> | null = null;
      try { msg = JSON.parse(data) as Record<string, unknown>; } catch { msg = null; }
      if (msg?.type === PREVIEW_MSG.REQUEST_END && typeof msg.requestId === 'string') {
        const requestId = msg.requestId;
        queueMicrotask(() => {
          this.emit('message', Buffer.from(JSON.stringify({
            type: PREVIEW_MSG.RESPONSE_START,
            requestId,
            status: 200,
            headers: { 'content-type': 'text/plain' },
          })), false);
          this.emit('message', packPreviewBinaryFrame(PREVIEW_BINARY_FRAME.RESPONSE_BODY, requestId, Buffer.from('ok')), true);
          this.emit('message', Buffer.from(JSON.stringify({ type: PREVIEW_MSG.RESPONSE_END, requestId })), false);
        });
      }
    }
  }

  close() { this.closed = true; this.readyState = 3; this.emit('close', 1000, Buffer.from('')); }
}

describe('local web preview availability side effects (daemon offline MUST NOT slide TTL)', () => {
  let serverId = 'srv-preview-avail';
  let userId = 'user-avail';
  let db: ReturnType<typeof makeMemDb>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    serverId = `srv-preview-avail-${Math.random().toString(36).slice(2)}`;
    userId = `user-avail-${Math.random().toString(36).slice(2)}`;
    db = makeMemDb();
    db.seedServer({ id: serverId, user_id: userId, team_id: null, token_hash: sha256Hex('daemon-token') });
    db.seedApiKey({ id: 'key1', user_id: userId, key_hash: sha256Hex('deck_test_key'), revoked_at: null, grace_expires_at: null });
    app = buildApp(makeEnv(db));
  });

  afterEach(() => {
    WsBridge.getAll().clear();
  });

  async function createPreview(): Promise<{ id: string; accessToken: string }> {
    const createRes = await app.request(`/api/server/${serverId}/local-web-preview`, {
      method: 'POST',
      headers: { Authorization: 'Bearer deck_test_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: 3000, path: '/' }),
    });
    expect(createRes.status).toBe(200);
    return (await createRes.json() as { preview: { id: string; accessToken: string } }).preview;
  }

  it('daemon OFFLINE: HTTP request returns 503 and does NOT slide the TTL (no touch)', async () => {
    const preview = await createPreview();
    const registry = LocalWebPreviewRegistry.get(serverId);

    // Snapshot the TTL fields BEFORE the offline request.
    const before = registry.peek(preview.id)!;
    const lastAccessBefore = before.lastAccessAt;
    const expiresBefore = before.expiresAt;

    // No daemon connection wired → bridge.isDaemonConnected() is false.
    const proxyRes = await app.request(
      `/api/server/${serverId}/local-web/${preview.id}/?${PREVIEW_ACCESS_TOKEN_QUERY_PARAM}=${preview.accessToken}`,
      { method: 'GET' },
    );

    // Availability outcome, NOT an authorization failure.
    expect(proxyRes.status).toBe(503);
    await expect(proxyRes.json()).resolves.toEqual({ error: PREVIEW_ERROR.DAEMON_OFFLINE });

    // The TTL MUST be unchanged — daemon-offline must not keep the preview alive.
    const after = registry.peek(preview.id)!;
    expect(after.lastAccessAt).toBe(lastAccessBefore);
    expect(after.expiresAt).toBe(expiresBefore);
  });

  it('daemon OFFLINE: the credential cookie MAY still be set (cached for retry)', async () => {
    const preview = await createPreview();

    const proxyRes = await app.request(
      `/api/server/${serverId}/local-web/${preview.id}/?${PREVIEW_ACCESS_TOKEN_QUERY_PARAM}=${preview.accessToken}`,
      { method: 'GET' },
    );

    expect(proxyRes.status).toBe(503);
    // setPreviewAccessCookie runs BEFORE the daemon gate → credential stays warm.
    expect(proxyRes.headers.get('set-cookie')).toContain(preview.accessToken);
  });

  it('daemon ONLINE in-flight 503: TTL IS slid (commit happened before the in-flight reject)', async () => {
    const preview = await createPreview();
    const registry = LocalWebPreviewRegistry.get(serverId);

    // Wire a daemon so isDaemonConnected() is true.
    const daemon = new MockDaemonWs();
    WsBridge.get(serverId).handleDaemonConnection(daemon as never, db as never, makeEnv(db) as never);
    daemon.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token: 'daemon-token' })), false);
    await new Promise((r) => setTimeout(r, 5));

    // Force the in-flight floor to reject: stub canAcceptPreviewInflight → false.
    const bridge = WsBridge.get(serverId);
    (bridge as unknown as { canAcceptPreviewInflight: (id: string) => boolean }).canAcceptPreviewInflight = () => false;

    // Advance the clock so a touch (if it happens) visibly moves lastAccessAt.
    const before = registry.peek(preview.id)!;
    const lastAccessBefore = before.lastAccessAt;
    await new Promise((r) => setTimeout(r, 5));

    const proxyRes = await app.request(
      `/api/server/${serverId}/local-web/${preview.id}/?${PREVIEW_ACCESS_TOKEN_QUERY_PARAM}=${preview.accessToken}`,
      { method: 'GET' },
    );

    // Rejected for in-flight pressure (daemon online).
    expect(proxyRes.status).toBe(503);
    await expect(proxyRes.json()).resolves.toEqual({ error: PREVIEW_ERROR.INFLIGHT_LIMIT });

    // commitAuthorizedAccess ran BEFORE the in-flight gate → TTL WAS slid.
    const after = registry.peek(preview.id)!;
    expect(after.lastAccessAt).toBeGreaterThan(lastAccessBefore);
  });
});
