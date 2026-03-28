import { Hono } from 'hono';
import { Cron } from 'croner';
import { z } from 'zod';
import type { Env } from '../env.js';
import type { DbCronJob } from '../db/queries.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';
import { randomHex } from '../security/crypto.js';
import { logAudit } from '../security/audit.js';
import { CRON_STATUS } from '../../../shared/cron-types.js';
import { P2P_MODE_KEYS } from '../../../shared/p2p-modes.js';
import { dispatchJobNow } from '../cron/job-dispatch.js';

export const cronApiRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const rolePattern = /^(brain|w\d+)$/;
const sessionNamePattern = /^deck_sub_[a-zA-Z0-9_-]+$/;

const cronParticipantSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('role'), value: z.string().regex(rolePattern) }),
  z.object({ type: z.literal('session'), value: z.string().regex(sessionNamePattern) }),
]);

const cronActionSchemaRaw = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), command: z.string().min(1) }),
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
  targetSessionName: z.string().regex(sessionNamePattern).optional(),
  action: cronActionSchema,
  timezone: z.string().min(1).max(64).optional(),
  expiresAt: z.number().nullable().optional(),
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
});

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
cronApiRoutes.get('/', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.query('serverId') || null;
  const projectName = c.req.query('projectName') || null;

  if (serverId) {
    const role = await resolveServerRole(c.env.DB, serverId, userId);
    if (role === 'none') return c.json({ error: 'forbidden' }, 403);
  }

  const jobs = await c.env.DB.query(
    `SELECT * FROM cron_jobs WHERE user_id = $1
       AND ($2::text IS NULL OR server_id = $2)
       AND ($3::text IS NULL OR project_name = $3)
     ORDER BY created_at DESC`,
    [userId, serverId, projectName],
  );
  return c.json({ jobs });
});

// POST /api/cron — create a cron job
cronApiRoutes.post('/', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const body = await c.req.json().catch(() => null);
  const parsed = cronJobCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const { name, cronExpr, serverId, projectName, targetRole, targetSessionName, action, timezone, expiresAt } = parsed.data;

  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const validation = validateCronExpr(cronExpr, timezone);
  if ('error' in validation) {
    return c.json({ error: validation.error, ...(validation.error === 'cron_interval_too_short' ? { minIntervalMinutes: 5 } : {}) }, 400);
  }

  const id = randomHex(16);
  const now = Date.now();

  await c.env.DB.execute(
    `INSERT INTO cron_jobs (id, server_id, user_id, name, cron_expr, project_name, target_role, target_session_name, action, timezone, status, next_run_at, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
    [id, serverId, userId, name, cronExpr, projectName, targetRole, targetSessionName ?? null, JSON.stringify(action), timezone ?? null, CRON_STATUS.ACTIVE, validation.nextRunAt, expiresAt ?? null, now],
  );

  await logAudit({ userId, action: 'cron.create', details: { id, name, cronExpr, projectName } }, c.env.DB);

  return c.json({ id, name, cronExpr, projectName, targetRole, targetSessionName: targetSessionName ?? null, action, timezone: timezone ?? null, status: CRON_STATUS.ACTIVE, nextRunAt: validation.nextRunAt, expiresAt: expiresAt ?? null }, 201);
});

// PUT /api/cron/:id — update a cron job
cronApiRoutes.put('/:id', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const jobId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = cronJobUpdateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const job = await c.env.DB.queryOne<DbCronJob>(
    'SELECT * FROM cron_jobs WHERE id = $1 AND user_id = $2',
    [jobId, userId],
  );
  if (!job) return c.json({ error: 'not_found' }, 404);

  const role = await resolveServerRole(c.env.DB, job.server_id, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const updates = parsed.data;
  const now = Date.now();

  // Re-validate cron expression if changed
  let nextRunAt: number | undefined;
  const newCronExpr = updates.cronExpr;
  const effectiveTz = updates.timezone ?? job.timezone ?? undefined;
  if (newCronExpr && newCronExpr !== job.cron_expr) {
    const validation = validateCronExpr(newCronExpr, effectiveTz);
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
  if (updates.action !== undefined) { sets.push(`action = $${idx++}`); vals.push(JSON.stringify(updates.action)); }
  if (updates.timezone !== undefined) { sets.push(`timezone = $${idx++}`); vals.push(updates.timezone); }
  if (updates.expiresAt !== undefined) { sets.push(`expires_at = $${idx++}`); vals.push(updates.expiresAt); }
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

  await logAudit({ userId, action: 'cron.update', details: { id: jobId } }, c.env.DB);
  return c.json({ ok: true });
});

// PATCH /api/cron/:id/status — pause/resume (only active ↔ paused)
cronApiRoutes.patch('/:id/status', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const jobId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const newStatus = (body as Record<string, unknown> | null)?.status;
  if (newStatus !== CRON_STATUS.ACTIVE && newStatus !== CRON_STATUS.PAUSED) {
    return c.json({ error: 'invalid_status' }, 400);
  }

  const job = await c.env.DB.queryOne<{ status: string; server_id: string }>(
    'SELECT status, server_id FROM cron_jobs WHERE id = $1 AND user_id = $2',
    [jobId, userId],
  );
  if (!job) return c.json({ error: 'not_found' }, 404);

  const role = await resolveServerRole(c.env.DB, job.server_id, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  if (newStatus === CRON_STATUS.ACTIVE && job.status !== CRON_STATUS.PAUSED) {
    return c.json({ error: 'cannot_resume', currentStatus: job.status }, 400);
  }

  await c.env.DB.execute(
    'UPDATE cron_jobs SET status = $1, updated_at = $2 WHERE id = $3',
    [newStatus, Date.now(), jobId],
  );

  await logAudit({ userId, action: 'cron.status', details: { id: jobId, status: newStatus } }, c.env.DB);
  return c.json({ ok: true });
});

// DELETE /api/cron/:id — delete a cron job
cronApiRoutes.delete('/:id', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const jobId = c.req.param('id');

  const job = await c.env.DB.queryOne<{ server_id: string }>(
    'SELECT server_id FROM cron_jobs WHERE id = $1 AND user_id = $2',
    [jobId, userId],
  );
  if (!job) return c.json({ error: 'not_found' }, 404);

  const role = await resolveServerRole(c.env.DB, job.server_id, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  await c.env.DB.execute('DELETE FROM cron_jobs WHERE id = $1', [jobId]);

  await logAudit({ userId, action: 'cron.delete', details: { id: jobId } }, c.env.DB);
  return c.json({ ok: true });
});

// POST /api/cron/:id/trigger — immediately dispatch a cron job
cronApiRoutes.post('/:id/trigger', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const jobId = c.req.param('id');

  const job = await c.env.DB.queryOne<DbCronJob>(
    'SELECT * FROM cron_jobs WHERE id = $1 AND user_id = $2',
    [jobId, userId],
  );
  if (!job) return c.json({ error: 'not_found' }, 404);

  const role = await resolveServerRole(c.env.DB, job.server_id, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  try {
    await dispatchJobNow(c.env, job);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 400);
  }

  await logAudit({ userId, action: 'cron.manual_trigger', details: { id: jobId } }, c.env.DB);
  return c.json({ ok: true });
});

// GET /api/cron/:id/executions — execution history for a cron job
cronApiRoutes.get('/:id/executions', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const jobId = c.req.param('id');
  const limitParam = parseInt(c.req.query('limit') || '20', 10);
  const limit = Math.min(Math.max(1, limitParam), 100);

  const job = await c.env.DB.queryOne<{ server_id: string }>(
    'SELECT server_id FROM cron_jobs WHERE id = $1 AND user_id = $2',
    [jobId, userId],
  );
  if (!job) return c.json({ error: 'not_found' }, 404);

  const role = await resolveServerRole(c.env.DB, job.server_id, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const executions = await c.env.DB.query(
    'SELECT id, status, detail, created_at FROM cron_executions WHERE job_id = $1 ORDER BY created_at DESC LIMIT $2',
    [jobId, limit],
  );
  return c.json({ executions });
});
