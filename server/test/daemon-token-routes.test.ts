import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.js';
import { buildApp } from '../src/index.js';
import { requireAuth, resolveBearerAuth } from '../src/security/authorization.js';
import { authenticateDaemonServer } from '../src/security/daemon-auth.js';
import { signJwt } from '../src/security/crypto.js';
import { DAEMON_TOKEN_ROUTES, DAEMON_TOKEN_ROUTE_NOT_ALLOWED, daemonApiUrl, matchDaemonTokenRoute } from '../../shared/daemon-token-routes.js';
import { NODE_ROLE, NODE_ROLE_REFUSAL } from '../../shared/remote-exec.js';
import { COOKIE_SESSION } from '../../shared/cookie-names.js';
import { SERVER_ID_HEADER } from '../../shared/http-header-names.js';
import { PUSH_PLATFORM_IOS } from '../../shared/push-notifications.js';

import { environment as rawEnvironment, token, key, signingKey, headers } from './helpers/daemon-token-env.js';
function environment(role: string | null = null, revoked: number | null = null) {
  const env = rawEnvironment(role, revoked);
  vi.spyOn(env.DB, 'execute');
  return env;
}
const concretize = (path: string) => path.replace(/:[^/]+/g, 'srv-1');
afterEach(() => vi.restoreAllMocks());

describe('daemon credentials are admitted only on explicitly called routes', () => {
  const blocked: [string, string, unknown?][] = [
    ['GET', '/api/server/srv-1/shares'], ['GET', '/api/team'], ['GET', '/api/bot'],
    ['POST', '/api/push/register', { token: 'fixture-push-device', platform: PUSH_PLATFORM_IOS }],
    ['GET', '/api/auth/user/me'], ['GET', '/api/auth/user/me/keys'],
    ['POST', '/api/auth/user/me/keys', {}], ['PATCH', '/api/auth/user/me', { display_name: 'x' }],
    ['GET', '/api/admin/users'], ['POST', '/api/bind/direct', { serverName: 'fixture' }],
    ['GET', '/api/unknown-new-account-route'], ['POST', '/api/aliases/admin', {}],
  ];
  it.each(blocked)('%s %s refuses before route effects', async (method, path, body) => {
    const env = environment();
    const response = await buildApp(env).request(path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden', reason: DAEMON_TOKEN_ROUTE_NOT_ALLOWED });
    expect(env.DB.execute).not.toHaveBeenCalled();
  });

  it.each(DAEMON_TOKEN_ROUTES)('$method $path passes real credential middleware', async (route) => {
    const app = new Hono<{ Bindings: Env }>();
    app.on(route.method, route.path, requireAuth(), c => c.json({ ok: true }));
    const response = await app.request(concretize(route.path), { method: route.method, headers }, environment());
    expect(response.status).toBe(200);
  });

  it('the lower-level bearer resolver refuses, not only requireAuth', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.get('/api/account', async c => c.json(await resolveBearerAuth(c)));
    expect((await app.request('/api/account', { headers }, environment())).status).toBe(403);
  });

  it('legacy headerless daemon auth also fails closed on a newly added route', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.post('/api/accidental-account-grant', async c => c.json(await authenticateDaemonServer(c, null)));
    expect((await app.request('/api/accidental-account-grant', { method: 'POST', headers: { Authorization: headers.Authorization } }, environment())).status).toBe(403);
  });

  it('logs a count, route template and verified server id without secrets or queries', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildApp(environment()).request('/api/team?secret=private-query', { headers });
    const logs = spy.mock.calls.flat().join(' ');
    expect(logs).toContain('"serverId":"srv-1"');
    expect(logs).toContain('"deniedCount":');
    expect(logs).toContain('"route":');
    expect(logs).not.toContain(token);
    expect(logs).not.toContain('private-query');
  });

  it('controlled and revoked credentials retain their narrower refusal', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.get('/api/aliases', requireAuth(), c => c.json({ ok: true }));
    const controlled = await app.request('/api/aliases', { headers }, environment(NODE_ROLE.CONTROLLED));
    expect(controlled.status).toBe(403);
    expect(await controlled.json()).toMatchObject({ reason: NODE_ROLE_REFUSAL.CONTROLLED_NODE });
    expect((await app.request('/api/aliases', { headers }, environment(NODE_ROLE.FULL, 1))).status).toBe(401);
  });

  it('account cookie/JWT/API-key flows are unaffected, including incidental server headers', async () => {
    const app = buildApp(environment());
    const jwt = signJwt({ sub: 'user-1', role: 'owner' }, signingKey, 60);
    for (const userHeaders of [
      { Authorization: `Bearer ${jwt}` }, { Authorization: `Bearer ${key}` },
      { Authorization: `Bearer ${jwt}`, [SERVER_ID_HEADER]: 'srv-1' },
      { Authorization: `Bearer ${key}`, [SERVER_ID_HEADER]: 'srv-1' },
      { Cookie: `${COOKIE_SESSION}=${jwt}` }, { Cookie: `${COOKIE_SESSION}=${jwt}`, ...headers },
    ]) expect((await app.request('/api/auth/user/me', { headers: userHeaders })).status).toBe(200);
    expect((await app.request('/api/team', { headers: { Authorization: 'Bearer invalid', [SERVER_ID_HEADER]: 'srv-1' } })).status).toBe(401);
  });

  it('matches methods and encoded identifier segments exactly and preserves sticky query', () => {
    const path = '/api/server/server%2Fid/cron/job%3Fid?serverId=server%2Fid';
    expect(daemonApiUrl('https://example.invalid/', 'PUT', path)).toBe(`https://example.invalid${path}`);
    for (const path of ['/api/server//cron', '/api/team', '/api/server/id/cron/id/admin', '/api/aliases-extra']) {
      expect(matchDaemonTokenRoute('GET', path, NODE_ROLE.FULL)).toBeUndefined();
    }
    expect(() => daemonApiUrl('https://example.invalid', 'DELETE', '/api/machines')).toThrow(DAEMON_TOKEN_ROUTE_NOT_ALLOWED);
    expect(matchDaemonTokenRoute('GET', '/api/aliases', NODE_ROLE.CONTROLLED)).toBeUndefined();
  });
});
