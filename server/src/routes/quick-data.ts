import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import {
  getQuickDataSnapshot,
  upsertQuickData,
  upsertQuickDataConditional,
} from '../db/queries.js';

export const quickDataRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

quickDataRoutes.use('/*', requireAuth());

const QUICK_DATA_HISTORY_MAX = 200;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseSessionHistory(raw: unknown, ctx: z.RefinementCtx): Record<string, string[]> {
  if (raw === undefined) return {};
  if (!isPlainRecord(raw)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected sessionHistory object' });
    return z.NEVER;
  }
  const map = new Map<string, string[]>();
  for (const [session, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries) || entries.length > QUICK_DATA_HISTORY_MAX) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid sessionHistory list for ${session}` });
      return z.NEVER;
    }
    for (const item of entries) {
      if (typeof item !== 'string' || item.length > 500) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid sessionHistory entry in ${session}` });
        return z.NEVER;
      }
    }
    map.set(session, entries as string[]);
  }
  return Object.fromEntries(map);
}

function validateTimestampMap(raw: unknown, ctx: z.RefinementCtx): Record<string, number> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainRecord(raw)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected timestamp map object' });
    return z.NEVER;
  }
  const map = new Map<string, number>();
  for (const [key, value] of Object.entries(raw)) {
    if (key.length > 500) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Timestamp key exceeds 500 characters' });
      return z.NEVER;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value) || value < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid history timestamp' });
      return z.NEVER;
    }
    map.set(key, value);
  }
  return Object.fromEntries(map);
}

function validateSessionTimestampMaps(
  raw: unknown,
  ctx: z.RefinementCtx,
): Record<string, Record<string, number>> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainRecord(raw)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected sessionHistoryTimestamps object' });
    return z.NEVER;
  }
  const outer = new Map<string, Record<string, number>>();
  for (const [session, rawMap] of Object.entries(raw)) {
    const validated = validateTimestampMap(rawMap, ctx);
    if (validated === (z.NEVER as unknown)) return z.NEVER;
    if (validated) outer.set(session, validated);
  }
  return Object.fromEntries(outer);
}

// Custom prototype-safe transforms avoid Zod v4 `z.record()` assigning into `{}`
// via `obj[key] = ...`, which silently drops `__proto__` own keys.
const quickDataSchema = z.object({
  history: z.array(z.string().max(500)).max(QUICK_DATA_HISTORY_MAX),
  sessionHistory: z.unknown().optional().transform((val, ctx) => parseSessionHistory(val, ctx)),
  historyTimestamps: z.unknown().optional().transform((val, ctx) => validateTimestampMap(val, ctx)),
  sessionHistoryTimestamps: z.unknown().optional().transform((val, ctx) => validateSessionTimestampMaps(val, ctx)),
  commands: z.array(z.string().max(500)).max(200),
  phrases: z.array(z.string().max(500)).max(200),
});

function pruneHistoryTimestamps(
  entries: readonly string[],
  rawMap: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!rawMap) return undefined;
  const entrySet = new Set(entries);
  const pruned = new Map<string, number>();
  for (const [key, value] of Object.entries(rawMap)) {
    if (entrySet.has(key)) pruned.set(key, value);
  }
  return pruned.size > 0 ? Object.fromEntries(pruned) : undefined;
}

function pruneSessionHistoryTimestamps(
  sessionHistory: Record<string, string[]>,
  rawMaps: Record<string, Record<string, number>> | undefined,
): Record<string, Record<string, number>> | undefined {
  if (!rawMaps) return undefined;
  const pruned = new Map<string, Record<string, number>>();
  for (const [session, map] of Object.entries(rawMaps)) {
    if (!Object.hasOwn(sessionHistory, session)) continue;
    const entries = sessionHistory[session];
    if (!entries || entries.length === 0) continue;
    const cleaned = pruneHistoryTimestamps(entries, map);
    if (cleaned) pruned.set(session, cleaned);
  }
  return pruned.size > 0 ? Object.fromEntries(pruned) : undefined;
}

/** GET /api/quick-data — load user's quick data and CAS version token */
quickDataRoutes.get('/', async (c) => {
  const userId = c.get('userId' as never) as string;
  const snapshot = await getQuickDataSnapshot(c.env.DB, userId);
  return c.json({ data: snapshot.data, version: snapshot.version });
});

/** PUT /api/quick-data — replace the user's quick data snapshot (with optional CAS version check) */
quickDataRoutes.put('/', async (c) => {
  const userId = c.get('userId' as never) as string;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  let dataCandidate: unknown = body;
  let expectedVersion: string | undefined;
  if (isPlainRecord(body) && 'data' in body) {
    dataCandidate = body.data;
    if (body.expectedVersion !== undefined) {
      const ver = z.string().min(1).max(128).safeParse(body.expectedVersion);
      if (!ver.success) {
        return c.json({ error: 'invalid_data', detail: ver.error.flatten() }, 400);
      }
      expectedVersion = ver.data;
    }
  }

  const parsed = quickDataSchema.safeParse(dataCandidate);
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

  if (expectedVersion !== undefined) {
    const result = await upsertQuickDataConditional(c.env.DB, userId, next, expectedVersion);
    if (!result.ok) {
      return c.json(
        { error: 'version_conflict', data: result.current.data, version: result.current.version },
        409,
      );
    }
    return c.json({ ok: true, version: result.version });
  }

  await upsertQuickData(c.env.DB, userId, next);
  return c.json({ ok: true });
});
