import { createPrimaryOAuthRoutes } from './oauth-primary.js';

export const githubAuthRoutes = createPrimaryOAuthRoutes({
  provider: 'github',
  callbackPath: '/api/auth/github/callback',
  buildAuthorizeUrl: ({ env, stateJwt, redirectUri, reauth }) => {
    const oauthParams = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID ?? '',
      redirect_uri: redirectUri,
      scope: 'read:user',
      state: stateJwt,
    });
    if (reauth) {
      const returnTo = `/login/oauth/authorize?${oauthParams.toString()}`;
      return `https://github.com/login?return_to=${encodeURIComponent(returnTo)}`;
    }
    return `https://github.com/login/oauth/authorize?${oauthParams.toString()}`;
  },
  exchangeCodeForPlatformUser: async ({ env, code }) => {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    if (!tokenRes.ok) {
      return { ok: false, status: 502, error: 'token_exchange_failed' };
    }

    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
    if (!tokenData.access_token) {
      return { ok: false, status: 502, error: 'no_access_token' };
    }

    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'User-Agent': 'imcodes',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!userRes.ok) {
      return { ok: false, status: 502, error: 'github_user_fetch_failed' };
    }

    const githubUser = await userRes.json() as { id?: number | string };
    if (githubUser.id === undefined || githubUser.id === null) {
      return { ok: false, status: 502, error: 'invalid_github_user' };
    }
    return { ok: true, platformUserId: String(githubUser.id) };
  },
});
