import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import {
  archiveMemory,
  deleteMemory,
  clearDirtyTarget,
  enqueueContextJob,
  getLocalProcessedFreshness,
  getProcessedProjectionStats,
  getReplicationState,
  listContextEvents,
  listDirtyTargets,
  listProcessedProjections,
  queryPendingContextEvents,
  queryProcessedProjections,
  removeMemoryNoiseProjections,
  recordContextEvent,
  recordMemoryHits,
  resetContextStoreForTests,
  restoreArchivedMemory,
  deleteStagedEventsByIds,
  setReplicationState,
  updateContextJob,
  writeProcessedProjection,
} from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

describe('context-store', () => {
  let tempDir: string;
  let namespace: ContextNamespace;
  let target: ContextTargetRef;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('context-store');
    namespace = { scope: 'personal', projectId: 'repo', userId: 'user-1' };
    target = { namespace, kind: 'session', sessionName: 'deck_repo_brain' };
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('records staged events and coalesces dirty targets', () => {
    const event1 = recordContextEvent({ target, eventType: 'user.turn', content: 'first', createdAt: 10 });
    const event2 = recordContextEvent({ target, eventType: 'assistant.turn', content: 'second', createdAt: 20 });

    expect(listContextEvents(target)).toEqual([event1, event2]);
    expect(listDirtyTargets(namespace)).toEqual([
      expect.objectContaining({
        target,
        eventCount: 2,
        oldestEventAt: 10,
        newestEventAt: 20,
      }),
    ]);
  });

  it('dedupes pending jobs per target/job type and tracks triggers', () => {
    recordContextEvent({ target, eventType: 'user.turn', createdAt: 10 });
    const first = enqueueContextJob(target, 'materialize_session', 'threshold', 30);
    const second = enqueueContextJob(target, 'materialize_session', 'idle', 40);
    updateContextJob(first.id, 'running', { attemptIncrement: true, now: 50 });

    expect(second.id).toBe(first.id);
    expect(listDirtyTargets(namespace)[0]).toEqual(expect.objectContaining({
      pendingJobId: first.id,
      lastTrigger: 'idle',
    }));
  });

  it('stores processed projections and replication state', () => {
    const now = Date.now();
    const projection = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-1'],
      summary: 'summary',
      content: { foo: 'bar' },
      createdAt: now - 10,
      updatedAt: now,
    });
    setReplicationState(namespace, {
      pendingProjectionIds: [projection.id],
      lastReplicatedAt: 100,
    });

    expect(listProcessedProjections(namespace, 'recent_summary')).toEqual([{
      ...projection,
      hitCount: 0,
      lastUsedAt: undefined,
      status: 'active',
    }]);
    expect(getReplicationState(namespace)).toEqual({
      namespace,
      pendingProjectionIds: [projection.id],
      lastReplicatedAt: 100,
      lastError: undefined,
    });
    expect(getLocalProcessedFreshness(namespace)).toBe('stale');
  });

  it('reports stale local processed freshness when the latest projection is older than the freshness cutoff', () => {
    const now = Date.now();
    writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-1'],
      summary: 'summary',
      content: { foo: 'bar' },
      createdAt: now - 8 * 60 * 60 * 1000,
      updatedAt: now - 7 * 60 * 60 * 1000,
    });

    expect(getLocalProcessedFreshness(namespace, now)).toBe('stale');
  });

  it('reports missing local processed freshness when no projections exist', () => {
    expect(getLocalProcessedFreshness(namespace)).toBe('missing');
  });

  it('queries processed projections and reports hit stats for personal memory views', () => {
    const now = Date.now();
    writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-1', 'evt-2'],
      summary: 'Repository summary',
      content: { note: 'Discuss deployment checklist' },
      createdAt: now - 20,
      updatedAt: now - 10,
    });
    writeProcessedProjection({
      namespace,
      class: 'durable_memory_candidate',
      sourceEventIds: ['evt-3'],
      summary: 'Keep rollback playbook',
      content: { category: 'operations' },
      createdAt: now - 5,
      updatedAt: now,
    });
    writeProcessedProjection({
      namespace: { scope: 'personal', projectId: 'repo-2', userId: 'user-1' },
      class: 'recent_summary',
      sourceEventIds: ['evt-4'],
      summary: 'Other project summary',
      content: { note: 'Should not match repo filter' },
      createdAt: now - 2,
      updatedAt: now - 1,
    });

    const records = queryProcessedProjections({
      scope: 'personal',
      projectId: 'repo',
      query: 'rollback',
      limit: 10,
    });
    expect(records).toEqual([
      expect.objectContaining({
        summary: 'Keep rollback playbook',
        class: 'durable_memory_candidate',
      }),
    ]);

    expect(getProcessedProjectionStats({
      scope: 'personal',
      projectId: 'repo',
      query: 'summary',
    })).toEqual({
      totalRecords: 2,
      matchedRecords: 1,
      recentSummaryCount: 1,
      durableCandidateCount: 1,
      projectCount: 1,
      stagedEventCount: 0,
      dirtyTargetCount: 0,
      pendingJobCount: 0,
    });
  });

  it('queries pending staged events separately from processed memory', () => {
    recordContextEvent({ target, eventType: 'user.turn', content: 'raw pending question', createdAt: 10 });
    recordContextEvent({ target, eventType: 'assistant.turn', content: 'raw pending answer', createdAt: 20 });

    expect(queryPendingContextEvents({ scope: 'personal', projectId: 'repo', limit: 10 })).toEqual([
      expect.objectContaining({
        eventType: 'assistant.turn',
        content: 'raw pending answer',
        projectId: 'repo',
      }),
      expect.objectContaining({
        eventType: 'user.turn',
        content: 'raw pending question',
        projectId: 'repo',
      }),
    ]);
  });

  it('removes staged events once they have been materialized', () => {
    const first = recordContextEvent({ target, eventType: 'user.turn', content: 'question', createdAt: 10 });
    const second = recordContextEvent({ target, eventType: 'assistant.turn', content: 'answer', createdAt: 20 });

    deleteStagedEventsByIds([first.id, second.id]);

    expect(queryPendingContextEvents({ scope: 'personal', projectId: 'repo', limit: 10 })).toEqual([]);
  });


  it('removes legacy API error memories from the local database', () => {
    const clean = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-1'],
      summary: 'Useful summary',
      content: {},
      createdAt: 10,
      updatedAt: 10,
    });
    const noisy = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-2'],
      summary: '**Assistant:** [API Error: Connection error. (cause: fetch failed)]',
      content: {},
      createdAt: 20,
      updatedAt: 20,
    });
    setReplicationState(namespace, {
      pendingProjectionIds: [clean.id, noisy.id],
      lastReplicatedAt: 0,
    });

    expect(removeMemoryNoiseProjections()).toBeLessThanOrEqual(1);
    expect(listProcessedProjections(namespace).map((row) => row.id)).toEqual([clean.id]);
    expect(getReplicationState(namespace)?.pendingProjectionIds).toEqual([clean.id]);
  });

  it('reconciles stale staged events that were already referenced by processed projections', () => {
    const first = recordContextEvent({ target, eventType: 'user.turn', content: 'question', createdAt: 10 });
    const second = recordContextEvent({ target, eventType: 'assistant.turn', content: 'answer', createdAt: 20 });
    writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: [first.id, second.id],
      summary: 'summary',
      content: {},
      createdAt: 30,
      updatedAt: 30,
    });

    resetContextStoreForTests();

    expect(queryPendingContextEvents({ scope: 'personal', projectId: 'repo', limit: 10 })).toEqual([]);
  });

  it('clears dirty targets after materialization cleanup', () => {
    recordContextEvent({ target, eventType: 'user.turn', createdAt: 10 });
    expect(listDirtyTargets(namespace)).toHaveLength(1);
    clearDirtyTarget(target);
    expect(listDirtyTargets(namespace)).toHaveLength(0);
  });

  // ── Memory hit tracking ──────────────────────────────────────────────────

  describe('Memory hit tracking', () => {
    it('recordMemoryHits increments hit_count and sets last_used_at', () => {
      const now = Date.now();
      const projection = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-1'],
        summary: 'Test summary',
        content: {},
        createdAt: now - 100,
        updatedAt: now,
      });

      recordMemoryHits([projection.id]);

      const results = listProcessedProjections(namespace, 'recent_summary');
      expect(results).toHaveLength(1);
      expect(results[0].hitCount).toBe(1);
      expect(results[0].lastUsedAt).toBeTypeOf('number');
      expect(results[0].lastUsedAt).toBeGreaterThanOrEqual(now);
    });

    it('recordMemoryHits handles multiple IDs in one call', () => {
      const now = Date.now();
      const p1 = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-1'],
        summary: 'First',
        content: {},
        createdAt: now - 100,
        updatedAt: now,
      });
      const p2 = writeProcessedProjection({
        namespace,
        class: 'durable_memory_candidate',
        sourceEventIds: ['evt-2'],
        summary: 'Second',
        content: {},
        createdAt: now - 50,
        updatedAt: now,
      });

      recordMemoryHits([p1.id, p2.id]);

      const all = listProcessedProjections(namespace);
      const map = new Map(all.map((p) => [p.id, p]));
      expect(map.get(p1.id)!.hitCount).toBe(1);
      expect(map.get(p2.id)!.hitCount).toBe(1);
    });

    it('recordMemoryHits is idempotent on repeated calls (increments each time)', () => {
      const now = Date.now();
      const projection = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-1'],
        summary: 'Repeated hits',
        content: {},
        createdAt: now - 100,
        updatedAt: now,
      });

      recordMemoryHits([projection.id]);
      recordMemoryHits([projection.id]);
      recordMemoryHits([projection.id]);

      const results = listProcessedProjections(namespace, 'recent_summary');
      expect(results).toHaveLength(1);
      expect(results[0].hitCount).toBe(3);
    });

    it('archiveMemory sets status to archived', () => {
      const now = Date.now();
      const projection = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-1'],
        summary: 'To archive',
        content: {},
        createdAt: now - 100,
        updatedAt: now,
      });

      const result = archiveMemory(projection.id);
      expect(result).toBe(true);

      const all = listProcessedProjections(namespace);
      expect(all).toHaveLength(1);
      expect(all[0].status).toBe('archived');
    });

    it('archiveMemory returns false for already-archived item', () => {
      const now = Date.now();
      const projection = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-1'],
        summary: 'Already archived',
        content: {},
        createdAt: now - 100,
        updatedAt: now,
      });

      expect(archiveMemory(projection.id)).toBe(true);
      expect(archiveMemory(projection.id)).toBe(false);
    });


    it('deleteMemory removes a processed projection permanently', () => {
      const now = Date.now();
      const projection = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-1'],
        summary: 'Delete me',
        content: {},
        createdAt: now - 100,
        updatedAt: now,
      });

      expect(deleteMemory(projection.id)).toBe(true);
      expect(queryProcessedProjections({ projectId: namespace.projectId, includeArchived: true })).toHaveLength(0);
      expect(deleteMemory(projection.id)).toBe(false);
    });

    it('deleteMemory removes pending replication ids for the deleted projection', () => {
      const projection = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-1'],
        summary: 'Delete and unschedule replication',
        content: {},
      });
      setReplicationState(namespace, {
        pendingProjectionIds: [projection.id, 'keep-me'],
        lastReplicatedAt: 123,
        lastError: 'none',
      });

      expect(deleteMemory(projection.id)).toBe(true);
      expect(getReplicationState(namespace)).toEqual({
        namespace,
        pendingProjectionIds: ['keep-me'],
        lastReplicatedAt: 123,
        lastError: 'none',
      });
    });

    it('queryProcessedProjections excludes archived by default', () => {
      const now = Date.now();
      const active = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-1'],
        summary: 'Active projection',
        content: {},
        createdAt: now - 100,
        updatedAt: now,
      });
      const toArchive = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-2'],
        summary: 'Archived projection',
        content: {},
        createdAt: now - 50,
        updatedAt: now,
      });

      archiveMemory(toArchive.id);

      const results = queryProcessedProjections({
        scope: 'personal',
        projectId: 'repo',
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(active.id);
    });

    it('queryProcessedProjections includes archived when includeArchived is true', () => {
      const now = Date.now();
      writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-1'],
        summary: 'Active projection',
        content: {},
        createdAt: now - 100,
        updatedAt: now,
      });
      const toArchive = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-2'],
        summary: 'Archived projection',
        content: {},
        createdAt: now - 50,
        updatedAt: now,
      });

      archiveMemory(toArchive.id);

      const results = queryProcessedProjections({
        scope: 'personal',
        projectId: 'repo',
        includeArchived: true,
      });
      expect(results).toHaveLength(2);
      const statuses = results.map((r) => r.status);
      expect(statuses).toContain('active');
      expect(statuses).toContain('archived');
    });
  });

  describe('SQLite schema — H.2 migration columns', () => {
    it('context_processed_local has hit_count column with default 0', () => {
      const projection = writeProcessedProjection({
        namespace, class: 'recent_summary',
        sourceEventIds: ['e1'], summary: 'schema test', content: {},
      });
      const rows = queryProcessedProjections({ projectId: namespace.projectId });
      const row = rows.find((r) => r.id === projection.id);
      expect(row).toBeDefined();
      expect(row!.hitCount).toBe(0);
    });

    it('context_processed_local has last_used_at column (null by default)', () => {
      const projection = writeProcessedProjection({
        namespace, class: 'recent_summary',
        sourceEventIds: ['e2'], summary: 'last_used_at test', content: {},
      });
      const rows = queryProcessedProjections({ projectId: namespace.projectId });
      const row = rows.find((r) => r.id === projection.id);
      expect(row).toBeDefined();
      expect(row!.lastUsedAt).toBeUndefined(); // null maps to undefined
    });

    it('context_processed_local has status column with default active', () => {
      const projection = writeProcessedProjection({
        namespace, class: 'recent_summary',
        sourceEventIds: ['e3'], summary: 'status test', content: {},
      });
      const rows = queryProcessedProjections({ projectId: namespace.projectId });
      const row = rows.find((r) => r.id === projection.id);
      expect(row).toBeDefined();
      expect(row!.status).toBe('active');
    });

    it('hit_count and last_used_at are updated by recordMemoryHits', () => {
      const projection = writeProcessedProjection({
        namespace, class: 'recent_summary',
        sourceEventIds: ['e4'], summary: 'roundtrip test', content: {},
      });
      recordMemoryHits([projection.id]);
      const rows = queryProcessedProjections({ projectId: namespace.projectId });
      const row = rows.find((r) => r.id === projection.id);
      expect(row!.hitCount).toBe(1);
      expect(row!.lastUsedAt).toBeGreaterThan(0);
    });

    it('status column survives archive + restore roundtrip', () => {
      const projection = writeProcessedProjection({
        namespace, class: 'recent_summary',
        sourceEventIds: ['e5'], summary: 'archive roundtrip', content: {},
      });
      archiveMemory(projection.id);
      // Archived — excluded from default query
      const afterArchive = queryProcessedProjections({ projectId: namespace.projectId });
      expect(afterArchive.find((r) => r.id === projection.id)).toBeUndefined();

      restoreArchivedMemory(projection.id);
      // Restored — visible again
      const afterRestore = queryProcessedProjections({ projectId: namespace.projectId });
      const restored = afterRestore.find((r) => r.id === projection.id);
      expect(restored).toBeDefined();
      expect(restored!.status).toBe('active');
    });
  });
});
