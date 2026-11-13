/**
 * Real PostgreSQL integration tests for Cloud Docs & Recent Documents (migration 105,
 * idempotency & partial-DDL retry, multi-user team FKs, partial unique share indexes,
 * and concurrent CAS commitCloudDocContent).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/queries.js';
import {
  commitCloudDocContent,
  createCloudDocFolder,
  deleteCloudDocFolderTree,
  insertCloudDoc,
  listSharedCloudItemsForUser,
  resolveCloudDocAccess,
  revokeCloudDocShare,
  upsertCloudDocShare,
} from '../src/db/cloud-docs.js';

let db: Database;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

describe('cloud-docs & migration 105 PostgreSQL integration', () => {
  it('verifies migration 105 idempotency, partial-DDL recovery, and multi-user + teams FKs', async () => {
    const now = Date.now();
    await createUser(db, 'cd-owner', 'cd_owner', 'Owner');
    await createUser(db, 'cd-member', 'cd_member', 'Member');
    await createUser(db, 'cd-outsider', 'cd_outsider', 'Outsider');
    await db.execute(
      `INSERT INTO teams (id, name, owner_id, plan, created_at)
       VALUES ($1, $2, $3, 'free', $4)
       ON CONFLICT (id) DO NOTHING`,
      ['cd-team-1', 'Core Group', 'cd-owner', now],
    );
    await db.execute(
      `INSERT INTO team_members (team_id, user_id, role, joined_at)
       VALUES ($1, $2, 'owner', $3), ($1, $4, 'member', $3)
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      ['cd-team-1', 'cd-owner', now, 'cd-member'],
    );

    const folder = await createCloudDocFolder(db, { userId: 'cd-owner', name: 'Specs' });
    const doc = await insertCloudDoc(db, {
      id: 'cd-pg-doc-1',
      userId: 'cd-owner',
      folderId: folder.id,
      name: 'Spec.docx',
      ext: '.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 128,
      contentSha256: 'abc123',
      storageKey: 'cd-owner/cd-pg-doc-1/v1',
    });
    expect(Number(doc.doc_version)).toBe(1);

    // 1. Re-run migration 105 on already-populated DB (idempotency #2)
    await db.execute("DELETE FROM _migrations WHERE name = '105_cloud_docs_and_recent_documents.sql'");
    await runMigrations(db);

    // 2. Partial DDL rollback/retry: drop subset of objects created by 105 and re-run migration 105
    await db.exec(`
      DROP INDEX IF EXISTS uq_cloud_doc_shares_active_user;
      DROP TABLE IF EXISTS recent_documents;
    `);
    await db.execute("DELETE FROM _migrations WHERE name = '105_cloud_docs_and_recent_documents.sql'");
    await runMigrations(db);

    for (const rel of ['cloud_doc_folders', 'cloud_docs', 'recent_documents', 'cloud_doc_shares', 'uq_cloud_doc_shares_active_user']) {
      const reg = await db.queryOne<{ oid: string | null }>('SELECT to_regclass($1) AS oid', [rel]);
      expect(reg?.oid).toBeTruthy();
    }

    // 3. Share FK & CHECK constraints + partial unique index across soft-revoke/re-share
    await expect(
      db.execute(
        `INSERT INTO cloud_doc_shares (id, target_kind, target_id, share_mode, target_team_id, target_user_id, role, allow_download, created_by, created_at, updated_at)
         VALUES ('bad-chk', 'doc', $1, 'team', 'cd-team-1', 'cd-member', 'viewer', TRUE, 'cd-owner', $2, $2)`,
        [doc.id, now],
      ),
    ).rejects.toThrow();

    const teamShare = await upsertCloudDocShare(db, {
      targetKind: 'folder',
      targetId: folder.id,
      shareMode: 'team',
      targetTeamId: 'cd-team-1',
      role: 'editor',
      allowDownload: true,
      createdBy: 'cd-owner',
    });
    const sharedBefore = await listSharedCloudItemsForUser(db, 'cd-member');
    expect(sharedBefore.sharedDocs.some((d) => d.id === doc.id && d.role === 'editor')).toBe(true);

    // Doc override downgrades member to viewer without download
    const docOverride = await upsertCloudDocShare(db, {
      targetKind: 'doc',
      targetId: doc.id,
      shareMode: 'user',
      targetUserId: 'cd-member',
      role: 'viewer',
      allowDownload: false,
      createdBy: 'cd-owner',
    });
    const accessDowngraded = await resolveCloudDocAccess(db, doc.id, 'cd-member');
    expect(accessDowngraded).toMatchObject({ allowed: true, role: 'viewer', allowDownload: false });

    // Soft-revoke & re-share same user succeeds cleanly under partial unique index WHERE revoked_at IS NULL
    expect(await revokeCloudDocShare(db, { shareId: docOverride.id, createdBy: 'cd-owner' })).toBe(true);
    const reShared = await upsertCloudDocShare(db, {
      targetKind: 'doc',
      targetId: doc.id,
      shareMode: 'user',
      targetUserId: 'cd-member',
      role: 'editor',
      allowDownload: true,
      createdBy: 'cd-owner',
    });
    expect(reShared.id).not.toBe(docOverride.id);

    // Outsider stays denied
    expect(await resolveCloudDocAccess(db, doc.id, 'cd-outsider')).toMatchObject({ allowed: false });

    // Cleanup folder tree cascades cleanly
    await revokeCloudDocShare(db, { shareId: teamShare.id, createdBy: 'cd-owner' });
    await revokeCloudDocShare(db, { shareId: reShared.id, createdBy: 'cd-owner' });
    const deleted = await deleteCloudDocFolderTree(db, 'cd-owner', folder.id);
    expect(deleted?.deletedFolderIds).toContain(folder.id);
    expect(deleted?.storageKeys).toContain(doc.storage_key);
  });

  it('guarantees single winner under concurrent commitCloudDocContent CAS updates in PostgreSQL', async () => {
    const doc = await insertCloudDoc(db, {
      id: 'cd-pg-cas-1',
      userId: 'cd-owner',
      folderId: null,
      name: 'Concurrent.docx',
      ext: '.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 64,
      contentSha256: 'v1hash',
      storageKey: 'cd-owner/cd-pg-cas-1/v1',
    });

    const writers = Array.from({ length: 5 }, (_, idx) =>
      commitCloudDocContent(db, {
        docId: doc.id,
        userId: 'cd-owner',
        expectedVersion: 1,
        bumpVersion: true,
        newStorageKey: `cd-owner/cd-pg-cas-1/v2-writer-${idx}`,
        sizeBytes: 200 + idx,
        contentSha256: `v2hash-${idx}`,
      }),
    );

    const results = await Promise.all(writers);
    const committed = results.filter((r) => r.status === 'committed');
    const conflicts = results.filter((r) => r.status === 'conflict');

    expect(committed).toHaveLength(1);
    expect(conflicts).toHaveLength(4);
    if (committed[0]?.status === 'committed') {
      expect(Number(committed[0].doc.doc_version)).toBe(2);
      expect(committed[0].doc.storage_key).toMatch(/^cd-owner\/cd-pg-cas-1\/v2-writer-/);
    }
  });
});
