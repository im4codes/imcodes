import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { BotConfig, InboundMessage, OutboundMessage } from '../platform/types.js';
import { getHandler } from '../platform/registry.js';
import { findChannelBindingByPlatformChannel } from '../db/queries.js';
import { sha256Hex, decryptBotConfig } from '../security/crypto.js';
import { WsBridge } from '../ws/bridge.js';
import logger from '../util/logger.js';

export const outboundRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

/**
 * Route an inbound message to the appropriate daemon via WsBridge.
 * Called by webhook.ts after verification and rate limiting.
 * botId identifies which bot received the webhook — used for deterministic binding lookup.
 */
export async function routeInbound(msg: InboundMessage, env: Env, botId: string): Promise<void> {
  const binding = await findChannelBindingByPlatformChannel(env.DB, msg.platform, msg.channelId, botId);
  if (!binding) {
    logger.info({ platform: msg.platform, channelId: msg.channelId, botId }, 'No channel binding found — ignoring');
    return;
  }

  const payload = JSON.stringify({ type: 'inbound', msg });
  WsBridge.get(binding.server_id).sendToDaemon(payload);
}

/**
 * Load bot config from DB by botId.
 */
async function loadBotConfig(botId: string, env: Env): Promise<BotConfig | null> {
  if (!env.BOT_ENCRYPTION_KEY) throw new Error('BOT_ENCRYPTION_KEY is not configured');

  const row = await env.DB.queryOne<{ id: string; user_id: string; platform: string; config_encrypted: string }>(
    'SELECT id, user_id, platform, config_encrypted FROM platform_bots WHERE id = $1',
    [botId],
  );

  if (!row) return null;

  const config = decryptBotConfig(row.config_encrypted, env.BOT_ENCRYPTION_KEY);

  return {
    botId: row.id,
    userId: row.user_id,
    platform: row.platform,
    config,
  };
}

/**
 * POST /api/outbound — daemon sends a message to be dispatched to a platform.
 * Authenticated via Bearer token (server token from bind flow).
 * Body must include botId to identify which user's bot credentials to use.
 */
outboundRoutes.post('/', async (c) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const token = auth.slice(7);

  // Validate server token
  const tokenHash = sha256Hex(token);
  const serverRow = await c.env.DB.queryOne<{ id: string; user_id: string }>(
    'SELECT id, user_id FROM servers WHERE token_hash = $1',
    [tokenHash],
  );

  if (!serverRow) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const msg = await c.req.json<OutboundMessage>();

  if (!msg.platform || !msg.botId || !msg.channelId || !msg.content) {
    return c.json({ error: 'invalid_payload' }, 400);
  }

  const handler = getHandler(msg.platform);
  if (!handler) {
    return c.json({ error: 'unknown_platform' }, 404);
  }

  // Load per-user bot credentials from DB
  const botConfig = await loadBotConfig(msg.botId, c.env);
  if (!botConfig) {
    return c.json({ error: 'bot_not_found' }, 404);
  }

  // Only allow sending via bots owned by the server's user
  if (botConfig.userId !== serverRow.user_id) {
    return c.json({ error: 'forbidden' }, 403);
  }

  try {
    await handler.sendOutbound(msg, botConfig);
  } catch (err) {
    logger.error({ platform: msg.platform, channelId: msg.channelId, err }, 'sendOutbound failed');
    return c.json({ error: 'delivery_failed' }, 500);
  }

  return c.json({ ok: true });
});
