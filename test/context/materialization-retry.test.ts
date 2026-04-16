import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import { MaterializationCoordinator } from '../../src/context/materialization-coordinator.js';
import type { CompressionInput, CompressionResult } from '../../src/context/summary-compressor.js';
import { buildLocalFallbackSummary } from '../../src/context/summary-compressor.js';
import { listContextEvents, queryProcessedProjections } from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

/**
 * Mock compressor that fails N times then succeeds.
 * Simulates backend recovery after transient downtime.
 */
function makeFailingThenSucceedingCompressor(failCount: number) {
  let callCount = 0;
  return async (input: CompressionInput): Promise<CompressionResult> => {
    callCount++;
    if (callCount <= failCount) {
      return {
        summary: buildLocalFallbackSummary(input.events, input.previousSummary),
        model: 'local-fallback',
        backend: 'none',
        usedBackup: false,
        fromSdk: false,
      };
    }
    return {
      summary: `## User Problem\nTest problem\n\n## Resolution\nSDK-generated structured summary from ${input.events.length} events`,
      model: 'sonnet',
      backend: 'claude-code-sdk',
      usedBackup: false,
      fromSdk: true,
    };
  };
}

describe('MaterializationCoordinator retry behavior', () => {
  let tempDir: string;
  let namespace: ContextNamespace;
  let target: ContextTargetRef;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('materialization-retry');
    namespace = { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' };
    target = { namespace, kind: 'session', sessionName: 'deck_repo_brain' };
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('keeps raw events and marks tentative when SDK compression fails', async () => {
    const coordinator = new MaterializationCoordinator({
      compressor: makeFailingThenSucceedingCompressor(999), // always fail
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });

    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'do stuff', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'done', createdAt: 101 });
    await coordinator.materializeTarget(target, 'manual', 500);

    // Raw events should STILL exist (not deleted)
    const rawEvents = listContextEvents(target);
    expect(rawEvents.length).toBeGreaterThan(0);

    // Projection should be marked tentative
    const projections = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId });
    expect(projections.length).toBe(1);
    expect(projections[0].content.tentative).toBe(true);
    expect(projections[0].content.retryAttempt).toBe(1);
    expect(projections[0].content.compressionFromSdk).toBe(false);
  });

  it('replaces tentative summary with SDK summary when backend recovers', async () => {
    // Use a single compressor instance so callCount persists across materializations
    const compressor = makeFailingThenSucceedingCompressor(2); // fail 2x then succeed
    const coordinator = new MaterializationCoordinator({
      compressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200, minIntervalMs: 0 },
    });

    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'fix the bug', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'fixed it', createdAt: 101 });

    // Attempt 1: fails, tentative stored, raw events kept
    await coordinator.materializeTarget(target, 'manual', 200);
    expect(listContextEvents(target).length).toBeGreaterThan(0);
    let projections = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId });
    expect(projections[0].content.tentative).toBe(true);

    // Attempt 2: still fails — tentative replaced with new tentative
    await coordinator.materializeTarget(target, 'schedule', 300);
    expect(listContextEvents(target).length).toBeGreaterThan(0);
    projections = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId });
    expect(projections.length).toBe(1); // old tentative was replaced, not accumulated
    expect(projections[0].content.retryAttempt).toBe(2);

    // Attempt 3: SDK recovers — commits proper summary, deletes tentative, clears raw events
    await coordinator.materializeTarget(target, 'schedule', 400);
    expect(listContextEvents(target).length).toBe(0); // raw events cleared on commit
    projections = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId });
    expect(projections.length).toBe(1);
    expect(projections[0].content.tentative).toBeFalsy();
    expect(projections[0].content.compressionFromSdk).toBe(true);
    expect(projections[0].summary).toContain('SDK-generated structured summary');
  });

  it('commits local fallback after MAX_SDK_RETRY_ATTEMPTS exhausted', async () => {
    const coordinator = new MaterializationCoordinator({
      compressor: makeFailingThenSucceedingCompressor(999), // always fail
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200, minIntervalMs: 0 },
    });

    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'keep trying', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'ok', createdAt: 101 });

    // Attempt 1, 2, 3 — all fail, tentative
    await coordinator.materializeTarget(target, 'manual', 200);
    await coordinator.materializeTarget(target, 'schedule', 300);
    await coordinator.materializeTarget(target, 'schedule', 400);

    // Raw events still kept
    expect(listContextEvents(target).length).toBeGreaterThan(0);
    let projections = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId });
    expect(projections[0].content.tentative).toBe(true);

    // Attempt 4 — budget exhausted, commit fallback anyway
    await coordinator.materializeTarget(target, 'schedule', 500);
    expect(listContextEvents(target).length).toBe(0); // raw events cleared
    projections = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId });
    expect(projections.length).toBe(1);
    expect(projections[0].content.tentative).toBeFalsy(); // final commit
    expect(projections[0].content.compressionFromSdk).toBe(false); // still fallback
  });
});
