import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import { getQuickData, upsertQuickData } from '../db/queries.js';

export const quickDataRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

quickDataRoutes.use('/*', requireAuth());

const quickDataSchema = z.object({
  history: z.array(z.string().max(500)).max(50),
  sessionHistory: z.record(z.string(), z.array(z.string().max(500)).max(50)).default({}),
  commands: z.array(z.string().max(500)).max(200),
  phrases: z.array(z.string().max(500)).max(200),
});

/** GET /api/quick-data — load user's quick data */
quickDataRoutes.get('/', async (c) => {
  const userId = c.get('userId' as never) as string;
  const data = await getQuickData(c.env.DB, userId);
  return c.json({ data });
});

/** Merge two string arrays: deduplicate, preserve order (incoming first), cap at max. */
function mergeArrays(incoming: string[], existing: string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const s of [...incoming, ...existing]) {
    if (!seen.has(s)) {
      seen.add(s);
      result.push(s);
      if (result.length >= max) break;
    }
  }
  return result;
}

/** PUT /api/quick-data — merge with existing data (not replace) */
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

  // Read existing data and merge to avoid cross-device overwrites
  const existing = await getQuickData(c.env.DB, userId);
  const merged = {
    history: mergeArrays(parsed.data.history, existing.history ?? [], 50),
    sessionHistory: { ...existing.sessionHistory, ...parsed.data.sessionHistory } as Record<string, string[]>,
    commands: mergeArrays(parsed.data.commands, existing.commands ?? [], 200),
    phrases: mergeArrays(parsed.data.phrases, existing.phrases ?? [], 200),
  };

  // Merge per-session histories too
  for (const [key, arr] of Object.entries(existing.sessionHistory ?? {})) {
    if (merged.sessionHistory[key]) {
      merged.sessionHistory[key] = mergeArrays(merged.sessionHistory[key], arr, 50);
    } else {
      merged.sessionHistory[key] = arr;
    }
  }

  await upsertQuickData(c.env.DB, userId, merged);
  return c.json({ ok: true });
});
