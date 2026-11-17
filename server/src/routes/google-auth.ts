import { createPrimaryOAuthRoutes } from './oauth-primary.js';

export const googleAuthRoutes = createPrimaryOAuthRoutes({
  provider: 'google',
  callbackPath: '/api/auth/google/callback',
  buildAuthorizeUrl: ({ env, stateJwt, redirectUri, reauth }) => {
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID ?? '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: stateJwt,
    });
    if (reauth) {
      params.set('prompt', 'select_account');
    }
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  },
  exchangeCodeForPlatformUser: async ({ env, code, redirectUri }) => {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID ?? '',
        client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }).toString(),
    });
    if (!tokenRes.ok) {
      return { ok: false, status: 502, error: 'token_exchange_failed' };
    }

    const tokenData = await tokenRes.json() as { access_token?: string };
    if (!tokenData.access_token) {
      return { ok: false, status: 502, error: 'no_access_token' };
    }

    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });
    if (!userRes.ok) {
      return { ok: false, status: 502, error: 'google_user_fetch_failed' };
    }

    const googleUser = await userRes.json() as { id?: string; sub?: string };
    const gid = googleUser.id ?? googleUser.sub;
    if (!gid) {
      return { ok: false, status: 502, error: 'invalid_google_user' };
    }
    return { ok: true, platformUserId: String(gid) };
  },
});
