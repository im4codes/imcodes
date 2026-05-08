/**
 * Integration tests for personal cloud memory endpoints.
 *
 * Runs against real PostgreSQL via testcontainers. Does NOT mock requireAuth —
 * verifies the actual auth middleware is applied to the personal-memory route.
 * This catches the ordering bug where requireAuth() was placed after the route.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildApp } from '../src/index.js';
import { hashPassword, signJwt, randomHex, sha256Hex } from '../src/security/crypto.js';
import type { Env } from '../src/env.js';

let db: Database;
const JWT_KEY = 'test-jwt-key-for-cloud-memory-tests-00000';

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

function makeApp() {
  return buildApp({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    JWT_SIGNING_KEY: JWT_KEY,
    BOT_ENCRYPTION_KEY: randomHex(32),
    DB: db,
    NODE_ENV: 'test',
    ALLOWED_ORIGINS: 'http://localhost',
  } as Env);
}

async function createUser(username: string): Promise<string> {
  const id = randomHex(16);
  const hash = await hashPassword('testpass');
  await db.execute(
    'INSERT INTO users (id, username, password_hash, display_name, password_must_change, is_admin, status, created_at) VALUES ($1, $2, $3, $4, false, false, $5, $6)',
    [id, username, hash, username, 'active', Date.now()],
  );
  return id;
}

async function createServer(userId: string, token: string): Promise<string> {
  const serverId = randomHex(16);
  const tokenHash = sha256Hex(token);
  await db.execute(
    'INSERT INTO servers (id, name, user_id, token_hash, created_at) VALUES ($1, $2, $3, $4, $5)',
    [serverId, 'test-server', userId, tokenHash, Date.now()],
  );
  return serverId;
}

async function seedProjection(opts: {
  userId: string;
  serverId: string;
  projectId: string;
  summary: string;
  projectionClass?: string;
  hitCount?: number;
  lastUsedAt?: number | null;
}): Promise<string> {
  const id = randomHex(16);
  const now = Date.now();
  await db.execute(
    `INSERT INTO shared_context_projections
       (id, server_id, scope, enterprise_id, workspace_id, user_id, project_id,
        projection_class, source_event_ids_json, summary, content_json,
        created_at, updated_at, replicated_at, hit_count, last_used_at)
     VALUES ($1, $2, 'personal', NULL, NULL, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10, $11, $12, $13)`,
    [id, opts.serverId, opts.userId, opts.projectId,
     opts.projectionClass ?? 'recent_summary',
     JSON.stringify(['evt-1']), opts.summary, JSON.stringify({ test: true }),
     now, now, now, opts.hitCount ?? 0, opts.lastUsedAt ?? null],
  );
  return id;
}

function csrfHeaders(token: string): Record<string, string> {
  const csrf = randomHex(16);
  return {
    Cookie: `rcc_session=${token}; rcc_csrf=${csrf}`,
    'X-CSRF-Token': csrf,
    'Content-Type': 'application/json',
    Origin: 'http://localhost',
  };
}

function makeToken(userId: string): string {
  return signJwt({ sub: userId, type: 'web' }, JWT_KEY, 3600);
}

async function clean(): Promise<void> {
  await db.exec('TRUNCATE users CASCADE');
  await db.exec('TRUNCATE servers CASCADE');
  await db.exec('TRUNCATE shared_context_projections CASCADE');
}

describe('personal cloud memory — auth and data isolation', () => {
  let userA: string;
  let userB: string;
  let serverA: string;

  beforeEach(async () => {
    await clean();
    userA = await createUser('alice');
    userB = await createUser('bob');
    serverA = await createServer(userA, 'daemon-token-a');
  });

  // ── Auth enforcement (the bug) ──────────────────────────────────────

  it('returns 401 for unauthenticated requests to /api/shared-context/personal-memory', async () => {
    const app = makeApp();
    const res = await app.request('/api/shared-context/personal-memory', {
      method: 'GET',
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when only Origin header is set (no session cookie)', async () => {
    const app = makeApp();
    const res = await app.request('/api/shared-context/personal-memory', {
      method: 'GET',
      headers: { Origin: 'http://localhost' },
    });
    expect(res.status).toBe(401);
  });

  // ── Authenticated queries ─────────────────────────────────────────

  it('returns personal projections for the authenticated user', async () => {
    await seedProjection({ userId: userA, serverId: serverA, projectId: 'repo-1', summary: 'Alice summary 1' });
    await seedProjection({ userId: userA, serverId: serverA, projectId: 'repo-2', summary: 'Alice summary 2' });

    const app = makeApp();
    const tokenA = makeToken(userA);
    const res = await app.request('/api/shared-context/personal-memory', {
      method: 'GET',
      headers: csrfHeaders(tokenA),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { stats: { totalRecords: number }; records: Array<{ summary: string }> };
    expect(body.stats.totalRecords).toBe(2);
    expect(body.records).toHaveLength(2);
    expect(body.records.map((r) => r.summary).sort()).toEqual(['Alice summary 1', 'Alice summary 2']);
  });

  it('does not leak projections across users', async () => {
    await seedProjection({ userId: userA, serverId: serverA, projectId: 'repo-1', summary: 'Alice only' });

    const app = makeApp();
    const tokenB = makeToken(userB);
    const res = await app.request('/api/shared-context/personal-memory', {
      method: 'GET',
      headers: csrfHeaders(tokenB),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { stats: { totalRecords: number }; records: unknown[] };
    expect(body.stats.totalRecords).toBe(0);
    expect(body.records).toHaveLength(0);
  });

  // ── Query filters ─────────────────────────────────────────────────

  it('filters by projectId query parameter', async () => {
    await seedProjection({ userId: userA, serverId: serverA, projectId: 'repo-1', summary: 'In repo-1' });
    await seedProjection({ userId: userA, serverId: serverA, projectId: 'repo-2', summary: 'In repo-2' });

    const app = makeApp();
    const res = await app.request('/api/shared-context/personal-memory?projectId=repo-1', {
      method: 'GET',
      headers: csrfHeaders(makeToken(userA)),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { stats: { totalRecords: number }; records: Array<{ projectId: string }> };
    expect(body.stats.totalRecords).toBe(1);
    expect(body.records[0].projectId).toBe('repo-1');
  });

  it('filters by projectionClass query parameter', async () => {
    await seedProjection({ userId: userA, serverId: serverA, projectId: 'repo-1', summary: 'Summary', projectionClass: 'recent_summary' });
    await seedProjection({ userId: userA, serverId: serverA, projectId: 'repo-1', summary: 'Decision', projectionClass: 'durable_memory_candidate' });

    const app = makeApp();
    const res = await app.request('/api/shared-context/personal-memory?projectionClass=durable_memory_candidate', {
      method: 'GET',
      headers: csrfHeaders(makeToken(userA)),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { stats: { totalRecords: number }; records: Array<{ summary: string }> };
    expect(body.stats.totalRecords).toBe(1);
    expect(body.records[0].summary).toBe('Decision');
  });

  it('does not increment recall metrics when personal memory is searched from the UI query route', async () => {
    const lastUsedAt = Date.now() - 60_000;
    const projectionId = await seedProjection({
      userId: userA,
      serverId: serverA,
      projectId: 'repo-1',
      summary: 'Deploy fix memory',
      hitCount: 2,
      lastUsedAt,
    });

    const app = makeApp();
    const headers = csrfHeaders(makeToken(userA));

    const first = await app.request('/api/shared-context/personal-memory?query=deploy&limit=10', {
      method: 'GET',
      headers,
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { records: Array<{ id: string; hitCount?: number; lastUsedAt?: number }> };
    expect(firstBody.records[0]).toEqual(expect.objectContaining({
      id: projectionId,
      hitCount: 2,
      lastUsedAt,
    }));

    const second = await app.request('/api/shared-context/personal-memory?query=deploy&limit=10', {
      method: 'GET',
      headers,
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { records: Array<{ id: string; hitCount?: number; lastUsedAt?: number }> };
    expect(secondBody.records[0]).toEqual(expect.objectContaining({
      id: projectionId,
      hitCount: 2,
      lastUsedAt,
    }));

    const persisted = await db.queryOne<{ hit_count: number; last_used_at: number | null }>(
      'SELECT hit_count, last_used_at FROM shared_context_projections WHERE id = $1',
      [projectionId],
    );
    expect(persisted).toEqual({ hit_count: 2, last_used_at: lastUsedAt });
  });


  // ── Daemon replication → cloud query round-trip ───────────────────

  it('daemon POST replication creates projections that are visible in authenticated cloud query', async () => {
    const app = makeApp();

    // 1. Daemon replicates via Bearer token
    const postRes = await app.request(`/api/server/${serverA}/shared-context/processed`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer daemon-token-a',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        namespace: { scope: 'personal', projectId: 'my-repo' },
        projections: [{
          id: randomHex(16),
          namespace: { scope: 'personal', projectId: 'my-repo' },
          class: 'recent_summary',
          origin: 'chat_compacted',
          sourceEventIds: ['e1', 'e2'],
          summary: 'Replicated from daemon',
          content: { trigger: 'idle' },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }],
      }),
    });
    expect(postRes.status).toBe(200);
    const ack = await postRes.json() as { ok: boolean; projectionCount: number };
    expect(ack.ok).toBe(true);
    expect(ack.projectionCount).toBe(1);

    // 2. User queries cloud via session auth — should see the projection
    const getRes = await app.request('/api/shared-context/personal-memory', {
      method: 'GET',
      headers: csrfHeaders(makeToken(userA)),
    });
    expect(getRes.status).toBe(200);
    const body = await getRes.json() as { stats: { totalRecords: number }; records: Array<{ summary: string }> };
    expect(body.stats.totalRecords).toBe(1);
    expect(body.records[0].summary).toBe('Replicated from daemon');
  });

  it('daemon POST replication is not visible to a different user', async () => {
    const app = makeApp();

    // Daemon replicates for userA
    const postRes = await app.request(`/api/server/${serverA}/shared-context/processed`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer daemon-token-a',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        namespace: { scope: 'personal', projectId: 'my-repo' },
        projections: [{
          id: randomHex(16),
          namespace: { scope: 'personal', projectId: 'my-repo' },
          class: 'recent_summary',
          origin: 'chat_compacted',
          sourceEventIds: ['e1'],
          summary: 'Alice secret memory',
          content: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }],
      }),
    });
    expect(postRes.status).toBe(200);

    // UserB queries — should NOT see it
    const getRes = await app.request('/api/shared-context/personal-memory', {
      method: 'GET',
      headers: csrfHeaders(makeToken(userB)),
    });
    expect(getRes.status).toBe(200);
    const body = await getRes.json() as { stats: { totalRecords: number }; records: unknown[] };
    expect(body.stats.totalRecords).toBe(0);
  });
});
