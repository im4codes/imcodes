import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { Env } from '../env.js';
import { createUser, getUserById, getUserByUsername } from '../db/queries.js';
import { randomHex, sha256Hex, signJwt, verifyJwt, hashPassword } from '../security/crypto.js';
import { COOKIE_SESSION } from '../../../shared/cookie-names.js';
import { issueAuthNonce, logAuthAudit, scheduleAuthNonceCleanup } from './auth.js';
import { z } from 'zod';
import logger from '../util/logger.js';

type HonoEnv = { Bindings: Env };

export const passkeyRoutes = new Hono<HonoEnv>();

// Cache-Control: no-store on all passkey endpoints
passkeyRoutes.use('/*', async (c, next) => {
  scheduleAuthNonceCleanup(c.env.DB);
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
});

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Derive rpId and expectedOrigin from the actual request host.
 * WebAuthn rpId MUST match the domain the user is actually on — SERVER_URL is
 * irrelevant here (it's for webhooks/callbacks, not for WebAuthn).
 */
function getRpInfo(c: Context<HonoEnv>): { rpId: string; origin: string } {
  const resolvedHost = (c.get('resolvedHost' as never) as string | null) ?? '';
  const isSecure = c.env.NODE_ENV === 'production';
  const scheme = isSecure ? 'https' : 'http';
  const host = resolvedHost || 'localhost';
  // WEBAUTHN_RP_ID lets multiple subdomains share passkeys (e.g. im.codes for
  // both app.im.codes and hk.im.codes). Must be a suffix of the visiting origin.
  const rpId = c.env.WEBAUTHN_RP_ID ?? host.split(':')[0];
  return { rpId, origin: `${scheme}://${host}` };
}

async function resolveAuthedUserId(c: Context<HonoEnv>): Promise<string | null> {
  // Try rcc_session cookie first (browser)
  const cookieHeader = c.req.header('cookie') ?? '';
  const cookieMatch = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_SESSION}=([^;]+)`));
  const cookieToken = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
  if (cookieToken && c.env.JWT_SIGNING_KEY) {
    const jwt = verifyJwt(cookieToken, c.env.JWT_SIGNING_KEY);
    if (jwt && typeof jwt.sub === 'string' && jwt.type !== 'ws-ticket') {
      const user = await getUserById(c.env.DB, jwt.sub);
      if (user) return user.id;
    }
  }

  // Try Bearer token (native app API key / CLI)
  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer ')) {
    const bearerToken = auth.slice(7);
    const jwt = verifyJwt(bearerToken, c.env.JWT_SIGNING_KEY);
    if (jwt && typeof jwt.sub === 'string' && jwt.type !== 'ws-ticket') {
      const user = await getUserById(c.env.DB, jwt.sub);
      if (user) return user.id;
    }
    const keyHash = sha256Hex(bearerToken);
    const row = await c.env.DB.queryOne<{ user_id: string }>(
      'SELECT user_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL', [keyHash],
    );
    if (row) return row.user_id;
  }

  return null;
}

function setSessionCookies(c: Context<HonoEnv>, accessToken: string, refreshToken: string): void {
  const isSecure = c.env.NODE_ENV === 'production';
  setCookie(c, COOKIE_SESSION, accessToken, { httpOnly: true, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 4 * 3600 });
  setCookie(c, 'rcc_refresh', refreshToken, { httpOnly: true, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 30 * 86400 });
  setCookie(c, 'rcc_csrf', randomHex(32), { httpOnly: false, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 30 * 86400 });
}

async function storeRefreshToken(db: Env['DB'], userId: string, refreshHash: string): Promise<void> {
  const now = Date.now();
  await db.execute(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomHex(16), userId, refreshHash, randomHex(16), now + 30 * 24 * 3600 * 1000, now],
  );
}

/**
 * Return an HTML page that redirects to a custom URL scheme.
 * ASWebAuthenticationSession reliably detects page-level navigations
 * but may not follow HTTP 302 redirects to non-HTTP schemes.
 */
function nativeRedirectPage(c: Context<HonoEnv>, url: string): Response {
  const html = `<!DOCTYPE html><html><head>
<meta http-equiv="refresh" content="0;url=${url.replace(/"/g, '&quot;')}">
</head><body>
<script>window.location.href=${JSON.stringify(url)};</script>
</body></html>`;
  return c.html(html);
}

/**
 * Parse request body as JSON or form-encoded (for native form submissions).
 * Form submissions send a hidden field "json" containing the JSON payload.
 */
async function parseBody(c: Context<HonoEnv>): Promise<unknown> {
  const ct = c.req.header('content-type') ?? '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    const formData = await c.req.parseBody();
    const raw = typeof formData.json === 'string' ? formData.json : null;
    if (raw) {
      try { return JSON.parse(raw); } catch { return null; }
    }
    return null;
  }
  return c.req.json().catch(() => null);
}

// ── DB-backed challenge store (multi-instance safe) ───────────────────────

interface PendingChallenge {
  challenge: string;
  userId: string | null;
  displayName: string;
}

interface StoredPasskeyCredential {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
}

async function saveChallenge(
  db: Env['DB'],
  id: string,
  challenge: string,
  userId: string | null,
  displayName: string,
): Promise<void> {
  const now = Date.now();
  await db.execute(
    'INSERT INTO passkey_challenges (id, challenge, user_id, display_name, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, challenge, userId, displayName, now + 5 * 60 * 1000, now],
  );
  // Clean up expired challenges opportunistically
  await db.execute('DELETE FROM passkey_challenges WHERE expires_at < $1', [now]);
}

async function getChallenge(db: Env['DB'], id: string): Promise<PendingChallenge | null> {
  const row = await db.queryOne<{ challenge: string; user_id: string | null; display_name: string }>(
    'SELECT challenge, user_id, display_name FROM passkey_challenges WHERE id = $1 AND expires_at > $2',
    [id, Date.now()],
  );
  if (!row) return null;
  return { challenge: row.challenge, userId: row.user_id, displayName: row.display_name };
}

async function consumeChallenge(db: Env['DB'], id: string): Promise<PendingChallenge | null> {
  const row = await getChallenge(db, id);
  if (!row) return null;
  await db.execute('DELETE FROM passkey_challenges WHERE id = $1', [id]);
  return row;
}

async function listUserCredentialIds(db: Env['DB'], userId: string): Promise<Array<{ id: string; type: 'public-key' }>> {
  const rows = await db.query<{ id: string }>(
    'SELECT id FROM passkey_credentials WHERE user_id = $1', [userId],
  );
  return rows.map((r) => ({ id: r.id, type: 'public-key' as const }));
}

async function getStoredPasskeyCredential(db: Env['DB'], credentialId: string): Promise<StoredPasskeyCredential | null> {
  return db.queryOne<StoredPasskeyCredential>(
    'SELECT id, user_id, public_key, counter, transports FROM passkey_credentials WHERE id = $1',
    [credentialId],
  );
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === '23505';
}

async function issueNativeAuthRedirect(
  c: Context<HonoEnv>,
  userId: string,
  callbackUrl: string,
  options: {
    keyLabel: string;
    includeLegacyParams?: boolean;
    extraParams?: Record<string, string>;
  },
): Promise<Response> {
  const keyId = randomHex(16);
  const rawKey = `deck_${randomHex(32)}`;
  const keyHash = sha256Hex(rawKey);
  const now = Date.now();
  await c.env.DB.execute(
    'INSERT INTO api_keys (id, user_id, key_hash, label, created_at) VALUES ($1, $2, $3, $4, $5)',
    [keyId, userId, keyHash, options.keyLabel, now],
  );

  const nonce = await issueAuthNonce(c.env.DB, { apiKey: rawKey, userId, keyId });
  const cbUrl = new URL(callbackUrl);
  cbUrl.searchParams.set('nonce', nonce);
  if (options.includeLegacyParams !== false) {
    cbUrl.searchParams.set('key', rawKey);
    cbUrl.searchParams.set('userId', userId);
    cbUrl.searchParams.set('keyId', keyId);
  }
  for (const [key, value] of Object.entries(options.extraParams ?? {})) {
    cbUrl.searchParams.set(key, value);
  }
  return nativeRedirectPage(c, cbUrl.toString());
}

// ── POST /api/auth/passkey/register/begin ─────────────────────────────────
const registerBeginSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
});

passkeyRoutes.post('/register/begin', async (c) => {
  const existingUserId = await resolveAuthedUserId(c);

  // Check if registration is enabled (skip for existing users adding a new passkey)
  if (!existingUserId) {
    const { getSetting } = await import('../db/queries.js');
    const regEnabled = await getSetting(c.env.DB, 'registration_enabled');
    if (regEnabled === 'false') {
      return c.json({ error: 'registration_disabled' }, 403);
    }
  }
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const parsed = registerBeginSchema.safeParse(body);
  let displayName = parsed.data?.displayName;
  let existingUser = null as Awaited<ReturnType<typeof getUserById>> | null;

  if (existingUserId) {
    existingUser = await getUserById(c.env.DB, existingUserId);
    if (!existingUser) return c.json({ error: 'user_not_found' }, 404);
    if (existingUser.status !== 'active') {
      return c.json({ error: existingUser.status === 'pending' ? 'account_pending' : 'account_disabled' }, 403);
    }
  }

  // For existing users adding a new passkey, look up their display_name from DB
  if (!displayName && existingUser) {
    displayName = existingUser.display_name || undefined;
  }
  displayName = displayName || 'IM.codes User';

  const { rpId } = getRpInfo(c);

  // Exclude already-registered credentials for this user
  const excludeCredentials = existingUserId
    ? await listUserCredentialIds(c.env.DB, existingUserId)
    : [];

  const userIdBytes = existingUserId
    ? Buffer.from(existingUserId, 'hex')
    : Buffer.from(randomHex(16), 'hex');

  const options = await generateRegistrationOptions({
    rpName: 'IM.codes',
    rpID: rpId,
    userID: userIdBytes,
    userName: displayName,
    userDisplayName: displayName,
    attestationType: 'none',
    excludeCredentials,
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  const challengeId = randomHex(16);
  await saveChallenge(c.env.DB, challengeId, options.challenge, existingUserId, displayName);

  return c.json({ ...options, challengeId });
});

// ── POST /api/auth/passkey/verify/begin ───────────────────────────────────
passkeyRoutes.post('/verify/begin', async (c) => {
  const userId = await resolveAuthedUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const user = await getUserById(c.env.DB, userId);
  if (!user) return c.json({ error: 'user_not_found' }, 404);
  if (user.status !== 'active') {
    return c.json({ error: user.status === 'pending' ? 'account_pending' : 'account_disabled' }, 403);
  }

  const allowCredentials = await listUserCredentialIds(c.env.DB, userId);
  if (allowCredentials.length === 0) return c.json({ error: 'no_passkeys' }, 400);

  const { rpId } = getRpInfo(c);
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    userVerification: 'preferred',
    allowCredentials,
  });

  const challengeId = randomHex(16);
  await saveChallenge(c.env.DB, challengeId, options.challenge, userId, '');
  return c.json({ ...options, challengeId });
});

// ── POST /api/auth/passkey/register/complete ──────────────────────────────
const registerCompleteSchema = z.object({
  challengeId: z.string(),
  response: z.any(),
  deviceName: z.string().max(100).optional(),
});

passkeyRoutes.post('/register/complete', async (c) => {
  const body = await parseBody(c);
  const parsed = registerCompleteSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { challengeId, response, deviceName } = parsed.data;
  const pending = await consumeChallenge(c.env.DB, challengeId);
  if (!pending) return c.json({ error: 'challenge_expired' }, 400);

  const { rpId, origin } = getRpInfo(c);
  logger.info({ rpId, origin }, '[passkey] register/complete verification');

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
    });
  } catch (err) {
    logger.warn({ err, rpId, origin }, '[passkey] registration verification failed');
    return c.json({ error: 'verification_failed' }, 400);
  }

  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: 'verification_failed' }, 400);
  }

  const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;

  const existing = await c.env.DB.queryOne<{ id: string }>(
    'SELECT id FROM passkey_credentials WHERE id = $1', [credentialID],
  );
  if (existing) return c.json({ error: 'credential_already_registered' }, 409);

  let userId = pending.userId;
  if (!userId) {
    userId = randomHex(16);
    await createUser(c.env.DB, userId);
    // Save the display name from registration to the user record
    if (pending.displayName && pending.displayName !== 'IM.codes User') {
      await c.env.DB.execute('UPDATE users SET display_name = $1 WHERE id = $2', [pending.displayName, userId]);
    }
    // Check if new registrations require admin approval
    const { getSetting, updateUserStatus } = await import('../db/queries.js');
    const requireApproval = await getSetting(c.env.DB, 'require_approval');
    if (requireApproval === 'true') {
      await updateUserStatus(c.env.DB, userId, 'pending');
    }
  } else {
    const user = await getUserById(c.env.DB, userId);
    if (!user) return c.json({ error: 'user_not_found' }, 404);
    if (user.status !== 'active') {
      return c.json({ error: user.status === 'pending' ? 'account_pending' : 'account_disabled' }, 403);
    }
  }

  const now = Date.now();
  await c.env.DB.execute(
    'INSERT INTO passkey_credentials (id, user_id, public_key, counter, device_name, transports, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [credentialID, userId, Buffer.from(credentialPublicKey).toString('base64'), counter, deviceName ?? null, null, now],
  );

  const ip = (c.get('clientIp' as never) as string | undefined) ?? 'unknown';
  await logAuthAudit(c, {
    userId,
    action: 'auth.passkey.register',
    ip,
    details: { credentialId: credentialID },
  }, c.env.DB);

  // Native callback: issue API key + redirect (skip the second login round-trip)
  const nativeCallback = c.req.query('native_callback');
  if (nativeCallback && nativeCallback.startsWith('imcodes://')) {
    return issueNativeAuthRedirect(c, userId, nativeCallback, { keyLabel: 'mobile-app' });
  }

  const accessToken = signJwt({ sub: userId }, c.env.JWT_SIGNING_KEY, 4 * 3600);
  const refreshToken = randomHex(32);
  await storeRefreshToken(c.env.DB, userId, sha256Hex(refreshToken));
  setSessionCookies(c, accessToken, refreshToken);

  return c.json({ ok: true, userId });
});

// ── POST /api/auth/passkey/login/begin ────────────────────────────────────
passkeyRoutes.post('/login/begin', async (c) => {
  const { rpId } = getRpInfo(c);

  const options = await generateAuthenticationOptions({
    rpID: rpId,
    userVerification: 'preferred',
  });

  const challengeId = randomHex(16);
  await saveChallenge(c.env.DB, challengeId, options.challenge, null, '');

  return c.json({ ...options, challengeId });
});

// ── POST /api/auth/passkey/login/complete ─────────────────────────────────
const loginCompleteSchema = z.object({
  challengeId: z.string(),
  response: z.any(),
});

passkeyRoutes.post('/login/complete', async (c) => {
  const body = await parseBody(c);
  const parsed = loginCompleteSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { challengeId, response } = parsed.data;
  const pending = await consumeChallenge(c.env.DB, challengeId);
  if (!pending) return c.json({ error: 'challenge_expired' }, 400);

  const { rpId, origin } = getRpInfo(c);
  logger.info({ rpId, origin }, '[passkey] login/complete verification');

  const credentialId = response.id as string;
  const storedCred = await getStoredPasskeyCredential(c.env.DB, credentialId);

  if (!storedCred) return c.json({ error: 'wrong_passkey' }, 403);

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      authenticator: {
        credentialID: storedCred.id,
        credentialPublicKey: Uint8Array.from(Buffer.from(storedCred.public_key, 'base64')),
        counter: storedCred.counter,
        transports: storedCred.transports ? JSON.parse(storedCred.transports) : undefined,
      },
    });
  } catch (err) {
    logger.warn({ err, rpId, origin }, '[passkey] authentication verification failed');
    return c.json({ error: 'verification_failed' }, 400);
  }

  if (!verification.verified) {
    return c.json({ error: 'verification_failed' }, 400);
  }

  const user = await getUserById(c.env.DB, storedCred.user_id);
  if (!user) return c.json({ error: 'user_not_found' }, 400);

  // Reject disabled/pending users
  if (user.status !== 'active') {
    return c.json({ error: user.status === 'pending' ? 'account_pending' : 'account_disabled' }, 403);
  }

  const now = Date.now();
  await c.env.DB.execute(
    'UPDATE passkey_credentials SET counter = $1, last_used_at = $2 WHERE id = $3',
    [verification.authenticationInfo.newCounter, now, storedCred.id],
  );

  const ip = (c.get('clientIp' as never) as string | undefined) ?? 'unknown';
  await logAuthAudit(c, {
    userId: user.id,
    action: 'auth.passkey.login',
    ip,
    details: { credentialId: storedCred.id },
  }, c.env.DB);

  const isNativeReq = c.req.query('native') === '1';

  const nativeCallback = c.req.query('native_callback');
  if (isNativeReq || nativeCallback) {
    // Native app: return a persistent API key instead of setting session cookies.
    // The client stores this key in biometric-protected storage.
    if (nativeCallback && nativeCallback.startsWith('imcodes://')) {
      // If native_callback is provided, redirect via HTTP 302 so ASWebAuthenticationSession
      // detects the custom-scheme navigation (JS window.location.href is unreliable).
      return issueNativeAuthRedirect(c, user.id, nativeCallback, { keyLabel: 'mobile-app' });
    }

    const rawKey = `deck_${randomHex(32)}`;
    const keyHash = sha256Hex(rawKey);
    const keyId = randomHex(16);
    const now = Date.now();
    await c.env.DB.execute(
      'INSERT INTO api_keys (id, user_id, key_hash, label, created_at) VALUES ($1, $2, $3, $4, $5)',
      [keyId, user.id, keyHash, 'mobile-app', now],
    );

    const nonce = await issueAuthNonce(c.env.DB, { apiKey: rawKey, userId: user.id, keyId });
    return c.json({ ok: true, userId: user.id, nonce });
  }

  const accessToken = signJwt({ sub: user.id }, c.env.JWT_SIGNING_KEY, 4 * 3600);
  const refreshToken = randomHex(32);
  await storeRefreshToken(c.env.DB, user.id, sha256Hex(refreshToken));
  setSessionCookies(c, accessToken, refreshToken);

  return c.json({ ok: true });
});

// ── POST /api/auth/password/setup ─────────────────────────────────────────
const passwordSetupSchema = z.object({
  username: z.string().min(3).max(32),
  newPassword: z.string().min(8),
  challengeId: z.string(),
  response: z.any(),
});

passkeyRoutes.post('/password/setup', async (c) => {
  const userId = await resolveAuthedUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const body = await parseBody(c);
  const parsed = passwordSetupSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { username, newPassword, challengeId, response } = parsed.data;

  // Validate password complexity
  const { validatePasswordComplexity } = await import('../../../shared/password-rules.js');
  const complexity = validatePasswordComplexity(newPassword);
  if (!complexity.valid) {
    return c.json({ error: complexity.errorKey }, 400);
  }

  const user = await getUserById(c.env.DB, userId);
  if (!user) return c.json({ error: 'user_not_found' }, 404);
  if (user.status !== 'active') {
    return c.json({ error: user.status === 'pending' ? 'account_pending' : 'account_disabled' }, 403);
  }
  if (user.password_hash) return c.json({ error: 'password_already_set' }, 400);

  const normalizedUsername = username.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/.test(normalizedUsername)) {
    return c.json({ error: 'invalid_username_format' }, 400);
  }

  const existingUser = await getUserByUsername(c.env.DB, normalizedUsername);
  if (existingUser && existingUser.id !== userId) {
    return c.json({ error: 'username_taken' }, 409);
  }

  const pending = await getChallenge(c.env.DB, challengeId);
  if (!pending) return c.json({ error: 'challenge_expired' }, 400);
  if (pending.userId !== userId) return c.json({ error: 'challenge_user_mismatch' }, 403);

  const credentialId = response.id as string;
  const storedCred = await getStoredPasskeyCredential(c.env.DB, credentialId);
  if (!storedCred) return c.json({ error: 'wrong_passkey' }, 403);
  if (storedCred.user_id !== userId) return c.json({ error: 'wrong_passkey' }, 403);

  const { rpId, origin } = getRpInfo(c);

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      authenticator: {
        credentialID: storedCred.id,
        credentialPublicKey: Uint8Array.from(Buffer.from(storedCred.public_key, 'base64')),
        counter: storedCred.counter,
        transports: storedCred.transports ? JSON.parse(storedCred.transports) : undefined,
      },
    });
  } catch (err) {
    logger.warn({ err, rpId, origin }, '[passkey] password setup verification failed');
    return c.json({ error: 'verification_failed' }, 400);
  }

  if (!verification.verified) {
    return c.json({ error: 'verification_failed' }, 400);
  }

  const newHash = await hashPassword(newPassword);
  const now = Date.now();
  try {
    await c.env.DB.transaction(async (tx) => {
      const deleted = await tx.execute(
        'DELETE FROM passkey_challenges WHERE id = $1 AND expires_at > $2 AND user_id = $3',
        [challengeId, Date.now(), userId],
      );
      if (deleted.changes === 0) throw new Error('challenge_expired');
      await tx.execute(
        'UPDATE passkey_credentials SET counter = $1, last_used_at = $2 WHERE id = $3',
        [verification.authenticationInfo.newCounter, now, storedCred.id],
      );
      await tx.execute(
        'UPDATE users SET username = $1, password_hash = $2, password_must_change = false WHERE id = $3',
        [normalizedUsername, newHash, userId],
      );
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'challenge_expired') {
      return c.json({ error: 'challenge_expired' }, 400);
    }
    if (isUniqueViolation(err)) {
      return c.json({ error: 'username_taken' }, 409);
    }
    throw err;
  }

  const ip = (c.get('clientIp' as never) as string | undefined) ?? 'unknown';
  await logAuthAudit(c, {
    userId,
    action: 'auth.password_setup_with_passkey',
    ip,
    details: { credentialId: storedCred.id },
  }, c.env.DB);

  const nativeCallback = c.req.query('native_callback');
  if (nativeCallback && nativeCallback.startsWith('imcodes://')) {
    return issueNativeAuthRedirect(c, userId, nativeCallback, {
      keyLabel: 'mobile-password-setup',
      includeLegacyParams: false,
      extraParams: {
        ok: '1',
        username: normalizedUsername,
      },
    });
  }

  return c.json({
    ok: true,
    user: {
      id: user.id,
      username: normalizedUsername,
      display_name: user.display_name,
      is_admin: user.is_admin,
      status: user.status,
      has_password: true,
    },
  });
});

// ── GET /api/auth/passkey/credentials ─────────────────────────────────────
passkeyRoutes.get('/credentials', async (c) => {
  const userId = await resolveAuthedUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const user = await getUserById(c.env.DB, userId);
  if (!user) return c.json({ error: 'user_not_found' }, 404);
  if (user.status !== 'active') {
    return c.json({ error: user.status === 'pending' ? 'account_pending' : 'account_disabled' }, 403);
  }

  const rows = await c.env.DB.query<{ id: string; device_name: string | null; created_at: number; last_used_at: number | null }>(
    'SELECT id, device_name, created_at, last_used_at FROM passkey_credentials WHERE user_id = $1 ORDER BY created_at DESC',
    [userId],
  );

  return c.json({
    credentials: rows.map((r) => ({
      id: r.id,
      deviceName: r.device_name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    })),
  });
});

// ── GET /api/auth/passkey/native ───────────────────────────────────────────
// Lightweight self-contained HTML page for native iOS passkey auth.
// Replaces loading the full SPA bundle in ASWebAuthenticationSession.
passkeyRoutes.get('/native', async (c) => {
  const callback = c.req.query('callback');
  const action = c.req.query('action') === 'register' ? 'register' : 'login';

  if (!callback || !callback.startsWith('imcodes://')) {
    return c.text('Invalid callback URL', 400);
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IM.codes Auth</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#111;color:#e0e0e0;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.c{text-align:center;max-width:320px}
.s{font-size:16px;margin-top:12px;color:#aaa}
.e{color:#f44;margin-top:12px;font-size:14px;word-break:break-word}
.r{margin-top:16px;padding:10px 24px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer;display:none}
.spinner{width:32px;height:32px;border:3px solid #333;border-top-color:#2563eb;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
<div class="c">
<div class="spinner" id="sp"></div>
<div class="s" id="st">Authenticating\u2026</div>
<div class="e" id="er"></div>
<button class="r" id="rt" onclick="run()">Retry</button>
</div>
<script>
var CB=${JSON.stringify(callback)};
var ACTION=${JSON.stringify(action)};
function gc(n){var m=document.cookie.match(new RegExp('(?:^|;\\\\s*)'+n+'=([^;]+)'));return m?decodeURIComponent(m[1]):'';}
function $(i){return document.getElementById(i);}
function err(m){$('sp').style.display='none';$('er').textContent=m;$('rt').style.display='inline-block';$('st').textContent='Authentication failed';}
async function run(){
$('sp').style.display='block';$('er').textContent='';$('rt').style.display='none';$('st').textContent='Authenticating\\u2026';
try{
var csrf=gc('rcc_csrf');
var h={'Content-Type':'application/json'};
if(csrf)h['X-CSRF-Token']=csrf;
var beginUrl=ACTION==='register'?'/api/auth/passkey/register/begin':'/api/auth/passkey/login/begin';
var r=await fetch(beginUrl,{method:'POST',headers:h,credentials:'include',body:ACTION==='register'?'{"displayName":"Mobile User"}':'{}'});
if(!r.ok){err('Server error: '+r.status);return;}
var opts=await r.json();
var cid=opts.challengeId;delete opts.challengeId;
var cred;
if(ACTION==='register'){
opts.user.id=base64ToBuffer(opts.user.id);
opts.challenge=base64ToBuffer(opts.challenge);
if(opts.excludeCredentials)opts.excludeCredentials.forEach(function(c){c.id=base64ToBuffer(c.id);});
cred=await navigator.credentials.create({publicKey:opts});
}else{
opts.challenge=base64ToBuffer(opts.challenge);
if(opts.allowCredentials)opts.allowCredentials.forEach(function(c){c.id=base64ToBuffer(c.id);});
cred=await navigator.credentials.get({publicKey:opts});
}
var cbEnc=encodeURIComponent(CB);
var completeUrl=(ACTION==='register'?'/api/auth/passkey/register/complete':'/api/auth/passkey/login/complete')+'?native=1&native_callback='+cbEnc;
var payload=JSON.stringify({challengeId:cid,response:credToJSON(cred)});
$('st').textContent='Verifying\\u2026';
var f=document.createElement('form');f.method='POST';f.action=completeUrl;
var inp=document.createElement('input');inp.type='hidden';inp.name='json';inp.value=payload;
f.appendChild(inp);document.body.appendChild(f);f.submit();
}catch(e){
var m=e.message||String(e);
if(m.includes('NotAllowedError')||m.toLowerCase().includes('cancel')){$('sp').style.display='none';$('st').textContent='Cancelled';$('rt').style.display='inline-block';}
else err(m);
}}
function base64ToBuffer(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var b=atob(s),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a.buffer;}
function bufferToBase64(b){var a=new Uint8Array(b),s='';for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}
function credToJSON(c){
if(ACTION==='register')return{id:c.id,rawId:bufferToBase64(c.rawId),type:c.type,response:{attestationObject:bufferToBase64(c.response.attestationObject),clientDataJSON:bufferToBase64(c.response.clientDataJSON)},clientExtensionResults:c.getClientExtensionResults()};
return{id:c.id,rawId:bufferToBase64(c.rawId),type:c.type,response:{authenticatorData:bufferToBase64(c.response.authenticatorData),clientDataJSON:bufferToBase64(c.response.clientDataJSON),signature:bufferToBase64(c.response.signature),userHandle:c.response.userHandle?bufferToBase64(c.response.userHandle):null},clientExtensionResults:c.getClientExtensionResults()};}
run();
</script></body></html>`;

  return c.html(html);
});

// ── DELETE /api/auth/passkey/credentials/:credId ──────────────────────────
passkeyRoutes.delete('/credentials/:credId', async (c) => {
  const userId = await resolveAuthedUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const user = await getUserById(c.env.DB, userId);
  if (!user) return c.json({ error: 'user_not_found' }, 404);
  if (user.status !== 'active') {
    return c.json({ error: user.status === 'pending' ? 'account_pending' : 'account_disabled' }, 403);
  }

  const credId = c.req.param('credId');
  const result = await c.env.DB.execute(
    'DELETE FROM passkey_credentials WHERE id = $1 AND user_id = $2', [credId, userId],
  );

  if (result.changes === 0) return c.json({ error: 'not_found' }, 404);

  const ip = (c.get('clientIp' as never) as string | undefined) ?? 'unknown';
  await logAuthAudit(c, {
    userId,
    action: 'auth.passkey.delete',
    ip,
    details: { credentialId: credId },
  }, c.env.DB);

  return c.json({ ok: true });
});
