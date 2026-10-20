import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { generateAuthenticationOptionsMock, verifyAuthenticationResponseMock } = vi.hoisted(() => ({
  generateAuthenticationOptionsMock: vi.fn(async (options: Record<string, unknown>) => ({
    challenge: typeof options.challenge === 'string' ? options.challenge : 'fresh-webauthn-challenge',
    rpId: options.rpID,
    allowCredentials: options.allowCredentials ?? [],
  })),
  verifyAuthenticationResponseMock: vi.fn(async () => ({
    verified: true,
    authenticationInfo: { newCounter: 8, userVerified: true },
  })),
}));

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: generateAuthenticationOptionsMock,
  verifyAuthenticationResponse: verifyAuthenticationResponseMock,
}));

import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { remoteDesktopAccountAuthRoutes } from '../src/routes/remote-desktop-account-auth.js';
import {
  REMOTE_DESKTOP_NATIVE_CLIENT,
  computePkceS256,
  consumeActionBoundStepUpGrant,
  createBearerAccountSession,
  digestStepUpAction,
  exchangeNativeAuthorizationCode,
  issueNativeAuthorizationCode,
  resolveBrowserAccountSession,
  resolveNativeShellSession,
  revokeBrowserAccountSession,
  revokeNativeShellSession,
  storeStepUpChallenge,
  type AccountSession,
} from '../src/services/remote-desktop-account-auth.js';
import { signJwt } from '../src/security/crypto.js';

type AuthCode = {
  codeHash: string;
  userId: string;
  accountSessionId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  stateHash: string;
  issuer: string;
  audience: string;
  expiresAt: number;
};

type NativeSession = {
  id: string;
  sessionHash: string;
  userId: string;
  clientId: string;
  issuer: string;
  audience: string;
  expiresAt: number;
  revokedAt: number | null;
};

type Challenge = {
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

type Grant = {
  id: string;
  grantHash: string;
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

type State = {
  users: Map<string, 'active' | 'disabled'>;
  apiKeys: Map<string, { userId: string; revokedAt: number | null; graceExpiresAt: number | null }>;
  webSessionRevocations: Map<string, { userId: string; expiresAt: number }>;
  credentials: Map<string, { id: string; user_id: string; public_key: string; counter: number; transports: string | null }>;
  authCodes: Map<string, AuthCode>;
  nativeSessions: Map<string, NativeSession>;
  challenges: Map<string, Challenge>;
  grants: Map<string, Grant>;
};

function cloneState(state: State): State {
  return structuredClone(state);
}

function makeDb(): { db: Database; state: State } {
  let state: State = {
    users: new Map([['owner-1', 'active'], ['owner-2', 'active']]),
    apiKeys: new Map([['mobile-key-1', { userId: 'owner-1', revokedAt: null, graceExpiresAt: null }]]),
    webSessionRevocations: new Map(),
    credentials: new Map([['cred-1', {
      id: 'cred-1', user_id: 'owner-1', public_key: Buffer.from('public-key').toString('base64'),
      counter: 7, transports: JSON.stringify(['internal']),
    }]]),
    authCodes: new Map(),
    nativeSessions: new Map(),
    challenges: new Map(),
    grants: new Map(),
  };
  const normalize = (sql: string) => sql.toLowerCase().replace(/\s+/g, ' ').trim();

  const db = {
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const normalized = normalize(sql);
      if (normalized.includes('select id from passkey_credentials where user_id')) {
        return Array.from(state.credentials.values())
          .filter((row) => row.user_id === params[0])
          .map(({ id }) => ({ id }) as T);
      }
      throw new Error(`Unhandled query: ${normalized}`);
    },
    queryOne: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const normalized = normalize(sql);
      if (normalized.startsWith('select pg_advisory_xact_lock')) {
        return { locked: null } as T;
      }
      if (normalized.includes('from api_keys as api_key')) {
        const row = state.apiKeys.get(String(params[0]));
        return (row
          && row.userId === params[1]
          && row.revokedAt == null
          && (row.graceExpiresAt == null || row.graceExpiresAt > Number(params[2]))
          && state.users.get(row.userId) === 'active'
          ? { id: params[0] }
          : null) as T | null;
      }
      if (normalized.includes('from users as account')
        && normalized.includes('remote_desktop_web_session_revocations')) {
        const revoked = state.webSessionRevocations.get(String(params[1]));
        return (state.users.get(String(params[0])) === 'active'
          && (!revoked || revoked.userId !== params[0] || revoked.expiresAt <= Number(params[2]))
          ? { id: params[0] } : null) as T | null;
      }
      if (normalized.includes("select id from users where id = $1 and status = 'active'")) {
        return (state.users.get(String(params[0])) === 'active' ? { id: params[0] } : null) as T | null;
      }
      if (normalized.startsWith('delete from remote_desktop_native_auth_codes')) {
        const row = state.authCodes.get(String(params[0]));
        if (!row
          || row.clientId !== params[1] || row.redirectUri !== params[2]
          || row.codeChallenge !== params[3] || row.stateHash !== params[4]
          || row.issuer !== params[5] || row.audience !== params[6]
          || row.expiresAt <= Number(params[7]) || state.users.get(row.userId) !== 'active') return null;
        state.authCodes.delete(row.codeHash);
        return {
          user_id: row.userId, account_session_id: row.accountSessionId,
          client_id: row.clientId, issuer: row.issuer, audience: row.audience,
        } as T;
      }
      if (normalized.startsWith('select user_id, account_session_id from remote_desktop_native_auth_codes')) {
        const row = state.authCodes.get(String(params[0]));
        return (row ? { user_id: row.userId, account_session_id: row.accountSessionId } : null) as T | null;
      }
      if (normalized.includes('from remote_desktop_native_sessions as session')
        && normalized.includes('session.session_hash = $1')) {
        const row = Array.from(state.nativeSessions.values()).find((candidate) => (
          candidate.sessionHash === params[0] && candidate.clientId === params[1]
          && candidate.issuer === params[2] && candidate.audience === params[3]
          && candidate.revokedAt == null && candidate.expiresAt > Number(params[4])
          && state.users.get(candidate.userId) === 'active'
        ));
        return (row ? { id: row.id, user_id: row.userId } : null) as T | null;
      }
      if ((normalized.startsWith('select id from remote_desktop_native_sessions')
        || normalized.startsWith('select session.id from remote_desktop_native_sessions'))
        && !normalized.includes('as session where session.session_hash')) {
        const row = state.nativeSessions.get(String(params[0]));
        return (row && row.userId === params[1] && row.revokedAt == null && row.expiresAt > Number(params[2])
          ? { id: row.id } : null) as T | null;
      }
      if (normalized.startsWith('select') && normalized.includes('from remote_desktop_step_up_challenges')) {
        const row = state.challenges.get(String(params[0]));
        const locked = normalized.includes('for update');
        const now = Number(params[locked ? 2 : 1]);
        return (row && (!locked || row.user_id === params[1])
          && row.expires_at > now && row.deadline > now
          && (!normalized.includes('native_verified_at is null') || row.native_verified_at == null)
          ? row : null) as T | null;
      }
      if (normalized.startsWith('delete from remote_desktop_step_up_challenges')) {
        const row = state.challenges.get(String(params[0]));
        const nativeClaim = normalized.includes('native_verified_at is not null');
        const now = Number(params[nativeClaim ? 3 : 2]);
        if (!row || row.user_id !== params[1] || row.expires_at <= now || row.deadline <= now
          || (nativeClaim && (row.account_session_kind !== 'native'
            || row.account_session_id !== params[2] || row.native_verified_at == null))
          || (!nativeClaim && row.native_verified_at != null)) return null;
        state.challenges.delete(row.id);
        return row as T;
      }
      if (normalized.includes('from passkey_credentials') && normalized.includes('where id = $1')) {
        const row = state.credentials.get(String(params[0]));
        return (row && row.user_id === params[1] ? { ...row } : null) as T | null;
      }
      if (normalized.includes('from remote_desktop_step_up_grants')) {
        const row = Array.from(state.grants.values()).find((candidate) => candidate.grantHash === params[0]);
        return (row ?? null) as T | null;
      }
      throw new Error(`Unhandled queryOne: ${normalized}`);
    },
    execute: async (sql: string, params: unknown[] = []): Promise<{ changes: number }> => {
      const normalized = normalize(sql);
      if (normalized.startsWith('insert into remote_desktop_web_session_revocations')) {
        const existing = state.webSessionRevocations.get(String(params[0]));
        if (existing && existing.userId !== params[1]) return { changes: 0 };
        state.webSessionRevocations.set(String(params[0]), {
          userId: String(params[1]),
          expiresAt: Math.max(existing?.expiresAt ?? 0, Number(params[3])),
        });
        return { changes: 1 };
      }
      if (normalized.startsWith('delete from remote_desktop_native_auth_codes')) {
        let changes = 0;
        for (const [key, row] of state.authCodes) {
          if (row.accountSessionId === params[0] && row.userId === params[1]) {
            state.authCodes.delete(key);
            changes += 1;
          }
        }
        return { changes };
      }
      if (normalized.startsWith('delete from remote_desktop_step_up_challenges')) {
        let changes = 0;
        for (const [key, row] of state.challenges) {
          if (row.account_session_kind === 'web'
            && row.account_session_id === params[0] && row.user_id === params[1]) {
            state.challenges.delete(key);
            changes += 1;
          }
        }
        return { changes };
      }
      if (normalized.startsWith('insert into remote_desktop_native_auth_codes')) {
        const row: AuthCode = {
          codeHash: String(params[1]), userId: String(params[2]), accountSessionId: String(params[3]),
          clientId: String(params[4]), redirectUri: String(params[5]), codeChallenge: String(params[6]),
          stateHash: String(params[7]), issuer: String(params[8]), audience: String(params[9]), expiresAt: Number(params[10]),
        };
        state.authCodes.set(row.codeHash, row);
        return { changes: 1 };
      }
      if (normalized.startsWith('insert into remote_desktop_native_sessions')) {
        const row: NativeSession = {
          id: String(params[0]), sessionHash: String(params[1]), userId: String(params[2]), clientId: String(params[4]),
          issuer: String(params[5]), audience: String(params[6]), expiresAt: Number(params[7]), revokedAt: null,
        };
        state.nativeSessions.set(row.id, row);
        return { changes: 1 };
      }
      if (normalized.startsWith('insert into remote_desktop_step_up_challenges')) {
        const row: Challenge = {
          id: String(params[0]), user_id: String(params[1]), account_session_kind: params[2] as 'web' | 'native',
          account_session_id: String(params[3]), canonical_host_id: String(params[4]), action_digest: String(params[5]),
          request_id: String(params[6]), challenge: String(params[7]), rp_id: String(params[8]), origin: String(params[9]),
          deadline: Number(params[10]), expires_at: Number(params[11]), native_verified_at: null,
        };
        state.challenges.set(row.id, row);
        return { changes: 1 };
      }
      if (normalized.startsWith('insert into remote_desktop_step_up_grants')) {
        const nativeGrant = normalized.includes("'native'");
        const row: Grant = {
          id: String(params[0]), grantHash: String(params[1]), user_id: String(params[2]),
          account_session_kind: nativeGrant ? 'native' : params[3] as 'web' | 'native',
          account_session_id: String(params[nativeGrant ? 3 : 4]),
          canonical_host_id: String(params[nativeGrant ? 4 : 5]),
          action_digest: String(params[nativeGrant ? 5 : 6]),
          request_id: String(params[nativeGrant ? 6 : 7]),
          deadline: Number(params[nativeGrant ? 7 : 8]),
          expires_at: Number(params[nativeGrant ? 8 : 9]), consumed_at: null, result_json: null,
        };
        state.grants.set(row.id, row);
        return { changes: 1 };
      }
      if (normalized.startsWith('update remote_desktop_native_sessions set last_used_at')) return { changes: 1 };
      if (normalized.includes('update remote_desktop_native_sessions') && normalized.includes('where id = $2')) {
        const row = state.nativeSessions.get(String(params[1]));
        if (!row || row.userId !== params[2] || row.revokedAt != null) return { changes: 0 };
        row.revokedAt = Number(params[0]);
        return { changes: 1 };
      }
      if (normalized.startsWith('update passkey_credentials')) {
        const row = state.credentials.get(String(params[2]));
        if (!row || row.user_id !== params[3] || row.counter !== Number(params[4])) return { changes: 0 };
        row.counter = Number(params[0]);
        return { changes: 1 };
      }
      if (normalized.startsWith('update remote_desktop_step_up_challenges')
        && normalized.includes('set native_verified_at')) {
        const row = state.challenges.get(String(params[0]));
        if (!row || row.native_verified_at != null) return { changes: 0 };
        row.native_verified_at = Number(params[1]);
        return { changes: 1 };
      }
      if (normalized.startsWith('update remote_desktop_step_up_grants')) {
        const row = state.grants.get(String(params[2]));
        if (!row || row.consumed_at != null) return { changes: 0 };
        row.consumed_at = Number(params[0]);
        row.result_json = String(params[1]);
        return { changes: 1 };
      }
      throw new Error(`Unhandled execute: ${normalized}`);
    },
    transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => {
      const snapshot = cloneState(state);
      try {
        return await fn(db as unknown as Database);
      } catch (error) {
        state = snapshot;
        exposed.state = state;
        throw error;
      }
    },
  };
  const exposed = { db: db as unknown as Database, state };
  return exposed;
}

function opaque32(): string {
  return randomBytes(32).toString('base64url');
}

function webSession(userId = 'owner-1'): AccountSession {
  return { kind: 'web', id: 'web-session-1', userId };
}

describe('remote desktop native account authentication', () => {
  it('uses an exact redirect allowlist and consumes a PKCE code only after every binding matches', async () => {
    const { db, state: dbState } = makeDb();
    const now = 1_700_000_000_000;
    const verifier = opaque32();
    const state = opaque32();
    const issued = await issueNativeAuthorizationCode(db, {
      accountSession: webSession(),
      clientId: REMOTE_DESKTOP_NATIVE_CLIENT.clientId,
      redirectUri: REMOTE_DESKTOP_NATIVE_CLIENT.redirectUris[0],
      codeChallenge: computePkceS256(verifier),
      state,
      issuer: 'https://app.im.codes',
    }, now);

    const base = {
      code: issued.code, codeVerifier: verifier, state,
      clientId: REMOTE_DESKTOP_NATIVE_CLIENT.clientId,
      redirectUri: REMOTE_DESKTOP_NATIVE_CLIENT.redirectUris[0],
      issuer: 'https://app.im.codes', audience: REMOTE_DESKTOP_NATIVE_CLIENT.audience,
    };
    expect(await exchangeNativeAuthorizationCode(db, { ...base, redirectUri: 'http://localhost:19139/oauth/callback' }, now + 1)).toBeNull();
    expect(await exchangeNativeAuthorizationCode(db, { ...base, codeVerifier: opaque32() }, now + 2)).toBeNull();
    expect(await exchangeNativeAuthorizationCode(db, { ...base, state: opaque32() }, now + 3)).toBeNull();
    expect(await exchangeNativeAuthorizationCode(db, { ...base, clientId: 'other-public-client' }, now + 4)).toBeNull();
    expect(await exchangeNativeAuthorizationCode(db, { ...base, issuer: 'https://other.example' }, now + 5)).toBeNull();
    expect(await exchangeNativeAuthorizationCode(db, { ...base, audience: 'other-audience' }, now + 6)).toBeNull();
    dbState.users.set('owner-1', 'disabled');
    expect(await exchangeNativeAuthorizationCode(db, base, now + 7)).toBeNull();
    dbState.users.set('owner-1', 'active');

    const exchanged = await exchangeNativeAuthorizationCode(db, base, now + 8);
    expect(exchanged).toMatchObject({ userId: 'owner-1', clientId: REMOTE_DESKTOP_NATIVE_CLIENT.clientId });
    expect(exchanged?.accessToken).toMatch(/^rdsn_[A-Za-z0-9_-]{43}$/);
    expect(await exchangeNativeAuthorizationCode(db, base, now + 9)).toBeNull();
    const nativeSession = await resolveNativeShellSession(db, `Bearer ${exchanged?.accessToken}`, base.issuer, now + 10);
    expect(nativeSession).toEqual({ kind: 'native', id: exchanged?.sessionId, userId: 'owner-1' });
    expect(await revokeNativeShellSession(db, nativeSession!, now + 11)).toBe(true);
    expect(await resolveNativeShellSession(db, `Bearer ${exchanged?.accessToken}`, base.issuer, now + 12)).toBeNull();
  });

  it('normalizes action digests and binds grant consumption to session, host, action and request', async () => {
    expect(digestStepUpAction({ b: 2, a: { y: true, x: 'v' } }))
      .toBe(digestStepUpAction({ a: { x: 'v', y: true }, b: 2 }));
    expect(digestStepUpAction({ operation: 'disable_password' }))
      .not.toBe(digestStepUpAction({ operation: 'rotate_public_id' }));
  });

  it('binds mobile API-key step-up state to the current non-revoked key', async () => {
    const { db, state } = makeDb();
    const now = 1_700_000_000_000;
    const accountSession = createBearerAccountSession({
      userId: 'owner-1',
      bearerToken: 'deck_raw_key_never_persisted',
      apiKeyId: 'mobile-key-1',
    });
    expect(accountSession).toEqual({
      kind: 'web',
      id: 'remote-desktop-api-key:mobile-key-1',
      userId: 'owner-1',
    });

    await expect(storeStepUpChallenge(db, {
      accountSession,
      canonicalHostId: 'host-mobile',
      actionDigest: 'a'.repeat(64),
      requestId: opaque32(),
      challenge: opaque32(),
      rpId: 'im.codes',
      origin: 'https://app.im.codes',
      deadline: now + 60_000,
    }, now)).resolves.toMatchObject({ expiresAt: now + 60_000 });

    state.apiKeys.get('mobile-key-1')!.revokedAt = now + 1;
    await expect(storeStepUpChallenge(db, {
      accountSession,
      canonicalHostId: 'host-mobile',
      actionDigest: 'b'.repeat(64),
      requestId: opaque32(),
      challenge: opaque32(),
      rpId: 'im.codes',
      origin: 'https://app.im.codes',
      deadline: now + 60_000,
    }, now + 2)).rejects.toThrow('account_session_revoked');
  });
});

describe('remote desktop account auth migration', () => {
  it('persists only hashes for bearer-like credentials and enforces request uniqueness', () => {
    const sql = readFileSync(new URL('../src/db/migrations/074_remote_desktop_account_auth.sql', import.meta.url), 'utf8');
    expect(sql).toContain('remote_desktop_web_session_revocations');
    expect(sql).toContain('session_hash TEXT PRIMARY KEY');
    expect(sql).toContain('code_hash          TEXT NOT NULL UNIQUE');
    expect(sql).toContain('session_hash              TEXT NOT NULL UNIQUE');
    expect(sql).toContain('grant_hash             TEXT NOT NULL UNIQUE');
    expect(sql).toContain('UNIQUE(user_id, canonical_host_id, request_id)');
    expect(sql).not.toMatch(/\b(raw_code|raw_session|raw_grant|access_token)\b/);
  });

  it('wires exact browser-session revocation into the ordinary logout route', () => {
    const source = readFileSync(new URL('../src/routes/auth.ts', import.meta.url), 'utf8');
    expect(source).toContain('await revokeBrowserAccountSession(');
    expect(source.indexOf('await revokeBrowserAccountSession('))
      .toBeLessThan(source.indexOf("deleteCookie(c, COOKIE_SESSION", source.indexOf("authRoutes.post('/logout'")));
  });
});

describe('remote desktop action-bound step-up routes', () => {
  const signingKey = 'remote-desktop-account-auth-test-signing-key';
  let db: Database;
  let state: State;
  let app: Hono<{ Bindings: Env }>;
  let env: Env;
  let cookie: string;

  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthenticationResponseMock.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 8, userVerified: true },
    });
    ({ db, state } = makeDb());
    env = {
      DB: db, DATABASE_URL: '', JWT_SIGNING_KEY: signingKey, BOT_ENCRYPTION_KEY: '',
      SERVER_URL: 'https://app.im.codes', WEBAUTHN_RP_ID: 'im.codes', NODE_ENV: 'production',
    };
    app = new Hono<{ Bindings: Env }>();
    app.route('/api/auth/remote-desktop', remoteDesktopAccountAuthRoutes);
    cookie = `rcc_session=${encodeURIComponent(signJwt({ sub: 'owner-1' }, signingKey, 3600))}`;
  });

  it('does not accept node/local bearer authority for native authorization', async () => {
    const query = new URLSearchParams({
      client_id: REMOTE_DESKTOP_NATIVE_CLIENT.clientId,
      redirect_uri: REMOTE_DESKTOP_NATIVE_CLIENT.redirectUris[0],
      code_challenge: computePkceS256(opaque32()), code_challenge_method: 'S256', state: opaque32(),
    });
    const response = await app.request(`/api/auth/remote-desktop/native/authorize?${query}`, {
      headers: { authorization: 'Bearer controlled-node-credential' },
    }, env);
    expect(response.status).toBe(401);
    expect(state.authCodes.size).toBe(0);
  });

  it('requires WebAuthn UV and issues a grant bound to the initiating web session', async () => {
    const requestId = opaque32();
    const action = { operation: 'create_link', policy: { mode: 'control', expiresInSeconds: 3600 } };
    const begin = await app.request('/api/auth/remote-desktop/step-up/begin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ canonicalHostId: 'host-1', requestId, deadline: Date.now() + 60_000, action }),
    }, env);
    expect(begin.status).toBe(200);
    const begun = await begin.json() as { challengeId: string };
    expect(generateAuthenticationOptionsMock).toHaveBeenCalledWith(expect.objectContaining({
      rpID: 'im.codes', userVerification: 'required',
    }));

    const complete = await app.request('/api/auth/remote-desktop/step-up/complete', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: begun.challengeId, response: { id: 'cred-1' } }),
    }, env);
    expect(complete.status).toBe(200);
    const granted = await complete.json() as { grantToken: string };
    expect(verifyAuthenticationResponseMock).toHaveBeenCalledWith(expect.objectContaining({
      requireUserVerification: true,
      advancedFIDOConfig: { userVerification: 'required' },
    }));

    let calls = 0;
    const storedGrant = Array.from(state.grants.values())[0];
    const binding = {
      token: granted.grantToken,
      accountSession: { kind: 'web' as const, id: storedGrant.account_session_id, userId: storedGrant.user_id },
      canonicalHostId: 'host-1', action, requestId,
    };
    await expect(consumeActionBoundStepUpGrant(db, { ...binding, canonicalHostId: 'host-2' }, async () => ({ id: 'wrong' })))
      .resolves.toEqual({ ok: false, error: 'invalid_grant' });
    const first = await consumeActionBoundStepUpGrant(db, binding, async () => {
      calls += 1;
      return { linkId: 'link-1' };
    });
    const replay = await consumeActionBoundStepUpGrant(db, binding, async () => {
      calls += 1;
      return { linkId: 'link-2' };
    }, Date.now() + 10 * 60_000);
    expect(first).toEqual({ ok: true, replayed: false, result: { linkId: 'link-1' } });
    expect(replay).toEqual({ ok: true, replayed: true, result: { linkId: 'link-1' } });
    expect(calls).toBe(1);
  });

  it('keeps a native-session grant out of the browser and lets only its initiating bearer claim once', async () => {
    const now = Date.now();
    const verifier = opaque32();
    const authorizationState = opaque32();
    const issued = await issueNativeAuthorizationCode(db, {
      accountSession: webSession(),
      clientId: REMOTE_DESKTOP_NATIVE_CLIENT.clientId,
      redirectUri: REMOTE_DESKTOP_NATIVE_CLIENT.redirectUris[0],
      codeChallenge: computePkceS256(verifier),
      state: authorizationState,
      issuer: 'https://app.im.codes',
    }, now);
    const exchanged = await exchangeNativeAuthorizationCode(db, {
      code: issued.code,
      codeVerifier: verifier,
      state: authorizationState,
      clientId: REMOTE_DESKTOP_NATIVE_CLIENT.clientId,
      redirectUri: REMOTE_DESKTOP_NATIVE_CLIENT.redirectUris[0],
      issuer: 'https://app.im.codes',
      audience: REMOTE_DESKTOP_NATIVE_CLIENT.audience,
    }, now + 1);
    expect(exchanged).not.toBeNull();
    const bearer = `Bearer ${exchanged!.accessToken}`;
    const begin = await app.request('/api/auth/remote-desktop/step-up/begin', {
      method: 'POST',
      headers: { authorization: bearer, 'content-type': 'application/json' },
      body: JSON.stringify({
        canonicalHostId: 'host-1', requestId: opaque32(), deadline: now + 60_000,
        action: { hostId: 'host-1', kind: 'remote_desktop.public_id.rotate' },
      }),
    }, env);
    expect(begin.status).toBe(200);
    const begun = await begin.json() as { challengeId: string };

    const browserGrantAttempt = await app.request('/api/auth/remote-desktop/step-up/complete', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: begun.challengeId, response: { id: 'cred-1' } }),
    }, env);
    expect(browserGrantAttempt.status).toBe(400);
    expect(state.grants.size).toBe(0);

    const browserCompletion = await app.request('/api/auth/remote-desktop/step-up/complete-native', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: begun.challengeId, response: { id: 'cred-1' } }),
    }, env);
    expect(browserCompletion.status).toBe(200);
    expect(await browserCompletion.json()).toEqual({ status: 'verified' });
    expect(state.grants.size).toBe(0);

    const cookieClaim = await app.request('/api/auth/remote-desktop/step-up/native/claim', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: begun.challengeId }),
    }, env);
    expect(cookieClaim.status).toBe(400);

    const nativeClaim = await app.request('/api/auth/remote-desktop/step-up/native/claim', {
      method: 'POST', headers: { authorization: bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: begun.challengeId }),
    }, env);
    expect(nativeClaim.status).toBe(200);
    const grant = await nativeClaim.json() as { grantToken: string };
    expect(grant.grantToken).toMatch(/^rdsg_[A-Za-z0-9_-]{43}$/);
    expect(state.grants.size).toBe(1);

    const replay = await app.request('/api/auth/remote-desktop/step-up/native/claim', {
      method: 'POST', headers: { authorization: bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: begun.challengeId }),
    }, env);
    expect(replay.status).toBe(409);
  });

  it('requires a fresh native grant for every Owner mutation and rejects cross-action reuse', async () => {
    const now = Date.now();
    const verifier = opaque32();
    const authorizationState = opaque32();
    const issued = await issueNativeAuthorizationCode(db, {
      accountSession: webSession(),
      clientId: REMOTE_DESKTOP_NATIVE_CLIENT.clientId,
      redirectUri: REMOTE_DESKTOP_NATIVE_CLIENT.redirectUris[0],
      codeChallenge: computePkceS256(verifier),
      state: authorizationState,
      issuer: 'https://app.im.codes',
    }, now);
    const exchanged = await exchangeNativeAuthorizationCode(db, {
      code: issued.code,
      codeVerifier: verifier,
      state: authorizationState,
      clientId: REMOTE_DESKTOP_NATIVE_CLIENT.clientId,
      redirectUri: REMOTE_DESKTOP_NATIVE_CLIENT.redirectUris[0],
      issuer: 'https://app.im.codes',
      audience: REMOTE_DESKTOP_NATIVE_CLIENT.audience,
    }, now + 1);
    expect(exchanged).not.toBeNull();
    const bearer = `Bearer ${exchanged!.accessToken}`;
    const accountSession = {
      kind: 'native' as const, id: exchanged!.sessionId, userId: 'owner-1',
    };
    const hostId = 'host-1';
    const linkId = 'link_00000000001';
    const cases = [
      {
        label: 'public-id rotate',
        requestId: opaque32(),
        action: { kind: 'remote_desktop.public_id.rotate', hostId },
      },
      {
        label: 'link create',
        requestId: opaque32(),
        action: {
          kind: 'remote_desktop.link.create', hostId,
          creationRequestId: opaque32(), tokenHash: 'a'.repeat(64), policyHash: 'b'.repeat(64),
        },
      },
      {
        label: 'link reduce',
        requestId: opaque32(),
        action: {
          kind: 'remote_desktop.link.mutate', hostId, linkId,
          mutation: 'reduce_to_view', label: null, expiresAt: null,
        },
      },
      {
        label: 'link revoke',
        requestId: opaque32(),
        action: {
          kind: 'remote_desktop.link.mutate', hostId, linkId,
          mutation: 'revoke', label: null, expiresAt: null,
        },
      },
      {
        label: 'password set',
        requestId: opaque32(),
        action: {
          type: 'remote_desktop.unattended_password.mutation.v1', hostId,
          action: 'set', requestId: '',
        },
      },
      {
        label: 'password change',
        requestId: opaque32(),
        action: {
          type: 'remote_desktop.unattended_password.mutation.v1', hostId,
          action: 'change', requestId: '',
        },
      },
      {
        label: 'password disable',
        requestId: opaque32(),
        action: {
          type: 'remote_desktop.unattended_password.mutation.v1', hostId,
          action: 'disable', requestId: '',
        },
      },
    ].map((entry) => ({
      ...entry,
      action: entry.action.type === 'remote_desktop.unattended_password.mutation.v1'
        ? { ...entry.action, requestId: entry.requestId }
        : entry.action,
    }));

    const tokens: string[] = [];
    for (const [index, entry] of cases.entries()) {
      verifyAuthenticationResponseMock.mockResolvedValueOnce({
        verified: true,
        authenticationInfo: { newCounter: 10 + index, userVerified: true },
      });
      const begin = await app.request('/api/auth/remote-desktop/step-up/begin', {
        method: 'POST', headers: { authorization: bearer, 'content-type': 'application/json' },
        body: JSON.stringify({
          canonicalHostId: hostId,
          requestId: entry.requestId,
          deadline: now + 60_000,
          action: entry.action,
        }),
      }, env);
      expect(begin.status, entry.label).toBe(200);
      const begun = await begin.json() as { challengeId: string };

      const verified = await app.request('/api/auth/remote-desktop/step-up/complete-native', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: begun.challengeId, response: { id: 'cred-1' } }),
      }, env);
      expect(verified.status, entry.label).toBe(200);
      expect(await verified.json()).toEqual({ status: 'verified' });

      const claim = await app.request('/api/auth/remote-desktop/step-up/native/claim', {
        method: 'POST', headers: { authorization: bearer, 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: begun.challengeId }),
      }, env);
      expect(claim.status, entry.label).toBe(200);
      const { grantToken } = await claim.json() as { grantToken: string };
      tokens.push(grantToken);

      const claimReplay = await app.request('/api/auth/remote-desktop/step-up/native/claim', {
        method: 'POST', headers: { authorization: bearer, 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: begun.challengeId }),
      }, env);
      expect(claimReplay.status, entry.label).toBe(409);

      const wrongAction = cases[(index + 1) % cases.length]!.action;
      await expect(consumeActionBoundStepUpGrant(db, {
        token: grantToken,
        accountSession,
        canonicalHostId: hostId,
        action: wrongAction,
        requestId: entry.requestId,
      }, async () => ({ action: 'must-not-run' }))).resolves.toEqual({
        ok: false, error: 'invalid_grant',
      });

      const first = await consumeActionBoundStepUpGrant(db, {
        token: grantToken,
        accountSession,
        canonicalHostId: hostId,
        action: entry.action,
        requestId: entry.requestId,
      }, async () => ({ action: entry.label }));
      expect(first).toEqual({
        ok: true, replayed: false, result: { action: entry.label },
      });

      // Exact request recovery is intentionally idempotent; it is not a fresh
      // authorization and cannot be redirected to another action.
      const exactRetry = await consumeActionBoundStepUpGrant(db, {
        token: grantToken,
        accountSession,
        canonicalHostId: hostId,
        action: entry.action,
        requestId: entry.requestId,
      }, async () => ({ action: 'must-not-reapply' }));
      expect(exactRetry).toEqual({
        ok: true, replayed: true, result: { action: entry.label },
      });
    }
    expect(new Set(tokens).size).toBe(cases.length);
  });

  it('does not burn a grant when the protected mutation rolls back', async () => {
    const requestId = opaque32();
    const action = { operation: 'disable_password' };
    const begin = await app.request('/api/auth/remote-desktop/step-up/begin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ canonicalHostId: 'host-1', requestId, deadline: Date.now() + 60_000, action }),
    }, env);
    const begun = await begin.json() as { challengeId: string };
    const complete = await app.request('/api/auth/remote-desktop/step-up/complete', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: begun.challengeId, response: { id: 'cred-1' } }),
    }, env);
    const granted = await complete.json() as { grantToken: string };
    const storedGrant = Array.from(state.grants.values())[0];
    const binding = {
      token: granted.grantToken,
      accountSession: { kind: 'web' as const, id: storedGrant.account_session_id, userId: storedGrant.user_id },
      canonicalHostId: 'host-1', action, requestId,
    };

    await expect(consumeActionBoundStepUpGrant(db, binding, async () => {
      throw new Error('mutation failed');
    })).rejects.toThrow('mutation failed');
    await expect(consumeActionBoundStepUpGrant(db, binding, async () => ({ disabled: true })))
      .resolves.toEqual({ ok: true, replayed: false, result: { disabled: true } });
  });

  it('rejects a verified assertion when UV is absent', async () => {
    verifyAuthenticationResponseMock.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter: 8, userVerified: false },
    });
    const begin = await app.request('/api/auth/remote-desktop/step-up/begin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        canonicalHostId: 'host-1', requestId: opaque32(), deadline: Date.now() + 60_000,
        action: { operation: 'rotate_public_id' },
      }),
    }, env);
    const begun = await begin.json() as { challengeId: string };
    const complete = await app.request('/api/auth/remote-desktop/step-up/complete', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: begun.challengeId, response: { id: 'cred-1' } }),
    }, env);
    expect(complete.status).toBe(400);
    expect(state.grants.size).toBe(0);
  });

  it('revokes the exact browser session and invalidates its pending code and step-up grant', async () => {
    const requestId = opaque32();
    const action = { operation: 'create_link', policy: { mode: 'view' } };
    const begin = await app.request('/api/auth/remote-desktop/step-up/begin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ canonicalHostId: 'host-1', requestId, deadline: Date.now() + 60_000, action }),
    }, env);
    const begun = await begin.json() as { challengeId: string };
    const complete = await app.request('/api/auth/remote-desktop/step-up/complete', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: begun.challengeId, response: { id: 'cred-1' } }),
    }, env);
    const granted = await complete.json() as { grantToken: string };
    const accountSession = await resolveBrowserAccountSession(db, signingKey, cookie);
    expect(accountSession).not.toBeNull();

    const verifier = opaque32();
    await issueNativeAuthorizationCode(db, {
      accountSession: accountSession!,
      clientId: REMOTE_DESKTOP_NATIVE_CLIENT.clientId,
      redirectUri: REMOTE_DESKTOP_NATIVE_CLIENT.redirectUris[0],
      codeChallenge: computePkceS256(verifier),
      state: opaque32(),
      issuer: 'https://app.im.codes',
    });
    expect(state.authCodes.size).toBe(1);

    expect(await revokeBrowserAccountSession(db, signingKey, cookie)).toBe(true);
    expect(await resolveBrowserAccountSession(db, signingKey, cookie)).toBeNull();
    expect(state.authCodes.size).toBe(0);
    await expect(consumeActionBoundStepUpGrant(db, {
      token: granted.grantToken,
      accountSession: accountSession!,
      canonicalHostId: 'host-1',
      action,
      requestId,
    }, async () => ({ linkId: 'must-not-run' }))).resolves.toEqual({ ok: false, error: 'invalid_grant' });
  });

  it('rejects a passkey completion when its stored counter changes after verification begins', async () => {
    const begin = await app.request('/api/auth/remote-desktop/step-up/begin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        canonicalHostId: 'host-1', requestId: opaque32(), deadline: Date.now() + 60_000,
        action: { operation: 'disable_password' },
      }),
    }, env);
    const begun = await begin.json() as { challengeId: string };
    verifyAuthenticationResponseMock.mockImplementationOnce(async () => {
      state.credentials.get('cred-1')!.counter = 9;
      return { verified: true, authenticationInfo: { newCounter: 10, userVerified: true } };
    });
    const complete = await app.request('/api/auth/remote-desktop/step-up/complete', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: begun.challengeId, response: { id: 'cred-1' } }),
    }, env);
    expect(complete.status).toBe(400);
    expect(state.credentials.get('cred-1')?.counter).toBe(9);
    expect(state.grants.size).toBe(0);
  });
});
