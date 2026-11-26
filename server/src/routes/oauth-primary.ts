import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { DESKTOP_SETUP_CALLBACK_QUERY_PARAM, parseDesktopSetupCallbackUrl } from '../../../shared/desktop-setup-auth.js';
import { ACCOUNT_SESSION_JWT_TYPE } from '../../../shared/auth-token-types.js';
import { AUTH_ERROR_CODES } from '../../../shared/auth-error-codes.js';
import type { Env } from '../env.js';
import { createUser, getSetting, getUserByPlatformId, updateUserStatus, upsertPlatformIdentity, withTransaction } from '../db/queries.js';
import { randomHex, sha256Hex, signJwt, verifyJwt } from '../security/crypto.js';
import { alignedSessionIssuedAt, evaluateUserAccess } from '../security/user-status.js';
import logger from '../util/logger.js';

export type PrimaryOAuthProvider = 'github' | 'google';

export interface PrimaryOAuthConfig {
  provider: PrimaryOAuthProvider;
  callbackPath: string;
  buildAuthorizeUrl: (opts: {
    env: Env;
    stateJwt: string;
    redirectUri: string;
    reauth: boolean;
  }) => string;
  exchangeCodeForPlatformUser: (opts: {
    env: Env;
    code: string;
    redirectUri: string;
  }) => Promise<{ ok: true; platformUserId: string } | { ok: false; status: 502; error: string }>;
}

/** Builds the set of allowed origins from env (`SERVER_URL` + `ALLOWED_ORIGINS`). */
export function allowedOAuthOrigins(env: { SERVER_URL: string; ALLOWED_ORIGINS?: string }): Set<string> {
  const list = new Set<string>();
  if (env.SERVER_URL) list.add(env.SERVER_URL.replace(/\/$/, ''));
  for (const o of (env.ALLOWED_ORIGINS ?? '').split(',')) {
    const t = o.trim();
    if (t) list.add(t.replace(/\/$/, ''));
  }
  return list;
}

/**
 * Resolves the current origin using the proxy-aware `resolvedHost` set by middleware
 * in `index.ts`. Falls back to `SERVER_URL` when the host is unknown or not allowlisted.
 */
export function resolveCurrentOAuthOrigin(
  c: { get(key: string): unknown; env: { SERVER_URL: string; ALLOWED_ORIGINS?: string; NODE_ENV?: string } },
): string {
  const protocol = c.env.NODE_ENV === 'production' ? 'https' : 'http';
  const host = c.get('resolvedHost') as string | null;
  const candidate = host ? `${protocol}://${host}` : null;
  if (candidate && allowedOAuthOrigins(c.env).has(candidate)) return candidate;
  return c.env.SERVER_URL;
}

/** Creates Hono start + callback routes for a primary account OAuth provider. */
export function createPrimaryOAuthRoutes(config: PrimaryOAuthConfig) {
  const routes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();
  const normalizedServerRedirectUri = (env: Env) => `${env.SERVER_URL.replace(/\/$/, '')}${config.callbackPath}`;

  routes.get('/', async (c): Promise<Response> => {
    const explicitOrigin = c.req.query('origin');
    const normalizedExplicit = explicitOrigin?.replace(/\/$/, '');
    const currentOrigin = normalizedExplicit && allowedOAuthOrigins(c.env).has(normalizedExplicit)
      ? normalizedExplicit
      : resolveCurrentOAuthOrigin(c);

    const rawDesktopCallback = c.req.query(DESKTOP_SETUP_CALLBACK_QUERY_PARAM);
    const desktopCallback = rawDesktopCallback !== undefined
      ? parseDesktopSetupCallbackUrl(rawDesktopCallback)?.href ?? null
      : null;
    if (rawDesktopCallback !== undefined && !desktopCallback) {
      return c.json({ error: 'invalid_desktop_callback' }, 400);
    }

    const stateValue = randomHex(32);
    const stateJwt = signJwt(
      {
        nonce: stateValue,
        origin: currentOrigin,
        provider: config.provider,
        ...(desktopCallback ? { desktopCallback } : {}),
      },
      c.env.JWT_SIGNING_KEY,
      600,
    );

    const isSecure = c.env.NODE_ENV === 'production';
    setCookie(c, 'oauth_state', stateValue, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'Lax',
      path: config.callbackPath,
      maxAge: 600,
    });

    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');

    const redirectUri = normalizedServerRedirectUri(c.env);
    return c.redirect(
      config.buildAuthorizeUrl({
        env: c.env,
        stateJwt,
        redirectUri,
        reauth: c.req.query('reauth') === '1',
      }),
    );
  });

  routes.get('/callback', async (c): Promise<Response> => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const relayToken = c.req.query('relay_token');

    const OAUTH_RELAY_KEY_ID = 'oauth-relay';
    let userId: string;
    let targetOrigin: string | null = null;
    let desktopCallback: string | null = null;
    let accessToken = '';
    const refreshRaw = randomHex(32);
    const refreshHash = sha256Hex(refreshRaw);
    const familyId = randomHex(16);
    const refreshId = randomHex(16);

    if (relayToken) {
      const payload = verifyJwt(relayToken, c.env.JWT_SIGNING_KEY);
      if (
        !payload
        || payload.type !== 'auth-relay'
        || typeof payload.sub !== 'string'
        || !payload.sub
        || typeof payload.jti !== 'string'
        || !payload.jti
      ) {
        return c.json({ error: 'invalid_relay_token' }, 401);
      }
      const actualOrigin = resolveCurrentOAuthOrigin(c);
      if (typeof payload.origin !== 'string' || payload.origin !== actualOrigin) {
        return c.json({ error: 'invalid_relay_origin' }, 401);
      }
      const relayNonce = `${OAUTH_RELAY_KEY_ID}:${payload.jti}`;
      targetOrigin = payload.origin;
      desktopCallback = typeof payload.desktopCallback === 'string'
        ? parseDesktopSetupCallbackUrl(payload.desktopCallback)?.href ?? null
        : null;

      const relayResult = await withTransaction(c.env.DB, async (tx) => {
        // Acquire users row lock BEFORE touching auth_nonces so lock order matches disableUserEndingSessions.
        const lockedUser = await tx.queryOne<{ status: string; sessions_valid_after: string | number }>(
          'SELECT status, sessions_valid_after FROM users WHERE id = $1 FOR UPDATE',
          [payload.sub],
        );
        const access = lockedUser
          ? { status: lockedUser.status, sessionsValidAfter: Number(lockedUser.sessions_valid_after ?? 0) || 0 }
          : null;
        const relayDecision = evaluateUserAccess(access);
        if (!relayDecision.ok) {
          return { ok: false as const, status: 403 as const, error: relayDecision.code };
        }
        const txNow = Date.now();
        const consumedNonce = await tx.queryOne<{ user_id: string }>(
          'DELETE FROM auth_nonces WHERE nonce = $1 AND user_id = $2 AND expires_at > $3 AND key_id = $4 RETURNING user_id',
          [relayNonce, payload.sub, txNow, OAUTH_RELAY_KEY_ID],
        );
        if (!consumedNonce) {
          return { ok: false as const, status: 401 as const, error: 'relay_token_replayed' };
        }
        await tx.execute(
          'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
          [refreshId, payload.sub, refreshHash, familyId, txNow + 30 * 24 * 3600 * 1000, txNow],
        );
        const token = signJwt(
          { sub: payload.sub, type: ACCOUNT_SESSION_JWT_TYPE, iat: alignedSessionIssuedAt(access?.sessionsValidAfter ?? 0, txNow) },
          c.env.JWT_SIGNING_KEY,
          4 * 3600,
        );
        return { ok: true as const, token };
      });
      if (!relayResult.ok) {
        return c.json({ error: relayResult.error }, relayResult.status);
      }
      userId = payload.sub;
      accessToken = relayResult.token;
    } else {
      if (!code || !state) {
        return c.json({ error: 'missing_params' }, 400);
      }

      const statePayload = verifyJwt(state, c.env.JWT_SIGNING_KEY) as {
        nonce?: string;
        origin?: string;
        provider?: string;
        desktopCallback?: unknown;
      } | null;
      if (!statePayload || !statePayload.nonce || (statePayload.provider && statePayload.provider !== config.provider)) {
        return c.json({ error: 'invalid_state' }, 400);
      }

      targetOrigin = statePayload.origin ?? null;
      desktopCallback = typeof statePayload.desktopCallback === 'string'
        ? parseDesktopSetupCallbackUrl(statePayload.desktopCallback)?.href ?? null
        : null;

      const actualOrigin = resolveCurrentOAuthOrigin(c);
      logger.info({ provider: config.provider, targetOrigin, actualOrigin }, 'oauth callback: origin detection');

      const cookieState = getCookie(c, 'oauth_state');
      const isCrossDomain = Boolean(
        targetOrigin && targetOrigin !== actualOrigin && allowedOAuthOrigins(c.env).has(targetOrigin),
      );

      if (!isCrossDomain) {
        if (!cookieState || statePayload.nonce !== cookieState) {
          logger.warn({ provider: config.provider, hasCookie: !!cookieState, targetOrigin, actualOrigin }, 'oauth callback: state_mismatch');
          return c.json({ error: 'state_mismatch' }, 400);
        }
        deleteCookie(c, 'oauth_state', { path: config.callbackPath });
      } else {
        logger.info({ provider: config.provider, targetOrigin }, 'oauth callback: cross-domain relay, skipping cookie check');
      }

      const exchanged = await config.exchangeCodeForPlatformUser({
        env: c.env,
        code,
        redirectUri: normalizedServerRedirectUri(c.env),
      });
      if (!exchanged.ok) {
        return c.json({ error: exchanged.error }, exchanged.status);
      }

      let user = await getUserByPlatformId(c.env.DB, config.provider, exchanged.platformUserId);
      if (!user) {
        const regEnabled = await getSetting(c.env.DB, 'registration_enabled');
        if (regEnabled === 'false') {
          return c.json({ error: AUTH_ERROR_CODES.REGISTRATION_DISABLED }, 403);
        }
        const requireApproval = await getSetting(c.env.DB, 'require_approval');
        user = await withTransaction(c.env.DB, async (tx) => {
          const created = await createUser(tx, randomHex(16));
          if (requireApproval === 'true') {
            await updateUserStatus(tx, created.id, 'pending');
          }
          await upsertPlatformIdentity(tx, randomHex(16), created.id, config.provider, exchanged.platformUserId);
          return created;
        });
      }
      userId = user.id;

      if (isCrossDomain && targetOrigin) {
        const jti = randomHex(16);
        const relayNonce = `${OAUTH_RELAY_KEY_ID}:${jti}`;
        // Global expired-nonce cleanup stays outside the user-locked transaction.
        await c.env.DB.execute(
          'DELETE FROM auth_nonces WHERE key_id = $1 AND expires_at < $2',
          [OAUTH_RELAY_KEY_ID, Date.now()],
        );
        const relayIssue = await withTransaction(c.env.DB, async (tx) => {
          const lockedUser = await tx.queryOne<{ status: string; sessions_valid_after: string | number }>(
            'SELECT status, sessions_valid_after FROM users WHERE id = $1 FOR UPDATE',
            [userId],
          );
          const access = lockedUser
            ? { status: lockedUser.status, sessionsValidAfter: Number(lockedUser.sessions_valid_after ?? 0) || 0 }
            : null;
          const decision = evaluateUserAccess(access);
          if (!decision.ok) {
            return { ok: false as const, code: decision.code };
          }
          const txNow = Date.now();
          const issuedSec = Math.floor(txNow / 1000);
          const relayExpSec = issuedSec + 120;
          // Cover the full verifyJwt validity window of the signed exp claim even if the transaction crosses a second boundary.
          const nonceExpiresAt = (relayExpSec + 1) * 1000;
          await tx.execute(
            'INSERT INTO auth_nonces (nonce, api_key, user_id, key_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
            [relayNonce, '', userId, OAUTH_RELAY_KEY_ID, nonceExpiresAt, txNow],
          );
          return { ok: true as const, issuedSec, relayExpSec };
        });
        if (!relayIssue.ok) {
          return c.json({ error: relayIssue.code }, 403);
        }
        const relay = signJwt(
          {
            sub: userId,
            type: 'auth-relay',
            origin: targetOrigin,
            jti,
            iat: relayIssue.issuedSec,
            exp: relayIssue.relayExpSec,
            ...(desktopCallback ? { desktopCallback } : {}),
          },
          c.env.JWT_SIGNING_KEY,
          120,
        );
        const relayUrl = new URL(`${targetOrigin}${config.callbackPath}`);
        relayUrl.searchParams.set('relay_token', relay);
        logger.info({ provider: config.provider, targetOrigin }, 'oauth callback: relaying to proxy domain with token');
        return c.redirect(relayUrl.toString());
      }

      const sessionTx = await withTransaction(c.env.DB, async (tx) => {
        const lockedUser = await tx.queryOne<{ status: string; sessions_valid_after: string | number }>(
          'SELECT status, sessions_valid_after FROM users WHERE id = $1 FOR UPDATE',
          [userId],
        );
        const txDecision = evaluateUserAccess(
          lockedUser ? { status: lockedUser.status, sessionsValidAfter: Number(lockedUser.sessions_valid_after ?? 0) || 0 } : null,
        );
        if (!txDecision.ok) return { ok: false as const, code: txDecision.code };
        const txNow = Date.now();
        await tx.execute(
          'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
          [refreshId, userId, refreshHash, familyId, txNow + 30 * 24 * 3600 * 1000, txNow],
        );
        const token = signJwt(
          { sub: userId, type: ACCOUNT_SESSION_JWT_TYPE, iat: alignedSessionIssuedAt(Number(lockedUser!.sessions_valid_after ?? 0) || 0, txNow) },
          c.env.JWT_SIGNING_KEY,
          4 * 3600,
        );
        return { ok: true as const, token };
      });
      if (!sessionTx.ok) return c.json({ error: sessionTx.code }, 403);
      accessToken = sessionTx.token;
    }

    const isSecure = c.env.NODE_ENV === 'production';

    setCookie(c, 'rcc_session', accessToken, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 4 * 3600,
    });
    setCookie(c, 'rcc_refresh', refreshRaw, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 30 * 86400,
    });
    setCookie(c, 'rcc_csrf', randomHex(32), {
      httpOnly: false,
      secure: isSecure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 30 * 86400,
    });

    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');

    const allowed = allowedOAuthOrigins(c.env);
    const safeTarget = (targetOrigin && allowed.has(targetOrigin)) ? targetOrigin : c.env.SERVER_URL;
    const safeDesktopCallback = desktopCallback ? parseDesktopSetupCallbackUrl(desktopCallback)?.href ?? null : null;
    if (safeDesktopCallback) {
      const dest = new URL('/', safeTarget);
      dest.searchParams.set(DESKTOP_SETUP_CALLBACK_QUERY_PARAM, safeDesktopCallback);
      return c.redirect(dest.toString());
    }
    return c.redirect(safeTarget);
  });

  return routes;
}
