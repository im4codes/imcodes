import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { Cron } from 'croner';
import { z } from 'zod';
import type { Env } from '../env.js';
import type { DbCronJob } from '../db/queries.js';
import { requireAuth } from '../security/authorization.js';
import { resolveHttpShareAccessForCoveredSession, resolveServerMemberAccessOrShareDeny } from './share-http-auth.js';
import { shareTargetFromSessionName } from '../db/tab-sharing.js';
import { getSubSessionById, getSubSessionsByServer, isExecutionCloneRow } from '../db/queries.js';
import { randomHex } from '../security/crypto.js';
import { logAudit } from '../security/audit.js';
import {
  CRON_COMPLETION_POLICY,
  CRON_CONTROL_CONTRACT,
  CRON_STATUS,
  normalizeCronCompletionPolicy,
  normalizeCronExecutionDetail,
  registerCronControlAction,
  type CronAction,
} from '../../../shared/cron-types.js';
import { MEMORY_MCP_CAPS } from '../../../shared/memory-mcp-contracts.js';
import { MEMORY_MCP_SOURCE_FIELDS, stripMemoryMcpSourceProvenance } from '../../../shared/memory-mcp-provenance.js';
import { P2P_MODE_KEYS } from '../../../shared/p2p-modes.js';
import { dispatchJobNow } from '../cron/job-dispatch.js';
import { WsBridge } from '../ws/bridge.js';
import { RESOURCE_TOPICS } from '../../../shared/resource-events.js';
import { CLIENT_TIMEZONE_HEADER, DEVICE_TIMEZONE_HEADER } from '../../../shared/http-header-names.js';
import { normalizeClientTimezone } from '../../../shared/client-timezone.js';
import { loadRememberedClientTimezone, rememberClientTimezone } from '../util/client-timezone.js';

type CronRouteEnv = { Bindings: Env; Variables: { userId: string; role: string; cronDaemonLocal?: boolean } };

export const cronApiRoutes = new Hono<CronRouteEnv>();

const MIN_INTERVAL_MS = MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES * 60 * 1000;

const rolePattern = /^(brain|w\d+)$/;
const sessionNamePattern = /^deck_sub_[a-zA-Z0-9_-]+$/;
const sourceSessionNamePattern = /^deck_(?:sub_[a-zA-Z0-9_-]+|[a-zA-Z0-9._-]+_(?:brain|w\d+))$/;

const cronParticipantSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('role'), value: z.string().regex(rolePattern) }),
  z.object({ type: z.literal('session'), value: z.string().regex(sessionNamePattern) }),
]);

const cronControlRegistrationSchema = z.object({
  contractId: z.literal(CRON_CONTROL_CONTRACT.contractId),
  version: z.literal(CRON_CONTROL_CONTRACT.version),
  scheduleId: z.string().min(1),
  constraints: z.object({
    updateSelf: z.literal(CRON_CONTROL_CONTRACT.constraints.updateSelf),
    cancelRecurring: z.literal(CRON_CONTROL_CONTRACT.constraints.cancelRecurring),
    cancelUntilComplete: z.literal(CRON_CONTROL_CONTRACT.constraints.cancelUntilComplete),
    silent: z.literal(CRON_CONTROL_CONTRACT.constraints.silent),
    network: z.literal(CRON_CONTROL_CONTRACT.constraints.network),
    finalResponse: z.literal(CRON_CONTROL_CONTRACT.constraints.finalResponse),
  }).strict(),
}).strict();

const cronActionSchemaRaw = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('command'), command: z.string().min(1), selfManaged: z.boolean().optional(),
    cronControl: cronControlRegistrationSchema.optional(),
  }),
  z.object({
    type: z.literal('send'),
    target: z.string().min(1),
    message: z.string().min(1),
    reply: z.boolean().optional(),
    broadcast: z.boolean().optional(),
    idempotencyKey: z.string().min(1).optional(),
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

function normalizeCronExecutionRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => {
    if (typeof row.detail !== 'string') return row;
    const detail = normalizeCronExecutionDetail(row.detail);
    return detail === row.detail ? row : { ...row, detail };
  });
}

function isDaemonServerTokenCronRequest(
  c: { req: { header: (name: string) => string | undefined } },
  routeServerId: string | null,
): boolean {
  if (!routeServerId) return false;
  const authHeader = c.req.header('Authorization');
  const headerServerId = c.req.header('X-Server-Id');
  const cookieHeader = c.req.header('Cookie');
  return !!authHeader?.startsWith('Bearer ')
    && headerServerId === routeServerId
    && !cookieHeader;
}

function isLocalDaemonCronRequest(c: Context<CronRouteEnv>): boolean {
  return c.get('cronDaemonLocal') === true;
}

function isDaemonCronRequest(
  c: Context<CronRouteEnv>,
  routeServerId: string | null,
): boolean {
  return isLocalDaemonCronRequest(c) || isDaemonServerTokenCronRequest(c, routeServerId);
}

type CronAccessMode = 'read' | 'write';
type CronScope = {
  ownerUserId: string;
  projectName: string | null;
  shared: boolean;
  sharedSessionName: string | null;
  sharedTargetKind: 'server' | 'main' | 'subsession' | null;
  sharedMainRole: string | null;
  sharedTargetSessionNames: string[] | null;
};

async function resolveCronScope(
  c: Context<CronRouteEnv>,
  params: { serverId: string; userId: string; requestedProjectName?: string | null; mode: CronAccessMode },
): Promise<{ ok: true; scope: CronScope } | { ok: false; reason: string }> {
  const member = await resolveServerMemberAccessOrShareDeny(c.env.DB, {
    serverId: params.serverId,
    userId: params.userId,
  });
  if (member.ok) {
    return {
      ok: true,
      scope: {
        ownerUserId: params.userId,
        projectName: params.requestedProjectName ?? null,
        shared: false,
        sharedSessionName: null,
        sharedTargetKind: null,
        sharedMainRole: null,
        sharedTargetSessionNames: null,
      },
    };
  }

  const sessionName = (c.req.query('sessionName') ?? '').trim();
  const target = shareTargetFromSessionName(params.serverId, sessionName);
  if (!target) return { ok: false, reason: member.reason };
  const access = await resolveHttpShareAccessForCoveredSession(c.env.DB, {
    serverId: params.serverId,
    userId: params.userId,
    target,
  });
  if (access.actor.kind !== 'share') return { ok: false, reason: member.reason };
  if (params.mode === 'write' && access.actor.effectiveActorRole !== 'participant') {
    return { ok: false, reason: 'share-role-denied' };
  }

  let projectName: string | null = null;
  let sharedMainRole: string | null = null;
  let sharedTargetSessionNames: string[] | null = null;
  if (target.kind === 'main') {
    const row = await c.env.DB.queryOne<{ project_name: string; role: string }>(
      'SELECT project_name, role FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
      [params.serverId, target.sessionName],
    );
    projectName = row?.project_name ?? null;
    sharedMainRole = row?.role ?? null;
    const children = await getSubSessionsByServer(c.env.DB, params.serverId);
    sharedTargetSessionNames = children
      .filter((child) => child.parent_session === target.sessionName)
      .map((child) => `deck_sub_${child.id}`);
  } else if (target.kind === 'subsession') {
    const row = await getSubSessionById(c.env.DB, target.subSessionId, params.serverId);
    if (row?.parent_session) {
      const parent = await c.env.DB.queryOne<{ project_name: string }>(
        'SELECT project_name FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
        [params.serverId, row.parent_session],
      );
      projectName = parent?.project_name ?? null;
    }
    sharedTargetSessionNames = [sessionName];
  }
  const server = await c.env.DB.queryOne<{ user_id: string }>(
    'SELECT user_id FROM servers WHERE id = $1',
    [params.serverId],
  );
  if (!server || !projectName) return { ok: false, reason: 'share-target-unavailable' };
  return {
    ok: true,
    scope: {
      ownerUserId: server.user_id,
      projectName,
      shared: true,
      sharedSessionName: sessionName,
      sharedTargetKind: target.kind,
      sharedMainRole,
      sharedTargetSessionNames,
    },
  };
}

async function resolveCronJobScope(
  c: Context<CronRouteEnv>,
  params: { userId: string; job: DbCronJob; mode: CronAccessMode },
): Promise<{ ok: true; scope: CronScope } | { ok: false; reason: string }> {
  const access = await resolveCronScope(c, {
    serverId: params.job.server_id,
    userId: params.userId,
    requestedProjectName: params.job.project_name,
    mode: params.mode,
  });
  if (!access.ok) return access;
  if (
    params.job.user_id !== access.scope.ownerUserId
    || (access.scope.projectName !== null && params.job.project_name !== access.scope.projectName)
  ) {
    return { ok: false, reason: 'share-direct-surface-denied' };
  }
  let action: z.infer<typeof cronActionSchema> | undefined;
  try {
    const parsed = cronActionSchema.safeParse(JSON.parse(params.job.action));
    if (parsed.success) action = parsed.data;
  } catch { /* malformed legacy jobs are never exposed through shared access */ }
  if (!await cronScopeCoversPayload(c, params.job.server_id, access.scope, {
    targetRole: params.job.target_role,
    targetSessionName: params.job.target_session_name,
    action,
  })) {
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

async function cronScopeCoversPayload(
  c: Context<CronRouteEnv>,
  serverId: string,
  scope: CronScope,
  payload: { targetRole?: string | null; targetSessionName?: string | null; action?: z.infer<typeof cronActionSchema> },
): Promise<boolean> {
  if (!scope.shared || scope.sharedTargetKind === 'server') return true;
  if (!payload.action) return false;
  const refs = cronPayloadSessionRefs(payload);
  const roleRefs = cronPayloadRoleRefs(payload);
  if (scope.sharedTargetKind === 'subsession') {
    return payload.targetSessionName === scope.sharedSessionName
      && refs.every((name) => name === scope.sharedSessionName)
      && roleRefs.length === 0;
  }
  if (payload.targetSessionName) {
    if (!scope.sharedTargetSessionNames?.includes(payload.targetSessionName)) return false;
  } else if (!scope.sharedMainRole || payload.targetRole !== scope.sharedMainRole) {
    return false;
  }
  if (roleRefs.some((role) => role !== scope.sharedMainRole)) return false;
  for (const name of refs) {
    if (name === scope.sharedSessionName) continue;
    const target = shareTargetFromSessionName(serverId, name);
    if (!target || target.kind !== 'subsession') return false;
    const child = await getSubSessionById(c.env.DB, target.subSessionId, serverId);
    if (!child || child.closed_at !== null || isExecutionCloneRow(child) || child.parent_session !== scope.sharedSessionName) {
      return false;
    }
  }
  return true;
}

async function filterCronRowsForSharedScope<T extends {
  server_id: string;
  target_role: string;
  target_session_name: string | null;
  action: string;
}>(c: Context<CronRouteEnv>, scope: CronScope, rows: T[]): Promise<T[]> {
  if (!scope.shared) return rows;
  const checks = await Promise.all(rows.map(async (row) => {
    let action: z.infer<typeof cronActionSchema> | undefined;
    try {
      const parsed = cronActionSchema.safeParse(JSON.parse(row.action));
      if (parsed.success) action = parsed.data;
    } catch { /* malformed legacy rows remain hidden from shared access */ }
    return await cronScopeCoversPayload(c, row.server_id, scope, {
      targetRole: row.target_role,
      targetSessionName: row.target_session_name,
      action,
    });
  }));
  return rows.filter((_, index) => checks[index]);
}

function requireCronAuth() {
  return async (c: Context<CronRouteEnv>, next: Next): Promise<Response | void> => {
    const routeServerId = getPodStickyServerId(c);
    const hasAuthLikeHeader = Boolean(c.req.header('Authorization') || c.req.header('Cookie'));
    if (routeServerId && !hasAuthLikeHeader) {
      const server = await c.env.DB.queryOne<{ user_id: string }>(
        'SELECT user_id FROM servers WHERE id = $1',
        [routeServerId],
      );
      if (!server) return c.json({ error: 'not_found' }, 404);
      c.set('userId', server.user_id);
      c.set('role', 'owner');
      c.set('cronDaemonLocal', true);
      await next();
      return;
    }
    return requireAuth()(c as unknown as Context<{ Bindings: Env }>, next);
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

/** Validate cron expression and enforce minimum 5-minute interval. Returns next run time or error string. */
function validateCronExpr(cronExpr: string, timezone?: string): { nextRunAt: number } | { error: string } {
  try {
    const opts = timezone ? { timezone } : undefined;
    const job = new Cron(cronExpr, opts);
    const first = job.nextRun();
    if (!first) return { error: 'invalid_cron_expression' };
    const second = job.nextRun(first);
    if (second && (second.getTime() - first.getTime()) < MIN_INTERVAL_MS) {
      return { error: 'cron_interval_too_short' };
    }
    return { nextRunAt: first.getTime() };
  } catch {
    return { error: 'invalid_cron_expression' };
  }
}

// GET /api/cron — list user's cron jobs, optionally filtered by server/project
cronApiRoutes.get('/', requireCronAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const routeServerId = getPodStickyServerId(c);
  const serverId = routeServerId ?? c.req.query('serverId') ?? null;
  const projectName = c.req.query('projectName') || null;

  const access = serverId
    ? await resolveCronScope(c, { serverId, userId, requestedProjectName: projectName, mode: 'read' })
    : { ok: true as const, scope: { ownerUserId: userId, projectName, shared: false, sharedSessionName: null, sharedTargetKind: null, sharedMainRole: null, sharedTargetSessionNames: null } };
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);

  const jobs = await c.env.DB.query<DbCronJob>(
    `SELECT * FROM cron_jobs WHERE user_id = $1
       AND ($2::text IS NULL OR server_id = $2)
       AND ($3::text IS NULL OR project_name = $3)
       AND ($4::text[] IS NULL
         OR target_session_name = ANY($4::text[])
         OR ($5::text IS NOT NULL AND target_session_name IS NULL AND target_role = $5))
     ORDER BY created_at DESC`,
    [
      access.scope.ownerUserId,
      serverId,
      access.scope.projectName,
      access.scope.sharedTargetSessionNames,
      access.scope.sharedMainRole,
    ],
  );
  return c.json({ jobs: await filterCronRowsForSharedScope(c, access.scope, jobs) });
});

// POST /api/cron — create a cron job
cronApiRoutes.post('/', requireCronAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const routeServerId = getPodStickyServerId(c);
  const body = await c.req.json().catch(() => null);
  const requestBody = await withDefaultCronTimezone(c, userId, withPodStickyServerId(body, routeServerId));
  const parsed = cronJobCreateSchema.safeParse(requestBody);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const {
    name,
    cronExpr,
    serverId,
    projectName,
    targetRole,
    targetSessionName,
    action,
    timezone,
    expiresAt,
    completionPolicy,
  } = parsed.data;
  const unboundAction = normalizeCronActionForPersistence(action, isDaemonCronRequest(c, routeServerId));

  const access = await resolveCronScope(c, { serverId, userId, requestedProjectName: projectName, mode: 'write' });
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);
  if (!await cronScopeCoversPayload(c, serverId, access.scope, { targetRole, targetSessionName, action })) {
    return c.json({ error: 'forbidden', reason: 'share-direct-surface-denied' }, 403);
  }

  const validation = validateCronExpr(cronExpr, timezone);
  if ('error' in validation) {
    return c.json({ error: validation.error, ...(validation.error === 'cron_interval_too_short' ? { minIntervalMinutes: 5 } : {}) }, 400);
  }

  const id = randomHex(16);
  const now = Date.now();
  const registeredAction = registerSelfManagedCronAction(unboundAction, id, completionPolicy);
  if (!registeredAction.ok) {
    return c.json({ error: 'invalid_cron_control', reason: registeredAction.reason }, 400);
  }
  const persistedAction = registeredAction.action;

  await c.env.DB.execute(
    `INSERT INTO cron_jobs (id, server_id, user_id, name, cron_expr, project_name, target_role, target_session_name, action, timezone, status, next_run_at, expires_at, completion_policy, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)`,
    [id, serverId, access.scope.ownerUserId, name, cronExpr, access.scope.projectName ?? projectName, targetRole, targetSessionName ?? null, JSON.stringify(persistedAction), timezone ?? null, CRON_STATUS.ACTIVE, validation.nextRunAt, expiresAt ?? null, completionPolicy, now],
  );

  await logAudit({ userId, action: 'cron.create', details: { id, name, cronExpr, projectName: access.scope.projectName ?? projectName } }, c.env.DB);
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
cronApiRoutes.put('/:id', requireCronAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const routeServerId = getPodStickyServerId(c);
  const jobId = c.req.param('id');
  if (!jobId) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = cronJobUpdateSchema.safeParse(await withDefaultCronTimezone(c, userId, body));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const job = await c.env.DB.queryOne<DbCronJob>(
    'SELECT * FROM cron_jobs WHERE id = $1',
    [jobId],
  );
  if (!job) return c.json({ error: 'not_found' }, 404);
  if (isWrongPodStickyServer(job.server_id, routeServerId)) return c.json({ error: 'not_found' }, 404);

  const access = await resolveCronJobScope(c, { userId, job, mode: 'write' });
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);

  const updates = { ...parsed.data };
  if (access.scope.shared) updates.projectName = access.scope.projectName ?? undefined;
  let existingAction: z.infer<typeof cronActionSchema> | undefined;
  try {
    const parsedExisting = cronActionSchema.safeParse(JSON.parse(job.action));
    if (parsedExisting.success) existingAction = parsedExisting.data;
  } catch { /* invalid legacy action remains non-editable through a shared scope */ }
  if (!await cronScopeCoversPayload(c, job.server_id, access.scope, {
    targetRole: updates.targetRole !== undefined ? updates.targetRole : job.target_role,
    targetSessionName: updates.targetSessionName !== undefined ? updates.targetSessionName : job.target_session_name,
    action: updates.action ?? existingAction,
  })) {
    return c.json({ error: 'forbidden', reason: 'share-direct-surface-denied' }, 403);
  }
  const now = Date.now();
  if (
    isDaemonCronRequest(c, routeServerId)
    && normalizeCronCompletionPolicy(job.completion_policy) === CRON_COMPLETION_POLICY.RECURRING
    && updates.completionPolicy === CRON_COMPLETION_POLICY.UNTIL_COMPLETE
    && c.req.query('force') !== 'true'
  ) {
    return c.json({
      error: 'cron_force_required',
      completionPolicy: CRON_COMPLETION_POLICY.RECURRING,
      message: 'Changing a recurring cron to until_complete from an agent requires force=true',
    }, 409);
  }

  // Re-validate cron expression if changed
  let nextRunAt: number | undefined;
  const newCronExpr = updates.cronExpr;
  const effectiveTz = updates.timezone ?? job.timezone ?? undefined;
  const scheduleChanged = (newCronExpr !== undefined && newCronExpr !== job.cron_expr)
    || (updates.timezone !== undefined && updates.timezone !== job.timezone);
  if (scheduleChanged) {
    const validation = validateCronExpr(newCronExpr ?? job.cron_expr, effectiveTz);
    if ('error' in validation) {
      return c.json({ error: validation.error, ...(validation.error === 'cron_interval_too_short' ? { minIntervalMinutes: 5 } : {}) }, 400);
    }
    nextRunAt = validation.nextRunAt;
  }

  // Build dynamic UPDATE
  const sets: string[] = ['updated_at = $1'];
  const vals: unknown[] = [now];
  let idx = 2;

  if (updates.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(updates.name); }
  if (updates.cronExpr !== undefined) { sets.push(`cron_expr = $${idx++}`); vals.push(updates.cronExpr); }
  if (updates.projectName !== undefined) { sets.push(`project_name = $${idx++}`); vals.push(updates.projectName); }
  if (updates.targetRole !== undefined) { sets.push(`target_role = $${idx++}`); vals.push(updates.targetRole); }
  if (updates.targetSessionName !== undefined) { sets.push(`target_session_name = $${idx++}`); vals.push(updates.targetSessionName); }
  if (updates.action !== undefined) {
    const unboundAction = normalizeCronActionForPersistence(updates.action, isDaemonCronRequest(c, routeServerId));
    const registeredAction = registerSelfManagedCronAction(
      unboundAction,
      jobId,
      updates.completionPolicy ?? normalizeCronCompletionPolicy(job.completion_policy),
    );
    if (!registeredAction.ok) {
      return c.json({ error: 'invalid_cron_control', reason: registeredAction.reason }, 400);
    }
    sets.push(`action = $${idx++}`);
    vals.push(JSON.stringify(registeredAction.action));
  }
  if (updates.timezone !== undefined) { sets.push(`timezone = $${idx++}`); vals.push(updates.timezone); }
  if (updates.expiresAt !== undefined) { sets.push(`expires_at = $${idx++}`); vals.push(updates.expiresAt); }
  if (updates.completionPolicy !== undefined) { sets.push(`completion_policy = $${idx++}`); vals.push(updates.completionPolicy); }
  if (nextRunAt !== undefined) { sets.push(`next_run_at = $${idx++}`); vals.push(nextRunAt); }

  // Reset expired/error jobs to paused on edit
  if (job.status === CRON_STATUS.EXPIRED || job.status === CRON_STATUS.ERROR) {
    sets.push(`status = $${idx++}`); vals.push(CRON_STATUS.PAUSED);
  }

  vals.push(jobId);
  await c.env.DB.execute(
    `UPDATE cron_jobs SET ${sets.join(', ')} WHERE id = $${idx}`,
    vals,
  );

  await logAudit({
    userId,
    action: 'cron.update',
    details: {
      id: jobId,
      ...(updates.completionPolicy !== undefined
        ? {
          completionPolicy: updates.completionPolicy,
          forced: isDaemonCronRequest(c, routeServerId) ? c.req.query('force') === 'true' : false,
        }
        : {}),
    },
  }, c.env.DB);
  WsBridge.publishResourceChanged(job.server_id, RESOURCE_TOPICS.cron, { action: 'update' });
  return c.json({ ok: true });
});

// PATCH /api/cron/:id/status — pause/resume (only active ↔ paused)
cronApiRoutes.patch('/:id/status', requireCronAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const routeServerId = getPodStickyServerId(c);
  const jobId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const newStatus = (body as Record<string, unknown> | null)?.status;
  if (newStatus !== CRON_STATUS.ACTIVE && newStatus !== CRON_STATUS.PAUSED) {
    return c.json({ error: 'invalid_status' }, 400);
  }

  const job = await c.env.DB.queryOne<DbCronJob>(
    'SELECT * FROM cron_jobs WHERE id = $1',
    [jobId],
  );
  if (!job) return c.json({ error: 'not_found' }, 404);
  if (isWrongPodStickyServer(job.server_id, routeServerId)) return c.json({ error: 'not_found' }, 404);

  const access = await resolveCronJobScope(c, { userId, job, mode: 'write' });
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);

  if (newStatus === CRON_STATUS.ACTIVE && job.status !== CRON_STATUS.PAUSED) {
    return c.json({ error: 'cannot_resume', currentStatus: job.status }, 400);
  }

  await c.env.DB.execute(
    'UPDATE cron_jobs SET status = $1, updated_at = $2 WHERE id = $3',
    [newStatus, Date.now(), jobId],
  );

  await logAudit({ userId, action: 'cron.status', details: { id: jobId, status: newStatus } }, c.env.DB);
  WsBridge.publishResourceChanged(job.server_id, RESOURCE_TOPICS.cron, { action: 'status' });
  return c.json({ ok: true });
});

// DELETE /api/cron/:id — delete a cron job
cronApiRoutes.delete('/:id', requireCronAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const routeServerId = getPodStickyServerId(c);
  const jobId = c.req.param('id');

  const job = await c.env.DB.queryOne<DbCronJob>(
    'SELECT * FROM cron_jobs WHERE id = $1',
    [jobId],
  );
  if (!job) return c.json({ error: 'not_found' }, 404);
  if (isWrongPodStickyServer(job.server_id, routeServerId)) return c.json({ error: 'not_found' }, 404);

  const access = await resolveCronJobScope(c, { userId, job, mode: 'write' });
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);

  const completionPolicy = normalizeCronCompletionPolicy(job.completion_policy);
  const force = c.req.query('force') === 'true';
  if (
    isDaemonCronRequest(c, routeServerId)
    && completionPolicy === CRON_COMPLETION_POLICY.RECURRING
    && !force
  ) {
    return c.json({
      error: 'cron_force_required',
      completionPolicy,
      message: 'Deleting a recurring cron from an agent requires force=true',
    }, 409);
  }

  await c.env.DB.execute('DELETE FROM cron_jobs WHERE id = $1', [jobId]);

  await logAudit({
    userId,
    action: 'cron.delete',
    details: {
      id: jobId,
      completionPolicy,
      forced: isDaemonCronRequest(c, routeServerId) ? force : false,
    },
  }, c.env.DB);
  WsBridge.publishResourceChanged(job.server_id, RESOURCE_TOPICS.cron, { action: 'delete' });
  return c.json({ ok: true });
});

// POST /api/cron/:id/trigger — immediately dispatch a cron job
cronApiRoutes.post('/:id/trigger', requireCronAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const routeServerId = getPodStickyServerId(c);
  const jobId = c.req.param('id');

  const job = await c.env.DB.queryOne<DbCronJob>(
    'SELECT * FROM cron_jobs WHERE id = $1',
    [jobId],
  );
  if (!job) return c.json({ error: 'not_found' }, 404);
  if (isWrongPodStickyServer(job.server_id, routeServerId)) return c.json({ error: 'not_found' }, 404);

  const access = await resolveCronJobScope(c, { userId, job, mode: 'write' });
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);

  try {
    await dispatchJobNow(c.env, job);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 400);
  }

  await logAudit({ userId, action: 'cron.manual_trigger', details: { id: jobId } }, c.env.DB);
  return c.json({ ok: true });
});

// GET /api/cron/executions — cross-job execution list
// mode=latest: most recent execution per job; mode=all: all executions sorted by time
cronApiRoutes.get('/executions', requireCronAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const mode = c.req.query('mode') || 'all';
  const routeServerId = getPodStickyServerId(c);
  const serverId = routeServerId ?? c.req.query('serverId') ?? null;
  const requestedProjectName = c.req.query('projectName') || null;
  const limitParam = parseInt(c.req.query('limit') || '50', 10);
  const limit = Math.min(Math.max(1, limitParam), 200);
  const access = serverId
    ? await resolveCronScope(c, { serverId, userId, requestedProjectName, mode: 'read' })
    : { ok: true as const, scope: { ownerUserId: userId, projectName: requestedProjectName, shared: false, sharedSessionName: null, sharedTargetKind: null, sharedMainRole: null, sharedTargetSessionNames: null } };
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);

  if (mode === 'latest') {
    // One row per job: most recent execution with job info
    const rows = await c.env.DB.query(
      `SELECT DISTINCT ON (j.id)
         e.id, e.job_id, e.status, e.detail, e.created_at,
         j.name AS job_name, j.server_id, j.project_name, j.cron_expr, j.target_role, j.target_session_name, j.action
       FROM cron_executions e
       JOIN cron_jobs j ON j.id = e.job_id
       WHERE j.user_id = $1
         AND ($2::text IS NULL OR j.server_id = $2)
         AND ($3::text IS NULL OR j.project_name = $3)
         AND ($4::text[] IS NULL
           OR j.target_session_name = ANY($4::text[])
           OR ($5::text IS NOT NULL AND j.target_session_name IS NULL AND j.target_role = $5))
       ORDER BY j.id, e.created_at DESC`,
      [access.scope.ownerUserId, serverId, access.scope.projectName, access.scope.sharedTargetSessionNames, access.scope.sharedMainRole],
    );
    const visibleRows = await filterCronRowsForSharedScope(c, access.scope, rows as Array<DbCronJob & Record<string, unknown>>);
    return c.json({ executions: normalizeCronExecutionRows(visibleRows) });
  }

  // mode=all: all executions sorted by time
  const rows = await c.env.DB.query(
    `SELECT e.id, e.job_id, e.status, e.detail, e.created_at,
       j.name AS job_name, j.server_id, j.project_name, j.cron_expr, j.target_role, j.target_session_name, j.action
     FROM cron_executions e
     JOIN cron_jobs j ON j.id = e.job_id
     WHERE j.user_id = $1
       AND ($2::text IS NULL OR j.server_id = $2)
       AND ($3::text IS NULL OR j.project_name = $3)
       AND ($4::text[] IS NULL
         OR j.target_session_name = ANY($4::text[])
         OR ($5::text IS NOT NULL AND j.target_session_name IS NULL AND j.target_role = $5))
     ORDER BY e.created_at DESC
     LIMIT $6`,
    [access.scope.ownerUserId, serverId, access.scope.projectName, access.scope.sharedTargetSessionNames, access.scope.sharedMainRole, limit],
  );
  const visibleRows = await filterCronRowsForSharedScope(c, access.scope, rows as Array<DbCronJob & Record<string, unknown>>);
  return c.json({ executions: normalizeCronExecutionRows(visibleRows) });
});

// GET /api/cron/:id/executions — execution history for a cron job
cronApiRoutes.get('/:id/executions', requireCronAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
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

  const access = await resolveCronJobScope(c, { userId, job, mode: 'read' });
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);

  const executions = await c.env.DB.query(
    'SELECT id, status, detail, created_at FROM cron_executions WHERE job_id = $1 ORDER BY created_at DESC LIMIT $2',
    [jobId, limit],
  );
  return c.json({ executions: normalizeCronExecutionRows(executions as Array<Record<string, unknown>>) });
});
