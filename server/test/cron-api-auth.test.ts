/**
 * The cron API authenticates every request with the REAL auth middleware (no mock of requireAuth / requireCronAuth).
 *
 * Counterexample for the hole this closes: a request to `/api/server/<serverId>/cron` with no Authorization and no Cookie
 * used to be treated as the local daemon -- it ran as the server owner, daemon-attested, so anyone who knew a serverId
 * (share recipients and group members receive it; it is in URLs and logs) could create, read, change, trigger and delete
 * the owner's cron jobs: jobs that inject prompts or commands into the owner's agent sessions.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { sha256Hex, signJwt } from '../src/security/crypto.js';
import { COOKIE_SESSION } from '../../shared/cookie-names.js';
import { CRON_API_AUTH_ERRORS } from '../../shared/cron-types.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { daemonServerAuthHeaders } from '../../shared/daemon-server-auth.js';
import { SERVER_ID_HEADER } from '../../shared/http-header-names.js';

const SIGNING_KEY = 'test-signing-key-32chars-padding!!';

interface ServerRow { id: string; token: string; user_id: string; node_role: string | null; revoked_at: number | null }
interface MockRow { [key: string]: unknown }

function normalize(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Servers, their token hashes and the cron tables; every write is recorded so "touched nothing" can be asserted. */
function makeDb(servers: ServerRow[]) {
  const cronJobs = new Map<string, MockRow>();
  const writes: string[] = [];
  const find = (id: unknown) => servers.find((server) => server.id === id);
  const db = {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const s = normalize(sql);
      if (s.includes('select token_hash, user_id, node_role, revoked_at from servers where id')) {
        const server = find(params[0]);
        return (server ? { token_hash: sha256Hex(server.token), user_id: server.user_id, node_role: server.node_role, revoked_at: server.revoked_at } : null) as T | null;
      }
      if (s.includes('select user_id from servers where id')) {
        const server = find(params[0]);
        return (server ? { user_id: server.user_id } : null) as T | null;
      }
      if (s.includes('exists (select 1 from servers')) return { exists: Boolean(find(params[0])) } as T;
      if (s.includes('from cron_jobs where id')) {
        const job = cronJobs.get(params[0] as string);
        return (job && (!s.includes('user_id') || job.user_id === params[1]) ? job : null) as T | null;
      }
      return null;
    },
    query: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const s = normalize(sql);
      if (s.includes('from cron_jobs')) return [...cronJobs.values()].filter((job) => job.user_id === params[0]) as T[];
      return [] as T[];
    },
    execute: async (sql: string, params: unknown[] = []): Promise<{ changes: number }> => {
      const s = normalize(sql);
      if (s.includes('insert into audit_log')) return { changes: 1 };
      writes.push(s.slice(0, 60));
      if (s.includes('insert into cron_jobs')) {
        cronJobs.set(params[0] as string, {
          id: params[0], server_id: params[1], user_id: params[2], name: params[3], cron_expr: params[4], project_name: params[5],
          target_role: params[6], target_session_name: params[7], action: params[8], timezone: params[9], status: params[10],
          next_run_at: params[11], expires_at: params[12], completion_policy: params[13], created_at: params[14], updated_at: params[14], last_run_at: null,
        });
      }
      if (s.includes('delete from cron_jobs')) cronJobs.delete(params[0] as string);
      return { changes: 1 };
    },
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;
  return { db, cronJobs, writes };
}

const OWNER = 'user-owner';
const ATTACKER = 'user-attacker';
const VICTIM_SERVER = 'srv-victim';
const ATTACKER_SERVER = 'srv-attacker';
const CONTROLLED_SERVER = 'srv-controlled';
const REVOKED_SERVER = 'srv-revoked';
const TOKENS = { victim: 'tok-victim', attacker: 'tok-attacker', controlled: 'tok-controlled', revoked: 'tok-revoked' };

function servers(): ServerRow[] {
  return [
    { id: VICTIM_SERVER, token: TOKENS.victim, user_id: OWNER, node_role: NODE_ROLE.FULL, revoked_at: null },
    { id: ATTACKER_SERVER, token: TOKENS.attacker, user_id: ATTACKER, node_role: NODE_ROLE.FULL, revoked_at: null },
    { id: CONTROLLED_SERVER, token: TOKENS.controlled, user_id: OWNER, node_role: NODE_ROLE.CONTROLLED, revoked_at: null },
    { id: REVOKED_SERVER, token: TOKENS.revoked, user_id: OWNER, node_role: NODE_ROLE.FULL, revoked_at: Date.now() - 1000 },
  ];
}

function env(db: Database): Env {
  return {
    DB: db, JWT_SIGNING_KEY: SIGNING_KEY, BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2), SERVER_URL: 'http://localhost:3000',
    ALLOWED_ORIGINS: '', TRUSTED_PROXIES: '', BIND_HOST: '127.0.0.1', PORT: '3000', NODE_ENV: 'development',
    GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', DATABASE_URL: '',
  } as Env;
}

async function buildApp(db: Database) {
  const { cronApiRoutes } = await import('../src/routes/cron-api.js');
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    if (!c.env) (c as unknown as { env: Env }).env = {} as Env;
    Object.assign(c.env, env(db));
    await next();
  });
  app.route('/api/cron', cronApiRoutes);
  app.route('/api/server/:serverId/cron', cronApiRoutes);
  return app;
}

const createBody = {
  name: 'Injected', cronExpr: '0 9 * * *', serverId: VICTIM_SERVER, projectName: 'proj', targetRole: 'brain',
  action: { type: 'command', command: '/status' },
};

type Call = { name: string; method: string; path: string; body?: unknown };
const ROUTES: Call[] = [
  { name: 'list', method: 'GET', path: '' },
  { name: 'create', method: 'POST', path: '', body: createBody },
  { name: 'update', method: 'PUT', path: '/job-1', body: { name: 'changed' } },
  { name: 'status', method: 'PATCH', path: '/job-1/status', body: { status: 'paused' } },
  { name: 'delete', method: 'DELETE', path: '/job-1?force=true' },
  { name: 'trigger', method: 'POST', path: '/job-1/trigger' },
  { name: 'executions (all)', method: 'GET', path: '/executions' },
  { name: 'executions (job)', method: 'GET', path: '/job-1/executions' },
];

function request(app: Hono<{ Bindings: Env }>, base: string, call: Call, headers: Record<string, string> = {}) {
  return app.request(`${base}${call.path}`, {
    method: call.method,
    headers: { ...(call.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
  });
}

describe('cron API authentication (real auth middleware)', () => {
  let app: Hono<{ Bindings: Env }>;
  let state: ReturnType<typeof makeDb>;

  beforeEach(async () => {
    state = makeDb(servers());
    // A job the owner really has: an unauthenticated caller must not be able to read, change, trigger or delete it.
    state.cronJobs.set('job-1', {
      id: 'job-1', server_id: VICTIM_SERVER, user_id: OWNER, name: 'Owner job', cron_expr: '0 9 * * *', project_name: 'proj', target_role: 'brain',
      action: JSON.stringify({ type: 'command', command: '/status' }), status: 'active', next_run_at: Date.now() + 60_000, completion_policy: 'recurring',
      created_at: 1, updated_at: 1, last_run_at: null,
    });
    state.writes.length = 0;
    app = await buildApp(state.db);
  });

  describe.each([
    ['pod-sticky mount (the exploit)', `/api/server/${VICTIM_SERVER}/cron`],
    ['plain mount', '/api/cron'],
  ])('%s', (_label, base) => {
    it.each(ROUTES)('$name with no Authorization and no Cookie -> 401, nothing read, created or changed', async (call) => {
      const res = await request(app, base, call);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain('Owner job');
      expect(state.writes).toEqual([]);
      expect([...state.cronJobs.keys()]).toEqual(['job-1']);
    });

    it('a request naming a server but carrying no credential is told to upgrade the daemon, and still touches nothing', async () => {
      for (const call of ROUTES) {
        const res = await request(app, base, call, { [SERVER_ID_HEADER]: VICTIM_SERVER });
        expect(res.status, call.name).toBe(401);
        expect(await res.json(), call.name).toEqual({ error: CRON_API_AUTH_ERRORS.DAEMON_CREDENTIAL_REQUIRED });
      }
      expect(state.writes).toEqual([]);
      expect([...state.cronJobs.keys()]).toEqual(['job-1']);
    });
  });

  describe('credentials that must be refused on every route', () => {
    const base = `/api/server/${VICTIM_SERVER}/cron`;
    const cases: Array<[string, Record<string, string>, number]> = [
      ['a malformed bearer', { Authorization: 'Bearer garbage' }, 401],
      ['a bearer with no scheme', { Authorization: 'tok-victim' }, 401],
      ['a bearer for the wrong server (attacker token naming the victim server)', daemonServerAuthHeaders({ serverId: VICTIM_SERVER, token: TOKENS.attacker }), 401],
      ['the right token with a different X-Server-Id', daemonServerAuthHeaders({ serverId: ATTACKER_SERVER, token: TOKENS.victim }), 401],
      ['a revoked server token', daemonServerAuthHeaders({ serverId: REVOKED_SERVER, token: TOKENS.revoked }), 401],
      ['a controlled-node token', daemonServerAuthHeaders({ serverId: CONTROLLED_SERVER, token: TOKENS.controlled }), 403],
      ['a bearer plus an unknown X-Server-Id', daemonServerAuthHeaders({ serverId: 'srv-unknown', token: TOKENS.victim }), 401],
      ['an invalid session cookie', { Cookie: `${COOKIE_SESSION}=not-a-jwt` }, 401],
    ];

    it.each(cases)('%s -> rejected on all routes, nothing touched', async (_label, headers, status) => {
      for (const call of ROUTES) {
        const res = await request(app, base, call, headers);
        expect(res.status, call.name).toBe(status);
      }
      expect(state.writes).toEqual([]);
      expect([...state.cronJobs.keys()]).toEqual(['job-1']);
    });

    it("another user's own valid daemon token cannot reach the victim server's jobs (no membership), and creates nothing", async () => {
      const attackerHeaders = daemonServerAuthHeaders({ serverId: ATTACKER_SERVER, token: TOKENS.attacker });
      for (const call of ROUTES) {
        const res = await request(app, base, call, attackerHeaders);
        expect([401, 403, 404], call.name).toContain(res.status);
        expect(await res.text(), call.name).not.toContain('Owner job');
      }
      expect(state.writes).toEqual([]);
      expect([...state.cronJobs.keys()]).toEqual(['job-1']);
    });
  });

  describe('the credentials that must keep working', () => {
    const base = `/api/server/${VICTIM_SERVER}/cron`;

    it('the daemon server token + its own X-Server-Id lists, creates and deletes (the MCP path)', async () => {
      const daemon = daemonServerAuthHeaders({ serverId: VICTIM_SERVER, token: TOKENS.victim });
      const listed = await request(app, base, ROUTES[0]!, daemon);
      expect(listed.status).toBe(200);
      expect(JSON.stringify(await listed.json())).toContain('Owner job');

      const created = await request(app, base, ROUTES[1]!, daemon);
      expect(created.status).toBe(201);
      expect(state.cronJobs.size).toBe(2);

      const deleted = await request(app, base, ROUTES[4]!, daemon);
      expect(deleted.status).toBe(200);
      expect(state.cronJobs.has('job-1')).toBe(false);
    });

    it('a user session cookie and a user bearer JWT of the server owner still work', async () => {
      const jwt = signJwt({ sub: OWNER, role: 'owner' }, SIGNING_KEY, 3600);
      for (const headers of [{ Cookie: `${COOKIE_SESSION}=${encodeURIComponent(jwt)}` }, { Authorization: `Bearer ${jwt}` }]) {
        const res = await request(app, base, ROUTES[0]!, headers);
        expect(res.status).toBe(200);
      }
    });

    it('a user who is not a member of the server is refused even with a valid session', async () => {
      const jwt = signJwt({ sub: ATTACKER, role: 'owner' }, SIGNING_KEY, 3600);
      const res = await request(app, base, ROUTES[0]!, { Cookie: `${COOKIE_SESSION}=${encodeURIComponent(jwt)}` });
      expect([401, 403, 404]).toContain(res.status);
      expect(await res.text()).not.toContain('Owner job');
    });
  });
});
