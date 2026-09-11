/**
 * Adding people to a team by username — real PostgreSQL.
 *
 * The same identifier a person types when sharing a single machine: an invite
 * link is for someone you cannot reach directly, not for someone whose name you
 * already know and whom you already have the authority to add.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { teamRoutes } from '../src/routes/team.js';
import { signJwt } from '../src/security/crypto.js';

const JWT_KEY = 'team-membership-test-key';

let db: Database;
let ownerId: string;
let teamId: string;

const hex = (n: number) => Math.random().toString(16).slice(2, 2 + n);

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as { env: { DB: Database; JWT_SIGNING_KEY: string } }).env = {
      DB: db,
      JWT_SIGNING_KEY: JWT_KEY,
    };
    await next();
  });
  app.route('/api/team', teamRoutes);
  return app;
}

function auth(userId: string): Record<string, string> {
  return {
    authorization: `Bearer ${signJwt({ sub: userId, type: 'web' }, JWT_KEY, 3600)}`,
    'content-type': 'application/json',
  };
}

async function createUser(id: string, username: string | null): Promise<string> {
  await db.execute('INSERT INTO users (id, created_at) VALUES ($1, $2)', [id, Date.now()]);
  if (username) await db.execute('UPDATE users SET username = $2 WHERE id = $1', [id, username]);
  return id;
}

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

beforeEach(async () => {
  ownerId = await createUser(`owner-${hex(6)}`, `owner_${hex(4)}`);
  teamId = `team-${hex(8)}`;
  await db.execute(
    "INSERT INTO teams (id, name, owner_id, plan, created_at) VALUES ($1, 'Ops', $2, 'free', $3)",
    [teamId, ownerId, Date.now()],
  );
  await db.execute(
    "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)",
    [teamId, ownerId, Date.now()],
  );
});

async function members(): Promise<{ user_id: string; role: string }[]> {
  return db.query('SELECT user_id, role FROM team_members WHERE team_id = $1 ORDER BY joined_at', [teamId]);
}

describe('POST /api/team/:id/member', () => {
  it('adds by username and is idempotent without demoting anyone', async () => {
    const app = buildApp();
    const mate = await createUser(`mate-${hex(6)}`, 'Alice');

    const added = await app.request(`/api/team/${teamId}/member`, {
      method: 'POST', headers: auth(ownerId), body: JSON.stringify({ user: 'alice', role: 'admin' }),
    });
    expect(added.status, 'username match is case-insensitive').toBe(201);
    expect(await members()).toEqual([
      { user_id: ownerId, role: 'owner' },
      { user_id: mate, role: 'admin' },
    ]);

    // Re-adding must not quietly demote an admin back to member, which is what
    // a plain upsert on role would do.
    const again = await app.request(`/api/team/${teamId}/member`, {
      method: 'POST', headers: auth(ownerId), body: JSON.stringify({ user: 'Alice', role: 'member' }),
    });
    expect(again.status).toBe(200);
    expect((await members())[1]).toEqual({ user_id: mate, role: 'admin' });
  });

  it('refuses a non-manager before it will say whether a username exists', async () => {
    // Order matters: checking membership first stops this route being used to
    // enumerate accounts by anyone who is merely in the team.
    const app = buildApp();
    const plain = await createUser(`plain-${hex(6)}`, 'plain');
    const real = await createUser(`real-${hex(6)}`, 'real');
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)",
      [teamId, plain, Date.now()],
    );

    const existing = await app.request(`/api/team/${teamId}/member`, {
      method: 'POST', headers: auth(plain), body: JSON.stringify({ user: 'real' }),
    });
    const missing = await app.request(`/api/team/${teamId}/member`, {
      method: 'POST', headers: auth(plain), body: JSON.stringify({ user: 'nobody-at-all' }),
    });
    expect(existing.status).toBe(403);
    // Identical answer either way: a real username and an invented one are not
    // distinguishable to someone who may not add anybody.
    expect(missing.status).toBe(403);
    expect(await members()).toHaveLength(2);
    expect(real).toBeTruthy();
  });

  it('rejects an unknown username, a blank one, and adding yourself', async () => {
    const app = buildApp();
    for (const [body, status] of [
      [{ user: 'no-such-person' }, 404],
      [{ user: '   ' }, 400],
      [{}, 400],
    ] as const) {
      const response = await app.request(`/api/team/${teamId}/member`, {
        method: 'POST', headers: auth(ownerId), body: JSON.stringify(body),
      });
      expect(response.status).toBe(status);
    }
    const self = await app.request(`/api/team/${teamId}/member`, {
      method: 'POST', headers: auth(ownerId), body: JSON.stringify({ user: ownerId }),
    });
    expect(self.status).toBe(400);
    expect(await members()).toHaveLength(1);
  });
});
