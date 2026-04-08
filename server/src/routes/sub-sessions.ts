import { Hono } from 'hono';
import type { Env } from '../env.js';
import {
  getSubSessionsByServer,
  getSubSessionById,
  createSubSession,
  updateSubSession,
  deleteSubSession,
  reorderSubSessions,
} from '../db/queries.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';
import { WsBridge } from '../ws/bridge.js';
import logger from '../util/logger.js';
import { isSessionAgentType } from '../../../shared/agent-types.js';

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

  let body: {
    type?: string;
    shellBin?: string;
    cwd?: string;
    label?: string;
    cc_session_id?: string;
    gemini_session_id?: string;
    parent_session?: string;
    description?: string;
    cc_preset_id?: string;
    requested_model?: string | null;
    active_model?: string | null;
    effort?: string | null;
    transport_config?: Record<string, unknown> | null;
  };
  try {
    body = await c.req.json() as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  if (!body.type) return c.json({ error: 'missing_fields' }, 400);
  if (!isSessionAgentType(body.type)) return c.json({ error: 'invalid_type' }, 400);

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
    null, null, null,
    body.description ?? null,
    body.cc_preset_id ?? null,
    body.requested_model ?? null,
    body.active_model ?? null,
    body.effort ?? null,
    body.transport_config ?? null,
  );

  const sessionName = `deck_sub_${id}`;
  return c.json({ id: sub.id, sessionName, subSession: sub }, 201);
});

/** PATCH /api/server/:id/sub-sessions/reorder — set sort_order for all sub-sessions (must be before :subId route) */
subSessionRoutes.patch('/:id/sub-sessions/reorder', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403);

  let body: { ids: string[] };
  try {
    body = await c.req.json() as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  if (!Array.isArray(body.ids) || body.ids.length === 0) return c.json({ error: 'ids required' }, 400);

  await reorderSubSessions(c.env.DB, serverId, body.ids);
  return c.json({ ok: true });
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

  let body: {
    type?: string | null;
    label?: string | null;
    closedAt?: number | null;
    description?: string | null;
    cwd?: string | null;
    ccPresetId?: string | null;
    requestedModel?: string | null;
    activeModel?: string | null;
    effort?: string | null;
    transportConfig?: Record<string, unknown> | null;
  };
  try {
    body = await c.req.json() as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const fields: {
    label?: string | null;
    closed_at?: number | null;
    description?: string | null;
    cwd?: string | null;
    cc_preset_id?: string | null;
    requested_model?: string | null;
    active_model?: string | null;
    effort?: string | null;
    transport_config?: Record<string, unknown> | null;
  } = {};
  if ('type' in body && body.type != null) {
    if (typeof body.type !== 'string' || !isSessionAgentType(body.type)) {
      return c.json({ error: 'invalid_agent_type' }, 400);
    }
  }
  if ('label' in body) fields.label = body.label ?? null;
  if ('closedAt' in body) fields.closed_at = body.closedAt ?? null;
  if ('description' in body) fields.description = body.description ?? null;
  if ('cwd' in body) fields.cwd = body.cwd ?? null;
  if ('ccPresetId' in body) fields.cc_preset_id = body.ccPresetId ?? null;
  if ('requestedModel' in body) fields.requested_model = body.requestedModel ?? null;
  if ('activeModel' in body) fields.active_model = body.activeModel ?? null;
  if ('effort' in body) fields.effort = body.effort ?? null;
  if ('transportConfig' in body) fields.transport_config = body.transportConfig ?? null;

  await updateSubSession(c.env.DB, subId, serverId, fields);

  if (typeof body.type === 'string') {
    try {
      WsBridge.get(serverId).sendToDaemon(JSON.stringify({
        type: 'subsession.restart',
        sessionName: `deck_sub_${subId}`,
        agentType: body.type,
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
        ...(body.requestedModel !== undefined ? { requestedModel: body.requestedModel } : {}),
        ...(body.activeModel !== undefined ? { activeModel: body.activeModel } : {}),
        ...(body.effort !== undefined ? { effort: body.effort } : {}),
        ...(body.transportConfig !== undefined ? { transportConfig: body.transportConfig } : {}),
      }));
    } catch (err) {
      logger.error({ serverId, subId, err }, 'WsBridge sub-session settings relay failed');
      return c.json({ error: 'relay_failed' }, 502);
    }
  }
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
