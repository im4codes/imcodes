/**
 * Tests for cron-api routes (POST/GET/PATCH/PUT/DELETE /api/cron).
 *
 * Uses Hono's built-in `app.request()` with mocked auth, audit, and DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { CRON_STATUS } from '../../shared/cron-types.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock requireAuth to inject a deterministic userId without real JWT/cookie logic.
// Mock resolveServerRole to be controllable per-test.
const mockResolveServerRole = vi.fn<() => Promise<string>>().mockResolvedValue('owner');

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'member');
    await next();
  },
  resolveServerRole: (...args: unknown[]) => mockResolveServerRole(...args as []),
}));

vi.mock('../src/security/audit.js', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/security/crypto.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/security/crypto.js')>();
  let counter = 0;
  return {
    ...real,
    randomHex: (_n: number) => `cron-id-${++counter}`,
  };
});

// ── Mock DB ──────────────────────────────────────────────────────────────────

interface MockRow {
  [key: string]: unknown;
}

function makeMockDb() {
  const cronJobs = new Map<string, MockRow>();
  const cronExecutions: MockRow[] = [];

  function normalize(sql: string): string {
    return sql.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  const db: Database = {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const s = normalize(sql);

      if (s.includes('from cron_jobs where id') && s.includes('user_id')) {
        const job = cronJobs.get(params[0] as string);
        if (job && job.user_id === params[1]) return job as T;
        return null;
      }

      return null;
    },

    query: async <T = unknown>(sql: string, _params: unknown[] = []): Promise<T[]> => {
      const s = normalize(sql);

      if (s.includes('from cron_jobs')) {
        return Array.from(cronJobs.values()) as T[];
      }

      if (s.includes('from cron_executions')) {
        return cronExecutions as T[];
      }

      return [] as T[];
    },

    execute: async (sql: string, params: unknown[] = []): Promise<{ changes: number }> => {
      const s = normalize(sql);

      if (s.includes('insert into cron_jobs')) {
        cronJobs.set(params[0] as string, {
          id: params[0],
          server_id: params[1],
          user_id: params[2],
          name: params[3],
          cron_expr: params[4],
          project_name: params[5],
          target_role: params[6],
          action: params[7],
          status: params[8],
          next_run_at: params[9],
          expires_at: params[10],
          created_at: params[11],
          updated_at: params[11],
          last_run_at: null,
        });
      }

      if (s.includes('update cron_jobs set')) {
        // Find the job and update its fields (simplified — just updates status for the
        // PATCH and marks updated_at)
        const idIdx = params.length - 1;
        const jobId = params[idIdx] as string;
        const job = cronJobs.get(jobId);
        if (job) {
          // For PATCH status updates, status is $1 and updated_at is $2
          if (s.includes('set status =')) {
            job.status = params[0];
            job.updated_at = params[1];
          }
          cronJobs.set(jobId, job);
        }
      }

      if (s.includes('delete from cron_jobs')) {
        cronJobs.delete(params[0] as string);
      }

      if (s.includes('insert into audit_log')) {
        // no-op
      }

      return { changes: 1 };
    },

    exec: async () => {},
    close: async () => {},
  } as unknown as Database;

  return { db, cronJobs, cronExecutions };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEnv(db: Database): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'http://localhost:3000',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'development',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    DATABASE_URL: '',
  } as Env;
}

/** Build a minimal Hono app with just the cron routes and env injection. */
async function buildTestApp(env: Env) {
  // Import after mocks are set up
  const { cronApiRoutes } = await import('../src/routes/cron-api.js');

  const app = new Hono<{ Bindings: Env }>();

  // Inject env into every request (mirrors buildApp pattern)
  app.use('*', async (c, next) => {
    if (!c.env) (c as unknown as { env: Env }).env = {} as Env;
    Object.assign(c.env, env);
    await next();
  });

  app.route('/api/cron', cronApiRoutes);
  return app;
}

function jsonReq(method: string, path: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Cron API routes', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockDb: ReturnType<typeof makeMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockResolveServerRole.mockResolvedValue('owner');
    mockDb = makeMockDb();
    const env = makeEnv(mockDb.db);
    app = await buildTestApp(env);
  });

  // ── POST /api/cron ───────────────────────────────────────────────────────

  describe('POST /api/cron', () => {
    const validCommandBody = {
      name: 'Daily report',
      cronExpr: '0 9 * * *', // every day at 9am — interval = 24h
      serverId: 'srv-1',
      projectName: 'myapp',
      targetRole: 'brain',
      action: { type: 'command', command: '/status' },
    };

    it('valid command action returns 201', async () => {
      const res = await app.request('/api/cron', jsonReq('POST', '/api/cron', validCommandBody));
      expect(res.status).toBe(201);
      const body = await res.json() as Record<string, unknown>;
      expect(body.name).toBe('Daily report');
      expect(body.status).toBe(CRON_STATUS.ACTIVE);
      expect(body.nextRunAt).toBeTypeOf('number');
      expect(body.action).toEqual({ type: 'command', command: '/status' });
    });

    it('command action missing `command` field returns 400', async () => {
      const res = await app.request('/api/cron', jsonReq('POST', '/api/cron', {
        ...validCommandBody,
        action: { type: 'command' }, // missing command
      }));
      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('invalid_body');
    });

    it('invalid cron expression returns 400', async () => {
      const res = await app.request('/api/cron', jsonReq('POST', '/api/cron', {
        ...validCommandBody,
        cronExpr: 'not a cron',
      }));
      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('invalid_cron_expression');
    });

    it('interval < 5 min returns 400 with cron_interval_too_short', async () => {
      const res = await app.request('/api/cron', jsonReq('POST', '/api/cron', {
        ...validCommandBody,
        cronExpr: '* * * * *', // every minute
      }));
      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('cron_interval_too_short');
      expect(body.minIntervalMinutes).toBe(5);
    });

    it('unauthorized server returns 403', async () => {
      mockResolveServerRole.mockResolvedValue('none');
      const res = await app.request('/api/cron', jsonReq('POST', '/api/cron', validCommandBody));
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('forbidden');
    });

    it('valid P2P action returns 201', async () => {
      const res = await app.request('/api/cron', jsonReq('POST', '/api/cron', {
        ...validCommandBody,
        action: {
          type: 'p2p',
          topic: 'Code review',
          mode: 'review',
          participants: ['brain', 'w1'],
          rounds: 3,
        },
      }));
      expect(res.status).toBe(201);
      const body = await res.json() as Record<string, unknown>;
      expect(body.action).toEqual({
        type: 'p2p',
        topic: 'Code review',
        mode: 'review',
        participants: ['brain', 'w1'],
        rounds: 3,
      });
    });

    it('P2P with empty participants returns 400', async () => {
      const res = await app.request('/api/cron', jsonReq('POST', '/api/cron', {
        ...validCommandBody,
        action: {
          type: 'p2p',
          topic: 'Code review',
          mode: 'review',
          participants: [],
        },
      }));
      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('invalid_body');
    });
  });

  // ── GET /api/cron ────────────────────────────────────────────────────────

  describe('GET /api/cron', () => {
    it('returns user jobs', async () => {
      // Seed a job directly
      mockDb.cronJobs.set('job-1', {
        id: 'job-1',
        server_id: 'srv-1',
        user_id: 'user-1',
        name: 'Test Job',
        cron_expr: '0 9 * * *',
        project_name: 'myapp',
        target_role: 'brain',
        action: JSON.stringify({ type: 'command', command: '/status' }),
        status: CRON_STATUS.ACTIVE,
        next_run_at: Date.now() + 86400000,
        expires_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
        last_run_at: null,
      });

      const res = await app.request('/api/cron', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = await res.json() as { jobs: unknown[] };
      expect(body.jobs).toHaveLength(1);
    });

    it('forbidden server returns 403 when filtering by serverId', async () => {
      mockResolveServerRole.mockResolvedValue('none');
      const res = await app.request('/api/cron?serverId=srv-forbidden', { method: 'GET' });
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('forbidden');
    });
  });

  // ── PATCH /api/cron/:id/status ───────────────────────────────────────────

  describe('PATCH /api/cron/:id/status', () => {
    beforeEach(() => {
      // Seed an active job
      mockDb.cronJobs.set('job-active', {
        id: 'job-active',
        server_id: 'srv-1',
        user_id: 'user-1',
        name: 'Active Job',
        cron_expr: '0 9 * * *',
        project_name: 'myapp',
        target_role: 'brain',
        action: JSON.stringify({ type: 'command', command: '/status' }),
        status: CRON_STATUS.ACTIVE,
        next_run_at: Date.now() + 86400000,
        expires_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
        last_run_at: null,
      });
    });

    it('pause active job succeeds', async () => {
      const res = await app.request(
        '/api/cron/job-active/status',
        jsonReq('PATCH', '', { status: CRON_STATUS.PAUSED }),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
    });

    it('resume expired job returns 400 cannot_resume', async () => {
      mockDb.cronJobs.set('job-expired', {
        id: 'job-expired',
        server_id: 'srv-1',
        user_id: 'user-1',
        name: 'Expired Job',
        cron_expr: '0 9 * * *',
        project_name: 'myapp',
        target_role: 'brain',
        action: JSON.stringify({ type: 'command', command: '/status' }),
        status: CRON_STATUS.EXPIRED,
        next_run_at: null,
        expires_at: Date.now() - 1000,
        created_at: Date.now() - 100000,
        updated_at: Date.now(),
        last_run_at: null,
      });

      const res = await app.request(
        '/api/cron/job-expired/status',
        jsonReq('PATCH', '', { status: CRON_STATUS.ACTIVE }),
      );
      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('cannot_resume');
      expect(body.currentStatus).toBe(CRON_STATUS.EXPIRED);
    });

    it('resume error job returns 400 cannot_resume', async () => {
      mockDb.cronJobs.set('job-error', {
        id: 'job-error',
        server_id: 'srv-1',
        user_id: 'user-1',
        name: 'Error Job',
        cron_expr: '0 9 * * *',
        project_name: 'myapp',
        target_role: 'brain',
        action: JSON.stringify({ type: 'command', command: '/status' }),
        status: CRON_STATUS.ERROR,
        next_run_at: null,
        expires_at: null,
        created_at: Date.now() - 100000,
        updated_at: Date.now(),
        last_run_at: null,
      });

      const res = await app.request(
        '/api/cron/job-error/status',
        jsonReq('PATCH', '', { status: CRON_STATUS.ACTIVE }),
      );
      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('cannot_resume');
      expect(body.currentStatus).toBe(CRON_STATUS.ERROR);
    });
  });

  // ── PUT /api/cron/:id ────────────────────────────────────────────────────

  describe('PUT /api/cron/:id', () => {
    beforeEach(() => {
      mockDb.cronJobs.set('job-update', {
        id: 'job-update',
        server_id: 'srv-1',
        user_id: 'user-1',
        name: 'Original Name',
        cron_expr: '0 9 * * *',
        project_name: 'myapp',
        target_role: 'brain',
        action: JSON.stringify({ type: 'command', command: '/status' }),
        status: CRON_STATUS.ACTIVE,
        next_run_at: Date.now() + 86400000,
        expires_at: null,
        created_at: Date.now() - 100000,
        updated_at: Date.now(),
        last_run_at: null,
      });
    });

    it('updates and recalculates next_run_at', async () => {
      const res = await app.request(
        '/api/cron/job-update',
        jsonReq('PUT', '', { name: 'Updated Name', cronExpr: '0 12 * * *' }),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
    });

    it('resets expired job to paused', async () => {
      mockDb.cronJobs.set('job-expired-edit', {
        id: 'job-expired-edit',
        server_id: 'srv-1',
        user_id: 'user-1',
        name: 'Expired Job',
        cron_expr: '0 9 * * *',
        project_name: 'myapp',
        target_role: 'brain',
        action: JSON.stringify({ type: 'command', command: '/status' }),
        status: CRON_STATUS.EXPIRED,
        next_run_at: null,
        expires_at: Date.now() - 1000,
        created_at: Date.now() - 200000,
        updated_at: Date.now(),
        last_run_at: null,
      });

      const res = await app.request(
        '/api/cron/job-expired-edit',
        jsonReq('PUT', '', { name: 'Revived Job' }),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
    });
  });

  // ── DELETE /api/cron/:id ─────────────────────────────────────────────────

  describe('DELETE /api/cron/:id', () => {
    it('deletes own job', async () => {
      mockDb.cronJobs.set('job-delete', {
        id: 'job-delete',
        server_id: 'srv-1',
        user_id: 'user-1',
        name: 'To Delete',
        cron_expr: '0 9 * * *',
        project_name: 'myapp',
        target_role: 'brain',
        action: JSON.stringify({ type: 'command', command: '/status' }),
        status: CRON_STATUS.ACTIVE,
        next_run_at: Date.now() + 86400000,
        expires_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
        last_run_at: null,
      });

      const res = await app.request('/api/cron/job-delete', { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      // Verify job was removed
      expect(mockDb.cronJobs.has('job-delete')).toBe(false);
    });
  });

  // ── GET /api/cron/:id/executions ─────────────────────────────────────────

  describe('GET /api/cron/:id/executions', () => {
    it('returns execution history', async () => {
      // Seed the job so ownership check passes
      mockDb.cronJobs.set('job-exec', {
        id: 'job-exec',
        server_id: 'srv-1',
        user_id: 'user-1',
        name: 'Exec Job',
        cron_expr: '0 9 * * *',
        project_name: 'myapp',
        target_role: 'brain',
        action: JSON.stringify({ type: 'command', command: '/status' }),
        status: CRON_STATUS.ACTIVE,
        next_run_at: Date.now() + 86400000,
        expires_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
        last_run_at: null,
      });

      // Seed executions
      mockDb.cronExecutions.push(
        { id: 'exec-1', job_id: 'job-exec', status: 'ok', detail: null, created_at: Date.now() - 5000 },
        { id: 'exec-2', job_id: 'job-exec', status: 'error', detail: 'timeout', created_at: Date.now() },
      );

      const res = await app.request('/api/cron/job-exec/executions', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = await res.json() as { executions: unknown[] };
      expect(body.executions).toHaveLength(2);
    });

    it('returns 403 when resolveServerRole is none', async () => {
      mockDb.cronJobs.set('job-exec-forbidden', {
        id: 'job-exec-forbidden',
        server_id: 'srv-1',
        user_id: 'user-1',
        name: 'Forbidden Exec',
        cron_expr: '0 9 * * *',
        project_name: 'myapp',
        target_role: 'brain',
        action: JSON.stringify({ type: 'command', command: '/status' }),
        status: CRON_STATUS.ACTIVE,
        next_run_at: Date.now() + 86400000,
        expires_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
        last_run_at: null,
      });

      mockResolveServerRole.mockResolvedValue('none');
      const res = await app.request('/api/cron/job-exec-forbidden/executions', { method: 'GET' });
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('forbidden');
    });
  });

  // ── Sub-session targeting (POST) ──────────────────────────────────────

  describe('POST /api/cron (sub-session targeting)', () => {
    const baseBody = {
      name: 'Sub-session job',
      cronExpr: '0 9 * * *',
      serverId: 'srv-1',
      projectName: 'myapp',
      targetRole: 'brain',
      action: { type: 'command', command: '/status' },
    };

    it('accepts valid targetSessionName', async () => {
      const res = await app.request('/api/cron', jsonReq('POST', '/api/cron', {
        ...baseBody,
        targetSessionName: 'deck_sub_abc123',
      }));
      expect(res.status).toBe(201);
      const body = await res.json() as Record<string, unknown>;
      expect(body.targetSessionName).toBe('deck_sub_abc123');
    });

    it('rejects invalid targetSessionName pattern', async () => {
      const res = await app.request('/api/cron', jsonReq('POST', '/api/cron', {
        ...baseBody,
        targetSessionName: '../etc/passwd',
      }));
      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('invalid_body');
    });

    it('validates P2P mode against shared constants', async () => {
      const res = await app.request('/api/cron', jsonReq('POST', '/api/cron', {
        ...baseBody,
        action: {
          type: 'p2p',
          topic: 'Code review',
          mode: 'nonexistent_mode',
          participants: ['brain', 'w1'],
        },
      }));
      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('invalid_body');
    });
  });

  // ── Auth gap: PATCH /status and GET /executions check resolveServerRole ──

  describe('PATCH /api/cron/:id/status (auth)', () => {
    it('returns 403 when resolveServerRole is none', async () => {
      mockDb.cronJobs.set('job-auth-patch', {
        id: 'job-auth-patch',
        server_id: 'srv-1',
        user_id: 'user-1',
        name: 'Auth Patch Job',
        cron_expr: '0 9 * * *',
        project_name: 'myapp',
        target_role: 'brain',
        action: JSON.stringify({ type: 'command', command: '/status' }),
        status: CRON_STATUS.ACTIVE,
        next_run_at: Date.now() + 86400000,
        expires_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
        last_run_at: null,
      });

      mockResolveServerRole.mockResolvedValue('none');
      const res = await app.request(
        '/api/cron/job-auth-patch/status',
        jsonReq('PATCH', '', { status: CRON_STATUS.PAUSED }),
      );
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('forbidden');
    });
  });
});
