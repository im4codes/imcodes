/**
 * Server routes for project management.
 * These relay project config operations to the daemon via WsBridge.
 */
import { Hono, type Context } from 'hono';
import type { Env } from '../env.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';
import { getServerById } from '../db/queries.js';
import { WsBridge } from '../ws/bridge.js';
import logger from '../util/logger.js';

export const projectRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

// ── Project CRUD ──────────────────────────────────────────────────────────────

// GET /api/server/:id/projects — list projects
projectRoutes.get('/:id/projects', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;

  const server = await getServerById(c.env.DB, serverId);
  if (!server) return c.json({ error: 'not_found' }, 404);

  const hasAccess = await (await resolveServerRole(c.env.DB, serverId, userId)) !== 'none';
  if (!hasAccess) return c.json({ error: 'forbidden' }, 403);

  return relayToDaemon(c, serverId, 'GET', '/projects');
});

// POST /api/server/:id/projects — add project
projectRoutes.post('/:id/projects', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;

  const server = await getServerById(c.env.DB, serverId);
  if (!server) return c.json({ error: 'not_found' }, 404);

  const hasAccess = await (await resolveServerRole(c.env.DB, serverId, userId)) !== 'none';
  if (!hasAccess) return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'invalid_body' }, 400);

  return relayToDaemon(c, serverId, 'POST', '/projects', body);
});

// PUT /api/server/:id/projects/:name — update project settings
projectRoutes.put('/:id/projects/:name', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const projectName = c.req.param('name')!;

  const hasAccess = await (await resolveServerRole(c.env.DB, serverId, userId)) !== 'none';
  if (!hasAccess) return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'invalid_body' }, 400);

  return relayToDaemon(c, serverId, 'PUT', `/projects/${encodeURIComponent(projectName)}`, body);
});

// GET /api/server/:id/projects/:name — get single project
projectRoutes.get('/:id/projects/:name', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const projectName = c.req.param('name')!;

  const hasAccess = await (await resolveServerRole(c.env.DB, serverId, userId)) !== 'none';
  if (!hasAccess) return c.json({ error: 'forbidden' }, 403);

  return relayToDaemon(c, serverId, 'GET', `/projects/${encodeURIComponent(projectName)}`);
});

// ── Auto-fix pipeline ─────────────────────────────────────────────────────────

// POST /api/server/:id/projects/:name/autofix — start auto-fix
projectRoutes.post('/:id/projects/:name/autofix', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const projectName = c.req.param('name')!;

  const hasAccess = await (await resolveServerRole(c.env.DB, serverId, userId)) !== 'none';
  if (!hasAccess) return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json().catch(() => null);
  return relayToDaemon(c, serverId, 'POST', `/projects/${encodeURIComponent(projectName)}/autofix`, body ?? {});
});

// DELETE /api/server/:id/projects/:name/autofix — stop auto-fix
projectRoutes.delete('/:id/projects/:name/autofix', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const projectName = c.req.param('name')!;

  const hasAccess = await (await resolveServerRole(c.env.DB, serverId, userId)) !== 'none';
  if (!hasAccess) return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json().catch(() => ({}));
  return relayToDaemon(c, serverId, 'DELETE', `/projects/${encodeURIComponent(projectName)}/autofix`, body);
});

// ── Tracker proxy ─────────────────────────────────────────────────────────────

// GET /api/server/:id/projects/:name/issues — proxy tracker API
projectRoutes.get('/:id/projects/:name/issues', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const projectName = c.req.param('name')!;

  const hasAccess = await (await resolveServerRole(c.env.DB, serverId, userId)) !== 'none';
  if (!hasAccess) return c.json({ error: 'forbidden' }, 403);

  return relayToDaemon(c, serverId, 'GET', `/projects/${encodeURIComponent(projectName)}/issues`);
});

// POST /api/server/:id/tracker/validate — validate tracker connection (for AddProject form)
projectRoutes.post('/:id/tracker/validate', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;

  const hasAccess = await (await resolveServerRole(c.env.DB, serverId, userId)) !== 'none';
  if (!hasAccess) return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'invalid_body' }, 400);

  return relayToDaemon(c, serverId, 'POST', '/tracker/validate', body);
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function relayToDaemon(
  c: Context<{ Bindings: Env; Variables: { userId: string; role: string } }>,
  serverId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  try {
    WsBridge.get(serverId).sendToDaemon(JSON.stringify({
      type: 'http.relay',
      method,
      path,
      body,
    }));
  } catch (err) {
    logger.error({ serverId, method, path, err }, 'WsBridge relay failed');
    return c.json({ error: 'relay_failed' }, 502);
  }

  // For relay operations, return ok immediately (fire-and-forget style).
  // Response data from daemon is delivered via WebSocket to browser clients.
  return c.json({ ok: true });
}
