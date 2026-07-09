/**
 * Flat `/api/aliases` CRUD for the user-level alias store.
 *
 * Mounted under the global `/api/*` group so it inherits the CORS + CSRF
 * middleware from index.ts (no bespoke bypass). Every request is
 * session-authenticated via {@link requireAuth} and scoped to the caller's
 * `user_id` — there is deliberately NO `serverId` requirement (aliases are a
 * user-level, pod-independent store).
 *
 * All writes are validated server-authoritatively with the shared validators
 * (NFC first) and rejected with the shared reason codes. The alias `value` is
 * never written to logs, error bodies, or diagnostics.
 */

import { Hono } from 'hono';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import { randomHex } from '../security/crypto.js';
import {
  type AliasEntry,
  ALIAS_REASONS,
  nfc,
  validateAliasName,
  validateAliasValue,
  validateAliasDescription,
  validateAliasTags,
} from '../../../shared/alias-types.js';
import {
  upsertAlias,
  getAliasByName,
  deleteAlias,
  listAliases,
} from '../db/alias-queries.js';

export const aliasRoutes = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

aliasRoutes.use('/*', requireAuth());

/**
 * NFC-normalize an already-validated `tags` field into a `string[]` for storage.
 *
 * MUST only be called AFTER {@link validateAliasTags} has returned `null` for the
 * same input — that validator is the server-authoritative gate (rejects a
 * non-array, >{@link ALIAS_TAG_MAX_COUNT} tags, and any non-string / empty /
 * oversized / control-char tag with `alias_tags_invalid`). We do NOT silently
 * truncate or drop here; every validated tag is preserved (NFC-normalized to
 * match the same normalization applied to name/value/description on write).
 */
function normalizeRequestTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as string[]).map((t) => nfc(t));
}

/** GET /api/aliases?q= — list the caller's aliases (optional literal substring filter). */
aliasRoutes.get('/', async (c) => {
  const userId = c.get('userId' as never) as string;
  const q = c.req.query('q');
  const entries: AliasEntry[] = await listAliases(c.env.DB, userId, { q });
  return c.json({ aliases: entries });
});

/** POST /api/aliases — upsert an alias for the caller (keyed on name). */
aliasRoutes.post('/', async (c) => {
  const userId = c.get('userId' as never) as string;

  let body: { name?: unknown; value?: unknown; description?: unknown; tags?: unknown };
  try {
    body = await c.req.json() as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const rawName = typeof body.name === 'string' ? body.name : '';
  const rawValue = typeof body.value === 'string' ? body.value : '';
  const rawDescription = typeof body.description === 'string' ? body.description : undefined;

  const nameReason = validateAliasName(rawName);
  if (nameReason) return c.json({ error: nameReason }, 400);

  const valueReason = validateAliasValue(rawValue);
  if (valueReason) return c.json({ error: valueReason }, 400);

  const descriptionReason = validateAliasDescription(rawDescription);
  if (descriptionReason) return c.json({ error: descriptionReason }, 400);

  const tagsReason = validateAliasTags(body.tags);
  if (tagsReason) return c.json({ error: tagsReason }, 400);

  const name = nfc(rawName);
  const description = rawDescription != null ? nfc(rawDescription) : null;
  const tags = normalizeRequestTags(body.tags);

  // Provenance: the daemon (MCP agent write) authenticates with X-Server-Id +
  // Bearer; a browser (web app) uses the session cookie and never sends it.
  const source = c.req.header('X-Server-Id') ? 'mcp' : 'web';

  const entry = await upsertAlias(c.env.DB, {
    id: randomHex(16),
    userId,
    name,
    value: rawValue,
    description,
    tags,
    source,
  });
  return c.json({ alias: entry });
});

/** DELETE /api/aliases/:name — remove the caller's alias by name. */
aliasRoutes.delete('/:name', async (c) => {
  const userId = c.get('userId' as never) as string;
  const rawName = c.req.param('name')!;

  const nameReason = validateAliasName(rawName);
  if (nameReason) return c.json({ error: nameReason }, 400);

  const name = nfc(rawName);
  const removed = await deleteAlias(c.env.DB, userId, name);
  if (!removed) return c.json({ error: ALIAS_REASONS.NOT_FOUND }, 404);
  return c.json({ ok: true });
});

/** GET /api/aliases/:name — fetch a single alias by name (owner-scoped). */
aliasRoutes.get('/:name', async (c) => {
  const userId = c.get('userId' as never) as string;
  const rawName = c.req.param('name')!;

  const nameReason = validateAliasName(rawName);
  if (nameReason) return c.json({ error: nameReason }, 400);

  const name = nfc(rawName);
  const entry = await getAliasByName(c.env.DB, userId, name);
  if (!entry) return c.json({ error: ALIAS_REASONS.NOT_FOUND }, 404);
  return c.json({ alias: entry });
});
