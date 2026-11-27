import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import { getQuickData, upsertQuickData } from '../db/queries.js';

export const quickDataRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

quickDataRoutes.use('/*', requireAuth());

const QUICK_DATA_HISTORY_MAX = 200;

const timestampSchema = z.number().int().nonnegative().finite();

const quickDataSchema = z.object({
  history: z.array(z.string().max(500)).max(QUICK_DATA_HISTORY_MAX),
  sessionHistory: z.record(z.string(), z.array(z.string().max(500)).max(QUICK_DATA_HISTORY_MAX)).default({}),
  historyTimestamps: z.record(z.string().max(500), timestampSchema).optional(),
  sessionHistoryTimestamps: z.record(z.string(), z.record(z.string().max(500), timestampSchema)).optional(),
  commands: z.array(z.string().max(500)).max(200),
  phrases: z.array(z.string().max(500)).max(200),
});

function pruneHistoryTimestamps(
  entries: readonly string[],
  rawMap: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!rawMap) return undefined;
  const entrySet = new Set(entries);
  const pruned: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawMap)) {
    if (entrySet.has(key)) pruned[key] = value;
  }
  return Object.keys(pruned).length > 0 ? pruned : undefined;
}

function pruneSessionHistoryTimestamps(
  sessionHistory: Record<string, string[]>,
  rawMaps: Record<string, Record<string, number>> | undefined,
): Record<string, Record<string, number>> | undefined {
  if (!rawMaps) return undefined;
  const pruned: Record<string, Record<string, number>> = {};
  for (const [session, map] of Object.entries(rawMaps)) {
    const entries = sessionHistory[session];
    if (!entries || entries.length === 0) continue;
    const cleaned = pruneHistoryTimestamps(entries, map);
    if (cleaned) pruned[session] = cleaned;
  }
  return Object.keys(pruned).length > 0 ? pruned : undefined;
}

/** GET /api/quick-data — load user's quick data */
quickDataRoutes.get('/', async (c) => {
  const userId = c.get('userId' as never) as string;
  const data = await getQuickData(c.env.DB, userId);
  return c.json({ data });
});

/** PUT /api/quick-data — replace the user's quick data snapshot */
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

  const historyTimestamps = pruneHistoryTimestamps(parsed.data.history, parsed.data.historyTimestamps);
  const sessionHistoryTimestamps = pruneSessionHistoryTimestamps(
    parsed.data.sessionHistory,
    parsed.data.sessionHistoryTimestamps,
  );

  const next = {
    history: parsed.data.history,
    sessionHistory: parsed.data.sessionHistory,
    ...(historyTimestamps ? { historyTimestamps } : {}),
    ...(sessionHistoryTimestamps ? { sessionHistoryTimestamps } : {}),
    commands: parsed.data.commands,
    phrases: parsed.data.phrases,
  };

  await upsertQuickData(c.env.DB, userId, next);
  return c.json({ ok: true });
});
