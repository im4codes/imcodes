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
    for (const [body, status, code] of [
      [{ user: 'no-such-person' }, 404, 'user_not_found'],
      [{ user: '   ' }, 400, 'user_required'],
      [{}, 400, 'user_required'],
    ] as const) {
      const response = await app.request(`/api/team/${teamId}/member`, {
        method: 'POST', headers: auth(ownerId), body: JSON.stringify(body),
      });
      expect(response.status).toBe(status);
      // The cause has to be readable by the client, or the UI can only ever
      // show the person a bare status code.
      expect(await response.json()).toMatchObject({ error: code });
    }
    const self = await app.request(`/api/team/${teamId}/member`, {
      method: 'POST', headers: auth(ownerId), body: JSON.stringify({ user: ownerId }),
    });
    expect(self.status).toBe(400);
    expect(await members()).toHaveLength(1);
  });
});

describe('renaming and deleting a group', () => {
  async function machineIn(group: string | null, ownerId: string): Promise<string> {
    const id = `srv-${hex(8)}`;
    await db.execute(
      `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, node_id)
       VALUES ($1, $2, 'm', 'h', 'offline', $3, 'controlled', $4)`,
      [id, ownerId, Date.now(), String(Math.floor(1e9 + Math.random() * 8.9e9))],
    );
    if (group) {
      await db.execute(
        'INSERT INTO machine_groups (server_id, team_id, added_at) VALUES ($1, $2, $3)',
        [id, group, Date.now()],
      );
    }
    return id;
  }

  it('renames a group, and refuses a blank or oversized name', async () => {
    const app = buildApp();
    const renamed = await app.request(`/api/team/${teamId}`, {
      method: 'PATCH', headers: auth(ownerId), body: JSON.stringify({ name: '  运维组  ' }),
    });
    expect(renamed.status).toBe(200);
    expect(await db.queryOne('SELECT name FROM teams WHERE id = $1', [teamId]))
      .toEqual({ name: '运维组' });

    for (const [body, code] of [
      [{ name: '   ' }, 'group_name_required'],
      [{}, 'group_name_required'],
      [{ name: 'n'.repeat(121) }, 'group_name_too_long'],
    ] as const) {
      const bad = await app.request(`/api/team/${teamId}`, {
        method: 'PATCH', headers: auth(ownerId), body: JSON.stringify(body),
      });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: code });
    }
    // Nothing was applied by any refusal.
    expect(await db.queryOne('SELECT name FROM teams WHERE id = $1', [teamId]))
      .toEqual({ name: '运维组' });
  });

  it('refuses to delete a group that still holds a machine', async () => {
    // A group being deleted is exactly when its machines silently lose the
    // access it granted. Emptying it first makes that a decision rather than a
    // side effect.
    const app = buildApp();
    const serverId = await machineIn(teamId, ownerId);

    const refused = await app.request(`/api/team/${teamId}`, { method: 'DELETE', headers: auth(ownerId) });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'group_has_machines', machineCount: 1 });
    expect(await db.queryOne('SELECT id FROM teams WHERE id = $1', [teamId])).toEqual({ id: teamId });

    // Take the machine out, and the same request now goes through.
    await db.execute('DELETE FROM machine_groups WHERE server_id = $1', [serverId]);
    const deleted = await app.request(`/api/team/${teamId}`, { method: 'DELETE', headers: auth(ownerId) });
    expect(deleted.status).toBe(200);
    expect(await db.queryOne('SELECT id FROM teams WHERE id = $1', [teamId])).toBeNull();
    // The machine outlives the group it was in.
    expect(await db.queryOne('SELECT id FROM servers WHERE id = $1', [serverId]))
      .toEqual({ id: serverId });
  });

  it('counts only live machines, so a revoked one cannot block deletion forever', async () => {
    const app = buildApp();
    const serverId = await machineIn(teamId, ownerId);
    await db.execute('UPDATE servers SET revoked_at = $2 WHERE id = $1', [serverId, Date.now()]);

    const deleted = await app.request(`/api/team/${teamId}`, { method: 'DELETE', headers: auth(ownerId) });
    expect(deleted.status).toBe(200);
  });

  it('lets an admin rename but never delete', async () => {
    // Managing who is in a group and destroying the group are not the same act,
    // and the second cannot be undone by the person it was taken from.
    const app = buildApp();
    const admin = await createUser(`admin-${hex(6)}`, `adm_${hex(4)}`);
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'admin', $3)",
      [teamId, admin, Date.now()],
    );

    expect((await app.request(`/api/team/${teamId}`, {
      method: 'PATCH', headers: auth(admin), body: JSON.stringify({ name: 'by admin' }),
    })).status).toBe(200);

    const refused = await app.request(`/api/team/${teamId}`, { method: 'DELETE', headers: auth(admin) });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'group_owner_required' });
    expect(await db.queryOne('SELECT id FROM teams WHERE id = $1', [teamId])).toEqual({ id: teamId });
  });

  it('refuses both to someone outside the group', async () => {
    const app = buildApp();
    const stranger = await createUser(`out-${hex(6)}`, `out_${hex(4)}`);
    expect((await app.request(`/api/team/${teamId}`, {
      method: 'PATCH', headers: auth(stranger), body: JSON.stringify({ name: 'theirs' }),
    })).status).toBe(403);
    expect((await app.request(`/api/team/${teamId}`, {
      method: 'DELETE', headers: auth(stranger),
    })).status).toBe(403);
    expect(await db.queryOne('SELECT id FROM teams WHERE id = $1', [teamId])).toEqual({ id: teamId });
  });

  it('takes the members with it, since they cascade', async () => {
    const app = buildApp();
    const mate = await createUser(`mate-${hex(6)}`, `mate_${hex(4)}`);
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)",
      [teamId, mate, Date.now()],
    );

    expect((await app.request(`/api/team/${teamId}`, { method: 'DELETE', headers: auth(ownerId) })).status).toBe(200);
    expect(await db.query('SELECT user_id FROM team_members WHERE team_id = $1', [teamId])).toEqual([]);
  });
});
