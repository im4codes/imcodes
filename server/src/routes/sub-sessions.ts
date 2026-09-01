import { Hono, type Context } from 'hono';
import type { Env } from '../env.js';
import {
  getSubSessionsByServer,
  getSubSessionById,
  createSubSession,
  updateSubSession,
  deleteSubSession,
  reorderSubSessions,
} from '../db/queries.js';
import { requireAuth } from '../security/authorization.js';
import {
  resolveHttpShareAccess,
  resolveHttpShareAccessForCoveredSession,
  resolveServerMemberAccessOrShareDeny,
} from './share-http-auth.js';
import { WsBridge } from '../ws/bridge.js';
import logger from '../util/logger.js';
import { isSessionAgentType } from '../../../shared/agent-types.js';
import { DAEMON_COMMAND_TYPES } from '../../../shared/daemon-command-types.js';
import { isKnownTestSessionLike } from '../../../shared/test-session-guard.js';
import {
  extractSessionSupervisionSnapshot,
  hasInvalidSessionSupervisionSnapshot,
  SUPERVISION_MODE,
} from '../../../shared/supervision-config.js';

export const subSessionRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();
type SubSessionRouteContext = Context<{ Bindings: Env; Variables: { userId: string; role: string } }>;

subSessionRoutes.use('/*', requireAuth());

async function resolveSubSessionRouteAccess(c: SubSessionRouteContext, serverId: string, userId: string) {
  const access = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  if (!access.ok) return { ok: false as const, response: c.json({ error: 'forbidden', reason: access.reason }, 403) };
  return { ok: true as const, role: access.role };
}

/** GET /api/server/:id/sub-sessions — list active sub-sessions */
subSessionRoutes.get('/:id/sub-sessions', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const member = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  if (!member.ok && member.reason !== 'share-direct-surface-denied') {
    return c.json({ error: 'forbidden', reason: member.reason }, 403);
  }
  // Normal sub-session listing surface: execution clones are excluded (default)
  // so ephemeral clone workers never clutter the normal sub-session list.
  const subSessions = (await getSubSessionsByServer(c.env.DB, serverId, { includeExecutionClones: false })) ?? [];
  if (member.ok) return c.json({ subSessions });
  const visible = (await Promise.all(subSessions.map(async (sub) => {
    const access = await resolveHttpShareAccessForCoveredSession(c.env.DB, {
      serverId,
      userId,
      target: { kind: 'subsession', serverId, subSessionId: sub.id },
    });
    return access.actor.kind === 'share' ? sub : null;
  }))).filter((sub): sub is NonNullable<typeof sub> => sub !== null);
  return c.json({ subSessions: visible });
});

/** POST /api/server/:id/sub-sessions — create sub-session */
subSessionRoutes.post('/:id/sub-sessions', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
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
  if (isKnownTestSessionLike({
    cwd: body.cwd ?? null,
    parentSession: body.parent_session ?? null,
  })) {
    return c.json({ error: 'test_session_blocked' }, 400);
  }
  const parentSession = typeof body.parent_session === 'string' ? body.parent_session.trim() : '';
  const member = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  const memberMayCreate = member.ok && (member.role === 'owner' || member.role === 'admin');
  const access = !member.ok && parentSession
    ? await resolveHttpShareAccess(c.env.DB, {
      serverId,
      userId,
      target: { kind: 'main', serverId, sessionName: parentSession },
    })
    : null;
  const mayCreate = memberMayCreate
    || (access?.actor.kind === 'share' && access.actor.effectiveActorRole === 'participant');
  if (!mayCreate) {
    const reason = access?.actor.kind === 'share' ? 'share-role-denied' : (member.ok ? 'share-role-denied' : member.reason);
    return c.json({ error: 'forbidden', reason }, 403);
  }
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
    parentSession || null,
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
  const access = await resolveSubSessionRouteAccess(c, serverId, userId);
  if (!access.ok) return access.response;
  const role = access.role;
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
  const member = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  const memberMayUpdate = member.ok && (member.role === 'owner' || member.role === 'admin');
  const access = !member.ok
    ? await resolveHttpShareAccessForCoveredSession(c.env.DB, {
      serverId,
      userId,
      target: { kind: 'subsession', serverId, subSessionId: subId },
    })
    : null;
  const mayUpdate = memberMayUpdate
    || (access?.actor.kind === 'share' && access.actor.effectiveActorRole === 'participant');
  if (!mayUpdate) {
    const reason = access?.actor.kind === 'share' ? 'share-role-denied' : (member.ok ? 'share-role-denied' : member.reason);
    return c.json({ error: 'forbidden', reason }, 403);
  }
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
  if ('closedAt' in body) {
    return c.json({ error: 'closed_at_managed_by_daemon' }, 400);
  }
  if ('label' in body) fields.label = body.label ?? null;
  if ('description' in body) fields.description = body.description ?? null;
  if ('cwd' in body) fields.cwd = body.cwd ?? null;
  if ('ccPresetId' in body) fields.cc_preset_id = body.ccPresetId ?? null;
  if ('requestedModel' in body) fields.requested_model = body.requestedModel ?? null;
  if ('activeModel' in body) fields.active_model = body.activeModel ?? null;
  if ('effort' in body) fields.effort = body.effort ?? null;
  if ('transportConfig' in body) fields.transport_config = body.transportConfig ?? null;
  if (hasInvalidSessionSupervisionSnapshot(body.transportConfig ?? null)) {
    return c.json({ error: 'invalid_supervision_config' }, 400);
  }
  const requestedSupervision = extractSessionSupervisionSnapshot(body.transportConfig ?? null);
  if (requestedSupervision && requestedSupervision.mode !== SUPERVISION_MODE.OFF) {
    return c.json({ error: 'forbidden', reason: 'brain_session_required' }, 403);
  }

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
  if (body.type == null && body.label !== undefined) {
    try {
      WsBridge.get(serverId).sendToDaemon(JSON.stringify({
        type: 'subsession.rename',
        sessionName: `deck_sub_${subId}`,
        label: body.label ?? null,
      }));
    } catch (err) {
      logger.error({ serverId, subId, err }, 'WsBridge sub-session rename relay failed');
      return c.json({ error: 'relay_failed' }, 502);
    }
  }
  if (body.type == null && body.transportConfig !== undefined) {
    try {
      WsBridge.get(serverId).sendToDaemon(JSON.stringify({
        type: DAEMON_COMMAND_TYPES.SUBSESSION_UPDATE_TRANSPORT_CONFIG,
        sessionName: `deck_sub_${subId}`,
        transportConfig: body.transportConfig ?? null,
      }));
    } catch (err) {
      logger.error({ serverId, subId, err }, 'WsBridge sub-session transportConfig relay failed');
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
  const access = await resolveSubSessionRouteAccess(c, serverId, userId);
  if (!access.ok) return access.response;
  const role = access.role;
  if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403);

  await deleteSubSession(c.env.DB, subId, serverId);
  void WsBridge.get(serverId).revalidateShareSocketsForTarget({ kind: 'subsession', serverId, subSessionId: subId });
  return c.json({ ok: true });
});
