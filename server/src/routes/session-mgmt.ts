import { Hono, type Context } from 'hono';
import type { Env } from '../env.js';
import { getServerById, getDbSessionsByServer, getSubSessionsByServer, upsertDbSession, deleteDbSession, updateSessionLabel, updateProjectName, updateSession } from '../db/queries.js';
import { requireAuth } from '../security/authorization.js';
import type { ServerRole } from '../security/authorization.js';
import { randomHex } from '../security/crypto.js';
import { logAudit } from '../security/audit.js';
import { WsBridge } from '../ws/bridge.js';
import logger from '../util/logger.js';
import {
  deriveShareTransitionKey,
  listActiveSharesForUser,
  shareTargetFromSessionName,
  writeShareAuditEvent,
  type EffectiveCoverage,
  type ShareAuditActionType,
  type ShareDenialReason,
  type ShareTarget,
} from '../db/tab-sharing.js';
import { resolveHttpShareAccess, resolveServerMemberAccessOrShareDeny } from './share-http-auth.js';
import { buildCoversSessionPredicate, resolveCoveredSessionNames } from '../share/covered-sessions.js';
import { evaluateP2pSendTargetScope } from '../share/p2p-send-scope.js';
import { IMCODES_POD_HEADER } from '../../../shared/http-header-names.js';
import {
  WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON,
  WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT,
  buildWorkerSessionSnapshotCompleteResponse,
  buildWorkerSessionSnapshotIncompleteResponse,
  normalizeWorkerSessionRows,
  normalizeWorkerSubSessionRows,
} from '../../../shared/worker-session-snapshot.js';
import { evaluateSharedCommandRateLimit } from '../share/share-rate-limit.js';
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
import { GIT_REMOTE_CLONE_CAPABILITY_V1 } from '../../../shared/git-remote-url.js';
import type { SharedActorEnvelope } from '../../../shared/tab-sharing.js';

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

/** GET /api/server/:id/session-snapshot — paired daemon startup snapshot with trust metadata */
sessionMgmtRoutes.get(`/:id/${WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT}`, async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const access = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);

  try {
    const [allSessions, subSessions] = await Promise.all([
      getDbSessionsByServer(c.env.DB, serverId),
      // Session-mgmt snapshot listing: exclude ephemeral execution clones (default).
      getSubSessionsByServer(c.env.DB, serverId, { includeExecutionClones: false }),
    ]);
    const sessions = allSessions.filter((s) => !s.name.startsWith('deck_sub_'));
    const normalizedSessions = normalizeWorkerSessionRows(sessions);
    const normalizedSubSessions = normalizeWorkerSubSessionRows(subSessions);
    if (!normalizedSessions.ok || !normalizedSubSessions.ok) {
      logger.warn({
        serverId,
        sessionIssues: normalizedSessions.issues,
        subSessionIssues: normalizedSubSessions.issues,
      }, 'session snapshot contains invalid rows');
      return c.json(buildWorkerSessionSnapshotIncompleteResponse({
        serverId,
        reason: WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON.INVALID_ROW,
      }), 503);
    }

    return c.json(buildWorkerSessionSnapshotCompleteResponse({
      serverId,
      sessions: normalizedSessions.rows,
      subSessions: normalizedSubSessions.rows,
    }));
  } catch (err) {
    logger.warn({ err, serverId }, 'session snapshot query failed');
    return c.json(buildWorkerSessionSnapshotIncompleteResponse({
      serverId,
      reason: WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON.QUERY_FAILED,
    }), 503);
  }
});

/** GET /api/server/:id/sessions — list all sessions for a server (used by daemon on startup) */
sessionMgmtRoutes.get('/:id/sessions', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const access = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);

  const all = await getDbSessionsByServer(c.env.DB, serverId);
  const sessions = all.filter((s) => !s.name.startsWith('deck_sub_'));
  return c.json({ sessions });
});

/** PUT /api/server/:id/sessions/:name — upsert a session record (daemon → DB) */
sessionMgmtRoutes.put('/:id/sessions/:name', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const sessionName = c.req.param('name')!;
  const access = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);
  const role = access.role;
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
  const access = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);

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
  const access = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);

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
  const access = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);

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
  const access = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);
  const role = access.role;
  if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403);

  await deleteDbSession(c.env.DB, serverId, sessionName);
  const target = shareTargetFromSessionName(serverId, sessionName);
  if (target) void WsBridge.get(serverId).revalidateShareSocketsForTarget(target);
  return c.json({ ok: true });
});

sessionMgmtRoutes.post('/:id/session/start', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const access = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  if (!access.ok) {
    return c.json({ error: 'forbidden', reason: access.reason }, 403);
  }
  const role = access.role;
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
  const access = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  const role: ServerRole = access.ok ? access.role : 'none';

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
  const gitRemoteUrlResult = readOptionalStringField(body, 'gitRemoteUrl');
  const auditBase = {
    role,
    sourceMainSessionName,
    idempotencyKey: idempotencyKey || undefined,
    targetProjectName: targetProjectNameResult.ok ? targetProjectNameResult.value : undefined,
  };

  if (!access.ok || (role !== 'owner' && role !== 'admin')) {
    await auditSessionGroupClone(c, {
      ...auditBase,
      outcome: 'forbidden',
      errorCode: 'forbidden',
    });
    return c.json({ error: 'forbidden', ...(!access.ok ? { reason: access.reason } : {}) }, 403);
  }

  if (!idempotencyKey) {
    await auditSessionGroupClone(c, {
      ...auditBase,
      outcome: 'failed',
      errorCode: 'invalid_request',
    });
    return c.json({ error: 'invalid_request', reason: 'idempotencyKey_required' }, 400);
  }

  if (!targetProjectNameResult.ok || !cwdOverrideResult.ok || !gitRemoteUrlResult.ok) {
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
  if (typeof gitRemoteUrlResult.value === 'string' && gitRemoteUrlResult.value.trim()
    && !bridge.hasDaemonCapability(GIT_REMOTE_CLONE_CAPABILITY_V1)) {
    await auditSessionGroupClone(c, {
      ...auditBase,
      outcome: 'failed',
      errorCode: 'unsupported_command',
      missingCapability: GIT_REMOTE_CLONE_CAPABILITY_V1,
    });
    return c.json({
      error: 'unsupported_command',
      missingCapability: GIT_REMOTE_CLONE_CAPABILITY_V1,
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
  if (gitRemoteUrlResult.value !== undefined) {
    payload.gitRemoteUrl = gitRemoteUrlResult.value;
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
  const serverId = c.req.param('id')!;
  const access = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);
  const role = access.role;
  if (role !== 'owner' && role !== 'admin') {
    return c.json({ error: 'forbidden', reason: 'stop requires admin or owner role' }, 403);
  }
  return relayToDaemon(c, 'session.stop');
});

sessionMgmtRoutes.post('/:id/session/cancel', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
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
  const targetSessionName = commandSessionName(body);
  const target = targetSessionName ? shareTargetFromSessionName(serverId, targetSessionName) : null;
  if (target) {
    const access = await resolveHttpShareAccess(c.env.DB, { serverId, userId, target });
    if (access.actor.kind === 'share') {
      const now = Date.now();
      const actionId = actionIdFromBody(body);
      if (access.actor.effectiveActorRole !== 'participant') {
        await auditHttpShareCommand(c, { userId, target, coverage: access.actor.coverage, actionType: 'session.cancel', decision: 'rejected', reason: 'share-role-denied', actionId, now });
        return c.json({ error: 'forbidden', reason: 'share-role-denied' }, 403);
      }
      const observedDispatchId = typeof body.observedDispatchId === 'string' ? body.observedDispatchId.trim() : '';
      if (!observedDispatchId) {
        await auditHttpShareCommand(c, { userId, target, coverage: access.actor.coverage, actionType: 'session.cancel', decision: 'rejected', reason: 'share-target-unavailable', actionId, now });
        return c.json({ error: 'not_canceled', reason: 'share-target-unavailable' }, 409);
      }
      const runtimeType = await getTrustedRuntimeType(c.env.DB, serverId, target);
      if (runtimeType !== 'transport') {
        await auditHttpShareCommand(c, { userId, target, coverage: access.actor.coverage, actionType: 'session.cancel', decision: 'rejected', reason: 'share-cancel-unsupported', actionId, now });
        return c.json({ error: 'forbidden', reason: 'share-cancel-unsupported' }, 403);
      }
      const bridge = WsBridge.get(serverId);
      const activeDispatchId = bridge.getActiveDispatchIdForSession(targetSessionName ?? '');
      if (!activeDispatchId || activeDispatchId !== observedDispatchId) {
        await auditHttpShareCommand(c, { userId, target, coverage: access.actor.coverage, actionType: 'session.cancel', decision: 'rejected', reason: 'share-target-unavailable', actionId, now });
        return c.json({ error: 'not_canceled', reason: 'share-target-unavailable' }, 409);
      }
      const rateLimitReason = evaluateHttpShareRateLimit({ bridge, userId, serverId, sessionName: targetSessionName ?? '', commandType: DAEMON_COMMAND_TYPES.SESSION_CANCEL, now });
      if (rateLimitReason) {
        await auditHttpShareCommand(c, { userId, target, coverage: access.actor.coverage, actionType: 'session.cancel', decision: 'rejected', reason: rateLimitReason, actionId, now });
        return c.json({ error: 'forbidden', reason: rateLimitReason }, 429);
      }
      await auditHttpShareCommand(c, { userId, target, coverage: access.actor.coverage, actionType: 'session.cancel', decision: 'accepted', actionId, now });
      return relayToDaemon(c, DAEMON_COMMAND_TYPES.SESSION_CANCEL, {
        ...(sessionName ? { sessionName } : session ? { session } : {}),
        ...(commandId ? { commandId } : {}),
        observedDispatchId,
        sharedActor: await buildHttpSharedActor(c.env.DB, {
          userId,
          coverage: access.actor.coverage,
          actionId,
          now,
        }),
      });
    }
    if (access.actor.kind === 'none') {
      return c.json({ error: 'forbidden', reason: 'not_authorized_for_server' }, 403);
    }
  } else {
    const access = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
    if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);
  }
  return relayToDaemon(c, DAEMON_COMMAND_TYPES.SESSION_CANCEL, {
    ...(sessionName ? { sessionName } : session ? { session } : {}),
    ...(commandId ? { commandId } : {}),
  });
});

sessionMgmtRoutes.post('/:id/session/send', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  let body: Record<string, unknown> = {};
  try {
    const parsed = await c.req.json();
    body = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    // body is optional; daemon will validate required fields
  }
  const targetSessionName = commandSessionName(body);
  const target = targetSessionName ? shareTargetFromSessionName(serverId, targetSessionName) : null;
  if (target) {
    const access = await resolveHttpShareAccess(c.env.DB, { serverId, userId, target });
    if (access.actor.kind === 'share') {
      const now = Date.now();
      const actionId = actionIdFromBody(body);
      if (access.actor.effectiveActorRole !== 'participant') {
        await auditHttpShareCommand(c, { userId, target, coverage: access.actor.coverage, actionType: 'session.send', decision: 'rejected', reason: 'share-role-denied', actionId, now });
        return c.json({ error: 'forbidden', reason: 'share-role-denied' }, 403);
      }
      const p2pScopeTarget = await httpP2pScopeTarget(c.env.DB, {
        userId,
        serverId,
        requestedTarget: target,
        coverage: access.actor.coverage,
        now,
      });
      const coveredSessionNames = await resolveCoveredSessionNames(c.env.DB, p2pScopeTarget);
      const p2pScopeReason = evaluateP2pSendTargetScope({
        msg: body,
        target: p2pScopeTarget,
        coversSession: buildCoversSessionPredicate(p2pScopeTarget, coveredSessionNames),
      });
      if (p2pScopeReason) {
        await auditHttpShareCommand(c, { userId, target, coverage: access.actor.coverage, actionType: 'session.send', decision: 'rejected', reason: p2pScopeReason, actionId, now });
        return c.json({ error: 'forbidden', reason: p2pScopeReason }, 403);
      }
      const rateLimitReason = evaluateHttpShareRateLimit({ bridge: WsBridge.get(serverId), userId, serverId, sessionName: targetSessionName ?? '', commandType: 'session.send', now });
      if (rateLimitReason) {
        await auditHttpShareCommand(c, { userId, target, coverage: access.actor.coverage, actionType: 'session.send', decision: 'rejected', reason: rateLimitReason, actionId, now });
        return c.json({ error: 'forbidden', reason: rateLimitReason }, 429);
      }
      await auditHttpShareCommand(c, { userId, target, coverage: access.actor.coverage, actionType: 'session.send', decision: 'accepted', actionId, now });
      const { type: _ignoredType, sharedActor: _ignoredSharedActor, shareScope: _ignoredShareScope, ...rest } = body;
      void _ignoredType;
      void _ignoredSharedActor;
      void _ignoredShareScope;
      return relayToDaemon(c, 'session.send', {
        ...rest,
        sharedActor: await buildHttpSharedActor(c.env.DB, {
          userId,
          coverage: access.actor.coverage,
          actionId,
          now,
        }),
      });
    }
    if (access.actor.kind === 'none') {
      return c.json({ error: 'forbidden', reason: 'not_authorized_for_server' }, 403);
    }
  } else {
    const access = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
    if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);
  }
  return relayToDaemon(c, 'session.send', stripBrowserShareFields(body));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

type OptionalStringResult =
  | { ok: true; value: string | null | undefined }
  | { ok: false };

type TrustedRuntimeType = 'process' | 'transport' | 'unknown';

function readOptionalStringField(body: Record<string, unknown>, key: string): OptionalStringResult {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return { ok: true, value: undefined };
  const value = body[key];
  if (value === null) return { ok: true, value: null };
  if (typeof value === 'string') return { ok: true, value };
  return { ok: false };
}

function commandSessionName(body: Record<string, unknown>): string | null {
  for (const key of ['sessionName', 'session', 'sessionId'] as const) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function actionIdFromBody(body: Record<string, unknown>): string {
  for (const key of ['actionId', 'commandId'] as const) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return `share-action-${randomHex(8)}`;
}

function stripBrowserShareFields(body: Record<string, unknown>): Record<string, unknown> {
  const { type: _ignoredType, sharedActor: _ignoredSharedActor, shareScope: _ignoredShareScope, ...safeBody } = body;
  void _ignoredType;
  void _ignoredSharedActor;
  void _ignoredShareScope;
  return safeBody;
}

async function getTrustedRuntimeType(db: Env['DB'], serverId: string, target: ShareTarget): Promise<TrustedRuntimeType> {
  const row = target.kind === 'subsession'
    ? await db.queryOne<{ runtime_type: string | null }>(
      'SELECT runtime_type FROM sub_sessions WHERE server_id = $1 AND id = $2 LIMIT 1',
      [serverId, target.subSessionId],
    )
    : await db.queryOne<{ runtime_type: string | null }>(
      'SELECT runtime_type FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
      [serverId, target.kind === 'main' ? target.sessionName : ''],
    );
  return normalizeTrustedRuntimeType(row?.runtime_type ?? null);
}

function normalizeTrustedRuntimeType(value: string | null): TrustedRuntimeType {
  if (value === 'transport') return 'transport';
  if (value === 'process') return 'process';
  return 'unknown';
}

async function buildHttpSharedActor(
  db: Env['DB'],
  params: { userId: string; coverage: EffectiveCoverage; actionId: string; now: number },
): Promise<SharedActorEnvelope> {
  const user = await db.queryOne<{ display_name: string | null; username: string | null }>(
    'SELECT display_name, username FROM users WHERE id = $1',
    [params.userId],
  );
  return {
    actorUserId: params.userId,
    actorDisplayName: user?.display_name ?? user?.username ?? params.userId,
    snapshot: params.coverage,
    primaryShareId: params.coverage.primaryShareId,
    effectiveActorRole: params.coverage.effectiveRole,
    actionId: params.actionId,
    origin: params.coverage.target.kind === 'server' ? 'shared-server' : 'shared-tab',
    authorizedAt: params.coverage.authorizedAt,
    queuedAt: params.now,
  };
}

async function httpP2pScopeTarget(
  db: Env['DB'],
  params: { userId: string; serverId: string; requestedTarget: ShareTarget; coverage: EffectiveCoverage; now: number },
): Promise<ShareTarget> {
  const coveringShareIds = new Set(params.coverage.coveringShareIds);
  const activeShares = await listActiveSharesForUser(db, params.userId, params.now);
  const hasParticipantServerGrant = activeShares.some((share) => (
    share.serverId === params.serverId
    && coveringShareIds.has(share.id)
    && share.target.kind === 'server'
    && share.role === 'participant'
  ));
  return hasParticipantServerGrant ? { kind: 'server', serverId: params.serverId } : params.requestedTarget;
}

function evaluateHttpShareRateLimit(params: {
  bridge: Pick<WsBridge, 'countSharePendingCommandsForUser'>;
  userId: string;
  serverId: string;
  sessionName: string;
  commandType: string;
  now: number;
}): ShareDenialReason | null {
  if (params.commandType === 'session.send') {
    const pending = params.bridge.countSharePendingCommandsForUser(params.userId, params.sessionName, 'session.send');
    return evaluateSharedCommandRateLimit({
      userId: params.userId,
      serverId: params.serverId,
      sessionName: params.sessionName,
      commandType: 'session.send',
      now: params.now,
      pendingSendCount: pending,
    });
  }
  return evaluateSharedCommandRateLimit({
    userId: params.userId,
    serverId: params.serverId,
    sessionName: params.sessionName,
    commandType: 'session.cancel',
    now: params.now,
  });
}

async function auditHttpShareCommand(
  c: Context<{ Bindings: Env; Variables: { userId: string; role: string } }>,
  params: {
    userId: string;
    target: ShareTarget;
    coverage: EffectiveCoverage;
    actionType: Extract<ShareAuditActionType, 'session.send' | 'session.cancel'>;
    decision: 'accepted' | 'rejected';
    reason?: ShareDenialReason | null;
    actionId: string;
    now: number;
  },
): Promise<void> {
  try {
    const auditEventId = randomHex(16);
    await writeShareAuditEvent(c.env.DB, {
      id: auditEventId,
      serverId: params.target.serverId,
      actorKind: 'user',
      actorUserId: params.userId,
      targetUserId: params.userId,
      effectiveActorRole: params.coverage.effectiveRole,
      target: params.target,
      actionType: params.actionType,
      decision: params.decision,
      reason: params.reason ?? null,
      snapshot: params.coverage,
      primaryShareId: params.coverage.primaryShareId,
      actionId: params.actionId,
      idempotencyKey: deriveShareTransitionKey({
        actionType: params.actionType,
        target: params.target,
        primaryShareId: params.coverage.primaryShareId,
        transitionEpochMs: params.now,
        decision: params.decision,
        attemptId: auditEventId,
      }),
      createdAt: params.now,
    });
  } catch (err) {
    logger.error({ err, serverId: params.target.serverId, actionType: params.actionType }, 'HTTP share command audit write failed');
  }
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

  const rawBody = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const rest = bodyOverride === undefined ? stripBrowserShareFields(rawBody) : rawBody;
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
