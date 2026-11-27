import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { Cron } from 'croner';
import { z } from 'zod';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import type { DbCronJob } from '../db/queries.js';
import { requireAuth } from '../security/authorization.js';
import { daemonScopeFailure, resolveDaemonCallerAuthority } from '../security/daemon-scope.js';
import { resolveHttpShareAccessForCoveredSession, resolveServerMemberAccessOrShareDeny } from './share-http-auth.js';
import { listActiveSharesForUser, shareTargetFromSessionName, shareTargetSessionName } from '../db/tab-sharing.js';
import { getSubSessionById, isExecutionCloneRow } from '../db/queries.js';
import { randomHex } from '../security/crypto.js';
import { logAudit } from '../security/audit.js';
import {
  CRON_API_AUTH_ERRORS,
  CRON_COMPLETION_POLICY,
  CRON_CONTROL_CONTRACT,
  LEGACY_CRON_CONTROL_CONTRACT_V1,
  CRON_STATUS,
  isAllowedExternalCliRestrictedCronAction,
  normalizeCronCompletionPolicy,
  normalizeCronExecutionDetail,
  normalizeCronSendActionForInterval,
  registerCronControlAction,
  unwrapCronActionForRead,
  wrapExternalCliRestrictedCronAction,
  type CronAction,
} from '../../../shared/cron-types.js';
import {
  checkAgentShortIntervalJustification,
  sampleCronOccurrences,
  validateCronScheduleWithSampler,
} from '../../../shared/cron-interval.js';
import { MEMORY_MCP_CAPS } from '../../../shared/memory-mcp-contracts.js';
import { MEMORY_MCP_SOURCE_FIELDS, stripMemoryMcpSourceProvenance } from '../../../shared/memory-mcp-provenance.js';
import { P2P_MODE_KEYS } from '../../../shared/p2p-modes.js';
import { dispatchJobNow, readCronJobAndProvenanceLocked, readCronJobProvenance, type CronProvenanceLookup } from '../cron/job-dispatch.js';
import { WsBridge } from '../ws/bridge.js';
import { RESOURCE_TOPICS } from '../../../shared/resource-events.js';
import { AUTHORIZATION_HEADER, CLIENT_TIMEZONE_HEADER, DEVICE_TIMEZONE_HEADER, SERVER_ID_HEADER } from '../../../shared/http-header-names.js';
import { CRON_RESTRICTED_ACTOR_EXTERNAL_CLI, CRON_RESTRICTED_ACTOR_HEADER } from '../../../shared/shared-machine-authority.js';
import { IMCODES_EXTERNAL_CLI_SENDER } from '../../../shared/imcodes-send.js';
import { normalizeClientTimezone } from '../../../shared/client-timezone.js';
import { loadRememberedClientTimezone, rememberClientTimezone } from '../util/client-timezone.js';

type CronRouteEnv = { Bindings: Env; Variables: { userId: string; role: string; externalCliRestrictedRoute?: boolean } };

export const cronApiRoutes = new Hono<CronRouteEnv>();
export const cronRestrictedApiRoutes = new Hono<CronRouteEnv>();
cronRestrictedApiRoutes.use('*', async (c, next) => {
  c.set('externalCliRestrictedRoute', true);
  return next();
});

const rolePattern = /^(brain|w\d+)$/;
const sessionNamePattern = /^deck_sub_[a-zA-Z0-9_-]+$/;
const sourceSessionNamePattern = /^deck_(?:sub_[a-zA-Z0-9_-]+|[a-zA-Z0-9._-]+_(?:brain|w\d+))$/;

const cronParticipantSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('role'), value: z.string().regex(rolePattern) }),
  z.object({ type: z.literal('session'), value: z.string().regex(sessionNamePattern) }),
]);

const currentCronControlRegistrationSchema = z.object({
  contractId: z.literal(CRON_CONTROL_CONTRACT.contractId), version: z.literal(CRON_CONTROL_CONTRACT.version), scheduleId: z.string().min(1),
  constraints: z.object({
    authorization: z.literal(CRON_CONTROL_CONTRACT.constraints.authorization),
    executeTaskBody: z.literal(CRON_CONTROL_CONTRACT.constraints.executeTaskBody),
    scope: z.literal(CRON_CONTROL_CONTRACT.constraints.scope),
    secrets: z.literal(CRON_CONTROL_CONTRACT.constraints.secrets),
    updateSelf: z.literal(CRON_CONTROL_CONTRACT.constraints.updateSelf),
    cancelRecurring: z.literal(CRON_CONTROL_CONTRACT.constraints.cancelRecurring),
    cancelUntilComplete: z.literal(CRON_CONTROL_CONTRACT.constraints.cancelUntilComplete),
    silent: z.literal(CRON_CONTROL_CONTRACT.constraints.silent),
    network: z.literal(CRON_CONTROL_CONTRACT.constraints.network),
    finalResponse: z.literal(CRON_CONTROL_CONTRACT.constraints.finalResponse),
  }).strict(),
}).strict();

const legacyCronControlRegistrationSchema = z.object({
  contractId: z.literal(LEGACY_CRON_CONTROL_CONTRACT_V1.contractId), version: z.literal(LEGACY_CRON_CONTROL_CONTRACT_V1.version), scheduleId: z.string().min(1),
  constraints: z.object({
    updateSelf: z.literal(LEGACY_CRON_CONTROL_CONTRACT_V1.constraints.updateSelf),
    cancelRecurring: z.literal(LEGACY_CRON_CONTROL_CONTRACT_V1.constraints.cancelRecurring),
    cancelUntilComplete: z.literal(LEGACY_CRON_CONTROL_CONTRACT_V1.constraints.cancelUntilComplete),
    silent: z.literal(LEGACY_CRON_CONTROL_CONTRACT_V1.constraints.silent),
    network: z.literal(LEGACY_CRON_CONTROL_CONTRACT_V1.constraints.network),
    finalResponse: z.literal(LEGACY_CRON_CONTROL_CONTRACT_V1.constraints.finalResponse),
  }).strict(),
}).strict();

const cronControlRegistrationSchema = z.union([
  currentCronControlRegistrationSchema,
  legacyCronControlRegistrationSchema,
]);

const cronActionSchemaRaw = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('command'), command: z.string().min(1), selfManaged: z.boolean().optional(),
    onlyWhenIdle: z.boolean().optional(),
    cronControl: cronControlRegistrationSchema.optional(),
  }),
  z.object({
    type: z.literal('send'),
    target: z.string().min(1),
    message: z.string().min(1),
    reply: z.boolean().optional(),
    broadcast: z.boolean().optional(),
    idempotencyKey: z.string().min(1).optional(),
    onlyWhenIdle: z.boolean().optional(),
    [MEMORY_MCP_SOURCE_FIELDS.SOURCE_SESSION_NAME]: z.string().regex(sourceSessionNamePattern).optional(),
    [MEMORY_MCP_SOURCE_FIELDS.SOURCE_PROJECT_NAME]: z.string().min(1).max(64).optional(),
    [MEMORY_MCP_SOURCE_FIELDS.SOURCE_SERVER_ID]: z.string().min(1).max(128).optional(),
  }),
  z.object({
    type: z.literal('p2p'),
    topic: z.string().min(1),
    mode: z.enum(P2P_MODE_KEYS),
    // Legacy: plain role strings (backward compat with existing DB rows)
    participants: z.array(z.string().regex(rolePattern)).optional(),
    // New: discriminated entries supporting both roles and session names
    participantEntries: z.array(cronParticipantSchema).optional(),
    rounds: z.number().int().min(1).max(6).optional(),
  }),
]);
// Refine outside discriminatedUnion to avoid Zod type incompatibility
const cronActionSchema = cronActionSchemaRaw.refine(d => {
  if (d.type !== 'p2p') return true;
  return (d.participants?.length ?? 0) + (d.participantEntries?.length ?? 0) > 0;
}, { message: 'At least one participant required (via participants or participantEntries)' });

const cronJobCreateSchema = z.object({
  name: z.string().min(1).max(100),
  cronExpr: z.string().min(1),
  shortIntervalReason: z.string().optional(),
  serverId: z.string().min(1),
  projectName: z.string().min(1).max(64),
  targetRole: z.string().regex(rolePattern).default('brain'),
  targetSessionName: z.string().regex(sessionNamePattern).nullable().optional(),
  action: cronActionSchema,
  timezone: z.string().min(1).max(64).optional(),
  expiresAt: z.number().nullable().optional(),
  completionPolicy: z.enum([
    CRON_COMPLETION_POLICY.RECURRING,
    CRON_COMPLETION_POLICY.UNTIL_COMPLETE,
  ]).default(CRON_COMPLETION_POLICY.RECURRING),
});

const cronJobUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  cronExpr: z.string().min(1).optional(),
  shortIntervalReason: z.string().optional(),
  projectName: z.string().min(1).max(64).optional(),
  targetRole: z.string().regex(rolePattern).optional(),
  targetSessionName: z.string().regex(sessionNamePattern).nullable().optional(),
  action: cronActionSchema.optional(),
  timezone: z.string().min(1).max(64).optional(),
  expiresAt: z.number().nullable().optional(),
  completionPolicy: z.enum([
    CRON_COMPLETION_POLICY.RECURRING,
    CRON_COMPLETION_POLICY.UNTIL_COMPLETE,
  ]).optional(),
});

function getPodStickyServerId(c: { req: { param: (name: string) => string | undefined } }): string | null {
  return c.req.param('serverId') || null;
}

function withPodStickyServerId(body: unknown, serverId: string | null): unknown {
  if (!serverId || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  return { ...(body as Record<string, unknown>), serverId };
}

async function withDefaultCronTimezone(
  c: Context<CronRouteEnv>,
  userId: string,
  body: unknown,
): Promise<unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (record.timezone !== undefined) return body;

  const directClientTimezone = await rememberClientTimezone(
    c.env.DB,
    userId,
    c.req.header(CLIENT_TIMEZONE_HEADER),
  ).catch(() => null);
  if (directClientTimezone) return { ...record, timezone: directClientTimezone };

  const rememberedTimezone = await loadRememberedClientTimezone(c.env.DB, userId).catch(() => null);
  if (rememberedTimezone) return { ...record, timezone: rememberedTimezone };

  const deviceTimezone = normalizeClientTimezone(c.req.header(DEVICE_TIMEZONE_HEADER));
  return deviceTimezone ? { ...record, timezone: deviceTimezone } : body;
}

function isWrongPodStickyServer(jobServerId: string, routeServerId: string | null): boolean {
  return routeServerId !== null && jobServerId !== routeServerId;
}

function parsePersistedCronAction(
  rawAction: string,
): { wrapped: boolean; validWrapper: boolean; action: z.infer<typeof cronActionSchema> | undefined } {
  try {
    const decoded = unwrapCronActionForRead(JSON.parse(rawAction));
    if (decoded.wrapped && !decoded.validWrapper) {
      return { wrapped: true, validWrapper: false, action: undefined };
    }
    const parsed = cronActionSchema.safeParse(decoded.action);
    return {
      wrapped: decoded.wrapped,
      validWrapper: decoded.validWrapper,
      action: parsed.success ? parsed.data : undefined,
    };
  } catch {
    return { wrapped: false, validWrapper: false, action: undefined };
  }
}

function unwrapCronActionStringForResponse(rawAction: string): string {
  const parsed = parsePersistedCronAction(rawAction);
  if (parsed.wrapped && parsed.validWrapper && parsed.action) {
    return JSON.stringify(parsed.action);
  }
  return rawAction;
}

function serializeCronActionForStorage(action: CronAction, restrictedExternalCli: boolean): string {
  return JSON.stringify(restrictedExternalCli ? wrapExternalCliRestrictedCronAction(action) : action);
}

function normalizeCronExecutionRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => {
    let next: T | null = null;
    if (typeof row.detail === 'string') {
      const detail = normalizeCronExecutionDetail(row.detail);
      if (detail !== row.detail) next = { ...row, detail };
    }
    if (typeof row.action === 'string') {
      const unwrappedAction = unwrapCronActionStringForResponse(row.action);
      if (unwrappedAction !== row.action) next = { ...(next ?? row), action: unwrappedAction };
    }
    return next ?? row;
  });
}

function isDaemonServerTokenCronRequest(
  c: { req: { header: (name: string) => string | undefined } },
  routeServerId: string | null,
): boolean {
  if (!routeServerId) return false;
  const authHeader = c.req.header(AUTHORIZATION_HEADER);
  const headerServerId = c.req.header(SERVER_ID_HEADER);
  const cookieHeader = c.req.header('Cookie');
  return !!authHeader?.startsWith('Bearer ')
    && headerServerId === routeServerId
    && !cookieHeader;
}

/**
 * True only for a request that `requireCronAuth` authenticated as THIS server's daemon: the credential is the server
 * token (a bearer sent together with `X-Server-Id`, which `resolveBearerAuth` verifies against `servers.token_hash` and
 * refuses for a revoked token or a controlled node) and the header names the route's own server. There is no other way
 * to be "the daemon": the unauthenticated path that once granted it (any request naming a server) is gone.
 */
function isDaemonCronRequest(
  c: Context<CronRouteEnv>,
  routeServerId: string | null,
  authorityKind?: 'interactive_user' | 'participant_daemon' | 'owner_daemon',
): boolean {
  if (authorityKind === 'participant_daemon') return false;
  return isDaemonServerTokenCronRequest(c, routeServerId);
}

function wantsExternalCliRestrictedCron(
  c: Context<CronRouteEnv>,
  routeServerId: string | null,
): boolean {
  return c.get('externalCliRestrictedRoute') === true
    && isDaemonServerTokenCronRequest(c, routeServerId)
    && c.req.header(CRON_RESTRICTED_ACTOR_HEADER) === CRON_RESTRICTED_ACTOR_EXTERNAL_CLI;
}

type CronDaemonContext =
  | Awaited<ReturnType<typeof resolveDaemonCallerAuthority>>
  | {
      ok: false;
      status: 403;
      error: 'forbidden';
      reason: 'external_cli_cron_route_denied' | 'external_cli_cron_requires_restricted_route';
    };

async function resolveCronDaemonContext(
  c: Context<CronRouteEnv>,
  targetServerId?: string | null,
): Promise<CronDaemonContext> {
  const routeServerId = getPodStickyServerId(c);
  const isRestrictedRoute = c.get('externalCliRestrictedRoute') === true;
  if (isRestrictedRoute) {
    if (!wantsExternalCliRestrictedCron(c, routeServerId)) {
      return { ok: false, status: 403, error: 'forbidden', reason: 'external_cli_cron_route_denied' };
    }
  } else if (c.req.header(CRON_RESTRICTED_ACTOR_HEADER) !== undefined) {
    return { ok: false, status: 403, error: 'forbidden', reason: 'external_cli_cron_requires_restricted_route' };
  }
  const authority = await resolveDaemonCallerAuthority(c as unknown as Context<{ Bindings: Env }>, {
    ...(targetServerId ? { targetServerId, allowOwnerCrossServer: true } : {}),
    ...(isRestrictedRoute ? { denySharedHostAbsentAuthority: false } : {}),
  });
  if (isRestrictedRoute) {
    if (
      !authority.ok
      || authority.kind !== 'owner_daemon'
      || authority.hasTurnAuthority
      || c.req.header(CRON_RESTRICTED_ACTOR_HEADER) !== CRON_RESTRICTED_ACTOR_EXTERNAL_CLI
    ) {
      return !authority.ok
        ? authority
        : { ok: false, status: 403, error: 'forbidden', reason: 'external_cli_cron_route_denied' };
    }
  }
  return authority;
}

function isExternalCliRestrictedAuthority(
  c: Context<CronRouteEnv>,
  routeServerId: string | null,
  authority: CronDaemonContext,
): boolean {
  return authority.ok
    && authority.kind === 'owner_daemon'
    && !authority.hasTurnAuthority
    && wantsExternalCliRestrictedCron(c, routeServerId);
}

function isExternalCliOwnedProvenance(
  prov: { creator_user_id?: string | null; shared?: boolean | null } | null | undefined,
): boolean {
  return prov?.creator_user_id === IMCODES_EXTERNAL_CLI_SENDER;
}

function pinnedSessionForAuthority(
  authority: Awaited<ReturnType<typeof resolveCronDaemonContext>>,
): string | null {
  if (!authority.ok || authority.kind !== 'participant_daemon') return null;
  return authority.claims.shareTarget.kind === 'server' ? null : authority.claims.sessionName;
}

type CronAccessMode = 'read' | 'write';
type CronScope = {
  ownerUserId: string;
  projectName: string | null;
  shared: boolean;
  sharedSessionName: string | null;
  sharedTargetKind: 'server' | 'main' | 'subsession' | null;
};

async function resolveCronScope(
  c: Context<CronRouteEnv>,
  params: {
    serverId: string;
    userId: string;
    requestedProjectName?: string | null;
    mode: CronAccessMode;
    pinnedSessionName?: string | null;
    db?: Database;
  },
): Promise<{ ok: true; scope: CronScope } | { ok: false; reason: string }> {
  const db = params.db ?? c.env.DB;
  const pinnedSession = params.pinnedSessionName?.trim() || '';
  const member = pinnedSession
    ? { ok: false as const, reason: 'pinned-shared-session' }
    : await resolveServerMemberAccessOrShareDeny(db, {
        serverId: params.serverId,
        userId: params.userId,
      });
  if (member.ok) {
    // Operational authority includes server Participants and group members;
    // jobs belong to the server owner, not the visiting actor.
    const server = await db.queryOne<{ user_id: string }>(
      'SELECT user_id FROM servers WHERE id = $1', [params.serverId],
    );
    if (!server) return { ok: false, reason: 'share-target-unavailable' };
    return {
      ok: true,
      scope: {
        ownerUserId: server.user_id,
        projectName: params.requestedProjectName ?? null,
        shared: false,
        sharedSessionName: null,
        sharedTargetKind: null,
      },
    };
  }

  let sessionName = pinnedSession || (c.req.query('sessionName') ?? '').trim();
  let target = shareTargetFromSessionName(params.serverId, sessionName);
  if (!target && !pinnedSession) {
    const userShares = await listActiveSharesForUser(db, params.userId, Date.now()).catch(() => []);
    const serverShare = userShares.find((s) => s.serverId === params.serverId && s.target.kind === 'server')
      ?? userShares.find((s) => s.serverId === params.serverId);
    if (serverShare) {
      target = serverShare.target;
      sessionName = shareTargetSessionName(serverShare.target) ?? '';
    }
  }
  if (!target) return { ok: false, reason: member.reason };
  let access = await resolveHttpShareAccessForCoveredSession(db, {
    serverId: params.serverId,
    userId: params.userId,
    target,
  });

  if (access.actor.kind !== 'share' && target.kind === 'main' && !pinnedSession) {
    const userShares = await listActiveSharesForUser(db, params.userId, Date.now()).catch(() => []);
    for (const share of userShares) {
      if (share.serverId !== params.serverId || share.target.kind !== 'subsession') continue;
      const child = await getSubSessionById(db, share.target.subSessionId, params.serverId);
      if (child && child.closed_at === null && child.parent_session === target.sessionName) {
        const subAccess = await resolveHttpShareAccessForCoveredSession(db, {
          serverId: params.serverId,
          userId: params.userId,
          target: share.target,
        });
        if (subAccess.actor.kind === 'share') {
          access = subAccess;
          target = share.target;
          sessionName = shareTargetSessionName(share.target) ?? sessionName;
          break;
        }
      }
    }
  }

  if (access.actor.kind !== 'share') return { ok: false, reason: member.reason };
  if (params.mode === 'write' && access.actor.effectiveActorRole !== 'participant') {
    return { ok: false, reason: 'share-role-denied' };
  }

  let projectName: string | null = null;
  if (target.kind === 'main') {
    const row = await db.queryOne<{ project_name: string; role: string }>(
      'SELECT project_name, role FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
      [params.serverId, target.sessionName],
    );
    projectName = row?.project_name ?? null;
  } else if (target.kind === 'subsession') {
    const row = await getSubSessionById(db, target.subSessionId, params.serverId);
    if (row?.parent_session) {
      const parent = await db.queryOne<{ project_name: string }>(
        'SELECT project_name FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
        [params.serverId, row.parent_session],
      );
      projectName = parent?.project_name ?? null;
    }
  }
  const server = await db.queryOne<{ user_id: string }>(
    'SELECT user_id FROM servers WHERE id = $1',
    [params.serverId],
  );
  // A whole-server grant intentionally has no project scope.  Session and
  // sub-session grants still require a live project so they cannot silently
  // widen to server visibility.
  if (!server || (target.kind !== 'server' && !projectName)) {
    return { ok: false, reason: 'share-target-unavailable' };
  }
  return {
    ok: true,
    scope: {
      ownerUserId: server.user_id,
      projectName,
      shared: true,
      sharedSessionName: sessionName,
      sharedTargetKind: target.kind,
    },
  };
}

async function resolveCronJobScope(
  c: Context<CronRouteEnv>,
  params: { userId: string; job: DbCronJob; mode: CronAccessMode; pinnedSessionName?: string | null; db?: Database },
): Promise<{ ok: true; scope: CronScope } | { ok: false; reason: string }> {
  const db = params.db ?? c.env.DB;
  const access = await resolveCronScope(c, {
    serverId: params.job.server_id,
    userId: params.userId,
    requestedProjectName: params.job.project_name,
    mode: params.mode,
    pinnedSessionName: params.pinnedSessionName,
    db,
  });
  if (!access.ok) return access;
  if (
    params.job.user_id !== access.scope.ownerUserId
    || (access.scope.projectName !== null && params.job.project_name !== access.scope.projectName)
  ) {
    return { ok: false, reason: 'share-direct-surface-denied' };
  }
  const action = parsePersistedCronAction(params.job.action).action;
  if (!await cronScopeCoversPayload(c, params.job.server_id, access.scope, {
    targetRole: params.job.target_role,
    targetSessionName: params.job.target_session_name,
    action,
  }, params.pinnedSessionName, db)) {
    return { ok: false, reason: 'share-direct-surface-denied' };
  }
  return access;
}

function cronPayloadSessionRefs(payload: {
  targetSessionName?: string | null;
  action?: z.infer<typeof cronActionSchema>;
}): string[] {
  const refs = new Set<string>();
  if (payload.targetSessionName) refs.add(payload.targetSessionName);
  const action = payload.action;
  if (action?.type === 'send' && action.target.startsWith('deck_')) refs.add(action.target);
  if (action?.type === 'p2p') {
    for (const entry of action.participantEntries ?? []) {
      if (entry.type === 'session') refs.add(entry.value);
    }
  }
  return [...refs];
}

function cronPayloadRoleRefs(payload: {
  action?: z.infer<typeof cronActionSchema>;
}): string[] {
  const refs = new Set<string>();
  const action = payload.action;
  if (action?.type === 'send' && rolePattern.test(action.target)) refs.add(action.target);
  if (action?.type === 'p2p') {
    for (const role of action.participants ?? []) refs.add(role);
    for (const entry of action.participantEntries ?? []) {
      if (entry.type === 'role') refs.add(entry.value);
    }
  }
  return [...refs];
}

async function sessionBelongsToProject(
  db: Database,
  serverId: string,
  sessionName: string,
  projectName: string,
): Promise<boolean> {
  const target = shareTargetFromSessionName(serverId, sessionName);
  if (!target) return false;
  if (target.kind === 'subsession') {
    const child = await getSubSessionById(db, target.subSessionId, serverId);
    if (!child || child.closed_at !== null || isExecutionCloneRow(child) || !child.parent_session) {
      return false;
    }
    const parent = await db.queryOne<{ project_name: string }>(
      'SELECT project_name FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
      [serverId, child.parent_session],
    );
    return parent?.project_name === projectName;
  }
  if (target.kind === 'main') {
    const row = await db.queryOne<{ project_name: string }>(
      'SELECT project_name FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
      [serverId, target.sessionName],
    );
    return row?.project_name === projectName;
  }
  return false;
}

async function cronScopeCoversPayload(
  c: Context<CronRouteEnv>,
  serverId: string,
  scope: CronScope,
  payload: { targetRole?: string | null; targetSessionName?: string | null; action?: z.infer<typeof cronActionSchema> },
  pinnedSessionName?: string | null,
  db: Database = c.env.DB,
): Promise<boolean> {
  if (pinnedSessionName && !pinnedSessionCoversPayload(pinnedSessionName, payload)) {
    return false;
  }
  if (!scope.shared) return true;
  if (!payload.action) return false;
  if (scope.sharedTargetKind === 'server') return true;
  if (!scope.projectName) return false;

  if (scope.sharedTargetKind === 'subsession') {
    if (!scope.sharedSessionName || payload.targetSessionName !== scope.sharedSessionName) {
      return false;
    }
    if (payload.action.type === 'send' && (payload.action.broadcast || payload.action.target !== scope.sharedSessionName)) {
      return false;
    }
    if (payload.action.type === 'p2p') {
      if ((payload.action.participants?.length ?? 0) > 0) return false;
      for (const entry of payload.action.participantEntries ?? []) {
        if (entry.type !== 'session' || entry.value !== scope.sharedSessionName) {
          return false;
        }
      }
    }
    return true;
  }

  if (payload.action.type === 'send') {
    if (payload.action.broadcast) return false;
    const rawTarget = payload.action.target.trim();
    if (!rolePattern.test(rawTarget) && !rawTarget.startsWith('deck_')) {
      return false;
    }
  }

  if (payload.targetSessionName) {
    if (!await sessionBelongsToProject(db, serverId, payload.targetSessionName, scope.projectName)) {
      return false;
    }
  } else if (payload.targetRole) {
    if (!rolePattern.test(payload.targetRole)) return false;
  }

  const roleRefs = cronPayloadRoleRefs(payload);
  for (const role of roleRefs) {
    if (!rolePattern.test(role)) return false;
  }

  const sessionRefs = cronPayloadSessionRefs(payload);
  for (const name of sessionRefs) {
    if (!await sessionBelongsToProject(db, serverId, name, scope.projectName)) {
      return false;
    }
  }

  return true;
}

function pinnedSessionCoversPayload(
  pinnedSessionName: string | null | undefined,
  payload: { targetRole?: string | null; targetSessionName?: string | null; action?: z.infer<typeof cronActionSchema> },
): boolean {
  if (!pinnedSessionName) return true;
  const isSubPinned = pinnedSessionName.startsWith('deck_sub_');
  const mainRoleMatch = !isSubPinned ? /^deck_.+_(brain|w\d+)$/.exec(pinnedSessionName) : null;
  const expectedMainRole = mainRoleMatch?.[1] ?? null;

  if (isSubPinned) {
    if (payload.targetSessionName !== pinnedSessionName) return false;
  } else if (payload.targetSessionName) {
    if (payload.targetSessionName !== pinnedSessionName) return false;
  } else if (!expectedMainRole || payload.targetRole !== expectedMainRole) {
    return false;
  }

  const action = payload.action;
  if (action?.type === 'send') {
    if (action.broadcast) return false;
    const allowedSendTarget = action.target === pinnedSessionName
      || (!isSubPinned && expectedMainRole !== null && action.target === expectedMainRole);
    if (!allowedSendTarget) return false;
  }
  if (action?.type === 'p2p') {
    if (isSubPinned && (action.participants?.length ?? 0) > 0) return false;
    if (!isSubPinned) {
      for (const role of action.participants ?? []) {
        if (!expectedMainRole || role !== expectedMainRole) return false;
      }
    }
    for (const entry of action.participantEntries ?? []) {
      if (entry.type === 'session') {
        if (entry.value !== pinnedSessionName) return false;
      } else if (isSubPinned || !expectedMainRole || entry.value !== expectedMainRole) {
        return false;
      }
    }
  }
  return true;
}

async function runCronWriteTx<T>(db: Database, fn: (tx: Database) => Promise<T>): Promise<T> {
  const txFn = (db as Database & { transaction?: (cb: (tx: Database) => Promise<unknown>) => Promise<unknown> }).transaction;
  if (typeof txFn === 'function') {
    return await txFn.call(db, fn) as T;
  }
  return await fn(db);
}

async function filterCronRowsForSharedScope<T extends {
  server_id: string;
  project_name?: string | null;
  target_role: string;
  target_session_name: string | null;
  action: string;
}>(c: Context<CronRouteEnv>, scope: CronScope, rows: T[], pinnedSessionName?: string | null): Promise<T[]> {
  if (!scope.shared && !pinnedSessionName) return rows;
  if (scope.shared && scope.sharedTargetKind !== 'server' && !scope.projectName) return [];
  const checks = await Promise.all(rows.map(async (row) => {
    if (scope.shared && scope.sharedTargetKind !== 'server' && row.project_name !== scope.projectName) return false;
    const action = parsePersistedCronAction(row.action).action;
    return await cronScopeCoversPayload(c, row.server_id, scope, {
      targetRole: row.target_role,
      targetSessionName: row.target_session_name,
      action,
    }, pinnedSessionName);
  }));
  return rows.filter((_, index) => checks[index]);
}

/**
 * Every cron route needs a real credential: a session cookie, a user bearer / API key, or the daemon's server token
 * (`Authorization: Bearer <server token>` + `X-Server-Id`). A request with none is refused with 401 and touches nothing.
 *
 * Until now a route carrying `:serverId` and neither header was treated as the local daemon: it was given the server
 * owner's identity and the daemon-attested flag. The serverId is not a secret (share recipients and group members receive
 * it, it is in URLs and logs), so anyone could create, read, change and trigger the owner's cron jobs -- jobs that inject
 * prompts or commands into the owner's agent sessions. A daemon from before this change still sends no credential: it is
 * told so by name (`CRON_API_AUTH_ERRORS.DAEMON_CREDENTIAL_REQUIRED`) instead of a bare 401, and the open path stays shut.
 */
function requireCronAuth() {
  const authenticate = requireAuth();
  return async (c: Context<CronRouteEnv>, next: Next): Promise<Response | void> => {
    const result = await authenticate(c as unknown as Context<{ Bindings: Env }>, next);
    // Only the refusal's wording is ours: a daemon that names its server but sends no credential at all is told what to do.
    if (result instanceof Response && result.status === 401 && !c.req.header(AUTHORIZATION_HEADER) && !c.req.header('Cookie') && c.req.header(SERVER_ID_HEADER)) {
      return c.json({ error: CRON_API_AUTH_ERRORS.DAEMON_CREDENTIAL_REQUIRED }, 401);
    }
    return result;
  };
}

function normalizeCronActionForPersistence<T extends z.infer<typeof cronActionSchema>>(
  action: T,
  daemonAttested: boolean,
): T {
  if (daemonAttested || action.type !== 'send') return action;
  return stripMemoryMcpSourceProvenance(action) as T;
}

function registerSelfManagedCronAction(
  action: z.infer<typeof cronActionSchema>,
  scheduleId: string,
  completionPolicy: z.infer<typeof cronJobCreateSchema>['completionPolicy'],
): { ok: true; action: CronAction } | { ok: false; reason: string } {
  if (action.type !== 'command' || action.selfManaged !== true) return { ok: true, action };
  const registered = registerCronControlAction(action, scheduleId, completionPolicy);
  return registered.ok
    ? { ok: true, action: registered.action }
    : { ok: false, reason: registered.reason };
}

/** Validate cron expression and enforce minimum 5-minute interval. Returns next run time or error details. */
function validateCronExpr(cronExpr: string, timezone?: string) {
  return validateCronScheduleWithSampler(
    () => sampleCronOccurrences(new Cron(cronExpr, timezone ? { timezone } : undefined)),
    MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES,
  );
}

function registerCronApiRoutes(router: Hono<CronRouteEnv>): void {
// GET /api/cron — list user's cron jobs, optionally filtered by server/project
router.get('/', requireCronAuth(), async (c) => {
  const routeServerId = getPodStickyServerId(c);
  const requestedServerId = routeServerId ?? c.req.query('serverId') ?? null;
  const authority = await resolveCronDaemonContext(c, requestedServerId);
  if (!authority.ok) return daemonScopeFailure(c as unknown as Context<{ Bindings: Env }>, authority);
  const userId = authority.actorUserId;
  const serverId = requestedServerId
    ?? (authority.kind === 'participant_daemon' ? authority.sourceServerId : null);
  const projectName = c.req.query('projectName') || null;
  const pinnedSessionName = pinnedSessionForAuthority(authority);

  const access = serverId
    ? await resolveCronScope(c, { serverId, userId, requestedProjectName: projectName, mode: 'read', pinnedSessionName })
    : { ok: true as const, scope: { ownerUserId: userId, projectName, shared: false, sharedSessionName: null, sharedTargetKind: null } };
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);

  // A whole-server share is intentionally unscoped, but an explicit project
  // query still narrows the list. Session-scoped shares must use their
  // resolved project instead of trusting a forged query value.
  const externalCliRestricted = isExternalCliRestrictedAuthority(c, routeServerId, authority);
  const queryProjectName = access.scope.sharedTargetKind === 'server'
    ? projectName
    : access.scope.projectName;
  const jobs = await c.env.DB.query<DbCronJob>(
    `SELECT j.*,
            COALESCE(p.creator_user_id, j.user_id) AS creator_user_id,
            COALESCE(NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(u.username), '')) AS creator_name,
            COALESCE(p.shared, FALSE) AS creator_is_shared
       FROM cron_jobs j
       LEFT JOIN cron_job_provenance p ON p.job_id = j.id
       LEFT JOIN users u ON u.id = COALESCE(p.creator_user_id, j.user_id)
      WHERE j.user_id = $1
        AND ($2::text IS NULL OR j.server_id = $2)
        AND ($3::text IS NULL OR j.project_name = $3)
        AND ($4::text IS NULL OR p.creator_user_id = $4)
      ORDER BY j.created_at DESC`,
    [
      access.scope.ownerUserId,
      serverId,
      queryProjectName,
      externalCliRestricted ? IMCODES_EXTERNAL_CLI_SENDER : null,
    ],
  );
  const filteredJobs = (await filterCronRowsForSharedScope(c, access.scope, jobs, pinnedSessionName)).map((job) => ({
    ...job,
    action: unwrapCronActionStringForResponse(job.action),
  }));
  return c.json({
    jobs: externalCliRestricted
      ? filteredJobs.filter((job) => isExternalCliOwnedProvenance({
          creator_user_id: (job as { creator_user_id?: string | null }).creator_user_id,
        }))
      : filteredJobs,
  });
});

// POST /api/cron — create a cron job
router.post('/', requireCronAuth(), async (c) => {
  const preAuthority = await resolveCronDaemonContext(c, getPodStickyServerId(c));
  if (!preAuthority.ok) return daemonScopeFailure(c as unknown as Context<{ Bindings: Env }>, preAuthority);
  const userId = preAuthority.actorUserId;
  const routeServerId = getPodStickyServerId(c);
  const body = await c.req.json().catch(() => null);
  const requestBody = await withDefaultCronTimezone(c, userId, withPodStickyServerId(body, routeServerId));
  const parsed = cronJobCreateSchema.safeParse(requestBody);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const {
    name,
    cronExpr,
    shortIntervalReason,
    serverId,
    projectName,
    targetRole,
    targetSessionName,
    action,
    timezone,
    expiresAt,
    completionPolicy,
  } = parsed.data;
  const authority = await resolveCronDaemonContext(c, serverId);
  if (!authority.ok) return daemonScopeFailure(c as unknown as Context<{ Bindings: Env }>, authority);
  const pinnedSessionName = pinnedSessionForAuthority(authority);
  const externalCliRestricted = isExternalCliRestrictedAuthority(c, routeServerId, authority);
  const isDaemonReq = isDaemonCronRequest(c, routeServerId, authority.kind);
  const isAgentCaller = authority.isDaemon || isDaemonReq;
  const unboundAction = normalizeCronActionForPersistence(action, isDaemonReq);
  if (externalCliRestricted && !isAllowedExternalCliRestrictedCronAction(unboundAction)) {
    return c.json({ error: 'forbidden', reason: 'external_cli_cron_action_not_allowed' }, 403);
  }

  const access = await resolveCronScope(c, {
    serverId,
    userId: authority.actorUserId,
    requestedProjectName: projectName,
    mode: 'write',
    pinnedSessionName,
  });
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);
  if (!await cronScopeCoversPayload(c, serverId, access.scope, { targetRole, targetSessionName, action }, pinnedSessionName)) {
    return c.json({ error: 'forbidden', reason: 'share-direct-surface-denied' }, 403);
  }

  const validation = validateCronExpr(cronExpr, timezone);
  if ('error' in validation) {
    return c.json({
      error: validation.error,
      ...(validation.error === 'cron_interval_too_short'
        ? { minIntervalMinutes: validation.minIntervalMinutes, message: validation.message }
        : {}),
    }, 400);
  }
  const justification = checkAgentShortIntervalJustification({
    isAgentOrDaemon: isAgentCaller,
    intervalMs: validation.intervalMs,
    shortIntervalReason,
  });
  if (!justification.ok) {
    return c.json({
      error: justification.error,
      thresholdMinutes: justification.thresholdMinutes,
      message: justification.message,
    }, 400);
  }

  const id = randomHex(16);
  const now = Date.now();
  const registeredAction = registerSelfManagedCronAction(unboundAction, id, completionPolicy);
  if (!registeredAction.ok) {
    return c.json({ error: 'invalid_cron_control', reason: registeredAction.reason }, 400);
  }
  const persistedAction = normalizeCronSendActionForInterval(
    registeredAction.action,
    validation.intervalMs,
  );

  const storedAction = serializeCronActionForStorage(persistedAction, externalCliRestricted);

  const requiresProvenance = externalCliRestricted || access.scope.shared || authority.kind === 'participant_daemon' || authority.actorUserId !== access.scope.ownerUserId;
  const provenanceCreatorUserId = externalCliRestricted ? IMCODES_EXTERNAL_CLI_SENDER : authority.actorUserId;
  // Every non-owner provenance row (shared participants AND external_cli) sets shared=TRUE
  // so older schedulers that do not understand IMCODES_EXTERNAL_CLI_SENDER fail closed
  // (`{ authorized: false }`) instead of elevating it to owner authority.
  const provenanceShared = true;
  await runCronWriteTx(c.env.DB, async (tx) => {
    await tx.execute(
      `INSERT INTO cron_jobs (id, server_id, user_id, name, cron_expr, project_name, target_role, target_session_name, action, timezone, status, next_run_at, expires_at, completion_policy, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)`,
      [id, serverId, access.scope.ownerUserId, name, cronExpr, access.scope.projectName ?? projectName, targetRole, targetSessionName ?? null, storedAction, timezone ?? null, CRON_STATUS.ACTIVE, validation.nextRunAt, expiresAt ?? null, completionPolicy, now],
    );
    if (requiresProvenance) {
      await tx.execute(
        `INSERT INTO cron_job_provenance (job_id, creator_user_id, server_id, project_name, shared, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (job_id) DO NOTHING`,
        [id, provenanceCreatorUserId, serverId, access.scope.projectName ?? projectName ?? null, provenanceShared, now],
      );
    }
  });

  await logAudit({ userId: authority.actorUserId, action: 'cron.create', details: { id, name, cronExpr, projectName: access.scope.projectName ?? projectName } }, c.env.DB);
  // Notify open browser views (incl. crons created externally via MCP) to refetch.
  WsBridge.publishResourceChanged(serverId, RESOURCE_TOPICS.cron, { action: 'create' });

  return c.json({
    id,
    name,
    cronExpr,
    projectName: access.scope.projectName ?? projectName,
    targetRole,
    targetSessionName: targetSessionName ?? null,
    action: persistedAction,
    timezone: timezone ?? null,
    status: CRON_STATUS.ACTIVE,
    nextRunAt: validation.nextRunAt,
    expiresAt: expiresAt ?? null,
    completionPolicy,
  }, 201);
});

// PUT /api/cron/:id — update a cron job
router.put('/:id', requireCronAuth(), async (c) => {
  const preAuthority = await resolveCronDaemonContext(c, getPodStickyServerId(c));
  if (!preAuthority.ok) return daemonScopeFailure(c as unknown as Context<{ Bindings: Env }>, preAuthority);
  const userId = preAuthority.actorUserId;
  const routeServerId = getPodStickyServerId(c);
  const jobId = c.req.param('id');
  if (!jobId) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = cronJobUpdateSchema.safeParse(await withDefaultCronTimezone(c, userId, body));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const initialJob = await c.env.DB.queryOne<DbCronJob>(
    'SELECT * FROM cron_jobs WHERE id = $1',
    [jobId],
  );
  if (!initialJob) return c.json({ error: 'not_found' }, 404);
  if (isWrongPodStickyServer(initialJob.server_id, routeServerId)) return c.json({ error: 'not_found' }, 404);
  const authority = await resolveCronDaemonContext(c, initialJob.server_id);
  if (!authority.ok) return daemonScopeFailure(c as unknown as Context<{ Bindings: Env }>, authority);
  const pinnedSessionName = pinnedSessionForAuthority(authority);
  const externalCliRestricted = isExternalCliRestrictedAuthority(c, routeServerId, authority);
  const isDaemonReq = isDaemonCronRequest(c, routeServerId, authority.kind);
  const isAgentCaller = authority.isDaemon || isDaemonReq;
  const forceFlag = c.req.query('force') === 'true';

  type PutTxResult =
    | { kind: 'ok'; serverId: string; completionPolicy?: string }
    | { kind: 'not_found' }
    | { kind: 'conflict' }
    | { kind: 'forbidden'; reason: string }
    | { kind: 'force_required'; completionPolicy: string }
    | { kind: 'invalid_expr'; error: string; minIntervalMinutes?: number; message?: string }
    | { kind: 'short_interval_reason_required'; error: 'cron_short_interval_reason_required'; thresholdMinutes: number; message: string }
    | { kind: 'invalid_control'; reason: string };

  const txResult: PutTxResult = await runCronWriteTx(c.env.DB, async (tx): Promise<PutTxResult> => {
    const lockedJob = await tx.queryOne<DbCronJob>(
      'SELECT * FROM cron_jobs WHERE id = $1 FOR UPDATE',
      [jobId],
    );
    if (!lockedJob || isWrongPodStickyServer(lockedJob.server_id, routeServerId)) {
      return { kind: 'not_found' };
    }
    const lockedProv = await tx.queryOne<{ creator_user_id?: string; shared?: boolean }>(
      'SELECT creator_user_id, shared FROM cron_job_provenance WHERE job_id = $1 FOR UPDATE',
      [jobId],
    );
    const lockedIsExternalCli = isExternalCliOwnedProvenance(lockedProv);
    if (lockedJob.server_id !== initialJob.server_id || lockedJob.user_id !== initialJob.user_id) {
      return { kind: 'conflict' };
    }
    if (externalCliRestricted && !lockedIsExternalCli) {
      return { kind: 'forbidden', reason: 'external_cli_cron_scope_denied' };
    }

    const access = await resolveCronJobScope(c, {
      userId: authority.actorUserId,
      job: lockedJob,
      mode: 'write',
      pinnedSessionName,
      db: tx,
    });
    if (!access.ok) return { kind: 'forbidden', reason: access.reason };

    const updates = { ...parsed.data };
    if (access.scope.shared) updates.projectName = access.scope.projectName ?? undefined;
    const existingParsed = parsePersistedCronAction(lockedJob.action);
    const existingAction = existingParsed.action;
    const restrictAsExternalCli = externalCliRestricted || lockedIsExternalCli;
    if (restrictAsExternalCli && !isAllowedExternalCliRestrictedCronAction(updates.action ?? existingAction)) {
      return { kind: 'forbidden', reason: 'external_cli_cron_action_not_allowed' };
    }
    if (!await cronScopeCoversPayload(c, lockedJob.server_id, access.scope, {
      targetRole: updates.targetRole !== undefined ? updates.targetRole : lockedJob.target_role,
      targetSessionName: updates.targetSessionName !== undefined ? updates.targetSessionName : lockedJob.target_session_name,
      action: updates.action ?? existingAction,
    }, pinnedSessionName, tx)) {
      return { kind: 'forbidden', reason: 'share-direct-surface-denied' };
    }

    const now = Date.now();
    if (
      isDaemonReq
      && normalizeCronCompletionPolicy(lockedJob.completion_policy) === CRON_COMPLETION_POLICY.RECURRING
      && updates.completionPolicy === CRON_COMPLETION_POLICY.UNTIL_COMPLETE
      && !forceFlag
    ) {
      return { kind: 'force_required', completionPolicy: CRON_COMPLETION_POLICY.RECURRING };
    }

    let nextRunAt: number | undefined;
    let effectiveIntervalMs: number | null | undefined;
    const newCronExpr = updates.cronExpr;
    const effectiveTz = updates.timezone ?? lockedJob.timezone ?? undefined;
    const cronExprChanged = newCronExpr !== undefined && newCronExpr !== lockedJob.cron_expr;
    const scheduleChanged = cronExprChanged
      || (updates.timezone !== undefined && updates.timezone !== lockedJob.timezone);
    if (scheduleChanged) {
      const validation = validateCronExpr(newCronExpr ?? lockedJob.cron_expr, effectiveTz);
      if ('error' in validation) {
        return {
          kind: 'invalid_expr',
          error: validation.error,
          ...(validation.error === 'cron_interval_too_short'
            ? { minIntervalMinutes: validation.minIntervalMinutes, message: validation.message }
            : {}),
        };
      }
      if (cronExprChanged) {
        const justification = checkAgentShortIntervalJustification({
          isAgentOrDaemon: isAgentCaller,
          intervalMs: validation.intervalMs,
          shortIntervalReason: updates.shortIntervalReason,
        });
        if (!justification.ok) {
          return {
            kind: 'short_interval_reason_required',
            error: justification.error,
            thresholdMinutes: justification.thresholdMinutes,
            message: justification.message,
          };
        }
      }
      nextRunAt = validation.nextRunAt;
      effectiveIntervalMs = validation.intervalMs;
    }

    const sets: string[] = ['updated_at = $1'];
    const vals: unknown[] = [now];
    let idx = 2;

    if (effectiveIntervalMs === undefined && (updates.action !== undefined || existingAction?.type === 'send')) {
      const scheduleValidation = validateCronExpr(newCronExpr ?? lockedJob.cron_expr, effectiveTz);
      if (!('error' in scheduleValidation)) effectiveIntervalMs = scheduleValidation.intervalMs;
    }

    if (updates.action === undefined && existingAction && existingAction.type !== 'p2p') {
      const normalizedExistingAction = normalizeCronSendActionForInterval(existingAction, effectiveIntervalMs);
      if (normalizedExistingAction !== existingAction || (restrictAsExternalCli && !existingParsed.wrapped)) {
        sets.push(`action = $${idx++}`);
        vals.push(serializeCronActionForStorage(normalizedExistingAction, restrictAsExternalCli));
      }
    }

    if (updates.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(updates.name); }
    if (updates.cronExpr !== undefined) { sets.push(`cron_expr = $${idx++}`); vals.push(updates.cronExpr); }
    if (updates.projectName !== undefined) { sets.push(`project_name = $${idx++}`); vals.push(updates.projectName); }
    if (updates.targetRole !== undefined) { sets.push(`target_role = $${idx++}`); vals.push(updates.targetRole); }
    if (updates.targetSessionName !== undefined) { sets.push(`target_session_name = $${idx++}`); vals.push(updates.targetSessionName); }
    if (updates.action !== undefined) {
      const unboundAction = normalizeCronActionForPersistence(updates.action, isDaemonReq);
      const registeredAction = registerSelfManagedCronAction(
        unboundAction,
        jobId,
        updates.completionPolicy ?? normalizeCronCompletionPolicy(lockedJob.completion_policy),
      );
      if (!registeredAction.ok) {
        return { kind: 'invalid_control', reason: registeredAction.reason };
      }
      const normalizedAction = normalizeCronSendActionForInterval(
        registeredAction.action,
        effectiveIntervalMs,
      );
      sets.push(`action = $${idx++}`);
      vals.push(serializeCronActionForStorage(normalizedAction, restrictAsExternalCli));
    }
    if (updates.timezone !== undefined) { sets.push(`timezone = $${idx++}`); vals.push(updates.timezone); }
    if (updates.expiresAt !== undefined) { sets.push(`expires_at = $${idx++}`); vals.push(updates.expiresAt); }
    if (updates.completionPolicy !== undefined) { sets.push(`completion_policy = $${idx++}`); vals.push(updates.completionPolicy); }
    if (nextRunAt !== undefined) { sets.push(`next_run_at = $${idx++}`); vals.push(nextRunAt); }

    if (lockedJob.status === CRON_STATUS.EXPIRED || lockedJob.status === CRON_STATUS.ERROR) {
      sets.push(`status = $${idx++}`); vals.push(CRON_STATUS.PAUSED);
    }

    const updatedAtIdx = idx++;
    const idIdx = idx;
    const upd = await tx.execute(
      `UPDATE cron_jobs SET ${sets.join(', ')} WHERE updated_at IS NOT DISTINCT FROM $${updatedAtIdx} AND id = $${idIdx}`,
      [...vals, lockedJob.updated_at ?? null, jobId],
    );
    if (upd.changes !== 1) {
      return { kind: 'conflict' };
    }

    const isSharedOrNonOwner = access.scope.shared || authority.kind === 'participant_daemon' || authority.actorUserId !== access.scope.ownerUserId;
    if (externalCliRestricted || lockedIsExternalCli) {
      // External-CLI restricted provenance (`creator_user_id = IMCODES_EXTERNAL_CLI_SENDER, shared = TRUE`)
      // is an upper bound on this job and must survive owner/participant maintenance edits.
      if (lockedIsExternalCli && (!lockedProv?.shared || updates.projectName !== undefined)) {
        await tx.execute(
          'UPDATE cron_job_provenance SET shared = TRUE, project_name = COALESCE($1, project_name) WHERE job_id = $2',
          [updates.projectName ?? null, jobId],
        );
      }
    } else if (isSharedOrNonOwner) {
      await tx.execute(
        `INSERT INTO cron_job_provenance (job_id, creator_user_id, server_id, project_name, shared, created_at)
         VALUES ($1, $2, $3, $4, TRUE, $5)
         ON CONFLICT (job_id) DO UPDATE
           SET creator_user_id = EXCLUDED.creator_user_id,
               server_id = EXCLUDED.server_id,
               project_name = EXCLUDED.project_name,
               shared = TRUE`,
        [jobId, authority.actorUserId, lockedJob.server_id, updates.projectName ?? lockedJob.project_name ?? null, now],
      );
    } else if (lockedProv) {
      await tx.execute(
        'DELETE FROM cron_job_provenance WHERE job_id = $1',
        [jobId],
      );
    }
    return { kind: 'ok', serverId: lockedJob.server_id, completionPolicy: updates.completionPolicy };
  });

  if (txResult.kind === 'not_found') return c.json({ error: 'not_found' }, 404);
  if (txResult.kind === 'conflict') return c.json({ error: 'cron_concurrent_modification' }, 409);
  if (txResult.kind === 'forbidden') return c.json({ error: 'forbidden', reason: txResult.reason }, 403);
  if (txResult.kind === 'force_required') {
    return c.json({
      error: 'cron_force_required',
      completionPolicy: txResult.completionPolicy,
      message: 'Changing a recurring cron to until_complete from an agent requires force=true',
    }, 409);
  }
  if (txResult.kind === 'invalid_expr') {
    return c.json({
      error: txResult.error,
      ...(txResult.minIntervalMinutes !== undefined ? { minIntervalMinutes: txResult.minIntervalMinutes } : {}),
      ...(txResult.message !== undefined ? { message: txResult.message } : {}),
    }, 400);
  }
  if (txResult.kind === 'short_interval_reason_required') {
    return c.json({
      error: txResult.error,
      thresholdMinutes: txResult.thresholdMinutes,
      message: txResult.message,
    }, 400);
  }
  if (txResult.kind === 'invalid_control') {
    return c.json({ error: 'invalid_cron_control', reason: txResult.reason }, 400);
  }

  await logAudit({
    userId,
    action: 'cron.update',
    details: {
      id: jobId,
      ...(txResult.completionPolicy !== undefined
        ? {
          completionPolicy: txResult.completionPolicy,
          forced: isDaemonCronRequest(c, routeServerId) ? forceFlag : false,
        }
        : {}),
    },
  }, c.env.DB);
  WsBridge.publishResourceChanged(txResult.serverId, RESOURCE_TOPICS.cron, { action: 'update' });
  return c.json({ ok: true });
});

// PATCH /api/cron/:id/status — pause/resume (only active ↔ paused)
router.patch('/:id/status', requireCronAuth(), async (c) => {
  const preAuthority = await resolveCronDaemonContext(c, getPodStickyServerId(c));
  if (!preAuthority.ok) return daemonScopeFailure(c as unknown as Context<{ Bindings: Env }>, preAuthority);
  const routeServerId = getPodStickyServerId(c);
  const jobId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const newStatus = (body as Record<string, unknown> | null)?.status;
  if (newStatus !== CRON_STATUS.ACTIVE && newStatus !== CRON_STATUS.PAUSED) {
    return c.json({ error: 'invalid_status' }, 400);
  }

  const initialJob = await c.env.DB.queryOne<DbCronJob>(
    'SELECT * FROM cron_jobs WHERE id = $1',
    [jobId],
  );
  if (!initialJob) return c.json({ error: 'not_found' }, 404);
  if (isWrongPodStickyServer(initialJob.server_id, routeServerId)) return c.json({ error: 'not_found' }, 404);
  const authority = await resolveCronDaemonContext(c, initialJob.server_id);
  if (!authority.ok) return daemonScopeFailure(c as unknown as Context<{ Bindings: Env }>, authority);
  const userId = authority.actorUserId;
  const pinnedSessionName = pinnedSessionForAuthority(authority);
  const externalCliRestricted = isExternalCliRestrictedAuthority(c, routeServerId, authority);

  type StatusTxResult =
    | { kind: 'ok'; serverId: string }
    | { kind: 'not_found' }
    | { kind: 'conflict' }
    | { kind: 'forbidden'; reason: string }
    | { kind: 'cannot_resume'; currentStatus: string };

  const txResult: StatusTxResult = await runCronWriteTx(c.env.DB, async (tx): Promise<StatusTxResult> => {
    const lockedJob = await tx.queryOne<DbCronJob>(
      'SELECT * FROM cron_jobs WHERE id = $1 FOR UPDATE',
      [jobId],
    );
    if (!lockedJob || isWrongPodStickyServer(lockedJob.server_id, routeServerId)) return { kind: 'not_found' };
    if (externalCliRestricted) {
      const lockedProv = await tx.queryOne<{ creator_user_id?: string; shared?: boolean }>(
        'SELECT creator_user_id, shared FROM cron_job_provenance WHERE job_id = $1 FOR UPDATE',
        [jobId],
      );
      if (!isExternalCliOwnedProvenance(lockedProv)) {
        return { kind: 'forbidden', reason: 'external_cli_cron_scope_denied' };
      }
    }
    const access = await resolveCronJobScope(c, { userId, job: lockedJob, mode: 'write', pinnedSessionName, db: tx });
    if (!access.ok) return { kind: 'forbidden', reason: access.reason };
    if (newStatus === CRON_STATUS.ACTIVE && lockedJob.status !== CRON_STATUS.PAUSED) {
      return { kind: 'cannot_resume', currentStatus: lockedJob.status };
    }
    const upd = await tx.execute(
      'UPDATE cron_jobs SET status = $1, updated_at = $2 WHERE updated_at IS NOT DISTINCT FROM $3 AND id = $4',
      [newStatus, Date.now(), lockedJob.updated_at ?? null, jobId],
    );
    if (upd.changes !== 1) return { kind: 'conflict' };
    return { kind: 'ok', serverId: lockedJob.server_id };
  });

  if (txResult.kind === 'not_found') return c.json({ error: 'not_found' }, 404);
  if (txResult.kind === 'conflict') return c.json({ error: 'cron_concurrent_modification' }, 409);
  if (txResult.kind === 'forbidden') return c.json({ error: 'forbidden', reason: txResult.reason }, 403);
  if (txResult.kind === 'cannot_resume') return c.json({ error: 'cannot_resume', currentStatus: txResult.currentStatus }, 400);

  await logAudit({ userId, action: 'cron.status', details: { id: jobId, status: newStatus } }, c.env.DB);
  WsBridge.publishResourceChanged(txResult.serverId, RESOURCE_TOPICS.cron, { action: 'status' });
  return c.json({ ok: true });
});

// DELETE /api/cron/:id — delete a cron job
router.delete('/:id', requireCronAuth(), async (c) => {
  const preAuthority = await resolveCronDaemonContext(c, getPodStickyServerId(c));
  if (!preAuthority.ok) return daemonScopeFailure(c as unknown as Context<{ Bindings: Env }>, preAuthority);
  const routeServerId = getPodStickyServerId(c);
  const jobId = c.req.param('id');

  const initialJob = await c.env.DB.queryOne<DbCronJob>(
    'SELECT * FROM cron_jobs WHERE id = $1',
    [jobId],
  );
  if (!initialJob) return c.json({ error: 'not_found' }, 404);
  if (isWrongPodStickyServer(initialJob.server_id, routeServerId)) return c.json({ error: 'not_found' }, 404);
  const authority = await resolveCronDaemonContext(c, initialJob.server_id);
  if (!authority.ok) return daemonScopeFailure(c as unknown as Context<{ Bindings: Env }>, authority);
  const userId = authority.actorUserId;
  const pinnedSessionName = pinnedSessionForAuthority(authority);
  const externalCliRestricted = isExternalCliRestrictedAuthority(c, routeServerId, authority);
  const isDaemonReq = isDaemonCronRequest(c, routeServerId, authority.kind);
  const force = c.req.query('force') === 'true';

  type DeleteTxResult =
    | { kind: 'ok'; serverId: string; completionPolicy: string }
    | { kind: 'not_found' }
    | { kind: 'conflict' }
    | { kind: 'forbidden'; reason: string }
    | { kind: 'force_required'; completionPolicy: string };

  const txResult: DeleteTxResult = await runCronWriteTx(c.env.DB, async (tx): Promise<DeleteTxResult> => {
    const lockedJob = await tx.queryOne<DbCronJob>(
      'SELECT * FROM cron_jobs WHERE id = $1 FOR UPDATE',
      [jobId],
    );
    if (!lockedJob || isWrongPodStickyServer(lockedJob.server_id, routeServerId)) return { kind: 'not_found' };
    if (externalCliRestricted) {
      const lockedProv = await tx.queryOne<{ creator_user_id?: string; shared?: boolean }>(
        'SELECT creator_user_id, shared FROM cron_job_provenance WHERE job_id = $1 FOR UPDATE',
        [jobId],
      );
      if (!isExternalCliOwnedProvenance(lockedProv)) {
        return { kind: 'forbidden', reason: 'external_cli_cron_scope_denied' };
      }
    }
    const access = await resolveCronJobScope(c, { userId, job: lockedJob, mode: 'write', pinnedSessionName, db: tx });
    if (!access.ok) return { kind: 'forbidden', reason: access.reason };
    const completionPolicy = normalizeCronCompletionPolicy(lockedJob.completion_policy);
    if (isDaemonReq && completionPolicy === CRON_COMPLETION_POLICY.RECURRING && !force) {
      return { kind: 'force_required', completionPolicy };
    }
    const del = await tx.execute(
      'DELETE FROM cron_jobs WHERE id = $1 AND updated_at IS NOT DISTINCT FROM $2',
      [jobId, lockedJob.updated_at ?? null],
    );
    if (del.changes !== 1) return { kind: 'conflict' };
    return { kind: 'ok', serverId: lockedJob.server_id, completionPolicy };
  });

  if (txResult.kind === 'not_found') return c.json({ error: 'not_found' }, 404);
  if (txResult.kind === 'conflict') return c.json({ error: 'cron_concurrent_modification' }, 409);
  if (txResult.kind === 'forbidden') return c.json({ error: 'forbidden', reason: txResult.reason }, 403);
  if (txResult.kind === 'force_required') {
    return c.json({
      error: 'cron_force_required',
      completionPolicy: txResult.completionPolicy,
      message: 'Deleting a recurring cron from an agent requires force=true',
    }, 409);
  }

  await logAudit({
    userId,
    action: 'cron.delete',
    details: {
      id: jobId,
      completionPolicy: txResult.completionPolicy,
      forced: isDaemonReq ? force : false,
    },
  }, c.env.DB);
  WsBridge.publishResourceChanged(txResult.serverId, RESOURCE_TOPICS.cron, { action: 'delete' });
  return c.json({ ok: true });
});

// POST /api/cron/:id/trigger — immediately dispatch a cron job
router.post('/:id/trigger', requireCronAuth(), async (c) => {
  const preAuthority = await resolveCronDaemonContext(c, getPodStickyServerId(c));
  if (!preAuthority.ok) return daemonScopeFailure(c as unknown as Context<{ Bindings: Env }>, preAuthority);
  const routeServerId = getPodStickyServerId(c);
  const jobId = c.req.param('id');
  if (!jobId) return c.json({ error: 'not_found' }, 404);

  const initialJob = await c.env.DB.queryOne<DbCronJob>(
    'SELECT * FROM cron_jobs WHERE id = $1',
    [jobId],
  );
  if (!initialJob) return c.json({ error: 'not_found' }, 404);
  if (isWrongPodStickyServer(initialJob.server_id, routeServerId)) return c.json({ error: 'not_found' }, 404);
  const authority = await resolveCronDaemonContext(c, initialJob.server_id);
  if (!authority.ok) return daemonScopeFailure(c as unknown as Context<{ Bindings: Env }>, authority);
  const userId = authority.actorUserId;
  const pinnedSessionName = pinnedSessionForAuthority(authority);
  const externalCliRestricted = isExternalCliRestrictedAuthority(c, routeServerId, authority);

  type TriggerTxResult =
    | { kind: 'ok'; job: DbCronJob; provenance: CronProvenanceLookup }
    | { kind: 'not_found' }
    | { kind: 'conflict' }
    | { kind: 'forbidden'; reason: string };

  const txResult: TriggerTxResult = await runCronWriteTx(c.env.DB, async (tx): Promise<TriggerTxResult> => {
    const locked = await readCronJobAndProvenanceLocked(tx, jobId);
    if (!locked.job || isWrongPodStickyServer(locked.job.server_id, routeServerId)) {
      return { kind: 'not_found' };
    }
    if (!locked.provenance.ok) {
      throw locked.provenance.error instanceof Error
        ? locked.provenance.error
        : new Error('cron_provenance_read_failed');
    }
    if (locked.job.server_id !== initialJob.server_id || locked.job.user_id !== initialJob.user_id) {
      return { kind: 'conflict' };
    }
    if (externalCliRestricted && !isExternalCliOwnedProvenance(locked.provenance.row)) {
      return { kind: 'forbidden', reason: 'external_cli_cron_scope_denied' };
    }

    const access = await resolveCronJobScope(c, {
      userId,
      job: locked.job,
      mode: 'write',
      pinnedSessionName,
      db: tx,
    });
    if (!access.ok) return { kind: 'forbidden', reason: access.reason };
    const lockedIsExternalCli = isExternalCliOwnedProvenance(locked.provenance.row);
    const isSharedTrigger = !externalCliRestricted && !lockedIsExternalCli && (
      access.scope.shared
      || authority.kind === 'participant_daemon'
      || authority.actorUserId !== locked.job.user_id
    );
    const effectiveProvenance: CronProvenanceLookup = isSharedTrigger
      ? { ok: true, row: { creator_user_id: authority.actorUserId, shared: true } }
      : locked.provenance;
    return { kind: 'ok', job: locked.job, provenance: effectiveProvenance };
  });

  if (txResult.kind === 'not_found') return c.json({ error: 'not_found' }, 404);
  if (txResult.kind === 'conflict') return c.json({ error: 'cron_concurrent_modification' }, 409);
  if (txResult.kind === 'forbidden') return c.json({ error: 'forbidden', reason: txResult.reason }, 403);

  try {
    await dispatchJobNow(c.env, txResult.job, {
      skipReload: true,
      verifiedProvenance: txResult.provenance,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 400);
  }

  await logAudit({ userId, action: 'cron.manual_trigger', details: { id: jobId } }, c.env.DB);
  return c.json({ ok: true });
});

// GET /api/cron/executions — cross-job execution list
// mode=latest: most recent execution per job; mode=all: all executions sorted by time
router.get('/executions', requireCronAuth(), async (c) => {
  const mode = c.req.query('mode') || 'all';
  const routeServerId = getPodStickyServerId(c);
  const requestedServerId = routeServerId ?? c.req.query('serverId') ?? null;
  const authority = await resolveCronDaemonContext(c, requestedServerId);
  if (!authority.ok) return daemonScopeFailure(c as unknown as Context<{ Bindings: Env }>, authority);
  const userId = authority.actorUserId;
  const serverId = requestedServerId
    ?? (authority.kind === 'participant_daemon' ? authority.sourceServerId : null);
  const requestedProjectName = c.req.query('projectName') || null;
  const pinnedSessionName = pinnedSessionForAuthority(authority);
  const externalCliRestricted = isExternalCliRestrictedAuthority(c, routeServerId, authority);
  const limitParam = parseInt(c.req.query('limit') || '50', 10);
  const limit = Math.min(Math.max(1, limitParam), 200);
  const access = serverId
    ? await resolveCronScope(c, { serverId, userId, requestedProjectName, mode: 'read', pinnedSessionName })
    : { ok: true as const, scope: { ownerUserId: userId, projectName: requestedProjectName, shared: false, sharedSessionName: null, sharedTargetKind: null } };
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);

  const filterExternalCliExecutions = <T extends Record<string, unknown>>(rows: T[]): T[] => (
    externalCliRestricted
      ? rows.filter((row) => isExternalCliOwnedProvenance({
          creator_user_id: (row as { creator_user_id?: string | null }).creator_user_id,
        }))
      : rows
  );

  if (mode === 'latest') {
    // One row per job: most recent execution with job info
    const rows = await c.env.DB.query(
      `SELECT DISTINCT ON (j.id)
         e.id, e.job_id, e.status, e.detail, e.created_at,
         j.name AS job_name, j.server_id, j.project_name, j.cron_expr, j.target_role, j.target_session_name, j.action,
         COALESCE(p.creator_user_id, j.user_id) AS creator_user_id,
         COALESCE(NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(u.username), '')) AS creator_name,
         COALESCE(p.shared, FALSE) AS creator_is_shared
       FROM cron_executions e
       JOIN cron_jobs j ON j.id = e.job_id
       LEFT JOIN cron_job_provenance p ON p.job_id = j.id
       LEFT JOIN users u ON u.id = COALESCE(p.creator_user_id, j.user_id)
       WHERE j.user_id = $1
         AND ($2::text IS NULL OR j.server_id = $2)
         AND ($3::text IS NULL OR j.project_name = $3)
         AND ($4::text IS NULL OR p.creator_user_id = $4)
       ORDER BY j.id, e.created_at DESC`,
      [
        access.scope.ownerUserId,
        serverId,
        access.scope.projectName,
        externalCliRestricted ? IMCODES_EXTERNAL_CLI_SENDER : null,
      ],
    );
    const visibleRows = filterExternalCliExecutions(
      await filterCronRowsForSharedScope(c, access.scope, rows as Array<DbCronJob & Record<string, unknown>>, pinnedSessionName),
    );
    return c.json({ executions: normalizeCronExecutionRows(visibleRows) });
  }

  // mode=all: all executions sorted by time
  const rows = await c.env.DB.query(
    `SELECT e.id, e.job_id, e.status, e.detail, e.created_at,
       j.name AS job_name, j.server_id, j.project_name, j.cron_expr, j.target_role, j.target_session_name, j.action,
       COALESCE(p.creator_user_id, j.user_id) AS creator_user_id,
       COALESCE(NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(u.username), '')) AS creator_name,
       COALESCE(p.shared, FALSE) AS creator_is_shared
     FROM cron_executions e
     JOIN cron_jobs j ON j.id = e.job_id
     LEFT JOIN cron_job_provenance p ON p.job_id = j.id
     LEFT JOIN users u ON u.id = COALESCE(p.creator_user_id, j.user_id)
     WHERE j.user_id = $1
       AND ($2::text IS NULL OR j.server_id = $2)
       AND ($3::text IS NULL OR j.project_name = $3)
       AND ($5::text IS NULL OR p.creator_user_id = $5)
     ORDER BY e.created_at DESC
     LIMIT $4`,
    [
      access.scope.ownerUserId,
      serverId,
      access.scope.projectName,
      limit,
      externalCliRestricted ? IMCODES_EXTERNAL_CLI_SENDER : null,
    ],
  );
  const visibleRows = filterExternalCliExecutions(
    await filterCronRowsForSharedScope(c, access.scope, rows as Array<DbCronJob & Record<string, unknown>>, pinnedSessionName),
  );
  return c.json({ executions: normalizeCronExecutionRows(visibleRows) });
});

// GET /api/cron/:id/executions — execution history for a cron job
router.get('/:id/executions', requireCronAuth(), async (c) => {
  const preAuthority = await resolveCronDaemonContext(c, getPodStickyServerId(c));
  if (!preAuthority.ok) return daemonScopeFailure(c as unknown as Context<{ Bindings: Env }>, preAuthority);
  const routeServerId = getPodStickyServerId(c);
  const jobId = c.req.param('id');
  const limitParam = parseInt(c.req.query('limit') || '20', 10);
  const limit = Math.min(Math.max(1, limitParam), 100);

  const job = await c.env.DB.queryOne<DbCronJob>(
    'SELECT * FROM cron_jobs WHERE id = $1',
    [jobId],
  );
  if (!job) return c.json({ error: 'not_found' }, 404);
  if (isWrongPodStickyServer(job.server_id, routeServerId)) return c.json({ error: 'not_found' }, 404);
  const authority = await resolveCronDaemonContext(c, job.server_id);
  if (!authority.ok) return daemonScopeFailure(c as unknown as Context<{ Bindings: Env }>, authority);
  const userId = authority.actorUserId;
  const pinnedSessionName = pinnedSessionForAuthority(authority);
  const externalCliRestricted = isExternalCliRestrictedAuthority(c, routeServerId, authority);

  if (externalCliRestricted) {
    const prov = await readCronJobProvenance(c.env.DB, jobId);
    if (!prov.ok) return c.json({ error: 'cron_provenance_read_failed' }, 500);
    if (!isExternalCliOwnedProvenance(prov.row)) {
      return c.json({ error: 'forbidden', reason: 'external_cli_cron_scope_denied' }, 403);
    }
  }

  const access = await resolveCronJobScope(c, { userId, job, mode: 'read', pinnedSessionName });
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);

  const executions = await c.env.DB.query(
    'SELECT id, status, detail, created_at FROM cron_executions WHERE job_id = $1 ORDER BY created_at DESC LIMIT $2',
    [jobId, limit],
  );
  return c.json({ executions: normalizeCronExecutionRows(executions as Array<Record<string, unknown>>) });
});
}

registerCronApiRoutes(cronApiRoutes);
registerCronApiRoutes(cronRestrictedApiRoutes);
