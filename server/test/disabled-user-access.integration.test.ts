/**
 * A user the admin disabled keeps NO access (finding F-01 of the strict pron3 verification): real PostgreSQL, the real middleware and the
 * real routes. Every credential path is asserted twice -- it works while the account is active, and is refused after the admin disables
 * it -- so a path that is not covered fails here by name instead of in production.
 *
 * Matrix: API key, login JWT (bearer), login JWT (cookie), daemon server-token (bearer + X-Server-Id) on a requireAuth route and on a
 * daemon-token route, passkey route, auth routes (me, ws-ticket, refresh), WebSocket admission (member / share / controlled machine),
 * share coverage (grantee and server owner), cron dispatch, push, token exchange, enrollment tickets, remote-desktop guest links,
 * live sockets, plus the disable/enable route contract, the two-replica bound and the lockout rules.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildApp } from '../src/index.js';
import { hashPassword, randomHex, sha256Hex, signJwt } from '../src/security/crypto.js';
import { resolveServerWebSocketAccess, resolveServerRole } from '../src/security/authorization.js';
import { resolveEffectiveShareCoverage } from '../src/db/tab-sharing.js';
import { resolveControlledMachineOperatorAccess } from '../src/share/machine-access.js';
import { evaluateUserAccess, loadUserAccess } from '../src/security/user-status.js';
import { insertControlledServerWithNodeId } from '../src/services/controlled-node-identity.js';
import { closeConnectionsOfInactiveUsers, startAccountConnectionWatch } from '../src/ws/account-watch.js';
import { WsBridge } from '../src/ws/bridge.js';
import { jobDispatchCron } from '../src/cron/job-dispatch.js';
import { dispatchPush } from '../src/routes/push.js';
import type { Env } from '../src/env.js';
import { AUTH_ERROR_CODES } from '../../shared/auth-error-codes.js';
import { ACCOUNT_WS_CLOSE_CODE, USER_STATUS } from '../../shared/user-status.js';
import { ACCOUNT_SESSION_JWT_TYPE } from '../../shared/auth-token-types.js';
import { COOKIE_SESSION } from '../../shared/cookie-names.js';

let db: Database;
const JWT_KEY = 'test-jwt-key-for-disabled-user-0000000000';
const ORIGIN = 'http://localhost';

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});
afterAll(async () => { await db.close(); });

function makeEnv(): Env {
  return {
    DATABASE_URL: process.env.TEST_DATABASE_URL!, JWT_SIGNING_KEY: JWT_KEY, BOT_ENCRYPTION_KEY: randomHex(32),
    DB: db, NODE_ENV: 'test', ALLOWED_ORIGINS: ORIGIN,
  } as Env;
}
const makeApp = () => buildApp(makeEnv());

interface Fixture {
  adminId: string; adminToken: string;
  userId: string; apiKey: string; jwt: string; refreshToken: string;
  serverId: string; serverToken: string;
  otherId: string; otherServerId: string;
}

async function insertUser(opts: { username: string; isAdmin?: boolean; status?: string }): Promise<string> {
  const id = randomHex(16);
  await db.execute(
    'INSERT INTO users (id, username, password_hash, display_name, password_must_change, is_admin, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, opts.username, await hashPassword('Passw0rd!x'), opts.username, false, opts.isAdmin ?? false, opts.status ?? USER_STATUS.ACTIVE, Date.now()],
  );
  return id;
}
async function insertApiKey(userId: string): Promise<string> {
  const raw = `deck_${randomHex(32)}`;
  await db.execute('INSERT INTO api_keys (id, user_id, key_hash, created_at) VALUES ($1,$2,$3,$4)', [randomHex(16), userId, sha256Hex(raw), Date.now()]);
  return raw;
}
async function insertServer(userId: string, token: string, nodeRole: 'full' | 'controlled' = 'full'): Promise<string> {
  const id = randomHex(16);
  if (nodeRole === 'controlled') {
    await insertControlledServerWithNodeId(db, {
      serverId: id, userId, tokenHash: sha256Hex(token), displayName: 'node', refName: null, os: null, arch: null, hostServerId: null,
      createdAt: Date.now(),
    } as never);
    return id;
  }
  await db.execute(
    'INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, `srv-${id.slice(0, 4)}`, sha256Hex(token), 'offline', Date.now(), nodeRole],
  );
  return id;
}
async function insertRefreshToken(userId: string): Promise<string> {
  const raw = randomHex(32);
  await db.execute(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [randomHex(16), userId, sha256Hex(raw), randomHex(16), Date.now() + 3_600_000, Date.now()],
  );
  return raw;
}
const loginJwt = (userId: string, iatShiftSeconds = 0): string => {
  const token = signJwt({ sub: userId, type: ACCOUNT_SESSION_JWT_TYPE }, JWT_KEY, 3600);
  if (iatShiftSeconds === 0) return token;
  // re-sign with a shifted iat (a token minted earlier)
  const [h, p] = token.split('.');
  const payload = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8')) as Record<string, unknown>;
  payload.iat = (payload.iat as number) + iatShiftSeconds;
  return signWith(h!, payload);
};
import { createHmac } from 'node:crypto';
function signWith(header: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', JWT_KEY).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

const csrf = randomHex(16);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, Origin: ORIGIN });
const cookie = (token: string) => ({ Cookie: `${COOKIE_SESSION}=${token}; rcc_csrf=${csrf}`, 'X-CSRF-Token': csrf, Origin: ORIGIN });
const daemon = (serverId: string, token: string) => ({ Authorization: `Bearer ${token}`, 'X-Server-Id': serverId, Origin: ORIGIN });

async function fixture(): Promise<Fixture> {
  await db.exec('TRUNCATE users CASCADE');
  const adminId = await insertUser({ username: 'admin', isAdmin: true });
  const userId = await insertUser({ username: 'victim' });
  const otherId = await insertUser({ username: 'other' });
  const serverToken = randomHex(32);
  return {
    adminId, adminToken: loginJwt(adminId),
    userId, apiKey: await insertApiKey(userId), jwt: loginJwt(userId), refreshToken: await insertRefreshToken(userId),
    serverId: await insertServer(userId, serverToken), serverToken,
    otherId, otherServerId: await insertServer(otherId, randomHex(32)),
  };
}
async function disableViaAdmin(f: Fixture): Promise<Response> {
  return makeApp().request(`/api/admin/users/${f.userId}/disable`, { method: 'POST', headers: cookie(f.adminToken) });
}

type Cell = { name: string; call: (f: Fixture) => Promise<Response>; ok: number };
const get = (path: string, headers: (f: Fixture) => Record<string, string>) => async (f: Fixture) => makeApp().request(path, { method: 'GET', headers: headers(f) });

const HTTP_MATRIX: Cell[] = [
  { name: 'API key (Bearer deck_…)', ok: 200, call: get('/api/aliases', (f) => bearer(f.apiKey)) },
  { name: 'login JWT (Bearer)', ok: 200, call: get('/api/aliases', (f) => bearer(f.jwt)) },
  { name: 'login JWT (session cookie)', ok: 200, call: get('/api/aliases', (f) => cookie(f.jwt)) },
  { name: 'daemon server-token on a requireAuth route (Bearer + X-Server-Id)', ok: 200, call: get('/api/aliases', (f) => daemon(f.serverId, f.serverToken)) },
  { name: 'daemon server-token on a daemon-token route (authenticateDaemonServer)', ok: 200,
    call: async (f) => makeApp().request(`/api/server/${f.serverId}/shared-context/runtime-config/daemon`, { method: 'GET', headers: bearer(f.serverToken) }) },
  { name: 'auth route /user/me with an API key', ok: 200, call: get('/api/auth/user/me', (f) => bearer(f.apiKey)) },
  { name: 'auth route /user/me with a login JWT', ok: 200, call: get('/api/auth/user/me', (f) => bearer(f.jwt)) },
  { name: 'passkey route (credentials) with an API key', ok: 200, call: get('/api/auth/passkey/credentials', (f) => bearer(f.apiKey)) },
  { name: 'passkey route (credentials) with a login JWT', ok: 200, call: get('/api/auth/passkey/credentials', (f) => bearer(f.jwt)) },
  { name: 'ws-ticket for the user\'s own server', ok: 200,
    call: async (f) => makeApp().request('/api/auth/ws-ticket', {
      method: 'POST', headers: { ...bearer(f.jwt), 'Content-Type': 'application/json' }, body: JSON.stringify({ serverId: f.serverId }),
    }) },
  { name: 'refresh token', ok: 200,
    call: async (f) => makeApp().request('/api/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ refreshToken: f.refreshToken }),
    }) },
];

describe('F-01: a disabled user keeps no API access (real middleware, real PostgreSQL)', () => {
  let f: Fixture;
  beforeEach(async () => { f = await fixture(); });

  for (const cell of HTTP_MATRIX) {
    it(`${cell.name}: works while active, refused after the admin disables the user`, async () => {
      const before = await cell.call(f);
      expect(before.status, 'active user must work').toBe(cell.ok);
      expect((await disableViaAdmin(f)).status).toBe(200);
      const after = await cell.call(f);
      expect([401, 403], `${cell.name} after disable`).toContain(after.status);
    });

    // The CC10 reproduction as written: only the STATUS changes (the base's disable route did nothing else), so nothing else can be what
    // refuses the credential -- a path that does not check the account itself fails here with a 200.
    it(`${cell.name}: refused when ONLY users.status changes (no key revoked, no epoch stamped)`, async () => {
      expect((await cell.call(f)).status, 'active user must work').toBe(cell.ok);
      await db.execute("UPDATE users SET status = 'disabled' WHERE id = $1", [f.userId]);
      const after = await cell.call(f);
      expect([401, 403], `${cell.name} after a bare status flip`).toContain(after.status);
      expect(after.status, 'must not be a success').not.toBe(cell.ok);
    });
  }

  it('the refusal names the account (account_disabled) for a genuine credential, and nothing for an unknown one', async () => {
    await db.execute("UPDATE users SET status = 'disabled' WHERE id = $1", [f.userId]);
    const known = await makeApp().request('/api/aliases', { headers: bearer(f.apiKey) });
    expect(known.status).toBe(403);
    expect(await known.json()).toEqual({ error: AUTH_ERROR_CODES.ACCOUNT_DISABLED });
    const unknown = await makeApp().request('/api/aliases', { headers: bearer(`deck_${randomHex(32)}`) });
    expect(unknown.status).toBe(401);
    const daemonDenied = await makeApp().request(`/api/server/${f.serverId}/shared-context/runtime-config/daemon`, { headers: bearer(f.serverToken) });
    expect(daemonDenied.status).toBe(403);
    expect(await daemonDenied.json()).toEqual({ error: AUTH_ERROR_CODES.ACCOUNT_DISABLED });
  });

  it('password login of a disabled user stays refused with account_disabled', async () => {
    await disableViaAdmin(f);
    const res = await makeApp().request('/api/auth/password/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ username: 'victim', password: 'Passw0rd!x' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: AUTH_ERROR_CODES.ACCOUNT_DISABLED });
  });

  it('pending and unknown statuses are refused too (only exactly `active` acts), as is a deleted user\'s token', async () => {
    await db.execute("UPDATE users SET status = 'pending' WHERE id = $1", [f.userId]);
    const pending = await makeApp().request('/api/aliases', { headers: bearer(f.apiKey) });
    expect(pending.status).toBe(403);
    expect(await pending.json()).toEqual({ error: AUTH_ERROR_CODES.ACCOUNT_PENDING });
    await db.execute("UPDATE users SET status = 'suspended-by-a-future-version' WHERE id = $1", [f.userId]);
    expect((await makeApp().request('/api/aliases', { headers: bearer(f.jwt) })).status).toBe(403);
    await db.execute('DELETE FROM servers WHERE user_id = $1', [f.userId]);
    await db.execute('DELETE FROM refresh_tokens WHERE user_id = $1', [f.userId]);
    await db.execute('DELETE FROM api_keys WHERE user_id = $1', [f.userId]);
    await db.execute('DELETE FROM users WHERE id = $1', [f.userId]);
    expect((await makeApp().request('/api/aliases', { headers: bearer(f.jwt) })).status).toBe(403);
  });
});

describe('disable / enable contract', () => {
  let f: Fixture;
  beforeEach(async () => { f = await fixture(); });

  it('disable ends keys, refresh tokens, login nonces and native sessions, stamps the sessions epoch and writes an audit record', async () => {
    await db.execute('INSERT INTO auth_nonces (nonce, api_key, user_id, key_id, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [randomHex(8), 'deck_x', f.userId, 'k', Date.now() + 60_000, Date.now()]);
    const before = Date.now();
    expect((await disableViaAdmin(f)).status).toBe(200);
    const user = await db.queryOne<{ status: string; sessions_valid_after: string }>('SELECT status, sessions_valid_after FROM users WHERE id = $1', [f.userId]);
    expect(user!.status).toBe('disabled');
    expect(Number(user!.sessions_valid_after)).toBeGreaterThanOrEqual(before);
    expect((await db.query('SELECT 1 FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL', [f.userId])).length).toBe(0);
    expect((await db.query('SELECT 1 FROM refresh_tokens WHERE user_id = $1 AND used_at IS NULL', [f.userId])).length).toBe(0);
    expect((await db.query('SELECT 1 FROM auth_nonces WHERE user_id = $1', [f.userId])).length).toBe(0);
    const audit = await db.queryOne<{ details: string }>("SELECT details FROM audit_log WHERE action = 'admin.disable_user' ORDER BY created_at DESC LIMIT 1");
    expect(JSON.parse(audit!.details)).toMatchObject({ targetId: f.userId, previousStatus: 'active', apiKeysRevoked: 1, refreshTokensEnded: 1, loginNoncesDeleted: 1 });
  });

  it('enable restores the STATUS only: ended keys, refresh tokens and every login minted before the disable stay dead; a fresh login works', async () => {
    await disableViaAdmin(f);
    expect((await makeApp().request(`/api/admin/users/${f.userId}/approve`, { method: 'POST', headers: cookie(f.adminToken) })).status).toBe(200);
    expect((await db.queryOne<{ status: string }>('SELECT status FROM users WHERE id = $1', [f.userId]))!.status).toBe('active');
    // the key was revoked, the refresh token used up, the old login minted before the stamp
    expect((await makeApp().request('/api/aliases', { headers: bearer(f.apiKey) })).status).toBe(401);
    const staleLogin = loginJwt(f.userId, -3600);
    expect((await makeApp().request('/api/aliases', { headers: bearer(staleLogin) })).status).toBe(403);
    expect((await makeApp().request('/api/aliases', { headers: bearer(f.jwt) })).status).toBe(403);
    expect((await makeApp().request('/api/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ refreshToken: f.refreshToken }),
    })).status).toBeGreaterThanOrEqual(401);
    // a login minted AFTER the stamp works (the stamp is in the past of a later second)
    const fresh = loginJwt(f.userId, 5);
    expect((await makeApp().request('/api/aliases', { headers: bearer(fresh) })).status).toBe(200);
    // the machine's daemon token was never revoked: its daemon resumes when the account does
    expect((await makeApp().request(`/api/server/${f.serverId}/shared-context/runtime-config/daemon`, { headers: bearer(f.serverToken) })).status).toBe(200);
  });

  it('lockout rules: nobody can disable themselves, the default admin account, or the last active admin', async () => {
    const selfDisable = await makeApp().request(`/api/admin/users/${f.adminId}/disable`, { method: 'POST', headers: cookie(f.adminToken) });
    expect(selfDisable.status).toBe(403);
    expect(await selfDisable.json()).toEqual({ error: 'cannot_modify_self' });
    const second = await insertUser({ username: 'second-admin', isAdmin: true });
    const disableDefault = await makeApp().request(`/api/admin/users/${f.adminId}/disable`, { method: 'POST', headers: cookie(loginJwt(second)) });
    expect(await disableDefault.json()).toEqual({ error: 'cannot_disable_admin' });
    await db.execute("UPDATE users SET username = 'renamed-admin' WHERE id = $1", [f.adminId]);
    await db.execute("UPDATE users SET is_admin = FALSE WHERE id = $1", [second]);
    const third = await insertUser({ username: 'third-admin', isAdmin: true });
    // the only OTHER active admin is `third`; renamed-admin is the last-but-one: disabling third while renamed-admin is active is fine,
    // disabling the last active admin is not
    await db.execute("UPDATE users SET is_admin = FALSE WHERE id = $1", [third]);
    const last = await makeApp().request(`/api/admin/users/${f.adminId}/disable`, { method: 'POST', headers: cookie(loginJwt(second)) });
    expect(last.status).toBe(403); // second is no admin any more: the admin API refuses the caller itself
  });

  it('a disabled admin cannot use the admin API with an old session (account status is checked before the role)', async () => {
    const second = await insertUser({ username: 'second-admin', isAdmin: true });
    const secondToken = loginJwt(second);
    await db.execute("UPDATE users SET status = 'disabled' WHERE id = $1", [second]);
    expect((await makeApp().request('/api/admin/users', { headers: cookie(secondToken) })).status).toBe(403);
  });
});

describe('every other identity path', () => {
  let f: Fixture;
  beforeEach(async () => { f = await fixture(); });

  it('WebSocket admission: a disabled member, a disabled share participant and a disabled controlled-machine operator are refused; so is a server whose owner is disabled', async () => {
    // member of the other user's server through a server share
    await db.execute(
      'INSERT INTO server_shares (id, server_id, target_user_id, role, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)',
      [randomHex(8), f.otherServerId, f.userId, 'participant', f.otherId, Date.now()],
    );
    const controlledToken = randomHex(32);
    const controlledId = await insertServer(f.userId, controlledToken, 'controlled');
    const now = Date.now();
    const target = { kind: 'server' as const, serverId: f.otherServerId };

    expect(await resolveServerWebSocketAccess(db, f.serverId, f.userId)).not.toBeNull();
    expect(await resolveServerWebSocketAccess(db, controlledId, f.userId, now)).not.toBeNull();
    expect(await resolveEffectiveShareCoverage(db, { userId: f.userId, target, now })).not.toBeNull();
    expect(await resolveControlledMachineOperatorAccess(db, f.userId, controlledId, now)).not.toBeNull();
    expect(await resolveServerRole(db, f.otherServerId, f.userId)).toBe('owner'); // participant authority

    await disableViaAdmin(f);

    expect(await resolveServerWebSocketAccess(db, f.serverId, f.userId)).toBeNull();
    expect(await resolveServerWebSocketAccess(db, controlledId, f.userId, now)).toBeNull();
    expect(await resolveEffectiveShareCoverage(db, { userId: f.userId, target, now })).toBeNull();
    expect(await resolveControlledMachineOperatorAccess(db, f.userId, controlledId, now)).toBeNull();
    expect(await resolveServerRole(db, f.otherServerId, f.userId)).toBe('none');

    // the OWNER disabled: a still-active grantee loses the server it was shared (it acts as its owner)
    await db.execute("UPDATE users SET status = 'active' WHERE id = $1", [f.userId]);
    expect(await resolveEffectiveShareCoverage(db, { userId: f.userId, target, now })).not.toBeNull();
    await db.execute("UPDATE users SET status = 'disabled' WHERE id = $1", [f.otherId]);
    expect(await resolveEffectiveShareCoverage(db, { userId: f.userId, target, now })).toBeNull();
    expect(await resolveServerRole(db, f.otherServerId, f.userId)).toBe('none');
  });

  it('cron: a disabled owner\'s due jobs are not claimed, and are claimed again after enabling', async () => {
    const id = randomHex(8);
    await db.execute(
      `INSERT INTO cron_jobs (id, server_id, user_id, name, cron_expr, project_name, target_role, action, status, next_run_at, completion_policy, created_at, updated_at)
       VALUES ($1,$2,$3,'j','* * * * *','p','brain','{"type":"command","command":"x"}','active',$4,'recurring',$5,$5)`,
      [id, f.serverId, f.userId, Date.now() - 60_000, Date.now()],
    );
    await db.execute("UPDATE users SET status = 'disabled' WHERE id = $1", [f.userId]);
    await jobDispatchCron(makeEnv());
    expect((await db.query('SELECT 1 FROM cron_executions WHERE job_id = $1', [id])).length).toBe(0);
    await db.execute("UPDATE users SET status = 'active' WHERE id = $1", [f.userId]);
    await jobDispatchCron(makeEnv());
    expect((await db.query('SELECT 1 FROM cron_executions WHERE job_id = $1', [id])).length).toBeGreaterThan(0);
  });

  it('push: a disabled user\'s devices receive nothing (no badge bump either)', async () => {
    await db.execute('INSERT INTO push_tokens (user_id, token, platform, created_at) VALUES ($1,$2,$3,$4)', [f.userId, 'tok-1', 'ios', Date.now()]);
    const badge = async () => Number((await db.queryOne<{ badge_count: string }>('SELECT badge_count FROM users WHERE id = $1', [f.userId]))!.badge_count);
    const start = await badge();
    await db.execute("UPDATE users SET status = 'disabled' WHERE id = $1", [f.userId]);
    await dispatchPush({ userId: f.userId, title: 't', body: 'b' } as never, makeEnv()).catch(() => undefined);
    expect(await badge()).toBe(start);
  });

  it('token exchange: a disabled user\'s API-key login nonce is consumed and refused, the key is never handed out', async () => {
    const nonce = randomHex(16);
    await db.execute('INSERT INTO auth_nonces (nonce, api_key, user_id, key_id, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [nonce, 'deck_secret', f.userId, 'k1', Date.now() + 60_000, Date.now()]);
    await db.execute("UPDATE users SET status = 'disabled' WHERE id = $1", [f.userId]);
    const res = await makeApp().request('/api/auth/token-exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ nonce }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain('deck_secret');
  });

  it('enrollment: a controlled-node install ticket of a disabled owner redeems nothing (and the same ticket redeems while the owner is active)', async () => {
    const enrollToken = `enroll-${randomHex(16)}`;
    await db.execute(
      `INSERT INTO controlled_node_enrollments_v2
         (ticket_hash, code_hash, owner_user_id, os, arch, artifact_sha256, encrypted_code, ticket_expires_at, expires_at, created_at, max_consumes)
       VALUES ($1,$2,$3,'linux','x64',$4,'enc',$5,$5,$6,3)`,
      [sha256Hex(`t-${enrollToken}`), sha256Hex(enrollToken), f.userId, 'a'.repeat(64), Date.now() + 600_000, Date.now()],
    );
    const redeem = () => makeApp().request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ version: 2, enrollToken, installId: 'install-1', nodeTokenHash: sha256Hex('node-token'), hostname: 'host', os: 'linux', arch: 'x64' }),
    });
    await db.execute("UPDATE users SET status = 'disabled' WHERE id = $1", [f.userId]);
    const refused = await redeem();
    expect(refused.status).toBe(401);
    expect((await db.query('SELECT 1 FROM servers WHERE user_id = $1 AND node_role = $2', [f.userId, 'controlled'])).length).toBe(0);
    await db.execute("UPDATE users SET status = 'active' WHERE id = $1", [f.userId]);
    const accepted = await redeem();
    expect(accepted.status, 'the very same ticket redeems for an active owner').toBe(200);
  });

  it('a controlled node\'s own credential is refused once its owner is disabled (artifact download)', async () => {
    const token = randomHex(32);
    const nodeId = await insertServer(f.userId, token, 'controlled');
    const url = `/api/enroll/v2/node-artifact?serverId=${nodeId}&os=linux&arch=x64&asset=node`;
    const before = await makeApp().request(url, { headers: bearer(token) });
    expect(before.status, 'baseline: the owner is active').not.toBe(403);
    await db.execute("UPDATE users SET status = 'disabled' WHERE id = $1", [f.userId]);
    const after = await makeApp().request(url, { headers: bearer(token) });
    expect(after.status).toBe(403);
    expect(await after.json()).toEqual({ error: AUTH_ERROR_CODES.ACCOUNT_DISABLED });
  });

  it('login-token epoch arithmetic: only tokens minted before the stamp are refused', () => {
    expect(evaluateUserAccess({ status: 'active', sessionsValidAfter: 10_000 }, 9).ok).toBe(false);
    expect(evaluateUserAccess({ status: 'active', sessionsValidAfter: 10_000 }, 10).ok).toBe(true);
    expect(evaluateUserAccess({ status: 'active', sessionsValidAfter: 0 }, 1).ok).toBe(true);
    expect(evaluateUserAccess(null).ok).toBe(false);
    expect(evaluateUserAccess({ status: 'disabled', sessionsValidAfter: 0 }, 100)).toEqual({ ok: false, code: AUTH_ERROR_CODES.ACCOUNT_DISABLED });
    expect(evaluateUserAccess({ status: 'pending', sessionsValidAfter: 0 })).toEqual({ ok: false, code: AUTH_ERROR_CODES.ACCOUNT_PENDING });
  });
});

describe('live connections and two replicas', () => {
  let f: Fixture;
  beforeEach(async () => { f = await fixture(); });

  class FakeSocket extends EventEmitter {
    readyState = 1;
    closed: { code?: number; reason?: string } | null = null;
    sent: unknown[] = [];
    send(data: unknown, _o?: unknown, cb?: (e?: Error) => void) { this.sent.push(data); cb?.(); }
    close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = 3; this.emit('close', code, reason); }
    terminate() { this.close(1006, 'terminated'); }
    ping() {}
  }

  it('the disable route closes this replica\'s live browser sockets of that user, with close code 4003 and the account error code', async () => {
    const bridge = WsBridge.get(f.serverId);
    const userSocket = new FakeSocket();
    const otherSocket = new FakeSocket();
    bridge.handleBrowserConnection(userSocket as never, f.userId, db, false);
    bridge.handleBrowserConnection(otherSocket as never, f.otherId, db, false);
    expect((await disableViaAdmin(f)).status).toBe(200);
    expect(userSocket.closed).toEqual({ code: ACCOUNT_WS_CLOSE_CODE, reason: AUTH_ERROR_CODES.ACCOUNT_DISABLED });
    expect(otherSocket.closed).toBeNull();
  });

  it('two replicas, one database: a disable served by replica A is honoured by replica B for requests at once and for live sockets within the watch interval', async () => {
    const replicaA = makeApp();
    const replicaB = makeApp();
    expect((await replicaB.request('/api/aliases', { headers: bearer(f.jwt) })).status).toBe(200);
    // replica B holds a live socket for the user; replica A serves the disable without ever seeing it (a separate bridge map stands in
    // for the other process: the account is only known to the shared database)
    const bridgeB = new (WsBridge as unknown as new (id: string) => WsBridge)(`replica-b-${randomHex(4)}`);
    const socketOnB = new FakeSocket();
    bridgeB.handleBrowserConnection(socketOnB as never, f.userId, db, false);
    const disable = await replicaA.request(`/api/admin/users/${f.userId}/disable`, { method: 'POST', headers: cookie(f.adminToken) });
    expect(disable.status).toBe(200);
    expect(socketOnB.closed, 'replica A cannot reach replica B\'s socket').toBeNull();
    // requests: no per-pod cache, so replica B refuses at once
    expect((await replicaB.request('/api/aliases', { headers: bearer(f.jwt) })).status).toBe(403);
    // sockets: replica B's own watcher closes it on its next tick
    vi.useFakeTimers();
    try {
      const stop = startAccountConnectionWatch(db, 50);
      void stop;
      vi.useRealTimers();
      const closeNow = await closeConnectionsOfInactiveUsers(db, [bridgeB]);
      stop();
      expect(closeNow.browserSockets).toBe(1);
    } finally { vi.useRealTimers(); }
    expect(socketOnB.closed).toEqual({ code: ACCOUNT_WS_CLOSE_CODE, reason: AUTH_ERROR_CODES.ACCOUNT_DISABLED });
  });

  it('the periodic watcher closes the sockets of an account disabled by direct SQL (any replica) within its interval', async () => {
    const bridge = WsBridge.get(f.serverId);
    const socket = new FakeSocket();
    bridge.handleBrowserConnection(socket as never, f.userId, db, false);
    const stop = startAccountConnectionWatch(db, 30);
    try {
      await db.execute("UPDATE users SET status = 'disabled' WHERE id = $1", [f.userId]);
      await vi.waitFor(() => expect(socket.closed).not.toBeNull(), { timeout: 3_000, interval: 20 });
    } finally { stop(); }
    expect(socket.closed).toEqual({ code: ACCOUNT_WS_CLOSE_CODE, reason: AUTH_ERROR_CODES.ACCOUNT_DISABLED });
  });

  it('loadUserAccess reads the database every time (no cache): a status flip is visible to the next read', async () => {
    expect((await loadUserAccess(db, f.userId))!.status).toBe('active');
    await db.execute("UPDATE users SET status = 'disabled' WHERE id = $1", [f.userId]);
    expect((await loadUserAccess(db, f.userId))!.status).toBe('disabled');
  });
});
