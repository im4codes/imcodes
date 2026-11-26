/**
 * Integration-style unit tests for email-verified registration, email binding,
 * email-verified password change, and forgot-password reset routes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../src/index.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { hashPassword } from '../src/security/crypto.js';
import { AUTH_ERROR_CODES } from '../../shared/auth-error-codes.js';
import { COOKIE_CSRF, HEADER_CSRF } from '../../shared/cookie-names.js';

interface MemUser {
  id: string;
  created_at: number;
  username: string | null;
  password_hash: string | null;
  display_name: string | null;
  email: string | null;
  email_verified_at: number | null;
  password_must_change: boolean | null;
  is_admin: boolean;
  status: 'active' | 'pending' | 'disabled';
  sessions_valid_after: number;
}

interface MemCode {
  id: string;
  email: string;
  user_id: string | null;
  purpose: string;
  code_hash: string;
  attempts: number;
  max_attempts: number;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
}

function makeEmailAuthMemDb() {
  let state = {
    users: new Map<string, MemUser>(),
    codes: new Map<string, MemCode>(),
    refreshTokens: new Map<string, { id: string; user_id: string; token_hash: string; family_id: string; used_at: number | null; expires_at: number; created_at: number }>(),
    apiKeys: new Map<string, { id: string; user_id: string; key_hash: string; label: string | null; created_at: number; revoked_at: number | null }>(),
    lockouts: new Map<string, { identity: string; failed_attempts: number; locked_until: number | null; last_attempt_at: number }>(),
    settings: new Map<string, string>([
      ['registration_enabled', 'true'],
      ['require_approval', 'false'],
    ]),
    auditLog: [] as unknown[],
  };

  let txChain: Promise<void> = Promise.resolve();

  function cloneState(src: typeof state): typeof state {
    return {
      users: new Map([...src.users.entries()].map(([k, v]) => [k, { ...v }])),
      codes: new Map([...src.codes.entries()].map(([k, v]) => [k, { ...v }])),
      refreshTokens: new Map([...src.refreshTokens.entries()].map(([k, v]) => [k, { ...v }])),
      apiKeys: new Map([...src.apiKeys.entries()].map(([k, v]) => [k, { ...v }])),
      lockouts: new Map([...src.lockouts.entries()].map(([k, v]) => [k, { ...v }])),
      settings: new Map(src.settings),
      auditLog: [...src.auditLog],
    };
  }

  function normalize(sql: string): string {
    return sql.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function createHandle(getS: () => typeof state): Database {
    return {
      queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
        const s = getS();
        const q = normalize(sql);
        if (q.includes('from users where id = $1')) {
          return (s.users.get(String(params[0])) ?? null) as T | null;
        }
        if (q.includes('from users where username = $1')) {
          for (const u of s.users.values()) {
            if (u.username === params[0]) return { ...u } as T;
          }
          return null;
        }
        if (q.includes('from users where lower(email) = $1 and email_verified_at is not null')) {
          const target = String(params[0]).toLowerCase();
          for (const u of s.users.values()) {
            if (u.email?.toLowerCase() === target && u.email_verified_at !== null) return { ...u } as T;
          }
          return null;
        }
        if (q.includes('from users where lower(email) = $1')) {
          const target = String(params[0]).toLowerCase();
          for (const u of s.users.values()) {
            if (u.email?.toLowerCase() === target) return { ...u } as T;
          }
          return null;
        }
        if (q.includes('from email_verification_codes where lower(email) = $1 and purpose = $2 and consumed_at is null')) {
          const target = String(params[0]).toLowerCase();
          const purpose = String(params[1]);
          const matches = [...s.codes.values()]
            .filter((c) => c.email.toLowerCase() === target && c.purpose === purpose && c.consumed_at === null)
            .sort((a, b) => b.created_at - a.created_at);
          return (matches[0] ? { ...matches[0] } : null) as T | null;
        }
        if (q.includes('from email_verification_codes where lower(email) = $1 and purpose = $2')) {
          const target = String(params[0]).toLowerCase();
          const purpose = String(params[1]);
          const matches = [...s.codes.values()]
            .filter((c) => c.email.toLowerCase() === target && c.purpose === purpose)
            .sort((a, b) => b.created_at - a.created_at);
          return (matches[0] ? { ...matches[0] } : null) as T | null;
        }
        if (q.includes('from api_keys') && q.includes('where key_hash = $1') && q.includes('revoked_at is null')) {
          for (const k of s.apiKeys.values()) {
            if (k.key_hash === params[0] && k.revoked_at === null) {
              const owner = s.users.get(k.user_id);
              return { id: k.id, user_id: k.user_id, user_status: owner?.status ?? 'active' } as T;
            }
          }
          return null;
        }
        if (q.includes('update refresh_tokens set used_at = $1 where token_hash = $2') && q.includes('returning')) {
          const now = Number(params[0]);
          for (const rt of s.refreshTokens.values()) {
            if (rt.token_hash === params[1] && rt.used_at === null && rt.expires_at > now) {
              rt.used_at = now;
              return { ...rt } as T;
            }
          }
          return null;
        }
        if (q.includes('from refresh_tokens where token_hash')) {
          const now = Number(params[1]);
          for (const rt of s.refreshTokens.values()) {
            if (rt.token_hash === params[0] && rt.used_at === null && rt.expires_at > now) return { ...rt } as T;
          }
          return null;
        }
        if (q.includes('from auth_lockout where identity = $1')) {
          const row = s.lockouts.get(String(params[0]));
          if (!row) return null;
          if (q.includes('locked_until > now()')) {
            if (row.locked_until === null || row.locked_until <= Date.now()) return null;
            return { locked_until: row.locked_until } as T;
          }
          return row as T;
        }
        if (q.includes('insert into auth_lockout')) {
          const identity = String(params[0]);
          const prev = s.lockouts.get(identity);
          const failed_attempts = (prev?.failed_attempts ?? 0) + 1;
          const locked_until = failed_attempts >= 5 ? Date.now() + 15 * 60_000 : null;
          s.lockouts.set(identity, { identity, failed_attempts, locked_until, last_attempt_at: Date.now() });
          return { fail_count: failed_attempts, locked_until } as T;
        }
        if (q.includes('from settings where key = $1')) {
          const val = s.settings.get(String(params[0]));
          return (val !== undefined ? { value: val } : null) as T | null;
        }
        if (q.includes('count(*) as cnt from users')) {
          return { cnt: s.users.size } as T;
        }
        return null;
      },
      query: async <T = unknown>(): Promise<T[]> => [],
      execute: async (sql: string, params: unknown[] = []) => {
        const s = getS();
        const q = normalize(sql);
        if (q.startsWith('insert into users (id, created_at)')) {
          s.users.set(String(params[0]), {
            id: String(params[0]),
            created_at: Number(params[1]),
            username: null,
            password_hash: null,
            display_name: null,
            email: null,
            email_verified_at: null,
            password_must_change: null,
            is_admin: false,
            status: 'active',
            sessions_valid_after: 0,
          });
          return { changes: 1 };
        }
        if (q.startsWith('update users set username = $1, password_hash = $2, display_name = $3, email = $4, email_verified_at = $5 where id = $6')) {
          const u = s.users.get(String(params[5]));
          if (!u) return { changes: 0 };
          u.username = String(params[0]);
          u.password_hash = String(params[1]);
          u.display_name = String(params[2]);
          u.email = String(params[3]);
          u.email_verified_at = Number(params[4]);
          return { changes: 1 };
        }
        if (q.startsWith('update users set username = $1, password_hash = $2, display_name = $3 where id = $4')) {
          const u = s.users.get(String(params[3]));
          if (!u) return { changes: 0 };
          u.username = String(params[0]);
          u.password_hash = String(params[1]);
          u.display_name = String(params[2]);
          return { changes: 1 };
        }
        if (q.startsWith('update users set email = $1, email_verified_at = $2 where id = $3')) {
          const u = s.users.get(String(params[2]));
          if (!u) return { changes: 0 };
          u.email = String(params[0]);
          u.email_verified_at = Number(params[1]);
          return { changes: 1 };
        }
        if (q.startsWith('update users set password_hash = $1, password_must_change = false, sessions_valid_after = greatest(sessions_valid_after, $3) where id = $2')) {
          const u = s.users.get(String(params[1]));
          if (!u) return { changes: 0 };
          u.password_hash = String(params[0]);
          u.password_must_change = false;
          u.sessions_valid_after = Math.max(u.sessions_valid_after, Number(params[2]));
          return { changes: 1 };
        }
        if (q.startsWith('update users set status = $1 where id = $2')) {
          const u = s.users.get(String(params[1]));
          if (!u) return { changes: 0 };
          u.status = params[0] as MemUser['status'];
          return { changes: 1 };
        }
        if (q.startsWith('update email_verification_codes set consumed_at = $1 where lower(email) = $2 and purpose = $3 and consumed_at is null')) {
          let changes = 0;
          for (const c of s.codes.values()) {
            if (c.email.toLowerCase() === String(params[1]).toLowerCase() && c.purpose === params[2] && c.consumed_at === null) {
              c.consumed_at = Number(params[0]);
              changes += 1;
            }
          }
          return { changes };
        }
        if (q.startsWith('insert into email_verification_codes')) {
          const hasUserIdParam = !q.includes('values ($1, $2, null,');
          const id = String(params[0]);
          const email = String(params[1]);
          const user_id = hasUserIdParam ? (params[2] ? String(params[2]) : null) : null;
          const offset = hasUserIdParam ? 3 : 2;
          const purpose = String(params[offset]);
          const code_hash = String(params[offset + 1]);
          const max_attempts = Number(params[offset + 2]);
          const expires_at = Number(params[offset + 3]);
          const consumed_at = hasUserIdParam ? null : Number(params[offset + 4]);
          const created_at = hasUserIdParam ? Number(params[offset + 4]) : Number(params[offset + 5]);
          s.codes.set(id, {
            id,
            email,
            user_id,
            purpose,
            code_hash,
            attempts: 0,
            max_attempts,
            expires_at,
            consumed_at,
            created_at,
          });
          return { changes: 1 };
        }
        if (q.startsWith('delete from email_verification_codes where id = $1')) {
          return { changes: s.codes.delete(String(params[0])) ? 1 : 0 };
        }
        if (q.startsWith('update email_verification_codes set attempts = $1, consumed_at = $2 where id = $3')) {
          const c = s.codes.get(String(params[2]));
          if (!c) return { changes: 0 };
          c.attempts = Number(params[0]);
          c.consumed_at = Number(params[1]);
          return { changes: 1 };
        }
        if (q.startsWith('update email_verification_codes set attempts = $1 where id = $2')) {
          const c = s.codes.get(String(params[1]));
          if (!c) return { changes: 0 };
          c.attempts = Number(params[0]);
          return { changes: 1 };
        }
        if (q.startsWith('update email_verification_codes set consumed_at = $1 where id = $2 and consumed_at is null')) {
          const c = s.codes.get(String(params[1]));
          if (!c || c.consumed_at !== null) return { changes: 0 };
          c.consumed_at = Number(params[0]);
          return { changes: 1 };
        }
        if (q.startsWith('update email_verification_codes set consumed_at = $1 where id = $2')) {
          const c = s.codes.get(String(params[1]));
          if (!c) return { changes: 0 };
          c.consumed_at = Number(params[0]);
          return { changes: 1 };
        }
        if (q.startsWith('insert into refresh_tokens')) {
          const id = String(params[0]);
          s.refreshTokens.set(id, {
            id,
            user_id: String(params[1]),
            token_hash: String(params[2]),
            family_id: String(params[3]),
            used_at: null,
            expires_at: Number(params[4]),
            created_at: Number(params[5]),
          });
          return { changes: 1 };
        }
        if (q.startsWith('update refresh_tokens set used_at = $1 where user_id = $2 and used_at is null')) {
          let changes = 0;
          for (const rt of s.refreshTokens.values()) {
            if (rt.user_id === params[1] && rt.used_at === null) {
              rt.used_at = Number(params[0]);
              changes += 1;
            }
          }
          return { changes };
        }
        if (q.startsWith('insert into api_keys')) {
          s.apiKeys.set(String(params[0]), {
            id: String(params[0]),
            user_id: String(params[1]),
            key_hash: String(params[2]),
            label: params[3] ? String(params[3]) : null,
            created_at: Number(params[4]),
            revoked_at: null,
          });
          return { changes: 1 };
        }
        if (q.startsWith('insert into audit_log')) {
          s.auditLog.push(params);
          return { changes: 1 };
        }
        if (q.startsWith('delete from auth_lockout where identity = $1')) {
          return { changes: s.lockouts.delete(String(params[0])) ? 1 : 0 };
        }
        return { changes: 0 };
      },
      transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => {
        const run = txChain.then(async () => {
          const working = cloneState(state);
          const result = await fn(createHandle(() => working));
          state = working;
          return result;
        });
        txChain = run.then(() => undefined, () => undefined);
        return run;
      },
      close: async () => {},
    };
  }

  return {
    db: createHandle(() => state),
    getState: () => state,
  };
}

function makeEnv(db: Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    DATABASE_URL: 'postgres://localhost/test',
    JWT_SIGNING_KEY: 'test-jwt-signing-key-must-be-long-enough-1234',
    BOT_ENCRYPTION_KEY: 'test-bot-encryption-key',
    SERVER_URL: 'https://app.im.codes',
    ALLOWED_ORIGINS: 'https://app.im.codes',
    EMAIL_AUTH_ENABLED: 'true',
    AWS_SES_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SES_SECRET_ACCESS_KEY: 'aws-secret-key-test',
    AWS_SES_REGION: 'us-east-1',
    AWS_SES_FROM: 'noreply@im.codes',
    NODE_ENV: 'production',
    ...overrides,
  };
}

describe('email auth routes', () => {
  let mem: ReturnType<typeof makeEmailAuthMemDb>;
  let sentEmails: Array<{ to: string[]; subject: string; text: string; otp: string | null }>;

  beforeEach(() => {
    mem = makeEmailAuthMemDb();
    sentEmails = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? JSON.parse(init.body) as {
        Destination?: { ToAddresses?: string[] };
        Content?: { Simple?: { Subject?: { Data?: string }; Body?: { Text?: { Data?: string } } } };
      } : {};
      const text = raw.Content?.Simple?.Body?.Text?.Data ?? '';
      const subject = raw.Content?.Simple?.Subject?.Data ?? '';
      const match = text.match(/\b(\d{6})\b/);
      sentEmails.push({
        to: raw.Destination?.ToAddresses ?? [],
        subject,
        text,
        otp: match?.[1] ?? null,
      });
      return new Response(JSON.stringify({ MessageId: `ses-${sentEmails.length}` }), { status: 200 });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps legacy flows intact and disables email endpoints when EMAIL_AUTH_ENABLED is off or email provider unconfigured', async () => {
    for (const env of [
      makeEnv(mem.db, { EMAIL_AUTH_ENABLED: undefined }),
      makeEnv(mem.db, { EMAIL_AUTH_ENABLED: 'true', AWS_SES_ACCESS_KEY_ID: undefined, AWS_SES_SECRET_ACCESS_KEY: undefined, AWS_SES_FROM: undefined }),
    ]) {
      const app = buildApp(env);
      const cfgRes = await app.request('/api/auth/email/config', { method: 'GET' }, env);
      expect(cfgRes.status).toBe(200);
      expect(await cfgRes.json()).toEqual({ emailAuthEnabled: false });

      const sendRes = await app.request('/api/auth/email/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@example.com', purpose: 'register' }),
      }, env);
      expect(sendRes.status).toBe(403);
      expect((await sendRes.json()).error).toBe(AUTH_ERROR_CODES.EMAIL_AUTH_DISABLED);

      const resetRes = await app.request('/api/auth/password/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@example.com', code: '123456', newPassword: 'NewPassword1!' }),
      }, env);
      expect(resetRes.status).toBe(403);
    }

    // Legacy registration without email succeeds when toggle is off.
    const offEnv = makeEnv(mem.db, { EMAIL_AUTH_ENABLED: 'false' });
    const offApp = buildApp(offEnv);
    const regRes = await offApp.request('/api/auth/password/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'legacyuser', password: 'Password1!', native: true }),
    }, offEnv);
    expect(regRes.status).toBe(200);
    expect((await regRes.json()).ok).toBe(true);
  });

  it('registers with hashed single-use OTP, enforces cooldown & attempt limit, supports email login, and rejects concurrent OTP replay', async () => {
    const env = makeEnv(mem.db);
    const app = buildApp(env);

    const cfgRes = await app.request('/api/auth/email/config', { method: 'GET' }, env);
    expect(await cfgRes.json()).toEqual({ emailAuthEnabled: true });

    // Registration without email/code fails cleanly.
    const missingEmailRes = await app.request('/api/auth/password/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice01', password: 'Password1!' }),
    }, env);
    expect(missingEmailRes.status).toBe(400);
    expect((await missingEmailRes.json()).error).toBe(AUTH_ERROR_CODES.EMAIL_REQUIRED);

    // Send OTP
    const send1 = await app.request('/api/auth/email/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': 'zh-CN' },
      body: JSON.stringify({ email: 'Alice@Example.COM ', purpose: 'register' }),
    }, env);
    expect(send1.status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    const otp = sentEmails[0].otp!;
    expect(otp).toMatch(/^\d{6}$/);
    expect(sentEmails[0].subject).toContain('注册账户');

    // Never store plaintext OTP in DB
    const storedCode = [...mem.getState().codes.values()][0];
    expect(storedCode.code_hash).not.toContain(otp);
    expect(storedCode.code_hash).toMatch(/^[a-f0-9]{64}$/);

    // 60s resend cooldown enforced
    const sendTooFast = await app.request('/api/auth/email/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', purpose: 'register' }),
    }, env);
    expect(sendTooFast.status).toBe(429);
    expect((await sendTooFast.json()).error).toBe(AUTH_ERROR_CODES.EMAIL_CODE_RATE_LIMITED);

    // 5 wrong OTP guesses lock the code permanently
    for (let i = 0; i < 5; i += 1) {
      const badCode = otp === '000000' ? '111111' : '000000';
      const badTry = await app.request('/api/auth/password/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'alice01',
          password: 'Password1!',
          email: 'alice@example.com',
          emailCode: badCode,
        }),
      }, env);
      expect(badTry.status).toBe(400);
      expect((await badTry.json()).error).toBe(AUTH_ERROR_CODES.EMAIL_CODE_INVALID);
    }
    // Even the real OTP is now dead after 5 failures
    const lockedOutTry = await app.request('/api/auth/password/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alice01',
        password: 'Password1!',
        email: 'alice@example.com',
        emailCode: otp,
      }),
    }, env);
    expect(lockedOutTry.status).toBe(400);
    expect((await lockedOutTry.json()).error).toBe(AUTH_ERROR_CODES.EMAIL_CODE_INVALID);

    // Age previous code >60s so a new OTP can be issued, and verify concurrency: only 1 of 2 registrations wins the OTP!
    for (const c of mem.getState().codes.values()) {
      c.created_at -= 61_000;
    }
    const send2 = await app.request('/api/auth/email/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', purpose: 'register' }),
    }, env);
    expect(send2.status).toBe(200);
    const otp2 = sentEmails[1].otp!;

    const [r1, r2] = await Promise.all([
      app.request('/api/auth/password/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'alice01',
          password: 'Password1!',
          email: 'Alice@Example.com',
          emailCode: otp2,
          native: true,
        }),
      }, env),
      app.request('/api/auth/password/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'alice02',
          password: 'Password1!',
          email: 'alice@example.com',
          emailCode: otp2,
          native: true,
        }),
      }, env),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winnerBody = r1.status === 200 ? await r1.json() : await r2.json();
    const apiKey = winnerBody.apiKey as string;

    // Duplicate email send-code fails case-insensitively
    const dupSend = await app.request('/api/auth/email/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ALICE@EXAMPLE.COM', purpose: 'register' }),
    }, env);
    expect(dupSend.status).toBe(409);
    expect((await dupSend.json()).error).toBe(AUTH_ERROR_CODES.EMAIL_TAKEN);

    // /user/me returns email & email_verified
    const meRes = await app.request('/api/auth/user/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    }, env);
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toMatchObject({
      email: 'alice@example.com',
      email_verified: true,
    });

    // Can login with verified email (case-insensitive)
    const loginRes = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ALICE@example.com', password: 'Password1!' }),
    }, env);
    expect(loginRes.status).toBe(200);
    expect((await loginRes.json()).ok).toBe(true);
  });

  it('supports anti-enumeration forgot-password reset, revokes tokens, and handles pre-email account bind + email-verified password change', async () => {
    const env = makeEnv(mem.db);
    const app = buildApp(env);

    // Seed pre-email existing account (`email: null`)
    const now = Date.now();
    const oldHash = await hashPassword('OldPass1!');
    mem.getState().users.set('u-legacy', {
      id: 'u-legacy',
      created_at: now,
      username: 'legacy',
      password_hash: oldHash,
      display_name: 'Legacy',
      email: null,
      email_verified_at: null,
      password_must_change: false,
      is_admin: false,
      status: 'active',
      sessions_valid_after: 0,
    });

    // Anti-enumeration on unknown email: returns identical 200 ok + identical 429 cooldown, sends zero emails.
    const unknownResetSend = await app.request('/api/auth/email/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', purpose: 'password_reset' }),
    }, env);
    expect(unknownResetSend.status).toBe(200);
    expect(await unknownResetSend.json()).toEqual({ ok: true });
    expect(sentEmails).toHaveLength(0);

    const unknownResetFast = await app.request('/api/auth/email/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', purpose: 'password_reset' }),
    }, env);
    expect(unknownResetFast.status).toBe(429);

    // Pre-email account can login and change password without emailCode even when EMAIL_AUTH_ENABLED=true
    const loginRes = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'legacy', password: 'OldPass1!', native: true }),
    }, env);
    expect(loginRes.status).toBe(200);
    const loginData = await loginRes.json() as { accessToken: string; refreshToken: string; apiKey: string };
    expect(loginData.refreshToken).toBeTruthy();

    // Bind email with cookie + CSRF enforcement check
    const bindSendCookieNoCsrf = await app.request('/api/auth/email/send-code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `rcc_session=${loginData.accessToken}; ${COOKIE_CSRF}=csrf-1`,
      },
      body: JSON.stringify({ email: 'legacy@example.com', purpose: 'bind_email' }),
    }, env);
    expect(bindSendCookieNoCsrf.status).toBe(403);

    const bindSend = await app.request('/api/auth/email/send-code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `rcc_session=${loginData.accessToken}; ${COOKIE_CSRF}=csrf-1`,
        [HEADER_CSRF]: 'csrf-1',
      },
      body: JSON.stringify({ email: 'Legacy@Example.com', purpose: 'bind_email' }),
    }, env);
    expect(bindSend.status).toBe(200);
    const bindOtp = sentEmails[0].otp!;

    const bindRes = await app.request('/api/auth/email/bind', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginData.apiKey}`,
      },
      body: JSON.stringify({ email: 'legacy@example.com', code: bindOtp }),
    }, env);
    expect(bindRes.status).toBe(200);
    expect(await bindRes.json()).toEqual({ ok: true, email: 'legacy@example.com', email_verified: true });

    // Now that email is verified, /password/change requires emailCode
    const pwChangeMissingCode = await app.request('/api/auth/password/change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.apiKey}` },
      body: JSON.stringify({ oldPassword: 'OldPass1!', newPassword: 'NewPass2!' }),
    }, env);
    expect(pwChangeMissingCode.status).toBe(400);
    expect((await pwChangeMissingCode.json()).error).toBe(AUTH_ERROR_CODES.EMAIL_CODE_REQUIRED);

    const pwSend = await app.request('/api/auth/email/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.apiKey}` },
      body: JSON.stringify({ purpose: 'password_change' }),
    }, env);
    expect(pwSend.status).toBe(200);
    const pwOtp = sentEmails[1].otp!;

    const pwChangeOk = await app.request('/api/auth/password/change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.apiKey}` },
      body: JSON.stringify({ oldPassword: 'OldPass1!', newPassword: 'NewPass2!', emailCode: pwOtp }),
    }, env);
    expect(pwChangeOk.status).toBe(200);

    // Forgot-password reset on legacy@example.com revokes active refresh tokens and sets new password
    const resetSend = await app.request('/api/auth/email/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'legacy@example.com', purpose: 'password_reset' }),
    }, env);
    expect(resetSend.status).toBe(200);
    const resetOtp = sentEmails[2].otp!;

    // Expired OTP is rejected with EMAIL_CODE_EXPIRED
    const liveResetRow = [...mem.getState().codes.values()].find((c) => c.purpose === 'password_reset' && c.consumed_at === null)!;
    const savedExpiry = liveResetRow.expires_at;
    liveResetRow.expires_at = Date.now() - 1000;
    const expiredTry = await app.request('/api/auth/password/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'legacy@example.com', code: resetOtp, newPassword: 'ResetPass3!' }),
    }, env);
    expect(expiredTry.status).toBe(400);
    expect((await expiredTry.json()).error).toBe(AUTH_ERROR_CODES.EMAIL_CODE_EXPIRED);

    // Issue fresh reset code (bypass cooldown in test state) and complete reset
    for (const c of mem.getState().codes.values()) {
      if (c.purpose === 'password_reset') {
        c.expires_at = savedExpiry;
        c.created_at -= 61_000;
      }
    }
    const resetSend2 = await app.request('/api/auth/email/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'legacy@example.com', purpose: 'password_reset' }),
    }, env);
    expect(resetSend2.status).toBe(200);
    const resetOtp2 = sentEmails[3].otp!;

    const resetOk = await app.request('/api/auth/password/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'legacy@example.com', code: resetOtp2, newPassword: 'ResetPass3!' }),
    }, env);
    expect(resetOk.status).toBe(200);
    expect(mem.getState().users.get('u-legacy')!.sessions_valid_after).toBeGreaterThan(0);
    for (const rt of mem.getState().refreshTokens.values()) {
      expect(rt.used_at).not.toBeNull();
    }

    const oldPwLogin = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'legacy@example.com', password: 'NewPass2!' }),
    }, env);
    expect(oldPwLogin.status).toBe(401);

    const newPwLogin = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'legacy@example.com', password: 'ResetPass3!' }),
    }, env);
    expect(newPwLogin.status).toBe(200);
  });

  it('includes valid idempotent PostgreSQL DDL in migration 115_user_email_auth.sql', () => {
    const sql = readFileSync(
      join(process.cwd(), 'src', 'db', 'migrations', '115_user_email_auth.sql'),
      'utf8',
    );
    expect(sql).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT');
    expect(sql).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at BIGINT');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS email_verification_codes');
  });
});
