import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/db/client.js';
import { verifyAndBindExternalShareDevice } from '../src/db/document-sharing.js';
import type { Env } from '../src/env.js';
import { buildApp } from '../src/index.js';
import { sha256Hex, signJwt } from '../src/security/crypto.js';

// Deterministic minimal CBOR encoder for COSE EC2 keys and fmt:"none" attestation objects.
function encodeCborUint(majorType: number, value: number): Buffer {
  const mt = majorType << 5;
  if (value < 24) return Buffer.from([mt | value]);
  if (value < 0x100) return Buffer.from([mt | 24, value]);
  if (value < 0x10000) {
    const out = Buffer.alloc(3);
    out[0] = mt | 25;
    out.writeUInt16BE(value, 1);
    return out;
  }
  const out = Buffer.alloc(5);
  out[0] = mt | 26;
  out.writeUInt32BE(value, 1);
  return out;
}

function encodeCborInt(value: number): Buffer {
  return value >= 0 ? encodeCborUint(0, value) : encodeCborUint(1, -1 - value);
}

function encodeCborBytes(bytes: Buffer): Buffer {
  return Buffer.concat([encodeCborUint(2, bytes.length), bytes]);
}

function encodeCborText(text: string): Buffer {
  const utf8 = Buffer.from(text, 'utf8');
  return Buffer.concat([encodeCborUint(3, utf8.length), utf8]);
}

function encodeCborMap(entries: Array<[Buffer, Buffer]>): Buffer {
  return Buffer.concat([
    encodeCborUint(5, entries.length),
    ...entries.flatMap(([k, v]) => [k, v]),
  ]);
}

function createEs256Authenticator(credentialIdBytes = randomBytes(32)) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const cosePublicKey = encodeCborMap([
    [encodeCborInt(1), encodeCborInt(2)],   // kty: EC2
    [encodeCborInt(3), encodeCborInt(-7)],  // alg: ES256
    [encodeCborInt(-1), encodeCborInt(1)],  // crv: P-256
    [encodeCborInt(-2), encodeCborBytes(Buffer.from(jwk.x, 'base64url'))],
    [encodeCborInt(-3), encodeCborBytes(Buffer.from(jwk.y, 'base64url'))],
  ]);

  const credentialId = credentialIdBytes.toString('base64url');
  const publicKeyBase64 = cosePublicKey.toString('base64');

  function makeRegistrationResponse(opts: { challenge: string; origin: string; rpId: string; signCount?: number }) {
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.create',
      challenge: opts.challenge,
      origin: opts.origin,
      crossOrigin: false,
    }), 'utf8');
    const rpIdHash = createHash('sha256').update(opts.rpId).digest();
    const flags = Buffer.from([0x45]); // UP | UV | AT
    const counterBuf = Buffer.alloc(4);
    counterBuf.writeUInt32BE(opts.signCount ?? 0, 0);
    const aaguid = Buffer.alloc(16, 0);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(credentialIdBytes.length, 0);
    const authData = Buffer.concat([rpIdHash, flags, counterBuf, aaguid, idLen, credentialIdBytes, cosePublicKey]);
    const attestationObject = encodeCborMap([
      [encodeCborText('fmt'), encodeCborText('none')],
      [encodeCborText('attStmt'), encodeCborMap([])],
      [encodeCborText('authData'), encodeCborBytes(authData)],
    ]);
    return {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key' as const,
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: {},
    };
  }

  function makeAuthenticationResponse(opts: {
    challenge: string;
    origin: string;
    rpId: string;
    signCount: number;
    userVerified?: boolean;
  }) {
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.get',
      challenge: opts.challenge,
      origin: opts.origin,
      crossOrigin: false,
    }), 'utf8');
    const rpIdHash = createHash('sha256').update(opts.rpId).digest();
    const flags = Buffer.from([opts.userVerified === false ? 0x01 : 0x05]); // UP (+ UV)
    const counterBuf = Buffer.alloc(4);
    counterBuf.writeUInt32BE(opts.signCount, 0);
    const authenticatorData = Buffer.concat([rpIdHash, flags, counterBuf]);
    const clientDataHash = createHash('sha256').update(clientDataJSON).digest();
    const signature = cryptoSign('sha256', Buffer.concat([authenticatorData, clientDataHash]), privateKey);

    return {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key' as const,
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authenticatorData.toString('base64url'),
        signature: signature.toString('base64url'),
      },
      clientExtensionResults: {},
    };
  }

  return {
    credentialId,
    publicKeyBase64,
    makeRegistrationResponse,
    makeAuthenticationResponse,
  };
}

function makeInMemoryDb() {
  const users = new Map<string, {
    id: string;
    username: string | null;
    display_name: string | null;
    password_hash: string | null;
    password_must_change: boolean | null;
    is_admin: boolean;
    status: string;
    sessions_valid_after: number;
    created_at: number;
  }>();
  const passkeys = new Map<string, {
    id: string;
    user_id: string;
    public_key: string;
    counter: number;
    device_name: string | null;
    transports: string | null;
    created_at: number;
    last_used_at: number | null;
  }>();
  const challenges = new Map<string, {
    id: string;
    challenge: string;
    user_id: string | null;
    display_name: string;
    expires_at: number;
    created_at: number;
  }>();
  const refreshTokens = new Map<string, unknown>();
  const settings = new Map<string, string>();
  const stepUpChallenges = new Map<string, {
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
    native_claimed_at: number | null;
    consumed_at: number | null;
    created_at: number;
  }>();
  const stepUpGrants = new Map<string, unknown>();
  const docShares = new Map<string, Record<string, unknown>>();
  const accountSessions = new Map<string, {
    id: string;
    user_id: string;
    session_hash: string;
    device_label: string;
    expires_at: number;
    revoked_at: number | null;
    created_at: number;
  }>();

  const db: Database = {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (sql.includes('SELECT id FROM passkey_credentials WHERE user_id = $1')) {
        return [...passkeys.values()].filter((p) => p.user_id === params[0]).map((p) => ({ id: p.id })) as T[];
      }
      return [];
    },
    async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
      const norm = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (norm.startsWith('select pg_advisory_xact_lock')) {
        return { locked: null } as T;
      }
      if (norm.includes('from users as account') && norm.includes('remote_desktop_web_session_revocations')) {
        const u = users.get(String(params[0]));
        return (u && u.status === 'active' ? { id: u.id } : null) as T | null;
      }
      if (sql.includes('FROM account_sessions') && sql.includes('session_hash = $1')) {
        const s = [...accountSessions.values()].find((r) => r.session_hash === params[0] && r.revoked_at === null);
        return (s ?? null) as T | null;
      }
      if (sql.includes('FROM users WHERE id = $1')) {
        return (users.get(String(params[0])) ?? null) as T | null;
      }
      if (sql.includes('FROM users WHERE LOWER(username) = LOWER($1)')) {
        const target = String(params[0]).toLowerCase();
        return ([...users.values()].find((u) => u.username?.toLowerCase() === target) ?? null) as T | null;
      }
      if (norm.includes('from passkey_credentials') && norm.includes('where id = $1 and user_id = $2')) {
        const row = passkeys.get(String(params[0]));
        return (row && row.user_id === params[1] ? { ...row } : null) as T | null;
      }
      if (norm.includes('from passkey_credentials') && norm.includes('where id = $1')) {
        const row = passkeys.get(String(params[0]));
        return (row ? { ...row } : null) as T | null;
      }
      if (sql.includes('DELETE FROM passkey_challenges WHERE id = $1')) {
        const ch = challenges.get(String(params[0]));
        if (!ch || ch.expires_at <= Number(params[1])) return null;
        challenges.delete(ch.id);
        return ch as unknown as T;
      }
      if (sql.includes('FROM passkey_challenges WHERE id = $1')) {
        const ch = challenges.get(String(params[0]));
        if (!ch || ch.expires_at <= Number(params[1])) return null;
        return ch as unknown as T;
      }
      if (sql.includes('FROM settings WHERE key = $1')) {
        const val = settings.get(String(params[0]));
        return val === undefined ? null : ({ value: val } as T);
      }
      if (norm.startsWith('select') && norm.includes('from remote_desktop_step_up_challenges')) {
        const ch = stepUpChallenges.get(String(params[0]));
        return (ch ?? null) as T | null;
      }
      if (norm.startsWith('delete from remote_desktop_step_up_challenges')) {
        const ch = stepUpChallenges.get(String(params[0]));
        if (!ch || ch.user_id !== params[1]) return null;
        stepUpChallenges.delete(ch.id);
        return ch as unknown as T;
      }
      if (sql.includes('FROM document_shares ds') && sql.includes('ds.share_token_hash = $1')) {
        const row = [...docShares.values()].find((r) => r.share_token_hash === params[0]);
        return (row ?? null) as T | null;
      }
      if (sql.includes('UPDATE document_shares') && sql.includes('bound_device_hash = $1')) {
        const row = docShares.get(String(params[2]));
        if (!row || row.bound_device_hash !== null) return null;
        row.bound_device_hash = params[0];
        row.updated_at = params[1];
        return row as T;
      }
      if (sql.includes('FROM document_shares ds') && sql.includes('ds.id = $1')) {
        return (docShares.get(String(params[0])) ?? null) as T | null;
      }
      return null;
    },
    async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
      if (sql.includes('INSERT INTO passkey_challenges')) {
        challenges.set(String(params[0]), {
          id: String(params[0]),
          challenge: String(params[1]),
          user_id: (params[2] as string | null) ?? null,
          display_name: String(params[3]),
          expires_at: Number(params[4]),
          created_at: Number(params[5]),
        });
        return { changes: 1 };
      }
      if (sql.includes('DELETE FROM passkey_challenges WHERE id = $1')) {
        const id = String(params[0]);
        const ch = challenges.get(id);
        if (!ch) return { changes: 0 };
        if (sql.includes('expires_at > $2') && ch.expires_at <= Number(params[1])) return { changes: 0 };
        if (sql.includes('user_id = $3') && ch.user_id !== params[2]) return { changes: 0 };
        challenges.delete(id);
        return { changes: 1 };
      }
      if (sql.includes('DELETE FROM passkey_challenges WHERE expires_at < $1')) {
        return { changes: 0 };
      }
      if (sql.includes('INSERT INTO users')) {
        users.set(String(params[0]), {
          id: String(params[0]),
          username: null,
          display_name: null,
          password_hash: null,
          password_must_change: false,
          is_admin: false,
          status: 'active',
          sessions_valid_after: 0,
          created_at: Number(params[1]),
        });
        return { changes: 1 };
      }
      if (sql.includes('UPDATE users SET display_name = $1 WHERE id = $2')) {
        const u = users.get(String(params[1]));
        if (u) u.display_name = String(params[0]);
        return { changes: u ? 1 : 0 };
      }
      if (sql.includes('UPDATE users SET username = $1, password_hash = $2, password_must_change = false WHERE id = $3')) {
        const u = users.get(String(params[2]));
        if (!u) return { changes: 0 };
        u.username = String(params[0]);
        u.password_hash = String(params[1]);
        u.password_must_change = false;
        return { changes: 1 };
      }
      if (sql.includes('INSERT INTO passkey_credentials')) {
        passkeys.set(String(params[0]), {
          id: String(params[0]),
          user_id: String(params[1]),
          public_key: String(params[2]),
          counter: Number(params[3]),
          device_name: (params[4] as string | null) ?? null,
          transports: (params[5] as string | null) ?? null,
          created_at: Number(params[6]),
          last_used_at: null,
        });
        return { changes: 1 };
      }
      const norm = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (norm.startsWith('update passkey_credentials set counter = $1')) {
        if (norm.includes('where id = $3 and user_id = $4 and counter = $5')) {
          const p = passkeys.get(String(params[2]));
          if (!p || p.user_id !== params[3] || p.counter !== Number(params[4])) return { changes: 0 };
          p.counter = Number(params[0]);
          p.last_used_at = Number(params[1]);
          return { changes: 1 };
        }
        if (norm.includes('where id = $3 and counter = $4')) {
          const p = passkeys.get(String(params[2]));
          if (!p || p.counter !== Number(params[3])) return { changes: 0 };
          p.counter = Number(params[0]);
          p.last_used_at = Number(params[1]);
          return { changes: 1 };
        }
        const p = passkeys.get(String(params[2]));
        if (!p) return { changes: 0 };
        p.counter = Number(params[0]);
        p.last_used_at = Number(params[1]);
        return { changes: 1 };
      }
      if (sql.includes('INSERT INTO refresh_tokens')) {
        refreshTokens.set(String(params[0]), params);
        return { changes: 1 };
      }
      if (sql.includes('INSERT INTO account_sessions')) {
        accountSessions.set(String(params[0]), {
          id: String(params[0]),
          user_id: String(params[1]),
          session_hash: String(params[2]),
          device_label: String(params[3]),
          expires_at: Number(params[4]),
          revoked_at: null,
          created_at: Number(params[5]),
        });
        return { changes: 1 };
      }
      if (sql.includes('INSERT INTO remote_desktop_step_up_challenges')) {
        stepUpChallenges.set(String(params[0]), {
          id: String(params[0]),
          user_id: String(params[1]),
          account_session_kind: params[2] as 'web' | 'native',
          account_session_id: String(params[3]),
          canonical_host_id: String(params[4]),
          action_digest: String(params[5]),
          request_id: String(params[6]),
          challenge: String(params[7]),
          rp_id: String(params[8]),
          origin: String(params[9]),
          deadline: Number(params[10]),
          expires_at: Number(params[11]),
          native_verified_at: null,
          native_claimed_at: null,
          consumed_at: null,
          created_at: Number(params[12]),
        });
        return { changes: 1 };
      }
      if (sql.includes('INSERT INTO remote_desktop_step_up_grants')) {
        stepUpGrants.set(String(params[0]), params);
        return { changes: 1 };
      }
      return { changes: 0 };
    },
    async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      return fn(db);
    },
    async close() {},
  };

  return { db, users, passkeys, challenges, docShares };
}

function makeEnv(db: Database): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: 'test-jwt-signing-key-32-bytes-long!!',
    BOT_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    SERVER_URL: 'https://app.im.codes',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'production',
    DATABASE_URL: '',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    WEBAUTHN_RP_ID: 'app.im.codes',
    ALLOWED_ORIGINS: 'https://app.im.codes',
  };
}

describe('@simplewebauthn/server v14 real crypto & stored DB credentials', () => {
  it('registers a real WebAuthn credential, persists it, and logs in with real signature verification', async () => {
    const store = makeInMemoryDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);
    const authn = createEs256Authenticator();

    const regBegin = await app.request('/api/auth/passkey/register/begin', {
      method: 'POST',
      headers: { host: 'app.im.codes', 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Real Passkey User' }),
    });
    expect(regBegin.status).toBe(200);
    const regOpts = await regBegin.json() as {
      challenge: string;
      challengeId: string;
      rp: { id: string };
      user: { id: string; name: string; displayName: string };
    };
    expect(regOpts.rp.id).toBe('app.im.codes');
    expect(typeof regOpts.user.id).toBe('string');

    const regResp = authn.makeRegistrationResponse({
      challenge: regOpts.challenge,
      origin: 'https://app.im.codes',
      rpId: 'app.im.codes',
    });
    const regComplete = await app.request('/api/auth/passkey/register/complete', {
      method: 'POST',
      headers: { host: 'app.im.codes', 'content-type': 'application/json' },
      body: JSON.stringify({
        challengeId: regOpts.challengeId,
        response: regResp,
        deviceName: 'MacBook Touch ID',
      }),
    });
    expect(regComplete.status).toBe(200);
    const regBody = await regComplete.json() as { ok: boolean; userId: string };
    expect(regBody.ok).toBe(true);

    const saved = store.passkeys.get(authn.credentialId);
    expect(saved).toBeDefined();
    expect(saved?.public_key).toBe(authn.publicKeyBase64);
    expect(saved?.counter).toBe(0);

    const loginBegin = await app.request('/api/auth/passkey/login/begin', {
      method: 'POST',
      headers: { host: 'app.im.codes', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(loginBegin.status).toBe(200);
    const loginOpts = await loginBegin.json() as { challenge: string; challengeId: string };

    const loginResp = authn.makeAuthenticationResponse({
      challenge: loginOpts.challenge,
      origin: 'https://app.im.codes',
      rpId: 'app.im.codes',
      signCount: 1,
    });
    const loginComplete = await app.request('/api/auth/passkey/login/complete', {
      method: 'POST',
      headers: { host: 'app.im.codes', 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: loginOpts.challengeId, response: loginResp }),
    });
    expect(loginComplete.status).toBe(200);
    expect(store.passkeys.get(authn.credentialId)?.counter).toBe(1);
  });

  it('verifies pre-existing stored passkey DB rows across passkey-auth, document-sharing, and remote-desktop step-up', async () => {
    const store = makeInMemoryDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);

    const authn = createEs256Authenticator();
    const now = Date.now();
    store.users.set('user-legacy-1', {
      id: 'user-legacy-1',
      username: null,
      display_name: 'Legacy User',
      password_hash: null,
      password_must_change: false,
      is_admin: false,
      status: 'active',
      sessions_valid_after: 0,
      created_at: now,
    });
    store.passkeys.set(authn.credentialId, {
      id: authn.credentialId,
      user_id: 'user-legacy-1',
      public_key: authn.publicKeyBase64,
      counter: 5,
      device_name: 'Existing DB Passkey',
      transports: JSON.stringify(['internal', 'hybrid']),
      created_at: now - 86_400_000,
      last_used_at: null,
    });

    // 1. passkey-auth /login/complete with stored DB row (counter 5 -> 6)
    const loginBegin = await app.request('/api/auth/passkey/login/begin', {
      method: 'POST',
      headers: { host: 'app.im.codes', 'content-type': 'application/json' },
      body: '{}',
    });
    const loginOpts = await loginBegin.json() as { challenge: string; challengeId: string };
    const loginRes = await app.request('/api/auth/passkey/login/complete', {
      method: 'POST',
      headers: { host: 'app.im.codes', 'content-type': 'application/json' },
      body: JSON.stringify({
        challengeId: loginOpts.challengeId,
        response: authn.makeAuthenticationResponse({
          challenge: loginOpts.challenge,
          origin: 'https://app.im.codes',
          rpId: 'app.im.codes',
          signCount: 6,
        }),
      }),
    });
    expect(loginRes.status).toBe(200);
    expect(store.passkeys.get(authn.credentialId)?.counter).toBe(6);

    // 2. document-sharing verifyAndBindExternalShareDevice with stored DB row (counter 6 -> 7)
    const rawShareToken = 'share-secret-token-123';
    store.docShares.set('share-1', {
      id: 'share-1',
      server_id: 'srv-1',
      target_kind: 'file',
      target_path: '/doc.docx',
      label: null,
      share_mode: 'external_link',
      target_user_id: '*',
      target_username: null,
      target_display_name: null,
      target_team_name: null,
      participant_label: 'Guest',
      share_token_hash: sha256Hex(rawShareToken),
      access_code_hash: null,
      device_lock_enabled: true,
      bound_device_hash: null,
      redeemed_by_user_id: null,
      redeemed_at: null,
      role: 'viewer',
      allow_download: true,
      created_by: 'user-legacy-1',
      created_at: now,
      updated_at: now,
      expires_at: null,
      revoked_at: null,
    });
    store.challenges.set('doc-ch-1', {
      id: 'doc-ch-1',
      challenge: 'doc-challenge-value',
      user_id: null,
      display_name: '',
      expires_at: now + 60_000,
      created_at: now,
    });
    const docResult = await verifyAndBindExternalShareDevice(store.db, {
      rawToken: rawShareToken,
      passkeyChallengeId: 'doc-ch-1',
      passkeyResponse: authn.makeAuthenticationResponse({
        challenge: 'doc-challenge-value',
        origin: 'https://app.im.codes',
        rpId: 'app.im.codes',
        signCount: 7,
      }) as unknown as Record<string, unknown>,
      rpId: 'app.im.codes',
      origin: 'https://app.im.codes',
      now,
    });
    expect(docResult.ok).toBe(true);
    if (docResult.ok) {
      expect(docResult.deviceToken.startsWith('pkey_')).toBe(true);
    }
    expect(store.passkeys.get(authn.credentialId)?.counter).toBe(7);

    // 3. remote-desktop-account-auth step-up requires UV=1 and verifies stored DB row (counter 7 -> 8)
    const cookieHeader = `rcc_session=${encodeURIComponent(signJwt({ sub: 'user-legacy-1' }, env.JWT_SIGNING_KEY, 3600))}; rcc_csrf=csrf-tok`;
    const stepUpBegin = await app.request('/api/auth/remote-desktop/step-up/begin', {
      method: 'POST',
      headers: { host: 'app.im.codes', origin: 'https://app.im.codes', cookie: cookieHeader, 'x-csrf-token': 'csrf-tok', 'content-type': 'application/json' },
      body: JSON.stringify({
        canonicalHostId: 'host-1',
        requestId: randomBytes(32).toString('base64url'),
        deadline: Date.now() + 60_000,
        action: { operation: 'create_link', policy: { mode: 'control', expiresInSeconds: 3600 } },
      }),
    });
    expect(stepUpBegin.status).toBe(200);
    const stepUpOpts = await stepUpBegin.json() as { challenge: string; challengeId: string };

    // UV=0 assertion must fail
    const noUvRes = await app.request('/api/auth/remote-desktop/step-up/complete', {
      method: 'POST',
      headers: { host: 'app.im.codes', origin: 'https://app.im.codes', cookie: cookieHeader, 'x-csrf-token': 'csrf-tok', 'content-type': 'application/json' },
      body: JSON.stringify({
        challengeId: stepUpOpts.challengeId,
        response: authn.makeAuthenticationResponse({
          challenge: stepUpOpts.challenge,
          origin: 'https://app.im.codes',
          rpId: 'app.im.codes',
          signCount: 8,
          userVerified: false,
        }),
      }),
    });
    expect(noUvRes.status).toBe(400);

    // UV=1 assertion succeeds
    const uvRes = await app.request('/api/auth/remote-desktop/step-up/complete', {
      method: 'POST',
      headers: { host: 'app.im.codes', origin: 'https://app.im.codes', cookie: cookieHeader, 'x-csrf-token': 'csrf-tok', 'content-type': 'application/json' },
      body: JSON.stringify({
        challengeId: stepUpOpts.challengeId,
        response: authn.makeAuthenticationResponse({
          challenge: stepUpOpts.challenge,
          origin: 'https://app.im.codes',
          rpId: 'app.im.codes',
          signCount: 8,
          userVerified: true,
        }),
      }),
    });
    expect(uvRes.status).toBe(200);
    const grant = await uvRes.json() as { grantToken: string };
    expect(typeof grant.grantToken).toBe('string');
    expect(store.passkeys.get(authn.credentialId)?.counter).toBe(8);

    // 4. passkey-auth /password/setup with stored DB row (counter 8 -> 9)
    const jwt = signJwt({ sub: 'user-legacy-1' }, env.JWT_SIGNING_KEY, 3600);
    const verifyBegin = await app.request('/api/auth/passkey/verify/begin', {
      method: 'POST',
      headers: { host: 'app.im.codes', Authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(verifyBegin.status).toBe(200);
    const verifyOpts = await verifyBegin.json() as { challenge: string; challengeId: string };
    const setupRes = await app.request('/api/auth/passkey/password/setup', {
      method: 'POST',
      headers: { host: 'app.im.codes', Authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'legacyuser',
        newPassword: 'Strong-Password-123!',
        challengeId: verifyOpts.challengeId,
        response: authn.makeAuthenticationResponse({
          challenge: verifyOpts.challenge,
          origin: 'https://app.im.codes',
          rpId: 'app.im.codes',
          signCount: 9,
        }),
      }),
    });
    expect(setupRes.status).toBe(200);
    expect(store.passkeys.get(authn.credentialId)?.counter).toBe(9);
  });

  it('preserves Zod v4 validation contracts for step-up action records and quick-data flatten detail', async () => {
    const store = makeInMemoryDb();
    const env = makeEnv(store.db);
    const app = buildApp(env);

    const now = Date.now();
    store.users.set('user-zod', {
      id: 'user-zod',
      username: 'zuser',
      display_name: 'Zod User',
      password_hash: null,
      password_must_change: false,
      is_admin: false,
      status: 'active',
      sessions_valid_after: 0,
      created_at: now,
    });
    const cookieHeader = `rcc_session=${encodeURIComponent(signJwt({ sub: 'user-zod' }, env.JWT_SIGNING_KEY, 3600))}; rcc_csrf=csrf-tok`;

    // Reject non-record action (string instead of record)
    const badAction = await app.request('/api/auth/remote-desktop/step-up/begin', {
      method: 'POST',
      headers: { host: 'app.im.codes', origin: 'https://app.im.codes', cookie: cookieHeader, 'x-csrf-token': 'csrf-tok', 'content-type': 'application/json' },
      body: JSON.stringify({
        canonicalHostId: 'host-1',
        requestId: randomBytes(32).toString('base64url'),
        deadline: now + 60_000,
        action: 'not-an-object',
      }),
    });
    expect(badAction.status).toBe(400);
    expect(await badAction.json()).toEqual({ error: 'invalid_step_up_request' });

    // Preserve quick-data 400 error shape with detail.fieldErrors from parsed.error.flatten()
    const jwt = signJwt({ sub: 'user-zod' }, env.JWT_SIGNING_KEY, 3600);
    const badQuickData = await app.request('/api/quick-data', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        history: 'invalid-should-be-array',
        commands: [],
        phrases: [],
      }),
    });
    expect(badQuickData.status).toBe(400);
    const body = await badQuickData.json() as { error: string; detail: { formErrors: string[]; fieldErrors: Record<string, string[]> } };
    expect(body.error).toBe('invalid_data');
    expect(Array.isArray(body.detail.formErrors)).toBe(true);
    expect(Array.isArray(body.detail.fieldErrors.history)).toBe(true);
  });
});
