/**
 * Additive migration hardening for controlled-node v2 — real PostgreSQL.
 * Covers migration 056 (partial-052 `controlled_node_enrollments_v2` hardening):
 * fresh state, empty partial, NULL ticket_hash fail-closed, and default/duplicate
 * UNIQUE(ticket_hash) deduplication. (Migration 057's machine_exec_audit serverId
 * retention is covered in controlled-node-exec.integration.test.ts.)
 *
 * NOTE: these tests mutate `controlled_node_enrollments_v2` schema to simulate
 * partially-upgraded databases and ALWAYS restore it in `finally`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migFile = (name: string) => join(__dirname, '..', 'src', 'db', 'migrations', name);
const MIGRATION_056 = '056_controlled_node_v2_ticket_hash_hardening.sql';
const MIGRATION_057 = '057_machine_exec_audit_immutable_server_ids.sql';
const MIGRATION_058 = '058_controlled_node_exec_default_enabled.sql';
const MIGRATION_059 = '059_controlled_node_reusable_installers.sql';
const hex = (n: number) => randomBytes(n).toString('hex');

let db: Database;

/** Count UNIQUE constraints defined on exactly the single column `ticket_hash`. */
async function uniqueCountOnTicketHash(): Promise<number> {
  const rows = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM pg_constraint con
       JOIN pg_attribute a
         ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.conrelid = 'controlled_node_enrollments_v2'::regclass
        AND con.contype = 'u'
        AND array_length(con.conkey, 1) = 1
        AND a.attname = 'ticket_hash'`,
  );
  return rows[0].n;
}

async function ticketHashIsNullable(): Promise<boolean> {
  const rows = await db.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'controlled_node_enrollments_v2' AND column_name = 'ticket_hash'`,
  );
  return rows[0].is_nullable === 'YES';
}

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db); // applies 052..058
});
afterAll(async () => { await db.close(); });

describe('059 reusable controlled-node installers', () => {
  it('makes enrollment expiry nullable while preserving legacy single-use defaults', async () => {
    const columns = await db.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'controlled_node_enrollments_v2'
          AND column_name IN ('expires_at', 'reusable')
        ORDER BY column_name`,
    );
    expect(columns).toEqual([
      { column_name: 'expires_at', is_nullable: 'YES', column_default: null },
      { column_name: 'reusable', is_nullable: 'NO', column_default: 'false' },
    ]);
  });

  it('backfills an already-claimed legacy identity exactly once and is idempotent', async () => {
    const userId = `u_${hex(4)}`;
    const serverId = `legacy_ctl_${hex(6)}`;
    const installId = `legacy_install_${hex(4)}`;
    const nodeTokenHash = hex(32);
    await createUser(db, userId);
    await createServer(db, serverId, userId, 'legacy-controlled', nodeTokenHash);
    const enrollment = await db.queryOne<{ id: string }>(
      `INSERT INTO controlled_node_enrollments_v2
         (ticket_hash, code_hash, owner_user_id, os, arch, artifact_sha256,
          encrypted_code, ticket_expires_at, expires_at, created_at,
          used_at, redeemed_server_id, install_id, node_token_hash)
       VALUES ($1, $2, $3, 'linux', 'x64', $4, 'enc', $5, $5, $5,
               $5, $6, $7, $8)
       RETURNING id`,
      [hex(32), hex(32), userId, hex(32), Date.now(), serverId, installId, nodeTokenHash],
    );
    const sql = await readFile(migFile(MIGRATION_059), 'utf8');
    await db.execute(sql);
    await db.execute(sql);
    const rows = await db.query<{ install_id: string; node_token_hash: string; redeemed_server_id: string }>(
      `SELECT install_id, node_token_hash, redeemed_server_id
         FROM controlled_node_enrollment_installs
        WHERE enrollment_id = $1`,
      [enrollment!.id],
    );
    expect(rows).toEqual([{ install_id: installId, node_token_hash: nodeTokenHash, redeemed_server_id: serverId }]);
  });
});

describe('058 controlled-node execution default', () => {
  it('defaults new server rows to executable without changing an existing explicit false', async () => {
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const defaultedId = `ctl_default_${hex(6)}`;
    const disabledId = `ctl_disabled_${hex(6)}`;
    await db.execute(
      `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role)
       VALUES ($1, $2, 'default-enabled', $3, 'offline', $4, $5)`,
      [defaultedId, userId, hex(16), Date.now(), NODE_ROLE.CONTROLLED],
    );
    await db.execute(
      `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled)
       VALUES ($1, $2, 'explicitly-disabled', $3, 'offline', $4, $5, false)`,
      [disabledId, userId, hex(16), Date.now(), NODE_ROLE.CONTROLLED],
    );

    const sql = await readFile(migFile(MIGRATION_058), 'utf8');
    await db.execute(sql);

    const rows = await db.query<{ id: string; exec_enabled: boolean }>(
      'SELECT id, exec_enabled FROM servers WHERE id IN ($1, $2) ORDER BY id',
      [defaultedId, disabledId],
    );
    expect(new Map(rows.map((row) => [row.id, row.exec_enabled]))).toEqual(new Map([
      [defaultedId, true],
      [disabledId, false],
    ]));
  });
});

describe('056 controlled_node_enrollments_v2 partial-upgrade hardening', () => {
  it('fresh full-migration end state: exactly ONE UNIQUE(ticket_hash) and NOT NULL (052 duplicate-unique bug resolved)', async () => {
    expect(await uniqueCountOnTicketHash()).toBe(1);
    expect(await ticketHashIsNullable()).toBe(false);
  });

  it('re-running 056 on a clean table is idempotent', async () => {
    const sql = await readFile(migFile(MIGRATION_056), 'utf8');
    await db.execute(sql);
    expect(await uniqueCountOnTicketHash()).toBe(1);
    expect(await ticketHashIsNullable()).toBe(false);
  });

  it('empty partial (nullable ticket_hash, no rows) → 056 re-applies NOT NULL cleanly', async () => {
    const sql = await readFile(migFile(MIGRATION_056), 'utf8');
    try {
      await db.execute('ALTER TABLE controlled_node_enrollments_v2 ALTER COLUMN ticket_hash DROP NOT NULL');
      expect(await ticketHashIsNullable()).toBe(true);
      await db.execute(sql); // empty → no NULL rows → SET NOT NULL succeeds
      expect(await ticketHashIsNullable()).toBe(false);
    } finally {
      await db.execute('ALTER TABLE controlled_node_enrollments_v2 ALTER COLUMN ticket_hash SET NOT NULL');
    }
  });

  it('NULL ticket_hash partial rows → 056 fails closed with a count and NEVER auto-deletes', async () => {
    const u = `u_${hex(4)}`; await createUser(db, u);
    const sql = await readFile(migFile(MIGRATION_056), 'utf8');
    try {
      await db.execute('ALTER TABLE controlled_node_enrollments_v2 ALTER COLUMN ticket_hash DROP NOT NULL');
      await db.execute(
        `INSERT INTO controlled_node_enrollments_v2
           (id, ticket_hash, code_hash, owner_user_id, os, arch, artifact_sha256,
            encrypted_code, ticket_expires_at, expires_at, created_at)
         VALUES (gen_random_uuid(), NULL, $1, $2, 'linux', 'x64', 'sha', 'enc', $3, $3, $3)`,
        [hex(16), u, Date.now()],
      );
      await expect(db.execute(sql)).rejects.toThrow(/NULL ticket_hash/);
      // no auto-delete: the offending row is untouched for operator remediation
      const rows = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM controlled_node_enrollments_v2 WHERE ticket_hash IS NULL AND owner_user_id = $1',
        [u],
      );
      expect(rows[0].n).toBe(1);
    } finally {
      await db.execute('DELETE FROM controlled_node_enrollments_v2 WHERE ticket_hash IS NULL AND owner_user_id = $1', [u]);
      await db.execute('ALTER TABLE controlled_node_enrollments_v2 ALTER COLUMN ticket_hash SET NOT NULL');
    }
  });

  it('056 makes ZERO changes before failing closed: a RAISE with a dedup-able duplicate present leaves the duplicate intact (atomic, preflight-before-mutation)', async () => {
    const u = `u_${hex(4)}`; await createUser(db, u);
    const sql = await readFile(migFile(MIGRATION_056), 'utf8');
    try {
      await db.execute('ALTER TABLE controlled_node_enrollments_v2 ALTER COLUMN ticket_hash DROP NOT NULL');
      await db.execute('ALTER TABLE controlled_node_enrollments_v2 ADD CONSTRAINT cne_v2_ticket_hash_dup2 UNIQUE (ticket_hash)');
      await db.execute(
        `INSERT INTO controlled_node_enrollments_v2
           (id, ticket_hash, code_hash, owner_user_id, os, arch, artifact_sha256,
            encrypted_code, ticket_expires_at, expires_at, created_at)
         VALUES (gen_random_uuid(), NULL, $1, $2, 'linux', 'x64', 'sha', 'enc', $3, $3, $3)`,
        [hex(16), u, Date.now()],
      );
      const before = await uniqueCountOnTicketHash();
      expect(before).toBeGreaterThan(1);
      await expect(db.execute(sql)).rejects.toThrow(/NULL ticket_hash/);
      // Preflight RAISE ran before ANY mutation: the dedup did NOT happen and
      // NOT NULL was NOT applied → schema is byte-for-byte unchanged after the fail.
      expect(await uniqueCountOnTicketHash()).toBe(before);
      expect(await ticketHashIsNullable()).toBe(true);
    } finally {
      await db.execute('DELETE FROM controlled_node_enrollments_v2 WHERE ticket_hash IS NULL AND owner_user_id = $1', [u]);
      await db.execute('ALTER TABLE controlled_node_enrollments_v2 DROP CONSTRAINT IF EXISTS cne_v2_ticket_hash_dup2');
      await db.execute('ALTER TABLE controlled_node_enrollments_v2 ALTER COLUMN ticket_hash SET NOT NULL');
    }
  });

  it('duplicate UNIQUE(ticket_hash) → 056 deduplicates back to exactly one', async () => {
    const sql = await readFile(migFile(MIGRATION_056), 'utf8');
    try {
      await db.execute('ALTER TABLE controlled_node_enrollments_v2 ADD CONSTRAINT cne_v2_ticket_hash_dup UNIQUE (ticket_hash)');
      expect(await uniqueCountOnTicketHash()).toBeGreaterThan(1);
      await db.execute(sql);
      expect(await uniqueCountOnTicketHash()).toBe(1);
    } finally {
      // 056 already dropped the extra; guard against leaving a stray if it didn't.
      await db.execute('ALTER TABLE controlled_node_enrollments_v2 DROP CONSTRAINT IF EXISTS cne_v2_ticket_hash_dup');
    }
  });

  it('partial table with ZERO unique on ticket_hash → 056 CREATES one (uniqueness invariant restored)', async () => {
    const sql = await readFile(migFile(MIGRATION_056), 'utf8');
    const cons = await db.query<{ conname: string }>(
      `SELECT con.conname FROM pg_constraint con
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
        WHERE con.conrelid = 'controlled_node_enrollments_v2'::regclass
          AND con.contype = 'u' AND array_length(con.conkey,1) = 1 AND a.attname = 'ticket_hash'`);
    for (const c of cons) {
      await db.execute(`ALTER TABLE controlled_node_enrollments_v2 DROP CONSTRAINT "${c.conname}"`);
    }
    expect(await uniqueCountOnTicketHash()).toBe(0);
    await db.execute(sql); // must not leave v_kept NULL without creating a unique
    expect(await uniqueCountOnTicketHash()).toBe(1);
    expect(await ticketHashIsNullable()).toBe(false);
  });

  it('an abnormal-TTL partial row (ticket_expires_at backfilled = expires_at) necessarily has NULL ticket_hash and is caught by the (a) gate', async () => {
    const u = `u_${hex(4)}`; await createUser(db, u);
    const sql = await readFile(migFile(MIGRATION_056), 'utf8');
    const now = Date.now();
    try {
      await db.execute('ALTER TABLE controlled_node_enrollments_v2 ALTER COLUMN ticket_hash DROP NOT NULL');
      // exact 052 partial-backfill signature: ticket_expires_at == expires_at (widened
      // to the enrollment lifetime) AND ticket_hash NULL (both columns added together).
      await db.execute(
        `INSERT INTO controlled_node_enrollments_v2
           (id, ticket_hash, code_hash, owner_user_id, os, arch, artifact_sha256,
            encrypted_code, ticket_expires_at, expires_at, created_at)
         VALUES (gen_random_uuid(), NULL, $1, $2, 'linux', 'x64', 'sha', 'enc', $3, $3, $3)`,
        [hex(16), u, now]);
      // the abnormal-TTL row is gated by the NULL ticket_hash preflight (never silently kept)
      await expect(db.execute(sql)).rejects.toThrow(/NULL ticket_hash/);
    } finally {
      await db.execute('DELETE FROM controlled_node_enrollments_v2 WHERE ticket_hash IS NULL AND owner_user_id = $1', [u]);
      await db.execute('ALTER TABLE controlled_node_enrollments_v2 ALTER COLUMN ticket_hash SET NOT NULL');
    }
  });

  it('057 fails closed (with count) if 053 already erased any source/target serverId, instead of silently retaining erased rows', async () => {
    const u = `u_${hex(4)}`; await createUser(db, u);
    const sql = await readFile(migFile(MIGRATION_057), 'utf8');
    const cid = hex(16);
    try {
      // simulate a row whose target server was deleted under 053's ON DELETE SET NULL
      await db.execute(
        `INSERT INTO machine_exec_audit
           (correlation_id, user_id, source_server_id, target_server_id, command_sha256,
            command_length, shell, outcome, timed_out, duration_ms, created_at, updated_at)
         VALUES ($1, $2, $3, NULL, $4, 4, 'bash', 'completed', false, 1, $5, $5)`,
        [cid, u, hex(8), 'a'.repeat(64), Date.now()]);
      await expect(db.execute(sql)).rejects.toThrow(/already erased/);
      // fail-closed, not auto-deleted
      expect((await db.query('SELECT 1 FROM machine_exec_audit WHERE correlation_id = $1', [cid])).length).toBe(1);
    } finally {
      await db.execute('DELETE FROM machine_exec_audit WHERE correlation_id = $1', [cid]);
    }
  });
});
