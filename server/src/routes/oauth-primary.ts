import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { DESKTOP_SETUP_CALLBACK_QUERY_PARAM, parseDesktopSetupCallbackUrl } from '../../../shared/desktop-setup-auth.js';
import { ACCOUNT_SESSION_JWT_TYPE } from '../../../shared/auth-token-types.js';
import type { Env } from '../env.js';
import { createUser, getUserByPlatformId, upsertPlatformIdentity } from '../db/queries.js';
import { randomHex, sha256Hex, signJwt, verifyJwt } from '../security/crypto.js';
import { evaluateUserAccess, loadUserAccess } from '../security/user-status.js';
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

    let userId: string;
    let targetOrigin: string | null = null;
    let desktopCallback: string | null = null;

    if (relayToken) {
      const payload = verifyJwt(relayToken, c.env.JWT_SIGNING_KEY);
      if (!payload || payload.type !== 'auth-relay' || !payload.sub) {
        return c.json({ error: 'invalid_relay_token' }, 401);
      }
      userId = payload.sub as string;
      targetOrigin = (payload.origin as string) ?? null;
      desktopCallback = typeof payload.desktopCallback === 'string'
        ? parseDesktopSetupCallbackUrl(payload.desktopCallback)?.href ?? null
        : null;
      const relayDecision = evaluateUserAccess(await loadUserAccess(c.env.DB, userId));
      if (!relayDecision.ok) return c.json({ error: relayDecision.code }, 403);
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
        user = await createUser(c.env.DB, randomHex(16));
        await upsertPlatformIdentity(c.env.DB, randomHex(16), user.id, config.provider, exchanged.platformUserId);
      }
      userId = user.id;

      const loginDecision = evaluateUserAccess(await loadUserAccess(c.env.DB, userId));
      if (!loginDecision.ok) return c.json({ error: loginDecision.code }, 403);

      if (isCrossDomain && targetOrigin) {
        const relay = signJwt(
          { sub: userId, type: 'auth-relay', origin: targetOrigin, ...(desktopCallback ? { desktopCallback } : {}) },
          c.env.JWT_SIGNING_KEY,
          120,
        );
        const relayUrl = new URL(`${targetOrigin}${config.callbackPath}`);
        relayUrl.searchParams.set('relay_token', relay);
        logger.info({ provider: config.provider, relayUrl: relayUrl.toString() }, 'oauth callback: relaying to proxy domain with token');
        return c.redirect(relayUrl.toString());
      }
    }

    const isSecure = c.env.NODE_ENV === 'production';
    const accessToken = signJwt({ sub: userId, type: ACCOUNT_SESSION_JWT_TYPE }, c.env.JWT_SIGNING_KEY, 4 * 3600);

    const refreshRaw = randomHex(32);
    const refreshHash = sha256Hex(refreshRaw);
    const familyId = randomHex(16);
    const refreshId = randomHex(16);
    await c.env.DB.execute(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [refreshId, userId, refreshHash, familyId, Date.now() + 30 * 24 * 3600 * 1000, Date.now()],
    );

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
