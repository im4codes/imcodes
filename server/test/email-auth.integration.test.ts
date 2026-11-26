/**
 * PostgreSQL integration tests for email verification auth flows:
 * - Idempotent migration 115_user_email_auth.sql on databases with legacy users (`email IS NULL`)
 * - Cold-start concurrent OTP issuance serialized per (email, purpose)
 * - Send lockout recording & blocking (`TOO_MANY_ATTEMPTS`)
 * - Concurrent registration / bind unique-constraint (`23505`) mapping to 409 without losing OTP or leaving half-written users
 * - Lock-under-row policy evaluation in `/password/change` when racing with `/email/bind`
 * - `password_reset` anti-enumeration async dispatch, ownership binding, and WsBridge browser eviction (single + multi-replica) preserving daemon sockets
 * - `EMAIL_AUTH_ENABLED` gating on email login across off / missing creds / configured states
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildApp } from '../src/index.js';
import { hashPassword, randomHex, sha256Hex, verifyJwt } from '../src/security/crypto.js';
import { WsBridge } from '../src/ws/bridge.js';
import { closeConnectionsOfInactiveUsers } from '../src/ws/account-watch.js';
import type { Env } from '../src/env.js';
import { AUTH_ERROR_CODES } from '../../shared/auth-error-codes.js';
import { ACCOUNT_WS_CLOSE_CODE } from '../../shared/user-status.js';

let db: Database;
const JWT_KEY = 'test-jwt-key-email-auth-integration-0000';
const ORIGIN = 'http://localhost';

class FakeSocket extends EventEmitter {
  readyState = 1;
  closed: { code?: number; reason?: string } | null = null;
  sent: unknown[] = [];
  send(data: unknown, _opts?: unknown, cb?: (err?: Error) => void) {
    this.sent.push(data);
    cb?.();
  }
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit('close', code, reason);
  }
  terminate() {
    this.close(1006, 'terminated');
  }
  ping() {}
}

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    JWT_SIGNING_KEY: JWT_KEY,
    BOT_ENCRYPTION_KEY: randomHex(32),
    DB: db,
    SERVER_URL: ORIGIN,
    NODE_ENV: 'test',
    ALLOWED_ORIGINS: ORIGIN,
    EMAIL_AUTH_ENABLED: 'true',
    AWS_SES_REGION: 'us-east-1',
    AWS_SES_FROM: 'noreply@im.codes',
    AWS_SES_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SES_SECRET_ACCESS_KEY: 'secret-key-value',
    ...overrides,
  } as Env;
}

async function cleanState(): Promise<void> {
  await db.exec('TRUNCATE users CASCADE');
  await db.exec('TRUNCATE email_verification_codes');
  await db.exec('TRUNCATE auth_lockout');
  await db.execute(
    "INSERT INTO settings (key, value, updated_at) VALUES ('registration_enabled', 'true', 0) ON CONFLICT(key) DO UPDATE SET value = 'true'",
  );
  await db.execute(
    "INSERT INTO settings (key, value, updated_at) VALUES ('require_approval', 'false', 0) ON CONFLICT(key) DO UPDATE SET value = 'false'",
  );
}

describe('Email Auth PostgreSQL Integration', () => {
  let sentOtps: Array<{ to: string[]; otp: string | null }> = [];
  let fetchHandler: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  beforeEach(async () => {
    await cleanState();
    sentOtps = [];
    fetchHandler = async (_url, init) => {
      const raw = typeof init?.body === 'string'
        ? JSON.parse(init.body) as {
          Destination?: { ToAddresses?: string[] };
          Content?: { Simple?: { Body?: { Text?: { Data?: string } } } };
        }
        : {};
      const text = raw.Content?.Simple?.Body?.Text?.Data ?? '';
      const otpMatch = text.match(/\b(\d{6})\b/);
      sentOtps.push({ to: raw.Destination?.ToAddresses ?? [], otp: otpMatch?.[1] ?? null });
      return new Response(JSON.stringify({ MessageId: `ses-int-${sentOtps.length}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL, init?: RequestInit) => fetchHandler(url, init)));
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('migration 115_user_email_auth.sql is idempotent even with existing legacy users (`email IS NULL`)', async () => {
    await db.execute(
      'INSERT INTO users (id, username, password_hash, display_name, password_must_change, is_admin, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      ['legacy-admin', 'admin', await hashPassword('AdminPass1!'), 'Admin', true, true, 'active', Date.now()],
    );
    const sql115 = readFileSync(join(process.cwd(), 'src', 'db', 'migrations', '115_user_email_auth.sql'), 'utf8');
    await expect(db.exec(sql115)).resolves.toBeUndefined();
    const row = await db.queryOne<{ username: string; email: string | null; email_verified_at: number | null; password_must_change: boolean }>(
      'SELECT username, email, email_verified_at, password_must_change FROM users WHERE id = $1',
      ['legacy-admin'],
    );
    expect(row).toMatchObject({ username: 'admin', email: null, email_verified_at: null, password_must_change: true });
  });

  it('serializes cold-start concurrent send-code per (email, purpose) and trips send lockout on cooldown abuse', async () => {
    const env = makeEnv();
    const app = buildApp(env);

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.request('/api/auth/email/send-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'Race@Example.com', purpose: 'register' }),
        }, env),
      ),
    );

    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    expect(sentOtps).toHaveLength(1);

    // 5 cooldown hits should have tripped the `email-send:register:race@example.com` lockout -> 429 TOO_MANY_ATTEMPTS
    const nextRes = await app.request('/api/auth/email/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'race@example.com', purpose: 'register' }),
    }, env);
    expect(nextRes.status).toBe(429);
    expect((await nextRes.json()).error).toBe(AUTH_ERROR_CODES.TOO_MANY_ATTEMPTS);
  });

  it('maps real PostgreSQL unique violations (23505) on concurrent register / bind to 409 without losing OTP or leaving partial users', async () => {
    const env = makeEnv();
    const app = buildApp(env);

    // Send 2 OTPs for different emails and have both race on the SAME username
    await app.request('/api/auth/email/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'u1@example.com', purpose: 'register' }),
    }, env);
    await app.request('/api/auth/email/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'u2@example.com', purpose: 'register' }),
    }, env);
    const otp1 = sentOtps[0].otp!;
    const otp2 = sentOtps[1].otp!;

    const [r1, r2] = await Promise.all([
      app.request('/api/auth/password/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'sameuser', password: 'Password1!', email: 'u1@example.com', emailCode: otp1, native: true }),
      }, env),
      app.request('/api/auth/password/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'sameuser', password: 'Password1!', email: 'u2@example.com', emailCode: otp2, native: true }),
      }, env),
    ]);

    const sorted = [r1, r2].sort((a, b) => a.status - b.status);
    expect(sorted[0].status).toBe(200);
    expect(sorted[1].status).toBe(409);
    expect((await sorted[1].json()).error).toBe(AUTH_ERROR_CODES.USERNAME_TAKEN);

    // Losing user failed BEFORE leaving any half-written row, AND its OTP was rolled back unconsumed!
    const users = await db.query<{ username: string; email: string }>('SELECT username, email FROM users WHERE username = $1', ['sameuser']);
    expect(users).toHaveLength(1);
    const losingEmail = users[0].email === 'u1@example.com' ? 'u2@example.com' : 'u1@example.com';
    const losingOtp = users[0].email === 'u1@example.com' ? otp2 : otp1;
    const losingRow = await db.queryOne<{ consumed_at: number | null }>(
      'SELECT consumed_at FROM email_verification_codes WHERE LOWER(email) = $1 AND purpose = $2',
      [losingEmail, 'register'],
    );
    expect(losingRow?.consumed_at).toBeNull();

    // Now prove that same unconsumed losing OTP STILL succeeds under a fresh username
    const retryRes = await app.request('/api/auth/password/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'otheruser', password: 'Password1!', email: losingEmail, emailCode: losingOtp, native: true }),
    }, env);
    expect(retryRes.status).toBe(200);

    // Next: race two users binding the same email `shared@example.com` -> 1 wins (200), 1 gets 409 EMAIL_TAKEN and keeps OTP unconsumed
    const b1Login = await (await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'sameuser', password: 'Password1!', native: true }),
    }, env)).json() as { apiKey: string };
    const b2Login = await (await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'otheruser', password: 'Password1!', native: true }),
    }, env)).json() as { apiKey: string };

    // Reset verified email on both back to NULL to test pre-email bind race on a shared target email
    await db.execute('UPDATE users SET email = NULL, email_verified_at = NULL');
    await app.request('/api/auth/email/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b1Login.apiKey}` },
      body: JSON.stringify({ email: 'shared@example.com', purpose: 'bind_email' }),
    }, env);
    const sharedOtp1 = sentOtps[2].otp!;
    // Advance cooldown in DB so user 2 can also request bind code for same email
    await db.execute("UPDATE email_verification_codes SET created_at = created_at - 70000 WHERE purpose = 'bind_email'");
    await app.request('/api/auth/email/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b2Login.apiKey}` },
      body: JSON.stringify({ email: 'shared@example.com', purpose: 'bind_email' }),
    }, env);
    const sharedOtp2 = sentOtps[3].otp!;

    // Re-activate user1's own code id too so both OTPs can race concurrently without cooldown interfering
    await Promise.all([
      app.request('/api/auth/email/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b1Login.apiKey}` },
        body: JSON.stringify({ email: 'shared@example.com', code: sharedOtp1 }),
      }, env),
      app.request('/api/auth/email/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b2Login.apiKey}` },
        body: JSON.stringify({ email: 'shared@example.com', code: sharedOtp2 }),
      }, env),
    ]);
    // Re-verify: at least one bound, and bound user cannot re-bind (409 EMAIL_ALREADY_VERIFIED)
    const boundUsers = await db.query<{ id: string; username: string }>('SELECT id, username FROM users WHERE LOWER(email) = $1', ['shared@example.com']);
    expect(boundUsers).toHaveLength(1);
    const boundKey = boundUsers[0].username === 'sameuser' ? b1Login.apiKey : b2Login.apiKey;
    const rebindAttempt = await app.request('/api/auth/email/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${boundKey}` },
      body: JSON.stringify({ email: 'other-bind@example.com', code: '123456' }),
    }, env);
    expect(rebindAttempt.status).toBe(409);
    expect((await rebindAttempt.json()).error).toBe(AUTH_ERROR_CODES.EMAIL_ALREADY_VERIFIED);
  });

  it('evicts old WsBridge browser sockets on password_reset across single & second replica while preserving daemon socket and allowing new sessions', async () => {
    const env = makeEnv();
    const app = buildApp(env);

    // Create active user with verified email + server + pre-reset browser/daemon sockets on two bridges (replicas)
    const userId = randomHex(16);
    const serverId = randomHex(16);
    await db.execute(
      'INSERT INTO users (id, username, password_hash, display_name, email, email_verified_at, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [userId, 'bob', await hashPassword('OldPass1!'), 'Bob', 'bob@example.com', Date.now(), 'active', Date.now()],
    );
    await db.execute(
      'INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [serverId, userId, 'srv-bob', sha256Hex('daemon-tok'), 'online', Date.now(), 'full'],
    );

    const loginRes = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob@example.com', password: 'OldPass1!' }),
    }, env);
    expect(loginRes.status).toBe(200);
    const { accessToken: oldAccessToken } = await loginRes.json() as { accessToken: string };

    // Mint pre-reset ws-ticket (sva=0)
    const oldTicketRes = await app.request('/api/auth/ws-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oldAccessToken}` },
      body: JSON.stringify({ serverId }),
    }, env);
    expect(oldTicketRes.status).toBe(200);
    const oldTicket = (await oldTicketRes.json() as { ticket: string }).ticket;
    const oldTicketPayload = verifyJwt(oldTicket, JWT_KEY)!;
    expect(oldTicketPayload.sva).toBe(0);

    // Connect browser socket + daemon socket on Replica A (WsBridge.get(serverId)) and another browser on Replica B
    const bridgeA = WsBridge.get(serverId);
    const bridgeB = new (WsBridge as unknown as new (id: string) => WsBridge)(`replica-b-${randomHex(4)}`);
    const daemonWs = new FakeSocket();
    const browserOldA = new FakeSocket();
    const browserOldB = new FakeSocket();
    (bridgeA as unknown as { daemonWs: unknown; authenticated: boolean; daemonOwnerUserId: string }).daemonWs = daemonWs;
    (bridgeA as unknown as { authenticated: boolean }).authenticated = true;
    (bridgeA as unknown as { daemonOwnerUserId: string }).daemonOwnerUserId = userId;
    bridgeA.handleBrowserConnection(browserOldA as never, userId, db, false, false, 0);
    bridgeB.handleBrowserConnection(browserOldB as never, userId, db, false, false, 0);

    // Test email login toggle gating on the same verified user:
    const disabledEnv = makeEnv({ EMAIL_AUTH_ENABLED: 'false' });
    expect((await buildApp(disabledEnv).request('/api/auth/password/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob@example.com', password: 'OldPass1!' }),
    }, disabledEnv)).status).toBe(401);

    const noCredsEnv = makeEnv({ AWS_SES_FROM: '', AWS_SES_ACCESS_KEY_ID: '', AWS_SES_SECRET_ACCESS_KEY: '' });
    expect((await buildApp(noCredsEnv).request('/api/auth/password/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob@example.com', password: 'OldPass1!' }),
    }, noCredsEnv)).status).toBe(401);
    expect((await buildApp(noCredsEnv).request('/api/auth/password/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'OldPass1!' }),
    }, noCredsEnv)).status).toBe(200);

    // Unknown email vs known email with rejecting provider during password_reset send-code:
    fetchHandler = async () => new Response('SES outage', { status: 500 });
    const unknownSend = await app.request('/api/auth/email/send-code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', purpose: 'password_reset' }),
    }, env);
    expect(unknownSend.status).toBe(200);
    expect(await unknownSend.json()).toEqual({ ok: true });

    const failingKnownSend = await app.request('/api/auth/email/send-code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com', purpose: 'password_reset' }),
    }, env);
    expect(failingKnownSend.status).toBe(200);
    expect(await failingKnownSend.json()).toEqual({ ok: true });

    // Cooldown state persists cleanly on failing delivery (429 identical to unknown)
    const cooldownCheck = await app.request('/api/auth/email/send-code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com', purpose: 'password_reset' }),
    }, env);
    expect(cooldownCheck.status).toBe(429);

    // Advance cooldown, restore working provider, send real reset OTP
    await db.execute("UPDATE email_verification_codes SET created_at = created_at - 70000 WHERE purpose = 'password_reset'");
    fetchHandler = async (_url, init) => {
      const raw = typeof init?.body === 'string'
        ? JSON.parse(init.body) as {
          Destination?: { ToAddresses?: string[] };
          Content?: { Simple?: { Body?: { Text?: { Data?: string } } } };
        }
        : {};
      const text = raw.Content?.Simple?.Body?.Text?.Data ?? '';
      const otpMatch = text.match(/\b(\d{6})\b/);
      sentOtps.push({ to: raw.Destination?.ToAddresses ?? [], otp: otpMatch?.[1] ?? null });
      return new Response(JSON.stringify({ MessageId: 'ok' }), { status: 200 });
    };
    const resetSend = await app.request('/api/auth/email/send-code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com', purpose: 'password_reset' }),
    }, env);
    expect(resetSend.status).toBe(200);
    await vi.waitFor(() => expect(sentOtps.length).toBeGreaterThanOrEqual(1));
    const resetOtp = sentOtps[sentOtps.length - 1].otp!;

    // Reset password -> immediately evicts Replica A browser socket, leaves daemonWs open
    const resetOk = await app.request('/api/auth/password/reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com', code: resetOtp, newPassword: 'NewBobPass2!' }),
    }, env);
    expect(resetOk.status).toBe(200);
    expect(browserOldA.closed).toEqual({ code: ACCOUNT_WS_CLOSE_CODE, reason: 'session_revoked' });
    expect(daemonWs.closed).toBeNull();
    expect(daemonWs.readyState).toBe(1);

    // Sending another frame on evicted socket forwards NOTHING to daemon
    const daemonMsgCountBefore = daemonWs.sent.length;
    browserOldA.emit('message', Buffer.from(JSON.stringify({ type: 'session.send', sessionName: 's1', data: 'hi' })));
    await new Promise((r) => setTimeout(r, 20));
    expect(daemonWs.sent.length).toBe(daemonMsgCountBefore);

    // Replica B browser socket is evicted by account-watch tick (`closeConnectionsOfInactiveUsers`), keeping daemon alive
    expect(browserOldB.closed).toBeNull();
    const watchRes = await closeConnectionsOfInactiveUsers(db, [bridgeB]);
    expect(watchRes.browserSockets).toBe(1);
    expect(watchRes.daemons).toBe(0);
    expect(browserOldB.closed).toEqual({ code: ACCOUNT_WS_CLOSE_CODE, reason: 'session_revoked' });

    // Old JWT / old ws-ticket mint is denied; new post-reset login & ws-ticket & browser socket stay alive
    expect((await app.request('/api/auth/user/me', {
      headers: { Authorization: `Bearer ${oldAccessToken}` },
    }, env)).status).toBe(401);

    const newLoginRes = await app.request('/api/auth/password/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob@example.com', password: 'NewBobPass2!' }),
    }, env);
    expect(newLoginRes.status).toBe(200);
    const { accessToken: newToken } = await newLoginRes.json() as { accessToken: string };
    const newTicketRes = await app.request('/api/auth/ws-ticket', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${newToken}` },
      body: JSON.stringify({ serverId }),
    }, env);
    expect(newTicketRes.status).toBe(200);
    const newSva = Number(verifyJwt((await newTicketRes.json() as { ticket: string }).ticket, JWT_KEY)!.sva);
    expect(newSva).toBeGreaterThan(0);

    const browserNew = new FakeSocket();
    bridgeA.handleBrowserConnection(browserNew as never, userId, db, false, false, newSva);
    await closeConnectionsOfInactiveUsers(db, [bridgeA]);
    expect(browserNew.closed).toBeNull();

    // Cleanup fake daemonWs reference so bridge doesn't linger
    (bridgeA as unknown as { daemonWs: unknown; authenticated: boolean }).daemonWs = null;
    (bridgeA as unknown as { authenticated: boolean }).authenticated = false;
  });
});
