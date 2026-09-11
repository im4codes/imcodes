/**
 * Desk resolution for a controlled-node mint — real PostgreSQL.
 *
 * A Desk is a team, and a machine does belong to one. What is under test here
 * is who has to produce it: an account with no Desk could not install at all,
 * because the mint demanded a team the product never created and the install
 * page offered no way to make one.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  resolveMintDesk,
  DeskAmbiguousError,
  DEFAULT_PERSONAL_DESK_NAME,
} from '../src/routes/enroll.js';

let db: Database;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

const RACERS = 5;

let userId: string;

beforeEach(async () => {
  userId = `user-${Math.random().toString(16).slice(2)}`;
  await db.execute('INSERT INTO users (id, created_at) VALUES ($1, $2)', [userId, Date.now()]);
});

async function addDesk(name: string, role: 'owner' | 'admin' | 'member', joinedAt: number): Promise<string> {
  const teamId = `team-${Math.random().toString(16).slice(2)}`;
  await db.execute(
    "INSERT INTO teams (id, name, owner_id, plan, created_at) VALUES ($1, $2, $3, 'free', $4)",
    [teamId, name, userId, joinedAt],
  );
  await db.execute(
    'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)',
    [teamId, userId, role, joinedAt],
  );
  return teamId;
}

async function mintableCount(): Promise<number> {
  const rows = await db.query<{ team_id: string }>(
    "SELECT team_id FROM team_members WHERE user_id = $1 AND role IN ('owner', 'admin')",
    [userId],
  );
  return rows.length;
}

describe('resolveMintDesk', () => {
  it('creates the first Desk for an account that has none', async () => {
    expect(await mintableCount()).toBe(0);

    const teamId = await resolveMintDesk(db, userId, undefined);

    const team = await db.queryOne<{ name: string; owner_id: string }>(
      'SELECT name, owner_id FROM teams WHERE id = $1',
      [teamId],
    );
    expect(team?.name).toBe(DEFAULT_PERSONAL_DESK_NAME);
    expect(team?.owner_id).toBe(userId);
    const membership = await db.queryOne<{ role: string }>(
      'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, userId],
    );
    // Owner, so the very next membership check in the mint passes. Creating a
    // Desk the creator cannot mint into would just move the dead end.
    expect(membership?.role).toBe('owner');
  });

  it('creates exactly one Desk when several installs start at once', async () => {
    // Both callers see "no Desk" before either commits. Without the per-user
    // lock each creates one, and the account is left carrying teams it never
    // asked for.
    //
    // The warm-up is what makes this a race at all. A cold pg pool finishes the
    // first query before its second connection has even finished handshaking,
    // so the callers run one after another and the test passes with the lock
    // removed -- proving nothing. Forcing the connections open first is the
    // difference between a concurrency test and a decorative one.
    await Promise.all(Array.from({ length: RACERS }, () => db.query('SELECT pg_sleep(0.05)')));

    const results = await Promise.all(
      Array.from({ length: RACERS }, () => resolveMintDesk(db, userId, undefined)),
    );

    expect(new Set(results).size, `callers disagreed: ${results.join(', ')}`).toBe(1);
    expect(await mintableCount()).toBe(1);
  });

  it('reuses the Desk it already made instead of making another', async () => {
    const first = await resolveMintDesk(db, userId, undefined);
    const second = await resolveMintDesk(db, userId, undefined);

    expect(second).toBe(first);
    expect(await mintableCount()).toBe(1);
  });

  it('uses the only Desk when there is exactly one', async () => {
    const existing = await addDesk('Solo', 'owner', 1000);

    expect(await resolveMintDesk(db, userId, undefined)).toBe(existing);
    expect(await mintableCount(), 'must not provision alongside an existing Desk').toBe(1);
  });

  it('still refuses to guess between several Desks', async () => {
    // The reason the no-default rule exists, and the one case it still governs:
    // picking an authorization boundary on someone's behalf.
    await addDesk('Desk A', 'owner', 1000);
    await addDesk('Desk B', 'admin', 2000);

    await expect(resolveMintDesk(db, userId, undefined)).rejects.toBeInstanceOf(DeskAmbiguousError);
    expect(await mintableCount()).toBe(2);
  });

  it('provisions for a member of someone else s Desk, who cannot mint into it', async () => {
    // Membership without a managing role is not a Desk this user can enrol into,
    // so "has a team" is not the same question as "can install".
    await addDesk('Someone else', 'member', 1000);

    const teamId = await resolveMintDesk(db, userId, undefined);

    const role = await db.queryOne<{ role: string }>(
      'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, userId],
    );
    expect(role?.role).toBe('owner');
  });

  it('passes an explicit Desk through untouched', async () => {
    const chosen = await addDesk('Chosen', 'owner', 1000);
    await addDesk('Other', 'owner', 2000);

    expect(await resolveMintDesk(db, userId, chosen)).toBe(chosen);
    expect(await resolveMintDesk(db, userId, `  ${chosen}  `)).toBe(chosen);
    expect(await mintableCount()).toBe(2);
  });
});
