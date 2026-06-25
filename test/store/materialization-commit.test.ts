import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace, ContextTargetRef, LocalContextEvent } from '../../shared/context-types.js';
import {
  commitMaterialization,
  recordContextEvent,
  enqueueContextJob,
  listContextEvents,
  listArchivedEventsForTarget,
  queryProcessedProjections,
  getReplicationState,
} from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

const NAMESPACE: ContextNamespace = { scope: 'personal', projectId: 'repo', userId: 'user-1' };
const TARGET: ContextTargetRef = { namespace: NAMESPACE, kind: 'session', sessionName: 'deck_repo_brain' };
const PROJ_FILTER = { scope: 'personal' as const, projectId: 'repo', userId: 'user-1', limit: 50 };

describe('commitMaterialization (atomic bundle)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('materialization-commit');
  });
  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  function stage(): { events: LocalContextEvent[]; ids: string[] } {
    const e1 = recordContextEvent({ target: TARGET, eventType: 'user.turn', content: 'fix the flaky build' });
    const e2 = recordContextEvent({ target: TARGET, eventType: 'assistant.text', content: 'updated the import and reran' });
    return { events: [e1, e2], ids: [e1.id, e2.id] };
  }

  it('commits the whole bundle together (archive + projection + delete staged + replication + complete job)', () => {
    const { events, ids } = stage();
    const job = enqueueContextJob(TARGET, 'materialize_session', 'manual');
    const now = 1000;

    const result = commitMaterialization({
      archiveEvents: events,
      archivedAt: now,
      summaryProjection: {
        namespace: NAMESPACE,
        class: 'recent_summary',
        origin: 'chat_compacted',
        sourceEventIds: ids,
        summary: 'Fixed the flaky build',
        content: { trigger: 'manual' },
        createdAt: now,
        updatedAt: now,
      },
      durableProjection: undefined,
      replication: { namespace: NAMESPACE, priorPendingProjectionIds: [] },
      deleteStagedEventIds: ids,
      completeJobId: job.id,
      completedAt: now,
      clearDirty: TARGET,
    });

    expect(result.summaryProjection.id).toBeTruthy();
    // staged events deleted
    expect(listContextEvents(TARGET)).toEqual([]);
    // events archived
    expect(listArchivedEventsForTarget(TARGET).map((e) => e.id).sort()).toEqual([...ids].sort());
    // projection written
    expect(queryProcessedProjections(PROJ_FILTER).map((p) => p.id)).toContain(result.summaryProjection.id);
    // replication queued with the freshly-written id
    expect(getReplicationState(NAMESPACE)?.pendingProjectionIds ?? []).toContain(result.summaryProjection.id);
  });

  it('rolls back the ENTIRE bundle on a mid-bundle failure — no duplicate projection, no lost staged events', () => {
    const { events, ids } = stage();
    const job = enqueueContextJob(TARGET, 'materialize_session', 'manual');
    const now = 1000;

    // Force a failure AFTER the archive step but before completion: a circular
    // `content` makes the projection write's `JSON.stringify` throw INSIDE the
    // transaction (a deterministic stand-in for a crash between archive and
    // delete-staged).
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() =>
      commitMaterialization({
        archiveEvents: events,
        archivedAt: now,
        summaryProjection: {
          namespace: NAMESPACE,
          class: 'recent_summary',
          origin: 'chat_compacted',
          sourceEventIds: ids,
          summary: 'Would fail mid-bundle',
          content: circular,
          createdAt: now,
          updatedAt: now,
        },
        durableProjection: undefined,
        replication: { namespace: NAMESPACE, priorPendingProjectionIds: [] },
        deleteStagedEventIds: ids,
        completeJobId: job.id,
        completedAt: now,
        clearDirty: TARGET,
      }),
    ).toThrow();

    // Atomic rollback: archive undone, staged events preserved, NO projection,
    // NO replication state — so the target re-materializes cleanly on restart
    // without duplicating or losing anything.
    expect(listArchivedEventsForTarget(TARGET)).toEqual([]);
    expect(listContextEvents(TARGET).map((e) => e.id).sort()).toEqual([...ids].sort());
    expect(queryProcessedProjections(PROJ_FILTER)).toEqual([]);
    expect(getReplicationState(NAMESPACE)?.pendingProjectionIds ?? []).toEqual([]);
  });

  it('writes the durable candidate atomically with the summary when provided', () => {
    const { events, ids } = stage();
    const job = enqueueContextJob(TARGET, 'materialize_session', 'manual');
    const now = 1000;

    const result = commitMaterialization({
      archiveEvents: events,
      archivedAt: now,
      summaryProjection: {
        namespace: NAMESPACE, class: 'recent_summary', origin: 'chat_compacted', sourceEventIds: ids,
        summary: 'Summary', content: {}, createdAt: now, updatedAt: now,
      },
      durableProjection: {
        namespace: NAMESPACE, class: 'durable_memory_candidate', origin: 'agent_learned', sourceEventIds: ids,
        summary: 'Durable decision: prefer X', content: { count: 1 }, createdAt: now, updatedAt: now,
      },
      replication: { namespace: NAMESPACE, priorPendingProjectionIds: [] },
      deleteStagedEventIds: ids,
      completeJobId: job.id,
      completedAt: now,
      clearDirty: TARGET,
    });

    expect(result.durableProjection?.id).toBeTruthy();
    const pending = getReplicationState(NAMESPACE)?.pendingProjectionIds ?? [];
    expect(pending).toContain(result.summaryProjection.id);
    expect(pending).toContain(result.durableProjection!.id);
  });
});
