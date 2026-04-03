/**
 * Token-exchange integration tests — runs against real PostgreSQL via testcontainers.
 *
 * Covers: valid nonce exchange, replay rejection, expired nonce rejection,
 * missing/invalid nonce, and cleanup of expired nonces.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildApp } from '../src/index.js';
import { randomHex, sha256Hex } from '../src/security/crypto.js';
import { cleanupExpiredAuthNonces } from '../src/routes/auth.js';
import type { Env } from '../src/env.js';

// ── DB lifecycle ──────────────────────────────────────────────────────────────

let db: Database;
const JWT_KEY = 'test-jwt-key-for-token-exchange-tests-00000';

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
    ALLOWED_ORIGINS: 'http://localhost',
  } as Env;
  return buildApp(env);
}

async function cleanNonces(): Promise<void> {
  await db.exec('DELETE FROM auth_nonces');
}

async function ensureUser(userId: string): Promise<void> {
  const existing = await db.queryOne<{ id: string }>(
    'SELECT id FROM users WHERE id = $1',
    [userId],
  );
  if (!existing) {
    await db.execute(
      'INSERT INTO users (id, display_name, is_admin, status, created_at) VALUES ($1, $2, false, $3, $4)',
      [userId, 'Test User', 'active', Date.now()],
    );
  }
}

async function insertNonce(
  nonce: string,
  apiKey: string,
  userId: string,
  keyId: string,
  expiresAt: number,
): Promise<void> {
  await db.execute(
    'INSERT INTO auth_nonces (nonce, api_key, user_id, key_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [nonce, apiKey, userId, keyId, expiresAt, Date.now()],
  );
}

function tokenExchange(app: ReturnType<typeof buildApp>, nonce: string) {
  return app.request('/api/auth/token-exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce }),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/auth/token-exchange', () => {
  const userId = randomHex(16);

  beforeAll(async () => {
    await ensureUser(userId);
  });

  beforeEach(async () => {
    await cleanNonces();
  });

  it('exchanges a valid nonce for API key, userId, and keyId', async () => {
    const app = makeApp();
    const nonce = randomHex(32);
    const apiKey = `deck_${randomHex(32)}`;
    const keyId = randomHex(16);
    const expiresAt = Date.now() + 60_000;
    await insertNonce(nonce, apiKey, userId, keyId, expiresAt);

    const res = await tokenExchange(app, nonce);
    expect(res.status).toBe(200);

    const body = await res.json() as { apiKey: string; userId: string; keyId: string };
    expect(body.apiKey).toBe(apiKey);
    expect(body.userId).toBe(userId);
    expect(body.keyId).toBe(keyId);
  });

  it('rejects replay — exchanging the same nonce twice returns 400', async () => {
    const app = makeApp();
    const nonce = randomHex(32);
    const apiKey = `deck_${randomHex(32)}`;
    const keyId = randomHex(16);
    const expiresAt = Date.now() + 60_000;
    await insertNonce(nonce, apiKey, userId, keyId, expiresAt);

    // First exchange succeeds
    const res1 = await tokenExchange(app, nonce);
    expect(res1.status).toBe(200);

    // Second exchange fails (nonce was consumed by DELETE ... RETURNING)
    const res2 = await tokenExchange(app, nonce);
    expect(res2.status).toBe(400);
    const body = await res2.json() as { error: string };
    expect(body.error).toBe('invalid_or_expired_nonce');
  });

  it('rejects an expired nonce', async () => {
    const app = makeApp();
    const nonce = randomHex(32);
    const apiKey = `deck_${randomHex(32)}`;
    const keyId = randomHex(16);
    const expiresAt = Date.now() - 1000; // expired 1 second ago
    await insertNonce(nonce, apiKey, userId, keyId, expiresAt);

    const res = await tokenExchange(app, nonce);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_or_expired_nonce');
  });

  it('rejects a missing/random nonce', async () => {
    const app = makeApp();
    const nonce = randomHex(32); // not inserted into DB

    const res = await tokenExchange(app, nonce);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_or_expired_nonce');
  });

  it('rejects an empty nonce', async () => {
    const app = makeApp();

    const res = await tokenExchange(app, '');
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_body');
  });

  it('rejects a request with no body', async () => {
    const app = makeApp();

    const res = await app.request('/api/auth/token-exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_body');
  });

  it('cleanup removes expired nonces', async () => {
    const expiredNonce = randomHex(32);
    const validNonce = randomHex(32);
    const apiKey1 = `deck_${randomHex(32)}`;
    const apiKey2 = `deck_${randomHex(32)}`;
    const keyId1 = randomHex(16);
    const keyId2 = randomHex(16);

    // Insert one expired and one valid nonce
    await insertNonce(expiredNonce, apiKey1, userId, keyId1, Date.now() - 5000);
    await insertNonce(validNonce, apiKey2, userId, keyId2, Date.now() + 60_000);

    // Run cleanup
    const deleted = await cleanupExpiredAuthNonces(db);
    expect(deleted).toBeGreaterThanOrEqual(1);

    // Expired nonce should be gone
    const expiredRow = await db.queryOne<{ nonce: string }>(
      'SELECT nonce FROM auth_nonces WHERE nonce = $1',
      [expiredNonce],
    );
    expect(expiredRow).toBeNull();

    // Valid nonce should still exist
    const validRow = await db.queryOne<{ nonce: string }>(
      'SELECT nonce FROM auth_nonces WHERE nonce = $1',
      [validNonce],
    );
    expect(validRow).toBeTruthy();
  });
});
