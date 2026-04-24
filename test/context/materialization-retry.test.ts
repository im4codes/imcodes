import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import { MaterializationCoordinator } from '../../src/context/materialization-coordinator.js';
import type { CompressionInput, CompressionResult } from '../../src/context/summary-compressor.js';
import { buildLocalFallbackSummary } from '../../src/context/summary-compressor.js';
import { listContextEvents, queryProcessedProjections } from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

/**
 * Mock compressor that fails N times then succeeds.
 * Simulates backend recovery after transient downtime. On failure the mock
 * returns the same fallback summary shape the real compressor would — but
 * the coordinator under test is expected to DISCARD that text and not
 * persist any projection for fromSdk: false results.
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

  it('keeps raw events and writes NO projection when SDK compression fails', async () => {
    const coordinator = new MaterializationCoordinator({
      compressor: makeFailingThenSucceedingCompressor(999), // always fail
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });

    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'do stuff', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'done', createdAt: 101 });
    await coordinator.materializeTarget(target, 'manual', 500);

    // Raw events should STILL exist (kept for retry)
    const rawEvents = listContextEvents(target);
    expect(rawEvents.length).toBeGreaterThan(0);

    // No projection should have been written — the "⚠️ backend offline"
    // fallback text must never reach the memory store.
    const projections = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId });
    expect(projections.length).toBe(0);
  });

  it('leaves no polluted projections during retry, commits only the real SDK summary on recovery', async () => {
    // Use a single compressor instance so callCount persists across materializations
    const compressor = makeFailingThenSucceedingCompressor(2); // fail 2x then succeed
    const coordinator = new MaterializationCoordinator({
      compressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200, minIntervalMs: 0 },
    });

    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'fix the bug', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'fixed it', createdAt: 101 });

    // Attempt 1: fails — no projection written, raw events kept
    await coordinator.materializeTarget(target, 'manual', 200);
    expect(listContextEvents(target).length).toBeGreaterThan(0);
    let projections = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId });
    expect(projections.length).toBe(0);

    // Attempt 2: still fails — still no projection, raw events still kept
    await coordinator.materializeTarget(target, 'schedule', 300);
    expect(listContextEvents(target).length).toBeGreaterThan(0);
    projections = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId });
    expect(projections.length).toBe(0);

    // Attempt 3: SDK recovers — commits the real summary, clears raw events
    await coordinator.materializeTarget(target, 'schedule', 400);
    expect(listContextEvents(target).length).toBe(0); // raw events cleared on commit
    projections = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId });
    expect(projections.length).toBe(1);
    expect(projections[0].content.compressionFromSdk).toBe(true);
    expect(projections[0].summary).toContain('SDK-generated structured summary');
    // Fallback warning must never appear in the committed summary.
    expect(projections[0].summary).not.toContain('Structured summary unavailable');
  });

  it('abandons the batch after MAX_SDK_RETRY_ATTEMPTS without writing a fallback projection', async () => {
    const coordinator = new MaterializationCoordinator({
      compressor: makeFailingThenSucceedingCompressor(999), // always fail
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200, minIntervalMs: 0 },
    });

    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'keep trying', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'ok', createdAt: 101 });

    // Attempts 1, 2, 3 — all fail. No projection ever written.
    await coordinator.materializeTarget(target, 'manual', 200);
    await coordinator.materializeTarget(target, 'schedule', 300);
    await coordinator.materializeTarget(target, 'schedule', 400);

    expect(listContextEvents(target).length).toBeGreaterThan(0);
    let projections = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId });
    expect(projections.length).toBe(0);

    // Attempt 4 — budget exhausted: raw events are cleared (prevent unbounded
    // growth), but STILL no projection is written. The memory store keeps its
    // pre-existing state (empty in this test) and a "gap" simply exists for
    // the abandoned batch.
    await coordinator.materializeTarget(target, 'schedule', 500);
    expect(listContextEvents(target).length).toBe(0);
    projections = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId });
    expect(projections.length).toBe(0);
  });

  it('preserves the prior real SDK summary when a later batch is abandoned', async () => {
    // First batch: one successful SDK call → a real summary is committed.
    let forceFail = false;
    const compressor = async (input: CompressionInput): Promise<CompressionResult> => {
      if (forceFail) {
        return {
          summary: buildLocalFallbackSummary(input.events, input.previousSummary),
          model: 'local-fallback',
          backend: 'none',
          usedBackup: false,
          fromSdk: false,
        };
      }
      return {
        summary: `## User Problem\nFirst batch\n\n## Resolution\nReal summary from ${input.events.length} events`,
        model: 'sonnet',
        backend: 'claude-code-sdk',
        usedBackup: false,
        fromSdk: true,
      };
    };

    const coordinator = new MaterializationCoordinator({
      compressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200, minIntervalMs: 0 },
    });

    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'first ask', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'first reply', createdAt: 101 });
    await coordinator.materializeTarget(target, 'manual', 200);

    let projections = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId });
    expect(projections.length).toBe(1);
    expect(projections[0].summary).toContain('Real summary');

    // Second batch: backend goes down for good. Run through the whole retry
    // budget + abandonment.
    forceFail = true;
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'second ask', createdAt: 300 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'second reply', createdAt: 301 });
    await coordinator.materializeTarget(target, 'manual', 400);
    await coordinator.materializeTarget(target, 'schedule', 500);
    await coordinator.materializeTarget(target, 'schedule', 600);
    await coordinator.materializeTarget(target, 'schedule', 700); // budget exhausted → abandon

    // The ORIGINAL real summary from batch 1 must still be the only projection.
    projections = queryProcessedProjections({ scope: 'personal', projectId: namespace.projectId });
    expect(projections.length).toBe(1);
    expect(projections[0].summary).toContain('Real summary');
    expect(projections[0].summary).not.toContain('Structured summary unavailable');
    expect(listContextEvents(target).length).toBe(0); // second-batch events discarded
  });
});
