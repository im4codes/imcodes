import { Hono } from 'hono';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import { getHandler, listPlatforms } from '../platform/registry.js';
import { randomHex, encryptBotConfig, decryptBotConfig } from '../security/crypto.js';
import { logAudit } from '../security/audit.js';
import { z } from 'zod';

export const botRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

botRoutes.use('/*', requireAuth());

const registerSchema = z.object({
  platform: z.enum(['telegram', 'discord', 'feishu']),
  label: z.string().optional(),
  config: z.record(z.string(), z.string()),
});

/**
 * POST /api/bot — register a new platform bot for the authenticated user.
 * Config is encrypted with BOT_ENCRYPTION_KEY before storage.
 * Returns: { botId, webhookUrl } — never returns credentials.
 */
botRoutes.post('/', async (c) => {
  const userId = c.get('userId' as never) as string;

  if (!c.env.BOT_ENCRYPTION_KEY) {
    return c.json({ error: 'server_misconfigured' }, 500);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);

  const { platform, label, config } = parsed.data;

  const handler = getHandler(platform);
  if (!handler) return c.json({ error: 'unknown_platform' }, 400);

  const caps = handler.getCapabilities();
  const missing = caps.requiredConfigKeys.filter((k) => !config[k]);
  if (missing.length > 0) {
    return c.json({ error: 'missing_config_keys', missing }, 400);
  }

  const botId = randomHex(16);
  const now = Date.now();
  const configEncrypted = encryptBotConfig(config, c.env.BOT_ENCRYPTION_KEY);

  await c.env.DB.execute(
    'INSERT INTO platform_bots (id, user_id, platform, label, config_encrypted, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [botId, userId, platform, label ?? null, configEncrypted, now, now],
  );

  await logAudit({ userId, action: 'bot.register', details: { botId, platform } }, c.env.DB);

  return c.json({
    botId,
    webhookUrl: `${c.env.SERVER_URL}/webhook/${platform}/${botId}`,
  }, 201);
});

/**
 * GET /api/bot — list all bots for the authenticated user.
 * Returns metadata only — never decrypted credentials.
 */
botRoutes.get('/', async (c) => {
  const userId = c.get('userId' as never) as string;

  const rows = await c.env.DB.query<{ id: string; platform: string; label: string | null; created_at: number }>(
    'SELECT id, platform, label, created_at FROM platform_bots WHERE user_id = $1 ORDER BY created_at DESC',
    [userId],
  );

  return c.json({
    bots: rows.map((r) => ({
      botId: r.id,
      platform: r.platform,
      label: r.label,
      webhookUrl: `${c.env.SERVER_URL}/webhook/${r.platform}/${r.id}`,
      createdAt: r.created_at,
    })),
  });
});

/**
 * GET /api/bot/platforms — list supported platforms and their required config keys.
 */
botRoutes.get('/platforms', (c) => {
  const platforms = listPlatforms().map((p) => {
    const handler = getHandler(p)!;
    const caps = handler.getCapabilities();
    return { platform: p, requiredConfigKeys: caps.requiredConfigKeys };
  });
  return c.json({ platforms });
});

/**
 * DELETE /api/bot/:botId — remove a bot registration.
 */
botRoutes.delete('/:botId', async (c) => {
  const userId = c.get('userId' as never) as string;
  const botId = c.req.param('botId');

  const row = await c.env.DB.queryOne<{ id: string }>(
    'SELECT id FROM platform_bots WHERE id = $1 AND user_id = $2',
    [botId, userId],
  );

  if (!row) return c.json({ error: 'not_found' }, 404);

  await c.env.DB.execute('DELETE FROM platform_bots WHERE id = $1', [botId]);

  await logAudit({ userId, action: 'bot.delete', details: { botId } }, c.env.DB);

  return c.json({ ok: true });
});

/**
 * PATCH /api/bot/:botId — update label or merge new config keys into an existing bot.
 * Decrypts existing config, merges, re-encrypts — plaintext never persisted.
 */
botRoutes.patch('/:botId', async (c) => {
  const userId = c.get('userId' as never) as string;
  const botId = c.req.param('botId');

  if (!c.env.BOT_ENCRYPTION_KEY) {
    return c.json({ error: 'server_misconfigured' }, 500);
  }

  const row = await c.env.DB.queryOne<{ id: string; platform: string; config_encrypted: string }>(
    'SELECT id, platform, config_encrypted FROM platform_bots WHERE id = $1 AND user_id = $2',
    [botId, userId],
  );

  if (!row) return c.json({ error: 'not_found' }, 404);

  const body = await c.req.json().catch(() => null);
  const patchSchema = z.object({
    label: z.string().optional(),
    config: z.record(z.string(), z.string()).optional(),
  });
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { label, config } = parsed.data;

  let newEncrypted = row.config_encrypted;
  if (config) {
    const existing = decryptBotConfig(row.config_encrypted, c.env.BOT_ENCRYPTION_KEY);
    const merged = { ...existing, ...config };

    // Validate that required keys are still present and non-empty after merge
    const handler = getHandler(row.platform);
    if (handler) {
      const { requiredConfigKeys } = handler.getCapabilities();
      const missing = requiredConfigKeys.filter((k) => !merged[k]);
      if (missing.length > 0) {
        return c.json({ error: 'missing_required_config', keys: missing }, 400);
      }
    }

    newEncrypted = encryptBotConfig(merged, c.env.BOT_ENCRYPTION_KEY);
  }

  await c.env.DB.execute(
    'UPDATE platform_bots SET label = COALESCE($1, label), config_encrypted = $2, updated_at = $3 WHERE id = $4',
    [label ?? null, newEncrypted, Date.now(), botId],
  );

  return c.json({ ok: true });
});
