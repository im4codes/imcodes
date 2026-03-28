import { Hono, type Context } from 'hono';
import type { Env } from '../env.js';
import { getServerById, getDbSessionsByServer, upsertDbSession, deleteDbSession, updateSessionLabel, updateProjectName, updateSession } from '../db/queries.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';
import { randomHex } from '../security/crypto.js';
import { WsBridge } from '../ws/bridge.js';
import logger from '../util/logger.js';

export const sessionMgmtRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

/**
 * POST /api/server/:id/session/start
 * POST /api/server/:id/session/stop
 * POST /api/server/:id/session/send
 *
 * All commands are relayed to the daemon via WsBridge (JSON over WebSocket).
 * The daemon interprets and executes the session operation locally.
 *
 * Permission model:
 * - start/stop: requires owner | admin
 * - send: requires owner | admin | member
 */

// Apply auth middleware globally to all session routes
sessionMgmtRoutes.use('/*', requireAuth());

// ── Session persistence (daemon syncs these) ───────────────────────────────

/** GET /api/server/:id/sessions — list all sessions for a server (used by daemon on startup) */
sessionMgmtRoutes.get('/:id/sessions', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const all = await getDbSessionsByServer(c.env.DB, serverId);
  const sessions = all.filter((s) => !s.name.startsWith('deck_sub_'));
  return c.json({ sessions });
});

/** PUT /api/server/:id/sessions/:name — upsert a session record (daemon → DB) */
sessionMgmtRoutes.put('/:id/sessions/:name', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const sessionName = c.req.param('name')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403);

  let body: Record<string, string>;
  try {
    body = await c.req.json() as Record<string, string>;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const { projectName, projectRole, agentType, agentVersion, projectDir, state, runtimeType, providerId, providerSessionId, description } = body;
  if (!projectName || !projectRole || !agentType || !projectDir || !state) {
    return c.json({ error: 'missing_fields' }, 400);
  }

  await upsertDbSession(c.env.DB, randomHex(16), serverId, sessionName, projectName, projectRole, agentType, projectDir, state, agentVersion, runtimeType, providerId, providerSessionId, description);
  return c.json({ ok: true });
});

/** PATCH /api/server/:id/sessions/:name/label — update display label (web client) */
sessionMgmtRoutes.patch('/:id/sessions/:name/label', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const sessionName = c.req.param('name')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  let body: { label?: string | null };
  try {
    body = await c.req.json() as { label?: string | null };
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : null;
  await updateSessionLabel(c.env.DB, serverId, sessionName, label);
  return c.json({ ok: true });
});

/** PATCH /api/server/:id/sessions/:name — update session settings (label, description, cwd) */
sessionMgmtRoutes.patch('/:id/sessions/:name', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const sessionName = c.req.param('name')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  let body: { label?: string | null; description?: string | null; cwd?: string | null };
  try {
    body = await c.req.json() as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const fields: { label?: string | null; description?: string | null; project_dir?: string | null } = {};
  if ('label' in body) fields.label = body.label ?? null;
  if ('description' in body) fields.description = body.description ?? null;
  if ('cwd' in body) fields.project_dir = body.cwd ?? null;

  await updateSession(c.env.DB, serverId, sessionName, fields);
  return c.json({ ok: true });
});

/** PATCH /api/server/:id/sessions/:name/rename — update project display name */
sessionMgmtRoutes.patch('/:id/sessions/:name/rename', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const sessionName = c.req.param('name')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  let body: { name?: string };
  try {
    body = await c.req.json() as { name?: string };
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const newName = typeof body.name === 'string' ? body.name.trim() : '';
  if (!newName) return c.json({ error: 'name_required' }, 400);

  await updateProjectName(c.env.DB, serverId, sessionName, newName);
  return c.json({ ok: true });
});

/** DELETE /api/server/:id/sessions/:name — remove a session record (daemon → DB) */
sessionMgmtRoutes.delete('/:id/sessions/:name', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const sessionName = c.req.param('name')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403);

  await deleteDbSession(c.env.DB, serverId, sessionName);
  return c.json({ ok: true });
});

sessionMgmtRoutes.post('/:id/session/start', async (c) => {
  const userId = c.get('userId' as never) as string;
  const role = await resolveServerRole(c.env.DB, c.req.param('id')!, userId);
  if (role !== 'owner' && role !== 'admin') {
    return c.json({ error: 'forbidden', reason: 'start requires admin or owner role' }, 403);
  }
  return relayToDaemon(c, 'session.start');
});

sessionMgmtRoutes.post('/:id/session/stop', async (c) => {
  const userId = c.get('userId' as never) as string;
  const role = await resolveServerRole(c.env.DB, c.req.param('id')!, userId);
  if (role !== 'owner' && role !== 'admin') {
    return c.json({ error: 'forbidden', reason: 'stop requires admin or owner role' }, 403);
  }
  return relayToDaemon(c, 'session.stop');
});

sessionMgmtRoutes.post('/:id/session/send', async (c) => {
  const userId = c.get('userId' as never) as string;
  const role = await resolveServerRole(c.env.DB, c.req.param('id')!, userId);
  if (role === 'none') {
    return c.json({ error: 'forbidden', reason: 'not_authorized_for_server' }, 403);
  }
  return relayToDaemon(c, 'session.send');
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function relayToDaemon(
  c: Context<{ Bindings: Env; Variables: { userId: string; role: string } }>,
  command: string,
) {
  const serverId = c.req.param('id')!;
  const server = await getServerById(c.env.DB, serverId);
  if (!server) return c.json({ error: 'not_found' }, 404);

  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    // body is optional
  }

  const payload = JSON.stringify({ type: command, ...body as object });

  try {
    WsBridge.get(serverId).sendToDaemon(payload);
  } catch (err) {
    logger.error({ serverId, command, err }, 'WsBridge relay failed');
    return c.json({ error: 'relay_failed' }, 502);
  }

  return c.json({ ok: true });
}
