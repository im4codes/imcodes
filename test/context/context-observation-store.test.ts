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
  writeContextObservation,
  writeProcessedProjection,
} from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

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
      }),
    ]);
    expect(projection.origin).toBe('chat_compacted');
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
});
