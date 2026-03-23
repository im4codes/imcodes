/**
 * Push notification device token management and dispatch.
 * POST /api/push/register — register device token
 * Dispatch: send push on session events (idle, notification, ask, error)
 *
 * iOS: APNs HTTP/2 with JWT auth
 * Android: FCM legacy HTTP API
 */
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { PgDatabase } from '../db/client.js';
import { requireAuth } from '../security/authorization.js';
import { SignJWT, importPKCS8 } from 'jose';
import logger from '../util/logger.js';

export const pushRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

pushRoutes.use('/*', requireAuth());

// POST /api/push/register — store device token for user
pushRoutes.post('/register', async (c) => {
  const userId = c.get('userId' as never) as string;
  const body = await c.req.json<{ token: string; platform: 'ios' | 'android' }>().catch(() => null);
  if (!body?.token || !body?.platform) return c.json({ error: 'token and platform required' }, 400);

  try {
    await c.env.DB.prepare(
      `INSERT INTO push_tokens (user_id, token, platform, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, token) DO UPDATE SET platform = excluded.platform`,
    ).bind(userId, body.token, body.platform, Date.now()).run();
  } catch (err) {
    logger.warn({ err }, 'push_tokens insert failed');
  }

  return c.json({ ok: true });
});

// DELETE /api/push/unregister — remove device token
pushRoutes.delete('/unregister', async (c) => {
  const userId = c.get('userId' as never) as string;
  const body = await c.req.json<{ token: string }>().catch(() => null);
  if (!body?.token) return c.json({ error: 'token required' }, 400);

  try {
    await c.env.DB.prepare('DELETE FROM push_tokens WHERE user_id = ? AND token = ?')
      .bind(userId, body.token).run();
  } catch { /* ignore */ }

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
 * Dispatch push to all devices for a user.
 * Routes iOS to APNs, Android to FCM.
 */
export async function dispatchPush(payload: PushPayload, env: Env): Promise<void>;
export async function dispatchPush(payload: PushPayload, db: PgDatabase, env?: Env): Promise<void>;
export async function dispatchPush(payload: PushPayload, envOrDb: Env | PgDatabase, maybeEnv?: Env): Promise<void> {
  let db: PgDatabase;
  let env: Env;

  if ('DB' in envOrDb) {
    db = (envOrDb as Env).DB;
    env = envOrDb as Env;
  } else {
    db = envOrDb as PgDatabase;
    env = maybeEnv!;
  }

  let tokens: Array<{ token: string; platform: string }> = [];
  try {
    const result = await db
      .prepare('SELECT token, platform FROM push_tokens WHERE user_id = ?')
      .bind(payload.userId)
      .all<{ token: string; platform: string }>();
    tokens = result.results;
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch push tokens');
    return;
  }

  if (tokens.length === 0) return;

  for (const { token, platform } of tokens) {
    try {
      if (platform === 'ios') {
        await sendApns(token, payload, env);
      } else if (platform === 'android' && env.FCM_SERVER_KEY) {
        await sendFcm(token, payload, env.FCM_SERVER_KEY);
      }
    } catch (err) {
      logger.warn({ token: token.slice(0, 10) + '...', platform, err }, 'Push dispatch failed');
      // Remove invalid tokens (APNs 410 = unregistered)
      if (err instanceof PushError && err.unregistered) {
        await db.prepare('DELETE FROM push_tokens WHERE token = ?').bind(token).run().catch(() => {});
      }
    }
  }
}

class PushError extends Error {
  constructor(message: string, public unregistered = false) {
    super(message);
  }
}

// ── APNs HTTP/2 ───────────────────────────────────────────────────────────────

let apnsJwtCache: { jwt: string; expiresAt: number } | null = null;

async function getApnsJwt(env: Env): Promise<string> {
  // JWT valid for up to 1 hour, cache for 50 minutes
  if (apnsJwtCache && Date.now() < apnsJwtCache.expiresAt) return apnsJwtCache.jwt;

  if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) {
    throw new Error('APNs not configured (APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID)');
  }

  const keyPem = Buffer.from(env.APNS_KEY, 'base64').toString('utf8');
  const key = await importPKCS8(keyPem, 'ES256');

  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.APNS_KEY_ID })
    .setIssuer(env.APNS_TEAM_ID)
    .setIssuedAt()
    .sign(key);

  apnsJwtCache = { jwt, expiresAt: Date.now() + 50 * 60 * 1000 };
  return jwt;
}

async function sendApnsToHost(host: string, deviceToken: string, payload: PushPayload, jwt: string, bundleId: string): Promise<Response> {
  const body = {
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: 'default',
      'mutable-content': 1,
    },
    ...payload.data,
  };

  return fetch(`https://${host}/3/device/${deviceToken}`, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${jwt}`,
      'apns-topic': bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function sendApns(deviceToken: string, payload: PushPayload, env: Env): Promise<void> {
  const jwt = await getApnsJwt(env);
  const bundleId = env.APNS_BUNDLE_ID ?? 'app.imcodes';

  // Try production first, fallback to sandbox for development tokens (Xcode builds).
  // APNs returns 400 BadDeviceToken when environment doesn't match.
  const hosts = ['api.push.apple.com', 'api.sandbox.push.apple.com'];

  for (let i = 0; i < hosts.length; i++) {
    const res = await sendApnsToHost(hosts[i], deviceToken, payload, jwt, bundleId);
    if (res.ok) return;

    const errBody = await res.text().catch(() => '');
    const unregistered = res.status === 410 || errBody.includes('Unregistered');

    // BadDeviceToken on production → likely a sandbox token, try sandbox
    if (i === 0 && res.status === 400 && errBody.includes('BadDeviceToken')) {
      logger.info({ token: deviceToken.slice(0, 10) }, 'APNs production rejected token, trying sandbox');
      continue;
    }

    throw new PushError(`APNs ${res.status}: ${errBody}`, unregistered);
  }
}

// ── FCM (Android) ─────────────────────────────────────────────────────────────

async function sendFcm(deviceToken: string, payload: PushPayload, serverKey: string): Promise<void> {
  const body = {
    to: deviceToken,
    notification: { title: payload.title, body: payload.body },
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
    const errBody = await res.text().catch(() => '');
    const unregistered = errBody.includes('NotRegistered');
    throw new PushError(`FCM ${res.status}: ${errBody}`, unregistered);
  }
}
