import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  generateRegistrationOptionsMock,
  generateAuthenticationOptionsMock,
  verifyRegistrationResponseMock,
  verifyAuthenticationResponseMock,
} = vi.hoisted(() => ({
  generateRegistrationOptionsMock: vi.fn(async () => ({
    challenge: 'register-challenge',
    user: { id: 'dXNlcg', name: 'Alice', displayName: 'Alice' },
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
import { hashPassword, signJwt } from '../src/security/crypto.js';

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

interface MemDb extends Database {
  failNextUsernameUpdateWithUniqueViolation(): void;
  failNextUsernameUpdateWithGenericError(): void;
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
}

function makeMemDb(): MemDb {
  const users = new Map<string, MemUser>();
  const passkeys = new Map<string, MemPasskey>();
  const challenges = new Map<string, MemChallenge>();
  const apiKeys = new Map<string, { user_id: string; key_hash: string; revoked_at: number | null }>();
  const refreshTokens = new Map<string, { user_id: string; token_hash: string }>();
  let failNextUsernameUpdateWithUniqueViolation = false;
  let failNextUsernameUpdateWithGenericError = false;

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
      if (s.includes('from api_keys where key_hash') && s.includes('revoked_at is null')) {
        for (const key of apiKeys.values()) {
          if (key.key_hash === params[0] && !key.revoked_at) return { user_id: key.user_id } as T;
        }
        return null;
      }
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
        if (s.includes('expires_at >') && s.includes('user_id')) {
          const row = challenges.get(String(params[0]));
          if (!row) return { changes: 0 };
          if (row.expires_at <= Number(params[1])) return { changes: 0 };
          if (row.user_id !== String(params[2])) return { changes: 0 };
          challenges.delete(String(params[0]));
          return { changes: 1 };
        }
        challenges.delete(String(params[0]));
      }
      if (s.includes('update passkey_credentials set counter')) {
        const cred = passkeys.get(String(params[2]));
        if (cred) {
          cred.counter = Number(params[0]);
          cred.last_used_at = Number(params[1]);
        }
      }
      if (s.includes('update users set username =') && s.includes('password_hash =')) {
        if (failNextUsernameUpdateWithUniqueViolation) {
          failNextUsernameUpdateWithUniqueViolation = false;
          const err = new Error('duplicate key value violates unique constraint');
          Object.assign(err, { code: '23505' });
          throw err;
        }
        if (failNextUsernameUpdateWithGenericError) {
          failNextUsernameUpdateWithGenericError = false;
          throw new Error('simulated write failure');
        }
        const user = users.get(String(params[2]));
        if (user) {
          user.username = String(params[0]);
          user.password_hash = String(params[1]);
          user.password_must_change = false;
        }
      }
      if (s.includes('update users set password_hash =') && s.includes('password_must_change = false')) {
        const user = users.get(String(params[1]));
        if (user) {
          user.password_hash = String(params[0]);
          user.password_must_change = false;
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
      if (s.includes('insert into refresh_tokens')) {
        refreshTokens.set(String(params[0]), { user_id: String(params[1]), token_hash: String(params[2]) });
      }
      if (s.includes('insert into audit_log') || s.includes('insert into auth_lockout') || s.includes('update auth_lockout')) {
        return { changes: 1 };
      }
      return { changes: 1 };
    },
    exec: async () => {},
    close: async () => {},
    transaction: async <T>(fn: (tx: Database) => Promise<T>) => {
      const snapshotUsers = new Map(Array.from(users.entries(), ([k, v]) => [k, { ...v }]));
      const snapshotPasskeys = new Map(Array.from(passkeys.entries(), ([k, v]) => [k, { ...v }]));
      const snapshotChallenges = new Map(Array.from(challenges.entries(), ([k, v]) => [k, { ...v }]));
      const snapshotApiKeys = new Map(Array.from(apiKeys.entries(), ([k, v]) => [k, { ...v }]));
      const snapshotRefreshTokens = new Map(Array.from(refreshTokens.entries(), ([k, v]) => [k, { ...v }]));
      try {
        return await fn(db as unknown as Database);
      } catch (err) {
        users.clear(); for (const [k, v] of snapshotUsers) users.set(k, v);
        passkeys.clear(); for (const [k, v] of snapshotPasskeys) passkeys.set(k, v);
        challenges.clear(); for (const [k, v] of snapshotChallenges) challenges.set(k, v);
        apiKeys.clear(); for (const [k, v] of snapshotApiKeys) apiKeys.set(k, v);
        refreshTokens.clear(); for (const [k, v] of snapshotRefreshTokens) refreshTokens.set(k, v);
        throw err;
      }
    },
    failNextUsernameUpdateWithUniqueViolation: () => { failNextUsernameUpdateWithUniqueViolation = true; },
    failNextUsernameUpdateWithGenericError: () => { failNextUsernameUpdateWithGenericError = true; },
  } as unknown as MemDb;
  return db;
}

async function seedPasskeyUser(db: Database, userId: string, credentialId: string, overrides: Partial<MemUser> = {}) {
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
  };
}

describe('passkey password setup', () => {
  let db: MemDb;
  let env: Env;
  let app: ReturnType<typeof buildApp>;
  let authHeader: Record<string, string>;

  beforeEach(async () => {
    vi.clearAllMocks();
    verifyRegistrationResponseMock.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credentialID: 'new-cred',
        credentialPublicKey: Uint8Array.from(Buffer.from('new-public-key')),
        counter: 0,
      },
    });
    db = makeMemDb();
    env = makeEnv(db);
    app = buildApp(env);
    await seedPasskeyUser(db, 'user-passkey', 'cred-user-passkey', { display_name: 'Alice' });
    await seedPasskeyUser(db, 'user-other', 'cred-user-other', { display_name: 'Bob', username: 'takenname' });
    const jwt = signJwt({ sub: 'user-passkey' }, env.JWT_SIGNING_KEY, 3600);
    authHeader = { Authorization: `Bearer ${jwt}` };
  });

  it('returns verify options scoped to the authed user passkeys', async () => {
    const res = await app.request('/api/auth/passkey/verify/begin', { method: 'POST', headers: authHeader, body: '{}' });
    expect(res.status).toBe(200);
    const body = await res.json() as { challengeId: string; allowCredentials: Array<{ id: string }> };
    expect(body.challengeId).toBeTruthy();
    expect(body.allowCredentials).toEqual([{ id: 'cred-user-passkey', type: 'public-key' }]);
    expect(generateAuthenticationOptionsMock).toHaveBeenCalledWith(expect.objectContaining({
      allowCredentials: [{ id: 'cred-user-passkey', type: 'public-key' }],
    }));
  });

  it('completes passkey login successfully and updates the counter', async () => {
    const beginRes = await app.request('/api/auth/passkey/login/begin', { method: 'POST', body: '{}' });
    const { challengeId } = await beginRes.json() as { challengeId: string };

    const loginRes = await app.request('/api/auth/passkey/login/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, response: { id: 'cred-user-passkey' } }),
    });

    expect(loginRes.status).toBe(200);
    expect(await loginRes.json()).toEqual({ ok: true });
    const cred = await db.queryOne<MemPasskey>('SELECT * FROM passkey_credentials WHERE id = $1', ['cred-user-passkey']);
    expect(cred?.counter).toBe(4);
  });

  it('allows active existing users to add another passkey', async () => {
    const beginRes = await app.request('/api/auth/passkey/register/begin', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Override Name' }),
    });
    expect(beginRes.status).toBe(200);
    const { challengeId } = await beginRes.json() as { challengeId: string };

    const completeRes = await app.request('/api/auth/passkey/register/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, response: { id: 'new-cred' }, deviceName: 'iPhone' }),
    });

    expect(completeRes.status).toBe(200);
    expect(await completeRes.json()).toEqual({ ok: true, userId: 'user-passkey' });
    const rows = await db.query<MemPasskey>('SELECT * FROM passkey_credentials WHERE user_id = $1', ['user-passkey']);
    expect(rows.map((row) => row.id).sort()).toEqual(['cred-user-passkey', 'new-cred']);
  });

  it('sets username and password after passkey verification, then allows password login', async () => {
    const beginRes = await app.request('/api/auth/passkey/verify/begin', { method: 'POST', headers: authHeader, body: '{}' });
    const { challengeId } = await beginRes.json() as { challengeId: string };

    const setupRes = await app.request('/api/auth/passkey/password/setup', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Alice.Set',
        newPassword: 'strong-password-123',
        challengeId,
        response: { id: 'cred-user-passkey' },
      }),
    });
    expect(setupRes.status).toBe(200);
    const setupBody = await setupRes.json() as { ok: boolean; user: { username: string; has_password: boolean } };
    expect(setupBody.ok).toBe(true);
    expect(setupBody.user.username).toBe('alice.set');
    expect(setupBody.user.has_password).toBe(true);

    const loginRes = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice.set', password: 'strong-password-123' }),
    });
    expect(loginRes.status).toBe(200);
  });

  it('rejects username collisions', async () => {
    const beginRes = await app.request('/api/auth/passkey/verify/begin', { method: 'POST', headers: authHeader, body: '{}' });
    const { challengeId } = await beginRes.json() as { challengeId: string };

    const setupRes = await app.request('/api/auth/passkey/password/setup', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'takenname',
        newPassword: 'strong-password-123',
        challengeId,
        response: { id: 'cred-user-passkey' },
      }),
    });

    expect(setupRes.status).toBe(409);
    expect(await setupRes.json()).toEqual({ error: 'username_taken' });
  });

  it('rejects invalid username format', async () => {
    const beginRes = await app.request('/api/auth/passkey/verify/begin', { method: 'POST', headers: authHeader, body: '{}' });
    const { challengeId } = await beginRes.json() as { challengeId: string };

    const setupRes = await app.request('/api/auth/passkey/password/setup', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'bad name',
        newPassword: 'strong-password-123',
        challengeId,
        response: { id: 'cred-user-passkey' },
      }),
    });

    expect(setupRes.status).toBe(400);
    expect(await setupRes.json()).toEqual({ error: 'invalid_username_format' });
  });

  it('rejects password setup after a password already exists', async () => {
    const user = await db.queryOne<MemUser>('SELECT * FROM users WHERE id = $1', ['user-passkey']);
    if (!user) throw new Error('missing user');
    user.password_hash = await hashPassword('existing-password');

    const beginRes = await app.request('/api/auth/passkey/verify/begin', { method: 'POST', headers: authHeader, body: '{}' });
    const { challengeId } = await beginRes.json() as { challengeId: string };

    const setupRes = await app.request('/api/auth/passkey/password/setup', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alice-new',
        newPassword: 'strong-password-123',
        challengeId,
        response: { id: 'cred-user-passkey' },
      }),
    });

    expect(setupRes.status).toBe(400);
    expect(await setupRes.json()).toEqual({ error: 'password_already_set' });
  });

  it('maps username unique constraint races to username_taken', async () => {
    const beginRes = await app.request('/api/auth/passkey/verify/begin', { method: 'POST', headers: authHeader, body: '{}' });
    const { challengeId } = await beginRes.json() as { challengeId: string };
    db.failNextUsernameUpdateWithUniqueViolation();

    const setupRes = await app.request('/api/auth/passkey/password/setup', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'race-user',
        newPassword: 'strong-password-123',
        challengeId,
        response: { id: 'cred-user-passkey' },
      }),
    });

    expect(setupRes.status).toBe(409);
    expect(await setupRes.json()).toEqual({ error: 'username_taken' });
  });

  it('rejects using another account passkey during setup', async () => {
    const beginRes = await app.request('/api/auth/passkey/verify/begin', { method: 'POST', headers: authHeader, body: '{}' });
    const { challengeId } = await beginRes.json() as { challengeId: string };

    const setupRes = await app.request('/api/auth/passkey/password/setup', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alice-new',
        newPassword: 'strong-password-123',
        challengeId,
        response: { id: 'cred-user-other' },
      }),
    });

    expect(setupRes.status).toBe(403);
    expect(await setupRes.json()).toEqual({ error: 'wrong_passkey' });
  });

  it('treats unknown setup credentials as wrong_passkey', async () => {
    const beginRes = await app.request('/api/auth/passkey/verify/begin', { method: 'POST', headers: authHeader, body: '{}' });
    const { challengeId } = await beginRes.json() as { challengeId: string };

    const setupRes = await app.request('/api/auth/passkey/password/setup', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alice-new',
        newPassword: 'strong-password-123',
        challengeId,
        response: { id: 'missing-cred' },
      }),
    });

    expect(setupRes.status).toBe(403);
    expect(await setupRes.json()).toEqual({ error: 'wrong_passkey' });
  });

  it('rejects expired setup challenges', async () => {
    const setupRes = await app.request('/api/auth/passkey/password/setup', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alice-new',
        newPassword: 'strong-password-123',
        challengeId: 'missing-challenge',
        response: { id: 'cred-user-passkey' },
      }),
    });

    expect(setupRes.status).toBe(400);
    expect(await setupRes.json()).toEqual({ error: 'challenge_expired' });
  });

  it('rejects setup challenges issued for a different user', async () => {
    await db.execute(
      'INSERT INTO passkey_challenges (id, challenge, user_id, display_name, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      ['foreign-challenge', 'verify-challenge', 'user-other', '', Date.now() + 60_000, Date.now()],
    );

    const setupRes = await app.request('/api/auth/passkey/password/setup', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alice-new',
        newPassword: 'strong-password-123',
        challengeId: 'foreign-challenge',
        response: { id: 'cred-user-passkey' },
      }),
    });

    expect(setupRes.status).toBe(403);
    expect(await setupRes.json()).toEqual({ error: 'challenge_user_mismatch' });
  });

  it('does not leak debug details on password setup verification failure', async () => {
    verifyAuthenticationResponseMock.mockRejectedValueOnce(new Error('origin mismatch'));
    const beginRes = await app.request('/api/auth/passkey/verify/begin', { method: 'POST', headers: authHeader, body: '{}' });
    const { challengeId } = await beginRes.json() as { challengeId: string };

    const setupRes = await app.request('/api/auth/passkey/password/setup', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alice-new',
        newPassword: 'strong-password-123',
        challengeId,
        response: { id: 'cred-user-passkey' },
      }),
    });

    expect(setupRes.status).toBe(400);
    expect(await setupRes.json()).toEqual({ error: 'verification_failed' });
  });

  it('rolls back password setup state when the final user update fails', async () => {
    const beginRes = await app.request('/api/auth/passkey/verify/begin', { method: 'POST', headers: authHeader, body: '{}' });
    const { challengeId } = await beginRes.json() as { challengeId: string };
    db.failNextUsernameUpdateWithGenericError();

    const setupRes = await app.request('/api/auth/passkey/password/setup', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alice-new',
        newPassword: 'strong-password-123',
        challengeId,
        response: { id: 'cred-user-passkey' },
      }),
    });

    expect(setupRes.status).toBe(500);
    const user = await db.queryOne<MemUser>('SELECT * FROM users WHERE id = $1', ['user-passkey']);
    const cred = await db.queryOne<MemPasskey>('SELECT * FROM passkey_credentials WHERE id = $1', ['cred-user-passkey']);
    const challenge = await db.queryOne<{ challenge: string }>('SELECT challenge FROM passkey_challenges WHERE id = $1 AND expires_at > $2', [challengeId, Date.now()]);
    expect(user?.username).toBeNull();
    expect(user?.password_hash).toBeNull();
    expect(cred?.counter).toBe(3);
    expect(challenge?.challenge).toBe('verify-challenge');
  });

  it('does not leak debug details on login verification failure', async () => {
    verifyAuthenticationResponseMock.mockRejectedValueOnce(new Error('origin mismatch'));
    const beginRes = await app.request('/api/auth/passkey/login/begin', { method: 'POST', body: '{}' });
    const { challengeId } = await beginRes.json() as { challengeId: string };

    const loginRes = await app.request('/api/auth/passkey/login/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, response: { id: 'cred-user-passkey' } }),
    });

    expect(loginRes.status).toBe(400);
    expect(await loginRes.json()).toEqual({ error: 'verification_failed' });
  });

  it('treats unknown login credentials as wrong_passkey', async () => {
    const beginRes = await app.request('/api/auth/passkey/login/begin', { method: 'POST', body: '{}' });
    const { challengeId } = await beginRes.json() as { challengeId: string };

    const loginRes = await app.request('/api/auth/passkey/login/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, response: { id: 'missing-cred' } }),
    });

    expect(loginRes.status).toBe(403);
    expect(await loginRes.json()).toEqual({ error: 'wrong_passkey' });
  });

  it('rejects verify begin for pending users', async () => {
    const user = await db.queryOne<MemUser>('SELECT * FROM users WHERE id = $1', ['user-passkey']);
    if (!user) throw new Error('missing user');
    user.status = 'pending';

    const res = await app.request('/api/auth/passkey/verify/begin', { method: 'POST', headers: authHeader, body: '{}' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_pending' });
  });

  it('rejects register begin for disabled existing users even if displayName is supplied', async () => {
    const user = await db.queryOne<MemUser>('SELECT * FROM users WHERE id = $1', ['user-passkey']);
    if (!user) throw new Error('missing user');
    user.status = 'disabled';

    const res = await app.request('/api/auth/passkey/register/begin', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Bypass Attempt' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_disabled' });
  });

  it('rejects register complete for pending existing users', async () => {
    const beginRes = await app.request('/api/auth/passkey/register/begin', {
      method: 'POST',
      headers: authHeader,
      body: '{}',
    });
    expect(beginRes.status).toBe(200);
    const { challengeId } = await beginRes.json() as { challengeId: string };
    const user = await db.queryOne<MemUser>('SELECT * FROM users WHERE id = $1', ['user-passkey']);
    if (!user) throw new Error('missing user');
    user.status = 'pending';

    const completeRes = await app.request('/api/auth/passkey/register/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, response: { id: 'new-cred' } }),
    });
    expect(completeRes.status).toBe(403);
    expect(await completeRes.json()).toEqual({ error: 'account_pending' });
  });

  it('rejects listing passkeys for disabled users', async () => {
    const user = await db.queryOne<MemUser>('SELECT * FROM users WHERE id = $1', ['user-passkey']);
    if (!user) throw new Error('missing user');
    user.status = 'disabled';

    const res = await app.request('/api/auth/passkey/credentials', { headers: authHeader });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_disabled' });
  });

  it('rejects deleting passkeys for pending users', async () => {
    const user = await db.queryOne<MemUser>('SELECT * FROM users WHERE id = $1', ['user-passkey']);
    if (!user) throw new Error('missing user');
    user.status = 'pending';

    const res = await app.request('/api/auth/passkey/credentials/cred-user-passkey', {
      method: 'DELETE',
      headers: authHeader,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_pending' });
  });

  it('does not leak debug details on registration verification failure', async () => {
    verifyRegistrationResponseMock.mockRejectedValueOnce(new Error('origin mismatch'));
    await db.execute(
      'INSERT INTO passkey_challenges (id, challenge, user_id, display_name, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      ['register-challenge', 'register-expected', null, 'Alice', Date.now() + 60_000, Date.now()],
    );

    const registerRes = await app.request('/api/auth/passkey/register/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: 'register-challenge', response: { id: 'new-cred' } }),
    });

    expect(registerRes.status).toBe(400);
    expect(await registerRes.json()).toEqual({ error: 'verification_failed' });
  });

  it('returns sanitized /me payload with username and has_password only', async () => {
    const passwordHash = await hashPassword('strong-password-123');
    const user = await db.queryOne<MemUser>('SELECT * FROM users WHERE id = $1', ['user-passkey']);
    if (!user) throw new Error('missing user');
    user.username = 'alice';
    user.password_hash = passwordHash;

    const meRes = await app.request('/api/auth/user/me', { headers: authHeader });
    expect(meRes.status).toBe(200);
    const me = await meRes.json() as Record<string, unknown>;
    expect(me.username).toBe('alice');
    expect(me.has_password).toBe(true);
    expect('password_hash' in me).toBe(false);
  });
});
