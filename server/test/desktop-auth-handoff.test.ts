import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/index.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import {
  buildDesktopSetupCallbackRedirectUrl,
  buildDesktopSetupLoginUrl,
  parseDesktopSetupCallbackUrl,
} from '../../shared/desktop-setup-auth.js';
import { DAEMON_TOKEN_ROUTE_NOT_ALLOWED } from '../../shared/daemon-token-routes.js';
import { SERVER_ID_HEADER } from '../../shared/http-header-names.js';
import { activeUserAnswer } from './helpers/user-status.js';

const USER_ID = 'user-1';
const API_KEY = 'deck_0123456789abcdef0123456789abcdef';
const DAEMON_TOKEN = 'daemon-token-xyz';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

interface NonceRow {
  nonce: string;
  api_key: string;
  user_id: string;
  key_id: string;
  expires_at: number;
  used: boolean;
}

function createAuthTestApp() {
  const apiKeys: Array<{ id: string; user_id: string; key_hash: string; label: string }> = [
    { id: 'key-seed', user_id: USER_ID, key_hash: sha(API_KEY), label: 'Seed' },
  ];
  const nonces: NonceRow[] = [];
  const audits: Array<{ action: string; userId: string }> = [];

  const db = {
    queryOne: async (sql: string, params: unknown[] = []) => {
      {
        const activeUser = activeUserAnswer(sql);
        if (activeUser) return activeUser;
      }
      const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (s.includes('from servers where id')) {
        return params[0] === 'srv-1'
          ? { token_hash: sha(DAEMON_TOKEN), owner_status: 'active', user_id: USER_ID, node_role: 'full', revoked_at: null }
          : null;
      }
      if (s.includes('from api_keys')) {
        const row = apiKeys.find((k) => k.key_hash === params[0]);
        return row ? { id: row.id, user_id: row.user_id, user_status: 'active' } : null;
      }
      if (s.includes('platform_identities')) {
        return { id: USER_ID, username: 'alice', is_admin: false, status: 'active' };
      }
      if (s.includes('from users where id')) {
        return params[0] === USER_ID
          ? { id: USER_ID, username: 'alice', is_admin: false, status: 'active' }
          : null;
      }
      if (s.startsWith('delete from auth_nonces') && s.includes('returning')) {
        const [nonce, now] = params as [string, number];
        const row = nonces.find((n) => n.nonce === nonce && !n.used && n.expires_at > now);
        if (!row) return null;
        row.used = true;
        return { api_key: row.api_key, user_id: row.user_id, key_id: row.key_id };
      }
      if (s.startsWith('select user_id, expires_at from auth_nonces')) {
        const row = nonces.find((n) => n.nonce === params[0]);
        return row ? { user_id: row.user_id, expires_at: row.expires_at } : null;
      }
      return null;
    },
    query: async () => [],
    execute: async (sql: string, params: unknown[] = []) => {
      const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (s.startsWith('insert into api_keys')) {
        apiKeys.push({
          id: String(params[0]),
          user_id: String(params[1]),
          key_hash: String(params[2]),
          label: String(params[3] ?? 'Desktop app'),
        });
      } else if (s.startsWith('insert into auth_nonces')) {
        nonces.push({
          nonce: String(params[0]),
          api_key: String(params[1]),
          user_id: String(params[2]),
          key_id: String(params[3]),
          expires_at: Number(params[4]),
          used: false,
        });
      } else if (s.startsWith('insert into audit')) {
        audits.push({ userId: String(params[1] ?? ''), action: String(params[3] ?? '') });
      }
      return { changes: 1 };
    },
    exec: async () => undefined,
    close: async () => undefined,
  } as unknown as Database;

  const app = buildApp({
    DB: db,
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'https://app.im.codes',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'development',
    GITHUB_CLIENT_ID: 'gh-client-1',
    GITHUB_CLIENT_SECRET: 'gh-secret-1',
  } as Env);

  return { app, apiKeys, nonces, audits };
}

describe('desktop setup callback validator', () => {
  it('accepts strict loopback http://127.0.0.1:<port>/setup/callback?state=...', () => {
    const valid = parseDesktopSetupCallbackUrl('http://127.0.0.1:43751/setup/callback?state=csrf_Token_12345');
    expect(valid).toEqual({
      origin: 'http://127.0.0.1:43751',
      port: 43751,
      state: 'csrf_Token_12345',
      href: 'http://127.0.0.1:43751/setup/callback?state=csrf_Token_12345',
    });
    expect(buildDesktopSetupCallbackRedirectUrl(valid!, 'nonce-abc')).toBe(
      'http://127.0.0.1:43751/setup/callback?nonce=nonce-abc&state=csrf_Token_12345',
    );
    expect(buildDesktopSetupLoginUrl('https://app.im.codes', valid!.href)).toBe(
      'https://app.im.codes/?desktop_callback=http%3A%2F%2F127.0.0.1%3A43751%2Fsetup%2Fcallback%3Fstate%3Dcsrf_Token_12345',
    );
  });

  it.each([
    '',
    'https://127.0.0.1:43751/setup/callback?state=abcdefgh',
    'http://localhost:43751/setup/callback?state=abcdefgh',
    'http://[::1]:43751/setup/callback?state=abcdefgh',
    'http://evil.example:43751/setup/callback?state=abcdefgh',
    'http://127.0.0.1/setup/callback?state=abcdefgh',
    'http://127.0.0.1:43751/wrong/path?state=abcdefgh',
    'http://127.0.0.1:43751/setup/callback?state=short',
    'http://127.0.0.1:43751/setup/callback?state=abcdefgh&extra=1',
    'http://user:pass@127.0.0.1:43751/setup/callback?state=abcdefgh',
    'http://127.0.0.1:43751/setup/callback?state=abcdefgh#frag',
  ])('rejects invalid desktop_callback URL: %s', (candidate) => {
    expect(parseDesktopSetupCallbackUrl(candidate)).toBeNull();
  });
});

describe('POST /api/auth/desktop/nonce & token-exchange & GitHub OAuth state', () => {
  it('mints single-use nonce and exchanges once for the desktop API key', async () => {
    const { app, apiKeys, nonces, audits } = createAuthTestApp();
    const callback = 'http://127.0.0.1:43751/setup/callback?state=AbCdEfGh12345678';

    const nonceRes = await app.request('/api/auth/desktop/nonce', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ callbackUrl: callback }),
    });
    expect(nonceRes.status).toBe(200);
    const nonceJson = await nonceRes.json() as { nonce: string; redirectUrl: string };
    expect(nonceJson.nonce).toBeTruthy();
    expect(nonceJson.redirectUrl).toBe(
      `http://127.0.0.1:43751/setup/callback?nonce=${encodeURIComponent(nonceJson.nonce)}&state=AbCdEfGh12345678`,
    );
    expect(nonces).toHaveLength(1);
    expect(apiKeys.some((k) => k.label === 'Desktop app')).toBe(true);
    expect(audits.some((a) => a.action === 'auth.desktop_nonce')).toBe(true);

    // Redeem nonce via POST /api/auth/token-exchange
    const exchange1 = await app.request('/api/auth/token-exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: nonceJson.nonce }),
    });
    expect(exchange1.status).toBe(200);
    const exchangeJson = await exchange1.json() as { apiKey: string; keyId: string };
    expect(exchangeJson.apiKey).toMatch(/^deck_/);
    expect(exchangeJson.keyId).toBeTruthy();

    // Replay must fail
    const exchange2 = await app.request('/api/auth/token-exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: nonceJson.nonce }),
    });
    expect(exchange2.status).toBe(400);
  });

  it('refuses daemon credential and invalid callback URLs on POST /api/auth/desktop/nonce', async () => {
    const { app } = createAuthTestApp();

    const daemonRes = await app.request('/api/auth/desktop/nonce', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DAEMON_TOKEN}`,
        [SERVER_ID_HEADER]: 'srv-1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ callbackUrl: 'http://127.0.0.1:43751/setup/callback?state=AbCdEfGh12345678' }),
    });
    expect(daemonRes.status).toBe(403);
    expect(await daemonRes.json()).toMatchObject({ reason: DAEMON_TOKEN_ROUTE_NOT_ALLOWED });

    const badCb = await app.request('/api/auth/desktop/nonce', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ callbackUrl: 'https://evil.example/setup/callback?state=AbCdEfGh12345678' }),
    });
    expect(badCb.status).toBe(400);
    expect(await badCb.json()).toMatchObject({ error: 'invalid_desktop_callback' });
  });

  it('propagates valid desktop_callback through GitHub OAuth state and rejects invalid ones', async () => {
    const { app } = createAuthTestApp();

    const badStart = await app.request('/api/auth/github?desktop_callback=' + encodeURIComponent('http://evil.example:43751/setup/callback?state=AbCdEfGh'));
    expect(badStart.status).toBe(400);
    expect(await badStart.json()).toMatchObject({ error: 'invalid_desktop_callback' });

    const goodCb = 'http://127.0.0.1:43751/setup/callback?state=StateToken123456';
    const goodStart = await app.request('https://app.im.codes/api/auth/github?desktop_callback=' + encodeURIComponent(goodCb));
    expect(goodStart.status).toBe(302);
    const ghLocation = goodStart.headers.get('location')!;
    const stateJwt = new URL(ghLocation).searchParams.get('state')!;
    expect(stateJwt).toBeTruthy();
    const oauthCookie = (goodStart.headers.get('set-cookie') ?? '').split(';')[0];

    // Simulate GitHub OAuth callback exchange (mocking global fetch for GitHub token/user APIs)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gh-tok-1' }), { status: 200 });
      }
      if (url.includes('api.github.com/user')) {
        return new Response(JSON.stringify({ id: 42, login: 'octo', name: 'Octo' }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      const cbRes = await app.request(
        `https://app.im.codes/api/auth/github/callback?code=code-1&state=${encodeURIComponent(stateJwt)}`,
        { headers: { Cookie: oauthCookie } },
      );
      expect(cbRes.status).toBe(302);
      const finalLoc = new URL(cbRes.headers.get('location')!, 'https://app.im.codes');
      expect(finalLoc.searchParams.get('desktop_callback')).toBe(goodCb);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
