import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { buildApp } from '../src/index.js';
import { requireAuth, requireRole, resolveAuth, resolveAuthOutcome } from '../src/security/authorization.js';
import { sha256Hex, signJwt } from '../src/security/crypto.js';
import { ALIAS_API_PATH } from '../../shared/alias-types.js';
import { COOKIE_SESSION } from '../../shared/cookie-names.js';
import { SERVER_ID_HEADER } from '../../shared/http-header-names.js';

const SIGNING_KEY = 'test-signing-key-32chars-padding!!';

function makeAuthCountingDb(opts?: { userStatus?: string; serverRevokedAt?: number | null }) {
  let userStatus = opts?.userStatus ?? 'active';
  const serverToken = 'daemon-secret-token';
  const serverTokenHash = sha256Hex(serverToken);
  const queryOne = vi.fn(async (sql: string) => {
    const s = sql.toLowerCase();
    if (s.includes('from servers where id')) {
      return {
        token_hash: serverTokenHash,
        user_id: 'user-1',
        node_role: 'full',
        revoked_at: opts?.serverRevokedAt ?? null,
        owner_status: userStatus,
      };
    }
    if (s.includes('from users where id')) {
      return {
        id: 'user-1',
        status: userStatus,
        is_admin: false,
      };
    }
    return null;
  });

  const db = {
    queryOne,
    query: vi.fn(async () => []),
    execute: vi.fn(async () => ({ changes: 1 })),
    exec: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as Database;

  return {
    db,
    queryOne,
    serverToken,
    setUserStatus(nextStatus: string) {
      userStatus = nextStatus;
    },
  };
}

function makeEnv(db: Database): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: SIGNING_KEY,
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'http://localhost:3000',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'development',
  };
}

describe('request-scoped resolveAuthOutcome memoization', () => {
  it('executes only a single DB lookup across repeated resolveAuth/requireAuth/requireRole calls in the same HTTP request', async () => {
    const { db, queryOne } = makeAuthCountingDb();
    const env = makeEnv(db);
    const jwt = signJwt({ sub: 'user-1', role: 'member' }, SIGNING_KEY, 300);

    const app = new Hono<{ Bindings: Env }>();
    app.get('/memo-check', async (c, next) => {
      const a1 = await resolveAuth(c);
      const [a2, o3] = await Promise.all([resolveAuth(c), resolveAuthOutcome(c)]);
      expect(a1?.userId).toBe('user-1');
      expect(a2?.userId).toBe('user-1');
      expect(o3.auth?.userId).toBe('user-1');
      return requireAuth()(c, next);
    }, requireRole('member'), async (c) => {
      const finalOutcome = await resolveAuthOutcome(c);
      return c.json({ userId: finalOutcome.auth?.userId ?? null });
    });

    const res = await app.request(
      '/memo-check',
      { headers: { Cookie: `${COOKIE_SESSION}=${encodeURIComponent(jwt)}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'user-1' });
    expect(queryOne).toHaveBeenCalledTimes(1);
  });

  it('reuses a single DB lookup across daemon preflight middleware and downstream route handlers in buildApp', async () => {
    const { db, queryOne, serverToken } = makeAuthCountingDb();
    const env = makeEnv(db);
    const app = buildApp(env);

    const res = await app.request(ALIAS_API_PATH, {
      headers: {
        [SERVER_ID_HEADER]: 'srv-1',
        Authorization: `Bearer ${serverToken}`,
      },
    });
    expect(res.status).toBe(200);
    // Daemon preflight (index.ts) + route requireAuth() share the single DB query for this request
    expect(queryOne).toHaveBeenCalledTimes(1);
  });

  it('never caches auth state across separate HTTP requests so user disable takes immediate effect', async () => {
    const { db, queryOne, setUserStatus } = makeAuthCountingDb({ userStatus: 'active' });
    const env = makeEnv(db);
    const jwt = signJwt({ sub: 'user-1', role: 'member' }, SIGNING_KEY, 300);
    const app = buildApp(env);

    const first = await app.request(ALIAS_API_PATH, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(first.status).toBe(200);
    expect(queryOne).toHaveBeenCalledTimes(1);

    setUserStatus('disabled');

    const second = await app.request(ALIAS_API_PATH, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(second.status).toBe(403);
    expect(queryOne).toHaveBeenCalledTimes(2);
  });

  it('does not serve stale auth if a synthetic context object changes headers between calls', async () => {
    const { db, queryOne } = makeAuthCountingDb();
    const env = makeEnv(db);
    const jwt1 = signJwt({ sub: 'user-1', role: 'member' }, SIGNING_KEY, 300);
    const jwt2 = signJwt({ sub: 'user-1', role: 'admin' }, SIGNING_KEY, 300);

    let currentAuth = `Bearer ${jwt1}`;
    const syntheticCtx = {
      env,
      req: {
        header: (name: string) => (name.toLowerCase() === 'authorization' ? currentAuth : undefined),
        path: '/api/auth/user/me',
        method: 'GET',
      },
    } as unknown as Parameters<typeof resolveAuthOutcome>[0];

    const r1 = await resolveAuthOutcome(syntheticCtx);
    const r1Repeat = await resolveAuthOutcome(syntheticCtx);
    expect(r1.auth?.role).toBe('member');
    expect(r1Repeat.auth?.role).toBe('member');
    expect(queryOne).toHaveBeenCalledTimes(1);

    currentAuth = `Bearer ${jwt2}`;
    const r2 = await resolveAuthOutcome(syntheticCtx);
    expect(r2.auth?.role).toBe('admin');
    expect(queryOne).toHaveBeenCalledTimes(2);
  });
});
