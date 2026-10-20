import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.js';
import { CONTROLLED_NODE_ABI_GLIBC217, CONTROLLED_NODE_ABI_MODERN } from '../../shared/controlled-node-abi.js';

describe('additive controlled-node ABI migration (real PostgreSQL)', () => {
  it('recovers partial DDL without changing existing ids, soft-deleted owners or old-peer conflict keys', async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('scoped_test_database_required');
    const db = createDatabase(process.env.TEST_DATABASE_URL);
    const schema = `imcodes_test_abi_${randomUUID().replaceAll('-', '')}`;
    try {
      await db.exec(`CREATE SCHEMA ${schema}`);
      await db.transaction(async (tx) => {
        await tx.exec(`SET LOCAL search_path TO ${schema}`);
        await tx.exec(`
          CREATE TABLE servers (id TEXT PRIMARY KEY, user_id TEXT, deleted_at BIGINT);
          CREATE TABLE controlled_node_enrollments_v2 (id TEXT PRIMARY KEY, owner_user_id TEXT, os TEXT, arch TEXT, host_server_id TEXT, revoked_at BIGINT);
          CREATE UNIQUE INDEX old_owner_target ON controlled_node_enrollments_v2 (owner_user_id, os, arch, (COALESCE(host_server_id, ''))) WHERE revoked_at IS NULL;
          CREATE TABLE controlled_node_artifact_manifests (os TEXT, arch TEXT, sha256 TEXT, PRIMARY KEY(os,arch));
          INSERT INTO servers VALUES ('existing-a','owner-a',NULL), ('deleted-b','owner-b',42);
          INSERT INTO controlled_node_enrollments_v2 VALUES ('link-a','owner-a','linux','x64',NULL,NULL), ('link-b','owner-b','linux','x64',NULL,NULL);
          INSERT INTO controlled_node_artifact_manifests VALUES ('linux','x64','last-good-modern');
          -- Simulate a previous deployment failing after its first ALTER.
          ALTER TABLE servers ADD COLUMN abi_profile TEXT NOT NULL DEFAULT 'modern';
        `);
        const sql = await readFile(new URL('../src/db/migrations/101_controlled_node_abi_profiles.sql', import.meta.url), 'utf8');
        await tx.exec(sql); await tx.exec(sql);
        expect(await tx.query('SELECT id,user_id,deleted_at,abi_profile FROM servers ORDER BY id')).toEqual([
          { id: 'deleted-b', user_id: 'owner-b', deleted_at: 42, abi_profile: CONTROLLED_NODE_ABI_MODERN },
          { id: 'existing-a', user_id: 'owner-a', deleted_at: null, abi_profile: CONTROLLED_NODE_ABI_MODERN },
        ]);
        // Old servers retain their original 2-key upsert. Compat is a separate
        // descriptor row, never a rewritten PK or CPU identity.
        await tx.exec(`INSERT INTO controlled_node_artifact_manifests VALUES ('linux','x64','old-peer-modern') ON CONFLICT(os,arch) DO UPDATE SET sha256=EXCLUDED.sha256`);
        await tx.execute(`INSERT INTO controlled_node_artifact_variants VALUES ('linux','x64',$1,'compat',6,$2,'manifest_json',1,1)`, [CONTROLLED_NODE_ABI_GLIBC217, 'b'.repeat(64)]);
        expect(await tx.query('SELECT sha256 FROM controlled_node_artifact_manifests')).toEqual([{ sha256: 'old-peer-modern' }]);
        expect(await tx.query('SELECT id,abi_profile,abi_variants FROM controlled_node_enrollments_v2 ORDER BY id')).toEqual([
          { id: 'link-a', abi_profile: CONTROLLED_NODE_ABI_MODERN, abi_variants: {} },
          { id: 'link-b', abi_profile: CONTROLLED_NODE_ABI_MODERN, abi_variants: {} },
        ]);
      });
      // Concurrent old writers on distinct connections still hit their own
      // original owner key; one owner's upgrade cannot strand the other's link.
      await Promise.all(['owner-a', 'owner-b'].map(async (owner) => db.transaction(async (tx) => {
        await tx.exec(`SET LOCAL search_path TO ${schema}`);
        await tx.execute(`INSERT INTO controlled_node_enrollments_v2 (id,owner_user_id,os,arch)
          VALUES ($1,$2,'linux','x64') ON CONFLICT(owner_user_id,os,arch,(COALESCE(host_server_id,''))) WHERE revoked_at IS NULL
          DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id`, [`new-${owner}`, owner]);
      })));
      expect(await db.query(`SELECT id FROM ${schema}.controlled_node_enrollments_v2 ORDER BY id`)).toEqual([{ id: 'link-a' }, { id: 'link-b' }]);
    } finally {
      await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.close();
    }
  });
});
