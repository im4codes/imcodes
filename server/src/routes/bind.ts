import { Hono } from 'hono';
import type { Env } from '../env.js';
import { randomHex, sha256Hex } from '../security/crypto.js';
import { createServer, getServerById, updateServerToken } from '../db/queries.js';
import { logAudit } from '../security/audit.js';
import { requireAuth } from '../security/authorization.js';
import { WsBridge } from '../ws/bridge.js';
import { z } from 'zod';

export const bindRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

const BIND_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// POST /api/bind/initiate — user starts bind flow, gets a short code
bindRoutes.post('/initiate', requireAuth(), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ serverName: z.string() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const userId = c.get('userId' as never) as string;
  const { serverName } = parsed.data;
  const code = randomHex(4).toUpperCase(); // 8-char hex code
  const expiresAt = Date.now() + BIND_CODE_TTL_MS;

  await c.env.DB.prepare(
    'INSERT INTO pending_binds (code, user_id, server_name, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(code, userId, serverName, expiresAt, Date.now())
    .run();

  return c.json({ code, expiresAt });
});

// POST /api/bind/confirm — daemon confirms the bind code and receives auth token
bindRoutes.post('/confirm', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ code: z.string() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { code } = parsed.data;
  const pending = await c.env.DB.prepare(
    'SELECT * FROM pending_binds WHERE code = ? AND expires_at > ?',
  )
    .bind(code, Date.now())
    .first<{ code: string; user_id: string; server_name: string }>();

  if (!pending) return c.json({ error: 'invalid_code' }, 404);

  // Generate daemon auth token
  const rawToken = randomHex(32);
  const tokenHash = sha256Hex(rawToken);

  const serverId = randomHex(16);
  await createServer(c.env.DB, serverId, pending.user_id, pending.server_name, tokenHash);

  // Consume the bind code
  await c.env.DB.prepare('DELETE FROM pending_binds WHERE code = ?').bind(code).run();

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAudit({ userId: pending.user_id, action: 'bind.confirm', ip, details: { serverId } }, c.env.DB);

  return c.json({ serverId, token: rawToken });
});

// POST /api/bind/direct — single-step bind for web-authenticated users (API key already in hand)
bindRoutes.post('/direct', requireAuth(), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ serverName: z.string().min(1).max(64) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const userId = c.get('userId' as never) as string;
  const keyId = c.get('keyId' as never) as string | undefined;
  const { serverName } = parsed.data;

  const rawToken = randomHex(32);
  const tokenHash = sha256Hex(rawToken);
  const serverId = randomHex(16);

  await createServer(c.env.DB, serverId, userId, serverName, tokenHash, keyId);

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAudit({ userId, action: 'bind.direct', ip, details: { serverId } }, c.env.DB);

  return c.json({ serverId, token: rawToken, serverName }, 201);
});

// POST /api/bind/rebind — replace token for an existing server (--force re-bind)
// Authenticated via Bearer API key (same as /direct). Requires serverId to match the caller's user.
bindRoutes.post('/rebind', requireAuth(), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ serverId: z.string(), serverName: z.string().min(1).max(64) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const userId = c.get('userId' as never) as string;
  const keyId = c.get('keyId' as never) as string | undefined;
  const { serverId, serverName } = parsed.data;

  const rawToken = randomHex(32);
  const tokenHash = sha256Hex(rawToken);

  const updated = await updateServerToken(c.env.DB, serverId, userId, tokenHash, serverName, keyId);
  if (!updated) return c.json({ error: 'not_found' }, 404);

  // Evict the existing daemon WebSocket so it must reconnect with the new token
  try { WsBridge.get(serverId).kickDaemon(); } catch { /* bridge may not exist yet */ }

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAudit({ userId, action: 'bind.rebind', ip, details: { serverId } }, c.env.DB);

  return c.json({ token: rawToken });
});

// POST /api/bind/verify — verify a daemon auth token
bindRoutes.post('/verify', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ serverId: z.string(), token: z.string() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { serverId, token } = parsed.data;
  const server = await getServerById(c.env.DB, serverId);
  if (!server) return c.json({ error: 'not_found' }, 404);

  const tokenHash = sha256Hex(token);
  if (tokenHash !== server.token_hash) return c.json({ error: 'invalid_token' }, 401);

  return c.json({ ok: true, serverId, userId: server.user_id });
});
