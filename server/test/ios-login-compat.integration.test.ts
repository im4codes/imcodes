/**
 * iOS Login Compatibility Integration Tests
 *
 * ⚠️  CRITICAL — DO NOT MODIFY THESE ASSERTIONS ⚠️
 *
 * These tests protect backward compatibility for iOS native app login.
 * Older iOS app versions (shipped via App Store) cannot be updated instantly —
 * they rely on specific response shapes and CORS behavior.
 *
 * Breaking any of these tests WILL break iOS app login for ALL users
 * until they update the app from the App Store.
 *
 * Specifically:
 * 1. passkey/login/complete?native=1 JSON response MUST include apiKey + keyId + userId (legacy) AND nonce (new)
 * 2. passkey native_callback redirect URL MUST include key + userId + keyId (legacy) AND nonce (new)
 * 3. password/login with native=true MUST return apiKey + keyId + userId
 * 4. CORS MUST allow X-Platform, X-App-Version, X-Bundle-Version headers (telemetry from native app)
 * 5. /api/auth/token-exchange MUST be exempt from CSRF (native app has no CSRF token pre-login)
 * 6. /api/auth/password/login MUST be exempt from CSRF
 * 7. /api/auth/password/register MUST be exempt from CSRF
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildApp } from '../src/index.js';
import { randomHex, sha256Hex, hashPassword } from '../src/security/crypto.js';
import type { Env } from '../src/env.js';

// ── DB lifecycle ──────────────────────────────────────────────────────────────

let db: Database;
const JWT_KEY = 'test-jwt-key-for-ios-compat-tests-00000';
const SERVER_URL = 'https://test.example.com';

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeApp() {
  const env: Env = {
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    JWT_SIGNING_KEY: JWT_KEY,
    BOT_ENCRYPTION_KEY: randomHex(32),
    DB: db,
    NODE_ENV: 'test',
    SERVER_URL,
    ALLOWED_ORIGINS: 'capacitor://localhost,https://localhost,http://localhost',
  } as Env;
  return buildApp(env);
}

async function ensureUser(userId: string, opts?: { username?: string; password?: string }): Promise<void> {
  const existing = await db.queryOne<{ id: string }>('SELECT id FROM users WHERE id = $1', [userId]);
  if (!existing) {
    const pwHash = opts?.password ? await hashPassword(opts.password) : null;
    await db.execute(
      'INSERT INTO users (id, username, password_hash, display_name, is_admin, status, created_at) VALUES ($1, $2, $3, $4, false, $5, $6)',
      [userId, opts?.username ?? null, pwHash, 'iOS Test User', 'active', Date.now()],
    );
  }
}

async function insertNonce(nonce: string, apiKey: string, userId: string, keyId: string): Promise<void> {
  await db.execute(
    'INSERT INTO auth_nonces (nonce, api_key, user_id, key_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [nonce, apiKey, userId, keyId, Date.now() + 60_000, Date.now()],
  );
}

// ── CORS Tests — iOS native app requires these headers ───────────────────────

describe('iOS CORS compatibility', () => {
  it('⚠️ MUST allow X-Platform, X-App-Version, X-Bundle-Version in CORS preflight', async () => {
    const app = makeApp();
    const res = await app.request('/api/auth/user/me', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'capacitor://localhost',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type,X-Platform,X-App-Version,X-Bundle-Version',
      },
    });
    // Preflight must succeed (200 or 204)
    expect(res.status).toBeLessThan(400);
    const allowHeaders = res.headers.get('Access-Control-Allow-Headers')?.toLowerCase() ?? '';
    expect(allowHeaders).toContain('x-platform');
    expect(allowHeaders).toContain('x-app-version');
    expect(allowHeaders).toContain('x-bundle-version');
  });

  it('⚠️ MUST allow capacitor://localhost origin', async () => {
    const app = makeApp();
    const res = await app.request('/api/auth/user/me', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'capacitor://localhost',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost');
  });
});

// ── CSRF Exemption Tests — native app has no CSRF token pre-login ────────────

describe('iOS CSRF exemptions', () => {
  it('⚠️ /api/auth/token-exchange MUST NOT require CSRF token', async () => {
    const app = makeApp();
    const userId = randomHex(16);
    await ensureUser(userId);
    const nonce = randomHex(32);
    const apiKey = `deck_${randomHex(32)}`;
    const keyId = randomHex(16);
    await insertNonce(nonce, apiKey, userId, keyId);

    // POST without any CSRF cookie/header — must not be rejected
    const res = await app.request('/api/auth/token-exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
    });
    expect(res.status).toBe(200);
  });

  it('⚠️ /api/auth/password/login MUST NOT require CSRF token', async () => {
    const app = makeApp();
    const userId = randomHex(16);
    const username = `ios_test_${randomHex(4)}`;
    await ensureUser(userId, { username, password: 'TestPass123' });

    const res = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'TestPass123' }),
    });
    expect(res.status).toBe(200);
  });

  it('⚠️ /api/auth/password/register MUST NOT require CSRF token', async () => {
    const app = makeApp();
    const username = `ios_reg_${randomHex(4)}`;
    const res = await app.request('/api/auth/password/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'TestPass123', displayName: 'iOS Tester' }),
    });
    // 200 or 403 (registration_disabled) are both acceptable — but NOT 403 with csrf_rejected
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).not.toBe('csrf_rejected');
  });
});

// ── Password Login Response Shape — iOS native app depends on this ───────────

describe('iOS password login response shape', () => {
  it('⚠️ password/login with native=true MUST return apiKey + keyId + userId', async () => {
    const app = makeApp();
    const userId = randomHex(16);
    const username = `ios_pw_${randomHex(4)}`;
    await ensureUser(userId, { username, password: 'TestPass123' });

    const res = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'TestPass123', native: true }),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    // ⚠️ These fields are required by iOS native app — DO NOT REMOVE
    expect(body).toHaveProperty('apiKey');
    expect(body).toHaveProperty('keyId');
    expect(body).toHaveProperty('userId');
    expect(typeof body.apiKey).toBe('string');
    expect(typeof body.keyId).toBe('string');
    expect(typeof body.userId).toBe('string');
    expect((body.apiKey as string).startsWith('deck_')).toBe(true);
  });
});

// ── Token Exchange Response Shape ────────────────────────────────────────────

describe('iOS token exchange response shape', () => {
  it('⚠️ token-exchange MUST return apiKey + userId + keyId', async () => {
    const app = makeApp();
    const userId = randomHex(16);
    await ensureUser(userId);
    const nonce = randomHex(32);
    const apiKey = `deck_${randomHex(32)}`;
    const keyId = randomHex(16);
    await insertNonce(nonce, apiKey, userId, keyId);

    const res = await app.request('/api/auth/token-exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    // ⚠️ All three fields required — old iOS uses apiKey directly, new iOS uses nonce exchange
    expect(body).toHaveProperty('apiKey');
    expect(body).toHaveProperty('userId');
    expect(body).toHaveProperty('keyId');
  });
});
