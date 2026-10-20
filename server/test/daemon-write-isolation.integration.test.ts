/**
 * tsk_854675e1e2 — real PostgreSQL (TEST_DATABASE_URL). A daemon authenticates with its own server token, but several of its writes took
 * a record id from the payload and keyed the SQL on it alone. Each check below writes a victim's row first, then tries to reach it from
 * ANOTHER user's server, and finally proves the owner's own write still works.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildApp } from '../src/index.js';
import { buildCronExecutionResultUpdate } from '../src/cron/execution-result.js';
import { randomHex } from '../src/security/crypto.js';
import type { Env } from '../src/env.js';

let db: Database;
let app: ReturnType<typeof buildApp>;
const tag = randomHex(4);
const A = { user: `user-a-${tag}`, server: `srv-a-${tag}`, token: `token-a-${tag}` };
const B = { user: `user-b-${tag}`, server: `srv-b-${tag}`, token: `token-b-${tag}` };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
  app = buildApp({
    DATABASE_URL: process.env.TEST_DATABASE_URL!, JWT_SIGNING_KEY: 'test-jwt-key-for-isolation-tests-0000000', BOT_ENCRYPTION_KEY: randomHex(32),
    DB: db, NODE_ENV: 'test', ALLOWED_ORIGINS: 'http://localhost',
  } as Env);
  for (const side of [A, B]) {
    await db.execute('INSERT INTO users (id, created_at) VALUES ($1, $2)', [side.user, Date.now()]);
    await db.execute('INSERT INTO servers (id, user_id, name, token_hash, created_at) VALUES ($1, $2, $3, $4, $5)',
      [side.server, side.user, side.server, sha(side.token), Date.now()]);
  }
});

afterAll(async () => { await db.close(); });

describe('cron execution results', () => {
  it("a daemon can only update executions of its own server's jobs, and never set the dispatcher's states", async () => {
    await db.execute('INSERT INTO cron_jobs (id, server_id, user_id, name, cron_expr, action, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [`job-b-${tag}`, B.server, B.user, 'b', '* * * * *', '{}', Date.now()]);
    await db.execute('INSERT INTO cron_executions (id, job_id, status, detail, created_at) VALUES ($1, $2, $3, $4, $5)',
      [`exec-b-${tag}`, `job-b-${tag}`, 'dispatched', 'original', Date.now()]);
    const read = () => db.queryOne<{ status: string; detail: string }>('SELECT status, detail FROM cron_executions WHERE id = $1', [`exec-b-${tag}`]);

    const foreignById = buildCronExecutionResultUpdate({ authenticatedServerId: A.server, jobId: `job-b-${tag}`, executionId: `exec-b-${tag}`, status: 'error', detail: 'pwned' })!;
    expect((await db.execute(foreignById.sql, foreignById.params)).changes).toBe(0);
    const foreignLatest = buildCronExecutionResultUpdate({ authenticatedServerId: A.server, jobId: `job-b-${tag}`, detail: 'pwned' })!;
    expect((await db.execute(foreignLatest.sql, foreignLatest.params)).changes).toBe(0);
    // Even claiming the victim's execution under a job id of its OWN does not reach it.
    await db.execute('INSERT INTO cron_jobs (id, server_id, user_id, name, cron_expr, action, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [`job-a-${tag}`, A.server, A.user, 'a', '* * * * *', '{}', Date.now()]);
    const mismatched = buildCronExecutionResultUpdate({ authenticatedServerId: A.server, jobId: `job-a-${tag}`, executionId: `exec-b-${tag}`, detail: 'pwned' })!;
    expect((await db.execute(mismatched.sql, mismatched.params)).changes).toBe(0);
    expect(await read()).toEqual({ status: 'dispatched', detail: 'original' });
    expect(buildCronExecutionResultUpdate({ authenticatedServerId: B.server, jobId: `job-b-${tag}`, executionId: `exec-b-${tag}`, status: 'pending_dispatch', detail: 'x' })).toBeNull();

    const own = buildCronExecutionResultUpdate({ authenticatedServerId: B.server, jobId: `job-b-${tag}`, executionId: `exec-b-${tag}`, status: 'error', detail: 'mine' })!;
    expect((await db.execute(own.sql, own.params)).changes).toBe(1);
    expect(await read()).toEqual({ status: 'error', detail: 'mine' });
  });
});

describe('shared-context projection replication', () => {
  const projection = (id: string, summary: string, userId?: string) => ({
    namespace: { scope: 'personal', projectId: 'proj-1', ...(userId ? { userId } : {}) },
    projections: [{
      id, namespace: { scope: 'personal', projectId: 'proj-1', ...(userId ? { userId } : {}) }, class: 'recent_summary', origin: 'chat_compacted',
      sourceEventIds: [], summary, content: { text: summary }, createdAt: 1, updatedAt: 2,
    }],
  });
  const post = (side: typeof A, body: unknown) => app.request(`/api/server/${side.server}/shared-context/processed`, {
    method: 'POST', headers: { Authorization: `Bearer ${side.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const row = () => db.queryOne<{ server_id: string; user_id: string | null; summary: string }>(
    'SELECT server_id, user_id, summary FROM shared_context_projections WHERE id = $1', [`proj-b-${tag}`]);

  it("another user's server cannot rewrite or take over an existing projection by its id; the owner still can", async () => {
    expect((await post(B, projection(`proj-b-${tag}`, 'victim memory text that is long enough to keep'))).status).toBe(200);
    expect(await row()).toMatchObject({ server_id: B.server, user_id: B.user, summary: 'victim memory text that is long enough to keep' });

    const attack = await post(A, projection(`proj-b-${tag}`, 'attacker replacement text that is long enough'));
    expect(attack.status).toBe(200);
    expect(await attack.json()).toMatchObject({ projectionCount: 0 });
    expect(await row()).toMatchObject({ server_id: B.server, user_id: B.user, summary: 'victim memory text that is long enough to keep' });

    const update = await post(B, projection(`proj-b-${tag}`, 'victim memory text after the owner edited it'));
    expect(await update.json()).toMatchObject({ projectionCount: 1 });
    expect((await row())!.summary).toBe('victim memory text after the owner edited it');
  });

  it('a personal projection moves between two servers of the SAME user (a re-bound daemon)', async () => {
    const second = { user: A.user, server: `srv-a2-${tag}`, token: `token-a2-${tag}` };
    await db.execute('INSERT INTO servers (id, user_id, name, token_hash, created_at) VALUES ($1, $2, $3, $4, $5)',
      [second.server, second.user, second.server, sha(second.token), Date.now()]);
    expect((await post(A, projection(`proj-a-${tag}`, 'personal memory of user a, first server'))).status).toBe(200);
    const moved = await post(second, projection(`proj-a-${tag}`, 'personal memory of user a, second server'));
    expect(await moved.json()).toMatchObject({ projectionCount: 1 });
  });
});

describe('channel bindings', () => {
  it("a daemon cannot bind or re-point another user's bot", async () => {
    await db.execute('INSERT INTO platform_bots (id, user_id, platform, config_encrypted, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)',
      [`bot-b-${tag}`, B.user, 'telegram', 'x', Date.now()]);
    const bind = (side: typeof A, botId: string) => app.request(`/api/server/${side.server}/bindings`, {
      method: 'POST', headers: { Authorization: `Bearer ${side.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'telegram', channelId: 'chan', botId, bindingType: 'session', target: 'deck_p_brain' }),
    });
    expect((await bind(B, `bot-b-${tag}`)).status).toBe(200);
    expect((await bind(A, `bot-b-${tag}`)).status).toBe(403);
    expect((await db.queryOne<{ server_id: string }>('SELECT server_id FROM channel_bindings WHERE bot_id = $1', [`bot-b-${tag}`]))!.server_id).toBe(B.server);
  });
});
