import { Hono } from 'hono';
import type { Env } from '../env.js';
import { getServersByUserId, updateServerHeartbeat, updateServerName, deleteServer, upsertChannelBinding } from '../db/queries.js';
import { WsBridge } from '../ws/bridge.js';
import { sha256Hex, randomHex } from '../security/crypto.js';
import { requireAuth } from '../security/authorization.js';
import { z } from 'zod';

export const serverRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

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

// PATCH /api/server/:id/name — rename a server (authenticated user must own the server)
serverRoutes.patch('/:id/name', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ name: z.string().min(1).max(64) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const updated = await updateServerName(c.env.DB, serverId, userId, parsed.data.name.trim());
  if (!updated) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// DELETE /api/server/:id — delete a server (user must own it); notifies daemon to self-destruct first
serverRoutes.delete('/:id', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id') ?? '';

  // Notify daemon to self-destruct (best-effort — daemon may be offline)
  try {
    WsBridge.get(serverId).sendToDaemon(JSON.stringify({ type: 'server.delete' }));
  } catch { /* daemon may be offline, continue with DB deletion */ }

  const deleted = await deleteServer(c.env.DB, serverId, userId);
  if (!deleted) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// POST /api/server/:id/upgrade — tell daemon to upgrade itself and restart
serverRoutes.post('/:id/upgrade', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id') ?? '';
  const dbServers = await getServersByUserId(c.env.DB, userId);
  if (!dbServers.find((s) => s.id === serverId)) return c.json({ error: 'not_found' }, 404);
  try {
    WsBridge.get(serverId).sendToDaemon(JSON.stringify({ type: 'daemon.upgrade' }));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'daemon_offline' }, 503);
  }
});

// POST /api/server/:id/heartbeat — authenticated via Bearer server token
serverRoutes.post('/:id/heartbeat', async (c) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const token = auth.slice(7);
  const tokenHash = sha256Hex(token);

  const serverId = c.req.param('id');
  const server = await c.env.DB.prepare(
    'SELECT id FROM servers WHERE id = ? AND token_hash = ?',
  ).bind(serverId, tokenHash).first<{ id: string }>();
  if (!server) return c.json({ error: 'unauthorized' }, 401);

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

  const tokenHash = sha256Hex(token);
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

  const tokenHash = sha256Hex(token);
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
