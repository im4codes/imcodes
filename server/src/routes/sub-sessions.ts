import { Hono } from 'hono';
import type { Env } from '../env.js';
import {
  getSubSessionsByServer,
  getSubSessionById,
  createSubSession,
  updateSubSession,
  deleteSubSession,
} from '../db/queries.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';

export const subSessionRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

subSessionRoutes.use('/*', requireAuth());

/** GET /api/server/:id/sub-sessions — list active sub-sessions */
subSessionRoutes.get('/:id/sub-sessions', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const subSessions = await getSubSessionsByServer(c.env.DB, serverId);
  return c.json({ subSessions });
});

/** POST /api/server/:id/sub-sessions — create sub-session */
subSessionRoutes.post('/:id/sub-sessions', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403);

  let body: { type?: string; shellBin?: string; cwd?: string; label?: string; cc_session_id?: string; gemini_session_id?: string; parent_session?: string };
  try {
    body = await c.req.json() as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  if (!body.type) return c.json({ error: 'missing_fields' }, 400);
  const validTypes = ['claude-code', 'codex', 'opencode', 'shell', 'gemini'];
  if (!validTypes.includes(body.type)) return c.json({ error: 'invalid_type' }, 400);

  // Generate 8-char id
  const id = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 8);

  const sub = await createSubSession(
    c.env.DB,
    id,
    serverId,
    body.type,
    body.shellBin ?? null,
    body.cwd ?? null,
    body.label ?? null,
    body.cc_session_id ?? null,
    body.gemini_session_id ?? null,
    body.parent_session ?? null,
  );

  const sessionName = `deck_sub_${id}`;
  return c.json({ id: sub.id, sessionName, subSession: sub }, 201);
});

/** PATCH /api/server/:id/sub-sessions/:subId — update label or close */
subSessionRoutes.patch('/:id/sub-sessions/:subId', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const subId = c.req.param('subId')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403);

  const existing = await getSubSessionById(c.env.DB, subId, serverId);
  if (!existing) return c.json({ error: 'not_found' }, 404);

  let body: { label?: string | null; closedAt?: number | null };
  try {
    body = await c.req.json() as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const fields: { label?: string | null; closed_at?: number | null } = {};
  if ('label' in body) fields.label = body.label ?? null;
  if ('closedAt' in body) fields.closed_at = body.closedAt ?? null;

  await updateSubSession(c.env.DB, subId, serverId, fields);
  return c.json({ ok: true });
});

/** DELETE /api/server/:id/sub-sessions/:subId — hard delete */
subSessionRoutes.delete('/:id/sub-sessions/:subId', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const subId = c.req.param('subId')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403);

  await deleteSubSession(c.env.DB, subId, serverId);
  return c.json({ ok: true });
});
