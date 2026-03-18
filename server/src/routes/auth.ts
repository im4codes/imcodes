import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from '../env.js';
import { createUser, getUserById } from '../db/queries.js';
import { randomHex, sha256Hex, signJwt, verifyJwt } from '../security/crypto.js';
import { checkIdempotency, recordIdempotency } from '../security/replay.js';
import { logAudit } from '../security/audit.js';
import { checkAuthLockout } from '../security/lockout.js';
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
      if (user) return user.id;
    }
  }

  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const bearerToken = auth.slice(7);

  // Try JWT first (web session tokens) — reject single-use ws-ticket tokens
  const jwt = verifyJwt(bearerToken, c.env.JWT_SIGNING_KEY);
  if (jwt && typeof jwt.sub === 'string' && jwt.type !== 'ws-ticket') {
    const user = await getUserById(c.env.DB, jwt.sub);
    if (user) return user.id;
  }

  // Fall back to API key check
  const keyHash = sha256Hex(bearerToken);
  const row = await c.env.DB.prepare(
    'SELECT user_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL',
  ).bind(keyHash).first<{ user_id: string }>();
  if (row) return row.user_id;

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
    setCookie(c, 'rcc_csrf', randomHex(32), {
      httpOnly: false, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 86400,
    });
    return c.json({ ok: true });
  }

  return c.json({ accessToken, refreshToken: newRefresh });
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
