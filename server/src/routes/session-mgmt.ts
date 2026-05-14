import { Hono, type Context } from 'hono';
import type { Env } from '../env.js';
import { getServerById, getDbSessionsByServer, upsertDbSession, deleteDbSession, updateSessionLabel, updateProjectName, updateSession } from '../db/queries.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';
import type { ServerRole } from '../security/authorization.js';
import { randomHex } from '../security/crypto.js';
import { logAudit } from '../security/audit.js';
import { WsBridge } from '../ws/bridge.js';
import logger from '../util/logger.js';
import { IMCODES_POD_HEADER } from '../../../shared/http-header-names.js';
import { getPodIdentity } from '../util/pod-identity.js';
import { isSessionAgentType } from '../../../shared/agent-types.js';
import { DAEMON_COMMAND_TYPES } from '../../../shared/daemon-command-types.js';
import { isKnownTestSessionLike } from '../../../shared/test-session-guard.js';
import { sanitizeProjectName } from '../../../shared/sanitize-project-name.js';
import {
  SESSION_GROUP_CLONE_CAPABILITY_V1,
  SESSION_GROUP_CLONE_MSG,
  mainSessionNameForProjectSlug,
  type SessionGroupCloneErrorCode,
} from '../../../shared/session-group-clone.js';

export const sessionMgmtRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

/**
 * POST /api/server/:id/session/start
 * POST /api/server/:id/session/stop
 * POST /api/server/:id/session/cancel
 * POST /api/server/:id/session/send
 *
 * All commands are relayed to the daemon via WsBridge (JSON over WebSocket).
 * The daemon interprets and executes the session operation locally.
 *
 * Permission model:
 * - start/stop: requires owner | admin
 * - send/cancel: requires owner | admin | member
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

  let body: Record<string, unknown>;
  try {
    body = await c.req.json() as Record<string, string>;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const {
    projectName,
    projectRole,
    agentType,
    agentVersion,
    projectDir,
    state,
    label,
    runtimeType,
    providerId,
    providerSessionId,
    description,
    requestedModel,
    activeModel,
    effort,
    transportConfig,
  } = body;
  if (!projectName || !projectRole || !agentType || !projectDir || !state) {
    return c.json({ error: 'missing_fields' }, 400);
  }
  if (isKnownTestSessionLike({
    name: sessionName,
    projectName: String(projectName),
    projectDir: String(projectDir),
  })) {
    return c.json({ ok: true, ignored: 'test_session' });
  }

  await upsertDbSession(
    c.env.DB,
    randomHex(16),
    serverId,
    sessionName,
    String(projectName),
    String(projectRole),
    String(agentType),
    String(projectDir),
    String(state),
    typeof label === 'string' && label.trim() ? label.trim() : null,
    typeof agentVersion === 'string' ? agentVersion : null,
    typeof runtimeType === 'string' ? runtimeType : null,
    typeof providerId === 'string' ? providerId : null,
    typeof providerSessionId === 'string' ? providerSessionId : null,
    typeof description === 'string' ? description : null,
    typeof requestedModel === 'string' ? requestedModel : null,
    typeof activeModel === 'string' ? activeModel : null,
    typeof effort === 'string' ? effort : null,
    transportConfig && typeof transportConfig === 'object' ? transportConfig as Record<string, unknown> : null,
  );
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
  try {
    WsBridge.get(serverId).sendToDaemon(JSON.stringify({
      type: 'session.relabel',
      sessionName,
      label,
    }));
  } catch (err) {
    logger.warn({ serverId, sessionName, err }, 'WsBridge session relabel relay failed');
  }
  return c.json({ ok: true });
});

/** PATCH /api/server/:id/sessions/:name — update session settings (label, description, cwd) */
sessionMgmtRoutes.patch('/:id/sessions/:name', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const sessionName = c.req.param('name')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  let body: {
    label?: string | null;
    description?: string | null;
    cwd?: string | null;
    agentType?: string | null;
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
    description?: string | null;
    project_dir?: string | null;
    requested_model?: string | null;
    active_model?: string | null;
    effort?: string | null;
    transport_config?: Record<string, unknown> | null;
  } = {};
  if ('agentType' in body && body.agentType != null) {
    if (typeof body.agentType !== 'string' || !isSessionAgentType(body.agentType)) {
      return c.json({ error: 'invalid_agent_type' }, 400);
    }
  }
  if ('label' in body) fields.label = body.label ?? null;
  if ('description' in body) fields.description = body.description ?? null;
  if ('cwd' in body) fields.project_dir = body.cwd ?? null;
  if ('requestedModel' in body) fields.requested_model = body.requestedModel ?? null;
  if ('activeModel' in body) fields.active_model = body.activeModel ?? null;
  if ('effort' in body) fields.effort = body.effort ?? null;
  if ('transportConfig' in body) fields.transport_config = body.transportConfig ?? null;

  await updateSession(c.env.DB, serverId, sessionName, fields);

  if (typeof body.agentType === 'string') {
    try {
      WsBridge.get(serverId).sendToDaemon(JSON.stringify({
        type: 'session.restart',
        sessionName,
        agentType: body.agentType,
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
        ...(body.requestedModel !== undefined ? { requestedModel: body.requestedModel } : {}),
        ...(body.activeModel !== undefined ? { activeModel: body.activeModel } : {}),
        ...(body.effort !== undefined ? { effort: body.effort } : {}),
        ...(body.transportConfig !== undefined ? { transportConfig: body.transportConfig } : {}),
      }));
    } catch (err) {
      logger.error({ serverId, sessionName, err }, 'WsBridge session settings relay failed');
      return c.json({ error: 'relay_failed' }, 502);
    }
  }
  if (body.agentType == null && body.label !== undefined) {
    try {
      WsBridge.get(serverId).sendToDaemon(JSON.stringify({
        type: 'session.relabel',
        sessionName,
        label: body.label ?? null,
      }));
    } catch (err) {
      logger.error({ serverId, sessionName, err }, 'WsBridge session relabel relay failed');
      return c.json({ error: 'relay_failed' }, 502);
    }
  }
  if (body.agentType == null && body.transportConfig !== undefined) {
    try {
      WsBridge.get(serverId).sendToDaemon(JSON.stringify({
        type: DAEMON_COMMAND_TYPES.SESSION_UPDATE_TRANSPORT_CONFIG,
        sessionName,
        transportConfig: body.transportConfig ?? null,
      }));
    } catch (err) {
      logger.error({ serverId, sessionName, err }, 'WsBridge session transportConfig relay failed');
      return c.json({ error: 'relay_failed' }, 502);
    }
  }
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
  try {
    WsBridge.get(serverId).sendToDaemon(JSON.stringify({
      type: 'session.rename',
      sessionName,
      projectName: newName,
    }));
  } catch (err) {
    logger.warn({ serverId, sessionName, err }, 'WsBridge session rename relay failed');
  }
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
  const serverId = c.req.param('id')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role !== 'owner' && role !== 'admin') {
    return c.json({ error: 'forbidden', reason: 'start requires admin or owner role' }, 403);
  }
  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  const rawProject = typeof body.project === 'string' ? body.project : '';
  const projectDir = typeof body.dir === 'string' ? body.dir : '';
  if (rawProject) {
    const projectName = sanitizeProjectName(rawProject);
    const sessionName = `deck_${projectName}_brain`;
    if (isKnownTestSessionLike({ name: sessionName, projectName: rawProject, projectDir })) {
      return c.json({ error: 'test_session_blocked' }, 400);
    }
  }
  return relayToDaemon(c, 'session.start', body);
});

sessionMgmtRoutes.post('/:id/sessions/:rootSession/group-clone', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const sourceMainSessionName = c.req.param('rootSession')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);

  let body: Record<string, unknown>;
  try {
    const parsed = await c.req.json();
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    await auditSessionGroupClone(c, {
      outcome: 'failed',
      errorCode: 'invalid_request',
      role,
      sourceMainSessionName,
    });
    return c.json({ error: 'invalid_json' }, 400);
  }

  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  const targetProjectNameResult = readOptionalStringField(body, 'targetProjectName');
  const cwdOverrideResult = readOptionalStringField(body, 'cwdOverride');
  const auditBase = {
    role,
    sourceMainSessionName,
    idempotencyKey: idempotencyKey || undefined,
    targetProjectName: targetProjectNameResult.ok ? targetProjectNameResult.value : undefined,
  };

  if (role !== 'owner' && role !== 'admin') {
    await auditSessionGroupClone(c, {
      ...auditBase,
      outcome: 'forbidden',
      errorCode: 'forbidden',
    });
    return c.json({ error: 'forbidden' }, 403);
  }

  if (!idempotencyKey) {
    await auditSessionGroupClone(c, {
      ...auditBase,
      outcome: 'failed',
      errorCode: 'invalid_request',
    });
    return c.json({ error: 'invalid_request', reason: 'idempotencyKey_required' }, 400);
  }

  if (!targetProjectNameResult.ok || !cwdOverrideResult.ok) {
    await auditSessionGroupClone(c, {
      ...auditBase,
      outcome: 'failed',
      errorCode: 'invalid_request',
    });
    return c.json({ error: 'invalid_request' }, 400);
  }

  if (typeof targetProjectNameResult.value === 'string' && targetProjectNameResult.value.trim() === '') {
    await auditSessionGroupClone(c, {
      ...auditBase,
      outcome: 'failed',
      errorCode: 'blank_target_project',
    });
    return c.json({ error: 'blank_target_project' }, 400);
  }

  const bridge = WsBridge.get(serverId);
  const existingEvent = bridge.getSessionGroupCloneOperationEvent(idempotencyKey);
  if (existingEvent) {
    c.header(IMCODES_POD_HEADER, getPodIdentity());
    return c.json({ ok: true, duplicate: true, event: existingEvent });
  }

  const dbSessions = await getDbSessionsByServer(c.env.DB, serverId);
  if (typeof targetProjectNameResult.value === 'string') {
    const targetProjectSlug = sanitizeProjectName(targetProjectNameResult.value.trim());
    const targetMainSessionName = mainSessionNameForProjectSlug(targetProjectSlug);
    if (dbSessions.some((session) => session.name === targetMainSessionName)) {
      await auditSessionGroupClone(c, {
        ...auditBase,
        outcome: 'failed',
        errorCode: 'name_taken',
      });
      return c.json({ error: 'name_taken', targetMainSessionName }, 409);
    }
  }

  if (!bridge.hasDaemonCapability(SESSION_GROUP_CLONE_CAPABILITY_V1)) {
    await auditSessionGroupClone(c, {
      ...auditBase,
      outcome: 'failed',
      errorCode: 'unsupported_command',
      missingCapability: SESSION_GROUP_CLONE_CAPABILITY_V1,
    });
    return c.json({
      error: 'unsupported_command',
      missingCapability: SESSION_GROUP_CLONE_CAPABILITY_V1,
    }, 409);
  }

  const payload: Record<string, unknown> = {
    type: SESSION_GROUP_CLONE_MSG.START,
    serverId,
    sourceMainSessionName,
    idempotencyKey,
  };
  if (targetProjectNameResult.value !== undefined) {
    payload.targetProjectName = targetProjectNameResult.value;
  }
  if (cwdOverrideResult.value !== undefined) {
    payload.cwdOverride = cwdOverrideResult.value;
  }
  const unavailableSessionNames = dbSessions
    .map((session) => session.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
  if (unavailableSessionNames.length > 0) {
    payload.unavailableSessionNames = unavailableSessionNames;
  }

  try {
    bridge.registerSessionGroupCloneOperationContext({
      idempotencyKey,
      userId,
      sourceMainSessionName,
    });
    bridge.sendToDaemon(JSON.stringify(payload));
  } catch (err) {
    logger.error({ serverId, sourceMainSessionName, err }, 'WsBridge session group clone relay failed');
    await auditSessionGroupClone(c, {
      ...auditBase,
      outcome: 'failed',
      errorCode: 'internal_error',
    });
    return c.json({ error: 'relay_failed' }, 502);
  }

  await auditSessionGroupClone(c, {
    ...auditBase,
    outcome: 'accepted',
  });
  c.header(IMCODES_POD_HEADER, getPodIdentity());
  return c.json({ ok: true });
});

sessionMgmtRoutes.post('/:id/session/stop', async (c) => {
  const userId = c.get('userId' as never) as string;
  const role = await resolveServerRole(c.env.DB, c.req.param('id')!, userId);
  if (role !== 'owner' && role !== 'admin') {
    return c.json({ error: 'forbidden', reason: 'stop requires admin or owner role' }, 403);
  }
  return relayToDaemon(c, 'session.stop');
});

sessionMgmtRoutes.post('/:id/session/cancel', async (c) => {
  const userId = c.get('userId' as never) as string;
  const role = await resolveServerRole(c.env.DB, c.req.param('id')!, userId);
  if (role === 'none') {
    return c.json({ error: 'forbidden', reason: 'not_authorized_for_server' }, 403);
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = await c.req.json();
    body = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    // body is optional; daemon will validate required fields
  }
  const sessionName = typeof body.sessionName === 'string' ? body.sessionName : undefined;
  const session = typeof body.session === 'string' ? body.session : undefined;
  const commandId = typeof body.commandId === 'string' ? body.commandId : undefined;
  return relayToDaemon(c, DAEMON_COMMAND_TYPES.SESSION_CANCEL, {
    ...(sessionName ? { sessionName } : session ? { session } : {}),
    ...(commandId ? { commandId } : {}),
  });
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

type OptionalStringResult =
  | { ok: true; value: string | null | undefined }
  | { ok: false };

function readOptionalStringField(body: Record<string, unknown>, key: string): OptionalStringResult {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return { ok: true, value: undefined };
  const value = body[key];
  if (value === null) return { ok: true, value: null };
  if (typeof value === 'string') return { ok: true, value };
  return { ok: false };
}

async function auditSessionGroupClone(
  c: Context<{ Bindings: Env; Variables: { userId: string; role: string } }>,
  entry: {
    outcome: 'accepted' | 'failed' | 'forbidden';
    role: ServerRole;
    sourceMainSessionName: string;
    idempotencyKey?: string;
    targetProjectName?: string | null;
    errorCode?: SessionGroupCloneErrorCode;
    missingCapability?: string;
  },
): Promise<void> {
  const targetProjectSlug = typeof entry.targetProjectName === 'string' && entry.targetProjectName.trim()
    ? sanitizeProjectName(entry.targetProjectName.trim())
    : undefined;
  await logAudit({
    userId: c.get('userId' as never) as string | undefined,
    serverId: c.req.param('id')!,
    action: `session_group_clone.${entry.outcome}`,
    details: {
      role: entry.role,
      sourceMainSessionName: entry.sourceMainSessionName,
      ...(entry.idempotencyKey ? { idempotencyKey: entry.idempotencyKey } : {}),
      ...(targetProjectSlug ? { targetProjectSlug } : {}),
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
      ...(entry.missingCapability ? { missingCapability: entry.missingCapability } : {}),
    },
    ip: c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? undefined,
  }, c.env.DB);
}

async function relayToDaemon(
  c: Context<{ Bindings: Env; Variables: { userId: string; role: string } }>,
  command: string,
  bodyOverride?: Record<string, unknown>,
) {
  const serverId = c.req.param('id')!;
  const server = await getServerById(c.env.DB, serverId);
  if (!server) return c.json({ error: 'not_found' }, 404);

  let body: unknown = bodyOverride ?? {};
  if (bodyOverride === undefined) {
    try {
      body = await c.req.json();
    } catch {
      // body is optional
    }
  }

  const { type: _ignoredType, ...rest } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  void _ignoredType;
  const payload = JSON.stringify({ type: command, ...rest });

  try {
    WsBridge.get(serverId).sendToDaemon(payload);
  } catch (err) {
    logger.error({ serverId, command, err }, 'WsBridge relay failed');
    return c.json({ error: 'relay_failed' }, 502);
  }

  c.header(IMCODES_POD_HEADER, getPodIdentity());
  return c.json({ ok: true });
}
