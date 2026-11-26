import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';
import {
  backfillNamespacesAndObservations,
  ensureContextNamespace,
  getContextMeta,
  listContextNamespaces,
  listContextObservations,
  listProcessedProjections,
  listObservationPromotionAudits,
  promoteContextObservation,
  rejectAutomaticObservationPromotion,
  getProjectionEmbedding,
  saveProjectionEmbedding,
  updateContextObservationText,
  writeContextObservation,
  writeProcessedProjection,
  deleteMemory,
  resetContextStoreForTests,
} from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

describe('post-1.1 context namespace and observation store', () => {
  let tempDir: string;
  let namespace: ContextNamespace;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('context-observation-store');
    namespace = { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' };
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('creates canonical namespace records without widening legacy personal scope', () => {
    const row = ensureContextNamespace(namespace, 100);
    expect(row).toMatchObject({ scope: 'personal', userId: 'user-1', projectId: 'github.com/acme/repo', visibility: 'private' });
    expect(listContextNamespaces({ scope: 'personal' })).toHaveLength(1);

    const userPrivate = ensureContextNamespace({ scope: 'user_private', userId: 'user-1', localTenant: 'local' }, 101);
    expect(userPrivate).toMatchObject({ scope: 'user_private', userId: 'user-1', projectId: undefined, visibility: 'private' });

    const projectShared = ensureContextNamespace({
      scope: 'project_shared',
      canonicalRepoId: 'git@github.com:Acme/Repo.git',
      workspaceId: 'workspace-1',
      localTenant: 'tenant-1',
    }, 102);
    expect(projectShared).toMatchObject({
      scope: 'project_shared',
      localTenant: 'tenant-1',
      projectId: 'github.com/acme/repo',
      workspaceId: 'workspace-1',
      visibility: 'shared',
    });
  });

  it('does not run namespace/observation backfill synchronously on first store open', () => {
    expect(getContextMeta('migration_namespace_observation_backfilled')).toBeUndefined();
    expect(getContextMeta('last_observation_repair_at')).toBeUndefined();
  });

  it('writes an active typed observation transactionally with processed projections', () => {
    const projection = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      origin: 'chat_compacted',
      sourceEventIds: ['evt-1'],
      summary: 'Fixed ack ordering',
      content: { text: 'Fixed ack ordering', observationClass: 'bugfix' },
      createdAt: 100,
      updatedAt: 110,
    });

    const observations = listContextObservations({ projectionId: projection.id });
    expect(observations).toEqual([
      expect.objectContaining({
        scope: 'personal',
        class: 'bugfix',
        origin: 'chat_compacted',
        projectionId: projection.id,
        sourceEventIds: ['evt-1'],
        state: 'active',
        content: expect.objectContaining({
          ownerUserId: 'user-1',
          createdByUserId: 'user-1',
        }),
      }),
    ]);
    expect(projection.origin).toBe('chat_compacted');
    expect(projection.content).toEqual({
      text: 'Fixed ack ordering',
      observationClass: 'bugfix',
    });
  });

  it('keeps legacy personal namespaces without user ids readable while binding observations locally', () => {
    const legacyNamespace: ContextNamespace = { scope: 'personal', projectId: 'github.com/acme/legacy' };
    const projection = writeProcessedProjection({
      namespace: legacyNamespace,
      class: 'recent_summary',
      origin: 'chat_compacted',
      sourceEventIds: ['evt-legacy-no-user'],
      summary: 'Legacy namespace summary',
      content: { text: 'Legacy namespace summary', observationClass: 'fact' },
      createdAt: 100,
      updatedAt: 110,
    });

    expect(listProcessedProjections(legacyNamespace, 'recent_summary')[0]).toMatchObject({
      id: projection.id,
      namespace: legacyNamespace,
    });
    expect(listContextNamespaces({ scope: 'personal', projectId: legacyNamespace.projectId })[0]?.userId).toEqual(expect.any(String));
    expect(listContextObservations({ projectionId: projection.id })).toEqual([
      expect.objectContaining({
        scope: 'personal',
        class: 'fact',
        projectionId: projection.id,
      }),
    ]);
  });

  it('dedupes observation writes and unions source ids in the same namespace/class/fingerprint/text hash', () => {
    const namespaceRow = ensureContextNamespace(namespace, 100);
    const first = writeContextObservation({
      namespaceId: namespaceRow.id,
      scope: 'personal',
      class: 'decision',
      origin: 'agent_learned',
      fingerprint: 'fp-1',
      content: { text: 'Use daemon receipt ack' },
      sourceEventIds: ['evt-1'],
      now: 100,
    });
    const second = writeContextObservation({
      namespaceId: namespaceRow.id,
      scope: 'personal',
      class: 'decision',
      origin: 'agent_learned',
      fingerprint: 'fp-1',
      content: { text: 'Use daemon receipt ack' },
      sourceEventIds: ['evt-2', 'evt-1'],
      now: 200,
    });

    expect(second.id).toBe(first.id);
    expect(listContextObservations({ namespaceId: namespaceRow.id, class: 'decision' })[0].sourceEventIds).toEqual(['evt-1', 'evt-2']);
  });

  it('filters and limits observations in the store before returning worker payloads', () => {
    const allowed = ensureContextNamespace(namespace, 100);
    const denied = ensureContextNamespace({ ...namespace, userId: 'user-2' }, 100);
    writeContextObservation({
      namespaceId: allowed.id,
      scope: 'personal',
      class: 'note',
      origin: 'user_note',
      fingerprint: 'allowed-old',
      content: { text: 'allowed old' },
      state: 'active',
      now: 100,
    });
    const newest = writeContextObservation({
      namespaceId: allowed.id,
      scope: 'personal',
      class: 'note',
      origin: 'user_note',
      fingerprint: 'allowed-new',
      content: { text: 'allowed new' },
      state: 'active',
      now: 300,
    });
    writeContextObservation({
      namespaceId: denied.id,
      scope: 'personal',
      class: 'note',
      origin: 'user_note',
      fingerprint: 'denied-newest',
      content: { text: 'denied newest' },
      state: 'active',
      now: 400,
    });

    expect(listContextObservations({
      namespaceIds: [allowed.id],
      scope: 'personal',
      class: 'note',
      state: ['active'],
      limit: 1,
    })).toEqual([expect.objectContaining({ id: newest.id })]);
    expect(listContextObservations({ namespaceIds: [] })).toEqual([]);
    expect(listContextObservations({ state: [] })).toEqual([]);
    expect(listContextObservations({ limit: 0 })).toEqual([]);
  });

  it('rejects invalid or reserved projection origins before durable writes', () => {
    expect(() => writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-reserved-origin'],
      summary: 'Reserved origin must not write',
      content: { origin: 'quick_search_cache' },
      createdAt: 100,
      updatedAt: 110,
    })).toThrow(/Reserved memory origin/);
    expect(listProcessedProjections(namespace)).toHaveLength(0);
    expect(listContextObservations()).toHaveLength(0);
  });

  it('merges overlapping projection and observation writes idempotently under retry-like concurrency', async () => {
    const writes = await Promise.all(['evt-a', 'evt-b', 'evt-a'].map((eventId, index) => Promise.resolve().then(() => writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      origin: 'agent_learned',
      sourceEventIds: [eventId],
      summary: 'Retry-safe projection merge',
      content: { text: 'Retry-safe projection merge', observationClass: 'fact' },
      createdAt: 100 + index,
      updatedAt: 110 + index,
    }))));

    expect(new Set(writes.map((write) => write.id)).size).toBe(1);
    expect(listProcessedProjections(namespace, 'recent_summary')).toEqual([
      expect.objectContaining({
        origin: 'agent_learned',
        sourceEventIds: ['evt-a', 'evt-b'],
      }),
    ]);
    expect(listContextObservations({ projectionId: writes[0].id })).toEqual([
      expect.objectContaining({
        origin: 'agent_learned',
        sourceEventIds: ['evt-a', 'evt-b'],
      }),
    ]);
  });

  it('deletes linked observations when deleting a processed memory projection', () => {
    const projection = writeProcessedProjection({
      namespace,
      class: 'durable_memory_candidate',
      origin: 'user_note',
      sourceEventIds: ['evt-delete-linked'],
      summary: 'Delete the linked observation with this memory',
      content: { text: 'Delete the linked observation with this memory', observationClass: 'note' },
      createdAt: 100,
      updatedAt: 110,
    });

    expect(listContextObservations({ projectionId: projection.id })).toHaveLength(1);
    expect(deleteMemory(projection.id)).toBe(true);
    expect(listContextObservations({ projectionId: projection.id })).toHaveLength(0);
    expect(deleteMemory(projection.id)).toBe(false);
  });

  it('clears stale projection embeddings when editing a linked observation', () => {
    const projection = writeProcessedProjection({
      namespace,
      class: 'durable_memory_candidate',
      origin: 'user_note',
      sourceEventIds: ['evt-edit-linked'],
      summary: 'Original linked observation text',
      content: { text: 'Original linked observation text', observationClass: 'note' },
      createdAt: 100,
      updatedAt: 110,
    });
    const observation = listContextObservations({ projectionId: projection.id })[0];
    expect(observation).toBeTruthy();
    saveProjectionEmbedding(projection.id, Buffer.from([1, 2, 3, 4]), projection.summary);
    expect(getProjectionEmbedding(projection.id)?.embeddingSource).toBe(projection.summary);

    const updated = updateContextObservationText({
      observationId: observation.id,
      text: 'Edited linked observation text',
      fingerprint: 'fp-edited-linked-observation',
      observationClass: observation.class,
      now: 200,
    });

    expect(updated).toMatchObject({
      id: observation.id,
      content: expect.objectContaining({ text: 'Edited linked observation text' }),
    });
    const embedding = getProjectionEmbedding(projection.id);
    expect(embedding?.summary).toBe('Edited linked observation text');
    expect(embedding?.embedding).toBeNull();
    expect(embedding?.embeddingSource).toBeNull();
  });

  it('rejects observations whose scope does not match the namespace scope', () => {
    const namespaceRow = ensureContextNamespace(namespace, 100);

    expect(() => writeContextObservation({
      namespaceId: namespaceRow.id,
      scope: 'project_shared',
      class: 'note',
      origin: 'user_note',
      fingerprint: 'fp-scope-mismatch',
      content: { text: 'This must remain personal' },
      now: 100,
    })).toThrow(/does not match namespace scope/);
    expect(listContextObservations()).toHaveLength(0);
  });

  it('backfills legacy projections into namespace and observation rows restartably', () => {
    const projection = writeProcessedProjection({
      namespace,
      class: 'durable_memory_candidate',
      origin: 'chat_compacted',
      sourceEventIds: ['evt-legacy'],
      summary: 'Legacy durable note',
      content: { text: 'Legacy durable note' },
      createdAt: 100,
      updatedAt: 110,
    });

    const stats = backfillNamespacesAndObservations({ limit: 10, now: 200 });
    expect(stats.namespacesBackfilled).toBeGreaterThanOrEqual(0);
    expect(listContextObservations({ projectionId: projection.id })).toHaveLength(1);
    expect(backfillNamespacesAndObservations({ limit: 10, now: 300 }).observationsBackfilled).toBe(0);
  });

  it('requires explicit promotion actions for private-to-shared observation promotion and records audit', () => {
    const namespaceRow = ensureContextNamespace(namespace, 100);
    const observation = writeContextObservation({
      namespaceId: namespaceRow.id,
      scope: 'personal',
      class: 'note',
      origin: 'user_note',
      fingerprint: 'fp-promote',
      content: { text: 'Promote only with audit' },
      now: 100,
    });

    expect(() => rejectAutomaticObservationPromotion('personal', 'project_shared')).toThrow(/automatic promotion/);
    expect(() => promoteContextObservation({
      observationId: observation.id,
      actorId: 'worker-1',
      action: 'background_worker' as never,
      toScope: 'project_shared',
      now: 150,
    })).toThrow(/unauthorized observation promotion action/);

    expect(() => promoteContextObservation({
      observationId: observation.id,
      actorId: 'user-1',
      action: 'web_ui_promote',
      toScope: 'project_shared',
      reason: 'share with project',
      now: 175,
    })).toThrow(/requires administrator authorization/);

    const audit = promoteContextObservation({
      observationId: observation.id,
      actorId: 'user-1',
      action: 'web_ui_promote',
      toScope: 'project_shared',
      actorRole: 'workspace_admin',
      reason: 'share with project',
      now: 200,
    });
    expect(audit).toMatchObject({ observationId: observation.id, fromScope: 'personal', toScope: 'project_shared' });
    expect(listObservationPromotionAudits(observation.id)).toEqual([audit]);
  });

  it('filters withoutProjection, after/before, and text prefilter, and creates idempotent index without full-table scan', () => {
    const nsRow = ensureContextNamespace(namespace, 100);
    const unprojOld = writeContextObservation({
      namespaceId: nsRow.id,
      scope: 'personal',
      class: 'bugfix',
      origin: 'user_note',
      fingerprint: 'fp-unproj-old',
      content: { text: 'unprojected alpha detail', title: 'Alpha' },
      sourceEventIds: ['evt-special-100'],
      now: 100,
    });
    const unprojInWindow = writeContextObservation({
      namespaceId: nsRow.id,
      scope: 'personal',
      class: 'decision',
      origin: 'agent_learned',
      fingerprint: 'fp-unproj-mid',
      content: { text: 'unprojected beta detail' },
      sourceEventIds: ['evt-special-200'],
      now: 250,
    });
    writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      origin: 'chat_compacted',
      sourceEventIds: ['evt-proj-300'],
      summary: 'projected detail beta',
      content: { text: 'projected detail beta' },
      createdAt: 300,
      updatedAt: 300,
    });

    // Also verify a legacy/raw row with projection_id = '' is treated identically to NULL.
    const dbPath = join(tempDir, 'context.sqlite');
    resetContextStoreForTests();
    const rawEmptyProjDb = new DatabaseSync(dbPath);
    rawEmptyProjDb.prepare(`
      INSERT INTO context_observations (
        id, namespace_id, scope, class, origin, fingerprint, content_json, text_hash,
        source_event_ids_json, projection_id, state, confidence, created_at, updated_at, promoted_at
      ) VALUES (?, ?, 'personal', 'note', 'user_note', ?, ?, ?, '[]', '', 'active', NULL, ?, ?, NULL)
    `).run('obs-empty-proj', nsRow.id, 'fp-empty-proj', JSON.stringify({ text: 'empty string projection id row' }), 'hash-empty-proj', 260, 260);
    rawEmptyProjDb.close();

    expect(listContextObservations({
      namespaceIds: [nsRow.id],
      state: ['active'],
      withoutProjection: true,
    }).map((r) => r.id)).toEqual(['obs-empty-proj', unprojInWindow.id, unprojOld.id]);

    expect(listContextObservations({
      namespaceIds: [nsRow.id],
      withoutProjection: true,
      after: 200,
      before: 250,
    }).map((r) => r.id)).toEqual([unprojInWindow.id]);

    expect(listContextObservations({
      namespaceIds: [nsRow.id],
      withoutProjection: true,
      query: 'bugfix evt-special-100',
    }).map((r) => r.id)).toEqual([unprojOld.id]);

    expect(listContextObservations({
      namespaceIds: [nsRow.id],
      withoutProjection: true,
      projectionId: 'any-id',
    })).toEqual([]);

    // Verify idempotent index creation when reopening an existing DB and verify EXPLAIN QUERY PLAN.
    resetContextStoreForTests();
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec('DROP INDEX IF EXISTS idx_context_observations_namespace_state_projection_updated');
    rawDb.close();

    // Reopening via store API idempotently recreates the composite index.
    expect(listContextObservations({
      namespaceIds: [nsRow.id],
      state: ['active'],
      withoutProjection: true,
    }).map((r) => r.id)).toEqual(['obs-empty-proj', unprojInWindow.id, unprojOld.id]);

    const inspectDb = new DatabaseSync(dbPath);
    const indexes = inspectDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'context_observations'").all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_context_observations_namespace_state_projection_updated');

    const plan = inspectDb.prepare(`
      EXPLAIN QUERY PLAN
      SELECT *
        FROM context_observations
       WHERE namespace_id IN (?, ?)
         AND state IN ('candidate', 'active', 'promoted')
         AND COALESCE(projection_id, '') = ''
       ORDER BY updated_at DESC, id ASC
       LIMIT 50
    `).all(nsRow.id, 'other-ns') as Array<{ detail: string }>;
    inspectDb.close();
    const planDetails = plan.map((row) => row.detail).join('\n');
    expect(planDetails).toContain('idx_context_observations_namespace_state_projection_updated');
    expect(planDetails).not.toMatch(/\bSCAN context_observations\b/);
  });

  it('allows explicit empty projectionId to clear a prior non-empty projectionId on upsert', () => {
    const nsRow = ensureContextNamespace(namespace, 100);
    const linked = writeContextObservation({
      namespaceId: nsRow.id,
      scope: 'personal',
      class: 'note',
      origin: 'user_note',
      fingerprint: 'fp-clear-proj',
      content: { text: 'observation initially linked then unlinked' },
      projectionId: 'proj-initial-1',
      now: 100,
    });
    expect(listContextObservations({ projectionId: 'proj-initial-1' }).map((r) => r.id)).toEqual([linked.id]);
    expect(listContextObservations({ namespaceIds: [nsRow.id], withoutProjection: true })).toEqual([]);

    const unlinked = writeContextObservation({
      namespaceId: nsRow.id,
      scope: 'personal',
      class: 'note',
      origin: 'user_note',
      fingerprint: 'fp-clear-proj',
      content: { text: 'observation initially linked then unlinked' },
      projectionId: '',
      now: 200,
    });
    expect(unlinked.id).toBe(linked.id);
    expect(listContextObservations({ projectionId: 'proj-initial-1' })).toEqual([]);
    expect(listContextObservations({ namespaceIds: [nsRow.id], withoutProjection: true }).map((r) => r.id)).toEqual([linked.id]);
  });
});
