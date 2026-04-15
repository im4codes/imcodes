import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import {
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
  recordContextEvent,
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

    expect(listProcessedProjections(namespace, 'recent_summary')).toEqual([projection]);
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

  it('clears dirty targets after materialization cleanup', () => {
    recordContextEvent({ target, eventType: 'user.turn', createdAt: 10 });
    expect(listDirtyTargets(namespace)).toHaveLength(1);
    clearDirtyTarget(target);
    expect(listDirtyTargets(namespace)).toHaveLength(0);
  });
});
