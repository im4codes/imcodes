import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';
import { archiveEventsForMaterialization, recordContextEvent, resetContextStoreForTests, writeProcessedProjection, queryProcessedProjections } from '../../src/store/context-store.js';
import { MaterializationCoordinator, materializeMasterSummary } from '../../src/context/materialization-coordinator.js';
import { shouldMaterializeMasterOnSessionStop } from '../../src/agent/session-manager.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

describe('master summary materialization', () => {
  let tempDir: string;
  let namespace: ContextNamespace;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('master-summary');
    namespace = { scope: 'personal', projectId: 'repo', userId: 'user-1' };
  });

  afterEach(async () => {
    resetContextStoreForTests();
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('writes one stable master_summary per session and merges source ids', async () => {
    writeProcessedProjection({ namespace, class: 'recent_summary', sourceEventIds: ['evt-a'], summary: '## User Problem\nA', content: { sessionName: 'deck_repo_brain' }, createdAt: 100, updatedAt: 100 });
    const target = { namespace, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const event = recordContextEvent({ id: 'evt-high', target, eventType: 'user.message', content: 'remember this high signal', createdAt: 110 });
    archiveEventsForMaterialization([event], 120);

    const first = await materializeMasterSummary('deck_repo_brain', namespace, 200);
    expect(first?.class).toBe('master_summary');
    expect(first?.sourceEventIds).toEqual(['evt-a', 'evt-high']);

    writeProcessedProjection({ namespace, class: 'recent_summary', sourceEventIds: ['evt-b'], summary: '## User Problem\nB', content: { sessionName: 'deck_repo_brain' }, createdAt: 300, updatedAt: 300 });
    const second = await materializeMasterSummary('deck_repo_brain', namespace, 400);
    expect(second?.id).toBe(first?.id);
    expect(second?.sourceEventIds).toEqual(['evt-a', 'evt-high', 'evt-b']);
    expect(queryProcessedProjections({ projectionClass: 'master_summary', includeArchived: true, limit: 10 })).toHaveLength(1);
  });

  it('fires idle master summaries after masterIdleHours', async () => {
    writeProcessedProjection({ namespace, class: 'recent_summary', sourceEventIds: ['evt-a'], summary: 'summary', content: { sessionName: 'deck_repo_brain' }, createdAt: 100, updatedAt: 100 });
    const coordinator = new MaterializationCoordinator({ memoryConfig: {
      autoTriggerTokens: 3000,
      minEventCount: 5,
      idleMs: 300_000,
      scheduleMs: 900_000,
      maxBatchTokens: 10_000,
      autoMaterializationTargetTokens: 500,
      manualCompactTargetTokens: 800,
      maxEventChars: 2000,
      previousSummaryMaxTokens: 1000,
      masterIdleHours: 1,
      archiveRetentionDays: -1,
      redactPatterns: [],
      extraRedactPatterns: [],
    } });
    expect(await coordinator.materializeDueMasterSummaries(30 * 60_000)).toHaveLength(0);
    expect(await coordinator.materializeDueMasterSummaries(2 * 60 * 60_000)).toHaveLength(1);
  });

  it('only schedules stop-triggered master summaries for main brain sessions', () => {
    expect(shouldMaterializeMasterOnSessionStop({
      name: 'deck_repo_brain',
      role: 'brain',
      parentSession: undefined,
      contextNamespace: namespace,
    })).toBe(true);
    expect(shouldMaterializeMasterOnSessionStop({
      name: 'deck_sub_worker',
      role: 'brain',
      parentSession: 'deck_repo_brain',
      contextNamespace: namespace,
    })).toBe(false);
    expect(shouldMaterializeMasterOnSessionStop({
      name: 'deck_repo_w1',
      role: 'w1',
      parentSession: undefined,
      contextNamespace: namespace,
    })).toBe(false);
  });
});
