import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types.js';
import { requireAuth } from '../security/authorization.js';
import { getQuickData, upsertQuickData } from '../db/queries.js';

export const quickDataRoutes = new Hono<{ Bindings: Env }>();

quickDataRoutes.use('/*', requireAuth());

const quickDataSchema = z.object({
  history: z.array(z.string().max(500)).max(50),
  commands: z.array(z.string().max(500)).max(200),
  phrases: z.array(z.string().max(500)).max(200),
});

/** GET /api/quick-data — load user's quick data */
quickDataRoutes.get('/', async (c) => {
  const userId = c.get('userId' as never) as string;
  const data = await getQuickData(c.env.DB, userId);
  return c.json({ data });
});

/** PUT /api/quick-data — replace user's quick data */
quickDataRoutes.put('/', async (c) => {
  const userId = c.get('userId' as never) as string;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const parsed = quickDataSchema.safeParse((body as Record<string, unknown>)?.data ?? body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_data', detail: parsed.error.flatten() }, 400);
  }

  await upsertQuickData(c.env.DB, userId, parsed.data);
  return c.json({ ok: true });
});
