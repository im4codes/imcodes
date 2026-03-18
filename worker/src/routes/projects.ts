/**
 * CF Worker routes for project management.
 * These relay project config operations to the daemon and proxy tracker API calls.
 */
import { Hono, type Context } from 'hono';
import type { Env } from '../types.js';
import { requireAuth, checkServerTeamAccess } from '../security/authorization.js';
import { getServerById } from '../db/queries.js';
import logger from '../util/logger.js';

export const projectRoutes = new Hono<{ Bindings: Env }>();

// ── Project CRUD ──────────────────────────────────────────────────────────────

// GET /api/server/:id/projects — list projects
projectRoutes.get('/:id/projects', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;

  const server = await getServerById(c.env.DB, serverId);
  if (!server) return c.json({ error: 'not_found' }, 404);

  const hasAccess = await checkServerTeamAccess(c, serverId, userId);
  if (!hasAccess) return c.json({ error: 'forbidden' }, 403);

  return relayToDaemon(c, serverId, 'GET', '/projects');
});

// POST /api/server/:id/projects — add project
projectRoutes.post('/:id/projects', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;

  const server = await getServerById(c.env.DB, serverId);
  if (!server) return c.json({ error: 'not_found' }, 404);

  const hasAccess = await checkServerTeamAccess(c, serverId, userId);
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

  const hasAccess = await checkServerTeamAccess(c, serverId, userId);
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

  const hasAccess = await checkServerTeamAccess(c, serverId, userId);
  if (!hasAccess) return c.json({ error: 'forbidden' }, 403);

  return relayToDaemon(c, serverId, 'GET', `/projects/${encodeURIComponent(projectName)}`);
});

// ── Auto-fix pipeline ─────────────────────────────────────────────────────────

// POST /api/server/:id/projects/:name/autofix — start auto-fix
projectRoutes.post('/:id/projects/:name/autofix', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const projectName = c.req.param('name')!;

  const hasAccess = await checkServerTeamAccess(c, serverId, userId);
  if (!hasAccess) return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json().catch(() => null);
  return relayToDaemon(c, serverId, 'POST', `/projects/${encodeURIComponent(projectName)}/autofix`, body ?? {});
});

// DELETE /api/server/:id/projects/:name/autofix — stop auto-fix
projectRoutes.delete('/:id/projects/:name/autofix', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const projectName = c.req.param('name')!;

  const hasAccess = await checkServerTeamAccess(c, serverId, userId);
  if (!hasAccess) return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json().catch(() => ({}));
  return relayToDaemon(c, serverId, 'DELETE', `/projects/${encodeURIComponent(projectName)}/autofix`, body);
});

// ── Tracker proxy ─────────────────────────────────────────────────────────────

// GET /api/server/:id/projects/:name/issues — proxy tracker API (task 9.20)
projectRoutes.get('/:id/projects/:name/issues', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const projectName = c.req.param('name')!;

  const hasAccess = await checkServerTeamAccess(c, serverId, userId);
  if (!hasAccess) return c.json({ error: 'forbidden' }, 403);

  return relayToDaemon(c, serverId, 'GET', `/projects/${encodeURIComponent(projectName)}/issues`);
});

// POST /api/server/:id/tracker/validate — validate tracker connection (for AddProject form)
projectRoutes.post('/:id/tracker/validate', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;

  const hasAccess = await checkServerTeamAccess(c, serverId, userId);
  if (!hasAccess) return c.json({ error: 'forbidden' }, 403);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'invalid_body' }, 400);

  return relayToDaemon(c, serverId, 'POST', '/tracker/validate', body);
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function relayToDaemon(
  c: Context<{ Bindings: Env }>,
  serverId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const doId = c.env.DAEMON_BRIDGE.idFromName(serverId);
  const stub = c.env.DAEMON_BRIDGE.get(doId);

  const res = await stub.fetch(
    new Request(`https://dummy${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );

  if (!res.ok) {
    const text = await res.text();
    logger.error({ serverId, method, path, status: res.status, text }, 'DaemonBridge relay failed');
    return c.json({ error: 'relay_failed' }, res.status as 502);
  }

  const data = await res.json();
  return c.json(data as object);
}
