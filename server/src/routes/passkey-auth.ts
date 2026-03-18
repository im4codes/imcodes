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
import { createUser, getUserById } from '../db/queries.js';
import { randomHex, sha256Hex, signJwt, verifyJwt } from '../security/crypto.js';
import { logAudit } from '../security/audit.js';
import { z } from 'zod';
import logger from '../util/logger.js';

type HonoEnv = { Bindings: Env };

export const passkeyRoutes = new Hono<HonoEnv>();

// Cache-Control: no-store on all passkey endpoints
passkeyRoutes.use('/*', async (c, next) => {
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
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)rcc_session=([^;]+)/);
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
    const row = await c.env.DB.prepare(
      'SELECT user_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL',
    ).bind(keyHash).first<{ user_id: string }>();
    if (row) return row.user_id;
  }

  return null;
}

function setSessionCookies(c: Context<HonoEnv>, accessToken: string, refreshToken: string): void {
  const isSecure = c.env.NODE_ENV === 'production';
  setCookie(c, 'rcc_session', accessToken, { httpOnly: true, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 4 * 3600 });
  setCookie(c, 'rcc_refresh', refreshToken, { httpOnly: true, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 30 * 86400 });
  setCookie(c, 'rcc_csrf', randomHex(32), { httpOnly: false, secure: isSecure, sameSite: 'Lax', path: '/', maxAge: 86400 });
}

async function storeRefreshToken(db: Env['DB'], userId: string, refreshHash: string): Promise<void> {
  const now = Date.now();
  await db.prepare(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(randomHex(16), userId, refreshHash, randomHex(16), now + 30 * 24 * 3600 * 1000, now).run();
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

async function saveChallenge(
  db: Env['DB'],
  id: string,
  challenge: string,
  userId: string | null,
  displayName: string,
): Promise<void> {
  const now = Date.now();
  await db.prepare(
    'INSERT INTO passkey_challenges (id, challenge, user_id, display_name, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, challenge, userId, displayName, now + 5 * 60 * 1000, now).run();
  // Clean up expired challenges opportunistically
  await db.prepare('DELETE FROM passkey_challenges WHERE expires_at < ?').bind(now).run();
}

async function consumeChallenge(db: Env['DB'], id: string): Promise<PendingChallenge | null> {
  const row = await db.prepare(
    'SELECT challenge, user_id, display_name FROM passkey_challenges WHERE id = ? AND expires_at > ?',
  ).bind(id, Date.now()).first<{ challenge: string; user_id: string | null; display_name: string }>();
  if (!row) return null;
  await db.prepare('DELETE FROM passkey_challenges WHERE id = ?').bind(id).run();
  return { challenge: row.challenge, userId: row.user_id, displayName: row.display_name };
}

// ── POST /api/auth/passkey/register/begin ─────────────────────────────────
const registerBeginSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
});

passkeyRoutes.post('/register/begin', async (c) => {
  const existingUserId = await resolveAuthedUserId(c);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const parsed = registerBeginSchema.safeParse(body);
  const displayName = parsed.data?.displayName ?? 'IM.codes User';
  const { rpId } = getRpInfo(c);

  // Exclude already-registered credentials for this user
  let excludeCredentials: { id: string; type: 'public-key' }[] = [];
  if (existingUserId) {
    const rows = await c.env.DB.prepare(
      'SELECT id FROM passkey_credentials WHERE user_id = ?',
    ).bind(existingUserId).all<{ id: string }>();
    excludeCredentials = rows.results.map((r) => ({ id: r.id, type: 'public-key' as const }));
  }

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
      residentKey: 'required',
      userVerification: 'preferred',
    },
  });

  const challengeId = randomHex(16);
  await saveChallenge(c.env.DB, challengeId, options.challenge, existingUserId, displayName);

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
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, rpId, origin }, '[passkey] registration verification failed');
    // TODO: remove debug detail after fixing native passkey
    return c.json({ error: 'verification_failed', debug: { rpId, origin, err: errMsg } }, 400);
  }

  if (!verification.verified || !verification.registrationInfo) {
    // TODO: remove debug detail after fixing native passkey
    return c.json({ error: 'verification_failed', debug: { rpId, origin, note: 'verified=false' } }, 400);
  }

  const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;

  const existing = await c.env.DB.prepare(
    'SELECT id FROM passkey_credentials WHERE id = ?',
  ).bind(credentialID).first<{ id: string }>();
  if (existing) return c.json({ error: 'credential_already_registered' }, 409);

  let userId = pending.userId;
  if (!userId) {
    userId = randomHex(16);
    await createUser(c.env.DB, userId);
  }

  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO passkey_credentials (id, user_id, public_key, counter, device_name, transports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    credentialID,
    userId,
    Buffer.from(credentialPublicKey).toString('base64'),
    counter,
    deviceName ?? null,
    null,
    now,
  ).run();

  const ip = (c.get('clientIp' as never) as string | undefined) ?? 'unknown';
  await logAudit({ userId, action: 'auth.passkey.register', ip, details: { credentialId: credentialID } }, c.env.DB);

  // Native callback: issue API key + redirect (skip the second login round-trip)
  const nativeCallback = c.req.query('native_callback');
  if (nativeCallback && nativeCallback.startsWith('imcodes://')) {
    const rawKey = `deck_${randomHex(32)}`;
    const keyHash = sha256Hex(rawKey);
    const keyId = randomHex(16);
    await c.env.DB.prepare(
      'INSERT INTO api_keys (id, user_id, key_hash, label, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(keyId, userId, keyHash, 'mobile-app', now).run();

    const cbUrl = new URL(nativeCallback);
    cbUrl.searchParams.set('key', rawKey);
    cbUrl.searchParams.set('userId', userId);
    cbUrl.searchParams.set('keyId', keyId);
    return c.redirect(cbUrl.toString(), 302);
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
  const storedCred = await c.env.DB.prepare(
    'SELECT id, user_id, public_key, counter, transports FROM passkey_credentials WHERE id = ?',
  ).bind(credentialId).first<{ id: string; user_id: string; public_key: string; counter: number; transports: string | null }>();

  if (!storedCred) return c.json({ error: 'credential_not_found' }, 400);

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
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, rpId, origin }, '[passkey] authentication verification failed');
    // TODO: remove debug detail after fixing native passkey
    return c.json({ error: 'verification_failed', debug: { rpId, origin, err: errMsg } }, 400);
  }

  if (!verification.verified) {
    // TODO: remove debug detail after fixing native passkey
    return c.json({ error: 'verification_failed', debug: { rpId, origin, note: 'verified=false' } }, 400);
  }

  const now = Date.now();
  await c.env.DB.prepare(
    'UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ?',
  ).bind(verification.authenticationInfo.newCounter, now, storedCred.id).run();

  const user = await getUserById(c.env.DB, storedCred.user_id);
  if (!user) return c.json({ error: 'user_not_found' }, 400);

  const ip = (c.get('clientIp' as never) as string | undefined) ?? 'unknown';
  await logAudit({ userId: user.id, action: 'auth.passkey.login', ip, details: { credentialId: storedCred.id } }, c.env.DB);

  const isNativeReq = c.req.query('native') === '1';

  const nativeCallback = c.req.query('native_callback');
  if (isNativeReq || nativeCallback) {
    // Native app: return a persistent API key instead of setting session cookies.
    // The client stores this key in biometric-protected storage.
    const rawKey = `deck_${randomHex(32)}`;
    const keyHash = sha256Hex(rawKey);
    const keyId = randomHex(16);
    const now = Date.now();
    await c.env.DB.prepare(
      'INSERT INTO api_keys (id, user_id, key_hash, label, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(keyId, user.id, keyHash, 'mobile-app', now).run();

    // If native_callback is provided, redirect via HTTP 302 so ASWebAuthenticationSession
    // detects the custom-scheme navigation (JS window.location.href is unreliable).
    if (nativeCallback && nativeCallback.startsWith('imcodes://')) {
      const cbUrl = new URL(nativeCallback);
      cbUrl.searchParams.set('key', rawKey);
      cbUrl.searchParams.set('userId', user.id);
      cbUrl.searchParams.set('keyId', keyId);
      return nativeRedirectPage(c, cbUrl.toString());
    }

    return c.json({ ok: true, userId: user.id, apiKey: rawKey, keyId });
  }

  const accessToken = signJwt({ sub: user.id }, c.env.JWT_SIGNING_KEY, 4 * 3600);
  const refreshToken = randomHex(32);
  await storeRefreshToken(c.env.DB, user.id, sha256Hex(refreshToken));
  setSessionCookies(c, accessToken, refreshToken);

  return c.json({ ok: true });
});

// ── GET /api/auth/passkey/credentials ─────────────────────────────────────
passkeyRoutes.get('/credentials', async (c) => {
  const userId = await resolveAuthedUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const rows = await c.env.DB.prepare(
    'SELECT id, device_name, created_at, last_used_at FROM passkey_credentials WHERE user_id = ? ORDER BY created_at DESC',
  ).bind(userId).all<{ id: string; device_name: string | null; created_at: number; last_used_at: number | null }>();

  return c.json({
    credentials: rows.results.map((r) => ({
      id: r.id,
      deviceName: r.device_name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    })),
  });
});

// ── DELETE /api/auth/passkey/credentials/:credId ──────────────────────────
passkeyRoutes.delete('/credentials/:credId', async (c) => {
  const userId = await resolveAuthedUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const credId = c.req.param('credId');
  const result = await c.env.DB.prepare(
    'DELETE FROM passkey_credentials WHERE id = ? AND user_id = ?',
  ).bind(credId, userId).run();

  if ((result.changes ?? 0) === 0) return c.json({ error: 'not_found' }, 404);

  const ip = (c.get('clientIp' as never) as string | undefined) ?? 'unknown';
  await logAudit({ userId, action: 'auth.passkey.delete', ip, details: { credentialId: credId } }, c.env.DB);

  return c.json({ ok: true });
});
