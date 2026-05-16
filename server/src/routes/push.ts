/**
 * Push notification device token management and dispatch.
 * POST /api/push/register — register device token
 * Dispatch: send push on session events (idle, notification, ask, error)
 *
 * iOS:                APNs HTTP/2 with JWT auth
 * Android (海外):     FCM legacy HTTP API
 * Android (国内):     JPush v3 REST API (aggregates Huawei / Xiaomi / OPPO / vivo / Honor vendor channels)
 *
 * Push credentials live ONLY on the central server (app.im.codes). Self-hosted
 * servers detect "I have no push credentials configured" and relay everything
 * via POST /api/push/relay back to the central server.
 */
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import { requireAuth } from '../security/authorization.js';
import { SignJWT, importPKCS8 } from 'jose';
import logger from '../util/logger.js';
import {
  PUSH_PLATFORM_IOS,
  PUSH_PLATFORM_ANDROID_FCM,
  PUSH_PLATFORM_ANDROID_JPUSH,
  isPushPlatform,
  type PushPlatform,
} from '../../../shared/push-notifications.js';

export const pushRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

// Auth required for register/unregister but NOT for relay (self-hosted servers call relay without auth)
pushRoutes.use('/register', requireAuth());
pushRoutes.use('/unregister', requireAuth());

// POST /api/push/register — store device token for user
pushRoutes.post('/register', async (c) => {
  const userId = c.get('userId' as never) as string;
  const body = await c.req.json<{ token: string; platform: PushPlatform }>().catch(() => null);
  if (!body?.token || !body?.platform) return c.json({ error: 'token and platform required' }, 400);
  if (!isPushPlatform(body.platform)) {
    return c.json({ error: `unsupported platform: ${body.platform}` }, 400);
  }

  try {
    await c.env.DB.execute(
      `INSERT INTO push_tokens (user_id, token, platform, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, token) DO UPDATE SET platform = excluded.platform`,
      [userId, body.token, body.platform, Date.now()],
    );
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
    await c.env.DB.execute('DELETE FROM push_tokens WHERE user_id = $1 AND token = $2',
      [userId, body.token]);
  } catch { /* ignore */ }

  return c.json({ ok: true });
});

// POST /api/push/badge-reset — clear badge count when app opens
pushRoutes.use('/badge-reset', requireAuth());
pushRoutes.post('/badge-reset', async (c) => {
  const userId = c.get('userId' as never) as string;
  try {
    await c.env.DB.execute('UPDATE users SET badge_count = 0 WHERE id = $1', [userId]);
  } catch { /* ignore */ }
  return c.json({ ok: true });
});

// ── Push relay for self-hosted servers ─────────────────────────────────────────
// Self-hosted servers don't have APNs keys. They call this endpoint to relay
// push notifications through app.im.codes which owns the APNs credentials.
// No auth required — validation is implicit: if the device token is invalid,
// APNs rejects it and we return the error.

pushRoutes.post('/relay', async (c) => {
  const body = await c.req.json<{ token: string; platform: string; title: string; body: string; badge?: number; data?: Record<string, string> }>().catch(() => null);
  if (!body?.token || !body?.platform || !body?.title) {
    return c.json({ error: 'token, platform, title, body required' }, 400);
  }

  // This server can serve relay if it has any push credential configured.
  // (Used to require APNs only; relaxed when JPush was added so a relay
  // server that holds only China credentials could still serve android-jpush.)
  const hasApns = !!(c.env.APNS_KEY && c.env.APNS_KEY_ID && c.env.APNS_TEAM_ID);
  const hasFcm = !!c.env.FCM_SERVER_KEY;
  const hasJpush = !!(c.env.JPUSH_APP_KEY && c.env.JPUSH_MASTER_SECRET);
  if (!hasApns && !hasFcm && !hasJpush) {
    return c.json({ error: 'push relay not available on this server' }, 503);
  }

  try {
    const relayPayload: PushPayload = { userId: '', title: body.title, body: body.body, badge: body.badge, data: body.data };
    if (body.platform === PUSH_PLATFORM_IOS && hasApns) {
      await sendApns(body.token, relayPayload, c.env);
      return c.json({ ok: true });
    } else if (body.platform === PUSH_PLATFORM_ANDROID_FCM && hasFcm) {
      await sendFcm(body.token, relayPayload, c.env.FCM_SERVER_KEY!);
      return c.json({ ok: true });
    } else if (body.platform === PUSH_PLATFORM_ANDROID_JPUSH && hasJpush) {
      await sendJpush(body.token, relayPayload, c.env.JPUSH_APP_KEY!, c.env.JPUSH_MASTER_SECRET!);
      return c.json({ ok: true });
    }
    return c.json({ error: `unsupported platform or credential missing: ${body.platform}` }, 400);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const unregistered = err instanceof PushError && err.unregistered;
    logger.warn(
      { err, platform: body.platform, token: body.token.slice(0, 10) + '...', unregistered },
      'Push relay failed',
    );
    return c.json({ error: msg, unregistered }, unregistered ? 410 : 502);
  }
});

// ── Push dispatch ─────────────────────────────────────────────────────────────

export interface PushPayload {
  userId: string;
  title: string;
  body: string;
  badge?: number;
  data?: Record<string, string>;
}

/**
 * Dispatch push to all devices for a user.
 * Routes iOS to APNs, Android to FCM.
 */
export async function dispatchPush(payload: PushPayload, env: Env): Promise<void>;
export async function dispatchPush(payload: PushPayload, db: Database, env?: Env): Promise<void>;
export async function dispatchPush(payload: PushPayload, envOrDb: Env | Database, maybeEnv?: Env): Promise<void> {
  let db: Database;
  let env: Env;

  if ('DB' in envOrDb) {
    db = (envOrDb as Env).DB;
    env = envOrDb as Env;
  } else {
    db = envOrDb as Database;
    env = maybeEnv!;
  }

  let tokens: Array<{ token: string; platform: string }> = [];
  try {
    tokens = await db.query<{ token: string; platform: string }>(
      'SELECT token, platform FROM push_tokens WHERE user_id = $1',
      [payload.userId],
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch push tokens');
    return;
  }

  if (tokens.length === 0) return;

  // Atomically increment badge count and read the new value
  let badgeCount = 1;
  try {
    const rows = await db.query<{ badge_count: number }>(
      'UPDATE users SET badge_count = badge_count + 1 WHERE id = $1 RETURNING badge_count',
      [payload.userId],
    );
    if (rows.length > 0) badgeCount = rows[0].badge_count;
  } catch (err) {
    logger.warn({ err, userId: payload.userId }, 'Failed to increment badge_count — falling back to 1');
  }
  payload.badge = badgeCount;

  const hasApns = !!(env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID);
  const hasFcm = !!env.FCM_SERVER_KEY;
  const hasJpush = !!(env.JPUSH_APP_KEY && env.JPUSH_MASTER_SECRET);
  // Self-hosted server detection: no push credentials of any kind configured
  // → this is a self-hosted instance, relay everything through the central
  // server (app.im.codes by default) which holds all credentials.
  const isSelfHosted = !hasApns && !hasFcm && !hasJpush;
  const relayUrl = isSelfHosted ? (env.PUSH_RELAY_URL || 'https://app.im.codes') : null;

  for (const { token, platform } of tokens) {
    try {
      if (relayUrl) {
        // Self-hosted: relay through central server
        await relayPush(relayUrl, token, platform, payload);
      } else if (platform === PUSH_PLATFORM_IOS && hasApns) {
        await sendApns(token, payload, env);
      } else if (platform === PUSH_PLATFORM_ANDROID_FCM && hasFcm) {
        await sendFcm(token, payload, env.FCM_SERVER_KEY!);
      } else if (platform === PUSH_PLATFORM_ANDROID_JPUSH && hasJpush) {
        await sendJpush(token, payload, env.JPUSH_APP_KEY!, env.JPUSH_MASTER_SECRET!);
      }
    } catch (err) {
      logger.warn({ token: token.slice(0, 10) + '...', platform, err: err instanceof Error ? err.message : err }, 'Push dispatch failed');
      if (err instanceof PushError && err.unregistered) {
        await db.execute('DELETE FROM push_tokens WHERE token = $1', [token]).catch(() => {});
      }
    }
  }
}

/** Relay push through a central server (for self-hosted instances without APNs keys). */
async function relayPush(relayBaseUrl: string, token: string, platform: string, payload: PushPayload): Promise<void> {
  const res = await fetch(`${relayBaseUrl}/api/push/relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      platform,
      title: payload.title,
      body: payload.body,
      badge: payload.badge,
      data: payload.data,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const unregistered = res.status === 410;
    throw new PushError(`Relay ${res.status}: ${body}`, unregistered);
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

  // APNS_KEY can be either raw PEM text or base64-encoded PEM
  const keyPem = env.APNS_KEY.startsWith('-----')
    ? env.APNS_KEY
    : Buffer.from(env.APNS_KEY, 'base64').toString('utf8');
  const key = await importPKCS8(keyPem, 'ES256');

  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.APNS_KEY_ID })
    .setIssuer(env.APNS_TEAM_ID)
    .setIssuedAt()
    .sign(key);

  apnsJwtCache = { jwt, expiresAt: Date.now() + 50 * 60 * 1000 };
  return jwt;
}

/** Send APNs push via HTTP/2 (required by Apple). Returns { status, body }. */
async function sendApnsToHost(
  host: string, deviceToken: string, payload: PushPayload, jwt: string, bundleId: string,
): Promise<{ status: number; body: string }> {
  const { connect } = await import('node:http2');
  const jsonBody = JSON.stringify({
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: 'default',
      badge: payload.badge ?? 1,
      'mutable-content': 1,
    },
    ...payload.data,
  });

  return new Promise((resolve, reject) => {
    const client = connect(`https://${host}`);
    client.on('error', (err) => { client.close(); reject(err); });

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${jwt}`,
      'apns-topic': bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });

    let status = 0;
    let data = '';
    req.setEncoding('utf8');
    req.on('response', (headers) => { status = (headers[':status'] as number) ?? 0; });
    req.on('data', (chunk: string) => { data += chunk; });
    req.on('end', () => { client.close(); resolve({ status, body: data }); });
    req.on('error', (err) => { client.close(); reject(err); });

    req.end(jsonBody);
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
    if (res.status === 200) return;

    const unregistered = res.status === 410 || res.body.includes('Unregistered');

    // BadDeviceToken on production → likely a sandbox token, try sandbox
    if (i === 0 && res.status === 400 && res.body.includes('BadDeviceToken')) {
      logger.info({ token: deviceToken.slice(0, 10) }, 'APNs production rejected token, trying sandbox');
      continue;
    }

    throw new PushError(`APNs ${res.status}: ${res.body}`, unregistered);
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

// ── JPush (极光推送, China Android) ───────────────────────────────────────────
//
// API doc: https://docs.jiguang.cn/jpush/server/push/rest_api_v3_push
//
// `registrationId` is the JPush RegistrationID returned by the JPush SDK on
// device init — opaque to us, just stored as push_tokens.token.
//
// Error codes that indicate the device is gone (we should delete the token):
//   1003  invalid registration_id format
//   1011  no valid users / registration_id targets
//   1020  registration_id does not exist
// See: https://docs.jiguang.cn/jpush/server/push/server_error_code

export const JPUSH_API_URL = 'https://api.jpush.cn/v3/push';

/** JPush error codes that mean the token is dead and should be unregistered. */
const JPUSH_UNREGISTERED_CODES: ReadonlySet<number> = new Set([1003, 1011, 1020]);

export async function sendJpush(
  registrationId: string,
  payload: PushPayload,
  appKey: string,
  masterSecret: string,
): Promise<void> {
  const auth = Buffer.from(`${appKey}:${masterSecret}`).toString('base64');
  const requestBody = {
    platform: ['android'],
    audience: { registration_id: [registrationId] },
    notification: {
      android: {
        alert: payload.body,
        title: payload.title,
        extras: payload.data ?? {},
        // priority 2 = high; required for IM-class messages to bypass doze
        priority: 2,
        // category 'msg' aligns with vendor channel IM category (Huawei / Xiaomi)
        category: 'msg',
        ...(payload.badge != null
          ? { badge_set_num: payload.badge, badge_class: 'com.im.codes.MainActivity' }
          : {}),
      },
    },
    options: {
      // 24h retention if device offline; matches FCM / APNs defaults
      time_to_live: 86400,
    },
  };

  const res = await fetch(JPUSH_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    // JPush returns `{"error":{"code":1011,"message":"..."}}` on failure.
    let code: number | null = null;
    try {
      const parsed = JSON.parse(errBody) as { error?: { code?: number } };
      if (typeof parsed?.error?.code === 'number') code = parsed.error.code;
    } catch { /* not JSON */ }
    const unregistered = code !== null && JPUSH_UNREGISTERED_CODES.has(code);
    throw new PushError(`JPush ${res.status} (code=${code ?? '?'}): ${errBody}`, unregistered);
  }
}
