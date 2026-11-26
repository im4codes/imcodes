import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser, deleteServer, getServerById } from '../src/db/queries.js';

let db: Database;
beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});
afterAll(async () => { await db.close(); });

async function seed() {
  const owner = randomUUID();
  const id = randomUUID();
  await createUser(db, owner);
  await createServer(db, id, owner, 'Offline server', 'test-hash');
  const now = Date.now();
  await db.execute(
    `INSERT INTO cron_jobs (id, server_id, user_id, name, cron_expr, action, created_at)
     VALUES ($1, $1, $2, 'offline job', '0 * * * *', '{}', $3)`, [id, owner, now],
  );
  await db.execute(
    `INSERT INTO controlled_node_enrollments_v2 (
       ticket_hash, code_hash, owner_user_id, os, arch, artifact_sha256, encrypted_code,
       ticket_expires_at, expires_at, created_at, used_at, redeemed_server_id, install_id, node_token_hash
     ) VALUES ($1, $1, $2, 'linux', 'x64', $3, 'test', $4, $4, $4, $4, $1, 'install', 'token')`,
    [id, owner, 'a'.repeat(64), now],
  );
  return { id, owner };
}

async function cronExists(id: string) {
  return !!await db.queryOne('SELECT id FROM cron_jobs WHERE server_id = $1', [id]);
}

async function enrollment(id: string) {
  return db.queryOne('SELECT * FROM controlled_node_enrollments_v2 WHERE code_hash = $1', [id]);
}

describe('offline server deletion with real foreign keys', () => {
  it('deletes an offline server with cron jobs and legacy enrollment without rearming the code', async () => {
    const { id, owner } = await seed();
    const other = await seed();
    const child = randomUUID();
    await createServer(db, child, owner, 'Child', 'child-hash');
    await db.execute('UPDATE servers SET host_server_id = $1 WHERE id = $2', [id, child]);
    expect((await getServerById(db, id))?.status).toBe('offline');
    await expect(deleteServer(db, id, owner)).resolves.toBe(true);
    expect(await getServerById(db, id)).toBeNull();
    expect(await cronExists(id)).toBe(false);
    expect(await enrollment(id)).toMatchObject({ used_at: null, redeemed_server_id: null, revoked_at: expect.any(Number) });
    expect((await getServerById(db, child))?.host_server_id).toBeNull();
    expect(await cronExists(other.id)).toBe(true);
    expect(await enrollment(other.id)).toMatchObject({ redeemed_server_id: other.id, revoked_at: null });
    await expect(deleteServer(db, id, owner)).resolves.toBe(false);
  });

  it('handles the legacy redemption constraint even when no cron job exists', async () => {
    const { id, owner } = await seed();
    await db.execute('DELETE FROM cron_jobs WHERE server_id = $1', [id]);
    await expect(deleteServer(db, id, owner)).resolves.toBe(true);
    expect(await getServerById(db, id)).toBeNull();
    expect(await enrollment(id)).toMatchObject({ redeemed_server_id: null, used_at: null, revoked_at: expect.any(Number) });
  });

  it('a wrong owner cannot partially delete dependent rows', async () => {
    const { id } = await seed();
    await expect(deleteServer(db, id, randomUUID())).resolves.toBe(false);
    expect(await getServerById(db, id)).not.toBeNull();
    expect(await cronExists(id)).toBe(true);
    expect(await enrollment(id)).toMatchObject({ redeemed_server_id: id, revoked_at: null });
  });

  it('rolls back every cleanup after a database failure and allows a retry', async () => {
    const { id, owner } = await seed();
    // An extra FK is deterministic fault injection at the last DELETE, after
    // cleanup has run. Use an isolated table, not a production migration.
    await db.exec('CREATE TABLE delete_server_test_blocker (server_id TEXT REFERENCES servers(id))');
    try {
      await db.execute('INSERT INTO delete_server_test_blocker VALUES ($1)', [id]);
      await expect(deleteServer(db, id, owner)).rejects.toMatchObject({ code: '23503' });
      expect(await getServerById(db, id)).not.toBeNull();
      expect(await cronExists(id)).toBe(true);
      expect(await enrollment(id)).toMatchObject({ redeemed_server_id: id, revoked_at: null });
    } finally {
      await db.exec('DROP TABLE delete_server_test_blocker');
    }
    await expect(deleteServer(db, id, owner)).resolves.toBe(true);
  });

  it('settles simultaneous deletes exactly once', async () => {
    const { id, owner } = await seed();
    const results = await Promise.all([deleteServer(db, id, owner), deleteServer(db, id, owner)]);
    expect(results.sort()).toEqual([false, true]);
    expect(await getServerById(db, id)).toBeNull();
  });

  it('keeps a reusable installer and its other installed machine', async () => {
    const { id, owner } = await seed();
    const second = randomUUID();
    await createServer(db, second, owner, 'Other install', 'other-hash');
    const parent = await db.queryOne<{ id: string }>(
      `UPDATE controlled_node_enrollments_v2 SET reusable = TRUE,
       used_at = NULL, redeemed_server_id = NULL, install_id = NULL, node_token_hash = NULL
       WHERE code_hash = $1 RETURNING id`, [id],
    );
    for (const serverId of [id, second]) {
      await db.execute(
        `INSERT INTO controlled_node_enrollment_installs
         (enrollment_id, install_id, node_token_hash, redeemed_server_id, created_at)
         VALUES ($1, $2, $2, $2, $3)`, [parent!.id, serverId, Date.now()],
      );
    }
    await expect(deleteServer(db, id, owner)).resolves.toBe(true);
    expect(await enrollment(id)).toMatchObject({ reusable: true, revoked_at: null });
    expect(await db.query('SELECT redeemed_server_id FROM controlled_node_enrollment_installs WHERE enrollment_id = $1', [parent!.id]))
      .toEqual([{ redeemed_server_id: second }]);
    expect(await getServerById(db, second)).not.toBeNull();
  });
});
