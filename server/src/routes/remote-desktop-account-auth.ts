import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { z } from 'zod';
import type { Env } from '../env.js';
import {
  canCompleteStepUpChallenge,
  claimVerifiedNativeStepUpGrant,
  digestStepUpAction,
  exchangeNativeAuthorizationCode,
  finalizeStepUpChallenge,
  isAllowedNativeRedirect,
  loadStepUpChallenge,
  nativeShellIssuer,
  resolveBrowserAccountSession,
  resolveNativeShellSession,
  revokeNativeShellSession,
  revokeNativeShellSessionsForAccount,
  storeStepUpChallenge,
  validateStepUpDeadline,
  validateStepUpRequestId,
  verifyNativeStepUpChallenge,
  type AccountSession,
  type StepUpChallengeRow,
  issueNativeAuthorizationCode,
} from '../services/remote-desktop-account-auth.js';

type RouteEnv = { Bindings: Env };

export const remoteDesktopAccountAuthRoutes = new Hono<RouteEnv>();

remoteDesktopAccountAuthRoutes.use('/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
});

const nativeAuthorizeSchema = z.object({
  client_id: z.string(),
  redirect_uri: z.string(),
  code_challenge: z.string(),
  code_challenge_method: z.literal('S256'),
  state: z.string(),
});

const nativeExchangeSchema = z.object({
  code: z.string(),
  codeVerifier: z.string(),
  state: z.string(),
  clientId: z.string(),
  redirectUri: z.string(),
  issuer: z.string(),
  audience: z.string(),
});

const stepUpBeginSchema = z.object({
  canonicalHostId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  requestId: z.string(),
  deadline: z.number().int(),
  action: z.record(z.unknown()),
});

const stepUpCompleteSchema = z.object({
  challengeId: z.string().min(20).max(128),
  response: z.any(),
}).strict();

const nativeStepUpClaimSchema = z.object({
  challengeId: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

type StoredCredential = {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
};

function webAuthnRpInfo(c: Context<RouteEnv>): { rpId: string; origin: string } {
  const resolvedHost = (c.get('resolvedHost' as never) as string | null) ?? '';
  const scheme = c.env.NODE_ENV === 'production' ? 'https' : 'http';
  const host = resolvedHost || 'localhost';
  return {
    rpId: c.env.WEBAUTHN_RP_ID ?? host.split(':')[0],
    origin: `${scheme}://${host}`,
  };
}

async function browserSession(c: Context<RouteEnv>): Promise<AccountSession | null> {
  return resolveBrowserAccountSession(
    c.env.DB,
    c.env.JWT_SIGNING_KEY,
    c.req.header('cookie'),
  );
}

async function requestAccountSession(c: Context<RouteEnv>): Promise<AccountSession | null> {
  const issuer = nativeShellIssuer(c.env.SERVER_URL);
  const native = await resolveNativeShellSession(
    c.env.DB,
    c.req.header('authorization'),
    issuer,
  );
  if (native) return native;
  return browserSession(c);
}

async function listCredentials(c: Context<RouteEnv>, userId: string): Promise<Array<{
  id: string;
  type: 'public-key';
}>> {
  const credentials = await c.env.DB.query<{ id: string }>(
    'SELECT id FROM passkey_credentials WHERE user_id = $1',
    [userId],
  );
  return credentials.map(({ id }) => ({ id, type: 'public-key' as const }));
}

async function authenticationOptions(
  c: Context<RouteEnv>,
  challenge: string | undefined,
  userId: string,
  rpId: string,
) {
  return generateAuthenticationOptions({
    rpID: rpId,
    ...(challenge ? { challenge } : {}),
    allowCredentials: await listCredentials(c, userId),
    userVerification: 'required',
  });
}

remoteDesktopAccountAuthRoutes.get('/native/authorize', async (c) => {
  const parsed = nativeAuthorizeSchema.safeParse(c.req.query());
  if (!parsed.success
    || !isAllowedNativeRedirect(parsed.data.client_id, parsed.data.redirect_uri)) {
    return c.json({ error: 'invalid_authorization_request' }, 400);
  }
  const accountSession = await browserSession(c);
  if (!accountSession) return c.json({ error: 'account_authentication_required' }, 401);

  try {
    const issued = await issueNativeAuthorizationCode(c.env.DB, {
      accountSession,
      clientId: parsed.data.client_id,
      redirectUri: parsed.data.redirect_uri,
      codeChallenge: parsed.data.code_challenge,
      state: parsed.data.state,
      issuer: nativeShellIssuer(c.env.SERVER_URL),
    });
    const redirect = new URL(parsed.data.redirect_uri);
    redirect.searchParams.set('code', issued.code);
    redirect.searchParams.set('state', parsed.data.state);
    return c.redirect(redirect.toString(), 302);
  } catch {
    return c.json({ error: 'invalid_authorization_request' }, 400);
  }
});

remoteDesktopAccountAuthRoutes.post('/native/exchange', async (c) => {
  const parsed = nativeExchangeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_code' }, 400);
  const exchanged = await exchangeNativeAuthorizationCode(c.env.DB, parsed.data);
  if (!exchanged) return c.json({ error: 'invalid_code' }, 400);
  return c.json({
    accessToken: exchanged.accessToken,
    tokenType: 'Bearer',
    sessionId: exchanged.sessionId,
    userId: exchanged.userId,
    expiresAt: exchanged.expiresAt,
    clientId: exchanged.clientId,
    issuer: exchanged.issuer,
    audience: exchanged.audience,
  });
});

remoteDesktopAccountAuthRoutes.post('/native/session/revoke', async (c) => {
  const session = await resolveNativeShellSession(
    c.env.DB,
    c.req.header('authorization'),
    nativeShellIssuer(c.env.SERVER_URL),
  );
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  await revokeNativeShellSession(c.env.DB, session);
  return c.json({ ok: true });
});

remoteDesktopAccountAuthRoutes.post('/native/sessions/revoke', async (c) => {
  const session = await browserSession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  const revoked = await revokeNativeShellSessionsForAccount(c.env.DB, session);
  return c.json({ ok: true, revoked });
});

remoteDesktopAccountAuthRoutes.post('/step-up/begin', async (c) => {
  const session = await requestAccountSession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  const parsed = stepUpBeginSchema.safeParse(await c.req.json().catch(() => null));
  const now = Date.now();
  if (!parsed.success
    || !validateStepUpRequestId(parsed.data.requestId)
    || !validateStepUpDeadline(parsed.data.deadline, now)) {
    return c.json({ error: 'invalid_step_up_request' }, 400);
  }

  const allowCredentials = await listCredentials(c, session.userId);
  if (allowCredentials.length === 0) return c.json({ error: 'passkey_required' }, 400);
  const { rpId, origin } = webAuthnRpInfo(c);
  let actionDigest: string;
  try {
    actionDigest = digestStepUpAction(parsed.data.action);
  } catch {
    return c.json({ error: 'invalid_step_up_request' }, 400);
  }
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials,
    userVerification: 'required',
  });
  const stored = await storeStepUpChallenge(c.env.DB, {
    accountSession: session,
    canonicalHostId: parsed.data.canonicalHostId,
    actionDigest,
    requestId: parsed.data.requestId,
    challenge: options.challenge,
    rpId,
    origin,
    deadline: parsed.data.deadline,
  }, now);
  return c.json({
    ...options,
    challengeId: stored.challengeId,
    actionDigest,
    deadline: parsed.data.deadline,
  });
});

remoteDesktopAccountAuthRoutes.get('/step-up/:challengeId/options', async (c) => {
  const challenge = await loadStepUpChallenge(c.env.DB, c.req.param('challengeId'));
  const session = await browserSession(c);
  if (!challenge || !session || !canCompleteStepUpChallenge(challenge, session)) {
    return c.json({ error: 'invalid_step_up_challenge' }, 400);
  }
  const options = await authenticationOptions(c, challenge.challenge, challenge.user_id, challenge.rp_id);
  return c.json({ ...options, challengeId: challenge.id, deadline: challenge.deadline });
});

remoteDesktopAccountAuthRoutes.post('/step-up/complete', async (c) => {
  const parsed = stepUpCompleteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_step_up_challenge' }, 400);
  const challenge = await loadStepUpChallenge(c.env.DB, parsed.data.challengeId);
  const completingSession = await browserSession(c);
  if (!challenge || challenge.account_session_kind !== 'web' || !completingSession
    || !canCompleteStepUpChallenge(challenge, completingSession)) {
    return c.json({ error: 'invalid_step_up_challenge' }, 400);
  }

  const response = parsed.data.response as { id?: unknown };
  if (typeof response.id !== 'string') return c.json({ error: 'verification_failed' }, 400);
  const credential = await c.env.DB.queryOne<StoredCredential>(
    `SELECT id, user_id, public_key, counter, transports
       FROM passkey_credentials
      WHERE id = $1 AND user_id = $2`,
    [response.id, challenge.user_id],
  );
  if (!credential) return c.json({ error: 'verification_failed' }, 400);

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: parsed.data.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rp_id,
      authenticator: {
        credentialID: credential.id,
        credentialPublicKey: Uint8Array.from(Buffer.from(credential.public_key, 'base64')),
        counter: credential.counter,
        transports: credential.transports ? JSON.parse(credential.transports) : undefined,
      },
      requireUserVerification: true,
      advancedFIDOConfig: { userVerification: 'required' },
    });
  } catch {
    return c.json({ error: 'verification_failed' }, 400);
  }
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    return c.json({ error: 'verification_failed' }, 400);
  }

  const grant = await finalizeStepUpChallenge(c.env.DB, {
    challenge: challenge as StepUpChallengeRow,
    completingSession,
    credentialId: credential.id,
    expectedCounter: credential.counter,
    newCounter: verification.authenticationInfo.newCounter,
    userVerified: verification.authenticationInfo.userVerified,
  }).catch(() => null);
  if (!grant) return c.json({ error: 'invalid_step_up_challenge' }, 400);
  return c.json(grant);
});

remoteDesktopAccountAuthRoutes.post('/step-up/complete-native', async (c) => {
  const parsed = stepUpCompleteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_step_up_challenge' }, 400);
  const challenge = await loadStepUpChallenge(c.env.DB, parsed.data.challengeId);
  const completingSession = await browserSession(c);
  if (!challenge || challenge.account_session_kind !== 'native' || !completingSession
    || !canCompleteStepUpChallenge(challenge, completingSession)) {
    return c.json({ error: 'invalid_step_up_challenge' }, 400);
  }

  const response = parsed.data.response as { id?: unknown };
  if (typeof response.id !== 'string') return c.json({ error: 'verification_failed' }, 400);
  const credential = await c.env.DB.queryOne<StoredCredential>(
    `SELECT id, user_id, public_key, counter, transports
       FROM passkey_credentials
      WHERE id = $1 AND user_id = $2`,
    [response.id, challenge.user_id],
  );
  if (!credential) return c.json({ error: 'verification_failed' }, 400);

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: parsed.data.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rp_id,
      authenticator: {
        credentialID: credential.id,
        credentialPublicKey: Uint8Array.from(Buffer.from(credential.public_key, 'base64')),
        counter: credential.counter,
        transports: credential.transports ? JSON.parse(credential.transports) : undefined,
      },
      requireUserVerification: true,
      advancedFIDOConfig: { userVerification: 'required' },
    });
  } catch {
    return c.json({ error: 'verification_failed' }, 400);
  }
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    return c.json({ error: 'verification_failed' }, 400);
  }
  const verified = await verifyNativeStepUpChallenge(c.env.DB, {
    challenge: challenge as StepUpChallengeRow,
    completingSession,
    credentialId: credential.id,
    expectedCounter: credential.counter,
    newCounter: verification.authenticationInfo.newCounter,
    userVerified: verification.authenticationInfo.userVerified,
  }).catch(() => null);
  if (!verified) return c.json({ error: 'invalid_step_up_challenge' }, 400);
  // Fixed content-free completion: the browser never receives the native
  // action grant. The initiating native bearer claims it over TLS below.
  return c.json({ status: 'verified' as const });
});

remoteDesktopAccountAuthRoutes.post('/step-up/native/claim', async (c) => {
  const accountSession = await resolveNativeShellSession(
    c.env.DB,
    c.req.header('authorization'),
    nativeShellIssuer(c.env.SERVER_URL),
  );
  const parsed = nativeStepUpClaimSchema.safeParse(await c.req.json().catch(() => null));
  if (!accountSession || !parsed.success) {
    return c.json({ error: 'invalid_step_up_challenge' }, 400);
  }
  const grant = await claimVerifiedNativeStepUpGrant(c.env.DB, {
    accountSession,
    challengeId: parsed.data.challengeId,
  }).catch(() => null);
  if (!grant) return c.json({ error: 'step_up_pending' }, 409);
  return c.json(grant);
});
