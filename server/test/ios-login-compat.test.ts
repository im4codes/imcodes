/**
 * iOS native login backward-compatibility tests.
 *
 * Protects the response shape of auth endpoints used by iOS clients.
 * Old iOS builds rely on `apiKey`; new iOS builds use `nonce` for token-exchange.
 * Both MUST be present to avoid breaking either version in the field.
 *
 * Uses in-memory mock DB (same pattern as passkey-password-setup.test.ts)
 * because passkey endpoints require mocked @simplewebauthn/server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock @simplewebauthn/server before any import that touches it ─────────

const {
  generateRegistrationOptionsMock,
  generateAuthenticationOptionsMock,
  verifyRegistrationResponseMock,
  verifyAuthenticationResponseMock,
} = vi.hoisted(() => ({
  generateRegistrationOptionsMock: vi.fn(async () => ({
    challenge: 'register-challenge',
    user: { id: 'dXNlcg', name: 'User', displayName: 'User' },
  })),
  generateAuthenticationOptionsMock: vi.fn(async (opts: Record<string, unknown>) => ({
    challenge: 'verify-challenge',
    rpId: opts.rpID,
    allowCredentials: opts.allowCredentials ?? [],
  })),
  verifyRegistrationResponseMock: vi.fn(),
  verifyAuthenticationResponseMock: vi.fn(async ({ authenticator }: Record<string, any>) => ({
    verified: true,
    authenticationInfo: { newCounter: Number(authenticator.counter ?? 0) + 1 },
  })),
}));

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: generateRegistrationOptionsMock,
  verifyRegistrationResponse: verifyRegistrationResponseMock,
  generateAuthenticationOptions: generateAuthenticationOptionsMock,
  verifyAuthenticationResponse: verifyAuthenticationResponseMock,
}));

import { buildApp } from '../src/index.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { hashPassword } from '../src/security/crypto.js';

// ── In-memory DB ─────────────────────────────────────────────────────────

interface MemUser {
  id: string;
  created_at: number;
  username: string | null;
  password_hash: string | null;
  display_name: string | null;
  password_must_change: boolean | null;
  is_admin: boolean;
  status: 'active' | 'pending' | 'disabled';
}

interface MemPasskey {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_name: string | null;
  created_at: number;
  last_used_at: number | null;
}

interface MemChallenge {
  id: string;
  challenge: string;
  user_id: string | null;
  display_name: string;
  expires_at: number;
  created_at: number;
}

interface MemApiKey {
  id: string;
  user_id: string;
  key_hash: string;
  label: string | null;
  revoked_at: number | null;
  created_at: number;
}

interface MemAuthNonce {
  nonce: string;
  api_key: string;
  user_id: string;
  key_id: string;
  expires_at: number;
  created_at: number;
}

function makeMemDb() {
  const users = new Map<string, MemUser>();
  const passkeys = new Map<string, MemPasskey>();
  const challenges = new Map<string, MemChallenge>();
  const apiKeys = new Map<string, MemApiKey>();
  const authNonces = new Map<string, MemAuthNonce>();
  const refreshTokens = new Map<string, { user_id: string; token_hash: string }>();

  function normalize(sql: string): string {
    return sql.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  const db = {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const s = normalize(sql);
      if (s.includes('from users where id')) return (users.get(String(params[0])) ?? null) as T | null;
      if (s.includes('from users where username')) {
        for (const user of users.values()) {
          if (user.username === params[0]) return user as T;
        }
        return null;
      }
      if (s.includes('from passkey_challenges where id')) {
        const row = challenges.get(String(params[0]));
        if (!row) return null;
        if (row.expires_at <= Number(params[1])) return null;
        return { challenge: row.challenge, user_id: row.user_id, display_name: row.display_name } as T;
      }
      if (s.includes('from passkey_credentials where id')) {
        return (passkeys.get(String(params[0])) ?? null) as T | null;
      }
      if (s.includes('delete from auth_nonces where nonce =') && s.includes('expires_at >') && s.includes('returning')) {
        const row = authNonces.get(String(params[0]));
        if (!row || row.expires_at <= Number(params[1])) return null;
        authNonces.delete(String(params[0]));
        return { api_key: row.api_key, user_id: row.user_id, key_id: row.key_id } as T;
      }
      if (s.includes('from auth_nonces where nonce =') && s.includes('expires_at >')) {
        const row = authNonces.get(String(params[0]));
        if (!row || row.expires_at <= Number(params[1])) return null;
        return { api_key: row.api_key, user_id: row.user_id, key_id: row.key_id } as T;
      }
      if (s.includes('from auth_nonces where nonce =')) {
        return (authNonces.get(String(params[0])) ?? null) as T | null;
      }
      if (s.includes('from api_keys where key_hash') && s.includes('revoked_at is null')) {
        for (const key of apiKeys.values()) {
          if (key.key_hash === params[0] && !key.revoked_at) return { user_id: key.user_id } as T;
        }
        return null;
      }
      if (s.includes('from settings where key')) return null;
      if (s.includes('from auth_lockout')) return null;
      return null;
    },
    query: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const s = normalize(sql);
      if (s.includes('from passkey_credentials where user_id')) {
        return Array.from(passkeys.values()).filter((cred) => cred.user_id === params[0]) as T[];
      }
      return [] as T[];
    },
    execute: async (sql: string, params: unknown[] = []): Promise<{ changes: number }> => {
      const s = normalize(sql);
      if (s.includes('insert into users')) {
        users.set(String(params[0]), {
          id: String(params[0]),
          created_at: Number(params[1]),
          username: null,
          password_hash: null,
          display_name: null,
          password_must_change: null,
          is_admin: false,
          status: 'active',
        });
      }
      if (s.includes('insert into passkey_credentials')) {
        passkeys.set(String(params[0]), {
          id: String(params[0]),
          user_id: String(params[1]),
          public_key: String(params[2]),
          counter: Number(params[3]),
          device_name: (params[4] as string | null) ?? null,
          transports: (params[5] as string | null) ?? null,
          created_at: Number(params[6]),
          last_used_at: null,
        });
      }
      if (s.includes('insert into passkey_challenges')) {
        challenges.set(String(params[0]), {
          id: String(params[0]),
          challenge: String(params[1]),
          user_id: (params[2] as string | null) ?? null,
          display_name: String(params[3]),
          expires_at: Number(params[4]),
          created_at: Number(params[5]),
        });
      }
      if (s.includes('delete from passkey_challenges where expires_at <')) {
        const cutoff = Number(params[0]);
        for (const [id, row] of challenges.entries()) {
          if (row.expires_at < cutoff) challenges.delete(id);
        }
      }
      if (s.includes('delete from passkey_challenges where id')) {
        challenges.delete(String(params[0]));
      }
      if (s.includes('update passkey_credentials set counter')) {
        const cred = passkeys.get(String(params[2]));
        if (cred) {
          cred.counter = Number(params[0]);
          cred.last_used_at = Number(params[1]);
        }
      }
      if (s.includes('insert into api_keys')) {
        apiKeys.set(String(params[0]), {
          id: String(params[0]),
          user_id: String(params[1]),
          key_hash: String(params[2]),
          label: (params[3] as string | null) ?? null,
          revoked_at: null,
          created_at: Number(params[4]),
        });
      }
      if (s.includes('insert into refresh_tokens')) {
        refreshTokens.set(String(params[0]), { user_id: String(params[1]), token_hash: String(params[2]) });
      }
      if (s.includes('insert into auth_nonces')) {
        authNonces.set(String(params[0]), {
          nonce: String(params[0]),
          api_key: String(params[1]),
          user_id: String(params[2]),
          key_id: String(params[3]),
          expires_at: Number(params[4]),
          created_at: Number(params[5]),
        });
      }
      if (s.includes('delete from auth_nonces where expires_at <')) {
        const cutoff = Number(params[0]);
        for (const [nonce, row] of authNonces.entries()) {
          if (row.expires_at < cutoff) authNonces.delete(nonce);
        }
      }
      if (s.includes('update users set display_name =')) {
        const user = users.get(String(params[1]));
        if (user) user.display_name = String(params[0]);
      }
      if (s.includes('update users set status =')) {
        const user = users.get(String(params[1]));
        if (user) user.status = String(params[0]) as MemUser['status'];
      }
      if (s.includes('insert into audit_log') || s.includes('insert into auth_lockout') || s.includes('update auth_lockout')) {
        return { changes: 1 };
      }
      return { changes: 1 };
    },
    exec: async () => {},
    close: async () => {},
    transaction: async <T>(fn: (tx: Database) => Promise<T>) => {
      return fn(db as unknown as Database);
    },
  } as unknown as Database;

  return {
    db,
    users,
    passkeys,
    apiKeys,
    authNonces,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

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
    DATABASE_URL: '',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    WEBAUTHN_RP_ID: 'localhost',
  } as Env;
}

async function seedPasskeyUser(
  db: Database,
  userId: string,
  credentialId: string,
  overrides: Partial<MemUser> = {},
): Promise<void> {
  const now = Date.now();
  await db.execute('INSERT INTO users (id, created_at) VALUES ($1, $2)', [userId, now]);
  const user = await db.queryOne<MemUser>('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) throw new Error('failed to seed user');
  Object.assign(user, overrides);
  await db.execute(
    'INSERT INTO passkey_credentials (id, user_id, public_key, counter, device_name, transports, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [credentialId, userId, Buffer.from('public-key').toString('base64'), 3, 'MacBook', JSON.stringify(['internal']), now],
  );
}

async function seedPasswordUser(
  db: Database,
  userId: string,
  username: string,
  password: string,
): Promise<void> {
  const now = Date.now();
  await db.execute('INSERT INTO users (id, created_at) VALUES ($1, $2)', [userId, now]);
  const user = await db.queryOne<MemUser>('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) throw new Error('failed to seed user');
  user.username = username;
  user.password_hash = await hashPassword(password);
  user.display_name = 'Password User';
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('iOS native login backward compatibility', () => {
  let mem: ReturnType<typeof makeMemDb>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    vi.clearAllMocks();
    verifyRegistrationResponseMock.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credentialID: 'new-cred-ios',
        credentialPublicKey: Uint8Array.from(Buffer.from('new-public-key')),
        counter: 0,
      },
    });
    mem = makeMemDb();
    app = buildApp(makeEnv(mem.db));
    await seedPasskeyUser(mem.db, 'user-ios', 'cred-ios', { display_name: 'iOS Tester' });
    await seedPasswordUser(mem.db, 'user-pw', 'alice', 'Strong-Pass-123');
  });

  // ── 1. POST /api/auth/passkey/login/complete?native=1 (JSON path) ─────

  describe('POST /api/auth/passkey/login/complete?native=1 (JSON path)', () => {
    it('response includes apiKey, nonce, keyId, and userId', async () => {
      // Begin challenge
      const beginRes = await app.request('/api/auth/passkey/login/begin', {
        method: 'POST',
        body: '{}',
      });
      expect(beginRes.status).toBe(200);
      const { challengeId } = await beginRes.json() as { challengeId: string };

      // Complete with native=1 query param (no native_callback)
      const completeRes = await app.request(
        '/api/auth/passkey/login/complete?native=1',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challengeId, response: { id: 'cred-ios' } }),
        },
      );

      expect(completeRes.status).toBe(200);
      const body = await completeRes.json() as Record<string, unknown>;

      // Old iOS relies on apiKey; new iOS relies on nonce — both MUST be present
      expect(body).toHaveProperty('apiKey');
      expect(body).toHaveProperty('nonce');
      expect(body).toHaveProperty('keyId');
      expect(body).toHaveProperty('userId');
      expect(body.ok).toBe(true);

      // Verify types are non-empty strings
      expect(typeof body.apiKey).toBe('string');
      expect(typeof body.nonce).toBe('string');
      expect(typeof body.keyId).toBe('string');
      expect(typeof body.userId).toBe('string');
      expect((body.apiKey as string).length).toBeGreaterThan(0);
      expect((body.nonce as string).length).toBeGreaterThan(0);
      expect((body.keyId as string).length).toBeGreaterThan(0);
      expect(body.userId).toBe('user-ios');

      // apiKey should follow the deck_ prefix convention
      expect((body.apiKey as string).startsWith('deck_')).toBe(true);
    });

    it('nonce from native=1 login is exchangeable via token-exchange', async () => {
      const beginRes = await app.request('/api/auth/passkey/login/begin', {
        method: 'POST',
        body: '{}',
      });
      const { challengeId } = await beginRes.json() as { challengeId: string };

      const completeRes = await app.request(
        '/api/auth/passkey/login/complete?native=1',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challengeId, response: { id: 'cred-ios' } }),
        },
      );
      const loginBody = await completeRes.json() as { nonce: string; apiKey: string; userId: string; keyId: string };

      // Exchange the nonce — should return the same apiKey, userId, keyId
      const exchangeRes = await app.request('/api/auth/token-exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: loginBody.nonce }),
      });
      expect(exchangeRes.status).toBe(200);
      const exchangeBody = await exchangeRes.json() as Record<string, unknown>;
      expect(exchangeBody.apiKey).toBe(loginBody.apiKey);
      expect(exchangeBody.userId).toBe(loginBody.userId);
      expect(exchangeBody.keyId).toBe(loginBody.keyId);
    });
  });

  // ── 2. POST /api/auth/passkey/login/complete with native_callback ─────

  describe('POST /api/auth/passkey/login/complete with native_callback (redirect path)', () => {
    it('returns HTML redirect page with nonce AND legacy params in URL', async () => {
      const beginRes = await app.request('/api/auth/passkey/login/begin', {
        method: 'POST',
        body: '{}',
      });
      const { challengeId } = await beginRes.json() as { challengeId: string };

      const callbackUrl = 'imcodes://auth';
      const completeRes = await app.request(
        `/api/auth/passkey/login/complete?native=1&native_callback=${encodeURIComponent(callbackUrl)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challengeId, response: { id: 'cred-ios' } }),
        },
      );

      expect(completeRes.status).toBe(200);
      const html = await completeRes.text();

      // Should be an HTML page (not JSON)
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html>');

      // Extract the redirect URL from meta refresh or script
      const urlMatch = html.match(/content="0;url=([^"]+)"/);
      expect(urlMatch).toBeTruthy();
      const redirectUrl = new URL(urlMatch![1]);

      // Must include nonce (new iOS path)
      expect(redirectUrl.searchParams.has('nonce')).toBe(true);
      expect(redirectUrl.searchParams.get('nonce')!.length).toBeGreaterThan(0);

      // Must include legacy params (old iOS path)
      expect(redirectUrl.searchParams.has('key')).toBe(true);
      expect(redirectUrl.searchParams.get('key')!.startsWith('deck_')).toBe(true);
      expect(redirectUrl.searchParams.has('userId')).toBe(true);
      expect(redirectUrl.searchParams.get('userId')).toBe('user-ios');
      expect(redirectUrl.searchParams.has('keyId')).toBe(true);
      expect(redirectUrl.searchParams.get('keyId')!.length).toBeGreaterThan(0);

      // Protocol should match the callback
      expect(redirectUrl.protocol).toBe('imcodes:');
    });
  });

  // ── 3. POST /api/auth/passkey/register/complete with native_callback ──

  describe('POST /api/auth/passkey/register/complete with native_callback (register + redirect)', () => {
    it('returns HTML redirect page with nonce AND legacy params in URL', async () => {
      // Begin registration (no auth header = new user)
      const beginRes = await app.request('/api/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'New iOS User' }),
      });
      expect(beginRes.status).toBe(200);
      const { challengeId } = await beginRes.json() as { challengeId: string };

      const callbackUrl = 'imcodes://auth';
      const completeRes = await app.request(
        `/api/auth/passkey/register/complete?native_callback=${encodeURIComponent(callbackUrl)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challengeId, response: { id: 'new-cred-ios' }, deviceName: 'iPhone' }),
        },
      );

      expect(completeRes.status).toBe(200);
      const html = await completeRes.text();

      // Should be an HTML page
      expect(html).toContain('<!DOCTYPE html>');

      // Extract the redirect URL
      const urlMatch = html.match(/content="0;url=([^"]+)"/);
      expect(urlMatch).toBeTruthy();
      const redirectUrl = new URL(urlMatch![1]);

      // Must include nonce (new iOS path)
      expect(redirectUrl.searchParams.has('nonce')).toBe(true);
      expect(redirectUrl.searchParams.get('nonce')!.length).toBeGreaterThan(0);

      // Must include legacy params (old iOS path)
      expect(redirectUrl.searchParams.has('key')).toBe(true);
      expect(redirectUrl.searchParams.get('key')!.startsWith('deck_')).toBe(true);
      expect(redirectUrl.searchParams.has('userId')).toBe(true);
      expect(redirectUrl.searchParams.get('userId')!.length).toBeGreaterThan(0);
      expect(redirectUrl.searchParams.has('keyId')).toBe(true);
      expect(redirectUrl.searchParams.get('keyId')!.length).toBeGreaterThan(0);

      // Protocol should match the callback
      expect(redirectUrl.protocol).toBe('imcodes:');
    });

    it('redirect nonce is exchangeable via token-exchange', async () => {
      const beginRes = await app.request('/api/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Nonce Test User' }),
      });
      const { challengeId } = await beginRes.json() as { challengeId: string };

      const callbackUrl = 'imcodes://auth';
      const completeRes = await app.request(
        `/api/auth/passkey/register/complete?native_callback=${encodeURIComponent(callbackUrl)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challengeId, response: { id: 'new-cred-ios' }, deviceName: 'iPhone' }),
        },
      );

      const html = await completeRes.text();
      const urlMatch = html.match(/content="0;url=([^"]+)"/);
      const redirectUrl = new URL(urlMatch![1]);
      const nonce = redirectUrl.searchParams.get('nonce')!;
      const key = redirectUrl.searchParams.get('key')!;

      // Exchange the nonce
      const exchangeRes = await app.request('/api/auth/token-exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce }),
      });
      expect(exchangeRes.status).toBe(200);
      const exchangeBody = await exchangeRes.json() as Record<string, unknown>;
      expect(exchangeBody.apiKey).toBe(key);
      expect(exchangeBody).toHaveProperty('userId');
      expect(exchangeBody).toHaveProperty('keyId');
    });
  });

  // ── 4. POST /api/auth/password/login with native=true ─────────────────

  describe('POST /api/auth/password/login with native=true', () => {
    it('response includes apiKey, keyId, and userId', async () => {
      const loginRes = await app.request('/api/auth/password/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'Strong-Pass-123', native: true }),
      });

      expect(loginRes.status).toBe(200);
      const body = await loginRes.json() as Record<string, unknown>;

      // Native iOS requires these fields
      expect(body).toHaveProperty('apiKey');
      expect(body).toHaveProperty('keyId');
      expect(body).toHaveProperty('userId');
      expect(body.ok).toBe(true);

      expect(typeof body.apiKey).toBe('string');
      expect(typeof body.keyId).toBe('string');
      expect(typeof body.userId).toBe('string');
      expect((body.apiKey as string).startsWith('deck_')).toBe(true);
      expect(body.userId).toBe('user-pw');
    });

    it('does NOT include apiKey/keyId/userId when native is false', async () => {
      const loginRes = await app.request('/api/auth/password/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'Strong-Pass-123' }),
      });

      expect(loginRes.status).toBe(200);
      const body = await loginRes.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      // Non-native login should NOT leak API keys
      expect(body.apiKey).toBeUndefined();
      expect(body.keyId).toBeUndefined();
      expect(body.userId).toBeUndefined();
    });
  });

  // ── 5. POST /api/auth/token-exchange — CSRF exemption ─────────────────

  describe('POST /api/auth/token-exchange', () => {
    it('valid nonce returns apiKey, userId, and keyId', async () => {
      // Seed a nonce directly into the in-memory store
      const nonce = 'test-nonce-for-exchange';
      const apiKey = 'deck_test_key_1234';
      const keyId = 'key-id-1234';
      await mem.db.execute(
        'INSERT INTO auth_nonces (nonce, api_key, user_id, key_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [nonce, apiKey, 'user-ios', keyId, Date.now() + 60_000, Date.now()],
      );

      const res = await app.request('/api/auth/token-exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.apiKey).toBe(apiKey);
      expect(body.userId).toBe('user-ios');
      expect(body.keyId).toBe(keyId);
    });

    it('is not blocked by CSRF (no cookie/csrf header required)', async () => {
      const nonce = 'csrf-test-nonce';
      const apiKey = 'deck_csrf_test_key';
      const keyId = 'csrf-key-id';
      await mem.db.execute(
        'INSERT INTO auth_nonces (nonce, api_key, user_id, key_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [nonce, apiKey, 'user-ios', keyId, Date.now() + 60_000, Date.now()],
      );

      // Request with no cookies, no CSRF header — should still succeed
      const res = await app.request('/api/auth/token-exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce }),
      });

      // If CSRF blocked this, we'd get a 403. We expect 200 because it's exempted.
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.apiKey).toBe(apiKey);
    });

    it('rejects an invalid nonce with 400', async () => {
      const res = await app.request('/api/auth/token-exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: 'nonexistent-nonce' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('invalid_or_expired_nonce');
    });
  });
});
