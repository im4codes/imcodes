import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db/client.js';
import { verifyJwt } from '../security/crypto.js';
import { COOKIE_SESSION } from '../../../shared/cookie-names.js';

export const REMOTE_DESKTOP_NATIVE_CLIENT = Object.freeze({
  clientId: 'imcodes-controlled-shell-v1',
  audience: 'imcodes-remote-desktop-management',
  redirectUris: Object.freeze([
    'http://127.0.0.1:19139/oauth/callback',
  ]),
  authorizationCodeTtlMs: 90_000,
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
});

export const REMOTE_DESKTOP_STEP_UP = Object.freeze({
  challengeTtlMs: 5 * 60 * 1000,
  maxDeadlineMs: 5 * 60 * 1000,
  maxCanonicalActionBytes: 16 * 1024,
  maxRecoverableResultBytes: 16 * 1024,
});

const CODE_HASH_DOMAIN = 'imcodes.remote-desktop.native-code.v1';
const STATE_HASH_DOMAIN = 'imcodes.remote-desktop.native-state.v1';
const SESSION_HASH_DOMAIN = 'imcodes.remote-desktop.native-session.v1';
const WEB_SESSION_HASH_DOMAIN = 'imcodes.remote-desktop.web-session.v1';
const API_KEY_ACCOUNT_SESSION_PREFIX = 'remote-desktop-api-key:';
const GRANT_HASH_DOMAIN = 'imcodes.remote-desktop.step-up-grant.v1';
const ACTION_HASH_DOMAIN = 'imcodes.remote-desktop.step-up-action.v1';
const NATIVE_SESSION_PREFIX = 'rdsn_';
const STEP_UP_GRANT_PREFIX = 'rdsg_';
const BASE64URL_32_RE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export type AccountSession = {
  kind: 'web' | 'native';
  id: string;
  userId: string;
};

/**
 * Bind the mobile app's account API key to the same step-up/session model used
 * by browser account clients. The raw bearer is never persisted. API-key ids
 * are server-issued opaque database identifiers and let the mutation
 * transaction revalidate revocation/grace state before consuming a grant.
 */
export function createBearerAccountSession(input: {
  userId: string;
  bearerToken: string;
  apiKeyId?: string;
}): AccountSession {
  if (input.apiKeyId) {
    return {
      kind: 'web',
      id: `${API_KEY_ACCOUNT_SESSION_PREFIX}${input.apiKeyId}`,
      userId: input.userId,
    };
  }
  return {
    kind: 'web',
    id: hashDomain(WEB_SESSION_HASH_DOMAIN, input.bearerToken),
    userId: input.userId,
  };
}

export type NativeAuthorizationRequest = {
  accountSession: AccountSession;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  issuer: string;
};

export type NativeCodeExchangeRequest = {
  code: string;
  codeVerifier: string;
  state: string;
  clientId: string;
  redirectUri: string;
  issuer: string;
  audience: string;
};

export type StepUpChallengeRow = {
  id: string;
  user_id: string;
  account_session_kind: 'web' | 'native';
  account_session_id: string;
  canonical_host_id: string;
  action_digest: string;
  request_id: string;
  challenge: string;
  rp_id: string;
  origin: string;
  deadline: number;
  expires_at: number;
  native_verified_at: number | null;
};

type StepUpGrantRow = {
  id: string;
  user_id: string;
  account_session_kind: 'web' | 'native';
  account_session_id: string;
  canonical_host_id: string;
  action_digest: string;
  request_id: string;
  deadline: number;
  expires_at: number;
  consumed_at: number | null;
  result_json: string | null;
};

export type StepUpGrantBinding = {
  token: string;
  accountSession: AccountSession;
  canonicalHostId: string;
  action: Record<string, unknown>;
  requestId: string;
};

export type StepUpGrantUse<T> =
  | { ok: true; replayed: boolean; result: T }
  | { ok: false; error: 'invalid_grant' };

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function hashDomain(domain: string, value: string): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update(Buffer.from([0]))
    .update(value, 'utf8')
    .digest('hex');
}

function randomOpaque(bytes = 32): string {
  return base64Url(randomBytes(bytes));
}

function isCanonicalBase64Url32(value: string): boolean {
  if (!BASE64URL_32_RE.test(value)) return false;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 32 && base64Url(decoded) === value;
  } catch {
    return false;
  }
}

export function isValidPkceVerifier(value: string): boolean {
  return PKCE_VERIFIER_RE.test(value);
}

export function computePkceS256(verifier: string): string {
  if (!isValidPkceVerifier(verifier)) throw new Error('invalid_pkce_verifier');
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function nativeShellIssuer(serverUrl: string): string {
  return new URL(serverUrl).origin;
}

export function isAllowedNativeRedirect(clientId: string, redirectUri: string): boolean {
  return clientId === REMOTE_DESKTOP_NATIVE_CLIENT.clientId
    && REMOTE_DESKTOP_NATIVE_CLIENT.redirectUris.includes(redirectUri);
}

function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const item of cookieHeader.split(/;\s*/)) {
    const separator = item.indexOf('=');
    if (separator <= 0 || item.slice(0, separator) !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1));
    } catch {
      return null;
    }
  }
  return null;
}

async function lockAccountSession(
  db: Database,
  session: Pick<AccountSession, 'kind' | 'id'>,
): Promise<void> {
  await db.queryOne(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) AS locked',
    [`remote-desktop-account-session:${session.kind}:${session.id}`],
  );
}

async function accountSessionRemainsCurrent(
  db: Database,
  session: AccountSession,
  now: number,
): Promise<boolean> {
  if (session.kind === 'native') {
    const row = await db.queryOne<{ id: string }>(
      `SELECT session.id
         FROM remote_desktop_native_sessions AS session
         JOIN users AS account ON account.id = session.user_id
        WHERE session.id = $1 AND session.user_id = $2
          AND session.revoked_at IS NULL AND session.expires_at > $3
          AND account.status = 'active'
        FOR UPDATE OF session`,
      [session.id, session.userId, now],
    );
    return row != null;
  }
  if (session.id.startsWith(API_KEY_ACCOUNT_SESSION_PREFIX)) {
    const apiKeyId = session.id.slice(API_KEY_ACCOUNT_SESSION_PREFIX.length);
    if (!apiKeyId) return false;
    const row = await db.queryOne<{ id: string }>(
      `SELECT api_key.id
         FROM api_keys AS api_key
         JOIN users AS account ON account.id = api_key.user_id
        WHERE api_key.id = $1 AND api_key.user_id = $2
          AND api_key.revoked_at IS NULL
          AND (api_key.grace_expires_at IS NULL OR api_key.grace_expires_at > $3)
          AND account.status = 'active'
        FOR UPDATE OF api_key`,
      [apiKeyId, session.userId, now],
    );
    return row != null;
  }
  const row = await db.queryOne<{ id: string }>(
    `SELECT account.id
       FROM users AS account
      WHERE account.id = $1 AND account.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM remote_desktop_web_session_revocations AS revoked
           WHERE revoked.session_hash = $2 AND revoked.user_id = account.id
             AND revoked.expires_at > $3
        )`,
    [session.userId, session.id, now],
  );
  return row != null;
}

export async function resolveBrowserAccountSession(
  db: Database,
  jwtSigningKey: string,
  cookieHeader: string | undefined,
  now = Date.now(),
): Promise<AccountSession | null> {
  const token = parseCookie(cookieHeader, COOKIE_SESSION);
  if (!token) return null;
  const payload = verifyJwt(token, jwtSigningKey);
  if (!payload || typeof payload.sub !== 'string') return null;
  if (payload.type === 'ws-ticket' || payload.type === 'share-ws-ticket') return null;
  const session = {
    kind: 'web',
    id: hashDomain(WEB_SESSION_HASH_DOMAIN, token),
    userId: payload.sub,
  } as const;
  if (!await accountSessionRemainsCurrent(db, session, now)) return null;
  return session;
}

export async function revokeBrowserAccountSession(
  db: Database,
  jwtSigningKey: string,
  cookieHeader: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  const token = parseCookie(cookieHeader, COOKIE_SESSION);
  if (!token) return false;
  const payload = verifyJwt(token, jwtSigningKey);
  if (!payload || typeof payload.sub !== 'string') return false;
  if (payload.type === 'ws-ticket' || payload.type === 'share-ws-ticket') return false;
  const expiresAt = typeof payload.exp === 'number' && Number.isSafeInteger(payload.exp)
    ? Math.max(now + 1, payload.exp * 1000)
    : now + 4 * 60 * 60 * 1000;
  const session: AccountSession = {
    kind: 'web',
    id: hashDomain(WEB_SESSION_HASH_DOMAIN, token),
    userId: payload.sub,
  };
  return db.transaction(async (tx) => {
    await lockAccountSession(tx, session);
    const inserted = await tx.execute(
      `INSERT INTO remote_desktop_web_session_revocations
         (session_hash, user_id, revoked_at, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_hash) DO UPDATE
         SET revoked_at = LEAST(remote_desktop_web_session_revocations.revoked_at, EXCLUDED.revoked_at),
             expires_at = GREATEST(remote_desktop_web_session_revocations.expires_at, EXCLUDED.expires_at)
       WHERE remote_desktop_web_session_revocations.user_id = EXCLUDED.user_id`,
      [session.id, session.userId, now, expiresAt],
    );
    if (inserted.changes !== 1) return false;
    await tx.execute(
      'DELETE FROM remote_desktop_native_auth_codes WHERE account_session_id = $1 AND user_id = $2',
      [session.id, session.userId],
    );
    await tx.execute(
      `DELETE FROM remote_desktop_step_up_challenges
        WHERE account_session_kind = 'web' AND account_session_id = $1 AND user_id = $2`,
      [session.id, session.userId],
    );
    return true;
  });
}

export async function issueNativeAuthorizationCode(
  db: Database,
  input: NativeAuthorizationRequest,
  now = Date.now(),
): Promise<{ code: string; expiresAt: number }> {
  if (input.accountSession.kind !== 'web') throw new Error('browser_session_required');
  if (!isAllowedNativeRedirect(input.clientId, input.redirectUri)) throw new Error('invalid_native_client');
  if (!isCanonicalBase64Url32(input.codeChallenge)) throw new Error('invalid_code_challenge');
  if (!isCanonicalBase64Url32(input.state)) throw new Error('invalid_oauth_state');

  return db.transaction(async (tx) => {
    await lockAccountSession(tx, input.accountSession);
    if (!await accountSessionRemainsCurrent(tx, input.accountSession, now)) {
      throw new Error('browser_session_revoked');
    }
    const code = randomOpaque();
    const expiresAt = now + REMOTE_DESKTOP_NATIVE_CLIENT.authorizationCodeTtlMs;
    await tx.execute(
      `INSERT INTO remote_desktop_native_auth_codes
       (id, code_hash, user_id, account_session_id, client_id, redirect_uri,
        code_challenge, state_hash, issuer, audience, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        randomOpaque(),
        hashDomain(CODE_HASH_DOMAIN, code),
        input.accountSession.userId,
        input.accountSession.id,
        input.clientId,
        input.redirectUri,
        input.codeChallenge,
        hashDomain(STATE_HASH_DOMAIN, input.state),
        input.issuer,
        REMOTE_DESKTOP_NATIVE_CLIENT.audience,
        expiresAt,
        now,
      ],
    );
    return { code, expiresAt };
  });
}

export async function exchangeNativeAuthorizationCode(
  db: Database,
  input: NativeCodeExchangeRequest,
  now = Date.now(),
): Promise<{
  accessToken: string;
  sessionId: string;
  userId: string;
  expiresAt: number;
  clientId: string;
  issuer: string;
  audience: string;
} | null> {
  if (!isCanonicalBase64Url32(input.code) || !isCanonicalBase64Url32(input.state)) return null;
  if (!isAllowedNativeRedirect(input.clientId, input.redirectUri)) return null;
  if (input.audience !== REMOTE_DESKTOP_NATIVE_CLIENT.audience) return null;
  if (!isValidPkceVerifier(input.codeVerifier)) return null;

  const challenge = computePkceS256(input.codeVerifier);
  return db.transaction(async (tx) => {
    const candidate = await tx.queryOne<{
      user_id: string;
      account_session_id: string;
    }>(
      `SELECT user_id, account_session_id
         FROM remote_desktop_native_auth_codes
        WHERE code_hash = $1`,
      [hashDomain(CODE_HASH_DOMAIN, input.code)],
    );
    if (!candidate) return null;
    const originatingSession: AccountSession = {
      kind: 'web',
      id: candidate.account_session_id,
      userId: candidate.user_id,
    };
    await lockAccountSession(tx, originatingSession);
    if (!await accountSessionRemainsCurrent(tx, originatingSession, now)) return null;
    const code = await tx.queryOne<{
      user_id: string;
      account_session_id: string;
      client_id: string;
      issuer: string;
      audience: string;
    }>(
      `DELETE FROM remote_desktop_native_auth_codes AS code
       USING users AS account
       WHERE code.code_hash = $1
         AND code.client_id = $2
         AND code.redirect_uri = $3
         AND code.code_challenge = $4
         AND code.state_hash = $5
         AND code.issuer = $6
         AND code.audience = $7
         AND code.expires_at > $8
         AND account.id = code.user_id
         AND account.status = 'active'
       RETURNING code.user_id, code.account_session_id, code.client_id,
                 code.issuer, code.audience`,
      [
        hashDomain(CODE_HASH_DOMAIN, input.code),
        input.clientId,
        input.redirectUri,
        challenge,
        hashDomain(STATE_HASH_DOMAIN, input.state),
        input.issuer,
        input.audience,
        now,
      ],
    );
    if (!code) return null;

    const sessionId = randomOpaque();
    const accessToken = `${NATIVE_SESSION_PREFIX}${randomOpaque()}`;
    const expiresAt = now + REMOTE_DESKTOP_NATIVE_CLIENT.sessionTtlMs;
    await tx.execute(
      `INSERT INTO remote_desktop_native_sessions
         (id, session_hash, user_id, originating_session_id, client_id,
          issuer, audience, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        sessionId,
        hashDomain(SESSION_HASH_DOMAIN, accessToken),
        code.user_id,
        code.account_session_id,
        code.client_id,
        code.issuer,
        code.audience,
        expiresAt,
        now,
      ],
    );
    return {
      accessToken,
      sessionId,
      userId: code.user_id,
      expiresAt,
      clientId: code.client_id,
      issuer: code.issuer,
      audience: code.audience,
    };
  });
}

export async function resolveNativeShellSession(
  db: Database,
  authorizationHeader: string | undefined,
  issuer: string,
  now = Date.now(),
): Promise<AccountSession | null> {
  if (!authorizationHeader?.startsWith('Bearer ')) return null;
  const token = authorizationHeader.slice('Bearer '.length);
  if (!token.startsWith(NATIVE_SESSION_PREFIX)) return null;
  const row = await db.queryOne<{ id: string; user_id: string }>(
    `SELECT session.id, session.user_id
       FROM remote_desktop_native_sessions AS session
       JOIN users AS account ON account.id = session.user_id
      WHERE session.session_hash = $1
        AND session.client_id = $2
        AND session.issuer = $3
        AND session.audience = $4
        AND session.revoked_at IS NULL
        AND session.expires_at > $5
        AND account.status = 'active'`,
    [
      hashDomain(SESSION_HASH_DOMAIN, token),
      REMOTE_DESKTOP_NATIVE_CLIENT.clientId,
      issuer,
      REMOTE_DESKTOP_NATIVE_CLIENT.audience,
      now,
    ],
  );
  if (!row) return null;
  await db.execute(
    'UPDATE remote_desktop_native_sessions SET last_used_at = $1 WHERE id = $2',
    [now, row.id],
  );
  return { kind: 'native', id: row.id, userId: row.user_id };
}

export async function revokeNativeShellSession(
  db: Database,
  session: AccountSession,
  now = Date.now(),
): Promise<boolean> {
  if (session.kind !== 'native') return false;
  return db.transaction(async (tx) => {
    await lockAccountSession(tx, session);
    const updated = await tx.execute(
      `UPDATE remote_desktop_native_sessions
          SET revoked_at = $1
        WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL`,
      [now, session.id, session.userId],
    );
    return updated.changes === 1;
  });
}

export async function revokeNativeShellSessionsForAccount(
  db: Database,
  accountSession: AccountSession,
  now = Date.now(),
): Promise<number> {
  if (accountSession.kind !== 'web') return 0;
  const updated = await db.execute(
    `UPDATE remote_desktop_native_sessions
        SET revoked_at = $1
      WHERE user_id = $2 AND revoked_at IS NULL`,
    [now, accountSession.userId],
  );
  return updated.changes;
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 8) throw new Error('action_too_deep');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid_action_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid_action_object');
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`
    ));
    return `{${entries.join(',')}}`;
  }
  throw new Error('invalid_action_value');
}

export function digestStepUpAction(action: Record<string, unknown>): string {
  const normalized = canonicalJson(action);
  if (Buffer.byteLength(normalized, 'utf8') > REMOTE_DESKTOP_STEP_UP.maxCanonicalActionBytes) {
    throw new Error('action_too_large');
  }
  return hashDomain(ACTION_HASH_DOMAIN, normalized);
}

export function validateStepUpRequestId(requestId: string): boolean {
  return isCanonicalBase64Url32(requestId);
}

export function validateStepUpDeadline(deadline: number, now = Date.now()): boolean {
  return Number.isSafeInteger(deadline)
    && deadline > now
    && deadline <= now + REMOTE_DESKTOP_STEP_UP.maxDeadlineMs;
}

export async function storeStepUpChallenge(
  db: Database,
  input: {
    accountSession: AccountSession;
    canonicalHostId: string;
    actionDigest: string;
    requestId: string;
    challenge: string;
    rpId: string;
    origin: string;
    deadline: number;
  },
  now = Date.now(),
): Promise<{ challengeId: string; expiresAt: number }> {
  if (!SHA256_HEX_RE.test(input.actionDigest)) throw new Error('invalid_action_digest');
  if (!validateStepUpRequestId(input.requestId)) throw new Error('invalid_request_id');
  if (!validateStepUpDeadline(input.deadline, now)) throw new Error('invalid_deadline');
  return db.transaction(async (tx) => {
    await lockAccountSession(tx, input.accountSession);
    if (!await accountSessionRemainsCurrent(tx, input.accountSession, now)) {
      throw new Error('account_session_revoked');
    }
    const challengeId = randomOpaque();
    const expiresAt = Math.min(input.deadline, now + REMOTE_DESKTOP_STEP_UP.challengeTtlMs);
    await tx.execute(
      `INSERT INTO remote_desktop_step_up_challenges
       (id, user_id, account_session_kind, account_session_id, canonical_host_id,
        action_digest, request_id, challenge, rp_id, origin, deadline, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        challengeId,
        input.accountSession.userId,
        input.accountSession.kind,
        input.accountSession.id,
        input.canonicalHostId,
        input.actionDigest,
        input.requestId,
        input.challenge,
        input.rpId,
        input.origin,
        input.deadline,
        expiresAt,
        now,
      ],
    );
    return { challengeId, expiresAt };
  });
}

export async function loadStepUpChallenge(
  db: Database,
  challengeId: string,
  now = Date.now(),
): Promise<StepUpChallengeRow | null> {
  return db.queryOne<StepUpChallengeRow>(
    `SELECT id, user_id, account_session_kind, account_session_id,
            canonical_host_id, action_digest, request_id, challenge,
            rp_id, origin, deadline, expires_at, native_verified_at
       FROM remote_desktop_step_up_challenges
      WHERE id = $1 AND expires_at > $2 AND deadline > $2`,
    [challengeId, now],
  );
}

export function canCompleteStepUpChallenge(
  challenge: StepUpChallengeRow,
  completingSession: AccountSession,
): boolean {
  if (challenge.user_id !== completingSession.userId) return false;
  if (challenge.account_session_kind === 'web') {
    return completingSession.kind === 'web'
      && challenge.account_session_id === completingSession.id;
  }
  // A native-shell step-up must cross the system browser. The resulting grant
  // remains bound to the initiating native session, not to this browser cookie.
  return completingSession.kind === 'web';
}

export async function finalizeStepUpChallenge(
  db: Database,
  input: {
    challenge: StepUpChallengeRow;
    completingSession: AccountSession;
    credentialId: string;
    expectedCounter: number;
    newCounter: number;
    userVerified: boolean;
  },
  now = Date.now(),
): Promise<{ grantToken: string; expiresAt: number; actionDigest: string } | null> {
  if (!input.userVerified
    || input.challenge.account_session_kind !== 'web'
    || !canCompleteStepUpChallenge(input.challenge, input.completingSession)) return null;
  return db.transaction(async (tx) => {
    const initiatingSession: AccountSession = {
      kind: input.challenge.account_session_kind,
      id: input.challenge.account_session_id,
      userId: input.challenge.user_id,
    };
    await lockAccountSession(tx, initiatingSession);
    if (!await accountSessionRemainsCurrent(tx, initiatingSession, now)) return null;
    const claimed = await tx.queryOne<StepUpChallengeRow>(
      `DELETE FROM remote_desktop_step_up_challenges
        WHERE id = $1 AND user_id = $2 AND expires_at > $3 AND deadline > $3
          AND native_verified_at IS NULL
      RETURNING id, user_id, account_session_kind, account_session_id,
                canonical_host_id, action_digest, request_id, challenge,
                rp_id, origin, deadline, expires_at, native_verified_at`,
      [input.challenge.id, input.challenge.user_id, now],
    );
    if (!claimed
      || claimed.account_session_kind !== input.challenge.account_session_kind
      || claimed.account_session_id !== input.challenge.account_session_id
      || claimed.canonical_host_id !== input.challenge.canonical_host_id
      || claimed.action_digest !== input.challenge.action_digest
      || claimed.request_id !== input.challenge.request_id
      || claimed.challenge !== input.challenge.challenge
      || claimed.rp_id !== input.challenge.rp_id
      || claimed.origin !== input.challenge.origin
      || claimed.deadline !== input.challenge.deadline
      || claimed.expires_at !== input.challenge.expires_at) {
      return null;
    }

    const credential = await tx.execute(
      `UPDATE passkey_credentials
          SET counter = $1, last_used_at = $2
        WHERE id = $3 AND user_id = $4 AND counter = $5`,
      [input.newCounter, now, input.credentialId, claimed.user_id, input.expectedCounter],
    );
    if (credential.changes !== 1) throw new Error('step_up_credential_changed');

    const grantToken = `${STEP_UP_GRANT_PREFIX}${randomOpaque()}`;
    await tx.execute(
      `INSERT INTO remote_desktop_step_up_grants
         (id, grant_hash, user_id, account_session_kind, account_session_id,
          canonical_host_id, action_digest, request_id, deadline, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        randomOpaque(),
        hashDomain(GRANT_HASH_DOMAIN, grantToken),
        claimed.user_id,
        claimed.account_session_kind,
        claimed.account_session_id,
        claimed.canonical_host_id,
        claimed.action_digest,
        claimed.request_id,
        claimed.deadline,
        claimed.expires_at,
        now,
      ],
    );
    return { grantToken, expiresAt: claimed.expires_at, actionDigest: claimed.action_digest };
  });
}

/**
 * Record browser user-verification for a native-shell challenge without ever
 * returning the action grant to the browser. The initiating native session is
 * locked and revalidated in the same transaction as the passkey counter and
 * verification marker. A browser cookie proves only user verification; it
 * never becomes the management session that will receive or consume a grant.
 */
export async function verifyNativeStepUpChallenge(
  db: Database,
  input: {
    challenge: StepUpChallengeRow;
    completingSession: AccountSession;
    credentialId: string;
    expectedCounter: number;
    newCounter: number;
    userVerified: boolean;
  },
  now = Date.now(),
): Promise<{ status: 'verified' } | null> {
  if (!input.userVerified
    || input.challenge.account_session_kind !== 'native'
    || !canCompleteStepUpChallenge(input.challenge, input.completingSession)) return null;
  return db.transaction(async (tx) => {
    const initiatingSession: AccountSession = {
      kind: 'native',
      id: input.challenge.account_session_id,
      userId: input.challenge.user_id,
    };
    await lockAccountSession(tx, initiatingSession);
    if (!await accountSessionRemainsCurrent(tx, initiatingSession, now)) return null;
    const claimed = await tx.queryOne<StepUpChallengeRow>(
      `SELECT id, user_id, account_session_kind, account_session_id,
              canonical_host_id, action_digest, request_id, challenge,
              rp_id, origin, deadline, expires_at, native_verified_at
         FROM remote_desktop_step_up_challenges
        WHERE id = $1 AND user_id = $2 AND account_session_kind = 'native'
          AND expires_at > $3 AND deadline > $3 AND native_verified_at IS NULL
        FOR UPDATE`,
      [input.challenge.id, input.challenge.user_id, now],
    );
    if (!claimed
      || claimed.account_session_id !== input.challenge.account_session_id
      || claimed.canonical_host_id !== input.challenge.canonical_host_id
      || claimed.action_digest !== input.challenge.action_digest
      || claimed.request_id !== input.challenge.request_id
      || claimed.challenge !== input.challenge.challenge
      || claimed.rp_id !== input.challenge.rp_id
      || claimed.origin !== input.challenge.origin
      || claimed.deadline !== input.challenge.deadline
      || claimed.expires_at !== input.challenge.expires_at) return null;

    const credential = await tx.execute(
      `UPDATE passkey_credentials
          SET counter = $1, last_used_at = $2
        WHERE id = $3 AND user_id = $4 AND counter = $5`,
      [input.newCounter, now, input.credentialId, claimed.user_id, input.expectedCounter],
    );
    if (credential.changes !== 1) throw new Error('step_up_credential_changed');
    const verified = await tx.execute(
      `UPDATE remote_desktop_step_up_challenges
          SET native_verified_at = $2
        WHERE id = $1 AND native_verified_at IS NULL`,
      [claimed.id, now],
    );
    if (verified.changes !== 1) throw new Error('native_step_up_verification_raced');
    return { status: 'verified' as const };
  });
}

/**
 * The raw one-use grant crosses TLS only to the initiating native bearer.
 * Browser history/URL/DOM receives no grant, and claiming atomically deletes
 * the verified challenge so polling/replay cannot mint a second grant.
 */
export async function claimVerifiedNativeStepUpGrant(
  db: Database,
  input: { accountSession: AccountSession; challengeId: string },
  now = Date.now(),
): Promise<{ grantToken: string; expiresAt: number; actionDigest: string } | null> {
  if (input.accountSession.kind !== 'native'
    || !BASE64URL_32_RE.test(input.challengeId)) return null;
  return db.transaction(async (tx) => {
    await lockAccountSession(tx, input.accountSession);
    if (!await accountSessionRemainsCurrent(tx, input.accountSession, now)) return null;
    const claimed = await tx.queryOne<StepUpChallengeRow>(
      `DELETE FROM remote_desktop_step_up_challenges
        WHERE id = $1 AND user_id = $2 AND account_session_kind = 'native'
          AND account_session_id = $3 AND expires_at > $4 AND deadline > $4
          AND native_verified_at IS NOT NULL
      RETURNING id, user_id, account_session_kind, account_session_id,
                canonical_host_id, action_digest, request_id, challenge,
                rp_id, origin, deadline, expires_at, native_verified_at`,
      [input.challengeId, input.accountSession.userId, input.accountSession.id, now],
    );
    if (!claimed) return null;
    const grantToken = `${STEP_UP_GRANT_PREFIX}${randomOpaque()}`;
    await tx.execute(
      `INSERT INTO remote_desktop_step_up_grants
         (id, grant_hash, user_id, account_session_kind, account_session_id,
          canonical_host_id, action_digest, request_id, deadline, expires_at, created_at)
       VALUES ($1, $2, $3, 'native', $4, $5, $6, $7, $8, $9, $10)`,
      [
        randomOpaque(),
        hashDomain(GRANT_HASH_DOMAIN, grantToken),
        claimed.user_id,
        claimed.account_session_id,
        claimed.canonical_host_id,
        claimed.action_digest,
        claimed.request_id,
        claimed.deadline,
        claimed.expires_at,
        now,
      ],
    );
    return {
      grantToken,
      expiresAt: claimed.expires_at,
      actionDigest: claimed.action_digest,
    };
  });
}

export async function consumeActionBoundStepUpGrant<T>(
  db: Database,
  binding: StepUpGrantBinding,
  mutation: (tx: Database) => Promise<T>,
  now = Date.now(),
): Promise<StepUpGrantUse<T>> {
  if (!binding.token.startsWith(STEP_UP_GRANT_PREFIX)
    || !validateStepUpRequestId(binding.requestId)) {
    return { ok: false, error: 'invalid_grant' };
  }

  let actionDigest: string;
  try {
    actionDigest = digestStepUpAction(binding.action);
  } catch {
    return { ok: false, error: 'invalid_grant' };
  }

  return db.transaction(async (tx) => {
    await lockAccountSession(tx, binding.accountSession);
    if (!await accountSessionRemainsCurrent(tx, binding.accountSession, now)) {
      return { ok: false as const, error: 'invalid_grant' as const };
    }
    const grant = await tx.queryOne<StepUpGrantRow>(
      `SELECT id, user_id, account_session_kind, account_session_id,
              canonical_host_id, action_digest, request_id, deadline,
              expires_at, consumed_at, result_json
         FROM remote_desktop_step_up_grants
        WHERE grant_hash = $1
        FOR UPDATE`,
      [hashDomain(GRANT_HASH_DOMAIN, binding.token)],
    );
    if (!grant
      || grant.user_id !== binding.accountSession.userId
      || grant.account_session_kind !== binding.accountSession.kind
      || grant.account_session_id !== binding.accountSession.id
      || grant.canonical_host_id !== binding.canonicalHostId
      || grant.action_digest !== actionDigest
      || grant.request_id !== binding.requestId) {
      return { ok: false as const, error: 'invalid_grant' as const };
    }

    if (grant.consumed_at != null) {
      if (grant.result_json == null) return { ok: false as const, error: 'invalid_grant' as const };
      try {
        return { ok: true as const, replayed: true, result: JSON.parse(grant.result_json) as T };
      } catch {
        return { ok: false as const, error: 'invalid_grant' as const };
      }
    }

    if (grant.deadline <= now || grant.expires_at <= now) {
      return { ok: false as const, error: 'invalid_grant' as const };
    }

    const result = await mutation(tx);
    const resultJson = JSON.stringify(result);
    if (resultJson === undefined
      || Buffer.byteLength(resultJson, 'utf8') > REMOTE_DESKTOP_STEP_UP.maxRecoverableResultBytes) {
      throw new Error('step_up_result_not_recoverable');
    }
    const consumed = await tx.execute(
      `UPDATE remote_desktop_step_up_grants
          SET consumed_at = $1, result_json = $2
        WHERE id = $3 AND consumed_at IS NULL`,
      [now, resultJson, grant.id],
    );
    if (consumed.changes !== 1) throw new Error('step_up_grant_raced');
    return { ok: true as const, replayed: false, result };
  });
}
