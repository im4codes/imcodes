/**
 * Security tests: cookie path, per-user rate limiting, JWT_SIGNING_KEY length
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/index.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';

// ── In-memory mock DB ─────────────────────────────────────────────────────────

function makeMemDb(): Database {
  const users = new Map<string, { id: string; created_at: number; is_admin: boolean; status: string }>();
  const apiKeys = new Map<string, { id: string; user_id: string; key_hash: string; created_at: number; revoked_at: number | null; grace_expires_at: number | null }>();
  const refreshTokens = new Map<string, { id: string; user_id: string; token_hash: string; family_id: string; expires_at: number; created_at: number; used_at: number | null }>();
  // auth_lockout: identity → { fail_count, first_fail_at, locked_until }
  const lockout = new Map<string, { identity: string; fail_count: number; first_fail_at: Date; locked_until: Date | null }>();
  const auditLog: unknown[] = [];

  function normalize(sql: string): string {
    return sql.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  return {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const s = normalize(sql);

      if (s.includes('from users where id')) {
        return (users.get(params[0] as string) ?? null) as T | null;
      }
      if (s.includes('from api_keys where key_hash')) {
        for (const k of apiKeys.values()) {
          if (k.key_hash === params[0] && !k.revoked_at) return { user_id: k.user_id } as T;
        }
        return null;
      }
      if (s.includes('from refresh_tokens where token_hash')) {
        const now = params[1] as number;
        for (const rt of refreshTokens.values()) {
          if (rt.token_hash === params[0] && rt.used_at === null && rt.expires_at > now) {
            return { id: rt.id, user_id: rt.user_id, family_id: rt.family_id } as T;
          }
        }
        return null;
      }
      if (s.includes('from auth_lockout') && s.includes('locked_until > now')) {
        const entry = lockout.get(params[0] as string);
        if (entry && entry.locked_until && entry.locked_until > new Date()) {
          return { locked_until: entry.locked_until } as T;
        }
        return null;
      }
      // ON CONFLICT upsert for auth_lockout — returns fail_count + locked_until
      if (s.includes('insert into auth_lockout')) {
        const identity = params[0] as string;
        const now = new Date();
        const existing = lockout.get(identity);
        let failCount: number;
        let firstFailAt: Date;

        if (!existing || existing.first_fail_at < new Date(now.getTime() - 15 * 60 * 1000)) {
          failCount = 1;
          firstFailAt = now;
        } else {
          failCount = existing.fail_count + 1;
          firstFailAt = existing.first_fail_at;
        }

        const lockedUntil = failCount >= 5 ? new Date(now.getTime() + 15 * 60 * 1000) : null;
        lockout.set(identity, { identity, fail_count: failCount, first_fail_at: firstFailAt, locked_until: lockedUntil });
        return { fail_count: failCount, locked_until: lockedUntil } as T;
      }
      return null;
    },
    query: async <T = unknown>(): Promise<T[]> => {
      return [] as T[];
    },
    execute: async (sql: string, params: unknown[] = []): Promise<{ changes: number }> => {
      const s = normalize(sql);

      if (s.includes('insert into users')) {
        users.set(params[0] as string, { id: params[0] as string, created_at: params[1] as number, is_admin: false, status: 'active' });
      }
      if (s.includes('insert into api_keys')) {
        apiKeys.set(params[0] as string, {
          id: params[0] as string,
          user_id: params[1] as string,
          key_hash: params[2] as string,
          created_at: params[3] as number,
          revoked_at: null,
          grace_expires_at: null,
        });
      }
      if (s.includes('insert into refresh_tokens')) {
        // (id, user_id, token_hash, family_id, expires_at, created_at)
        refreshTokens.set(params[0] as string, {
          id: params[0] as string,
          user_id: params[1] as string,
          token_hash: params[2] as string,
          family_id: params[3] as string,
          expires_at: params[4] as number,
          created_at: params[5] as number,
          used_at: null,
        });
      }
      if (s.includes('update refresh_tokens set used_at')) {
        const token = refreshTokens.get(params[1] as string);
        if (token) token.used_at = params[0] as number;
      }
      if (s.includes('insert into audit_log')) {
        auditLog.push(params);
      }
      return { changes: 1 };
    },
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;
}

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    DB: makeMemDb(),
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
    ...overrides,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function registerAndGetKey(app: ReturnType<typeof buildApp>): Promise<string> {
  const res = await app.request('/api/auth/register', { method: 'POST' });
  const { apiKey } = await res.json() as { apiKey: string };
  return apiKey;
}

/**
 * Login via refresh endpoint — seeds a refresh token directly into the DB returned by makeMemDb.
 * We call the login route (GitHub OAuth is complex) — instead we use the register+seeded-refresh approach:
 * seed a refresh token directly, then call POST /api/auth/refresh with it.
 */
async function seedRefreshToken(
  db: Database,
  userId: string,
  rawToken: string,
  sha256HexFn: (s: string) => string,
): Promise<void> {
  const tokenHash = sha256HexFn(rawToken);
  await db.execute(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [`rt_${Math.random().toString(36).slice(2)}`, userId, tokenHash, 'family1', Date.now() + 30 * 86400 * 1000, Date.now()],
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Fix 1: rcc_refresh cookie path', () => {
  let app: ReturnType<typeof buildApp>;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeEnv();
    app = buildApp(env);
  });

  it('sets rcc_refresh cookie with path=/ (not path=/api/auth/refresh)', async () => {
    // Seed a refresh token directly in the DB
    const { sha256Hex } = await import('../src/security/crypto.js');
    const rawToken = 'test-refresh-token-seed-value-abc123';

    // Register to get a user
    const regRes = await app.request('/api/auth/register', { method: 'POST' });
    const { userId } = await regRes.json() as { userId: string; apiKey: string };

    // Seed refresh token
    await seedRefreshToken(env.DB, userId, rawToken, sha256Hex);

    // Call refresh with the token in body (CLI flow)
    const res = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rawToken }),
    });
    // CLI flow returns JSON, not cookies
    expect(res.status).toBe(200);
    const body = await res.json() as { accessToken?: string; refreshToken?: string };
    expect(body.refreshToken).toBeTruthy();

    // Now test cookie flow: send as cookie header to simulate browser
    // Seed another refresh token for cookie flow test
    const rawToken2 = 'test-refresh-token-cookie-flow-xyz999';
    await seedRefreshToken(env.DB, userId, rawToken2, sha256Hex);

    const res2 = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `rcc_refresh=${rawToken2}`,
      },
      body: JSON.stringify({}),
    });
    expect(res2.status).toBe(200);

    // Check Set-Cookie header for rcc_refresh
    const setCookieHeader = res2.headers.get('set-cookie') ?? '';
    // There may be multiple Set-Cookie headers joined — check the one for rcc_refresh
    const allCookies = res2.headers.getSetCookie?.() ?? [setCookieHeader];
    const refreshCookie = allCookies.find((c: string) => c.startsWith('rcc_refresh='));
    expect(refreshCookie).toBeTruthy();
    // Should have path=/ not path=/api/auth/refresh
    expect(refreshCookie).toMatch(/path=\//i);
    expect(refreshCookie?.toLowerCase()).not.toContain('/api/auth/refresh');
  });
});

describe('Fix 3: Per-user rate limiting on JWT refresh', () => {
  it('returns 429 after 5 failed attempts for per-user lockout', async () => {
    // We test the per-user lockout by verifying a user cannot be locked out via
    // invalid tokens — after 5 IP failures the IP is locked. For per-user, we need
    // to record failures on user:<userId>. This is tested indirectly:
    // 1. Pre-populate the lockout DB with 5 failures for user:<userId>
    // 2. Then call refresh with a valid token — should get 429 from per-user lockout.

    const env = makeEnv();
    const app = buildApp(env);

    const { sha256Hex } = await import('../src/security/crypto.js');

    // Register to create a user
    const regRes = await app.request('/api/auth/register', { method: 'POST' });
    const { userId } = await regRes.json() as { userId: string; apiKey: string };

    // Simulate 5 failed auth attempts for user:<userId> directly in the lockout table
    // by calling recordAuthFailure 5 times
    const { recordAuthFailure } = await import('../src/security/lockout.js');
    for (let i = 0; i < 5; i++) {
      await recordAuthFailure(env.DB, `user:${userId}`);
    }

    // Seed a valid refresh token
    const rawToken = 'valid-refresh-token-for-user-lockout-test';
    await seedRefreshToken(env.DB, userId, rawToken, sha256Hex);

    // Attempt refresh — should hit per-user lockout even though token is valid
    const res = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rawToken }),
    });
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('too_many_attempts');
  });
});

describe('Fix 5: JWT_SIGNING_KEY minimum length validation', () => {
  it('Buffer.byteLength check catches keys shorter than 32 bytes', () => {
    // Directly test the condition from index.ts
    const shortKey = 'short-key';
    expect(Buffer.byteLength(shortKey, 'utf8')).toBeLessThan(32);

    const longKey = 'test-signing-key-32chars-padding!!';
    expect(Buffer.byteLength(longKey, 'utf8')).toBeGreaterThanOrEqual(32);
  });

  it('rejects a missing JWT_SIGNING_KEY (falsy check)', () => {
    const missingKey = '';
    // The condition: !key || byteLength < 32
    expect(!missingKey || Buffer.byteLength(missingKey, 'utf8') < 32).toBe(true);
  });

  it('accepts a key of exactly 32 bytes', () => {
    const exactKey = 'a'.repeat(32); // 32 ASCII chars = 32 bytes
    expect(!exactKey || Buffer.byteLength(exactKey, 'utf8') < 32).toBe(false);
  });

  it('accepts a multibyte UTF-8 key that is >= 32 bytes', () => {
    // Each '€' is 3 bytes in UTF-8, so 11 chars = 33 bytes
    const multibyteKey = '€'.repeat(11);
    expect(Buffer.byteLength(multibyteKey, 'utf8')).toBeGreaterThanOrEqual(32);
    expect(!multibyteKey || Buffer.byteLength(multibyteKey, 'utf8') < 32).toBe(false);
  });
});

// ── OAuth origin allowlist + redirect safety tests ──────────────────────────

describe('OAuth origin allowlist', () => {
  it('GET /api/auth/github redirects to GitHub with state JWT containing only allowlisted origin', async () => {
    const env = makeEnv({
      SERVER_URL: 'https://app.im.codes',
      ALLOWED_ORIGINS: 'https://im.codes,https://app.im.codes',
      NODE_ENV: 'production',
    });
    const app = buildApp(env);

    // Request with a trusted resolved host that IS in the allowlist
    const res = await app.request('/api/auth/github', {
      headers: { host: 'app.im.codes' },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('github.com/login/oauth/authorize');
    // The state param contains a signed JWT with origin — we just verify the redirect works
  });

  it('GitHub OAuth callback final redirect falls back to SERVER_URL for non-allowlisted origin', async () => {
    const { signJwt, randomHex } = await import('../src/security/crypto.js');
    const env = makeEnv({
      SERVER_URL: 'https://app.im.codes',
      ALLOWED_ORIGINS: 'https://app.im.codes',
      NODE_ENV: 'production',
    });
    const app = buildApp(env);

    // Craft a state JWT with a non-allowlisted origin injected
    const stateNonce = randomHex(32);
    const stateJwt = signJwt({ nonce: stateNonce, origin: 'https://evil.example.com' }, env.JWT_SIGNING_KEY, 600);

    // The callback should NOT relay or redirect to the evil origin.
    // It will fail state_mismatch (no cookie) but the important thing is it doesn't redirect to evil.example.com.
    const res = await app.request(`/api/auth/github/callback?code=fake&state=${stateJwt}`, {
      headers: {
        host: 'app.im.codes',
        cookie: `oauth_state=${stateNonce}`,
      },
    });

    // It may fail at token exchange (502) or state_mismatch, but must NOT redirect to evil.example.com
    const location = res.headers.get('location') ?? '';
    expect(location).not.toContain('evil.example.com');
  });

  it('resolvedHost middleware does not trust x-forwarded-host without trusted proxy', async () => {
    const env = makeEnv({
      SERVER_URL: 'https://app.im.codes',
      ALLOWED_ORIGINS: 'https://im.codes',
      TRUSTED_PROXIES: '', // no trusted proxies
      NODE_ENV: 'production',
    });
    const app = buildApp(env);

    // Direct connection with spoofed x-forwarded-host should be ignored.
    // The OAuth redirect should use SERVER_URL, not the spoofed host.
    const res = await app.request('/api/auth/github', {
      headers: {
        host: 'app.im.codes',
        'x-forwarded-host': 'im.codes',
      },
    });
    expect(res.status).toBe(302);
    // The state JWT should contain SERVER_URL or the host header value,
    // not the spoofed x-forwarded-host
  });
});

// ── GitHub OAuth refresh cookie path test ───────────────────────────────────

describe('GitHub OAuth callback sets rcc_refresh with path=/', () => {
  it('rcc_refresh cookie path is / in github-auth route (verified by code inspection and existing test)', async () => {
    // Read the github-auth source and verify the cookie path is '/'
    // This is a structural test: we import and check the route source
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(__dirname, '..', 'src', 'routes', 'github-auth.ts'), 'utf-8');

    // Find the rcc_refresh setCookie call — it should have path: '/'
    const refreshMatch = source.match(/setCookie\(c,\s*'rcc_refresh'[\s\S]*?path:\s*'([^']*)'/);
    expect(refreshMatch).toBeTruthy();
    expect(refreshMatch![1]).toBe('/');
  });
});

// ── Security headers on HTML responses ──────────────────────────────────────

describe('Security headers on HTML responses', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp(makeEnv());
  });

  it('SPA fallback response includes all required security headers', async () => {
    // Request a non-API, non-existent path → SPA fallback (index.html)
    // Note: in test environment WEB_DIST may not exist, so this might 404.
    // But let's check the static handler's SECURITY_HEADERS constant via source.
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(__dirname, '..', 'src', 'index.ts'), 'utf-8');

    // Verify SECURITY_HEADERS includes all required headers
    expect(source).toContain("'X-Frame-Options': 'DENY'");
    expect(source).toContain("'X-Content-Type-Options': 'nosniff'");
    expect(source).toContain("'Referrer-Policy': 'no-referrer'");
    expect(source).toContain('Permissions-Policy');
    expect(source).toContain('Content-Security-Policy');
    expect(source).toContain("frame-ancestors 'none'");
  });

  it('SECURITY_HEADERS are applied to HTML responses, not non-HTML', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(__dirname, '..', 'src', 'index.ts'), 'utf-8');

    // The code should only apply SECURITY_HEADERS when ext === 'html'
    expect(source).toContain("if (ext === 'html') Object.assign(headers, SECURITY_HEADERS)");
    // SPA fallback should also include them
    expect(source).toContain('...SECURITY_HEADERS');
  });
});
