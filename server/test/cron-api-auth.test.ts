/**
 * The cron API authenticates every request with the REAL auth middleware (no mock of requireAuth / requireCronAuth).
 *
 * Counterexample for the hole this closes: a request to `/api/server/<serverId>/cron` with no Authorization and no Cookie
 * used to be treated as the local daemon -- it ran as the server owner, daemon-attested, so anyone who knew a serverId
 * (share recipients and group members receive it; it is in URLs and logs) could create, read, change, trigger and delete
 * the owner's cron jobs: jobs that inject prompts or commands into the owner's agent sessions.
 */
import { activeUserAnswer } from './helpers/user-status.js';
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
  const cronProvenance = new Map<string, MockRow>();
  const cronExecutions: MockRow[] = [];
  const writes: string[] = [];
  const queryLog: Array<{ sql: string; params: unknown[] }> = [];
  const find = (id: unknown) => servers.find((server) => server.id === id);
  const db = {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
      { const activeUser = activeUserAnswer(sql); if (activeUser) return activeUser as never; }
      const s = normalize(sql);
      if ((s.startsWith('select token_hash, user_id, node_role, revoked_at') && s.includes('from servers where id'))) {
        const server = find(params[0]);
        return (server ? { token_hash: sha256Hex(server.token), owner_status: 'active', user_id: server.user_id, node_role: server.node_role, revoked_at: server.revoked_at } : null) as T | null;
      }
      if (s.startsWith('select user_id') && s.includes('from servers where id')) {
        const server = find(params[0]);
        return (server ? { user_id: server.user_id, owner_status: 'active', actor_status: 'active' } : null) as T | null;
      }
      if (s.includes('s.user_id') && s.includes('from servers s')) {
        const server = find(params[0]);
        return (server ? { user_id: server.user_id, user_status: 'active' } : null) as T | null;
      }
      if (s.includes('exists (select 1 from servers')) return { exists: Boolean(find(params[0])) } as T;
      if (s.includes('from cron_jobs j left join cron_job_provenance')) {
        const job = cronJobs.get(params[0] as string);
        if (!job) return null;
        const prov = cronProvenance.get(params[0] as string);
        return {
          ...job,
          prov_creator_user_id: prov?.creator_user_id ?? null,
          prov_shared: prov ? Boolean(prov.shared) : null,
          prov_present: Boolean(prov),
        } as T;
      }
      if (s.includes('from cron_job_provenance where job_id')) {
        return (cronProvenance.get(params[0] as string) ?? null) as T | null;
      }
      if (s.includes('from cron_jobs where id')) {
        const job = cronJobs.get(params[0] as string);
        return (job && (!s.includes('user_id') || job.user_id === params[1]) ? job : null) as T | null;
      }
      return null;
    },
    query: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
      queryLog.push({ sql, params });
      const s = normalize(sql);
      if (s.includes('from cron_executions')) {
        if (s.includes('where job_id = $1')) {
          return cronExecutions
            .filter((e) => e.job_id === params[0])
            .sort((a, b) => Number(b.created_at) - Number(a.created_at))
            .slice(0, Number(params[1] ?? 20)) as T[];
        }
        const ownerUserId = params[0] as string;
        const serverId = params[1] as string | null;
        const projectName = params[2] as string | null;
        const isLatest = s.includes('distinct on');
        const limit = isLatest ? Number.POSITIVE_INFINITY : Number(params[3] ?? 50);
        const extFilter = (isLatest ? params[3] : params[4]) as string | null | undefined;
        const filtered = cronExecutions
          .map((exec) => {
            const job = cronJobs.get(String(exec.job_id ?? ''));
            if (!job || job.user_id !== ownerUserId) return null;
            if (serverId && job.server_id !== serverId) return null;
            if (projectName && job.project_name !== projectName) return null;
            const prov = cronProvenance.get(String(job.id ?? ''));
            if (extFilter && (prov?.creator_user_id !== extFilter || Boolean(prov?.shared))) return null;
            return {
              ...exec,
              job_name: job.name,
              server_id: job.server_id,
              project_name: job.project_name,
              cron_expr: job.cron_expr,
              target_role: job.target_role,
              target_session_name: job.target_session_name,
              action: job.action,
              creator_user_id: prov?.creator_user_id ?? job.user_id,
              creator_name: null,
              creator_is_shared: Boolean(prov?.shared),
            };
          })
          .filter((row): row is NonNullable<typeof row> => row !== null)
          .sort((a, b) => Number(b.created_at) - Number(a.created_at));
        if (isLatest) {
          const seen = new Set<string>();
          return filtered.filter((row) => {
            const id = String(row.job_id);
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          }) as T[];
        }
        return filtered.slice(0, limit) as T[];
      }
      if (s.includes('from cron_jobs')) {
        const extFilter = params[3] as string | null | undefined;
        return [...cronJobs.values()]
          .filter((job) => {
            if (job.user_id !== params[0]) return false;
            const prov = cronProvenance.get(job.id as string);
            if (extFilter && (prov?.creator_user_id !== extFilter || Boolean(prov?.shared))) return false;
            return true;
          })
          .map((job) => ({
            ...job,
            creator_user_id: cronProvenance.get(job.id as string)?.creator_user_id ?? job.user_id,
            creator_is_shared: Boolean(cronProvenance.get(job.id as string)?.shared),
          })) as T[];
      }
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
      if (s.includes('update cron_jobs set')) {
        const job = cronJobs.get(params[params.length - 1] as string);
        if (job) {
          const setClause = s.slice(s.indexOf('set ') + 4, s.indexOf(' where '));
          const parts = setClause.split(',').map((p) => p.trim());
          parts.forEach((part, idx) => {
            const col = part.split('=')[0]!.trim();
            job[col] = params[idx];
          });
        }
      }
      if (s.includes('insert into cron_job_provenance')) {
        cronProvenance.set(params[0] as string, {
          job_id: params[0],
          creator_user_id: params[1],
          server_id: params[2],
          project_name: params[3],
          shared: s.includes('true') ? true : Boolean(params[4]),
        });
      }
      if (s.includes('insert into cron_executions')) {
        cronExecutions.push({
          id: params[0],
          job_id: params[1],
          status: params[2],
          detail: params[3] ?? null,
          created_at: params[4],
        });
      }
      if (s.includes('delete from cron_job_provenance')) cronProvenance.delete(params[0] as string);
      if (s.includes('delete from cron_jobs')) cronJobs.delete(params[0] as string);
      return { changes: 1 };
    },
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;
  return { db, cronJobs, cronProvenance, cronExecutions, writes, queryLog };
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
    { id: VICTIM_SERVER, token: TOKENS.victim, user_id: OWNER, node_role: NODE_ROLE.FULL, revoked_at: null, owner_status: 'active' },
    { id: ATTACKER_SERVER, token: TOKENS.attacker, user_id: ATTACKER, node_role: NODE_ROLE.FULL, revoked_at: null, owner_status: 'active' },
    { id: CONTROLLED_SERVER, token: TOKENS.controlled, user_id: OWNER, node_role: NODE_ROLE.CONTROLLED, revoked_at: null, owner_status: 'active' },
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

async function buildApp(db: Database, opts?: { includeRestrictedMount?: boolean }) {
  const { cronApiRoutes, cronRestrictedApiRoutes } = await import('../src/routes/cron-api.js');
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    if (!c.env) (c as unknown as { env: Env }).env = {} as Env;
    Object.assign(c.env, env(db));
    await next();
  });
  app.route('/api/cron', cronApiRoutes);
  app.route('/api/server/:serverId/cron', cronApiRoutes);
  if (opts?.includeRestrictedMount !== false) {
    app.route('/api/server/:serverId/cron-restricted', cronRestrictedApiRoutes);
  }
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

  it.each(['participant', 'viewer'] as const)('whole-server %s sees owner jobs across projects, not a private other server', async (role) => {
    const originalQuery = state.db.query.bind(state.db);
    state.db.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      if (sql.includes('FROM server_shares') && params[1] === ATTACKER) {
        return [{ target_kind: 'server', id: 'share-1', server_id: VICTIM_SERVER, target_user_id: ATTACKER,
          role, created_by: OWNER, created_at: 1, updated_at: 1, expires_at: null, revoked_at: null }] as T[];
      }
      return originalQuery<T>(sql, params);
    };
    state.cronJobs.set('other-project', { ...state.cronJobs.get('job-1'), id: 'other-project', project_name: 'second' });
    // The query fixture applies the same server/project predicates as SQL.
    const sharedQuery = state.db.query.bind(state.db);
    state.db.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const rows = await sharedQuery<T>(sql, params);
      return sql.includes('FROM cron_jobs') ? rows.filter((row) => {
        const job = row as MockRow;
        return (!params[1] || job.server_id === params[1]) && (!params[2] || job.project_name === params[2]);
      }) : rows;
    };
    const cookie = await signJwt({ sub: ATTACKER, role: 'member' }, SIGNING_KEY, 3600);
    const headers = { Cookie: `${COOKIE_SESSION}=${cookie}` };
    const list = await app.request(`/api/cron?serverId=${VICTIM_SERVER}`, { headers });
    expect(list.status).toBe(200);
    expect((await list.json() as { jobs: MockRow[] }).jobs.map(j => j.id).sort()).toEqual(['job-1', 'other-project']);
    // Participant can update owner-created in-scope job via PUT and provenance flips to creator=participant, shared=true (anti-escalation)
    const participantUpdate = await app.request('/api/cron/job-1', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'updated-by-participant' }) });
    expect(participantUpdate.status).toBe(role === 'participant' ? 200 : 403);
    if (role === 'participant') {
      expect(state.cronProvenance.get('job-1')).toMatchObject({ creator_user_id: ATTACKER, shared: true });
    } else {
      expect(state.cronProvenance.has('job-1')).toBe(false);
    }
    // Shared-provenance job can also be updated by participant and stays viewer-read-only
    state.cronJobs.set('job-shared', { ...state.cronJobs.get('job-1'), id: 'job-shared' });
    state.cronProvenance.set('job-shared', { job_id: 'job-shared', creator_user_id: ATTACKER, server_id: VICTIM_SERVER, project_name: 'proj', shared: true });
    const update = await app.request('/api/cron/job-shared', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'updated' }) });
    expect(update.status).toBe(role === 'participant' ? 200 : 403);
    const denied = await app.request(`/api/cron?serverId=${CONTROLLED_SERVER}`, { headers });
    expect(denied.status).toBe(403);
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

    it('external-CLI restricted cron uses dedicated cron-restricted route, filters execution histories before pagination, preserves restriction across owner edits/triggers, and fails closed on old servers', async () => {
      const { CRON_RESTRICTED_ACTOR_EXTERNAL_CLI, CRON_RESTRICTED_ACTOR_HEADER, CRON_RESTRICTED_ROUTE_SEGMENT } = await import('../../shared/shared-machine-authority.js');
      const { IMCODES_EXTERNAL_CLI_SENDER } = await import('../../shared/imcodes-send.js');
      const { dispatchJobNow } = await import('../src/cron/job-dispatch.js');
      const { WsBridge } = await import('../src/ws/bridge.js');

      const restrictedBase = `/api/server/${VICTIM_SERVER}/${CRON_RESTRICTED_ROUTE_SEGMENT}`;
      const daemon = daemonServerAuthHeaders({ serverId: VICTIM_SERVER, token: TOKENS.victim });
      const extHeaders = {
        ...daemon,
        [CRON_RESTRICTED_ACTOR_HEADER]: CRON_RESTRICTED_ACTOR_EXTERNAL_CLI,
      };

      // Old server without cron-restricted mount refuses before any DB write (and ordinary /cron refuses external_cli header)
      const oldServerApp = await buildApp(state.db, { includeRestrictedMount: false });
      const oldRejected = await request(oldServerApp, restrictedBase, ROUTES[1]!, extHeaders);
      expect([403, 404]).toContain(oldRejected.status);
      expect(state.writes).toEqual([]);
      expect(state.cronJobs.size).toBe(1);

      const headerOnOldCron = await request(app, base, ROUTES[1]!, extHeaders);
      expect(headerOnOldCron.status).toBe(403);
      expect(state.writes).toEqual([]);

      // Interactive browser user or headerless owner daemon cannot access cron-restricted
      const attackerJwt = signJwt({ sub: ATTACKER, role: 'owner' }, SIGNING_KEY, 3600);
      expect((await request(app, restrictedBase, ROUTES[1]!, {
        Cookie: `${COOKIE_SESSION}=${encodeURIComponent(attackerJwt)}`,
        [CRON_RESTRICTED_ACTOR_HEADER]: CRON_RESTRICTED_ACTOR_EXTERNAL_CLI,
      })).status).toBe(403);
      expect((await request(app, restrictedBase, ROUTES[1]!, daemon)).status).toBe(403);

      // External-CLI restricted turn creates a cron with creator_user_id = IMCODES_EXTERNAL_CLI_SENDER, shared = false
      const created = await request(app, restrictedBase, ROUTES[1]!, extHeaders);
      expect(created.status).toBe(201);
      const createdJson = await created.json() as { id: string };
      expect(state.cronProvenance.get(createdJson.id)).toMatchObject({
        creator_user_id: IMCODES_EXTERNAL_CLI_SENDER,
        shared: false,
      });

      // List returns only external-CLI-owned jobs, hiding owner's job-1
      const listed = await request(app, restrictedBase, ROUTES[0]!, extHeaders);
      expect(listed.status).toBe(200);
      const listedIds = ((await listed.json()) as { jobs: MockRow[] }).jobs.map((j) => j.id);
      expect(listedIds).toEqual([createdJson.id]);

      // Execution history routes isolate owner executions and filter before SQL LIMIT
      state.cronExecutions.push(
        { id: 'exec-ext-1', job_id: createdJson.id, status: 'sent', detail: 'ext-ok', created_at: 100 },
        { id: 'exec-owner-newer-1', job_id: 'job-1', status: 'error', detail: 'owner-secret-1', created_at: 200 },
        { id: 'exec-owner-newer-2', job_id: 'job-1', status: 'error', detail: 'owner-secret-2', created_at: 300 },
      );
      const execAll = await request(app, restrictedBase, { name: 'ext-exec-all', method: 'GET', path: '/executions?mode=all&limit=1' }, extHeaders);
      expect(execAll.status).toBe(200);
      const execAllJson = await execAll.json() as { executions: MockRow[] };
      expect(execAllJson.executions.map((e) => e.id)).toEqual(['exec-ext-1']);

      const execLatest = await request(app, restrictedBase, { name: 'ext-exec-latest', method: 'GET', path: '/executions?mode=latest' }, extHeaders);
      expect(execLatest.status).toBe(200);
      const execLatestJson = await execLatest.json() as { executions: MockRow[] };
      expect(execLatestJson.executions.map((e) => e.id)).toEqual(['exec-ext-1']);

      const ownerJobExecsDenied = await request(app, restrictedBase, { name: 'ext-owner-job-exec', method: 'GET', path: '/job-1/executions' }, extHeaders);
      expect(ownerJobExecsDenied.status).toBe(403);
      const extJobExecsAllowed = await request(app, restrictedBase, { name: 'ext-own-job-exec', method: 'GET', path: `/${createdJson.id}/executions` }, extHeaders);
      expect(extJobExecsAllowed.status).toBe(200);
      expect(((await extJobExecsAllowed.json()) as { executions: MockRow[] }).executions.map((e) => e.id)).toEqual(['exec-ext-1']);

      // Normal owner reads full execution history as before
      const ownerJwt = signJwt({ sub: OWNER, role: 'owner' }, SIGNING_KEY, 3600);
      const ownerHeaders = { Cookie: `${COOKIE_SESSION}=${encodeURIComponent(ownerJwt)}` };
      const ownerAll = await request(app, base, { name: 'owner-exec-all', method: 'GET', path: '/executions?mode=all' }, ownerHeaders);
      expect(ownerAll.status).toBe(200);
      expect(((await ownerAll.json()) as { executions: MockRow[] }).executions.map((e) => e.id)).toEqual([
        'exec-owner-newer-2',
        'exec-owner-newer-1',
        'exec-ext-1',
      ]);
      const ownerJob1Execs = await request(app, base, { name: 'owner-job1-exec', method: 'GET', path: '/job-1/executions' }, ownerHeaders);
      expect(ownerJob1Execs.status).toBe(200);
      expect(((await ownerJob1Execs.json()) as { executions: MockRow[] }).executions).toHaveLength(2);

      // External-CLI turn cannot modify, pause, trigger, or delete owner's job-1
      for (const call of [ROUTES[2]!, ROUTES[3]!, ROUTES[4]!, ROUTES[5]!]) {
        const res = await request(app, restrictedBase, call, extHeaders);
        expect(res.status, call.name).toBe(403);
      }
      expect(state.cronJobs.has('job-1')).toBe(true);

      // Owner renaming the restricted job keeps restricted external-CLI provenance as upper bound across scheduled + manual triggers
      const ownerRename = await request(app, base, {
        name: 'owner-rename-ext',
        method: 'PUT',
        path: `/${createdJson.id}`,
        body: { name: 'Owner Renamed CLI Job' },
      }, ownerHeaders);
      expect(ownerRename.status).toBe(200);
      expect(state.cronProvenance.get(createdJson.id)).toMatchObject({
        creator_user_id: IMCODES_EXTERNAL_CLI_SENDER,
        shared: false,
      });

      const sentPayloads: string[] = [];
      const bridge = WsBridge.get(VICTIM_SERVER);
      const origConnected = bridge.isDaemonConnected.bind(bridge);
      const origSend = bridge.sendToDaemon.bind(bridge);
      bridge.isDaemonConnected = () => true;
      bridge.sendToDaemon = (raw: string) => { sentPayloads.push(raw); };
      try {
        // Reload-based scheduled dispatch preserves restricted authority
        await dispatchJobNow(env(state.db), state.cronJobs.get(createdJson.id) as never);
        // Owner manual trigger of restricted job also preserves restricted authority
        const manualExt = await request(app, base, { name: 'owner-trig-ext', method: 'POST', path: `/${createdJson.id}/trigger` }, ownerHeaders);
        expect(manualExt.status).toBe(200);
        // Owner manual trigger of normal owner job retains ownerMachineAuthority
        const manualOwner = await request(app, base, { name: 'owner-trig-job1', method: 'POST', path: '/job-1/trigger' }, ownerHeaders);
        expect(manualOwner.status).toBe(200);
      } finally {
        bridge.isDaemonConnected = origConnected;
        bridge.sendToDaemon = origSend;
      }
      expect(sentPayloads).toHaveLength(3);
      for (const idx of [0, 1]) {
        const dispatched = JSON.parse(sentPayloads[idx]!) as Record<string, unknown>;
        expect(dispatched.sharedActor).toMatchObject({
          actorUserId: IMCODES_EXTERNAL_CLI_SENDER,
          effectiveActorRole: 'participant',
          origin: 'server-member',
        });
        expect(dispatched.ownerMachineAuthority).toBeUndefined();
        expect(dispatched.sharedMachineAuthority).toBeUndefined();
      }
      const ownerDispatched = JSON.parse(sentPayloads[2]!) as Record<string, unknown>;
      expect(ownerDispatched.sharedActor).toBeUndefined();
      expect(typeof ownerDispatched.ownerMachineAuthority).toBe('string');
      expect(state.cronProvenance.get(createdJson.id)).toMatchObject({
        creator_user_id: IMCODES_EXTERNAL_CLI_SENDER,
        shared: false,
      });
    });
  });
});
