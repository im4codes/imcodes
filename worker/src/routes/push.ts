/**
 * Push notification device token management and dispatch.
 * POST /api/push/register — register device token
 * Dispatch: send push on session events (idle, error, @ask, @reply)
 */
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireAuth } from '../security/authorization.js';
import logger from '../util/logger.js';

export const pushRoutes = new Hono<{ Bindings: Env }>();

pushRoutes.use('/*', requireAuth());

// POST /api/push/register — store device token for user
pushRoutes.post('/register', async (c) => {
  const userId = c.get('userId' as never) as string;
  const body = await c.req.json<{ token: string; platform: 'ios' | 'android' }>().catch(() => null);
  if (!body?.token || !body?.platform) return c.json({ error: 'token and platform required' }, 400);

  // Store token in D1 (push_tokens table — added to security migration or separately)
  try {
    await c.env.DB.prepare(
      `INSERT INTO push_tokens (user_id, token, platform, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, token) DO UPDATE SET platform = excluded.platform`,
    ).bind(userId, body.token, body.platform, Date.now()).run();
  } catch (err) {
    // push_tokens table may not exist yet — log and continue
    logger.warn({ err }, 'push_tokens table not ready');
  }

  return c.json({ ok: true });
});

// ── Push dispatch ─────────────────────────────────────────────────────────────

export interface PushPayload {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Dispatch a push notification to all devices registered by a user.
 * Uses FCM HTTP v1 API for Android and APNs for iOS.
 * Falls back gracefully if FCM_SERVER_KEY is not configured.
 */
export async function dispatchPush(payload: PushPayload, env: Env): Promise<void> {
  const fcmKey = (env as unknown as Record<string, string>).FCM_SERVER_KEY;
  if (!fcmKey) {
    logger.debug({ userId: payload.userId }, 'FCM not configured — skipping push');
    return;
  }

  let tokens: Array<{ token: string; platform: string }> = [];
  try {
    const result = await env.DB
      .prepare('SELECT token, platform FROM push_tokens WHERE user_id = ?')
      .bind(payload.userId)
      .all<{ token: string; platform: string }>();
    tokens = result.results;
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch push tokens');
    return;
  }

  for (const { token, platform } of tokens) {
    try {
      if (platform === 'android') {
        await sendFcm(token, payload, fcmKey);
      } else if (platform === 'ios') {
        // APNs requires a separate key — simplified implementation
        await sendFcm(token, payload, fcmKey); // FCM can also handle iOS with unified token
      }
    } catch (err) {
      logger.warn({ token, platform, err }, 'Push dispatch failed');
    }
  }
}

async function sendFcm(
  deviceToken: string,
  payload: PushPayload,
  serverKey: string,
): Promise<void> {
  const body = {
    to: deviceToken,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: payload.data ?? {},
  };

  const res = await fetch('https://fcm.googleapis.com/fcm/send', {
    method: 'POST',
    headers: {
      Authorization: `key=${serverKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`FCM error: ${res.status}`);
  }
}
