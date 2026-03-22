import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from '../env.js';
import { createUser, getUserById, getUserByUsername } from '../db/queries.js';
import { randomHex, sha256Hex, signJwt, verifyJwt, hashPassword, verifyPassword } from '../security/crypto.js';
import { checkIdempotency, recordIdempotency } from '../security/replay.js';
import { logAudit } from '../security/audit.js';
import { checkAuthLockout, recordAuthFailure } from '../security/lockout.js';
import { resolveServerRole } from '../security/authorization.js';
import { WsBridge } from '../ws/bridge.js';
import { z } from 'zod';
import logger from '../util/logger.js';

export const authRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

// Task 5: Cache-Control: no-store on all auth endpoints
authRoutes.use('/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
});

// ── Shared auth helper ────────────────────────────────────────────────────
// Resolves the authenticated user ID from cookie (browser) or Bearer token (API key / CLI).
// Accepts any Hono Context with Bindings: Env — Variables generic is intentionally widened.
type AnyAuthContext = { req: { header(name: string): string | undefined }; env: Env };

async function resolveUserId(c: AnyAuthContext): Promise<string | null> {
  // Task 1: Try rcc_session cookie first (parse manually to avoid Hono Context type constraint)
  const cookieHeader = c.req.header('cookie') ?? '';
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)rcc_session=([^;]+)/);
  const cookieToken = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
  if (cookieToken && c.env.JWT_SIGNING_KEY) {
    const jwt = verifyJwt(cookieToken, c.env.JWT_SIGNING_KEY);
    if (jwt && typeof jwt.sub === 'string' && jwt.type !== 'ws-ticket') {
      const user = await getUserById(c.env.DB, jwt.sub);
      if (user && user.status === 'active') return user.id;
    }
  }

  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const bearerToken = auth.slice(7);

  // Try JWT first (web session tokens) — reject single-use ws-ticket tokens
  const jwtBearer = verifyJwt(bearerToken, c.env.JWT_SIGNING_KEY);
  if (jwtBearer && typeof jwtBearer.sub === 'string' && jwtBearer.type !== 'ws-ticket') {
    const user = await getUserById(c.env.DB, jwtBearer.sub);
    if (user && user.status === 'active') return user.id;
  }

  // Fall back to API key check
  const keyHash = sha256Hex(bearerToken);
  const row = await c.env.DB.prepare(
    'SELECT user_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL',
  ).bind(keyHash).first<{ user_id: string }>();
  if (row) {
    const apiKeyUser = await getUserById(c.env.DB, row.user_id);
    if (apiKeyUser && apiKeyUser.status === 'active') return row.user_id;
  }

  return null;
}

// POST /api/auth/register — create a new user and issue initial API key
authRoutes.post('/register', async (c) => {
  // Idempotency: deduplicate retried registration requests
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (idempotencyKey) {
    const cached = await checkIdempotency(idempotencyKey, 'anon', c.env.DB);
    if (cached) return c.body(cached.body, cached.status as never);
  }

  const userId = randomHex(16);
  await createUser(c.env.DB, userId);

  const rawKey = `deck_${randomHex(32)}`;
  const keyHash = sha256Hex(rawKey);
  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO api_keys (id, user_id, key_hash, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(randomHex(16), userId, keyHash, now)
    .run();

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAudit({ userId, action: 'auth.register', ip }, c.env.DB);

  const responseBody = JSON.stringify({ userId, apiKey: rawKey });
  if (idempotencyKey) {
    await recordIdempotency(idempotencyKey, 'anon', 201, responseBody, c.env.DB);
  }
  return c.body(responseBody, 201, { 'Content-Type': 'application/json' });
});

// Platform identity linking is handled exclusively through verified OAuth flows
// (e.g., github-auth.ts). No public endpoint is exposed to prevent identity pre-claiming.

// GET /api/auth/user/me — get authenticated user (cookie, Bearer API key or JWT)
// NOTE: must be registered before /user/:id to avoid Hono matching id='me'
authRoutes.get('/user/me', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const user = await getUserById(c.env.DB, userId);
  if (!user) return c.json({ error: 'not_found' }, 404);
  return c.json(user);
});

// GET /api/auth/user/:id — requires auth, only accessible for own user ID
authRoutes.get('/user/:id', async (c) => {
  const authedUserId = await resolveUserId(c);
  if (!authedUserId) return c.json({ error: 'unauthorized' }, 401);

  const requestedId = c.req.param('id');
  if (authedUserId !== requestedId) return c.json({ error: 'forbidden' }, 403);

  const user = await getUserById(c.env.DB, requestedId);
  if (!user) return c.json({ error: 'not_found' }, 404);
  return c.json(user);
});

// POST /api/user/:id/rotate-key — generate new API key, 24-hour grace for old key
authRoutes.post('/user/:id/rotate-key', async (c) => {
  const authedUserId = await resolveUserId(c);
  if (!authedUserId) return c.json({ error: 'unauthorized' }, 401);

  const userId = c.req.param('id');
  if (authedUserId !== userId) return c.json({ error: 'forbidden' }, 403);

  const user = await getUserById(c.env.DB, userId);
  if (!user) return c.json({ error: 'not_found' }, 404);

  // Mark existing active keys as grace-period (grace expires in 24 hours)
  const graceExpiry = Date.now() + 24 * 3600 * 1000;
  await c.env.DB.prepare(
    "UPDATE api_keys SET grace_expires_at = ? WHERE user_id = ? AND revoked_at IS NULL AND grace_expires_at IS NULL",
  ).bind(graceExpiry, userId).run();

  // Issue new key
  const rawKey = `deck_${randomHex(32)}`;
  const keyHash = sha256Hex(rawKey);
  await c.env.DB.prepare(
    'INSERT INTO api_keys (id, user_id, key_hash, created_at) VALUES (?, ?, ?, ?)',
  ).bind(randomHex(16), userId, keyHash, Date.now()).run();

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAudit({ userId, action: 'auth.rotate_key', ip }, c.env.DB);

  return c.json({ apiKey: rawKey, graceExpiry });
});

// DELETE /api/user/:id/key — revoke all API keys immediately
authRoutes.delete('/user/:id/key', async (c) => {
  const authedUserId = await resolveUserId(c);
  if (!authedUserId) return c.json({ error: 'unauthorized' }, 401);

  const userId = c.req.param('id');
  if (authedUserId !== userId) return c.json({ error: 'forbidden' }, 403);

  const user = await getUserById(c.env.DB, userId);
  if (!user) return c.json({ error: 'not_found' }, 404);

  const now = Date.now();
  await c.env.DB.prepare(
    'UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
  ).bind(now, userId).run();

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAudit({ userId, action: 'auth.revoke_keys', ip }, c.env.DB);

  return c.json({ ok: true, revokedAt: now });
});

// POST /api/auth/user/me/keys — create a new API key for the authenticated user
authRoutes.post('/user/me/keys', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const label = typeof body.label === 'string' ? body.label : null;

  const rawKey = `deck_${randomHex(32)}`;
  const keyHash = sha256Hex(rawKey);
  const keyId = randomHex(16);
  const now = Date.now();

  await c.env.DB.prepare(
    'INSERT INTO api_keys (id, user_id, key_hash, label, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(keyId, userId, keyHash, label, now).run();

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAudit({ userId, action: 'auth.create_key', ip }, c.env.DB);

  return c.json({ id: keyId, apiKey: rawKey, label, createdAt: now }, 201);
});

// GET /api/auth/user/me/keys — list all API keys for the authenticated user (no raw key)
authRoutes.get('/user/me/keys', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const result = await c.env.DB.prepare(
    'SELECT id, label, created_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
  ).bind(userId).all<{ id: string; label: string | null; created_at: number; revoked_at: number | null }>();

  const keys = result.results.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  }));

  return c.json({ keys });
});

// DELETE /api/auth/user/me/keys/:keyId — revoke a specific API key
authRoutes.delete('/user/me/keys/:keyId', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const keyId = c.req.param('keyId');

  // Verify ownership
  const key = await c.env.DB.prepare(
    'SELECT id FROM api_keys WHERE id = ? AND user_id = ?',
  ).bind(keyId, userId).first<{ id: string }>();

  if (!key) return c.json({ error: 'not_found' }, 404);

  const now = Date.now();
  await c.env.DB.prepare(
    'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ?',
  ).bind(now, keyId, userId).run();

  // Kick all daemon WebSocket connections that were bound using this API key
  const boundServers = await c.env.DB.prepare(
    'SELECT id FROM servers WHERE bound_with_key_id = ? AND user_id = ?',
  ).bind(keyId, userId).all<{ id: string }>();
  for (const srv of boundServers.results) {
    try { WsBridge.get(srv.id).kickDaemon(); } catch { /* bridge may not be active */ }
  }

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAudit({ userId, action: 'auth.revoke_key', ip, details: { keyId, serversKicked: boundServers.results.length } }, c.env.DB);

  return c.json({ ok: true, revokedAt: now });
});

// POST /api/auth/ws-ticket — issue a short-lived WebSocket ticket
const wsTicketSchema = z.object({ serverId: z.string() });

authRoutes.post('/ws-ticket', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = wsTicketSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  // Check server access
  const role = await resolveServerRole(c.env.DB, parsed.data.serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const jti = randomHex(16);
  const ticket = signJwt(
    { sub: userId, type: 'ws-ticket', sid: parsed.data.serverId, jti },
    c.env.JWT_SIGNING_KEY,
    15, // 15 seconds
  );

  return c.json({ ticket });
});

// POST /api/auth/refresh — refresh JWT access token (cookie or JSON body)
const refreshSchema = z.object({ refreshToken: z.string().optional() });

authRoutes.post('/refresh', async (c) => {
  const cookieRefresh = getCookie(c, 'rcc_refresh');
  const body = await c.req.json().catch(() => null);
  const parsed = refreshSchema.safeParse(body);
  const refreshToken = cookieRefresh ?? parsed.data?.refreshToken;
  if (!refreshToken) {
    logger.warn({ hasCookieRefresh: !!cookieRefresh }, '[refresh] no refresh token provided');
    return c.json({ error: 'invalid_body' }, 400);
  }

  const tokenHash = sha256Hex(refreshToken);

  // Only accept unused tokens (used_at IS NULL). Already-consumed tokens are simply
  // rejected — no family revocation. This matches the pre-security-hardening behaviour
  // that was stable. The replay-detection pattern (revoking entire families) caused
  // cascading logouts whenever a Set-Cookie response was lost (network glitch, browser
  // crash, race between tabs).
  const row = await c.env.DB.prepare(
    'SELECT * FROM refresh_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
  )
    .bind(tokenHash, Date.now())
    .first<{ id: string; user_id: string; family_id: string }>();

  if (!row) {
    logger.warn({ hashPrefix: tokenHash.slice(0, 8) }, '[refresh] token not found, already used, or expired');
    return c.json({ error: 'invalid_token' }, 401);
  }

  // Per-user lockout check
  const userLockout = await checkAuthLockout(c.env.DB, `user:${row.user_id}`);
  if (userLockout.locked) {
    return c.json({ error: 'too_many_attempts', retryAfterMs: userLockout.lockedUntil ? userLockout.lockedUntil - Date.now() : 0 }, 429);
  }

  // Mark old token consumed (rotation)
  await c.env.DB.prepare('UPDATE refresh_tokens SET used_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
  logger.info({ tokenId: row.id }, '[refresh] token consumed, issuing new pair');

  // Issue new access (4h) + refresh (30d) tokens
  const accessToken = signJwt({ sub: row.user_id }, c.env.JWT_SIGNING_KEY, 4 * 3600);
  const newRefresh = randomHex(32);
  const newRefreshHash = sha256Hex(newRefresh);
  const newRefreshId = randomHex(16);
  await c.env.DB.prepare(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(newRefreshId, row.user_id, newRefreshHash, row.family_id, Date.now() + 30 * 24 * 3600 * 1000, Date.now())
    .run();

  const isSecure = c.env.NODE_ENV === 'production';

  if (cookieRefresh) {
    setCookie(c, 'rcc_session', accessToken, {
      httpOnly: true, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 4 * 3600,
    });
    setCookie(c, 'rcc_refresh', newRefresh, {
      httpOnly: true, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 30 * 86400,
    });
    // Don't rotate CSRF token on refresh — only set on login.
    // Rotating on every refresh causes race conditions in multi-tab scenarios:
    // tab A refreshes → new CSRF cookie → tab B's next request has stale CSRF header → 403.
    return c.json({ ok: true });
  }

  return c.json({ accessToken, refreshToken: newRefresh });
});

// DELETE /api/auth/user/me — permanently delete the authenticated user and all associated data
authRoutes.delete('/user/me', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const user = await getUserById(c.env.DB, userId);
  if (!user) return c.json({ error: 'not_found' }, 404);

  const db = c.env.DB;

  // 1. Passkey credentials
  await db.prepare('DELETE FROM passkey_credentials WHERE user_id = ?').bind(userId).run();
  // 2. Passkey challenges
  await db.prepare('DELETE FROM passkey_challenges WHERE user_id = ?').bind(userId).run();
  // 3. API keys
  await db.prepare('DELETE FROM api_keys WHERE user_id = ?').bind(userId).run();
  // 4. Refresh tokens
  await db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(userId).run();
  // 5. Push tokens
  await db.prepare('DELETE FROM push_tokens WHERE user_id = ?').bind(userId).run();
  // 6. Push subscriptions
  await db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(userId).run();

  // 7. Get server IDs for cascade deleting server-scoped data
  const serverRows = await db.prepare('SELECT id FROM servers WHERE user_id = ?').bind(userId).all<{ id: string }>();
  const serverIds = serverRows.results.map((r) => r.id);

  if (serverIds.length > 0) {
    for (const sid of serverIds) {
      // Discussion rounds → discussions (CASCADE should handle rounds, but be explicit)
      await db.prepare('DELETE FROM discussion_rounds WHERE discussion_id IN (SELECT id FROM discussions WHERE server_id = ?)').bind(sid).run();
      await db.prepare('DELETE FROM discussions WHERE server_id = ?').bind(sid).run();
      // Sub-sessions
      await db.prepare('DELETE FROM sub_sessions WHERE server_id = ?').bind(sid).run();
      // Channel bindings
      await db.prepare('DELETE FROM channel_bindings WHERE server_id = ?').bind(sid).run();
      // Sessions
      await db.prepare('DELETE FROM sessions WHERE server_id = ?').bind(sid).run();
      // Cron jobs
      await db.prepare('DELETE FROM cron_jobs WHERE server_id = ?').bind(sid).run();
    }
  }

  // 8. Platform bots
  await db.prepare('DELETE FROM platform_bots WHERE user_id = ?').bind(userId).run();
  // 9. Servers
  await db.prepare('DELETE FROM servers WHERE user_id = ?').bind(userId).run();
  // 10. Pending binds
  await db.prepare('DELETE FROM pending_binds WHERE user_id = ?').bind(userId).run();
  // 11. Platform identities
  await db.prepare('DELETE FROM platform_identities WHERE user_id = ?').bind(userId).run();
  // 12. User preferences
  await db.prepare('DELETE FROM user_preferences WHERE user_id = ?').bind(userId).run();
  // 13. User quick data
  await db.prepare('DELETE FROM user_quick_data WHERE user_id = ?').bind(userId).run();
  // 14. Idempotency records
  await db.prepare('DELETE FROM idempotency_records WHERE user_id = ?').bind(userId).run();
  // 15. Team memberships (not owned teams — those are separate)
  await db.prepare('DELETE FROM team_members WHERE user_id = ?').bind(userId).run();
  // 16. Audit log entries (keep? delete for GDPR compliance)
  await db.prepare('DELETE FROM audit_log WHERE user_id = ?').bind(userId).run();
  // 17. Delete user
  await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();

  // Clear session cookies
  deleteCookie(c, 'rcc_session', { path: '/' });
  deleteCookie(c, 'rcc_refresh', { path: '/' });
  deleteCookie(c, 'rcc_csrf', { path: '/' });

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  logger.info({ userId, ip }, '[auth] account deleted');

  return c.json({ ok: true });
});

// ── Password auth ─────────────────────────────────────────────────────────

// POST /api/auth/password/login — authenticate with username + password
const passwordLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

authRoutes.post('/password/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = passwordLoginSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { username, password } = parsed.data;
  const ip = c.get('clientIp' as never) as string ?? 'unknown';

  // Per-IP lockout check
  const ipLockout = await checkAuthLockout(c.env.DB, `ip:${ip}`);
  if (ipLockout.locked) {
    return c.json({ error: 'too_many_attempts', retryAfterMs: ipLockout.lockedUntil ? ipLockout.lockedUntil - Date.now() : 0 }, 429);
  }

  const user = await getUserByUsername(c.env.DB, username);
  if (!user || !user.password_hash) {
    await recordAuthFailure(c.env.DB, `ip:${ip}`);
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  // Per-user lockout check
  const userLockout = await checkAuthLockout(c.env.DB, `user:${user.id}`);
  if (userLockout.locked) {
    return c.json({ error: 'too_many_attempts', retryAfterMs: userLockout.lockedUntil ? userLockout.lockedUntil - Date.now() : 0 }, 429);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    await recordAuthFailure(c.env.DB, `ip:${ip}`);
    await recordAuthFailure(c.env.DB, `user:${user.id}`);
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  // Reject disabled/pending users
  if (user.status !== 'active') {
    return c.json({ error: user.status === 'pending' ? 'account_pending' : 'account_disabled' }, 403);
  }

  // Issue access (4h) + refresh (30d) tokens
  const accessToken = signJwt({ sub: user.id, type: 'web' }, c.env.JWT_SIGNING_KEY, 4 * 3600);
  const refreshRaw = randomHex(32);
  const refreshHash = sha256Hex(refreshRaw);
  const familyId = randomHex(16);
  const refreshId = randomHex(16);
  await c.env.DB.prepare(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(refreshId, user.id, refreshHash, familyId, Date.now() + 30 * 24 * 3600 * 1000, Date.now()).run();

  const isSecure = c.env.NODE_ENV === 'production';
  setCookie(c, 'rcc_session', accessToken, {
    httpOnly: true, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 4 * 3600,
  });
  setCookie(c, 'rcc_refresh', refreshRaw, {
    httpOnly: true, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 30 * 86400,
  });
  setCookie(c, 'rcc_csrf', randomHex(32), {
    httpOnly: false, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 86400,
  });

  await logAudit({ userId: user.id, action: 'auth.password_login', ip }, c.env.DB);

  return c.json({
    ok: true,
    passwordMustChange: !!user.password_must_change,
    accessToken,
    refreshToken: refreshRaw,
  });
});

// PATCH /api/auth/user/me — update display name
const patchMeSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
});

authRoutes.patch('/user/me', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = patchMeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  if (parsed.data.displayName !== undefined) {
    await c.env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?')
      .bind(parsed.data.displayName, userId)
      .run();
  }

  const user = await getUserById(c.env.DB, userId);
  return c.json(user);
});

// POST /api/auth/password/change — change password (requires auth)
const passwordChangeSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

authRoutes.post('/password/change', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = passwordChangeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { oldPassword, newPassword } = parsed.data;

  const user = await getUserById(c.env.DB, userId);
  if (!user || !user.password_hash) return c.json({ error: 'no_password_set' }, 400);

  const valid = await verifyPassword(oldPassword, user.password_hash);
  if (!valid) return c.json({ error: 'invalid_old_password' }, 401);

  const newHash = await hashPassword(newPassword);
  await c.env.DB.prepare(
    'UPDATE users SET password_hash = ?, password_must_change = false WHERE id = ?',
  ).bind(newHash, userId).run();

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAudit({ userId, action: 'auth.password_change', ip }, c.env.DB);

  return c.json({ ok: true });
});

// POST /api/auth/logout — clear session cookies + invalidate refresh tokens
authRoutes.post('/logout', async (c) => {
  const userId = await resolveUserId(c);

  // Clear all auth cookies regardless of auth state
  deleteCookie(c, 'rcc_session', { path: '/' });
  deleteCookie(c, 'rcc_refresh', { path: '/' });
  deleteCookie(c, 'rcc_csrf', { path: '/' });

  // Invalidate all active refresh tokens for the user
  if (userId) {
    await c.env.DB.prepare(
      'UPDATE refresh_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL',
    ).bind(Date.now(), userId).run();
  }

  return c.json({ ok: true });
});
