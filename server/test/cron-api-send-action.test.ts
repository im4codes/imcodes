import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { MEMORY_MCP_SOURCE_FIELDS } from '../../shared/memory-mcp-provenance.js';

const mockResolveServerRole = vi.fn<() => Promise<string>>().mockResolvedValue('owner');

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'member');
    await next();
  },
  resolveServerRole: (...args: unknown[]) => mockResolveServerRole(...args as []),
}));

vi.mock('../src/security/audit.js', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/security/crypto.js', () => ({
  randomHex: vi.fn((n: number) => `id-${n}`),
  sha256Hex: vi.fn((value: string) => `sha:${value}`),
  verifyToken: vi.fn(),
  randomToken: vi.fn(),
}));

interface MockRow {
  [key: string]: unknown;
}

function normalize(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, ' ').trim();
}

function makeMockDb() {
  const cronJobs = new Map<string, MockRow>();
  const db = {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const s = normalize(sql);
      if (s.includes('from cron_jobs where id') && s.includes('user_id')) {
        const job = cronJobs.get(params[0] as string);
        return job && job.user_id === params[1] ? job as T : null;
      }
      if (s.includes('from servers where id')) {
        return { user_id: 'user-1' } as T;
      }
      return null;
    },
    query: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const s = normalize(sql);
      if (s.includes('from cron_jobs')) {
        const serverId = params[1] as string | null | undefined;
        return Array.from(cronJobs.values()).filter((job) => !serverId || job.server_id === serverId) as T[];
      }
      return [];
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
          target_session_name: params[7],
          action: params[8],
          timezone: params[9],
          status: params[10],
          next_run_at: params[11],
          expires_at: params[12],
          created_at: params[13],
          updated_at: params[13],
        });
      }
      return { changes: 1 };
    },
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;
  return { db, cronJobs };
}

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

async function buildApp(env: Env) {
  const { cronApiRoutes } = await import('../src/routes/cron-api.js');
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    if (!c.env) (c as unknown as { env: Env }).env = {} as Env;
    Object.assign(c.env, env);
    await next();
  });
  app.route('/api/cron', cronApiRoutes);
  app.route('/api/server/:serverId/cron', cronApiRoutes);
  return app;
}

function jsonReq(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

describe('cron API structured send actions', () => {
  let app: Hono<{ Bindings: Env }>;
  let dbState: ReturnType<typeof makeMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockResolveServerRole.mockResolvedValue('owner');
    dbState = makeMockDb();
    app = await buildApp(makeEnv(dbState.db));
  });

  it('accepts structured send actions and strips untrusted source provenance from regular API requests', async () => {
    const res = await app.request('/api/cron', jsonReq('POST', {
      name: 'Send reminder',
      cronExpr: '0 9 * * *',
      serverId: 'srv-1',
      projectName: 'proj',
      targetRole: 'brain',
      action: {
        type: 'send',
        target: 'w1',
        message: 'please review this',
        reply: true,
        idempotencyKey: 'idem-1',
        [MEMORY_MCP_SOURCE_FIELDS.SOURCE_SESSION_NAME]: 'deck_sub_scheduler',
        [MEMORY_MCP_SOURCE_FIELDS.SOURCE_PROJECT_NAME]: 'proj',
        [MEMORY_MCP_SOURCE_FIELDS.SOURCE_SERVER_ID]: 'srv-1',
      },
    }));

    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.action).toEqual({
      type: 'send',
      target: 'w1',
      message: 'please review this',
      reply: true,
      idempotencyKey: 'idem-1',
    });
  });

  it('preserves source provenance for no-auth daemon pod-sticky cron requests', async () => {
    const res = await app.request('/api/server/srv-1/cron', jsonReq('POST', {
      name: 'Send reminder',
      cronExpr: '0 9 * * *',
      serverId: 'srv-forged',
      projectName: 'proj',
      targetRole: 'brain',
      action: {
        type: 'send',
        target: 'w1',
        message: 'please review this',
        [MEMORY_MCP_SOURCE_FIELDS.SOURCE_SESSION_NAME]: 'deck_sub_scheduler',
        [MEMORY_MCP_SOURCE_FIELDS.SOURCE_PROJECT_NAME]: 'proj',
        [MEMORY_MCP_SOURCE_FIELDS.SOURCE_SERVER_ID]: 'srv-1',
      },
    }));

    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.action).toMatchObject({
      type: 'send',
      target: 'w1',
      message: 'please review this',
      sourceSessionName: 'deck_sub_scheduler',
      sourceProjectName: 'proj',
      sourceServerId: 'srv-1',
    });
  });

  it('still preserves source provenance for legacy daemon server-token pod-sticky cron requests', async () => {
    const res = await app.request('/api/server/srv-1/cron', jsonReq('POST', {
      name: 'Send reminder',
      cronExpr: '0 9 * * *',
      serverId: 'srv-forged',
      projectName: 'proj',
      targetRole: 'brain',
      action: {
        type: 'send',
        target: 'w1',
        message: 'please review this',
        [MEMORY_MCP_SOURCE_FIELDS.SOURCE_SESSION_NAME]: 'deck_sub_scheduler',
        [MEMORY_MCP_SOURCE_FIELDS.SOURCE_PROJECT_NAME]: 'proj',
        [MEMORY_MCP_SOURCE_FIELDS.SOURCE_SERVER_ID]: 'srv-1',
      },
    }, {
      Authorization: 'Bearer server-token',
      'X-Server-Id': 'srv-1',
    }));

    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.action).toMatchObject({
      sourceSessionName: 'deck_sub_scheduler',
      sourceProjectName: 'proj',
      sourceServerId: 'srv-1',
    });
  });

  it('keeps command and p2p actions backward-compatible', async () => {
    const command = await app.request('/api/cron', jsonReq('POST', {
      name: 'Command',
      cronExpr: '0 10 * * *',
      serverId: 'srv-1',
      projectName: 'proj',
      targetRole: 'brain',
      action: { type: 'command', command: '/status' },
    }));
    expect(command.status).toBe(201);

    const p2p = await app.request('/api/cron', jsonReq('POST', {
      name: 'P2P',
      cronExpr: '0 11 * * *',
      serverId: 'srv-1',
      projectName: 'proj',
      targetRole: 'brain',
      action: { type: 'p2p', topic: 'audit this', mode: 'review', participants: ['w1'] },
    }));
    expect(p2p.status).toBe(201);
  });

  it('rejects invalid structured send actions', async () => {
    const res = await app.request('/api/cron', jsonReq('POST', {
      name: 'Bad send',
      cronExpr: '0 9 * * *',
      serverId: 'srv-1',
      projectName: 'proj',
      targetRole: 'brain',
      action: { type: 'send', target: 'w1' },
    }));

    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('invalid_body');
  });

  it('uses pod-sticky route serverId instead of forged body serverId', async () => {
    const res = await app.request('/api/server/srv-bound/cron', jsonReq('POST', {
      name: 'Sticky send',
      cronExpr: '0 9 * * *',
      serverId: 'srv-forged',
      projectName: 'proj',
      targetRole: 'brain',
      action: { type: 'send', target: 'w1', message: 'sticky route' },
    }));

    expect(res.status).toBe(201);
    expect(mockResolveServerRole).toHaveBeenCalledWith(expect.anything(), 'srv-bound', 'user-1');
    expect(Array.from(dbState.cronJobs.values())[0]?.server_id).toBe('srv-bound');
  });
});
