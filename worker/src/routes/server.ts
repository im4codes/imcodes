import { Hono } from 'hono';
import type { Env } from '../types.js';
import { getServerById, getServersByUserId, updateServerHeartbeat, upsertChannelBinding } from '../db/queries.js';
import { sha256Hex, randomHex, verifyJwt } from '../security/crypto.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';
import { z } from 'zod';

export const serverRoutes = new Hono<{ Bindings: Env }>();

// GET /api/server — list all servers accessible to the authenticated user
serverRoutes.get('/', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const dbServers = await getServersByUserId(c.env.DB, userId);

  const servers = dbServers.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    lastHeartbeatAt: s.last_heartbeat_at,
    createdAt: s.created_at,
  }));

  return c.json({ servers });
});

// GET /api/server/:id/terminal — browser WebSocket endpoint, auth via ?ticket= (ws-ticket JWT)
serverRoutes.get('/:id/terminal', async (c) => {
  const serverId = c.req.param('id');
  const ticket = c.req.query('ticket');

  if (!ticket) return c.json({ error: 'missing_ticket' }, 401);

  // Verify ticket JWT
  const payload = await verifyJwt(ticket, c.env.JWT_SIGNING_KEY);
  if (!payload) return c.json({ error: 'invalid_ticket' }, 401);
  if (payload.type !== 'ws-ticket') return c.json({ error: 'wrong_token_type' }, 401);
  if (payload.sid !== serverId) return c.json({ error: 'sid_mismatch' }, 401);

  // Enforce single-use via jti consumption in RateLimiter DO
  const jti = payload.jti as string;
  if (!jti) return c.json({ error: 'missing_jti' }, 401);

  const rateLimiterId = c.env.RATE_LIMITER.idFromName(`jti:${jti}`);
  const rateLimiterStub = c.env.RATE_LIMITER.get(rateLimiterId);
  const jtiRes = await rateLimiterStub.fetch(new Request('https://dummy/jti-consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jti }),
  }));
  const jtiResult = await jtiRes.json() as { consumed: boolean };
  if (jtiResult.consumed) return c.json({ error: 'ticket_already_used' }, 401);

  // Check server exists and user has access
  const server = await getServerById(c.env.DB, serverId);
  if (!server) return c.json({ error: 'not_found' }, 404);

  const userId = payload.sub as string;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  // Proxy to DaemonBridge browser socket
  const doId = c.env.DAEMON_BRIDGE.idFromName(serverId);
  const stub = c.env.DAEMON_BRIDGE.get(doId);
  const url = new URL(c.req.url);
  url.pathname = '/browser';
  return stub.fetch(new Request(url.toString(), c.req.raw));
});

// GET /api/server/:id/ws — upgrade to WebSocket, proxy to DaemonBridge DO
serverRoutes.get('/:id/ws', async (c) => {
  const serverId = c.req.param('id');
  const server = await getServerById(c.env.DB, serverId);
  if (!server) return c.json({ error: 'not_found' }, 404);

  const id = c.env.DAEMON_BRIDGE.idFromName(serverId);
  const stub = c.env.DAEMON_BRIDGE.get(id);
  const url = new URL(c.req.url);
  url.pathname = '/daemon';
  return stub.fetch(new Request(url, c.req.raw));
});

// POST /api/server/:id/heartbeat
serverRoutes.post('/:id/heartbeat', async (c) => {
  const serverId = c.req.param('id');
  const server = await getServerById(c.env.DB, serverId);
  if (!server) return c.json({ error: 'not_found' }, 404);
  await updateServerHeartbeat(c.env.DB, serverId);
  return c.json({ ok: true });
});

/**
 * POST /api/server/:id/bindings — persist a channel binding from the daemon.
 * Authenticated via Bearer server token. The token identifies the server (and thus the owner user).
 * Body: { platform, channelId, botId, bindingType, target }
 *
 * This is the write path that makes inbound webhook routing deterministic.
 * The daemon calls this after processing a /bind command from a user in chat.
 */
serverRoutes.post('/:id/bindings', async (c) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const token = auth.slice(7);

  const tokenHash = await sha256Hex(token);
  const serverRow = await c.env.DB.prepare(
    'SELECT id, user_id FROM servers WHERE token_hash = ? AND id = ?',
  ).bind(tokenHash, c.req.param('id')).first<{ id: string; user_id: string }>();

  if (!serverRow) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    platform: z.string(),
    channelId: z.string(),
    botId: z.string(),
    bindingType: z.string(),
    target: z.string(),
  }).safeParse(body);

  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { platform, channelId, botId, bindingType, target } = parsed.data;
  const id = randomHex(16);
  await upsertChannelBinding(c.env.DB, id, serverRow.id, platform, channelId, bindingType, target, botId);

  return c.json({ ok: true });
});

/**
 * DELETE /api/server/:id/bindings — remove a channel binding.
 * Body: { platform, channelId, botId }
 */
serverRoutes.delete('/:id/bindings', async (c) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const token = auth.slice(7);

  const tokenHash = await sha256Hex(token);
  const serverRow = await c.env.DB.prepare(
    'SELECT id FROM servers WHERE token_hash = ? AND id = ?',
  ).bind(tokenHash, c.req.param('id')).first<{ id: string }>();

  if (!serverRow) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ platform: z.string(), channelId: z.string(), botId: z.string() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { platform, channelId, botId } = parsed.data;
  // Scope to server_id to prevent cross-server deletion races
  await c.env.DB.prepare(
    'DELETE FROM channel_bindings WHERE platform = ? AND channel_id = ? AND bot_id = ? AND server_id = ?',
  ).bind(platform, channelId, botId, serverRow.id).run();

  return c.json({ ok: true });
});
