import { Hono } from 'hono';
import type { Env } from '../types.js';
import { createUser, getUserByPlatformId, upsertPlatformIdentity } from '../db/queries.js';
import { randomHex, signJwt, verifyJwt } from '../security/crypto.js';

export const githubAuthRoutes = new Hono<{ Bindings: Env }>();

// GET /api/auth/github — redirect to GitHub OAuth
// ?reauth=1 → forces GitHub login page (prevents auto-login after logout)
githubAuthRoutes.get('/', async (c): Promise<Response> => {
  const state = await signJwt({ nonce: randomHex(16) }, c.env.JWT_SIGNING_KEY, 600);
  const oauthParams = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    redirect_uri: `${c.env.WORKER_URL}/api/auth/github/callback`,
    scope: 'read:user',
    state,
  });

  if (c.req.query('reauth') === '1') {
    // Route through GitHub's login page — forces account selection / re-authentication
    const returnTo = `/login/oauth/authorize?${oauthParams.toString()}`;
    return c.redirect(`https://github.com/login?return_to=${encodeURIComponent(returnTo)}`);
  }

  return c.redirect(`https://github.com/login/oauth/authorize?${oauthParams.toString()}`);
});

// GET /api/auth/github/callback — handle OAuth callback
githubAuthRoutes.get('/callback', async (c): Promise<Response> => {
  const code = c.req.query('code');
  const state = c.req.query('state');

  if (!code || !state) {
    return c.json({ error: 'missing_params' }, 400);
  }

  // Verify state JWT
  const statePayload = await verifyJwt(state, c.env.JWT_SIGNING_KEY);
  if (!statePayload) {
    return c.json({ error: 'invalid_state' }, 400);
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

  // Issue a short-lived session JWT (24h)
  const sessionToken = await signJwt({ sub: user.id, type: 'web' }, c.env.JWT_SIGNING_KEY, 86400);

  const redirectUrl = new URL(c.env.WORKER_URL);
  redirectUrl.searchParams.set('token', sessionToken);
  redirectUrl.searchParams.set('userId', user.id);

  return c.redirect(redirectUrl.toString());
});
