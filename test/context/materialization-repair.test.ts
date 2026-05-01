import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import {
  enqueueContextJob,
  listDirtyTargets,
  queryProcessedProjections,
  recordContextEvent,
  repairMaterializationState,
  updateContextJob,
  writeProcessedProjection,
} from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

describe('materialization state repair', () => {
  let tempDir: string;
  let namespace: ContextNamespace;
  let target: ContextTargetRef;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('materialization-repair');
    namespace = { scope: 'personal', projectId: 'github.com/acme/repo' };
    target = { namespace, kind: 'session', sessionName: 'deck_repo_brain' };
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('resets stale running jobs and clears dirty pending refs that point at failed work', () => {
    recordContextEvent({ id: 'evt-1', target, eventType: 'assistant.text', content: 'done', createdAt: 100 });
    const job = enqueueContextJob(target, 'materialize_session', 'idle', 100);
    updateContextJob(job.id, 'running', { attemptIncrement: true, now: 100 });

    const stats = repairMaterializationState({ now: 100 + 11 * 60_000, staleRunningMs: 10 * 60_000 });

    expect(stats.staleRunningReset).toBe(1);
    expect(stats.dirtyPendingRefsCleared).toBe(1);
    expect(listDirtyTargets(namespace)[0]?.pendingJobId).toBeUndefined();
  });

  it('archives legacy local-fallback pollution so it no longer participates in active recall', () => {
    writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['legacy-event'],
      summary: '## User Problem\nOld summary\n\n--- Updated ---\n\n> ⚠️ **Structured summary unavailable** — AI compression backend is currently offline.',
      content: {
        sessionName: target.sessionName,
        compressionFromSdk: false,
        compressionModel: 'local-fallback',
        compressionBackend: 'none',
      },
      createdAt: 100,
      updatedAt: 100,
    });

    expect(queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId })).toHaveLength(1);
    const stats = repairMaterializationState({ now: 200 });

    expect(stats.pollutedFallbackArchived).toBe(1);
    expect(queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId })).toHaveLength(0);
    const archived = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, includeArchived: true });
    expect(archived).toHaveLength(1);
    expect(archived[0]?.status).toBe('archived');
  });

  it('archives legacy raw transcript projections produced before compression provenance was stored', () => {
    writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['legacy-event'],
      summary: 'tool.result: Total output lines: 240\n\nsrc/index.ts:1: example\nassistant.turn: I checked the logs.',
      content: {
        trigger: 'threshold',
        targetKind: 'session',
        sessionName: target.sessionName,
        eventCount: 12,
      },
      createdAt: 100,
      updatedAt: 100,
    });

    const stats = repairMaterializationState({ now: 200 });

    expect(stats.pollutedFallbackArchived).toBe(1);
    expect(queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId })).toHaveLength(0);
    const archived = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId, includeArchived: true });
    expect(archived[0]?.status).toBe('archived');
  });

  it('prunes old failed materialization jobs with a per-target retention floor', () => {
    recordContextEvent({ id: 'evt-1', target, eventType: 'assistant.text', content: 'done', createdAt: 100 });
    for (let i = 0; i < 8; i++) {
      const job = enqueueContextJob(target, 'materialize_session', 'schedule', 100 + i);
      updateContextJob(job.id, 'materialization_failed', { now: 100 + i, error: `failed-${i}` });
    }

    const stats = repairMaterializationState({
      now: 10_000,
      failedJobsRetainPerTarget: 3,
      failedJobRetentionMs: 60_000,
    });

    expect(stats.failedJobsPruned).toBe(5);
  });
});
