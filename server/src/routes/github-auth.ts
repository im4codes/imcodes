import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from '../env.js';
import { createUser, getUserByPlatformId, upsertPlatformIdentity } from '../db/queries.js';
import { randomHex, sha256Hex, signJwt, verifyJwt } from '../security/crypto.js';
import logger from '../util/logger.js';

export const githubAuthRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

// Builds the set of allowed origins from env (SERVER_URL + ALLOWED_ORIGINS).
function allowedOrigins(env: { SERVER_URL: string; ALLOWED_ORIGINS?: string }): Set<string> {
  const list = new Set<string>();
  if (env.SERVER_URL) list.add(env.SERVER_URL.replace(/\/$/, ''));
  for (const o of (env.ALLOWED_ORIGINS ?? '').split(',')) {
    const t = o.trim();
    if (t) list.add(t.replace(/\/$/, ''));
  }
  return list;
}

// Resolves the current origin using the proxy-aware resolvedHost set by the
// middleware in index.ts (which only trusts x-forwarded-host through TRUSTED_PROXIES).
// Falls back to SERVER_URL when the host is unknown or not in the allowlist.
function resolveCurrentOrigin(
  c: { get(key: string): unknown; env: { SERVER_URL: string; ALLOWED_ORIGINS?: string; NODE_ENV?: string } },
): string {
  const protocol = c.env.NODE_ENV === 'production' ? 'https' : 'http';
  const host = c.get('resolvedHost') as string | null;
  const candidate = host ? `${protocol}://${host}` : null;
  if (candidate && allowedOrigins(c.env).has(candidate)) return candidate;
  return c.env.SERVER_URL;
}

// GET /api/auth/github — redirect to GitHub OAuth
// ?reauth=1 → forces GitHub login page (prevents auto-login after logout)
// ?origin=https://... → explicit origin for proxied deployments where Host is rewritten
githubAuthRoutes.get('/', async (c): Promise<Response> => {
  // Allow the frontend to pass its origin explicitly (needed when a reverse proxy
  // rewrites the Host header, e.g. CF proxy im.codes → app.im.codes).
  // Validated against ALLOWED_ORIGINS to prevent open-redirect.
  const explicitOrigin = c.req.query('origin');
  let currentOrigin: string;
  if (explicitOrigin) {
    const normalized = explicitOrigin.replace(/\/$/, '');
    if (allowedOrigins(c.env).has(normalized)) {
      currentOrigin = normalized;
    } else {
      currentOrigin = resolveCurrentOrigin(c);
    }
  } else {
    currentOrigin = resolveCurrentOrigin(c);
  }

  // State JWT embeds the origin so we know where to redirect after OAuth.
  // Cookie is set on the user's actual domain (e.g. im.codes via proxy).
  const stateValue = randomHex(32);
  const stateJwt = signJwt({ nonce: stateValue, origin: currentOrigin }, c.env.JWT_SIGNING_KEY, 600);

  const isSecure = c.env.NODE_ENV === 'production';
  setCookie(c, 'oauth_state', stateValue, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'Lax',
    path: '/api/auth/github/callback',
    maxAge: 600,
  });

  // redirect_uri always points to SERVER_URL — that's what GitHub has registered.
  const oauthParams = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID ?? '',
    redirect_uri: `${c.env.SERVER_URL}/api/auth/github/callback`,
    scope: 'read:user',
    state: stateJwt,
  });

  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  if (c.req.query('reauth') === '1') {
    const returnTo = `/login/oauth/authorize?${oauthParams.toString()}`;
    return c.redirect(`https://github.com/login?return_to=${encodeURIComponent(returnTo)}`);
  }

  return c.redirect(`https://github.com/login/oauth/authorize?${oauthParams.toString()}`);
});

// GET /api/auth/github/callback — handle OAuth callback
githubAuthRoutes.get('/callback', async (c): Promise<Response> => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const relayToken = c.req.query('relay_token');

  let userId: string;
  let targetOrigin: string | null = null;

  if (relayToken) {
    // --- Relay Flow: We are on the proxy domain, finishing auth via relay_token ---
    const payload = verifyJwt(relayToken, c.env.JWT_SIGNING_KEY);
    if (!payload || payload.type !== 'auth-relay' || !payload.sub) {
      return c.json({ error: 'invalid_relay_token' }, 401);
    }
    userId = payload.sub as string;
    targetOrigin = payload.origin as string ?? null;
  } else {
    // --- Standard Flow: Handling code/state from GitHub ---
    if (!code || !state) {
      return c.json({ error: 'missing_params' }, 400);
    }

    const statePayload = verifyJwt(state, c.env.JWT_SIGNING_KEY) as { nonce: string; origin?: string } | null;
    if (!statePayload) {
      return c.json({ error: 'invalid_state' }, 400);
    }

    targetOrigin = statePayload.origin ?? null;

    const actualOrigin = resolveCurrentOrigin(c);
    logger.info({ targetOrigin, actualOrigin }, 'oauth callback: origin detection');

    // Verify state JWT + cookie binding.
    // When the callback arrives on a proxy domain (cookie present), verify normally.
    // When the callback arrives on SERVER_URL (cross-domain), the cookie won't be here —
    // we skip cookie check and instead relay via relay_token after exchanging the code.
    const cookieState = getCookie(c, 'oauth_state');
    const isCrossDomain = targetOrigin && targetOrigin !== actualOrigin && allowedOrigins(c.env).has(targetOrigin);

    if (!isCrossDomain) {
      // Same-domain flow: verify cookie binding
      logger.info({ cookieState: !!cookieState, nonce: statePayload.nonce?.slice(0, 8) }, 'oauth callback: cookie check');
      if (!cookieState || statePayload.nonce !== cookieState) {
        logger.warn({ hasCookie: !!cookieState, targetOrigin, actualOrigin }, 'oauth callback: state_mismatch');
        return c.json({ error: 'state_mismatch' }, 400);
      }
      deleteCookie(c, 'oauth_state', { path: '/api/auth/github/callback' });
    } else {
      // Cross-domain: cookie lives on the proxy domain, not here. Skip cookie check.
      // We'll exchange the code here (where GitHub's redirect_uri points) and relay
      // with a signed relay_token to the proxy domain.
      logger.info({ targetOrigin }, 'oauth callback: cross-domain relay, skipping cookie check');
    }

    // Exchange code for GitHub access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: c.env.GITHUB_CLIENT_ID,
        client_secret: c.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    if (!tokenRes.ok) {
      return c.json({ error: 'token_exchange_failed' }, 502);
    }

    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
    if (!tokenData.access_token) {
      return c.json({ error: 'no_access_token' }, 502);
    }

    // Fetch GitHub user
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'User-Agent': 'imcodes',
        Accept: 'application/vnd.github+json',
      },
    });

    if (!userRes.ok) {
      return c.json({ error: 'github_user_fetch_failed' }, 502);
    }

    const githubUser = await userRes.json() as { id: number; login: string };

    // Find or create user
    let user = await getUserByPlatformId(c.env.DB, 'github', String(githubUser.id));
    if (!user) {
      user = await createUser(c.env.DB, randomHex(16));
      await upsertPlatformIdentity(c.env.DB, randomHex(16), user.id, 'github', String(githubUser.id));
    }
    userId = user.id;

    // Cross-domain relay: exchange is done, now relay with a signed token
    // so the proxy domain can set cookies without needing the oauth_state cookie.
    if (isCrossDomain) {
      const relay = signJwt(
        { sub: userId, type: 'auth-relay', origin: targetOrigin },
        c.env.JWT_SIGNING_KEY,
        120,
      );
      const relayUrl = new URL(`${targetOrigin}/api/auth/github/callback`);
      relayUrl.searchParams.set('relay_token', relay);
      logger.info({ relayUrl: relayUrl.toString() }, 'oauth callback: relaying to proxy domain with token');
      return c.redirect(relayUrl.toString());
    }
  }

  const isSecure = c.env.NODE_ENV === 'production';

  // Task 5: Issue 4-hour access token
  const accessToken = signJwt({ sub: userId, type: 'web' }, c.env.JWT_SIGNING_KEY, 4 * 3600);

  // Task 5: Issue refresh token and persist to DB
  const refreshRaw = randomHex(32);
  const refreshHash = sha256Hex(refreshRaw);
  const familyId = randomHex(16);
  const refreshId = randomHex(16);
  await c.env.DB.execute(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [refreshId, userId, refreshHash, familyId, Date.now() + 30 * 24 * 3600 * 1000, Date.now()],
  );

  // Task 1: Deliver tokens via HttpOnly cookies
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

  // Final redirect — must be an allowlisted origin to prevent open redirect
  const allowed = allowedOrigins(c.env);
  const safeTarget = (targetOrigin && allowed.has(targetOrigin)) ? targetOrigin : c.env.SERVER_URL;
  return c.redirect(safeTarget);
});
