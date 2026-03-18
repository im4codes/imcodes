import { Hono } from 'hono';
import type { Env } from '../env.js';
import { getServerById } from '../db/queries.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';
import logger from '../util/logger.js';

export const terminalRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

// All terminal routes require authentication
terminalRoutes.use('/*', requireAuth());

/**
 * GET /api/server/:id/terminal/:session/ws
 * WebSocket relay for terminal streams: browser ↔ WsBridge ↔ daemon's TerminalStreamer.
 *
 * The browser connects here; the server upgrades and proxies to WsBridge,
 * which in turn forwards to the daemon's /terminal WebSocket endpoint.
 *
 * Requires authenticated user with server access (member or above).
 *
 * Note: Actual WebSocket upgrade is handled at the server entry point.
 * This route returns 426 if not a WebSocket upgrade.
 */
terminalRoutes.get('/:id/terminal/:session/ws', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id');
  const sessionName = c.req.param('session');

  const server = await getServerById(c.env.DB, serverId);
  if (!server) return c.json({ error: 'not_found' }, 404);

  // Check access: server must belong to this user (direct or via team)
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'websocket_required' }, 426);
  }

  // WebSocket upgrade is handled in the server entry point (ws/ module).
  // This route should not be reached for actual WS connections.
  logger.debug({ serverId, sessionName }, 'Terminal WS route reached — upgrade handled upstream');
  return c.json({ error: 'internal_error' }, 500);
});
