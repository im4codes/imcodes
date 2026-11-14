/**
 * Integration tests for `verification_machine_profiles` — real PostgreSQL via
 * testcontainers (managed by test/setup/integration-global.ts).
 *
 * Covers the storage and SQL contract:
 *   - create (`revision: 1`) with omitted `expectedRevision` or `expectedRevision: 0`
 *   - update (`expectedRevision >= 1`) renames and switches scope (`revision: 2`)
 *   - stale `expectedRevision` returns `'revision_conflict'`
 *   - duplicate `(user_id, scope, scope_key, alias)` returns `'alias_conflict'`
 *   - missing row or other user's row returns `'not_found'` on `expectedRevision > 0`
 *     and `'revision_conflict'` when overwriting another user's id without expectedRevision
 *   - dynamic `alias` sync from `user_aliases` for `ssh` profiles on list
 *   - project-scope isolation vs `includeAllProjects` listing, and per-user isolation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/queries.js';
import { upsertAlias } from '../src/db/alias-queries.js';
import { randomHex } from '../src/security/crypto.js';
import {
  deleteVerificationMachine,
  getVerificationMachine,
  listVerificationMachines,
  listVerificationMachinesPage,
  recordVerificationMachineStatus,
  upsertVerificationMachine,
  type VerificationMachineCursor,
} from '../src/db/verification-machine-queries.js';

let db: Database;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

async function freshUser(): Promise<string> {
  const id = 'vm-user-' + randomHex(6);
  await createUser(db, id);
  return id;
}

describe('verification-machine-queries (real PostgreSQL)', () => {
  it('creates with revision=1, updates with expectedRevision=1 -> revision=2, and rejects stale expectedRevision=1', async () => {
    const userId = await freshUser();
    const id = randomHex(16);

    const created = await upsertVerificationMachine(db, {
      id,
      userId,
      scope: 'project',
      scopeKey: 'repo-1',
      alias: 'Windows lab',
      kind: 'controlled_node',
      target: '1234567890',
      enabled: true,
      source: 'web',
      expectedRevision: 0,
    });
    expect(created).not.toBe('revision_conflict');
    expect(created).not.toBe('alias_conflict');
    expect(created).not.toBe('not_found');
    if (typeof created === 'string') throw new Error(`unexpected result: ${created}`);
    expect(created.revision).toBe(1);
    expect(created.scope).toBe('project');
    expect(created.scopeKey).toBe('repo-1');
    expect(created.alias).toBe('Windows lab');

    // Verify expectedRevision: 0 rejects duplicate creation of the same id.
    const dupCreate = await upsertVerificationMachine(db, {
      id,
      userId,
      scope: 'project',
      scopeKey: 'repo-1',
      alias: 'Windows lab duplicate',
      kind: 'controlled_node',
      target: '1234567890',
      enabled: true,
      source: 'web',
      expectedRevision: 0,
    });
    expect(dupCreate).toBe('revision_conflict');

    // Mark verified before rename to ensure verification status is preserved when target/kind are unchanged.
    const verified = await recordVerificationMachineStatus(db, userId, id, 'verified');
    expect(verified?.revision).toBe(2);
    expect(verified?.lastVerificationStatus).toBe('verified');

    // Update using expectedRevision: 2 (rename + switch scope to user).
    const updated = await upsertVerificationMachine(db, {
      id,
      userId,
      scope: 'user',
      scopeKey: '',
      alias: 'Shared Windows lab',
      kind: 'controlled_node',
      target: '1234567890',
      enabled: true,
      source: 'web',
      expectedRevision: 2,
    });
    if (typeof updated === 'string') throw new Error(`unexpected update result: ${updated}`);
    expect(updated.revision).toBe(3);
    expect(updated.scope).toBe('user');
    expect(updated.scopeKey).toBe('');
    expect(updated.alias).toBe('Shared Windows lab');
    expect(updated.lastVerificationStatus).toBe('verified');

    // Stale expectedRevision returns revision_conflict and leaves row untouched.
    const stale = await upsertVerificationMachine(db, {
      id,
      userId,
      scope: 'user',
      scopeKey: '',
      alias: 'Stale write',
      kind: 'controlled_node',
      target: '1234567890',
      enabled: true,
      source: 'web',
      expectedRevision: 1,
    });
    expect(stale).toBe('revision_conflict');

    const loaded = await getVerificationMachine(db, userId, id);
    expect(loaded?.alias).toBe('Shared Windows lab');
    expect(loaded?.revision).toBe(3);

    // Omitted expectedRevision updates owned row unconditionally.
    const unconditional = await upsertVerificationMachine(db, {
      id,
      userId,
      scope: 'project',
      scopeKey: 'repo-2',
      alias: 'Moved to repo-2',
      kind: 'controlled_node',
      target: '0987654321',
      enabled: true,
      source: 'mcp',
    });
    if (typeof unconditional === 'string') throw new Error(`unexpected unconditional result: ${unconditional}`);
    expect(unconditional.revision).toBe(4);
    expect(unconditional.lastVerificationStatus).toBe('unverified');
  });

  it('returns alias_conflict on duplicate (user_id, scope, scope_key, alias)', async () => {
    const userId = await freshUser();
    const first = await upsertVerificationMachine(db, {
      id: randomHex(16),
      userId,
      scope: 'project',
      scopeKey: 'repo-a',
      alias: 'Linux box',
      kind: 'controlled_node',
      target: '1111111111',
      enabled: true,
      source: 'web',
    });
    expect(typeof first).toBe('object');

    const conflict = await upsertVerificationMachine(db, {
      id: randomHex(16),
      userId,
      scope: 'project',
      scopeKey: 'repo-a',
      alias: 'Linux box',
      kind: 'controlled_node',
      target: '2222222222',
      enabled: true,
      source: 'web',
    });
    expect(conflict).toBe('alias_conflict');

    // Update conflict as well.
    const second = await upsertVerificationMachine(db, {
      id: randomHex(16),
      userId,
      scope: 'project',
      scopeKey: 'repo-a',
      alias: 'Other box',
      kind: 'controlled_node',
      target: '2222222222',
      enabled: true,
      source: 'web',
    });
    if (typeof second === 'string') throw new Error(`unexpected second create: ${second}`);
    const updateConflict = await upsertVerificationMachine(db, {
      id: second.id,
      userId,
      scope: 'project',
      scopeKey: 'repo-a',
      alias: 'Linux box',
      kind: 'controlled_node',
      target: '2222222222',
      enabled: true,
      source: 'web',
      expectedRevision: second.revision,
    });
    expect(updateConflict).toBe('alias_conflict');
  });

  it('isolates users strictly and returns not_found for missing/foreign ids with expectedRevision > 0', async () => {
    const userA = await freshUser();
    const userB = await freshUser();
    const id = randomHex(16);

    const created = await upsertVerificationMachine(db, {
      id,
      userId: userA,
      scope: 'user',
      scopeKey: '',
      alias: 'User A machine',
      kind: 'controlled_node',
      target: '1234567890',
      enabled: true,
      source: 'web',
    });
    if (typeof created === 'string') throw new Error(`unexpected create: ${created}`);

    expect(await getVerificationMachine(db, userB, id)).toBeNull();
    expect(await listVerificationMachines(db, userB, undefined, { includeAllProjects: true })).toEqual([]);
    expect(await deleteVerificationMachine(db, userB, id)).toBe('not_found');

    const foreignUpdate = await upsertVerificationMachine(db, {
      id,
      userId: userB,
      scope: 'user',
      scopeKey: '',
      alias: 'Hijack',
      kind: 'controlled_node',
      target: '1234567890',
      enabled: true,
      source: 'web',
      expectedRevision: 1,
    });
    expect(foreignUpdate).toBe('not_found');

    const foreignUnconditional = await upsertVerificationMachine(db, {
      id,
      userId: userB,
      scope: 'user',
      scopeKey: '',
      alias: 'Hijack unconditional',
      kind: 'controlled_node',
      target: '1234567890',
      enabled: true,
      source: 'web',
    });
    expect(foreignUnconditional).toBe('revision_conflict');

    const missingUpdate = await upsertVerificationMachine(db, {
      id: randomHex(16),
      userId: userA,
      scope: 'user',
      scopeKey: '',
      alias: 'Ghost',
      kind: 'controlled_node',
      target: '1234567890',
      enabled: true,
      source: 'web',
      expectedRevision: 1,
    });
    expect(missingUpdate).toBe('not_found');

    // Original row remains intact.
    expect((await getVerificationMachine(db, userA, id))?.alias).toBe('User A machine');
  });

  it('dynamically syncs ssh alias name from user_aliases and filters project scopes accurately', async () => {
    const userId = await freshUser();
    const aliasId = randomHex(16);
    await upsertAlias(db, {
      id: aliasId,
      userId,
      name: 'prod-211',
      value: 'ssh k@172.16.253.211',
      source: 'web',
    });

    await upsertVerificationMachine(db, {
      id: randomHex(16),
      userId,
      scope: 'project',
      scopeKey: 'proj-alpha',
      alias: 'prod-211',
      kind: 'ssh',
      target: aliasId,
      enabled: true,
      source: 'web',
    });
    await upsertVerificationMachine(db, {
      id: randomHex(16),
      userId,
      scope: 'project',
      scopeKey: 'proj-beta',
      alias: 'Beta Win',
      kind: 'controlled_node',
      target: '9999999999',
      enabled: true,
      source: 'web',
    });
    await upsertVerificationMachine(db, {
      id: randomHex(16),
      userId,
      scope: 'user',
      scopeKey: '',
      alias: 'Global Mac',
      kind: 'controlled_node',
      target: '8888888888',
      enabled: true,
      source: 'web',
    });

    // Rename the underlying user_aliases row preserving id -> listVerificationMachines sees new name.
    await upsertAlias(db, {
      id: aliasId,
      existingId: aliasId,
      userId,
      name: 'prod-211-renamed',
      value: 'ssh k@172.16.253.211',
      source: 'web',
    });

    const alphaOnly = await listVerificationMachines(db, userId, 'proj-alpha');
    expect(alphaOnly.map((m) => ({ alias: m.alias, scope: m.scope, scopeKey: m.scopeKey }))).toEqual([
      { alias: 'prod-211-renamed', scope: 'project', scopeKey: 'proj-alpha' },
      { alias: 'Global Mac', scope: 'user', scopeKey: '' },
    ]);

    const noProject = await listVerificationMachines(db, userId);
    expect(noProject.map((m) => m.alias)).toEqual(['Global Mac']);

    const allProjects = await listVerificationMachines(db, userId, 'proj-beta', { includeAllProjects: true });
    expect(allProjects.map((m) => ({ alias: m.alias, scope: m.scope, scopeKey: m.scopeKey }))).toEqual([
      { alias: 'Beta Win', scope: 'project', scopeKey: 'proj-beta' },
      { alias: 'prod-211-renamed', scope: 'project', scopeKey: 'proj-alpha' },
      { alias: 'Global Mac', scope: 'user', scopeKey: '' },
    ]);
  });

  it('paginates >100 multi-project profiles with deterministic cursor ordering including identical aliases and id tie-breaker', async () => {
    const userId = await freshUser();
    const otherUser = await freshUser();
    const createdIds: string[] = [];

    // 55 in repo-a, 50 in repo-b (with 2 SSH rows sharing the same dynamic alias name in repo-b), and 3 in user scope = 108 total.
    const sharedAliasId = randomHex(16);
    await upsertAlias(db, {
      id: sharedAliasId,
      userId,
      name: 'shared-ssh-alias',
      value: 'ssh k@172.16.253.211',
      source: 'web',
    });

    for (let i = 0; i < 55; i += 1) {
      const id = randomHex(16);
      createdIds.push(id);
      await upsertVerificationMachine(db, {
        id,
        userId,
        scope: 'project',
        scopeKey: 'repo-a',
        alias: `node-a-${String(i).padStart(3, '0')}`,
        kind: 'controlled_node',
        target: '1234567890',
        enabled: true,
        source: 'web',
      });
    }
    for (let i = 0; i < 48; i += 1) {
      const id = randomHex(16);
      createdIds.push(id);
      await upsertVerificationMachine(db, {
        id,
        userId,
        scope: 'project',
        scopeKey: 'repo-b',
        alias: `node-b-${String(i).padStart(3, '0')}`,
        kind: 'controlled_node',
        target: '0987654321',
        enabled: true,
        source: 'web',
      });
    }
    for (const storedAlias of ['ssh-alias-row-1', 'ssh-alias-row-2']) {
      const id = randomHex(16);
      createdIds.push(id);
      await upsertVerificationMachine(db, {
        id,
        userId,
        scope: 'project',
        scopeKey: 'repo-b',
        alias: storedAlias,
        kind: 'ssh',
        target: sharedAliasId,
        enabled: true,
        source: 'web',
      });
    }
    for (let i = 0; i < 3; i += 1) {
      const id = randomHex(16);
      createdIds.push(id);
      await upsertVerificationMachine(db, {
        id,
        userId,
        scope: 'user',
        scopeKey: '',
        alias: `global-${i}`,
        kind: 'controlled_node',
        target: '1111111111',
        enabled: true,
        source: 'web',
      });
    }
    await upsertVerificationMachine(db, {
      id: randomHex(16),
      userId: otherUser,
      scope: 'user',
      scopeKey: '',
      alias: 'other-user-only',
      kind: 'controlled_node',
      target: '2222222222',
      enabled: true,
      source: 'web',
    });

    // Small bounded pages (limit=40) + active project bucket='repo-b' must visit all 108 rows without skips or duplicates.
    const pagedIds: string[] = [];
    let cursor: VerificationMachineCursor | null = null;
    let pageCount = 0;
    while (true) {
      const page = await listVerificationMachinesPage(db, userId, {
        projectKey: 'repo-b',
        limit: 40,
        cursor,
      });
      pageCount += 1;
      for (const item of page.profiles) pagedIds.push(item.id);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(pageCount).toBe(3); // 40 + 40 + 28 = 108
    expect(pagedIds).toHaveLength(108);
    expect(new Set(pagedIds)).toEqual(new Set(createdIds));

    // Default MAX_ITEMS (100) paging also spans 2 pages cleanly.
    const defaultPage1 = await listVerificationMachinesPage(db, userId);
    expect(defaultPage1.profiles).toHaveLength(100);
    expect(defaultPage1.nextCursor).not.toBeNull();
    const defaultPage2 = await listVerificationMachinesPage(db, userId, { cursor: defaultPage1.nextCursor });
    expect(defaultPage2.profiles).toHaveLength(8);
    expect(defaultPage2.nextCursor).toBeNull();

    // listVerificationMachines with includeAllProjects=true aggregates all 108, while scoped stays <= 100 per scope.
    const allAggregated = await listVerificationMachines(db, userId, undefined, { includeAllProjects: true });
    expect(allAggregated).toHaveLength(108);
    expect(await listVerificationMachines(db, userId, 'repo-a')).toHaveLength(58); // 55 repo-a + 3 user
    expect(await listVerificationMachines(db, otherUser, undefined, { includeAllProjects: true })).toHaveLength(1);
  });
});
