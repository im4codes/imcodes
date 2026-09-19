import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import { listControlledMachines } from '../src/routes/machines.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { isControlledNodeId } from '../../shared/controlled-node-identity.js';

const suffix = randomBytes(6).toString('hex');
const ownerId = `node_id_owner_${suffix}`;
const otherId = `node_id_other_${suffix}`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
let db: Database;

async function withIsolatedServersSchema<T>(
  label: string,
  run: (tx: Database) => Promise<T>,
): Promise<T> {
  const schema = `node_id_${label}_${suffix}`;
  return db.transaction(async (tx) => {
    await tx.execute(`CREATE SCHEMA "${schema}"`);
    await tx.execute(`SET LOCAL search_path TO "${schema}", public`);
    await tx.execute(
      `CREATE TABLE servers (
         id TEXT PRIMARY KEY,
         node_role TEXT NOT NULL,
         ref_name TEXT,
         node_id TEXT
       )`,
    );
    return run(tx);
  });
}

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
  await createUser(db, ownerId);
  await createUser(db, otherId);
});

afterAll(async () => {
  await db.execute('DELETE FROM users WHERE id = ANY($1)', [[ownerId, otherId]]).catch(() => {});
  await db.close();
});

describe('controlled-node canonical nodeId database contract', () => {
  it('mints globally unique string IDs concurrently and preserves them across a new DB client', async () => {
    const serverIds = Array.from({ length: 12 }, (_, index) => `controlled_${suffix}_${index}`);
    await Promise.all(serverIds.map((serverId) => createServer(
      db, serverId, ownerId, `node-${serverId}`, sha256(serverId), undefined, NODE_ROLE.CONTROLLED,
    )));
    const rows = await db.query<{ id: string; node_id: unknown }>(
      'SELECT id, node_id FROM servers WHERE user_id = $1 ORDER BY id', [ownerId],
    );
    expect(rows).toHaveLength(serverIds.length);
    expect(rows.every((row) => typeof row.node_id === 'string' && isControlledNodeId(row.node_id))).toBe(true);
    expect(new Set(rows.map((row) => row.node_id)).size).toBe(rows.length);

    const restarted = createDatabase(process.env.TEST_DATABASE_URL!);
    try {
      const afterRestart = await restarted.query<{ id: string; node_id: string }>(
        'SELECT id, node_id FROM servers WHERE user_id = $1 ORDER BY id', [ownerId],
      );
      expect(afterRestart).toEqual(rows);
    } finally {
      await restarted.close();
    }
  });

  it('projects canonical nodeId under owner scope without authorizing another owner', async () => {
    const owner = await listControlledMachines(db, ownerId, Date.now());
    expect(owner.machines.length).toBeGreaterThan(0);
    expect(owner.machines.every((machine) => isControlledNodeId(machine.nodeId))).toBe(true);
    expect(owner.machines.every((machine) => machine.serverId !== machine.nodeId)).toBe(true);

    const isolated = await listControlledMachines(db, otherId, Date.now());
    expect(isolated.machines).toEqual([]);
  });

  it('database rejects invalid, duplicate, and full-daemon node IDs', async () => {
    const validServerId = `constraint_${suffix}`;
    await createServer(
      db, validServerId, ownerId, 'constraint-source', sha256(validServerId),
      undefined, NODE_ROLE.CONTROLLED,
    );
    const first = await db.queryOne<{ node_id: string }>(
      'SELECT node_id FROM servers WHERE id = $1', [validServerId],
    );
    await expect(db.execute(
      'UPDATE servers SET node_id = $2 WHERE id = $1 AND node_role = $3',
      [validServerId, '0123456789', NODE_ROLE.CONTROLLED],
    )).rejects.toThrow();
    await expect(db.execute(
      `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, node_id)
       VALUES ($1, $2, 'dup', 'hash', 'offline', 1, $3, $4)`,
      [`dup_${suffix}`, otherId, NODE_ROLE.CONTROLLED, first!.node_id],
    )).rejects.toThrow();
    await expect(db.execute(
      `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, node_id)
       VALUES ($1, $2, 'full', 'hash', 'offline', 1, $3, $4)`,
      [`full_${suffix}`, otherId, NODE_ROLE.FULL, '1234567890'],
    )).rejects.toThrow();
    await expect(db.execute(
      `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role)
       VALUES ($1, $2, 'missing', 'hash', 'offline', 1, $3)`,
      [`missing_${suffix}`, otherId, NODE_ROLE.CONTROLLED],
    )).rejects.toThrow();
    await expect(db.execute(
      `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, node_id)
       VALUES ($1, $2, 'null', 'hash', 'offline', 1, $3, NULL)`,
      [`null_${suffix}`, otherId, NODE_ROLE.CONTROLLED],
    )).rejects.toThrow();
  });

  it('086 repairs a NULL row admitted by 085 and preserves its deterministic identity and alias', async () => {
    const migration085 = await readFile(new URL('../src/db/migrations/085_controlled_node_identity.sql', import.meta.url), 'utf8');
    const migration086 = await readFile(new URL('../src/db/migrations/086_controlled_node_identity_not_null.sql', import.meta.url), 'utf8');
    await withIsolatedServersSchema('repair', async (tx) => {
      await tx.execute(
        `INSERT INTO servers (id, node_role, ref_name, node_id)
         VALUES ('legacy_internal', 'controlled', 'legacy-host', NULL)`,
      );
      await tx.execute(migration085);
      const first = await tx.queryOne<{ node_id: string; ref_name: string }>(
        `SELECT node_id, ref_name FROM servers WHERE id = 'legacy_internal'`,
      );
      expect(isControlledNodeId(first?.node_id)).toBe(true);

      // This UPDATE is the deployed 085 counterexample: its CHECK evaluates
      // UNKNOWN and accepts NULL. 086 must repair it without changing identity.
      await tx.execute(`UPDATE servers SET node_id = NULL WHERE id = 'legacy_internal'`);
      await tx.execute(migration086);
      const repaired = await tx.queryOne<{ node_id: string; ref_name: string }>(
        `SELECT node_id, ref_name FROM servers WHERE id = 'legacy_internal'`,
      );
      expect(repaired).toEqual(first);
      expect(repaired?.ref_name).toBe('legacy-host');
      await expect(tx.execute(
        `INSERT INTO servers (id, node_role, ref_name) VALUES ('missing', 'controlled', 'other-host')`,
      )).rejects.toThrow();
    });
  });

  it('085 and 086 abort on a canonical legacy ref while 086 accepts a disjoint alias', async () => {
    const migration085 = await readFile(new URL('../src/db/migrations/085_controlled_node_identity.sql', import.meta.url), 'utf8');
    const migration086 = await readFile(new URL('../src/db/migrations/086_controlled_node_identity_not_null.sql', import.meta.url), 'utf8');
    for (const [label, migration] of [['guard085', migration085], ['guard086', migration086]] as const) {
      await expect(withIsolatedServersSchema(label, async (tx) => {
        await tx.execute(
          `INSERT INTO servers (id, node_role, ref_name, node_id)
           VALUES ('legacy_conflict', 'controlled', '1234567890', NULL)`,
        );
        await tx.execute(migration);
      })).rejects.toThrow(/legacy ref_name collides/);
    }

    await withIsolatedServersSchema('guard_positive', async (tx) => {
      await tx.execute(
        `INSERT INTO servers (id, node_role, ref_name, node_id)
         VALUES ('legacy_safe', 'controlled', 'host-1234567890', NULL)`,
      );
      await tx.execute(migration086);
      const row = await tx.queryOne<{ node_id: string }>(
        `SELECT node_id FROM servers WHERE id = 'legacy_safe'`,
      );
      expect(isControlledNodeId(row?.node_id)).toBe(true);
    });
  });
});
