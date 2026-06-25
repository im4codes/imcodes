import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { buildApp } from '../src/index.js';
import { WsBridge } from '../src/ws/bridge.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { sha256Hex, signJwt } from '../src/security/crypto.js';
import { COOKIE_CSRF, COOKIE_PREVIEW_ACCESS, COOKIE_SESSION, HEADER_CSRF } from '../../shared/cookie-names.js';
import {
  PREVIEW_ACCESS_TOKEN_QUERY_PARAM,
  PREVIEW_ERROR,
  PREVIEW_MSG,
  PREVIEW_BINARY_FRAME,
  packPreviewBinaryFrame,
} from '../../shared/preview-types.js';

/**
 * Minimal mock daemon WS for driving the preview proxy end-to-end in-process.
 * Auto-answers each `preview.request` with a fast 200 + body + response_end so
 * the HTTP relay resolves (used to prove first-paint bursts are NOT rejected).
 */
class MockDaemonWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1; // OPEN
  autoRespond = true;

  send(data: string | Buffer, optsOrCb?: unknown, callback?: (err?: Error) => void): void {
    const cb = typeof optsOrCb === 'function' ? (optsOrCb as (e?: Error) => void) : callback;
    if (this.closed) { cb?.(new Error('closed')); return; }
    this.sent.push(data);
    cb?.();
    if (this.autoRespond && typeof data === 'string') {
      let msg: Record<string, unknown> | null = null;
      try { msg = JSON.parse(data) as Record<string, unknown>; } catch { msg = null; }
      if (msg?.type === PREVIEW_MSG.REQUEST_END && typeof msg.requestId === 'string') {
        const requestId = msg.requestId;
        // Reply asynchronously, as the real daemon would.
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

type ServerRow = { id: string; user_id: string; team_id: string | null; token_hash: string };
type ApiKeyRow = { id: string; user_id: string; key_hash: string; revoked_at: number | null; grace_expires_at: number | null };
type ServerShareRow = {
  id: string;
  server_id: string;
  target_user_id: string;
  role: 'viewer' | 'participant';
  created_by: string;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  revoked_at: number | null;
};

function makeMemDb() {
  const servers = new Map<string, ServerRow>();
  const apiKeys = new Map<string, ApiKeyRow>();
  const serverShares = new Map<string, ServerShareRow>();

  const db: Database & {
    seedServer: (row: ServerRow) => void;
    seedApiKey: (row: ApiKeyRow) => void;
    seedServerShare: (row: ServerShareRow) => void;
    setServerOwner: (serverId: string, userId: string) => void;
  } = {
    seedServer: (row) => servers.set(row.id, row),
    seedApiKey: (row) => apiKeys.set(row.id, row),
    seedServerShare: (row) => serverShares.set(row.id, row),
    setServerOwner: (serverId, userId) => {
      const row = servers.get(serverId);
      if (row) row.user_id = userId;
    },
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
      const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (s.includes('select token_hash, user_id from servers where id = $1')) {
        const row = servers.get(params[0] as string);
        return (row ? { token_hash: row.token_hash, user_id: row.user_id } : null) as T | null;
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
    query: async <T = unknown>(sql: string, params: unknown[] = []) => {
      const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (s.includes('from server_shares') && s.includes('target_user_id = $2')) {
        const now = params[0] as number;
        const targetUserId = params[1] as string;
        return [...serverShares.values()]
          .filter((row) => row.target_user_id === targetUserId && row.revoked_at === null && (row.expires_at === null || row.expires_at > now))
          .map((row) => ({
            target_kind: 'server',
            id: row.id,
            server_id: row.server_id,
            session_name: null,
            sub_session_id: null,
            target_user_id: row.target_user_id,
            role: row.role,
            created_by: row.created_by,
            created_at: row.created_at,
            updated_at: row.updated_at,
            expires_at: row.expires_at,
            revoked_at: row.revoked_at,
          })) as T[];
      }
      return [] as T[];
    },
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

describe('local web preview routes', () => {
  let serverId = 'srv-preview-routes';
  let userId = 'user-preview';
  let db: ReturnType<typeof makeMemDb>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    serverId = `srv-preview-routes-${Math.random().toString(36).slice(2)}`;
    userId = `user-preview-${Math.random().toString(36).slice(2)}`;
    db = makeMemDb();
    db.seedServer({ id: serverId, user_id: userId, team_id: null, token_hash: sha256Hex('daemon-token') });
    db.seedApiKey({ id: 'key1', user_id: userId, key_hash: sha256Hex('deck_test_key'), revoked_at: null, grace_expires_at: null });
    app = buildApp(makeEnv(db));
  });

  afterEach(() => {
    WsBridge.getAll().clear();
  });

  function sessionCookie(csrf = 'csrf-token') {
    const token = signJwt({ sub: userId, role: 'member' }, 'test-signing-key-32chars-padding!!', 3600);
    return `${COOKIE_SESSION}=${token}; ${COOKIE_CSRF}=${csrf}`;
  }

  it('requires csrf for create and close under session-cookie auth', async () => {
    const createNoCsrf = await app.request(`/api/server/${serverId}/local-web-preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie(),
      },
      body: JSON.stringify({ port: 3000, path: '/' }),
    });
    expect(createNoCsrf.status).toBe(403);

    const createOk = await app.request(`/api/server/${serverId}/local-web-preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie(),
        [HEADER_CSRF]: 'csrf-token',
      },
      body: JSON.stringify({ port: 3000, path: '/' }),
    });
    expect(createOk.status).toBe(200);
    const created = await createOk.json() as { preview: { id: string; accessToken: string; url: string } };
    expect(created.preview.accessToken).toMatch(/^[a-f0-9]{48}$/);
    expect(created.preview.url).toContain(`${PREVIEW_ACCESS_TOKEN_QUERY_PARAM}=`);

    const closeNoCsrf = await app.request(`/api/server/${serverId}/local-web-preview/${created.preview.id}`, {
      method: 'DELETE',
      headers: {
        Cookie: sessionCookie(),
      },
    });
    expect(closeNoCsrf.status).toBe(403);

    const closeOk = await app.request(`/api/server/${serverId}/local-web-preview/${created.preview.id}`, {
      method: 'DELETE',
      headers: {
        Cookie: sessionCookie(),
        [HEADER_CSRF]: 'csrf-token',
      },
    });
    expect(closeOk.status).toBe(200);
  });

  it('denies share-only preview create and close with the direct-surface reason', async () => {
    const ownerId = userId;
    const shareUserId = `share-preview-${Math.random().toString(36).slice(2)}`;
    db.seedServerShare({
      id: 'share-preview-1',
      server_id: serverId,
      target_user_id: shareUserId,
      role: 'participant',
      created_by: ownerId,
      created_at: Date.now() - 1_000,
      updated_at: Date.now() - 1_000,
      expires_at: null,
      revoked_at: null,
    });
    userId = shareUserId;

    const createRes = await app.request(`/api/server/${serverId}/local-web-preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie(),
        [HEADER_CSRF]: 'csrf-token',
      },
      body: JSON.stringify({ port: 3000, path: '/' }),
    });
    expect(createRes.status).toBe(403);
    await expect(createRes.json()).resolves.toEqual({ error: PREVIEW_ERROR.FORBIDDEN, reason: 'share-direct-surface-denied' });

    const closeRes = await app.request(`/api/server/${serverId}/local-web-preview/preview-share-only`, {
      method: 'DELETE',
      headers: {
        Cookie: sessionCookie(),
        [HEADER_CSRF]: 'csrf-token',
      },
    });
    expect(closeRes.status).toBe(403);
    await expect(closeRes.json()).resolves.toEqual({ error: PREVIEW_ERROR.FORBIDDEN, reason: 'share-direct-surface-denied' });
  });

  it('revalidates access on every proxied request after preview creation', async () => {
    const createRes = await app.request(`/api/server/${serverId}/local-web-preview`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer deck_test_key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ port: 3000, path: '/' }),
    });
    expect(createRes.status).toBe(200);
    const created = await createRes.json() as { preview: { id: string } };

    db.setServerOwner(serverId, 'other-user');

    const proxyRes = await app.request(`/api/server/${serverId}/local-web/${created.preview.id}/`, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer deck_test_key',
      },
    });
    expect(proxyRes.status).toBe(403);
  });

  it('allows preview proxy requests with a valid preview access token and sets a preview cookie', async () => {
    const createRes = await app.request(`/api/server/${serverId}/local-web-preview`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer deck_test_key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ port: 3000, path: '/' }),
    });
    expect(createRes.status).toBe(200);
    const created = await createRes.json() as { preview: { id: string; accessToken: string } };

    const proxyRes = await app.request(
      `/api/server/${serverId}/local-web/${created.preview.id}/?${PREVIEW_ACCESS_TOKEN_QUERY_PARAM}=${created.preview.accessToken}`,
      { method: 'GET' },
    );

    expect([503, 502]).toContain(proxyRes.status);
    expect(proxyRes.headers.get('set-cookie')).toContain(`${COOKIE_PREVIEW_ACCESS}=${created.preview.accessToken}`);
  });

  // ── V-conc-首屏 (run 8a975732-23a P0.5.1 / P0.6) ────────────────────────────
  // Replaces the removed "121st request → 429" per-request count-limit assertion.
  // A real SPA first paint fires dozens–hundreds of fast sub-resource requests;
  // with the count limiter gone and only an in-flight concurrency floor remaining,
  // a high-but-fast-completing burst MUST NOT be rejected with 429 OR 503.
  it('V-conc-首屏: a fast >120/min burst is never rejected with 429 or 503', async () => {
    // Wire a mock daemon that auto-answers each request fast, so the relay
    // resolves (proving requests are forwarded, not daemon-offline-503).
    const daemon = new MockDaemonWs();
    WsBridge.get(serverId).handleDaemonConnection(daemon as never, db as never, makeEnv(db) as never);
    daemon.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token: 'daemon-token' })), false);
    await new Promise((r) => setTimeout(r, 5));

    const createRes = await app.request(`/api/server/${serverId}/local-web-preview`, {
      method: 'POST',
      headers: { Authorization: 'Bearer deck_test_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: 3000, path: '/' }),
    });
    const created = await createRes.json() as { preview: { id: string; accessToken: string } };

    // 130 sequential (fast-completing) requests — each settles before the next,
    // so in-flight is always 1 and far below the floor.
    for (let i = 0; i < 130; i++) {
      const res = await app.request(
        `/api/server/${serverId}/local-web/${created.preview.id}/?${PREVIEW_ACCESS_TOKEN_QUERY_PARAM}=${created.preview.accessToken}`,
        { method: 'GET' },
      );
      expect(res.status).not.toBe(429);
      expect(res.status).not.toBe(503);
      expect(res.status).toBe(200);
    }
  });
});
