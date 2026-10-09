/**
 * tsk_854675e1e2: a daemon server-token (X-Server-Id + Bearer) resolves to the server OWNER's account with role `owner` on every
 * requireAuth route. The token lives in ~/.imcodes/server.json, which the owner's agents (a participant-driven turn included) can read,
 * so account administration and credential minting must not accept it.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { SERVER_ID_HEADER } from '../../shared/http-header-names.js';
import { DAEMON_CREDENTIAL_REFUSAL } from '../src/security/authorization.js';

const TOKEN = 'daemon-token-123';
const API_KEY = 'deck_0123456789abcdef0123456789abcdef';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

function makeApp() {
  const db = {
    queryOne: async (sql: string, params: unknown[] = []) => {
      const s = sql.toLowerCase().replace(/\s+/g, ' ');
      if (s.includes('from servers where id')) return { token_hash: sha(TOKEN), user_id: 'admin-1', node_role: null, revoked_at: null };
      if (s.includes('from api_keys')) return params[0] === sha(API_KEY) ? { id: 'key-1', user_id: 'admin-1' } : null;
      if (s.includes('from users where id')) return { id: 'admin-1', is_admin: true, status: 'active' };
      return null;
    },
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => undefined,
    close: async () => undefined,
  } as unknown as Database;
  return buildApp({
    DB: db, JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!', BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'http://localhost:3000', ALLOWED_ORIGINS: '', TRUSTED_PROXIES: '', BIND_HOST: '127.0.0.1', PORT: '3000',
    NODE_ENV: 'development', GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '',
  } as Env);
}

const daemon = { Authorization: `Bearer ${TOKEN}`, [SERVER_ID_HEADER]: 'srv-1', 'Content-Type': 'application/json' };
const apiKey = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

describe('routes that administer the account or mint credentials refuse a daemon credential', () => {
  const routes: Array<[string, string, unknown]> = [
    ['POST', '/api/bind/direct', { serverName: 'x' }],
    ['POST', '/api/bind/rebind', { serverId: 'srv-1', serverName: 'x' }],
    ['GET', '/api/admin/users', undefined],
    ['GET', '/api/admin/settings', undefined],
  ];

  it.each(routes)('%s %s -> 403 with a daemon token', async (method, path, body) => {
    const response = await makeApp().request(path, { method, headers: daemon, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: DAEMON_CREDENTIAL_REFUSAL });
  });

  it.each(routes)('%s %s still answers an API key (not refused for being a daemon)', async (method, path, body) => {
    const response = await makeApp().request(path, { method, headers: apiKey, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    expect(text).not.toContain(DAEMON_CREDENTIAL_REFUSAL);
    expect(response.status).not.toBe(401);
  });
});
