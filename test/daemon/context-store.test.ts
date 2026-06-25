import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import {
  archiveMemory,
  deleteMemory,
  clearDirtyTarget,
  enqueueContextJob,
  ensureContextNamespace,
  estimateStagedTokenUpperBound,
  getLocalProcessedFreshness,
  getProcessedProjectionStats,
  getReplicationState,
  getLatestMasterSummaryUpdatedAt,
  getLatestRecentSummaryUpdatedAtForTarget,
  hasProcessedProjectionsInNamespace,
  listContextEvents,
  listDirtyTargets,
  listLatestRecentSummarySessions,
  listProcessedProjections,
  listStartupContextObservations,
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
  writeContextObservation,
  writeProcessedProjection,
} from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';
import { getCounter, resetMetricsForTests } from '../../src/util/metrics.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

describe('context-store', () => {
  let tempDir: string;
  let namespace: ContextNamespace;
  let target: ContextTargetRef;

  beforeEach(async () => {
    resetMetricsForTests();
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

  it('treats duplicate staged event ids as idempotent without inflating dirty counts or token estimates', () => {
    const stagedId = 'evt-idempotent-duplicate';
    const originalContent = 'first';
    const duplicateContent = 'duplicate content must not inflate the target';

    const first = recordContextEvent({
      id: stagedId,
      target,
      eventType: 'user.turn',
      content: originalContent,
      createdAt: 10,
    });
    const tokenEstimateBeforeDuplicate = estimateStagedTokenUpperBound(target);

    const duplicate = recordContextEvent({
      id: stagedId,
      target,
      eventType: 'assistant.turn',
      content: duplicateContent,
      createdAt: 20,
    });

    expect(duplicate.id).toBe(first.id);
    expect(listContextEvents(target)).toEqual([first]);
    expect(listDirtyTargets(namespace)).toEqual([
      expect.objectContaining({
        target,
        eventCount: 1,
        oldestEventAt: 10,
        newestEventAt: 10,
      }),
    ]);
    expect(estimateStagedTokenUpperBound(target)).toBe(tokenEstimateBeforeDuplicate);
    expect(tokenEstimateBeforeDuplicate).toBe(originalContent.length);
  });

  it('does not flag a duplicate-id mismatch when the replayed event_type and content match', () => {
    const stagedId = 'evt-duplicate-id-match';

    const first = recordContextEvent({
      id: stagedId,
      target,
      eventType: 'user.turn',
      content: 'identical replay payload',
      createdAt: 10,
    });
    const duplicate = recordContextEvent({
      id: stagedId,
      target,
      eventType: 'user.turn',
      content: 'identical replay payload',
      createdAt: 20,
    });

    // Idempotent: first row kept, no double dirty/staged count.
    expect(duplicate.id).toBe(first.id);
    expect(listContextEvents(target)).toEqual([first]);
    expect(listDirtyTargets(namespace)).toEqual([
      expect.objectContaining({ target, eventCount: 1, oldestEventAt: 10, newestEventAt: 10 }),
    ]);
    // Matching replay is a normal idempotent no-op — the mismatch counter must stay at 0.
    expect(getCounter('mem.ingest.duplicate_id_mismatch', { source: 'recordContextEvent' })).toBe(0);
  });

  it('flags a duplicate-id mismatch (metric) when a replayed stable id carries a different event_type or content but stays idempotent', () => {
    const stagedId = 'evt-duplicate-id-mismatch';

    const first = recordContextEvent({
      id: stagedId,
      target,
      eventType: 'user.turn',
      content: 'original payload',
      createdAt: 10,
    });
    const duplicate = recordContextEvent({
      id: stagedId,
      target,
      eventType: 'assistant.turn',
      content: 'conflicting payload for the same stable id',
      createdAt: 20,
    });

    // Still idempotent: first row kept, dirty count NOT double-incremented.
    expect(duplicate.id).toBe(first.id);
    expect(listContextEvents(target)).toEqual([first]);
    expect(listDirtyTargets(namespace)).toEqual([
      expect.objectContaining({ target, eventCount: 1, oldestEventAt: 10, newestEventAt: 10 }),
    ]);
    // Observability: the contract violation is counted exactly once.
    expect(getCounter('mem.ingest.duplicate_id_mismatch', { source: 'recordContextEvent' })).toBe(1);
  });

  it('rolls back the staged insert when the dirty-target upsert fails', () => {
    const seedContent = 'seed';
    const seed = recordContextEvent({
      id: 'evt-rollback-seed',
      target,
      eventType: 'user.turn',
      content: seedContent,
      createdAt: 10,
    });
    expect(listDirtyTargets(namespace)[0]).toEqual(expect.objectContaining({ eventCount: 1 }));

    const dbPath = process.env.IMCODES_CONTEXT_DB_PATH;
    expect(dbPath).toBeTruthy();
    const sqlite = new DatabaseSync(dbPath!);
    try {
      sqlite.exec(`
        CREATE TRIGGER context_dirty_targets_injected_update_failure
        BEFORE UPDATE ON context_dirty_targets
        BEGIN
          SELECT RAISE(ABORT, 'injected dirty-target upsert failure');
        END;
      `);
    } finally {
      sqlite.close();
    }

    try {
      expect(() => recordContextEvent({
        id: 'evt-rollback-current',
        target,
        eventType: 'assistant.turn',
        content: 'insert should be rolled back',
        createdAt: 20,
      })).toThrow(/injected dirty-target upsert failure/);

      expect(listContextEvents(target)).toEqual([seed]);
      expect(listDirtyTargets(namespace)).toEqual([
        expect.objectContaining({
          target,
          eventCount: 1,
          oldestEventAt: 10,
          newestEventAt: 10,
        }),
      ]);
      expect(estimateStagedTokenUpperBound(target)).toBe(seedContent.length);
    } finally {
      const cleanup = new DatabaseSync(dbPath!);
      try {
        cleanup.exec('DROP TRIGGER IF EXISTS context_dirty_targets_injected_update_failure');
      } finally {
        cleanup.close();
      }
    }
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

  it('estimates staged token upper bound without hydrating staged event rows', () => {
    recordContextEvent({ target, eventType: 'user.turn', content: 'hello', createdAt: 10 });
    recordContextEvent({ target, eventType: 'assistant.turn', content: 'world!', createdAt: 20 });

    expect(estimateStagedTokenUpperBound(target)).toBe(11);
    expect(estimateStagedTokenUpperBound({ namespace, kind: 'session', sessionName: 'deck_repo_other' })).toBe(0);
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

  it('checks namespace processed activity without hydrating projection rows', () => {
    expect(hasProcessedProjectionsInNamespace(namespace)).toBe(false);
    writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-noise'],
      summary: '[API Error: Connection error. (cause: fetch failed)]',
      content: {},
      createdAt: 5,
      updatedAt: 5,
    });
    expect(hasProcessedProjectionsInNamespace(namespace)).toBe(false);
    writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-1'],
      summary: 'summary',
      content: {},
      createdAt: 10,
      updatedAt: 10,
    });
    expect(hasProcessedProjectionsInNamespace(namespace)).toBe(true);
    expect(hasProcessedProjectionsInNamespace({ scope: 'personal', projectId: 'other', userId: 'user-1' })).toBe(false);
  });

  it('lists startup observations with SQL-side namespace/state filters', () => {
    const allowed = ensureContextNamespace({
      scope: 'user_private',
      projectId: namespace.projectId,
      userId: namespace.userId,
    }, 100);
    const other = ensureContextNamespace({
      scope: 'user_private',
      projectId: 'other',
      userId: namespace.userId,
    }, 100);
    const active = writeContextObservation({
      namespaceId: allowed.id,
      scope: 'user_private',
      class: 'note',
      origin: 'agent_learned',
      fingerprint: 'active-startup',
      content: { text: 'active startup observation' },
      text: 'active startup observation',
      state: 'active',
      now: 300,
    });
    const promoted = writeContextObservation({
      namespaceId: allowed.id,
      scope: 'user_private',
      class: 'decision',
      origin: 'user_note',
      fingerprint: 'promoted-startup',
      content: { text: 'promoted startup observation' },
      text: 'promoted startup observation',
      state: 'promoted',
      now: 250,
    });
    writeContextObservation({
      namespaceId: allowed.id,
      scope: 'user_private',
      class: 'note',
      origin: 'agent_learned',
      fingerprint: 'candidate-startup',
      content: { text: 'candidate startup observation' },
      text: 'candidate startup observation',
      state: 'candidate',
      now: 400,
    });
    writeContextObservation({
      namespaceId: allowed.id,
      scope: 'user_private',
      class: 'skill_candidate',
      origin: 'agent_learned',
      fingerprint: 'skill-startup',
      content: { text: 'skill startup observation' },
      text: 'skill startup observation',
      state: 'active',
      now: 350,
    });
    const otherObservation = writeContextObservation({
      namespaceId: other.id,
      scope: 'user_private',
      class: 'note',
      origin: 'agent_learned',
      fingerprint: 'other-startup',
      content: { text: 'other namespace startup observation' },
      text: 'other namespace startup observation',
      state: 'active',
      now: 500,
    });

    expect(listStartupContextObservations([allowed.id], 10).map((row) => row.id)).toEqual([active.id, promoted.id]);
    expect(listStartupContextObservations([allowed.id, other.id], 1).map((row) => row.id)).toEqual([otherObservation.id]);
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

  it('requires explicit legacy personal owner compatibility for owner-filtered management reads', () => {
    const now = Date.now();
    writeProcessedProjection({
      namespace: { scope: 'personal', projectId: 'repo' },
      class: 'recent_summary',
      sourceEventIds: ['legacy-proj'],
      summary: 'Legacy local personal memory',
      content: {},
      createdAt: now - 10,
      updatedAt: now,
    });
    writeProcessedProjection({
      namespace: { scope: 'personal', projectId: 'repo', userId: 'user-2' },
      class: 'recent_summary',
      sourceEventIds: ['other-user-proj'],
      summary: 'Other user personal memory',
      content: {},
      createdAt: now - 5,
      updatedAt: now,
    });
    recordContextEvent({
      target: { namespace: { scope: 'personal', projectId: 'repo' }, kind: 'session', sessionName: 'legacy-session' },
      eventType: 'user.turn',
      content: 'Legacy pending local event',
      createdAt: now,
    });

    expect(queryProcessedProjections({ scope: 'personal', projectId: 'repo', userId: 'user-1' })).toEqual([]);
    expect(getProcessedProjectionStats({ scope: 'personal', projectId: 'repo', userId: 'user-1' }).totalRecords).toBe(0);
    expect(queryPendingContextEvents({ scope: 'personal', projectId: 'repo', userId: 'user-1' })).toEqual([]);

    const compatibleRecords = queryProcessedProjections({
      scope: 'personal',
      projectId: 'repo',
      userId: 'user-1',
      includeLegacyPersonalOwner: true,
    });
    expect(compatibleRecords).toEqual([
      expect.objectContaining({ summary: 'Legacy local personal memory' }),
    ]);
    expect(getProcessedProjectionStats({
      scope: 'personal',
      projectId: 'repo',
      userId: 'user-1',
      includeLegacyPersonalOwner: true,
    })).toMatchObject({
      totalRecords: 1,
      matchedRecords: 1,
      projectCount: 1,
      stagedEventCount: 1,
    });
    expect(queryPendingContextEvents({
      scope: 'personal',
      projectId: 'repo',
      userId: 'user-1',
      includeLegacyPersonalOwner: true,
    })).toEqual([
      expect.objectContaining({ content: 'Legacy pending local event' }),
    ]);
    expect(queryProcessedProjections({
      projectId: 'repo',
      userId: 'user-1',
      includeLegacyPersonalOwner: true,
    })).toEqual([
      expect.objectContaining({ summary: 'Legacy local personal memory' }),
    ]);
  });

  it('does not treat an empty owner filter as an all-user memory query', () => {
    writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-user'],
      summary: 'User-owned summary',
      content: {},
      createdAt: 1,
      updatedAt: 2,
    });

    expect(queryProcessedProjections({ scope: 'personal', userId: '' })).toEqual([]);
    expect(getProcessedProjectionStats({ scope: 'personal', userId: '' }).totalRecords).toBe(0);
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

    it('finds the latest recent summary timestamp for a specific materialization target', () => {
      writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-other'],
        summary: 'Other session summary',
        content: { targetKind: 'session', sessionName: 'deck_repo_other' },
        createdAt: 100,
        updatedAt: 500,
      });
      writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-target-old'],
        summary: 'Old target summary',
        content: { targetKind: 'session', sessionName: 'deck_repo_brain' },
        createdAt: 100,
        updatedAt: 200,
      });
      writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-target-new'],
        summary: 'New target summary',
        content: { targetKind: 'session', sessionName: 'deck_repo_brain' },
        createdAt: 100,
        updatedAt: 300,
      });

      expect(getLatestRecentSummaryUpdatedAtForTarget(target)).toBe(300);
      expect(getLatestRecentSummaryUpdatedAtForTarget({
        namespace,
        kind: 'project',
      })).toBeUndefined();
    });

    it('lists latest recent-summary sessions without hydrating projection contents', () => {
      writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-old'],
        summary: 'Old session summary',
        content: { sessionName: 'deck_repo_brain' },
        createdAt: 100,
        updatedAt: 100,
      });
      writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-new'],
        summary: 'New session summary',
        content: { sessionName: 'deck_repo_brain' },
        createdAt: 200,
        updatedAt: 200,
      });
      writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-noise'],
        summary: '[API Error: Connection error. (cause: fetch failed)]',
        content: { sessionName: 'deck_repo_brain' },
        createdAt: 250,
        updatedAt: 250,
      });
      writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-other'],
        summary: 'Other session summary',
        content: { sessionName: 'deck_repo_other' },
        createdAt: 300,
        updatedAt: 300,
      });
      writeProcessedProjection({
        namespace,
        class: 'master_summary',
        sourceEventIds: ['evt-master'],
        summary: 'Master summary',
        content: { sessionName: 'deck_repo_brain' },
        createdAt: 400,
        updatedAt: 400,
      });
      writeProcessedProjection({
        namespace,
        class: 'master_summary',
        sourceEventIds: ['evt-master-noise'],
        summary: '[API Error: Connection error. (cause: fetch failed)]',
        content: { sessionName: 'deck_repo_other' },
        createdAt: 500,
        updatedAt: 500,
      });

      expect(listLatestRecentSummarySessions(10).map((item) => ({
        sessionName: item.sessionName,
        updatedAt: item.updatedAt,
      }))).toEqual([
        { sessionName: 'deck_repo_other', updatedAt: 300 },
        { sessionName: 'deck_repo_brain', updatedAt: 200 },
      ]);
      expect(getLatestMasterSummaryUpdatedAt('deck_repo_brain', namespace)).toBe(400);
      expect(getLatestMasterSummaryUpdatedAt('deck_repo_other', namespace)).toBeUndefined();
      expect(getLatestMasterSummaryUpdatedAt('deck_repo_missing', namespace)).toBeUndefined();
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
    it('stores namespace filter columns and indexes management query paths', () => {
      const event = recordContextEvent({ target, eventType: 'user.turn', content: 'pending', createdAt: 10 });
      const job = enqueueContextJob(target, 'materialize_session', 'threshold', 20);
      const projection = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['source-1'],
        summary: 'indexed projection',
        content: {},
        createdAt: 30,
        updatedAt: 40,
      });

      const dbPath = process.env.IMCODES_CONTEXT_DB_PATH;
      expect(dbPath).toBeTruthy();
      const sqlite = new DatabaseSync(dbPath!);
      try {
        const indexNames = (table: string): string[] =>
          (sqlite.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ name: string }>).map((row) => String(row.name));

        expect(indexNames('context_processed_local')).toEqual(expect.arrayContaining([
          'idx_context_processed_local_scope_project',
          'idx_context_processed_local_scope_owner_project',
          'idx_context_processed_local_project',
        ]));
        expect(indexNames('context_staged_events')).toEqual(expect.arrayContaining([
          'idx_context_staged_events_scope_project',
          'idx_context_staged_events_scope_owner_project',
          'idx_context_staged_events_project_created',
          'idx_context_staged_events_namespace_created',
        ]));
        expect(indexNames('context_dirty_targets')).toEqual(expect.arrayContaining([
          'idx_context_dirty_targets_scope_project',
          'idx_context_dirty_targets_scope_owner_project',
          'idx_context_dirty_targets_project_newest',
          'idx_context_dirty_targets_namespace_newest',
        ]));
        expect(indexNames('context_jobs')).toEqual(expect.arrayContaining([
          'idx_context_jobs_status_scope_project',
          'idx_context_jobs_status_scope_owner_project',
          'idx_context_jobs_status_project_created',
          'idx_context_jobs_namespace_status_created',
        ]));

        expect(sqlite.prepare('SELECT scope, user_id, project_id FROM context_processed_local WHERE id = ?').get(projection.id)).toEqual({
          scope: 'personal',
          user_id: 'user-1',
          project_id: 'repo',
        });
        expect(sqlite.prepare('SELECT scope, user_id, project_id FROM context_staged_events WHERE id = ?').get(event.id)).toEqual({
          scope: 'personal',
          user_id: 'user-1',
          project_id: 'repo',
        });
        expect(sqlite.prepare('SELECT scope, user_id, project_id FROM context_jobs WHERE id = ?').get(job.id)).toEqual({
          scope: 'personal',
          user_id: 'user-1',
          project_id: 'repo',
        });
        expect(sqlite.prepare('SELECT scope, user_id, project_id FROM context_dirty_targets WHERE pending_job_id = ?').get(job.id)).toEqual({
          scope: 'personal',
          user_id: 'user-1',
          project_id: 'repo',
        });
      } finally {
        sqlite.close();
      }
    });

    it('backfills namespace filter columns for existing local rows', () => {
      recordContextEvent({ target, eventType: 'user.turn', content: 'legacy pending', createdAt: 10 });
      const job = enqueueContextJob(target, 'materialize_session', 'threshold', 20);
      const projection = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['legacy-source'],
        summary: 'legacy indexed projection',
        content: {},
        createdAt: 30,
        updatedAt: 40,
      });

      const dbPath = process.env.IMCODES_CONTEXT_DB_PATH;
      expect(dbPath).toBeTruthy();
      const sqlite = new DatabaseSync(dbPath!);
      try {
        sqlite.exec(`
          UPDATE context_processed_local SET scope = NULL, enterprise_id = NULL, workspace_id = NULL, user_id = NULL, project_id = NULL;
          UPDATE context_staged_events SET scope = NULL, enterprise_id = NULL, workspace_id = NULL, user_id = NULL, project_id = NULL;
          UPDATE context_dirty_targets SET scope = NULL, enterprise_id = NULL, workspace_id = NULL, user_id = NULL, project_id = NULL;
          UPDATE context_jobs SET scope = NULL, enterprise_id = NULL, workspace_id = NULL, user_id = NULL, project_id = NULL;
        `);
      } finally {
        sqlite.close();
      }

      resetContextStoreForTests();

      expect(getProcessedProjectionStats({ scope: 'personal', userId: 'user-1', projectId: 'repo' })).toMatchObject({
        totalRecords: 1,
        stagedEventCount: 1,
        dirtyTargetCount: 1,
        pendingJobCount: 1,
      });
      expect(queryProcessedProjections({ scope: 'personal', userId: 'user-1', projectId: 'repo' })).toHaveLength(1);
      expect(queryPendingContextEvents({ scope: 'personal', userId: 'user-1', projectId: 'repo' })).toHaveLength(1);

      const sqliteAfter = new DatabaseSync(dbPath!);
      try {
        expect(sqliteAfter.prepare('SELECT scope, user_id, project_id FROM context_processed_local WHERE id = ?').get(projection.id)).toEqual({
          scope: 'personal',
          user_id: 'user-1',
          project_id: 'repo',
        });
        expect(sqliteAfter.prepare('SELECT scope, user_id, project_id FROM context_jobs WHERE id = ?').get(job.id)).toEqual({
          scope: 'personal',
          user_id: 'user-1',
          project_id: 'repo',
        });
      } finally {
        sqliteAfter.close();
      }
    });

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
