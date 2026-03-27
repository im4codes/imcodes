import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import { randomHex } from '../security/crypto.js';
import { logAudit } from '../security/audit.js';

export const cronApiRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

const cronJobSchema = z.object({
  name: z.string().min(1).max(100),
  schedule: z.string().min(1),  // cron expression
  action: z.string().min(1),    // action type/payload
});

// GET /api/cron — list user's cron jobs
cronApiRoutes.get('/', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const jobs = await c.env.DB.query(
    "SELECT * FROM cron_jobs WHERE user_id = $1 ORDER BY created_at DESC",
    [userId],
  );
  return c.json({ jobs });
});

// POST /api/cron — create a cron job
cronApiRoutes.post('/', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const body = await c.req.json().catch(() => null);
  const parsed = cronJobSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const { name, schedule, action } = parsed.data;
  const id = randomHex(16);
  const now = Date.now();

  await c.env.DB.execute(
    "INSERT INTO cron_jobs (id, user_id, name, schedule, action, status, next_run_at, created_at) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)",
    [id, userId, name, schedule, action, now + 60_000, now],
  );

  await logAudit({ userId, action: 'cron.create', details: { id, name, schedule } }, c.env.DB);

  return c.json({ id, name, schedule, action, status: 'active' }, 201);
});

// PUT /api/cron/:id — update a cron job
cronApiRoutes.put('/:id', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const jobId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = cronJobSchema.partial().safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const job = await c.env.DB.queryOne(
    'SELECT * FROM cron_jobs WHERE id = $1 AND user_id = $2',
    [jobId, userId],
  );
  if (!job) return c.json({ error: 'not_found' }, 404);

  const updates = parsed.data;
  if (updates.name) await c.env.DB.execute('UPDATE cron_jobs SET name = $1 WHERE id = $2', [updates.name, jobId]);
  if (updates.schedule) await c.env.DB.execute('UPDATE cron_jobs SET schedule = $1 WHERE id = $2', [updates.schedule, jobId]);
  if (updates.action) await c.env.DB.execute('UPDATE cron_jobs SET action = $1 WHERE id = $2', [updates.action, jobId]);

  await logAudit({ userId, action: 'cron.update', details: { id: jobId } }, c.env.DB);
  return c.json({ ok: true });
});

// DELETE /api/cron/:id — delete a cron job
cronApiRoutes.delete('/:id', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const jobId = c.req.param('id');

  const result = await c.env.DB.execute(
    'DELETE FROM cron_jobs WHERE id = $1 AND user_id = $2',
    [jobId, userId],
  );

  if (result.changes === 0) return c.json({ error: 'not_found' }, 404);

  await logAudit({ userId, action: 'cron.delete', details: { id: jobId } }, c.env.DB);
  return c.json({ ok: true });
});
