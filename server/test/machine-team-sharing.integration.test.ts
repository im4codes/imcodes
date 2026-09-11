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
import {
  canOperateControlledMachine,
  listAccessibleControlledMachines,
  resolveControlledMachineAccess,
} from '../src/share/machine-access.js';
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
    `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, node_id)
     VALUES ($1, $2, 'test-machine', 'hash', 'offline', $3, $4, $5)`,
    [id, userId, Date.now(), NODE_ROLE.CONTROLLED, nodeId],
  );
  return id;
}

/** Put a machine in a group. A machine can be in several. */
async function addToGroup(serverId: string, teamId: string): Promise<void> {
  await db.execute(
    'INSERT INTO machine_groups (server_id, team_id, added_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [serverId, teamId, Date.now()],
  );
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
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'admin', $3)",
      [teamId, colleague, Date.now()],
    );

    // The team exists and the colleague runs it. The machine is still not in it.
    expect(await resolveControlledMachineAccess(db, colleague, serverId, Date.now())).toBeNull();
  });
});

describe('associating a machine with a team', () => {
  it('gives the people running the team every machine in it, and members only their own', async () => {
    // Three roles. An ordinary member manages what they added and nothing else;
    // the owner and admins manage everything in the team. Putting a machine in
    // a team therefore hands it to the people running the team -- not to
    // everyone who happens to be in it.
    const teamId = await makeTeam(owner);
    const admin = await newUser();
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'admin', $3)",
      [teamId, admin, Date.now()],
    );
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)",
      [teamId, colleague, Date.now()],
    );
    await addToGroup(serverId, teamId);

    const roleFor = async (userId: string) =>
      (await resolveControlledMachineAccess(db, userId, serverId, Date.now()))?.access_role;

    expect(await roleFor(owner)).toBe('owner');
    expect(await roleFor(admin), 'an admin manages every machine in the team').toBe('participant');
    // Asserted as an exact value, not `not.toBe('none')`: an absent row also
    // satisfies that, so the weaker form would pass whatever this returned.
    expect(await roleFor(colleague), 'a plain member gets nothing through the team').toBeUndefined();
    expect(await roleFor(stranger)).toBeUndefined();
  });

  it('still lets a member run the machine they added to the team themselves', async () => {
    const teamId = await makeTeam(owner);
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)",
      [teamId, colleague, Date.now()],
    );
    const theirs = await installMachine(colleague);
    await addToGroup(theirs, teamId);

    // Their own machine, reached as its owner rather than through the team.
    expect((await resolveControlledMachineAccess(db, colleague, theirs, Date.now()))?.access_role).toBe('owner');
    // And the people running the team can manage it, which is the point of
    // putting it there.
    expect((await resolveControlledMachineAccess(db, owner, theirs, Date.now()))?.access_role).toBe('participant');
  });

  it('withdraws access the moment the machine leaves the team', async () => {
    // Moving a machine out is a real revocation, not bookkeeping. If this ever
    // stops being true, someone keeps reaching a machine after being removed
    // from the group that granted it.
    const teamId = await makeTeam(owner);
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'admin', $3)",
      [teamId, colleague, Date.now()],
    );
    await addToGroup(serverId, teamId);
    expect((await resolveControlledMachineAccess(db, colleague, serverId, Date.now()))?.access_role)
      .toBe('participant');

    await db.execute('DELETE FROM machine_groups WHERE server_id = $1', [serverId]);

    expect(await resolveControlledMachineAccess(db, colleague, serverId, Date.now())).toBeNull();
    expect((await resolveControlledMachineAccess(db, owner, serverId, Date.now()))?.access_role).toBe('owner');
  });

  it('withdraws access the moment a person leaves the team', async () => {
    const teamId = await makeTeam(owner);
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'admin', $3)",
      [teamId, colleague, Date.now()],
    );
    await addToGroup(serverId, teamId);
    expect((await resolveControlledMachineAccess(db, colleague, serverId, Date.now()))?.access_role)
      .toBe('participant');

    await db.execute('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, colleague]);

    expect(await resolveControlledMachineAccess(db, colleague, serverId, Date.now())).toBeNull();
  });
});

describe('sharing one machine with one person', () => {
  async function share(role: 'viewer' | 'participant', opts: { expiresAt?: number; revoked?: boolean } = {}) {
    await db.execute(
      `INSERT INTO server_shares (id, server_id, target_user_id, role, created_by, created_at, updated_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)`,
      [
        `share-${Math.random().toString(16).slice(2)}`,
        serverId, colleague, role, owner, Date.now(),
        opts.expiresAt ?? null,
        opts.revoked ? Date.now() : null,
      ],
    );
  }

  const accessFor = (userId: string) =>
    resolveControlledMachineAccess(db, userId, serverId, Date.now());

  it('grants on its own, with no team anywhere in sight', async () => {
    // The regression: commit 1a2b6c76a made a share row inert unless the
    // grantee was also a current member of the machine's team. Every machine
    // installs with no team, so every direct share granted nothing while the
    // sharing panel kept listing it as active.
    await share('participant');

    const access = await accessFor(colleague);
    expect(access?.access_role).toBe('participant');
    expect(await accessFor(stranger)).toBeNull();
  });

  it('grants even when the machine belongs to a team the person is not in', async () => {
    // Sharing one machine with one person and sharing a group with a team are
    // separate grants. Putting the machine in a team must not quietly withdraw
    // the individual one.
    const teamId = await makeTeam(owner);
    await addToGroup(serverId, teamId);
    await share('participant');

    expect((await accessFor(colleague))?.access_role).toBe('participant');
  });

  it('carries the role it was given, not a blanket one', async () => {
    await share('viewer');

    const access = await accessFor(colleague);
    expect(access?.access_role).toBe('viewer');
    expect(canOperateControlledMachine(access!.access_role)).toBe(false);
  });

  it('lets an explicit per-machine role override the team default', async () => {
    // Both grants apply to the same person. The per-machine one is the more
    // specific statement, so a deliberate downgrade survives.
    const teamId = await makeTeam(owner);
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'admin', $3)",
      [teamId, colleague, Date.now()],
    );
    await addToGroup(serverId, teamId);
    await share('viewer');

    expect((await accessFor(colleague))?.access_role).toBe('viewer');
  });

  it('grants nothing once revoked or expired', async () => {
    await share('participant', { revoked: true });
    expect(await accessFor(colleague)).toBeNull();

    await db.execute('DELETE FROM server_shares WHERE server_id = $1', [serverId]);
    await share('participant', { expiresAt: Date.now() - 1000 });
    expect(await accessFor(colleague)).toBeNull();
  });

  it('reaches the machine through the team with no share row at all', async () => {
    const teamId = await makeTeam(owner);
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'admin', $3)",
      [teamId, colleague, Date.now()],
    );
    await addToGroup(serverId, teamId);

    expect((await accessFor(colleague))?.access_role).toBe('participant');
    expect(await accessFor(stranger)).toBeNull();
  });
});

describe('the server role a group confers', () => {
  /** Put someone in a group at a role. */
  const join = (teamId: string, userId: string, role: 'admin' | 'member') => db.execute(
    'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)',
    [teamId, userId, role, Date.now()],
  );

  it('is owner for the installer, whatever the groups say', async () => {
    const teamId = await makeTeam(colleague);
    await addToGroup(serverId, teamId);
    await join(teamId, owner, 'member');
    // Being a plain member of a group holding your own machine does not
    // demote you on it.
    expect(await resolveServerRole(db, serverId, owner)).toBe('owner');
  });

  it('promotes whoever runs the group, and leaves plain members as members', async () => {
    const teamId = await makeTeam(colleague);
    await addToGroup(serverId, teamId);
    const admin = await newUser();
    const plain = await newUser();
    await join(teamId, admin, 'admin');
    await join(teamId, plain, 'member');

    // The group's own owner runs the machines in it, but is not their owner:
    // that word is reserved for whoever installed it, and it is the role that
    // can revoke the machine outright.
    expect(await resolveServerRole(db, serverId, colleague)).toBe('admin');
    expect(await resolveServerRole(db, serverId, admin)).toBe('admin');
    expect(await resolveServerRole(db, serverId, plain)).toBe('member');
    expect(await resolveServerRole(db, serverId, stranger)).toBe('none');
  });

  it('takes the strongest role when the machine is in several groups', async () => {
    // The same person can be a plain member of one group and run another, both
    // holding this machine. Answering from whichever row the database happened
    // to return first would make their access flip between page loads.
    const weak = await makeTeam(owner);
    const strong = await makeTeam(owner);
    await addToGroup(serverId, weak);
    await addToGroup(serverId, strong);
    await join(weak, colleague, 'member');
    await join(strong, colleague, 'admin');
    expect(await resolveServerRole(db, serverId, colleague)).toBe('admin');

    // And the reverse order of insertion gives the same answer.
    const other = await installMachine(owner);
    await addToGroup(other, strong);
    await addToGroup(other, weak);
    expect(await resolveServerRole(db, other, colleague)).toBe('admin');
  });

  it('drops back to none when the group loses the machine, the person, or itself', async () => {
    const teamId = await makeTeam(owner);
    await addToGroup(serverId, teamId);
    await join(teamId, colleague, 'admin');
    expect(await resolveServerRole(db, serverId, colleague)).toBe('admin');

    await db.execute('DELETE FROM machine_groups WHERE server_id = $1 AND team_id = $2', [serverId, teamId]);
    expect(await resolveServerRole(db, serverId, colleague)).toBe('none');

    await addToGroup(serverId, teamId);
    await db.execute('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, colleague]);
    expect(await resolveServerRole(db, serverId, colleague)).toBe('none');

    await join(teamId, colleague, 'admin');
    await db.execute('DELETE FROM teams WHERE id = $1', [teamId]);
    // Deleting the group cascades the membership away rather than leaving the
    // machine pointing at a group that no longer exists.
    expect(await resolveServerRole(db, serverId, colleague)).toBe('none');
  });
});

describe('a machine in several groups', () => {
  it('is reachable through every group that holds it, independently', async () => {
    // The shape the single column could not express at all: shared with ops AND
    // with support, without either one displacing the other.
    const ops = await makeTeam(owner);
    const support = await makeTeam(owner);
    const opsAdmin = await newUser();
    const supportAdmin = await newUser();
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'admin', $3)",
      [ops, opsAdmin, Date.now()],
    );
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'admin', $3)",
      [support, supportAdmin, Date.now()],
    );
    await addToGroup(serverId, ops);
    await addToGroup(serverId, support);

    const roleFor = async (userId: string) =>
      (await resolveControlledMachineAccess(db, userId, serverId, Date.now()))?.access_role;
    expect(await roleFor(opsAdmin)).toBe('participant');
    expect(await roleFor(supportAdmin)).toBe('participant');
    expect(await roleFor(stranger)).toBeUndefined();
  });

  it('appears once, not once per group', async () => {
    // A join across memberships returns the machine per matching group. A list
    // that repeats a machine is not a machine list, and a count taken off it
    // would be wrong everywhere it is shown.
    const ops = await makeTeam(owner);
    const support = await makeTeam(owner);
    const admin = await newUser();
    for (const team of [ops, support]) {
      await db.execute(
        "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'admin', $3)",
        [team, admin, Date.now()],
      );
      await addToGroup(serverId, team);
    }

    const rows = await listAccessibleControlledMachines(db, admin, Date.now(), 50);
    expect(rows.filter((row) => row.id === serverId)).toHaveLength(1);
    // And it reports both groups it is in.
    expect(rows.find((row) => row.id === serverId)?.team_ids?.sort()).toEqual([ops, support].sort());
  });

  it('keeps the other groups when it leaves one', async () => {
    const ops = await makeTeam(owner);
    const support = await makeTeam(owner);
    const opsAdmin = await newUser();
    const supportAdmin = await newUser();
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'admin', $3)",
      [ops, opsAdmin, Date.now()],
    );
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'admin', $3)",
      [support, supportAdmin, Date.now()],
    );
    await addToGroup(serverId, ops);
    await addToGroup(serverId, support);

    await db.execute('DELETE FROM machine_groups WHERE server_id = $1 AND team_id = $2', [serverId, ops]);

    const roleFor = async (userId: string) =>
      (await resolveControlledMachineAccess(db, userId, serverId, Date.now()))?.access_role;
    expect(await roleFor(opsAdmin), 'the group it left grants nothing').toBeUndefined();
    expect(await roleFor(supportAdmin), 'the group it stayed in is untouched').toBe('participant');
  });

  it('loses a group membership when that group is deleted', async () => {
    // machine_groups cascades on the group, so nothing dangles. The machine
    // itself survives, which is the point of refusing to delete a non-empty
    // group in the UI rather than in the database.
    const ops = await makeTeam(owner);
    const admin = await newUser();
    await db.execute(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'admin', $3)",
      [ops, admin, Date.now()],
    );
    await addToGroup(serverId, ops);
    expect((await resolveControlledMachineAccess(db, admin, serverId, Date.now()))?.access_role)
      .toBe('participant');

    await db.execute('DELETE FROM teams WHERE id = $1', [ops]);

    expect(await resolveControlledMachineAccess(db, admin, serverId, Date.now())).toBeNull();
    expect((await resolveControlledMachineAccess(db, owner, serverId, Date.now()))?.access_role)
      .toBe('owner');
    expect(await db.query('SELECT team_id FROM machine_groups WHERE server_id = $1', [serverId]))
      .toEqual([]);
  });

  it('takes its group memberships with it when the machine is deleted', async () => {
    const ops = await makeTeam(owner);
    await addToGroup(serverId, ops);
    await db.execute('DELETE FROM servers WHERE id = $1', [serverId]);
    expect(await db.query('SELECT server_id FROM machine_groups WHERE team_id = $1', [ops])).toEqual([]);
  });

  it('counts as ungrouped only when it is in no group at all', async () => {
    // The default machine view is "in no group". A machine in two groups must
    // not fall into it just because neither is selected.
    const ops = await makeTeam(owner);
    await addToGroup(serverId, ops);
    const row = (await listAccessibleControlledMachines(db, owner, Date.now(), 50))
      .find((entry) => entry.id === serverId);
    expect(row?.team_ids).toEqual([ops]);
  });
});
