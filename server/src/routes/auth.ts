import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from '../env.js';
import { isEmailAuthEnabled } from '../env.js';
import type { Database } from '../db/client.js';
import {
  createUser,
  getUserByEmail,
  getUserById,
  getUserByUsername,
  getUserByVerifiedEmail,
  getSetting,
  updateUserStatus,
  withTransaction,
} from '../db/queries.js';
import { randomHex, sha256Hex, signJwt, verifyJwt, hashPassword, verifyPassword } from '../security/crypto.js';
import { checkAuthLockout, rateLimiter, recordAuthFailure } from '../security/lockout.js';
import { DOC_COLLABORATOR_SCOPE_REFUSAL, requireAuth, resolveAuthOutcome, resolveServerWebSocketAccess } from '../security/authorization.js';
import {
  buildDesktopSetupCallbackRedirectUrl,
  DESKTOP_SETUP_CALLBACK_QUERY_PARAM,
  parseDesktopSetupCallbackUrl,
} from '../../../shared/desktop-setup-auth.js';
import { alignedSessionIssuedAt, evaluateUserAccess, isUserActive, loadUserAccess, nextSessionValidAfter } from '../security/user-status.js';
import { isUserStatusActive } from '../../../shared/user-status.js';
import { evictStaleUserBrowserSockets } from '../ws/account-watch.js';
import { WsBridge } from '../ws/bridge.js';
import { COOKIE_SESSION, COOKIE_CSRF, HEADER_CSRF } from '../../../shared/cookie-names.js';
import { AUTH_ERROR_CODES } from '../../../shared/auth-error-codes.js';
import { ACCOUNT_SESSION_JWT_TYPE } from '../../../shared/auth-token-types.js';
import { validatePasswordComplexity, USERNAME_REGEX } from '../../../shared/password-rules.js';
import { EMAIL_AUTH_PURPOSE } from '../../../shared/email-auth.js';
import { EmailServiceError } from '../services/email.js';
import {
  consumeEmailVerificationCode,
  getDbClockMs,
  isValidEmail,
  isValidEmailOtp,
  issueEmailVerificationCode,
  normalizeEmail,
  resolveEmailLanguage,
} from '../services/email-auth.js';
import { deleteTokenUsageFactsForUser } from '../db/token-usage-queries.js';
import { z } from 'zod';
import logger from '../util/logger.js';
import { CLIENT_TIMEZONE_HEADER } from '../../../shared/http-header-names.js';
import { rememberClientTimezone } from '../util/client-timezone.js';
import { revokeBrowserAccountSession } from '../services/remote-desktop-account-auth.js';
import { globalTaskHub } from '../services/global-task-hub.js';
import { r2RelayConfig } from '../services/r2-relay.js';

export const authRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

const AUTH_NONCE_TTL_MS = 60_000;
const AUTH_NONCE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const OAUTH_RELAY_KEY_ID = 'oauth-relay';
export const DOC_RELAY_TICKET_PURPOSE = 'doc-relay-ticket';
export const DOC_RELAY_TICKET_ID_PREFIX = `${DOC_RELAY_TICKET_PURPOSE}:`;

let authNonceCleanupDb: Database | null = null;
let authNonceCleanupTimer: ReturnType<typeof setInterval> | null = null;
let authNonceStartupCleanupPromise: Promise<void> | null = null;

// Task 5: Cache-Control: no-store on all auth endpoints
authRoutes.use('/*', async (c, next): Promise<Response | void> => {
  scheduleAuthNonceCleanup(c.env.DB);
  const path = c.req.path;
  const method = c.req.method;
  const isDocCollabAllowedAuthPath =
    (method === 'GET' && path.endsWith('/user/me')) ||
    (method === 'POST' && (path.endsWith('/refresh') || path.endsWith('/logout') || path.endsWith('/relay/verify'))) ||
    path.includes('/github') ||
    path.includes('/google');
  if (!isDocCollabAllowedAuthPath) {
    const resolution = await resolveAuthOutcome(c);
    if (resolution.auth?.scope === 'doc_collaborator') {
      return c.json({ error: 'forbidden', reason: DOC_COLLABORATOR_SCOPE_REFUSAL }, 403);
    }
  }
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
});

// ── Shared auth helper ────────────────────────────────────────────────────
// Resolves the authenticated user ID from cookie (browser) or Bearer token (API key / CLI).
// Accepts any Hono Context with Bindings: Env — Variables generic is intentionally widened.
type AnyAuthContext = { req: { header(name: string): string | undefined }; env: Env; get?: (key: string) => unknown };

type AuthAuditEntry = {
  userId?: string;
  serverId?: string;
  action: string;
  details?: Record<string, unknown>;
  ip?: string;
  outcomeCode?: string;
};

type AuthRequestMetadata = {
  platform: string;
  appVersion: string;
  bundleVersion: string;
};

async function resolveUserId(c: AnyAuthContext): Promise<string | null> {
  // The ONE credential resolver (security/authorization.ts): login cookie / bearer JWT / API key, each followed by the account check, so a
  // disabled or pending user holds no identity here either. A daemon server-token is not an account credential for these routes.
  const resolution = await resolveAuthOutcome(c as unknown as Parameters<typeof resolveAuthOutcome>[0]);
  return resolution.auth && !resolution.auth.serverId ? resolution.auth.userId : null;
}

function toClientUser(user: Awaited<ReturnType<typeof getUserById>>) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    email: user.email ?? null,
    email_verified: Boolean(user.email_verified_at),
    is_admin: user.is_admin,
    status: user.status,
    has_password: !!user.password_hash,
  };
}

function mapPgUniqueConstraintError(err: unknown): (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES] | null {
  if (!err || typeof err !== 'object' || !('code' in err) || (err as { code?: unknown }).code !== '23505') {
    return null;
  }
  const constraint = 'constraint' in err && typeof err.constraint === 'string' ? err.constraint : '';
  if (constraint === 'idx_users_email_lower') {
    return AUTH_ERROR_CODES.EMAIL_TAKEN;
  }
  if (constraint === 'users_username_key') {
    return AUTH_ERROR_CODES.USERNAME_TAKEN;
  }
  return null;
}

function getAuthRequestMetadata(c: AnyAuthContext): AuthRequestMetadata {
  const platform = (c.req.header('X-Platform') ?? c.req.header('x-platform') ?? 'unknown').trim().toLowerCase() || 'unknown';
  const appVersion = (c.req.header('X-App-Version') ?? c.req.header('x-app-version') ?? 'unknown').trim() || 'unknown';
  const bundleVersion = (c.req.header('X-Bundle-Version') ?? c.req.header('x-bundle-version') ?? 'none').trim() || 'none';
  return { platform, appVersion, bundleVersion };
}

export async function logAuthAudit(c: AnyAuthContext, entry: AuthAuditEntry, db: Database): Promise<void> {
  try {
    const metadata = getAuthRequestMetadata(c);
    const ip = entry.ip ?? ((c.get ? (c.get('clientIp' as never) as string | undefined) : undefined) ?? 'unknown');
    await db.execute(
      'INSERT INTO audit_log (id, user_id, server_id, action, details, ip, platform, app_version, bundle_version, outcome_code, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
      [
        randomHex(16),
        entry.userId ?? null,
        entry.serverId ?? null,
        entry.action,
        entry.details ? JSON.stringify(entry.details) : null,
        ip,
        metadata.platform,
        metadata.appVersion,
        metadata.bundleVersion,
        entry.outcomeCode ?? 'success',
        Date.now(),
      ],
    );
  } catch (err) {
    logger.error({ action: entry.action, err }, 'Audit log write failed');
  }
}

export async function issueAuthNonce(
  db: Database,
  params: { apiKey: string; userId: string; keyId: string },
): Promise<string> {
  const nonce = randomHex(32);
  const now = Date.now();
  await db.execute(
    'INSERT INTO auth_nonces (nonce, api_key, user_id, key_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [nonce, params.apiKey, params.userId, params.keyId, now + AUTH_NONCE_TTL_MS, now],
  );
  return nonce;
}

export async function cleanupExpiredAuthNonces(db: Database): Promise<number> {
  const result = await db.execute(
    'DELETE FROM auth_nonces WHERE expires_at < $1 AND key_id != $2',
    [Date.now(), OAUTH_RELAY_KEY_ID],
  );
  return result.changes ?? 0;
}

export function scheduleAuthNonceCleanup(db: Database): void {
  authNonceCleanupDb = db;
  if (authNonceCleanupTimer) return;
  authNonceCleanupTimer = setInterval(() => {
    if (authNonceCleanupDb) {
      void cleanupExpiredAuthNonces(authNonceCleanupDb);
    }
  }, AUTH_NONCE_CLEANUP_INTERVAL_MS);
  authNonceCleanupTimer.unref?.();
}

export async function initializeAuthNonceCleanup(db: Database): Promise<void> {
  authNonceCleanupDb = db;
  if (!authNonceStartupCleanupPromise) {
    authNonceStartupCleanupPromise = cleanupExpiredAuthNonces(db)
      .then(() => undefined)
      .catch((err) => {
        authNonceStartupCleanupPromise = null;
        throw err;
      });
  }
  await authNonceStartupCleanupPromise;
  scheduleAuthNonceCleanup(db);
}

// POST /api/auth/register — create a new user and issue initial API key
authRoutes.post('/register', async (c) => {
  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  if (!rateLimiter.check(`auth-register:${ip}`, 20, 60_000)) {
    return c.json({ error: AUTH_ERROR_CODES.TOO_MANY_ATTEMPTS, retryAfter: 60 }, 429);
  }

  // Check if registration is enabled
  const regEnabled = await getSetting(c.env.DB, 'registration_enabled');
  if (regEnabled === 'false') {
    return c.json({ error: AUTH_ERROR_CODES.REGISTRATION_DISABLED }, 403);
  }

  const userId = randomHex(16);
  await createUser(c.env.DB, userId);

  // Set status to pending if approval is required; never issue an active API key while pending
  const requireApproval = await getSetting(c.env.DB, 'require_approval');
  if (requireApproval === 'true') {
    await updateUserStatus(c.env.DB, userId, 'pending');
    await logAuthAudit(c, { userId, action: 'auth.register', ip }, c.env.DB);
    return c.json({ ok: true, userId, pending: true }, 201);
  }

  const rawKey = `deck_${randomHex(32)}`;
  const keyHash = sha256Hex(rawKey);
  const now = Date.now();
  await c.env.DB.execute(
    'INSERT INTO api_keys (id, user_id, key_hash, created_at) VALUES ($1, $2, $3, $4)',
    [randomHex(16), userId, keyHash, now],
  );

  await logAuthAudit(c, { userId, action: 'auth.register', ip }, c.env.DB);

  return c.json({ userId, apiKey: rawKey }, 201);
});

// Platform identity linking is handled exclusively through verified OAuth flows
// (e.g., github-auth.ts). No public endpoint is exposed to prevent identity pre-claiming.

// GET /api/auth/user/me — get authenticated user (cookie, Bearer API key or JWT)
// NOTE: must be registered before /user/:id to avoid Hono matching id='me'
authRoutes.get('/user/me', async (c) => {
  const resolution = await resolveAuthOutcome(c);
  const userId = resolution.auth && !resolution.auth.serverId ? resolution.auth.userId : null;
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const user = await getUserById(c.env.DB, userId);
  if (!user) return c.json({ error: 'not_found' }, 404);
  await rememberClientTimezone(c.env.DB, userId, c.req.header(CLIENT_TIMEZONE_HEADER)).catch((err) => {
    logger.warn({ err, userId }, 'Failed to remember client timezone');
  });
  const clientUser = toClientUser(user);
  const r2RelayEnabled = r2RelayConfig(c.env) !== null;
  return c.json(
    resolution.auth?.scope === 'doc_collaborator' && clientUser
      ? { ...clientUser, scope: 'doc_collaborator' as const, r2RelayEnabled }
      : { ...clientUser, r2RelayEnabled },
  );
});

// GET /api/auth/user/:id — requires auth, only accessible for own user ID
authRoutes.get('/user/:id', async (c) => {
  const authedUserId = await resolveUserId(c);
  if (!authedUserId) return c.json({ error: 'unauthorized' }, 401);

  const requestedId = c.req.param('id');
  if (authedUserId !== requestedId) return c.json({ error: 'forbidden' }, 403);

  const user = await getUserById(c.env.DB, requestedId);
  if (!user) return c.json({ error: 'not_found' }, 404);
  return c.json(toClientUser(user));
});

// POST /api/user/:id/rotate-key — generate new API key, 24-hour grace for old key
authRoutes.post('/user/:id/rotate-key', async (c) => {
  const authedUserId = await resolveUserId(c);
  if (!authedUserId) return c.json({ error: 'unauthorized' }, 401);

  const userId = c.req.param('id');
  if (authedUserId !== userId) return c.json({ error: 'forbidden' }, 403);

  const user = await getUserById(c.env.DB, userId);
  if (!user) return c.json({ error: 'not_found' }, 404);

  // Mark existing active keys as grace-period (grace expires in 24 hours)
  const graceExpiry = Date.now() + 24 * 3600 * 1000;
  await c.env.DB.execute(
    "UPDATE api_keys SET grace_expires_at = $1 WHERE user_id = $2 AND revoked_at IS NULL AND grace_expires_at IS NULL",
    [graceExpiry, userId],
  );

  // Issue new key
  const rawKey = `deck_${randomHex(32)}`;
  const keyHash = sha256Hex(rawKey);
  await c.env.DB.execute(
    'INSERT INTO api_keys (id, user_id, key_hash, created_at) VALUES ($1, $2, $3, $4)',
    [randomHex(16), userId, keyHash, Date.now()],
  );

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAuthAudit(c, { userId, action: 'auth.rotate_key', ip }, c.env.DB);

  return c.json({ apiKey: rawKey, graceExpiry });
});

// DELETE /api/user/:id/key — revoke all API keys immediately
authRoutes.delete('/user/:id/key', async (c) => {
  const authedUserId = await resolveUserId(c);
  if (!authedUserId) return c.json({ error: 'unauthorized' }, 401);

  const userId = c.req.param('id');
  if (authedUserId !== userId) return c.json({ error: 'forbidden' }, 403);

  const user = await getUserById(c.env.DB, userId);
  if (!user) return c.json({ error: 'not_found' }, 404);

  const now = Date.now();
  await c.env.DB.execute(
    'UPDATE api_keys SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL',
    [now, userId],
  );
  await globalTaskHub.notifyPushCredentialRevoked(c.env.DB, { userId, allApiKeys: true });

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAuthAudit(c, { userId, action: 'auth.revoke_keys', ip }, c.env.DB);

  return c.json({ ok: true, revokedAt: now });
});

// POST /api/auth/user/me/keys — create a new API key for the authenticated user
authRoutes.post('/user/me/keys', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const label = typeof body.label === 'string' ? body.label : null;

  const rawKey = `deck_${randomHex(32)}`;
  const keyHash = sha256Hex(rawKey);
  const keyId = randomHex(16);
  const now = Date.now();

  await c.env.DB.execute(
    'INSERT INTO api_keys (id, user_id, key_hash, label, created_at) VALUES ($1, $2, $3, $4, $5)',
    [keyId, userId, keyHash, label, now],
  );

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAuthAudit(c, { userId, action: 'auth.create_key', ip }, c.env.DB);

  return c.json({ id: keyId, apiKey: rawKey, label, createdAt: now }, 201);
});

// GET /api/auth/user/me/keys — list all API keys for the authenticated user (no raw key)
authRoutes.get('/user/me/keys', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const results = await c.env.DB.query<{ id: string; label: string | null; created_at: number; revoked_at: number | null }>(
    'SELECT id, label, created_at, revoked_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC',
    [userId],
  );

  const keys = results.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  }));

  return c.json({ keys });
});

// DELETE /api/auth/user/me/keys/:keyId — revoke a specific API key
authRoutes.delete('/user/me/keys/:keyId', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const keyId = c.req.param('keyId');

  // Verify ownership
  const key = await c.env.DB.queryOne<{ id: string }>(
    'SELECT id FROM api_keys WHERE id = $1 AND user_id = $2',
    [keyId, userId],
  );

  if (!key) return c.json({ error: 'not_found' }, 404);

  const now = Date.now();
  await c.env.DB.execute(
    'UPDATE api_keys SET revoked_at = $1 WHERE id = $2 AND user_id = $3',
    [now, keyId, userId],
  );
  await globalTaskHub.notifyPushCredentialRevoked(c.env.DB, { userId, keyId });

  // Kick all daemon WebSocket connections that were bound using this API key
  const boundServers = await c.env.DB.query<{ id: string }>(
    'SELECT id FROM servers WHERE bound_with_key_id = $1 AND user_id = $2',
    [keyId, userId],
  );
  for (const srv of boundServers) {
    try { WsBridge.get(srv.id).kickDaemon(); } catch { /* bridge may not be active */ }
  }

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAuthAudit(c, { userId, action: 'auth.revoke_key', ip, details: { keyId, serversKicked: boundServers.length } }, c.env.DB);

  return c.json({ ok: true, revokedAt: now });
});

// POST /api/auth/ws-ticket — issue a short-lived WebSocket ticket
const wsTicketSchema = z.object({ serverId: z.string() });

authRoutes.post('/ws-ticket', async (c) => {
  const resolution = await resolveAuthOutcome(c);
  const userId = resolution.auth && !resolution.auth.serverId ? resolution.auth.userId : null;
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = wsTicketSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const userAccess = await loadUserAccess(c.env.DB, userId);
  const accessDecision = evaluateUserAccess(userAccess, resolution.auth?.issuedAt);
  if (!accessDecision.ok) return c.json({ error: accessDecision.code }, 403);

  // Check server access
  const access = await resolveServerWebSocketAccess(c.env.DB, parsed.data.serverId, userId);
  if (!access) return c.json({ error: 'forbidden' }, 403);

  const nowMs = Date.now();
  const validAfter = userAccess?.sessionsValidAfter ?? 0;
  const jti = randomHex(16);
  const ticket = signJwt(
    {
      sub: userId,
      type: 'ws-ticket',
      sid: parsed.data.serverId,
      jti,
      iat: alignedSessionIssuedAt(validAfter, nowMs),
      sva: validAfter,
    },
    c.env.JWT_SIGNING_KEY,
    15, // 15 seconds
  );

  return c.json({ ticket });
});

// POST /api/auth/token-exchange — exchange a short-lived callback nonce for a real API key
const tokenExchangeSchema = z.object({
  nonce: z.string().min(1),
});

authRoutes.post('/token-exchange', async (c) => {
  scheduleAuthNonceCleanup(c.env.DB);

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  const body = await c.req.json().catch(() => null);
  const parsed = tokenExchangeSchema.safeParse(body);
  if (!parsed.success) {
    await logAuthAudit(c, {
      action: 'auth.token_exchange',
      ip,
      outcomeCode: 'token_exchange_failed',
      details: { reason: 'invalid_body' },
    }, c.env.DB);
    return c.json({ error: 'invalid_body' }, 400);
  }

  const now = Date.now();
  const nonceRow = await c.env.DB.queryOne<{ api_key: string; user_id: string; key_id: string }>(
    'DELETE FROM auth_nonces WHERE nonce = $1 AND expires_at > $2 AND key_id != $3 RETURNING api_key, user_id, key_id',
    [parsed.data.nonce, now, OAUTH_RELAY_KEY_ID],
  );

  if (!nonceRow) {
    const existing = await c.env.DB.queryOne<{ user_id: string; expires_at: number }>(
      'SELECT user_id, expires_at FROM auth_nonces WHERE nonce = $1 AND key_id != $2',
      [parsed.data.nonce, OAUTH_RELAY_KEY_ID],
    );
    await logAuthAudit(c, {
      userId: existing?.user_id,
      action: 'auth.token_exchange',
      ip,
      outcomeCode: existing && existing.expires_at <= now ? 'nonce_expired' : 'token_exchange_failed',
      details: {
        reason: existing ? (existing.expires_at <= now ? 'expired' : 'replayed') : 'missing',
      },
    }, c.env.DB);
    return c.json({ error: 'invalid_or_expired_nonce' }, 400);
  }

  // The nonce carries a freshly minted API key: a disabled (or pending) user's nonce is consumed and refused, the key is never handed out.
  if (!await isUserActive(c.env.DB, nonceRow.user_id)) {
    await logAuthAudit(c, {
      userId: nonceRow.user_id, action: 'auth.token_exchange', ip, outcomeCode: 'token_exchange_failed', details: { reason: 'account_not_active' },
    }, c.env.DB);
    return c.json({ error: 'invalid_or_expired_nonce' }, 400);
  }

  await logAuthAudit(c, {
    userId: nonceRow.user_id,
    action: 'auth.token_exchange',
    ip,
    outcomeCode: 'success',
    details: { keyId: nonceRow.key_id },
  }, c.env.DB);

  return c.json({
    apiKey: nonceRow.api_key,
    userId: nonceRow.user_id,
    keyId: nonceRow.key_id,
  });
});

// POST /api/auth/desktop/nonce — mint a short-lived nonce for a validated loopback desktop callback
const desktopNonceSchema = z.object({
  callbackUrl: z.string().min(1).max(512),
});

authRoutes.post('/desktop/nonce', requireAuth({ refuseDaemonCredential: true }), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = desktopNonceSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const validated = parseDesktopSetupCallbackUrl(parsed.data.callbackUrl);
  if (!validated) return c.json({ error: 'invalid_desktop_callback' }, 400);

  const userId = c.get('userId' as never) as string;
  if (!await isUserActive(c.env.DB, userId)) {
    return c.json({ error: 'account_not_active' }, 403);
  }

  const rawKey = `deck_${randomHex(32)}`;
  const keyHash = sha256Hex(rawKey);
  const keyId = randomHex(16);
  const now = Date.now();
  await c.env.DB.execute(
    'INSERT INTO api_keys (id, user_id, key_hash, label, created_at) VALUES ($1, $2, $3, $4, $5)',
    [keyId, userId, keyHash, 'Desktop app', now],
  );

  const nonce = await issueAuthNonce(c.env.DB, { apiKey: rawKey, userId, keyId });
  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAuthAudit(c, {
    userId,
    action: 'auth.desktop_nonce',
    ip,
    outcomeCode: 'success',
    details: { keyId, callbackPort: validated.port },
  }, c.env.DB);

  return c.json({
    nonce,
    redirectUrl: buildDesktopSetupCallbackRedirectUrl(validated, nonce),
  });
});

// POST /api/auth/refresh — refresh JWT access token (cookie or JSON body)
const refreshSchema = z.object({ refreshToken: z.string().optional() });

authRoutes.post('/refresh', async (c) => {
  const cookieRefresh = getCookie(c, 'rcc_refresh');
  const body = await c.req.json().catch(() => null);
  const parsed = refreshSchema.safeParse(body);
  const refreshToken = cookieRefresh ?? parsed.data?.refreshToken;
  if (!refreshToken) {
    logger.warn({ hasCookieRefresh: !!cookieRefresh }, '[refresh] no refresh token provided');
    return c.json({ error: AUTH_ERROR_CODES.INVALID_BODY }, 400);
  }

  const tokenHash = sha256Hex(refreshToken);
  const now = Date.now();

  // Read-only lookup first so temporary account lockout never consumes the refresh token.
  const peek = await c.env.DB.queryOne<{ user_id: string }>(
    'SELECT user_id FROM refresh_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2',
    [tokenHash, now],
  );
  if (!peek) {
    logger.warn({ hashPrefix: tokenHash.slice(0, 8) }, '[refresh] token not found, already used, or expired');
    return c.json({ error: 'invalid_token' }, 401);
  }

  // A valid refresh token is not a brute-force attempt. In particular, never
  // consult a shared IP bucket here: one user's password failures must not
  // invalidate refresh for every other logged-in user.
  const preLockout = await checkAuthLockout(c.env.DB, `user:${peek.user_id}`);
  if (preLockout.locked) {
    return c.json({ error: AUTH_ERROR_CODES.TOO_MANY_ATTEMPTS, retryAfterMs: preLockout.lockedUntil ? preLockout.lockedUntil - Date.now() : 0 }, 429);
  }

  const newRefresh = randomHex(32);
  const newRefreshHash = sha256Hex(newRefresh);
  const newRefreshId = randomHex(16);

  // Lock users row before updating refresh_tokens (same lock order as /password/change) so an
  // in-flight refresh cannot race past a concurrent password change or disable and still mint a new pair.
  const txResult = await withTransaction(c.env.DB, async (tx) => {
    const lockedUser = await tx.queryOne<{ id: string; status: string; sessions_valid_after: string | number }>(
      'SELECT id, status, sessions_valid_after FROM users WHERE id = $1 FOR UPDATE',
      [peek.user_id],
    );
    if (!lockedUser || lockedUser.status !== 'active') {
      return { ok: false as const, status: 403 as const, error: AUTH_ERROR_CODES.ACCOUNT_DISABLED };
    }

    const userLockout = await checkAuthLockout(tx, `user:${lockedUser.id}`);
    if (userLockout.locked) {
      return {
        ok: false as const,
        status: 429 as const,
        error: AUTH_ERROR_CODES.TOO_MANY_ATTEMPTS,
        retryAfterMs: userLockout.lockedUntil ? userLockout.lockedUntil - Date.now() : 0,
      };
    }

    const txNow = Date.now();
    const row = await tx.queryOne<{ id: string; user_id: string; family_id: string }>(
      'UPDATE refresh_tokens SET used_at = $1 WHERE token_hash = $2 AND used_at IS NULL AND expires_at > $1 RETURNING id, user_id, family_id',
      [txNow, tokenHash],
    );
    if (!row) {
      return { ok: false as const, status: 401 as const, error: 'invalid_token' };
    }

    const isDocCollabRefresh = typeof row.family_id === 'string' && row.family_id.startsWith('doc_collab:');
    const iat = alignedSessionIssuedAt(Number(lockedUser.sessions_valid_after ?? 0) || 0, txNow);
    const accessToken = signJwt(
      isDocCollabRefresh
        ? { sub: row.user_id, type: ACCOUNT_SESSION_JWT_TYPE, scope: 'doc_collaborator', iat }
        : { sub: row.user_id, iat },
      c.env.JWT_SIGNING_KEY,
      4 * 3600,
    );
    await tx.execute(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [newRefreshId, row.user_id, newRefreshHash, row.family_id, txNow + 30 * 24 * 3600 * 1000, txNow],
    );
    return { ok: true as const, tokenId: row.id, accessToken };
  });

  if (!txResult.ok) {
    if (txResult.status === 429) {
      return c.json({ error: txResult.error, retryAfterMs: txResult.retryAfterMs }, 429);
    }
    return c.json({ error: txResult.error }, txResult.status);
  }

  logger.info({ tokenId: txResult.tokenId }, '[refresh] token consumed, issuing new pair');
  const accessToken = txResult.accessToken;

  const isSecure = c.env.NODE_ENV === 'production';

  if (cookieRefresh) {
    setCookie(c, COOKIE_SESSION, accessToken, {
      httpOnly: true, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 4 * 3600,
    });
    setCookie(c, 'rcc_refresh', newRefresh, {
      httpOnly: true, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 30 * 86400,
    });
    // Re-set CSRF cookie with same value to extend its lifetime.
    // We don't rotate the value (that would break other tabs), just refresh maxAge.
    const existingCsrf = getCookie(c, COOKIE_CSRF);
    if (existingCsrf) {
      setCookie(c, COOKIE_CSRF, existingCsrf, {
        httpOnly: false, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 30 * 86400,
      });
    } else {
      // CSRF cookie expired — issue a new one
      setCookie(c, COOKIE_CSRF, randomHex(32), {
        httpOnly: false, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 30 * 86400,
      });
    }
    return c.json({ ok: true });
  }

  return c.json({ accessToken, refreshToken: newRefresh });
});

// DELETE /api/auth/user/me — permanently delete the authenticated user and all associated data
authRoutes.delete('/user/me', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const user = await getUserById(c.env.DB, userId);
  if (!user) return c.json({ error: 'not_found' }, 404);

  const db = c.env.DB;

  // 1. Passkey credentials
  await db.execute('DELETE FROM passkey_credentials WHERE user_id = $1', [userId]);
  // 2. Passkey challenges
  await db.execute('DELETE FROM passkey_challenges WHERE user_id = $1', [userId]);
  // 3. API keys
  await db.execute('DELETE FROM api_keys WHERE user_id = $1', [userId]);
  // 4. Refresh tokens
  await db.execute('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
  // 5. Push tokens
  await db.execute('DELETE FROM push_tokens WHERE user_id = $1', [userId]);
  // 6. Push subscriptions
  await db.execute('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
  // 7. Server-side usage analytics facts
  await deleteTokenUsageFactsForUser(db, userId);

  // 8. Get server IDs for cascade deleting server-scoped data
  const serverRows = await db.query<{ id: string }>('SELECT id FROM servers WHERE user_id = $1', [userId]);
  const serverIds = serverRows.map((r) => r.id);

  if (serverIds.length > 0) {
    for (const sid of serverIds) {
      // Discussion rounds → discussions (CASCADE should handle rounds, but be explicit)
      await db.execute('DELETE FROM discussion_rounds WHERE discussion_id IN (SELECT id FROM discussions WHERE server_id = $1)', [sid]);
      await db.execute('DELETE FROM discussions WHERE server_id = $1', [sid]);
      // Sub-sessions
      await db.execute('DELETE FROM sub_sessions WHERE server_id = $1', [sid]);
      // Channel bindings
      await db.execute('DELETE FROM channel_bindings WHERE server_id = $1', [sid]);
      // Sessions
      await db.execute('DELETE FROM sessions WHERE server_id = $1', [sid]);
      // Cron jobs
      await db.execute('DELETE FROM cron_jobs WHERE server_id = $1', [sid]);
    }
  }

  // 9. Platform bots
  await db.execute('DELETE FROM platform_bots WHERE user_id = $1', [userId]);
  // 10. Servers
  await db.execute('DELETE FROM servers WHERE user_id = $1', [userId]);
  // 11. Pending binds
  await db.execute('DELETE FROM pending_binds WHERE user_id = $1', [userId]);
  // 12. Platform identities
  await db.execute('DELETE FROM platform_identities WHERE user_id = $1', [userId]);
  // 12. User preferences
  await db.execute('DELETE FROM user_preferences WHERE user_id = $1', [userId]);
  // 13. User quick data
  await db.execute('DELETE FROM user_quick_data WHERE user_id = $1', [userId]);
  // 14. Idempotency records
  await db.execute('DELETE FROM idempotency_records WHERE user_id = $1', [userId]);
  // 15. Team memberships (not owned teams — those are separate)
  await db.execute('DELETE FROM team_members WHERE user_id = $1', [userId]);
  // 16. Email verification codes
  await db.execute('DELETE FROM email_verification_codes WHERE user_id = $1', [userId]);
  // 17. Audit log entries (keep? delete for GDPR compliance)
  await db.execute('DELETE FROM audit_log WHERE user_id = $1', [userId]);
  // 18. Delete user
  await db.execute('DELETE FROM users WHERE id = $1', [userId]);

  // Clear session cookies
  deleteCookie(c, COOKIE_SESSION, { path: '/' });
  deleteCookie(c, 'rcc_refresh', { path: '/' });
  deleteCookie(c, COOKIE_CSRF, { path: '/' });

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  logger.info({ userId, ip }, '[auth] account deleted');

  return c.json({ ok: true });
});

// ── Email verification & password auth ────────────────────────────────────

// GET /api/auth/email/config — expose only non-secret deployment toggle
authRoutes.get('/email/config', (c) => {
  return c.json({ emailAuthEnabled: isEmailAuthEnabled(c.env) });
});

const sendEmailCodeSchema = z.object({
  email: z.string().optional(),
  purpose: z.enum([
    EMAIL_AUTH_PURPOSE.REGISTER,
    EMAIL_AUTH_PURPOSE.PASSWORD_RESET,
    EMAIL_AUTH_PURPOSE.PASSWORD_CHANGE,
    EMAIL_AUTH_PURPOSE.BIND_EMAIL,
  ]),
  lang: z.string().max(16).optional(),
});

// POST /api/auth/email/send-code — send a single-use 6-digit verification OTP
authRoutes.post('/email/send-code', async (c) => {
  if (!isEmailAuthEnabled(c.env)) {
    return c.json({ error: AUTH_ERROR_CODES.EMAIL_AUTH_DISABLED }, 403);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = sendEmailCodeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: AUTH_ERROR_CODES.INVALID_BODY }, 400);

  const { purpose, lang: bodyLang } = parsed.data;
  const lang = resolveEmailLanguage(bodyLang, c.req.header('Accept-Language'));

  const requiresCookieCsrfCheck = (): boolean => {
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) return false;
    const sessionCookie = getCookie(c, COOKIE_SESSION);
    if (!sessionCookie) return false;
    const csrfCookie = getCookie(c, COOKIE_CSRF);
    const csrfHeader = c.req.header(HEADER_CSRF);
    return !csrfCookie || !csrfHeader || csrfCookie !== csrfHeader;
  };

  let targetEmail: string;
  let userId: string | null = null;
  let suppressSendForAntiEnumeration = false;
  let lockoutIdentity: string;

  if (purpose === EMAIL_AUTH_PURPOSE.PASSWORD_CHANGE || purpose === EMAIL_AUTH_PURPOSE.BIND_EMAIL) {
    if (requiresCookieCsrfCheck()) {
      return c.json({ error: 'csrf_rejected', reason: 'token_mismatch' }, 403);
    }
    const authedUserId = await resolveUserId(c);
    if (!authedUserId) return c.json({ error: 'unauthorized' }, 401);

    userId = authedUserId;
    if (purpose === EMAIL_AUTH_PURPOSE.PASSWORD_CHANGE) {
      if (parsed.data.email !== undefined && !isValidEmail(parsed.data.email)) {
        return c.json({ error: AUTH_ERROR_CODES.INVALID_EMAIL }, 400);
      }
      targetEmail = parsed.data.email !== undefined ? normalizeEmail(parsed.data.email) : '';
    } else {
      if (!isValidEmail(parsed.data.email)) {
        return c.json({ error: AUTH_ERROR_CODES.INVALID_EMAIL }, 400);
      }
      targetEmail = normalizeEmail(parsed.data.email);
    }
    lockoutIdentity = `email-send:${purpose}:${authedUserId}`;
  } else {
    if (!isValidEmail(parsed.data.email)) {
      return c.json({ error: AUTH_ERROR_CODES.INVALID_EMAIL }, 400);
    }
    targetEmail = normalizeEmail(parsed.data.email);
    if (purpose === EMAIL_AUTH_PURPOSE.REGISTER) {
      const regEnabled = await getSetting(c.env.DB, 'registration_enabled');
      if (regEnabled === 'false') {
        return c.json({ error: AUTH_ERROR_CODES.REGISTRATION_DISABLED }, 403);
      }
    }
    lockoutIdentity = `email-send:${purpose}:${targetEmail}`;
  }

  const isResetPurpose = purpose === EMAIL_AUTH_PURPOSE.PASSWORD_RESET;

  try {
    const issued = await issueEmailVerificationCode(c.env.DB, c.env, {
      email: targetEmail || undefined,
      purpose,
      userId,
      lang,
      suppressSendForAntiEnumeration,
      lookupResetTarget: isResetPurpose,
      asyncDelivery: isResetPurpose,
      lockoutIdentity,
    });
    if (!issued.ok) {
      return c.json(
        issued.retryAfterMs !== undefined
          ? { error: issued.error, retryAfterMs: issued.retryAfterMs }
          : { error: issued.error },
        issued.status,
      );
    }
  } catch (err) {
    if (err instanceof EmailServiceError) {
      logger.warn({ purpose, code: err.code, category: err.category }, '[auth] email send failed');
      return c.json({ error: 'email_send_failed' }, 502);
    }
    throw err;
  }

  return c.json({ ok: true });
});

const bindEmailSchema = z.object({
  email: z.string(),
  code: z.string(),
});

// POST /api/auth/email/bind — initial verified-email binding for pre-email accounts
authRoutes.post('/email/bind', async (c) => {
  if (!isEmailAuthEnabled(c.env)) {
    return c.json({ error: AUTH_ERROR_CODES.EMAIL_AUTH_DISABLED }, 403);
  }
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const userLockout = await checkAuthLockout(c.env.DB, `user:${userId}`);
  if (userLockout.locked) {
    return c.json({
      error: AUTH_ERROR_CODES.TOO_MANY_ATTEMPTS,
      retryAfterMs: userLockout.lockedUntil ? userLockout.lockedUntil - Date.now() : 0,
    }, 429);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = bindEmailSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: AUTH_ERROR_CODES.INVALID_BODY }, 400);

  if (!isValidEmail(parsed.data.email)) {
    return c.json({ error: AUTH_ERROR_CODES.INVALID_EMAIL }, 400);
  }
  if (!isValidEmailOtp(parsed.data.code)) {
    return c.json({ error: AUTH_ERROR_CODES.EMAIL_CODE_REQUIRED }, 400);
  }

  const normalizedEmail = normalizeEmail(parsed.data.email);
  const code = parsed.data.code.trim();

  let bindTx:
    | { ok: true }
    | { ok: false; status: 400 | 403 | 404 | 409; error: string; recordFailure?: boolean };
  try {
    bindTx = await withTransaction(c.env.DB, async (tx) => {
      const lockedUser = await tx.queryOne<{ id: string; status: string; email_verified_at: string | number | null }>(
        'SELECT id, status, email_verified_at FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      if (!lockedUser) {
        return { ok: false as const, status: 404 as const, error: 'not_found' };
      }
      if (!isUserStatusActive(lockedUser.status)) {
        return {
          ok: false as const,
          status: 403 as const,
          error: lockedUser.status === 'pending' ? AUTH_ERROR_CODES.ACCOUNT_PENDING : AUTH_ERROR_CODES.ACCOUNT_DISABLED,
        };
      }
      if (lockedUser.email_verified_at) {
        return { ok: false as const, status: 409 as const, error: AUTH_ERROR_CODES.EMAIL_ALREADY_VERIFIED };
      }
      const existing = await tx.queryOne<{ id: string }>(
        'SELECT id FROM users WHERE LOWER(email) = $1',
        [normalizedEmail],
      );
      if (existing && existing.id !== userId) {
        return { ok: false as const, status: 409 as const, error: AUTH_ERROR_CODES.EMAIL_TAKEN };
      }

      const consumed = await consumeEmailVerificationCode(tx, c.env.JWT_SIGNING_KEY, {
        email: normalizedEmail,
        purpose: EMAIL_AUTH_PURPOSE.BIND_EMAIL,
        code,
        userId,
      });
      if (!consumed.ok) {
        return { ok: false as const, status: 400 as const, error: consumed.error, recordFailure: true };
      }

      await tx.execute(
        'UPDATE users SET email = $1, email_verified_at = $2 WHERE id = $3',
        [normalizedEmail, consumed.now, userId],
      );
      return { ok: true as const };
    });
  } catch (err) {
    const conflict = mapPgUniqueConstraintError(err);
    if (conflict === AUTH_ERROR_CODES.EMAIL_TAKEN) {
      return c.json({ error: AUTH_ERROR_CODES.EMAIL_TAKEN }, 409);
    }
    throw err;
  }

  if (!bindTx.ok) {
    if ('recordFailure' in bindTx && bindTx.recordFailure) {
      await recordAuthFailure(c.env.DB, `user:${userId}`, 'email_bind_invalid_code');
    }
    return c.json({ error: bindTx.error }, bindTx.status);
  }

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAuthAudit(c, { userId, action: 'auth.email_bind', ip }, c.env.DB);
  return c.json({ ok: true, email: normalizedEmail, email_verified: true });
});

// POST /api/auth/password/register — create a new user with username + password (+ email OTP when enabled)
const passwordRegisterSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8),
  displayName: z.string().max(100).optional(),
  email: z.string().optional(),
  emailCode: z.string().optional(),
  native: z.boolean().optional(),
});

authRoutes.post('/password/register', async (c) => {
  // Check if registration is enabled
  const regEnabled = await getSetting(c.env.DB, 'registration_enabled');
  if (regEnabled === 'false') {
    return c.json({ error: AUTH_ERROR_CODES.REGISTRATION_DISABLED }, 403);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = passwordRegisterSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: AUTH_ERROR_CODES.INVALID_BODY }, 400);

  const { username, password, displayName, email, emailCode, native } = parsed.data;
  const emailAuthEnabled = isEmailAuthEnabled(c.env);

  // Validate password complexity
  const complexity = validatePasswordComplexity(password);
  if (!complexity.valid) {
    return c.json({ error: complexity.errorKey }, 400);
  }

  // Validate username format
  const normalizedUsername = username.trim().toLowerCase();
  if (!USERNAME_REGEX.test(normalizedUsername)) {
    return c.json({ error: AUTH_ERROR_CODES.INVALID_USERNAME_FORMAT }, 400);
  }

  let normalizedEmail: string | null = null;
  let normalizedEmailCode: string | null = null;
  if (emailAuthEnabled) {
    if (typeof email !== 'string' || !email.trim()) {
      return c.json({ error: AUTH_ERROR_CODES.EMAIL_REQUIRED }, 400);
    }
    if (!isValidEmail(email)) {
      return c.json({ error: AUTH_ERROR_CODES.INVALID_EMAIL }, 400);
    }
    if (!isValidEmailOtp(emailCode)) {
      return c.json({ error: AUTH_ERROR_CODES.EMAIL_CODE_REQUIRED }, 400);
    }
    normalizedEmail = normalizeEmail(email);
    normalizedEmailCode = emailCode.trim();
  }

  // Fast pre-check before scrypt hashing; unique constraints under PG transaction remain authoritative on races.
  const existingUser = await getUserByUsername(c.env.DB, normalizedUsername);
  if (existingUser) {
    return c.json({ error: AUTH_ERROR_CODES.USERNAME_TAKEN }, 409);
  }
  if (normalizedEmail) {
    const existingEmailUser = await getUserByEmail(c.env.DB, normalizedEmail);
    if (existingEmailUser) {
      return c.json({ error: AUTH_ERROR_CODES.EMAIL_TAKEN }, 409);
    }
  }

  const userId = randomHex(16);
  const passwordHash = await hashPassword(password);
  const requireApproval = await getSetting(c.env.DB, 'require_approval');
  const isPending = requireApproval === 'true';
  const now = Date.now();
  const effectiveDisplayName = displayName?.trim() || normalizedUsername;

  if (emailAuthEnabled && normalizedEmail && normalizedEmailCode) {
    let regTx: { ok: true } | { ok: false; status: 400 | 409; error: string };
    try {
      regTx = await withTransaction(c.env.DB, async (tx) => {
        const txExistingUsername = await getUserByUsername(tx, normalizedUsername);
        if (txExistingUsername) {
          return { ok: false as const, status: 409 as const, error: AUTH_ERROR_CODES.USERNAME_TAKEN };
        }
        const txExistingEmail = await getUserByEmail(tx, normalizedEmail);
        if (txExistingEmail) {
          return { ok: false as const, status: 409 as const, error: AUTH_ERROR_CODES.EMAIL_TAKEN };
        }

        const consumed = await consumeEmailVerificationCode(tx, c.env.JWT_SIGNING_KEY, {
          email: normalizedEmail,
          purpose: EMAIL_AUTH_PURPOSE.REGISTER,
          code: normalizedEmailCode,
        });
        if (!consumed.ok) {
          return { ok: false as const, status: 400 as const, error: consumed.error };
        }

        const txNow = consumed.now;
        await tx.execute('INSERT INTO users (id, created_at) VALUES ($1, $2)', [userId, txNow]);
        await tx.execute(
          'UPDATE users SET username = $1, password_hash = $2, display_name = $3, email = $4, email_verified_at = $5 WHERE id = $6',
          [normalizedUsername, passwordHash, effectiveDisplayName, normalizedEmail, txNow, userId],
        );
        if (isPending) {
          await tx.execute('UPDATE users SET status = $1 WHERE id = $2', ['pending', userId]);
        }
        return { ok: true as const };
      });
    } catch (err) {
      const conflict = mapPgUniqueConstraintError(err);
      if (conflict) {
        return c.json({ error: conflict }, 409);
      }
      throw err;
    }

    if (!regTx.ok) {
      return c.json({ error: regTx.error }, regTx.status);
    }
  } else {
    // Legacy flow when EMAIL_AUTH_ENABLED is off
    try {
      await withTransaction(c.env.DB, async (tx) => {
        await tx.execute('INSERT INTO users (id, created_at) VALUES ($1, $2)', [userId, now]);
        await tx.execute(
          'UPDATE users SET username = $1, password_hash = $2, display_name = $3 WHERE id = $4',
          [normalizedUsername, passwordHash, effectiveDisplayName, userId],
        );
        if (isPending) {
          await tx.execute('UPDATE users SET status = $1 WHERE id = $2', ['pending', userId]);
        }
      });
    } catch (err) {
      const conflict = mapPgUniqueConstraintError(err);
      if (conflict) {
        return c.json({ error: conflict }, 409);
      }
      throw err;
    }
  }

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAuthAudit(c, { userId, action: 'auth.password_register', ip }, c.env.DB);

  // Don't issue session tokens for pending users — they can't use the app until approved
  if (isPending) {
    return c.json({ ok: true, pending: true });
  }

  // Issue session
  const isSecure = (c.req.header('x-forwarded-proto') ?? c.req.url).includes('https');
  const accessToken = signJwt({ sub: userId, type: ACCOUNT_SESSION_JWT_TYPE }, c.env.JWT_SIGNING_KEY, 4 * 3600);
  const refreshRaw = randomHex(32);
  const refreshHash = sha256Hex(refreshRaw);
  await c.env.DB.execute(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomHex(16), userId, refreshHash, randomHex(16), now + 30 * 86400000, now],
  );

  setCookie(c, COOKIE_SESSION, accessToken, {
    httpOnly: true, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 15 * 60,
  });
  setCookie(c, 'rcc_refresh', refreshRaw, {
    httpOnly: true, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 30 * 86400,
  });
  setCookie(c, COOKIE_CSRF, randomHex(16), {
    httpOnly: false, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 30 * 86400,
  });

  // Native apps need API key
  let apiKey: string | undefined;
  let keyId: string | undefined;
  if (native) {
    keyId = randomHex(16);
    const rawKey = `deck_${randomHex(32)}`;
    const keyHash = sha256Hex(rawKey);
    await c.env.DB.execute(
      'INSERT INTO api_keys (id, user_id, key_hash, label, created_at) VALUES ($1, $2, $3, $4, $5)',
      [keyId, userId, keyHash, 'native-password-register', now],
    );
    apiKey = rawKey;
  }

  return c.json({
    ok: true,
    ...(native ? { apiKey, keyId, userId } : {}),
  });
});

// POST /api/auth/password/login — authenticate with username + password
const passwordLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  native: z.boolean().optional(),
});

authRoutes.post('/password/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = passwordLoginSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: AUTH_ERROR_CODES.INVALID_BODY }, 400);

  const { username, password, native } = parsed.data;
  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  const normalizedUsername = username.trim().toLowerCase();

  // Account-only lockout checks. IP dimensions are deliberately not used:
  // a reverse proxy can collapse all users onto one socket address.
  // Check BEFORE user lookup to avoid timing side-channels.
  const usernameLockout = await checkAuthLockout(c.env.DB, `username:${normalizedUsername}`);
  if (usernameLockout.locked) {
    return c.json({ error: AUTH_ERROR_CODES.TOO_MANY_ATTEMPTS, retryAfterMs: usernameLockout.lockedUntil ? usernameLockout.lockedUntil - Date.now() : 0 }, 429);
  }

  const user = isEmailAuthEnabled(c.env) && normalizedUsername.includes('@')
    ? await getUserByVerifiedEmail(c.env.DB, normalizedUsername)
    : await getUserByUsername(c.env.DB, normalizedUsername);
  if (!user || !user.password_hash) {
    // Unified failure: record against the attempted username even when it does
    // not exist. This cannot affect another account.
    await recordAuthFailure(c.env.DB, `username:${normalizedUsername}`, 'password_login_invalid_credentials');
    return c.json({ error: AUTH_ERROR_CODES.INVALID_CREDENTIALS }, 401);
  }

  // User ID — prevents abuse of a specific known account.
  const userLockout = await checkAuthLockout(c.env.DB, `user:${user.id}`);
  if (userLockout.locked) {
    return c.json({ error: AUTH_ERROR_CODES.TOO_MANY_ATTEMPTS, retryAfterMs: userLockout.lockedUntil ? userLockout.lockedUntil - Date.now() : 0 }, 429);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    await recordAuthFailure(c.env.DB, `username:${normalizedUsername}`, 'password_login_invalid_credentials');
    await recordAuthFailure(c.env.DB, `user:${user.id}`, 'password_login_invalid_credentials');
    return c.json({ error: AUTH_ERROR_CODES.INVALID_CREDENTIALS }, 401);
  }

  // Reject disabled/pending users
  if (user.status !== 'active') {
    return c.json({ error: user.status === 'pending' ? AUTH_ERROR_CODES.ACCOUNT_PENDING : AUTH_ERROR_CODES.ACCOUNT_DISABLED }, 403);
  }

  // Lock users row before issuing tokens and confirm the password hash is still the one verified above.
  const refreshRaw = randomHex(32);
  const refreshHash = sha256Hex(refreshRaw);
  const familyId = randomHex(16);
  const refreshId = randomHex(16);
  const rawKey = native ? `deck_${randomHex(32)}` : undefined;
  const keyId = native ? randomHex(16) : undefined;

  const loginTx = await withTransaction(c.env.DB, async (tx) => {
    const lockedUser = await tx.queryOne<{
      id: string;
      password_hash: string | null;
      status: string;
      password_must_change: boolean | null;
      sessions_valid_after: string | number;
    }>(
      'SELECT id, password_hash, status, password_must_change, sessions_valid_after FROM users WHERE id = $1 FOR UPDATE',
      [user.id],
    );
    if (!lockedUser || lockedUser.password_hash !== user.password_hash) {
      return { ok: false as const, status: 401 as const, error: AUTH_ERROR_CODES.INVALID_CREDENTIALS };
    }
    if (lockedUser.status !== 'active') {
      return {
        ok: false as const,
        status: 403 as const,
        error: lockedUser.status === 'pending' ? AUTH_ERROR_CODES.ACCOUNT_PENDING : AUTH_ERROR_CODES.ACCOUNT_DISABLED,
      };
    }
    const txLockout = await checkAuthLockout(tx, `user:${user.id}`);
    if (txLockout.locked) {
      return {
        ok: false as const,
        status: 429 as const,
        error: AUTH_ERROR_CODES.TOO_MANY_ATTEMPTS,
        retryAfterMs: txLockout.lockedUntil ? txLockout.lockedUntil - Date.now() : 0,
      };
    }

    const txNow = Date.now();
    const iat = alignedSessionIssuedAt(Number(lockedUser.sessions_valid_after ?? 0) || 0, txNow);
    const accessToken = signJwt(
      { sub: user.id, type: ACCOUNT_SESSION_JWT_TYPE, iat },
      c.env.JWT_SIGNING_KEY,
      4 * 3600,
    );
    await tx.execute(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [refreshId, user.id, refreshHash, familyId, txNow + 30 * 24 * 3600 * 1000, txNow],
    );
    if (native && rawKey && keyId) {
      await tx.execute(
        'INSERT INTO api_keys (id, user_id, key_hash, label, created_at) VALUES ($1, $2, $3, $4, $5)',
        [keyId, user.id, sha256Hex(rawKey), 'native-password-login', txNow],
      );
    }
    return { ok: true as const, accessToken, passwordMustChange: !!lockedUser.password_must_change };
  });

  if (!loginTx.ok) {
    if (loginTx.status === 429) {
      return c.json({ error: loginTx.error, retryAfterMs: loginTx.retryAfterMs }, 429);
    }
    return c.json({ error: loginTx.error }, loginTx.status);
  }

  const { accessToken, passwordMustChange } = loginTx;
  const isSecure = c.env.NODE_ENV === 'production';
  setCookie(c, COOKIE_SESSION, accessToken, {
    httpOnly: true, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 4 * 3600,
  });
  setCookie(c, 'rcc_refresh', refreshRaw, {
    httpOnly: true, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 30 * 86400,
  });
  setCookie(c, COOKIE_CSRF, randomHex(32), {
    httpOnly: false, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 30 * 86400,
  });

  await logAuthAudit(c, { userId: user.id, action: 'auth.password_login', ip }, c.env.DB);

  return c.json({
    ok: true,
    passwordMustChange,
    accessToken,
    refreshToken: refreshRaw,
    ...(native ? { apiKey: rawKey, keyId, userId: user.id } : {}),
  });
});

// PATCH /api/auth/user/me — update display name
const patchMeSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
});

authRoutes.patch('/user/me', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = patchMeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  if (parsed.data.displayName !== undefined) {
    await c.env.DB.execute('UPDATE users SET display_name = $1 WHERE id = $2', [parsed.data.displayName, userId]);
  }

  const user = await getUserById(c.env.DB, userId);
  return c.json(toClientUser(user));
});

// POST /api/auth/password/reset — forgot-password reset with verified email OTP
const passwordResetSchema = z.object({
  email: z.string(),
  code: z.string(),
  newPassword: z.string().min(8),
});

authRoutes.post('/password/reset', async (c) => {
  if (!isEmailAuthEnabled(c.env)) {
    return c.json({ error: AUTH_ERROR_CODES.EMAIL_AUTH_DISABLED }, 403);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = passwordResetSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: AUTH_ERROR_CODES.INVALID_BODY }, 400);

  if (!isValidEmail(parsed.data.email)) {
    return c.json({ error: AUTH_ERROR_CODES.INVALID_EMAIL }, 400);
  }
  if (!isValidEmailOtp(parsed.data.code)) {
    return c.json({ error: AUTH_ERROR_CODES.EMAIL_CODE_REQUIRED }, 400);
  }

  const complexity = validatePasswordComplexity(parsed.data.newPassword);
  if (!complexity.valid) {
    return c.json({ error: complexity.errorKey }, 400);
  }

  const normalizedEmail = normalizeEmail(parsed.data.email);
  const code = parsed.data.code.trim();
  const lockoutKey = `email-reset:${normalizedEmail}`;
  const resetLockout = await checkAuthLockout(c.env.DB, lockoutKey);
  if (resetLockout.locked) {
    return c.json({
      error: AUTH_ERROR_CODES.TOO_MANY_ATTEMPTS,
      retryAfterMs: resetLockout.lockedUntil ? resetLockout.lockedUntil - Date.now() : 0,
    }, 429);
  }

  const newHash = await hashPassword(parsed.data.newPassword);
  const resetTx = await withTransaction(c.env.DB, async (tx) => {
    const lockedUser = await tx.queryOne<{ id: string; status: string; sessions_valid_after: string | number }>(
      'SELECT id, status, sessions_valid_after FROM users WHERE LOWER(email) = $1 AND email_verified_at IS NOT NULL FOR UPDATE',
      [normalizedEmail],
    );
    if (!lockedUser) {
      return { ok: false as const, status: 400 as const, error: AUTH_ERROR_CODES.EMAIL_CODE_INVALID, recordFailure: true };
    }
    if (!isUserStatusActive(lockedUser.status)) {
      return {
        ok: false as const,
        status: 403 as const,
        error: lockedUser.status === 'pending' ? AUTH_ERROR_CODES.ACCOUNT_PENDING : AUTH_ERROR_CODES.ACCOUNT_DISABLED,
      };
    }

    const consumed = await consumeEmailVerificationCode(tx, c.env.JWT_SIGNING_KEY, {
      email: normalizedEmail,
      purpose: EMAIL_AUTH_PURPOSE.PASSWORD_RESET,
      code,
      userId: lockedUser.id,
    });
    if (!consumed.ok) {
      return { ok: false as const, status: 400 as const, error: consumed.error, recordFailure: true };
    }

    const txNow = consumed.now;
    const prevValidAfter = Number(lockedUser.sessions_valid_after ?? 0) || 0;
    const newValidAfter = nextSessionValidAfter(prevValidAfter, txNow);

    await tx.execute(
      'UPDATE users SET password_hash = $1, password_must_change = false, sessions_valid_after = GREATEST(sessions_valid_after, $3) WHERE id = $2',
      [newHash, lockedUser.id, newValidAfter],
    );
    await tx.execute(
      'UPDATE refresh_tokens SET used_at = $1 WHERE user_id = $2 AND used_at IS NULL',
      [txNow, lockedUser.id],
    );

    return { ok: true as const, userId: lockedUser.id, newValidAfter };
  });

  if (!resetTx.ok) {
    if ('recordFailure' in resetTx && resetTx.recordFailure) {
      await recordAuthFailure(c.env.DB, lockoutKey, 'password_reset_invalid_code');
    }
    return c.json({ error: resetTx.error }, resetTx.status);
  }

  evictStaleUserBrowserSockets(resetTx.userId, resetTx.newValidAfter);
  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAuthAudit(c, { userId: resetTx.userId, action: 'auth.password_reset', ip }, c.env.DB);
  return c.json({ ok: true });
});

// POST /api/auth/password/change — change password (requires auth)
const passwordChangeSchema = z.object({
  oldPassword: z.string().min(1).optional(),
  newPassword: z.string().min(8),
  emailCode: z.string().optional(),
});

authRoutes.post('/password/change', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const userLockout = await checkAuthLockout(c.env.DB, `user:${userId}`);
  if (userLockout.locked) {
    return c.json({
      error: AUTH_ERROR_CODES.TOO_MANY_ATTEMPTS,
      retryAfterMs: userLockout.lockedUntil ? userLockout.lockedUntil - Date.now() : 0,
    }, 429);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = passwordChangeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { oldPassword, newPassword, emailCode } = parsed.data;

  // Validate password complexity
  const complexity = validatePasswordComplexity(newPassword);
  if (!complexity.valid) {
    return c.json({ error: complexity.errorKey }, 400);
  }

  const user = await getUserById(c.env.DB, userId);
  if (!user || !user.password_hash) return c.json({ error: 'no_password_set' }, 400);

  let oldPasswordVerified = false;
  if (typeof oldPassword === 'string' && oldPassword.length > 0) {
    const valid = await verifyPassword(oldPassword, user.password_hash);
    if (!valid) {
      await recordAuthFailure(c.env.DB, `user:${userId}`, 'password_change_invalid_old_password');
      return c.json({ error: AUTH_ERROR_CODES.INVALID_OLD_PASSWORD }, 401);
    }
    oldPasswordVerified = true;
  }

  const emailAuthEnabled = isEmailAuthEnabled(c.env);
  const newHash = await hashPassword(newPassword);
  const hadSessionCookie = !c.req.header('Authorization') && !!getCookie(c, COOKIE_SESSION);

  const changeTx = await withTransaction(c.env.DB, async (tx) => {
    const lockedUser = await tx.queryOne<{
      id: string;
      password_hash: string | null;
      status: string;
      sessions_valid_after: string | number;
      email: string | null;
      email_verified_at: string | number | null;
      password_must_change: boolean | null;
    }>(
      'SELECT id, password_hash, status, sessions_valid_after, email, email_verified_at, password_must_change FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    if (!lockedUser || !lockedUser.password_hash) {
      return { ok: false as const, status: 400 as const, error: 'no_password_set' };
    }
    if (lockedUser.password_hash !== user.password_hash) {
      return { ok: false as const, status: 401 as const, error: AUTH_ERROR_CODES.INVALID_OLD_PASSWORD };
    }
    if (!isUserStatusActive(lockedUser.status)) {
      return {
        ok: false as const,
        status: 403 as const,
        error: lockedUser.status === 'pending' ? AUTH_ERROR_CODES.ACCOUNT_PENDING : AUTH_ERROR_CODES.ACCOUNT_DISABLED,
      };
    }

    const txRequiresEmailCode = emailAuthEnabled
      && !lockedUser.password_must_change
      && Boolean(lockedUser.email && lockedUser.email_verified_at);

    let txNow: number;
    if (!txRequiresEmailCode) {
      if (!oldPasswordVerified) {
        return { ok: false as const, status: 400 as const, error: AUTH_ERROR_CODES.INVALID_BODY };
      }
      txNow = await getDbClockMs(tx);
    } else {
      if (!isValidEmailOtp(emailCode)) {
        return { ok: false as const, status: 400 as const, error: AUTH_ERROR_CODES.EMAIL_CODE_REQUIRED };
      }
      const consumed = await consumeEmailVerificationCode(tx, c.env.JWT_SIGNING_KEY, {
        email: lockedUser.email!,
        purpose: EMAIL_AUTH_PURPOSE.PASSWORD_CHANGE,
        code: emailCode.trim(),
        userId,
      });
      if (!consumed.ok) {
        return { ok: false as const, status: 400 as const, error: consumed.error, recordFailure: true };
      }
      txNow = consumed.now;
    }

    const prevValidAfter = Number(lockedUser.sessions_valid_after ?? 0) || 0;
    const newValidAfter = nextSessionValidAfter(prevValidAfter, txNow);

    await tx.execute(
      'UPDATE users SET password_hash = $1, password_must_change = false, sessions_valid_after = GREATEST(sessions_valid_after, $3) WHERE id = $2',
      [newHash, userId, newValidAfter],
    );
    await tx.execute(
      'UPDATE refresh_tokens SET used_at = $1 WHERE user_id = $2 AND used_at IS NULL',
      [txNow, userId],
    );

    if (hadSessionCookie && c.env.JWT_SIGNING_KEY) {
      const nextIat = alignedSessionIssuedAt(newValidAfter, txNow);
      const accessToken = signJwt({ sub: userId, type: ACCOUNT_SESSION_JWT_TYPE, iat: nextIat }, c.env.JWT_SIGNING_KEY, 4 * 3600);
      const refreshRaw = randomHex(32);
      await tx.execute(
        'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [randomHex(16), userId, sha256Hex(refreshRaw), randomHex(16), txNow + 30 * 24 * 3600 * 1000, txNow],
      );
      return { ok: true as const, accessToken, refreshRaw, newValidAfter };
    }
    return { ok: true as const, accessToken: null, refreshRaw: null, newValidAfter };
  });

  if (!changeTx.ok) {
    if ('recordFailure' in changeTx && changeTx.recordFailure) {
      await recordAuthFailure(c.env.DB, `user:${userId}`, 'password_change_invalid_email_code');
    }
    return c.json({ error: changeTx.error }, changeTx.status);
  }

  if (emailAuthEnabled) {
    evictStaleUserBrowserSockets(userId, changeTx.newValidAfter);
  }

  if (changeTx.accessToken && changeTx.refreshRaw) {
    const isSecure = c.env.NODE_ENV === 'production';
    setCookie(c, COOKIE_SESSION, changeTx.accessToken, {
      httpOnly: true, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 4 * 3600,
    });
    setCookie(c, 'rcc_refresh', changeTx.refreshRaw, {
      httpOnly: true, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 30 * 86400,
    });
    const existingCsrf = getCookie(c, COOKIE_CSRF);
    setCookie(c, COOKIE_CSRF, existingCsrf || randomHex(32), {
      httpOnly: false, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 30 * 86400,
    });
  }

  const ip = c.get('clientIp' as never) as string ?? 'unknown';
  await logAuthAudit(c, { userId, action: 'auth.password_change', ip }, c.env.DB);

  return c.json({ ok: true });
});

// POST /api/auth/logout — clear session cookies + invalidate refresh tokens
authRoutes.post('/logout', async (c) => {
  const userId = await resolveUserId(c);

  // The access JWT remains cryptographically valid after its cookie is removed.
  // Persist exact-session revocation before clearing it so pending native codes
  // and action-bound remote-desktop grants cannot survive logout.
  await revokeBrowserAccountSession(
    c.env.DB,
    c.env.JWT_SIGNING_KEY,
    c.req.header('cookie'),
  );

  // Clear all auth cookies regardless of auth state
  deleteCookie(c, COOKIE_SESSION, { path: '/' });
  deleteCookie(c, 'rcc_refresh', { path: '/' });
  deleteCookie(c, COOKIE_CSRF, { path: '/' });

  // Invalidate all active refresh tokens for the user
  if (userId) {
    await c.env.DB.execute(
      'UPDATE refresh_tokens SET used_at = $1 WHERE user_id = $2 AND used_at IS NULL',
      [Date.now(), userId],
    );
  }

  return c.json({ ok: true });
});

// ── Keyless Central OAuth Relay for Document Collaborators (GitHub & Google) ──

const DOC_SHARE_RELAY_CALLBACK_PATH = '/api/doc-shares/auth-relay/callback';

function isAllowedDocRelayOrigin(
  env: { SERVER_URL: string; ALLOWED_ORIGINS?: string },
  rawOrigin: string,
): string | null {
  const trimmed = rawOrigin.trim().replace(/\/$/, '');
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.origin !== trimmed) return null;

  const configured = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (configured.length > 0) {
    const allowed = new Set([env.SERVER_URL.replace(/\/$/, ''), ...configured]);
    if (!allowed.has(trimmed)) return null;
  }
  return trimmed;
}

async function handleCentralDocRelayStart(
  c: { req: { query(name: string): string | undefined }; env: Env; json(data: unknown, status?: number): Response; redirect(url: string): Response },
  provider: 'github' | 'google',
): Promise<Response> {
  const rawOrigin = c.req.query('origin') ?? '';
  const callbackPath = c.req.query('callback_path') ?? '';
  const clientState = (c.req.query('state') ?? '').trim();

  if (callbackPath !== DOC_SHARE_RELAY_CALLBACK_PATH) {
    return c.json({ error: 'invalid_callback_path' }, 400);
  }
  const targetOrigin = isAllowedDocRelayOrigin(c.env, rawOrigin);
  if (!targetOrigin) {
    return c.json({ error: 'invalid_origin' }, 400);
  }
  if (!clientState) {
    return c.json({ error: 'missing_state' }, 400);
  }

  const centralState = signJwt(
    {
      type: 'doc-auth-relay-central',
      provider,
      origin: targetOrigin,
      callbackPath: DOC_SHARE_RELAY_CALLBACK_PATH,
      clientState,
      nonce: randomHex(16),
    },
    c.env.JWT_SIGNING_KEY,
    600,
  );

  const centralRedirectUri = `${c.env.SERVER_URL.replace(/\/$/, '')}/api/auth/${provider}/callback`;
  if (provider === 'github') {
    const params = new URLSearchParams({
      client_id: c.env.GITHUB_CLIENT_ID ?? '',
      redirect_uri: centralRedirectUri,
      scope: 'read:user user:email',
      state: centralState,
    });
    return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
  }

  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: centralRedirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: centralState,
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

async function handleCentralDocRelayCallback(
  c: { req: { query(name: string): string | undefined }; env: Env; json(data: unknown, status?: number): Response; redirect(url: string): Response },
  provider: 'github' | 'google',
  centralStatePayload: Record<string, unknown>,
): Promise<Response> {
  const code = c.req.query('code') ?? '';
  if (!code) return c.json({ error: 'missing_code' }, 400);

  if (
    centralStatePayload.provider !== provider ||
    centralStatePayload.callbackPath !== DOC_SHARE_RELAY_CALLBACK_PATH
  ) {
    return c.json({ error: 'invalid_state' }, 400);
  }
  const targetOrigin = isAllowedDocRelayOrigin(c.env, String(centralStatePayload.origin ?? ''));
  if (!targetOrigin) {
    return c.json({ error: 'invalid_origin' }, 400);
  }
  const clientState = String(centralStatePayload.clientState ?? '');
  if (!clientState) {
    return c.json({ error: 'missing_client_state' }, 400);
  }

  let externalId = '';
  let username = '';
  let email: string | null = null;
  let displayName = '';

  if (provider === 'github') {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: c.env.GITHUB_CLIENT_ID,
        client_secret: c.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    if (!tokenRes.ok) return c.json({ error: 'token_exchange_failed' }, 502);
    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) return c.json({ error: 'no_access_token' }, 502);

    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'User-Agent': 'imcodes',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!userRes.ok) return c.json({ error: 'github_user_fetch_failed' }, 502);
    const ghUser = (await userRes.json()) as { id?: number | string; login?: string; name?: string; email?: string };
    if (!ghUser.id) return c.json({ error: 'invalid_github_user' }, 502);
    externalId = String(ghUser.id);
    username = ghUser.login ?? `gh_${externalId}`;
    email = ghUser.email ?? null;
    displayName = ghUser.name || username;
  } else {
    const centralRedirectUri = `${c.env.SERVER_URL.replace(/\/$/, '')}/api/auth/google/callback`;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: c.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: c.env.GOOGLE_CLIENT_SECRET ?? '',
        code,
        grant_type: 'authorization_code',
        redirect_uri: centralRedirectUri,
      }).toString(),
    });
    if (!tokenRes.ok) return c.json({ error: 'token_exchange_failed' }, 502);
    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) return c.json({ error: 'no_access_token' }, 502);

    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userRes.ok) return c.json({ error: 'google_user_fetch_failed' }, 502);
    const gUser = (await userRes.json()) as { id?: string; sub?: string; email?: string; name?: string };
    const gid = gUser.id ?? gUser.sub;
    if (!gid) return c.json({ error: 'invalid_google_user' }, 502);
    externalId = String(gid);
    email = gUser.email ?? null;
    username = email ? email.split('@')[0] : `google_${externalId.slice(0, 8)}`;
    displayName = gUser.name || email || username;
  }

  const jti = randomHex(16);
  const relayToken = signJwt(
    {
      type: 'doc-auth-relay-ticket',
      iss: c.env.SERVER_URL.replace(/\/$/, ''),
      aud: targetOrigin,
      jti,
      provider,
      sub: `${provider}:${externalId}`,
      externalId,
      username,
      email,
      displayName,
      stateHash: sha256Hex(clientState),
    },
    c.env.JWT_SIGNING_KEY,
    120,
  );

  const callbackUrl = new URL(`${targetOrigin}${DOC_SHARE_RELAY_CALLBACK_PATH}`);
  callbackUrl.searchParams.set('relay_token', relayToken);
  callbackUrl.searchParams.set('state', clientState);
  callbackUrl.searchParams.set('provider', provider);
  return c.redirect(callbackUrl.toString());
}

authRoutes.get('/github', async (c, next) => {
  if (c.req.query('callback_path')) {
    if (c.req.query(DESKTOP_SETUP_CALLBACK_QUERY_PARAM)) {
      return c.json({ error: 'invalid_desktop_callback' }, 400);
    }
    return handleCentralDocRelayStart(c, 'github');
  }
  return next();
});

authRoutes.get('/github/callback', async (c, next) => {
  const state = c.req.query('state');
  if (state && c.env.JWT_SIGNING_KEY) {
    const payload = verifyJwt(state, c.env.JWT_SIGNING_KEY);
    if (payload && payload.type === 'doc-auth-relay-central') {
      return handleCentralDocRelayCallback(c, 'github', payload);
    }
  }
  return next();
});

authRoutes.get('/google', async (c, next) => {
  if (c.req.query('callback_path')) {
    if (c.req.query(DESKTOP_SETUP_CALLBACK_QUERY_PARAM)) {
      return c.json({ error: 'invalid_desktop_callback' }, 400);
    }
    return handleCentralDocRelayStart(c, 'google');
  }
  return next();
});

authRoutes.get('/google/callback', async (c, next) => {
  const state = c.req.query('state');
  if (state && c.env.JWT_SIGNING_KEY) {
    const payload = verifyJwt(state, c.env.JWT_SIGNING_KEY);
    if (payload && payload.type === 'doc-auth-relay-central') {
      return handleCentralDocRelayCallback(c, 'google', payload);
    }
  }
  return next();
});

const verifyRelayTicketSchema = z.object({
  relayToken: z.string().min(1),
  expectedAudience: z.string().min(1),
  expectedProvider: z.enum(['github', 'google']).optional(),
  expectedStateHash: z.string().min(1).optional(),
});

authRoutes.post('/relay/verify', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = verifyRelayTicketSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  const payload = verifyJwt(parsed.data.relayToken, c.env.JWT_SIGNING_KEY);
  if (!payload || payload.type !== 'doc-auth-relay-ticket') {
    return c.json({ error: 'invalid_relay_token' }, 401);
  }

  const expectedIssuer = c.env.SERVER_URL.replace(/\/$/, '');
  if (payload.iss !== expectedIssuer) {
    return c.json({ error: 'invalid_relay_issuer' }, 401);
  }

  const expectedAud = parsed.data.expectedAudience.trim().replace(/\/$/, '');
  if (payload.aud !== expectedAud) {
    return c.json({ error: 'invalid_relay_audience' }, 401);
  }

  if (parsed.data.expectedProvider && payload.provider !== parsed.data.expectedProvider) {
    return c.json({ error: 'invalid_relay_provider' }, 401);
  }

  if (parsed.data.expectedStateHash && payload.stateHash !== parsed.data.expectedStateHash) {
    return c.json({ error: 'invalid_relay_state_binding' }, 401);
  }

  const jti = typeof payload.jti === 'string' ? payload.jti : '';
  if (!jti) {
    return c.json({ error: 'relay_token_replayed' }, 401);
  }

  // Persist single-use JTI consumption across all replicas using a purpose-isolated, server-keyed
  // passkey_challenges row (id prefixed by DOC_RELAY_TICKET_ID_PREFIX; passkey flows ignore that prefix).
  // Retain the marker until (exp + 1) * 1000 because verifyJwt accepts tokens throughout their exp second.
  const ticketChallengeId = `${DOC_RELAY_TICKET_ID_PREFIX}${sha256Hex(`${c.env.JWT_SIGNING_KEY}:${DOC_RELAY_TICKET_PURPOSE}:${jti}`)}`;
  const now = Date.now();
  const expiresAt = typeof payload.exp === 'number' ? (payload.exp + 1) * 1000 : now + 5 * 60 * 1000;
  await c.env.DB.execute(
    'DELETE FROM passkey_challenges WHERE id LIKE $1 AND expires_at < $2',
    [`${DOC_RELAY_TICKET_ID_PREFIX}%`, now],
  );
  const insertedTicket = await c.env.DB.queryOne<{ id: string }>(
    'INSERT INTO passkey_challenges (id, challenge, user_id, display_name, expires_at, created_at) VALUES ($1, $2, NULL, $3, $4, $5) ON CONFLICT (id) DO NOTHING RETURNING id',
    [ticketChallengeId, ticketChallengeId, DOC_RELAY_TICKET_PURPOSE, expiresAt, now],
  );
  if (!insertedTicket) {
    return c.json({ error: 'relay_token_replayed' }, 401);
  }

  return c.json({
    ok: true,
    issuer: expectedIssuer,
    profile: {
      provider: payload.provider as 'github' | 'google',
      externalId: String(payload.externalId ?? ''),
      username: String(payload.username ?? ''),
      email: typeof payload.email === 'string' ? payload.email : null,
      displayName: String(payload.displayName ?? ''),
    },
  });
});
