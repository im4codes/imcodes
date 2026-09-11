/**
 * Who can reach a machine — real PostgreSQL.
 *
 * The product shape: a machine belongs to whoever installed it. A team is made
 * separately, machines are associated into it, people are added to it, and
 * everyone in it can then manage those machines. Installing is not the moment
 * any of that is decided.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { resolveServerRole } from '../src/security/authorization.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

let db: Database;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

let owner: string;
let colleague: string;
let stranger: string;
let serverId: string;

async function newUser(): Promise<string> {
  const id = `user-${Math.random().toString(16).slice(2)}`;
  await db.execute('INSERT INTO users (id, created_at) VALUES ($1, $2)', [id, Date.now()]);
  return id;
}

/** A machine as it exists straight after an install: no team. */
async function installMachine(userId: string): Promise<string> {
  const id = `srv-${Math.random().toString(16).slice(2)}`;
  // A controlled row carries a 10-digit node id by constraint; installing is
  // what normally mints it.
  const nodeId = String(Math.floor(1e9 + Math.random() * 8.9e9));
  await db.execute(
    `INSERT INTO servers (id, user_id, team_id, name, token_hash, status, created_at, node_role, node_id)
     VALUES ($1, $2, NULL, 'test-machine', 'hash', 'offline', $3, $4, $5)`,
    [id, userId, Date.now(), NODE_ROLE.CONTROLLED, nodeId],
  );
  return id;
}

async function makeTeam(ownerId: string): Promise<string> {
  const teamId = `team-${Math.random().toString(16).slice(2)}`;
  await db.execute(
    "INSERT INTO teams (id, name, owner_id, plan, created_at) VALUES ($1, 'Shared', $2, 'free', $3)",
    [teamId, ownerId, Date.now()],
  );
  await db.execute(
    "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)",
    [teamId, ownerId, Date.now()],
  );
  return teamId;
}

beforeEach(async () => {
  owner = await newUser();
  colleague = await newUser();
  stranger = await newUser();
  serverId = await installMachine(owner);
});

describe('a freshly installed machine', () => {
  it('belongs to whoever installed it, and to nobody else', async () => {
    // No team is not a missing authorization domain. It is the narrowest one,
    // which is why installing never needed a team in the first place.
    expect(await resolveServerRole(db, serverId, owner)).toBe('owner');
    expect(await resolveServerRole(db, serverId, colleague)).toBe('none');
    expect(await resolveServerRole(db, serverId, stranger)).toBe('none');
  });

  it('is not reachable through a team it was never associated with', async () => {
    const teamId = await makeTeam(owner);
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)",
      [teamId, colleague, Date.now()],
    );

    // The team exists and the colleague is in it. The machine is still not.
    expect(await resolveServerRole(db, serverId, colleague)).toBe('none');
  });
});

describe('associating a machine with a team', () => {
  it('lets everyone in the team manage it, and still nobody outside', async () => {
    const teamId = await makeTeam(owner);
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)",
      [teamId, colleague, Date.now()],
    );
    await db.execute('UPDATE servers SET team_id = $2 WHERE id = $1', [serverId, teamId]);

    expect(await resolveServerRole(db, serverId, owner)).toBe('owner');
    expect(await resolveServerRole(db, serverId, colleague)).not.toBe('none');
    expect(await resolveServerRole(db, serverId, stranger)).toBe('none');
  });

  it('withdraws access the moment the machine leaves the team', async () => {
    // Moving a machine out is a real revocation, not bookkeeping. If this ever
    // stops being true, someone keeps reaching a machine after being removed
    // from the group that granted it.
    const teamId = await makeTeam(owner);
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)",
      [teamId, colleague, Date.now()],
    );
    await db.execute('UPDATE servers SET team_id = $2 WHERE id = $1', [serverId, teamId]);
    expect(await resolveServerRole(db, serverId, colleague)).not.toBe('none');

    await db.execute('UPDATE servers SET team_id = NULL WHERE id = $1', [serverId]);

    expect(await resolveServerRole(db, serverId, colleague)).toBe('none');
    expect(await resolveServerRole(db, serverId, owner)).toBe('owner');
  });

  it('withdraws access the moment a person leaves the team', async () => {
    const teamId = await makeTeam(owner);
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)",
      [teamId, colleague, Date.now()],
    );
    await db.execute('UPDATE servers SET team_id = $2 WHERE id = $1', [serverId, teamId]);
    expect(await resolveServerRole(db, serverId, colleague)).not.toBe('none');

    await db.execute('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, colleague]);

    expect(await resolveServerRole(db, serverId, colleague)).toBe('none');
  });
});
