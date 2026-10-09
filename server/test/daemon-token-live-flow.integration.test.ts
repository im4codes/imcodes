/** Real PostgreSQL + real loopback HTTP; record daemon client requests. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { buildApp } from '../src/index.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { sha256Hex, signJwt } from '../src/security/crypto.js';
import { daemonServerAuthHeaders } from '../../shared/daemon-server-auth.js';
import { DAEMON_TOKEN_ROUTE_NOT_ALLOWED, DAEMON_TOKEN_ROUTES } from '../../shared/daemon-token-routes.js';
import { aliasMcpList, aliasMcpUpsert, aliasMcpDelete } from '../../src/daemon/alias-mcp-client.js';
import { cronMcpCreateSelf, cronMcpList, cronMcpDelete } from '../../src/daemon/cron-mcp-client.js';
import { fetchBackendStartupMemoryItems } from '../../src/context/backend-startup-memory.js';
import { createServerCapabilityService } from '../../src/capability/server-capability-service.js';
import { listMachines } from '../../src/daemon/machine-exec-client.js';
import { listVerificationMachineProfiles } from '../../src/daemon/verification-machine-mcp-client.js';

let db: Database;
let http: ServerType;
let endpoint: { workerUrl: string; serverId: string; token: string };
const user = 'daemon-policy-fixture-user';
const signingKey = 'fixture-live-jwt-signing-key-32chars';
const records: string[] = [];
const recordedFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  records.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  return fetch(input, init);
};
const send = (path: string, init: RequestInit = {}) => recordedFetch(`${endpoint.workerUrl}${path}`, init);

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
  await db.execute('INSERT INTO users (id, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user, Date.now()]);
  const app = buildApp({ DB: db, JWT_SIGNING_KEY: signingKey, BOT_ENCRYPTION_KEY: 'a'.repeat(32),
    SERVER_URL: 'http://localhost', TRUSTED_PROXIES: '', NODE_ENV: 'test' } as never);
  http = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => http.on('listening', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('missing scoped loopback address');
  endpoint = { workerUrl: `http://127.0.0.1:${address.port}`, serverId: '', token: '' };
  const response = await send('/api/bind/direct', { method: 'POST',
    headers: { Authorization: `Bearer ${signJwt({ sub: user, role: 'owner' }, signingKey, 3600)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverName: 'fixture-policy-daemon' }) });
  expect(response.status).toBe(201);
  const bound = await response.json() as { serverId: string; token: string };
  endpoint = { ...endpoint, ...bound };
}, 60_000);

afterAll(async () => {
  if (http) await new Promise<void>((resolve, reject) => http.close(err => err ? reject(err) : resolve()));
  if (db) await db.close();
});

describe('bound daemon clients against new server admission', () => {
  it('bind verification keeps its body proof and cannot mint credentials with the daemon token', async () => {
    const response = await send('/api/bind/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(endpoint) });
    expect(response.status).toBe(200);
    const denied = await send('/api/bind/direct', { method: 'POST', headers: daemonServerAuthHeaders(endpoint), body: '{}' });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ reason: DAEMON_TOKEN_ROUTE_NOT_ALLOWED });
  });

  it('alias MCP roundtrip reaches real owner-scoped PostgreSQL rows', async () => {
    const options = { endpoint, fetchImpl: recordedFetch };
    expect((await aliasMcpUpsert({ name: 'fixture-alias', value: 'fixture-value' }, options)).status).toBe('ok');
    const listed = await aliasMcpList(options);
    expect(listed).toMatchObject({ status: 'ok', aliases: [{ name: 'fixture-alias', value: 'fixture-value' }] });
    expect(await aliasMcpDelete('fixture-alias', options)).toMatchObject({ status: 'ok', deleted: true });
  });

  it('cron MCP create/list/delete uses the pod-sticky path', async () => {
    const options = { endpoint, runtimeServerId: endpoint.serverId, fetchImpl: recordedFetch };
    const created = await cronMcpCreateSelf({ name: 'fixture-cron', cronExpr: '0 * * * *', projectName: 'fixture-project', targetRole: 'brain', message: 'fixture command' }, options);
    expect(created).toMatchObject({ status: 'ok' });
    const listed = await cronMcpList({}, options);
    expect(listed.status).toBe('ok');
    if (listed.status !== 'ok') throw new Error('cron list failed');
    const jobs = (listed.body as { jobs: { id: string }[] }).jobs;
    expect(jobs).toHaveLength(1);
    expect((await cronMcpDelete(jobs[0]!.id, options, true)).status).toBe('ok');
  });

  it('memory startup and capability control clients retain admission', async () => {
    expect(await fetchBackendStartupMemoryItems(endpoint, { scope: 'project', projectId: 'fixture-project' } as never, 10, { fetchImpl: recordedFetch })).toEqual([]);
    const service = createServerCapabilityService({ serverId: endpoint.serverId, loadCredentials: async () => endpoint, fetchImpl: recordedFetch });
    expect(await service.list({})).toMatchObject({ status: 'ok', items: [] });
  });

  it('machine discovery and verification profile clients retain admission', async () => {
    expect(await listMachines({ serverUrl: endpoint.workerUrl, sourceServerId: endpoint.serverId, sourceToken: endpoint.token, fetchImpl: recordedFetch })).toEqual([]);
    expect(await listVerificationMachineProfiles(undefined, { endpoint, fetchImpl: recordedFetch })).toMatchObject({ status: 'ok', profiles: [] });
  });

  it('file transfer and node artifact paths reach their original input/resource guards', async () => {
    // No file write occurs: these deliberately incomplete requests must reach
    // the original validation handler, not the daemon admission refusal.
    for (const [method, path, expected] of [
      ['POST', `/api/server/${endpoint.serverId}/upload`, 400],
      ['GET', `/api/enroll/v2/node-artifact?serverId=${endpoint.serverId}`, 400],
    ] as const) {
      const response = await send(path, { method, headers: daemonServerAuthHeaders(endpoint) });
      expect(response.status).toBe(expected);
      expect(await response.text()).not.toContain(DAEMON_TOKEN_ROUTE_NOT_ALLOWED);
    }
  });

  it('share open and enrollment-ticket issuance do not gain daemon authority', async () => {
    // These are browser/account/ticket APIs, not daemon REST calls. Preserve the
    // account route's old input guards and uniformly refuse daemon substitution.
    for (const path of ['/api/shares/open', '/api/shares/ws-ticket', '/api/enroll/v2/ticket']) {
      const daemon = await send(path, { method: 'POST', headers: daemonServerAuthHeaders(endpoint), body: '{}' });
      expect(daemon.status).toBe(403);
      expect(await daemon.json()).toMatchObject({ reason: DAEMON_TOKEN_ROUTE_NOT_ALLOWED });
      const account = await send(path, { method: 'POST', headers: { Authorization: `Bearer ${signJwt({ sub: user, role: 'owner' }, signingKey, 3600)}`, 'Content-Type': 'application/json' }, body: '{}' });
      expect(await account.text()).not.toContain(DAEMON_TOKEN_ROUTE_NOT_ALLOWED);
    }
  });

  it.each(DAEMON_TOKEN_ROUTES)('real mounted $method $path retains daemon admission', async route => {
    const path = route.path.replace(/:serverId/g, endpoint.serverId).replace(/:[^/]+/g, 'fixture-unknown');
    const response = await send(`${path}?serverId=${endpoint.serverId}`, { method: route.method,
      headers: { ...daemonServerAuthHeaders(endpoint), 'Content-Type': 'application/json' },
      ...(['POST', 'PUT', 'PATCH'].includes(route.method) ? { body: '{}' } : {}) });
    expect(response.status).not.toBe(401);
    expect(await response.text()).not.toContain(DAEMON_TOKEN_ROUTE_NOT_ALLOWED);
  });

  it('records real daemon/client methods and paths without recording credentials', () => {
    expect(records).toContain('GET /api/aliases');
    expect(records).toContain(`GET /api/server/${endpoint.serverId}/cron`);
    expect(records).toContain('POST /api/shared-context/memory/search');
    expect(records).toContain('GET /api/capabilities');
    expect(records.join('\n')).not.toContain(endpoint.token);
    expect(sha256Hex(endpoint.token)).toHaveLength(64);
  });
});
