import { Hono } from 'hono';
import type { Env } from '../env.js';
import { getUserPref, setUserPref, deleteUserPref } from '../db/queries.js';
import { requireAuth } from '../security/authorization.js';

export const preferencesRoutes = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

preferencesRoutes.use('/*', requireAuth());

const KEY_RE = /^[a-zA-Z0-9_.:@-]{1,128}$/;
const MAX_VALUE_BYTES = 65536; // 64KB

/** GET /api/preferences/:key */
preferencesRoutes.get('/:key', async (c) => {
  const userId = c.get('userId' as never) as string;
  const key = c.req.param('key')!;
  if (!KEY_RE.test(key)) return c.json({ error: 'invalid_key' }, 400);

  const raw = await getUserPref(c.env.DB, userId, key);
  if (raw === null) return c.json({ value: null });
  try {
    return c.json({ value: JSON.parse(raw) });
  } catch {
    return c.json({ value: null });
  }
});

/** PUT /api/preferences/:key */
preferencesRoutes.put('/:key', async (c) => {
  const userId = c.get('userId' as never) as string;
  const key = c.req.param('key')!;
  if (!KEY_RE.test(key)) return c.json({ error: 'invalid_key' }, 400);

  let body: { value?: unknown };
  try {
    body = await c.req.json() as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const serialized = JSON.stringify(body.value ?? null);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_VALUE_BYTES) {
    return c.json({ error: 'value_too_large' }, 400);
  }

  await setUserPref(c.env.DB, userId, key, serialized);
  return c.json({ ok: true });
});

/** DELETE /api/preferences/:key */
preferencesRoutes.delete('/:key', async (c) => {
  const userId = c.get('userId' as never) as string;
  const key = c.req.param('key')!;
  if (!KEY_RE.test(key)) return c.json({ error: 'invalid_key' }, 400);

  await deleteUserPref(c.env.DB, userId, key);
  return c.json({ ok: true });
});
