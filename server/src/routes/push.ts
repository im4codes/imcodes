/**
 * Push notification device token management and dispatch.
 * POST /api/push/register — register device token
 * Dispatch: send push on session events (idle, notification, ask, error)
 *
 * iOS:                              APNs HTTP/2 with JWT auth
 * Android (International edition):  FCM HTTP v1 API
 * Android (Mainland China edition): JPush v3 REST API (aggregates the Huawei /
 *                                   Xiaomi / OPPO / vivo / Honor vendor channels)
 *
 * Push credentials live ONLY on the central server (app.im.codes). Self-hosted
 * servers detect "I have no push credentials configured" and relay everything
 * via POST /api/push/relay back to the central server.
 */
import { USER_STATUS, isUserStatusActive, userStatusDenialCode } from '../../../shared/user-status.js';
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import { timingSafeEqual, sha256Hex } from '../security/crypto.js';
import { requireAuth } from '../security/authorization.js';
import { loadUserAccess } from '../security/user-status.js';
import { MemoryRateLimiter } from '../ws/rate-limiter.js';
import { SignJWT, importPKCS8 } from 'jose';
import logger from '../util/logger.js';
import {
  PUSH_PLATFORM_IOS,
  PUSH_PLATFORM_ANDROID_FCM,
  PUSH_PLATFORM_ANDROID_JPUSH,
  PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
  DEFAULT_PUSH_NOTIFICATION_TYPES,
  isPushPlatform,
  isPushNotificationType,
  sanitizePushEnabledServerIds,
  isPushEnabledForServer,
  resolvePushPayloadServerId,
  shouldBypassServerPushMute,
  type PushPlatform,
  type PushNotificationType,
} from '../../../shared/push-notifications.js';
import { listAccessibleControlledMachines } from '../share/machine-access.js';
import { NODE_ROLE } from '../../../shared/remote-exec.js';
import { globalTaskHub } from '../services/global-task-hub.js';
import { PUSH_STREAM_KEEPALIVE_MS, PUSH_STREAM_MAX_BUFFERED_CHUNKS, pushStreamHub, type PushStreamCredential } from '../services/push-stream-hub.js';

export const pushRoutes = new Hono<{
  Bindings: Env;
  Variables: {
    userId: string;
    role: string;
    keyId?: string;
  };
}>();

const APNS_DEVICE_TOKEN_RE = /^[0-9a-fA-F]{64,200}$/;
const pushRelayRateLimiter = new MemoryRateLimiter();
const PUSH_RELAY_RATE_LIMIT = 60;
const PUSH_RELAY_RATE_WINDOW_MS = 60_000;

export function isValidApnsDeviceToken(token: string): boolean {
  return APNS_DEVICE_TOKEN_RE.test(token);
}

async function checkPushStreamApiKeyState(
  db: Database,
  userId: string,
  keyId: string,
): Promise<{ ok: true } | { ok: false; status: 401 | 403; error: string }> {
  const access = await loadUserAccess(db, userId);
  if (!access) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  if (!isUserStatusActive(access.status)) {
    return { ok: false, status: 403, error: userStatusDenialCode(access.status) };
  }
  const row = await db.queryOne<{ id: string }>(
    `SELECT id FROM api_keys
      WHERE id = $1 AND user_id = $2
        AND revoked_at IS NULL
        AND (grace_expires_at IS NULL OR grace_expires_at > $3)`,
    [keyId, userId, Date.now()],
  );
  if (!row) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}

// Auth required for register/unregister/preferences/stream; relay is protected by optional PUSH_RELAY_SECRET + rate limit
pushRoutes.use('/register', requireAuth());
pushRoutes.use('/unregister', requireAuth());
pushRoutes.use('/preferences', requireAuth());
pushRoutes.use('/stream', requireAuth({ refuseDaemonCredential: true }));

// GET /api/push/stream — lightweight SSE push stream for native clients without FCM (e.g. Android withoutFcm)
pushRoutes.get('/stream', async (c) => {
  const userId = c.get('userId' as never) as string;
  const keyId = c.get('keyId' as never) as string | undefined;
  if (!keyId) {
    // Restrict background SSE push stream to native API key Bearer credentials with a real keyId.
    return c.json({ error: 'unauthorized' }, 401);
  }
  let state: Awaited<ReturnType<typeof checkPushStreamApiKeyState>>;
  try {
    state = await checkPushStreamApiKeyState(c.env.DB, userId, keyId);
  } catch (err) {
    logger.warn({ err, userId, keyId }, 'Push stream API key verification failed');
    return c.json({ error: 'service_unavailable' }, 503);
  }
  if (!state.ok) {
    return c.json({ error: state.error }, state.status);
  }
  const credential: PushStreamCredential = { kind: 'api_key', keyId };

  const encoder = new TextEncoder();
  const signal = c.req.raw.signal;
  let cleanupFn: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let cleaned = false;
      let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;

      const sendChunk = (chunk: string): boolean => {
        if (cleaned) return false;
        const desired = controller.desiredSize;
        if (desired !== null && desired <= -PUSH_STREAM_MAX_BUFFERED_CHUNKS) {
          logger.warn({ userId, desiredSize: desired }, 'Closing slow SSE push stream consumer');
          cleanup();
          return false;
        }
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          cleanup();
          return false;
        }
      };

      const onAbort = (): void => {
        cleanup();
      };

      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        if (keepaliveTimer !== null) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          // ignore
        }
        if (unsubscribe) {
          const fn = unsubscribe;
          unsubscribe = null;
          fn();
        }
        try {
          controller.close();
        } catch {
          // ignore already-closed controller
        }
      };

      cleanupFn = cleanup;

      if (signal.aborted) {
        cleanup();
        return;
      }

      unsubscribe = pushStreamHub.subscribe(userId, {
        send: sendChunk,
        close: cleanup,
        credential,
      });

      signal.addEventListener('abort', onAbort, { once: true });

      if (!sendChunk(': connected\n\n')) {
        cleanup();
        return;
      }

      keepaliveTimer = setInterval(() => {
        if (cleaned) return;
        void checkPushStreamApiKeyState(c.env.DB, userId, keyId)
          .then((nextState) => {
            if (cleaned) return;
            if (!nextState.ok) {
              cleanup();
              return;
            }
            if (!sendChunk(': keepalive\n\n')) {
              cleanup();
            }
          })
          .catch((err) => {
            // Transient DB hiccup must not revoke/abort an active SSE session prematurely;
            // keepalive continues and next tick re-checks DB state.
            logger.warn({ err, userId, keyId }, 'Push stream API key revalidation failed (transient)');
            if (!cleaned && !sendChunk(': keepalive\n\n')) {
              cleanup();
            }
          });
      }, PUSH_STREAM_KEEPALIVE_MS);
      if (typeof (keepaliveTimer as { unref?: () => void }).unref === 'function') {
        (keepaliveTimer as { unref: () => void }).unref();
      }
    },
    cancel() {
      cleanupFn?.();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
});

// POST /api/push/register — store device token for user
pushRoutes.post('/register', async (c) => {
  const userId = c.get('userId' as never) as string;
  const body = await c.req.json<{ token: string; platform: PushPlatform; notificationTypes?: string[] }>().catch(() => null);
  if (!body?.token || !body?.platform) return c.json({ error: 'token and platform required' }, 400);
  if (!isPushPlatform(body.platform)) {
    return c.json({ error: `unsupported platform: ${body.platform}` }, 400);
  }

  const rawTypes = body.notificationTypes;
  const hasExplicitTypes = Array.isArray(rawTypes);
  const notificationTypes = hasExplicitTypes
    ? rawTypes.filter(isPushNotificationType)
    : undefined;

  try {
    if (hasExplicitTypes) {
      await c.env.DB.execute(
        `INSERT INTO push_tokens (user_id, token, platform, notification_types, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, token) DO UPDATE SET platform = excluded.platform, notification_types = excluded.notification_types`,
        [userId, body.token, body.platform, notificationTypes, Date.now()],
      );
      try {
        await c.env.DB.execute(
          'UPDATE users SET push_notification_types = $1 WHERE id = $2',
          [notificationTypes, userId],
        );
      } catch {
        // best-effort sync
      }
    } else {
      let userRow: { push_notification_types?: string[] | null } | null = null;
      try {
        userRow = await c.env.DB.queryOne<{ push_notification_types?: string[] | null }>(
          'SELECT push_notification_types FROM users WHERE id = $1 LIMIT 1',
          [userId],
        );
      } catch {
        userRow = null;
      }
      const seededTypes = Array.isArray(userRow?.push_notification_types)
        ? userRow.push_notification_types.filter(isPushNotificationType)
        : DEFAULT_PUSH_NOTIFICATION_TYPES;
      await c.env.DB.execute(
        `INSERT INTO push_tokens (user_id, token, platform, notification_types, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, token) DO UPDATE SET platform = excluded.platform`,
        [userId, body.token, body.platform, seededTypes, Date.now()],
      );
    }
  } catch (err) {
    logger.warn({ err }, 'push_tokens insert failed');
  }

  return c.json({ ok: true });
});

// GET /api/push/preferences — get notification types and allowed servers preferences
pushRoutes.get('/preferences', async (c) => {
  const userId = c.get('userId' as never) as string;
  const token = c.req.query('token');
  let row: { notification_types?: string[] | null } | null = null;
  if (token) {
    row = await c.env.DB.queryOne<{ notification_types?: string[] | null }>(
      'SELECT notification_types FROM push_tokens WHERE user_id = $1 AND token = $2 LIMIT 1',
      [userId, token],
    );
  }
  if (!row) {
    row = await c.env.DB.queryOne<{ notification_types?: string[] | null }>(
      'SELECT notification_types FROM push_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [userId],
    );
  }
  const userRow = await c.env.DB.queryOne<{
    push_enabled_server_ids?: string[] | null;
    push_notification_types?: string[] | null;
  }>(
    'SELECT push_enabled_server_ids, push_notification_types FROM users WHERE id = $1 LIMIT 1',
    [userId],
  );
  const types = (token && row && Array.isArray(row.notification_types))
    ? row.notification_types
    : Array.isArray(userRow?.push_notification_types)
      ? userRow.push_notification_types
      : (row && Array.isArray(row.notification_types))
        ? row.notification_types
        : DEFAULT_PUSH_NOTIFICATION_TYPES;
  const enabledServerIds = Array.isArray(userRow?.push_enabled_server_ids)
    ? sanitizePushEnabledServerIds(userRow.push_enabled_server_ids)
    : null;
  return c.json({
    ok: true,
    types,
    defaultTypes: DEFAULT_PUSH_NOTIFICATION_TYPES,
    enabledServerIds,
  });
});

// POST /api/push/preferences — update notification types and/or allowed servers preferences
pushRoutes.post('/preferences', async (c) => {
  const userId = c.get('userId' as never) as string;
  const body = await c.req.json<{ types?: unknown; enabledServerIds?: unknown; token?: string }>().catch(() => null);
  if (!body) {
    return c.json({ error: 'types or enabledServerIds array required' }, 400);
  }
  if (body.types !== undefined && !Array.isArray(body.types)) {
    return c.json({ error: 'types must be an array' }, 400);
  }
  if (body.enabledServerIds !== undefined && body.enabledServerIds !== null && !Array.isArray(body.enabledServerIds)) {
    return c.json({ error: 'enabledServerIds must be an array or null' }, 400);
  }
  const hasTypes = Array.isArray(body.types);
  const hasEnabledServerIds = body.enabledServerIds === null || Array.isArray(body.enabledServerIds);
  if (!hasTypes && !hasEnabledServerIds) {
    return c.json({ error: 'types or enabledServerIds array required' }, 400);
  }

  const sanitizedTypes = hasTypes ? (body.types as unknown[]).filter(isPushNotificationType) : undefined;
  const sanitizedServerIds = body.enabledServerIds === null
    ? null
    : Array.isArray(body.enabledServerIds)
      ? sanitizePushEnabledServerIds(body.enabledServerIds)
      : undefined;

  try {
    if (sanitizedTypes !== undefined && body.token) {
      await c.env.DB.execute(
        'UPDATE push_tokens SET notification_types = $1 WHERE user_id = $2 AND token = $3',
        [sanitizedTypes, userId, body.token],
      );
      if (sanitizedServerIds !== undefined) {
        await c.env.DB.execute(
          'UPDATE users SET push_enabled_server_ids = $1 WHERE id = $2',
          [sanitizedServerIds, userId],
        );
      }
    } else if (sanitizedTypes !== undefined && sanitizedServerIds !== undefined) {
      await c.env.DB.execute(
        'UPDATE push_tokens SET notification_types = $1 WHERE user_id = $2',
        [sanitizedTypes, userId],
      );
      await c.env.DB.execute(
        'UPDATE users SET push_notification_types = $1, push_enabled_server_ids = $2 WHERE id = $3',
        [sanitizedTypes, sanitizedServerIds, userId],
      );
    } else if (sanitizedTypes !== undefined) {
      await c.env.DB.execute(
        'UPDATE push_tokens SET notification_types = $1 WHERE user_id = $2',
        [sanitizedTypes, userId],
      );
      await c.env.DB.execute(
        'UPDATE users SET push_notification_types = $1 WHERE id = $2',
        [sanitizedTypes, userId],
      );
    } else if (sanitizedServerIds !== undefined) {
      await c.env.DB.execute(
        'UPDATE users SET push_enabled_server_ids = $1 WHERE id = $2',
        [sanitizedServerIds, userId],
      );
    }
  } catch (err) {
    logger.error({ err, userId }, 'Failed to update push preferences');
    return c.json({ error: 'failed to update push preferences' }, 500);
  }

  return c.json({
    ok: true,
    ...(sanitizedTypes !== undefined ? { types: sanitizedTypes } : {}),
    ...(sanitizedServerIds !== undefined ? { enabledServerIds: sanitizedServerIds } : {}),
  });
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
  const relaySecret = c.env.PUSH_RELAY_SECRET?.trim();
  if (relaySecret) {
    const authHeader = c.req.header('Authorization');
    const suppliedSecret = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!suppliedSecret || !timingSafeEqual(suppliedSecret, relaySecret)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
  }

  const clientIp = (c.get('clientIp' as never) as string | undefined) || 'unknown';
  if (!pushRelayRateLimiter.check(`relay:${clientIp}`, PUSH_RELAY_RATE_LIMIT, PUSH_RELAY_RATE_WINDOW_MS)) {
    return c.json({ error: 'rate_limited', retryAfter: 60 }, 429);
  }

  const body = await c.req.json<{
    token: string;
    platform: string;
    title: string;
    body: string;
    badge?: number;
    data?: Record<string, string>;
    type?: string;
  }>().catch(() => null);
  if (!body?.token || !body?.platform || !body?.title) {
    return c.json({ error: 'token, platform, title, body required' }, 400);
  }
  if (body.platform === PUSH_PLATFORM_IOS && !isValidApnsDeviceToken(body.token)) {
    return c.json({ error: 'invalid_apns_device_token' }, 400);
  }

  // This server can serve relay if it has any push credential configured.
  // (Used to require APNs only; relaxed when JPush was added so a relay
  // server that holds only China credentials could still serve android-jpush.)
  const hasApns = !!(c.env.APNS_KEY && c.env.APNS_KEY_ID && c.env.APNS_TEAM_ID);
  const hasFcm = !!c.env.FCM_SERVICE_ACCOUNT_JSON?.trim();
  const hasJpush = !!(c.env.JPUSH_APP_KEY && c.env.JPUSH_MASTER_SECRET);
  if (!hasApns && !hasFcm && !hasJpush) {
    return c.json({ error: 'push relay not available on this server' }, 503);
  }

  try {
    const relayType = isPushNotificationType(body.type) ? body.type : undefined;
    const relayPayload: PushPayload = {
      userId: '',
      title: body.title,
      body: body.body,
      badge: body.badge,
      data: body.data,
      type: relayType,
    };
    if (body.platform === PUSH_PLATFORM_IOS && hasApns) {
      await sendApns(body.token, relayPayload, c.env);
      return c.json({ ok: true });
    } else if (body.platform === PUSH_PLATFORM_ANDROID_FCM && hasFcm) {
      await sendFcm(body.token, relayPayload, c.env.FCM_SERVICE_ACCOUNT_JSON!, c.env.FCM_PROJECT_ID);
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
  type?: PushNotificationType;
  serverId?: string;
  eventId?: string;
  suppressMobilePush?: boolean;
  suppressTokenPush?: boolean;
  suppressStreamPush?: boolean;
  suppressDesktopPush?: boolean;
}

async function getAccessiblePushServerIds(db: Database, userId: string): Promise<string[]> {
  // Only needed when user.push_enabled_server_ids is null (auto-default enables
  // push iff the user has exactly one accessible server). Fetch at most 2 distinct
  // IDs per side instead of loading full server rows and 5,000+ controlled hosts.
  const [fullServerRows, controlledMachines] = await Promise.all([
    db.query<{ id: string }>(
      `SELECT id FROM (
         SELECT s.id
           FROM servers s
          WHERE s.user_id = $1 AND s.node_role IS DISTINCT FROM $2
         UNION
         SELECT s.id
           FROM servers s
           JOIN machine_groups mg ON mg.server_id = s.id
           JOIN team_members tm ON tm.team_id = mg.team_id
          WHERE tm.user_id = $1 AND s.user_id != $1 AND s.node_role IS DISTINCT FROM $2
       ) AS accessible_full
       LIMIT 2`,
      [userId, NODE_ROLE.CONTROLLED],
    ),
    listAccessibleControlledMachines(db, userId, Date.now(), 2),
  ]);
  const ids = new Set<string>();
  for (const s of fullServerRows) ids.add(s.id);
  for (const m of controlledMachines) ids.add(m.id);
  return [...ids];
}

function resolvePushEventId(payload: PushPayload, targetServerId: string | null): string {
  const explicit = typeof payload.eventId === 'string' ? payload.eventId.trim() : '';
  if (explicit) {
    return Buffer.byteLength(explicit, 'utf8') <= 128
      ? explicit
      : `evt_${sha256Hex(explicit).slice(0, 32)}`;
  }
  const scope = payload.data?.session ?? payload.data?.taskId ?? '';
  const eventType = payload.data?.type ?? payload.type ?? 'push';
  const raw = `${eventType}:${targetServerId ?? ''}:${scope}:${payload.title}:${payload.body}`;
  return Buffer.byteLength(raw, 'utf8') <= 128
    ? raw
    : `evt_${sha256Hex(raw).slice(0, 32)}`;
}

/**
 * Dispatch push to all devices for a user.
 * Routes iOS to APNs, Android to FCM/JPush, and live desktop/pc-app clients via GlobalTaskHub.
 */
export async function dispatchPush(payload: PushPayload, env: Env): Promise<void>;
export async function dispatchPush(payload: PushPayload, db: Database, env?: Env): Promise<void>;
export async function dispatchPush(
  payload: PushPayload,
  envOrDb: Env | Database,
  maybeEnv?: Env,
  hubOverrides?: {
    globalHub?: typeof globalTaskHub;
  },
): Promise<void> {
  let db: Database;
  let env: Env;

  if ('DB' in envOrDb) {
    db = (envOrDb as Env).DB;
    env = envOrDb as Env;
  } else {
    db = envOrDb as Database;
    env = maybeEnv!;
  }
  const taskHub = hubOverrides?.globalHub ?? globalTaskHub;

  const targetServerId = resolvePushPayloadServerId(payload);

  let rows: Array<{
    user_status?: string | null;
    push_enabled_server_ids?: string[] | null;
    push_notification_types?: string[] | null;
    token: string | null;
    platform: string | null;
    notification_types?: string[] | null;
  }> = [];
  try {
    rows = await db.query<{
      user_status?: string | null;
      push_enabled_server_ids?: string[] | null;
      push_notification_types?: string[] | null;
      token: string | null;
      platform: string | null;
      notification_types?: string[] | null;
    }>(
      // A disabled user's devices receive nothing (security/user-status.ts); their registrations stay, so enabling the account resumes it.
      `SELECT usr.status AS user_status,
              usr.push_enabled_server_ids,
              usr.push_notification_types,
              t.token,
              t.platform,
              t.notification_types
         FROM users usr
         LEFT JOIN push_tokens t ON t.user_id = usr.id
        WHERE usr.id = $1 AND usr.status = '${USER_STATUS.ACTIVE}'`,
      [payload.userId],
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch push tokens');
    return;
  }

  if (rows.length === 0) return;
  if (rows[0].user_status !== undefined && !isUserStatusActive(rows[0].user_status)) return;

  const tokens = rows.filter(
    (r): r is {
      user_status?: string | null;
      push_enabled_server_ids?: string[] | null;
      push_notification_types?: string[] | null;
      token: string;
      platform: string;
      notification_types?: string[] | null;
    } => typeof r.token === 'string' && typeof r.platform === 'string',
  );

  const rawEnabledServerIds = rows[0].push_enabled_server_ids;
  const userNotificationTypes: readonly string[] | null = tokens.length > 0
    ? (Array.isArray(rows[0].push_notification_types) ? rows[0].push_notification_types : null)
    : (Array.isArray(rows[0].push_notification_types) ? rows[0].push_notification_types : DEFAULT_PUSH_NOTIFICATION_TYPES);

  const matchingTokens = tokens.filter((t) => {
    if (!payload.type) return true;
    const allowed = Array.isArray(t.notification_types)
      ? t.notification_types
      : (DEFAULT_PUSH_NOTIFICATION_TYPES as readonly string[]);
    return allowed.includes(payload.type);
  });

  const desktopAllowed = userNotificationTypes !== null
    ? (!payload.type || userNotificationTypes.includes(payload.type))
    : (matchingTokens.length > 0 || !payload.type);
  const streamAllowed = desktopAllowed;

  const wantsDesktop = desktopAllowed && !payload.suppressDesktopPush;
  const wantsTokenMobile = matchingTokens.length > 0 && !payload.suppressMobilePush && !payload.suppressTokenPush;
  const wantsStreamMobile = streamAllowed && (
    payload.suppressStreamPush === false
      ? true
      : (!payload.suppressMobilePush && !payload.suppressStreamPush)
  );

  if (!wantsDesktop && !wantsTokenMobile && !wantsStreamMobile) return;

  if (targetServerId && !shouldBypassServerPushMute(payload.type)) {
    if (Array.isArray(rawEnabledServerIds)) {
      if (!isPushEnabledForServer(rawEnabledServerIds, targetServerId, [])) return;
    } else {
      const accessibleServerIds = await getAccessiblePushServerIds(db, payload.userId);
      if (!isPushEnabledForServer(null, targetServerId, accessibleServerIds)) return;
    }
  }

  const eventId = resolvePushEventId(payload, targetServerId);

  if (wantsDesktop) {
    await taskHub.notifyPushNotification(db, {
      userId: payload.userId,
      eventId,
      title: payload.title,
      body: payload.body,
      ...(payload.type ? { notificationType: payload.type } : {}),
      ...(targetServerId ? { serverId: targetServerId } : {}),
      ...(payload.data?.session ? { session: payload.data.session } : {}),
      ...(payload.data?.taskId ? { taskId: payload.data.taskId } : {}),
      ...(payload.data?.type ? { eventType: payload.data.type } : {}),
      ts: Date.now(),
    }).catch((err) => {
      logger.warn({ err, userId: payload.userId }, 'Desktop globalTaskHub notification emit failed');
    });
  }

  if (!wantsTokenMobile && !wantsStreamMobile) return;

  // Atomically increment shared user badge_count ONLY for matching mobile push tokens (APNs/FCM/JPush).
  // SSE-only clients must never inflate APNs/FCM badges or trigger spurious DB writes when no replica has SSE.
  let badgeCount: number | undefined;
  if (wantsTokenMobile) {
    badgeCount = 1;
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
  }

  if (wantsStreamMobile) {
    await taskHub.notifyPushStream(db, {
      userId: payload.userId,
      eventId,
      title: payload.title,
      body: payload.body,
      ...(payload.type ? { notificationType: payload.type } : {}),
      ...(badgeCount != null ? { badge: badgeCount } : {}),
      ...(payload.data ? { data: payload.data } : {}),
      ts: Date.now(),
    }).catch((err) => {
      logger.warn({ err, userId: payload.userId }, 'SSE pushStream notification emit failed');
    });
  }

  if (!wantsTokenMobile) return;

  const hasApns = !!(env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID);
  const hasFcm = !!env.FCM_SERVICE_ACCOUNT_JSON?.trim();
  const hasJpush = !!(env.JPUSH_APP_KEY && env.JPUSH_MASTER_SECRET);
  // Self-hosted server detection: no push credentials of any kind configured
  // → this is a self-hosted instance, relay everything through the central
  // server (app.im.codes by default) which holds all credentials.
  const isSelfHosted = !hasApns && !hasFcm && !hasJpush;
  const configuredRelayUrl = env.PUSH_RELAY_URL?.trim();
  const relayUrl = isSelfHosted ? (configuredRelayUrl || 'https://app.im.codes') : null;
  const relayClientSecret = configuredRelayUrl ? (env.PUSH_RELAY_CLIENT_SECRET?.trim() || undefined) : undefined;

  for (const { token, platform } of matchingTokens) {
    try {
      if (relayUrl) {
        // Self-hosted: relay through central server
        await relayPush(relayUrl, token, platform, payload, relayClientSecret);
      } else if (platform === PUSH_PLATFORM_IOS && hasApns) {
        await sendApns(token, payload, env);
      } else if (platform === PUSH_PLATFORM_ANDROID_FCM && hasFcm) {
        await sendFcm(token, payload, env.FCM_SERVICE_ACCOUNT_JSON!, env.FCM_PROJECT_ID);
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
async function relayPush(
  relayBaseUrl: string,
  token: string,
  platform: string,
  payload: PushPayload,
  relaySecret?: string,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const normalizedBase = relayBaseUrl.replace(/\/+$/, '');
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify({
      token,
      platform,
      title: payload.title,
      body: payload.body,
      badge: payload.badge,
      data: payload.data,
      type: payload.type,
    }),
    signal: AbortSignal.timeout(10_000),
  };
  if (relaySecret) {
    headers.Authorization = `Bearer ${relaySecret}`;
    init.redirect = 'error';
  }
  const res = await fetch(`${normalizedBase}/api/push/relay`, init);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const unregistered = res.status === 410;
    throw new PushError(`Relay ${res.status}: ${body}`, unregistered);
  }
}

export class PushError extends Error {
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
  if (!isValidApnsDeviceToken(deviceToken)) {
    throw new PushError('Invalid APNs device token', false);
  }
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
  if (!isValidApnsDeviceToken(deviceToken)) {
    throw new PushError('Invalid APNs device token', false);
  }
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

// ── FCM HTTP v1 (Android) ────────────────────────────────────────────────────

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_FCM_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const FCM_TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000;

interface FcmServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface FcmTokenCacheEntry {
  accessToken: string;
  expiresAt: number;
}

const fcmTokenCache = new Map<string, FcmTokenCacheEntry>();
const fcmTokenFlights = new Map<string, Promise<string>>();

/** Clear FCM OAuth state between tests and after credential rotation. */
export function resetFcmAuthCacheForTesting(): void {
  fcmTokenCache.clear();
  fcmTokenFlights.clear();
}

function parseFcmServiceAccount(raw: string): FcmServiceAccount {
  const source = raw.trim();
  if (!source) throw new Error('FCM_SERVICE_ACCOUNT_JSON is empty');

  let json = source;
  if (!source.startsWith('{')) {
    try {
      json = Buffer.from(source, 'base64').toString('utf8');
    } catch {
      throw new Error('FCM_SERVICE_ACCOUNT_JSON is not valid JSON or base64 JSON');
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('FCM service account must be a JSON object');
  const value = parsed as Record<string, unknown>;
  const projectId = typeof value.project_id === 'string' ? value.project_id.trim() : '';
  const clientEmail = typeof value.client_email === 'string' ? value.client_email.trim() : '';
  const privateKey = typeof value.private_key === 'string' ? value.private_key.replace(/\\n/g, '\n') : '';
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('FCM service account requires project_id, client_email, and private_key');
  }
  const tokenUri = typeof value.token_uri === 'string' && value.token_uri.trim()
    ? value.token_uri.trim()
    : DEFAULT_FCM_TOKEN_URI;
  let parsedUri: URL;
  try {
    parsedUri = new URL(tokenUri);
  } catch {
    throw new Error('FCM service account token_uri must be a valid HTTPS URL');
  }
  if (parsedUri.protocol !== 'https:') throw new Error('FCM service account token_uri must use HTTPS');
  return { project_id: projectId, client_email: clientEmail, private_key: privateKey, token_uri: parsedUri.toString() };
}

async function fetchFcmAccessToken(account: FcmServiceAccount): Promise<FcmTokenCacheEntry> {
  const tokenUri = account.token_uri ?? DEFAULT_FCM_TOKEN_URI;
  const key = await importPKCS8(account.private_key, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: FCM_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(account.client_email)
    .setSubject(account.client_email)
    .setAudience(tokenUri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const text = await response.text().catch(() => '');
  let body: { access_token?: unknown; expires_in?: unknown; error?: unknown } = {};
  try { body = JSON.parse(text) as typeof body; } catch { /* handled below */ }
  if (!response.ok || typeof body.access_token !== 'string') {
    throw new Error(`FCM OAuth token request failed (${response.status}): ${text}`);
  }
  const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
    ? body.expires_in
    : 3600;
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1000,
  };
}

async function getFcmAccessToken(account: FcmServiceAccount): Promise<string> {
  const cacheKey = `${account.project_id}:${account.client_email}`;
  const cached = fcmTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - FCM_TOKEN_REFRESH_LEEWAY_MS) return cached.accessToken;

  const existingFlight = fcmTokenFlights.get(cacheKey);
  if (existingFlight) return existingFlight;

  const flight = (async () => {
    const entry = await fetchFcmAccessToken(account);
    fcmTokenCache.set(cacheKey, entry);
    return entry.accessToken;
  })();
  fcmTokenFlights.set(cacheKey, flight);
  try {
    return await flight;
  } finally {
    if (fcmTokenFlights.get(cacheKey) === flight) fcmTokenFlights.delete(cacheKey);
  }
}

function fcmData(payload: PushPayload): Record<string, string> {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload.data ?? {})) {
    if (value !== undefined && value !== null) data[key] = String(value);
  }
  return data;
}

function fcmErrorIsUnregistered(status: number, text: string): boolean {
  let body: { error?: { status?: string; details?: Array<{ errorCode?: string }> } } = {};
  try { body = JSON.parse(text) as typeof body; } catch { /* non-JSON error */ }
  const details = body.error?.details ?? [];
  const hasUnregisteredDetail = details.some((detail) => detail?.errorCode === 'UNREGISTERED');
  return status === 410 || hasUnregisteredDetail;
}

export async function sendFcm(
  deviceToken: string,
  payload: PushPayload,
  serviceAccountRaw: string,
  projectIdOverride?: string,
): Promise<void> {
  const account = parseFcmServiceAccount(serviceAccountRaw);
  const projectId = projectIdOverride?.trim() || account.project_id;
  if (!projectId) throw new Error('FCM project_id is required');
  const cacheKey = `${projectId}:${account.client_email}`;
  const data = fcmData(payload);
  const message: Record<string, unknown> = {
    token: deviceToken,
    notification: { title: payload.title, body: payload.body },
    android: {
      priority: 'HIGH',
      notification: { sound: 'default' },
    },
  };
  if (Object.keys(data).length > 0) message.data = data;

  let retriedAuth = false;
  while (true) {
    const accessToken = await getFcmAccessToken({ ...account, project_id: projectId });
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      },
    );
    const text = await response.text().catch(() => '');
    if (response.ok) return;
    if (response.status === 401 && !retriedAuth) {
      fcmTokenCache.delete(cacheKey);
      retriedAuth = true;
      continue;
    }
    throw new PushError(`FCM ${response.status}: ${text}`, fcmErrorIsUnregistered(response.status, text));
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
        // priority 1 (high) — developer-tool notifications should arrive
        // promptly but are not life-critical. Value 2 (max) is reserved by
        // most vendors for IM-class and triggers stricter quota checks.
        // Highest-level security warning (remote desktop auto unlock) uses max priority 2.
        priority: payload.type === PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP ? 2 : 1,
        // Maps to Android Notification.CATEGORY_SERVICE — matches what this
        // app actually emits ("AI agent finished a task", "session needs
        // your attention"). NOT 'msg' / CATEGORY_MESSAGE: that's the IM
        // chat category, which requires IM-class qualification at every
        // vendor (Huawei / Xiaomi / OPPO / vivo) and would be rejected on
        // review for a developer tool.
        category: 'service',
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
