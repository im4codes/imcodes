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
  const jobs = await c.env.DB
    .prepare("SELECT * FROM cron_jobs WHERE user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all();
  return c.json({ jobs: jobs.results });
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

  await c.env.DB
    .prepare(
      "INSERT INTO cron_jobs (id, user_id, name, schedule, action, status, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
    )
    .bind(id, userId, name, schedule, action, now + 60_000, now)
    .run();

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

  const job = await c.env.DB
    .prepare('SELECT * FROM cron_jobs WHERE id = ? AND user_id = ?')
    .bind(jobId, userId)
    .first();
  if (!job) return c.json({ error: 'not_found' }, 404);

  const updates = parsed.data;
  if (updates.name) await c.env.DB.prepare('UPDATE cron_jobs SET name = ? WHERE id = ?').bind(updates.name, jobId).run();
  if (updates.schedule) await c.env.DB.prepare('UPDATE cron_jobs SET schedule = ? WHERE id = ?').bind(updates.schedule, jobId).run();
  if (updates.action) await c.env.DB.prepare('UPDATE cron_jobs SET action = ? WHERE id = ?').bind(updates.action, jobId).run();

  await logAudit({ userId, action: 'cron.update', details: { id: jobId } }, c.env.DB);
  return c.json({ ok: true });
});

// DELETE /api/cron/:id — delete a cron job
cronApiRoutes.delete('/:id', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const jobId = c.req.param('id');

  const result = await c.env.DB
    .prepare('DELETE FROM cron_jobs WHERE id = ? AND user_id = ?')
    .bind(jobId, userId)
    .run();

  if ((result.changes ?? 0) === 0) return c.json({ error: 'not_found' }, 404);

  await logAudit({ userId, action: 'cron.delete', details: { id: jobId } }, c.env.DB);
  return c.json({ ok: true });
});
