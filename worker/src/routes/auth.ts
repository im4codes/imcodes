import { Hono } from 'hono';
import type { Env } from '../types.js';
import { createUser, getUserById } from '../db/queries.js';
import { randomHex, sha256Hex, signJwt, verifyJwt } from '../security/crypto.js';
import { checkIdempotency, recordIdempotency } from '../security/replay.js';
import { logAudit } from '../security/audit.js';
import { recordAuthFailure, checkAuthLockout } from '../security/lockout.js';
import { z } from 'zod';

export const authRoutes = new Hono<{ Bindings: Env }>();

// ── Shared auth helper ────────────────────────────────────────────────────
// Resolves the authenticated user ID from Bearer token (JWT or API key).
async function resolveUserId(c: { req: { header(name: string): string | undefined }; env: Env }): Promise<string | null> {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const bearerToken = auth.slice(7);

  // Try JWT first (web session tokens) — reject single-use ws-ticket tokens
  const jwt = await verifyJwt(bearerToken, c.env.JWT_SIGNING_KEY);
  if (jwt && typeof jwt.sub === 'string' && jwt.type !== 'ws-ticket') {
    const user = await getUserById(c.env.DB, jwt.sub);
    if (user) return user.id;
  }

  // Fall back to API key check
  const keyHash = await sha256Hex(bearerToken);
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
  const keyHash = await sha256Hex(rawKey);
  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO api_keys (id, user_id, key_hash, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(randomHex(16), userId, keyHash, now)
    .run();

  await logAudit({ userId, action: 'auth.register', ip: c.req.header('CF-Connecting-IP') }, c.env.DB);

  const responseBody = JSON.stringify({ userId, apiKey: rawKey });
  if (idempotencyKey) {
    await recordIdempotency(idempotencyKey, 'anon', 201, responseBody, c.env.DB);
  }
  return c.body(responseBody, 201, { 'Content-Type': 'application/json' });
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

// Platform identity linking is handled exclusively through verified OAuth flows
// (e.g., github-auth.ts). No public endpoint is exposed to prevent identity pre-claiming.

// GET /api/auth/user/me — get authenticated user (Bearer API key or JWT)
authRoutes.get('/user/me', async (c) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const bearerToken = auth.slice(7);

  // Try JWT first (web session tokens) — reject single-use ws-ticket tokens
  const jwt = await verifyJwt(bearerToken, c.env.JWT_SIGNING_KEY);
  if (jwt && typeof jwt.sub === 'string' && jwt.type !== 'ws-ticket') {
    const user = await getUserById(c.env.DB, jwt.sub);
    if (user) return c.json(user);
  }

  // Fall back to API key check
  const keyHash = await sha256Hex(bearerToken);
  const row = await c.env.DB.prepare(
    'SELECT user_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL',
  ).bind(keyHash).first<{ user_id: string }>();
  if (!row) return c.json({ error: 'unauthorized' }, 401);
  const user = await getUserById(c.env.DB, row.user_id);
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
  const keyHash = await sha256Hex(rawKey);
  await c.env.DB.prepare(
    'INSERT INTO api_keys (id, user_id, key_hash, created_at) VALUES (?, ?, ?, ?)',
  ).bind(randomHex(16), userId, keyHash, Date.now()).run();

  await logAudit({ userId, action: 'auth.rotate_key', ip: c.req.header('CF-Connecting-IP') }, c.env.DB);

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

  await logAudit({ userId, action: 'auth.revoke_keys', ip: c.req.header('CF-Connecting-IP') }, c.env.DB);

  return c.json({ ok: true, revokedAt: now });
});

// POST /api/auth/user/me/keys — create a new API key for the authenticated user
authRoutes.post('/user/me/keys', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const label = typeof body.label === 'string' ? body.label : null;

  const rawKey = `deck_${randomHex(32)}`;
  const keyHash = await sha256Hex(rawKey);
  const keyId = randomHex(16);
  const now = Date.now();

  await c.env.DB.prepare(
    'INSERT INTO api_keys (id, user_id, key_hash, label, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(keyId, userId, keyHash, label, now).run();

  await logAudit({ userId, action: 'auth.create_key', ip: c.req.header('CF-Connecting-IP') }, c.env.DB);

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

  await logAudit({ userId, action: 'auth.revoke_key', ip: c.req.header('CF-Connecting-IP') }, c.env.DB);

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

  const jti = randomHex(16);
  const ticket = await signJwt(
    { sub: userId, type: 'ws-ticket', sid: parsed.data.serverId, jti },
    c.env.JWT_SIGNING_KEY,
    15, // 15 seconds
  );

  return c.json({ ticket });
});

// POST /api/auth/refresh — refresh JWT access token
const refreshSchema = z.object({ refreshToken: z.string() });

authRoutes.post('/refresh', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';

  // Check lockout before attempting auth
  const lockout = await checkAuthLockout(ip, c.env);
  if (lockout.locked) {
    return c.json({ error: 'too_many_attempts', retryAfterMs: lockout.lockedUntil ? lockout.lockedUntil - Date.now() : 0 }, 429);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = refreshSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { refreshToken } = parsed.data;
  const tokenHash = await sha256Hex(refreshToken);

  const row = await c.env.DB.prepare(
    'SELECT * FROM refresh_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
  )
    .bind(tokenHash, Date.now())
    .first<{ id: string; user_id: string; family_id: string }>();

  if (!row) {
    await recordAuthFailure(ip, c.env);
    return c.json({ error: 'invalid_token' }, 401);
  }

  // Mark old token consumed (rotation)
  await c.env.DB.prepare('UPDATE refresh_tokens SET used_at = ? WHERE id = ?').bind(Date.now(), row.id).run();

  // Issue new access + refresh tokens
  const accessToken = await signJwt({ sub: row.user_id }, c.env.JWT_SIGNING_KEY, 15 * 60);
  const newRefresh = randomHex(32);
  const newRefreshHash = await sha256Hex(newRefresh);
  const newRefreshId = randomHex(16);
  await c.env.DB.prepare(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(newRefreshId, row.user_id, newRefreshHash, row.family_id, Date.now() + 30 * 24 * 3600 * 1000, Date.now())
    .run();

  return c.json({ accessToken, refreshToken: newRefresh });
});
