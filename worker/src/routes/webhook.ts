import { Hono } from 'hono';
import type { Env } from '../types.js';
import type { BotConfig } from '../platform/types.js';
import { getHandler } from '../platform/registry.js';
import { decryptBotConfig } from '../security/crypto.js';
import { routeInbound } from './outbound.js';
import logger from '../util/logger.js';

export const webhookRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /webhook/:platform/:botId
 *
 * Each user registers their own bot via POST /api/bot, receiving a unique botId.
 * They configure their platform webhook URL as:
 *   https://worker.example.com/webhook/telegram/<botId>
 *   https://worker.example.com/webhook/discord/<botId>
 *   https://worker.example.com/webhook/feishu/<botId>
 */
webhookRoutes.post('/:platform/:botId', async (c) => {
  const platform = c.req.param('platform');
  const botId = c.req.param('botId');

  const handler = getHandler(platform);
  if (!handler) {
    return c.json({ error: 'unknown_platform' }, 404);
  }

  if (!c.env.BOT_ENCRYPTION_KEY) {
    logger.error({}, 'BOT_ENCRYPTION_KEY is not configured');
    return c.json({ error: 'server_misconfigured' }, 500);
  }

  // Load per-user bot config from DB and decrypt
  const row = await c.env.DB.prepare(
    'SELECT id, user_id, platform, config_encrypted FROM platform_bots WHERE id = ? AND platform = ?',
  ).bind(botId, platform).first<{ id: string; user_id: string; platform: string; config_encrypted: string }>();

  if (!row) {
    return c.json({ error: 'bot_not_found' }, 404);
  }

  let decryptedConfig: Record<string, string>;
  try {
    decryptedConfig = await decryptBotConfig(row.config_encrypted, c.env.BOT_ENCRYPTION_KEY);
  } catch (err) {
    logger.error({ botId, err }, 'Failed to decrypt bot config');
    return c.json({ error: 'server_error' }, 500);
  }

  const botConfig: BotConfig = {
    botId: row.id,
    userId: row.user_id,
    platform: row.platform,
    config: decryptedConfig,
  };

  // Verify signature / token using per-bot credentials
  let verified: boolean;
  try {
    verified = await handler.verifyInbound(c.req.raw, botConfig);
  } catch (err) {
    logger.error({ platform, botId, err }, 'verifyInbound threw');
    return c.json({ error: 'verification_error' }, 500);
  }

  if (!verified) {
    logger.warn({ platform, botId }, 'Webhook signature verification failed');
    return c.json({ error: 'unauthorized' }, 401);
  }

  // Normalize to canonical InboundMessage
  let msg;
  try {
    msg = await handler.normalizeInbound(c.req.raw, botConfig);
  } catch (err) {
    logger.error({ platform, botId, err }, 'normalizeInbound threw');
    return c.json({ error: 'normalization_error' }, 400);
  }

  // Platform handshake responses — must be returned before routing
  if (platform === 'discord' && msg.channelId === 'ping' && msg.content === '__ping__') {
    return c.json({ type: 1 }); // Discord PONG
  }
  if (platform === 'feishu' && msg.channelId === 'challenge') {
    const body = await c.req.raw.clone().json<{ challenge: string }>().catch(() => ({ challenge: '' }));
    return c.json({ challenge: body.challenge });
  }

  // Rate limit check (per user)
  const rateLimitId = c.env.RATE_LIMITER.idFromName(`msg:${platform}:${msg.userId}`);
  const rateLimitStub = c.env.RATE_LIMITER.get(rateLimitId);
  const rlRes = await rateLimitStub.fetch(
    new Request(`https://dummy/?key=${encodeURIComponent(`${platform}:${msg.userId}`)}&type=msg`),
  );
  const { allowed, retryAfter } = (await rlRes.json()) as { allowed: boolean; retryAfter: number };

  if (!allowed) {
    return c.json({ error: 'rate_limited', retryAfter }, 429);
  }

  // Route to connected daemon via DaemonBridge
  try {
    await routeInbound(msg, c.env, botId);
  } catch (err) {
    logger.error({ platform, botId, channelId: msg.channelId, err }, 'routeInbound failed');
    return c.json({ error: 'routing_error' }, 500);
  }

  return c.json({ ok: true });
});
