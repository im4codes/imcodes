import { Hono } from 'hono';
import type { Env } from '../types.js';
import { getServerById } from '../db/queries.js';
import { requireAuth, checkServerTeamAccess } from '../security/authorization.js';
import logger from '../util/logger.js';

export const terminalRoutes = new Hono<{ Bindings: Env }>();

// All terminal routes require authentication
terminalRoutes.use('/*', requireAuth());

/**
 * GET /api/server/:id/terminal/:session/ws
 * WebSocket relay for terminal streams: browser ↔ DaemonBridge ↔ daemon's TerminalStreamer.
 *
 * The browser connects here; the worker upgrades and proxies to DaemonBridge DO,
 * which in turn forwards to the daemon's /terminal WebSocket endpoint.
 *
 * Requires authenticated user with server access (member or above).
 */
terminalRoutes.get('/:id/terminal/:session/ws', async (c) => {
  const userId = c.get('userId' as never) as string;
  const hasAccess = await checkServerTeamAccess(c, c.req.param('id'), userId);
  if (!hasAccess) return c.json({ error: 'forbidden' }, 403);
  const serverId = c.req.param('id');
  const sessionName = c.req.param('session');

  const server = await getServerById(c.env.DB, serverId);
  if (!server) return c.json({ error: 'not_found' }, 404);

  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'websocket_required' }, 426);
  }

  // Proxy to DaemonBridge, passing session name as a query param
  const doId = c.env.DAEMON_BRIDGE.idFromName(serverId);
  const stub = c.env.DAEMON_BRIDGE.get(doId);

  const url = new URL(c.req.url);
  url.pathname = '/terminal';
  url.searchParams.set('session', sessionName);

  logger.debug({ serverId, sessionName }, 'Proxying terminal WS to DaemonBridge');
  return stub.fetch(new Request(url.toString(), c.req.raw));
});
