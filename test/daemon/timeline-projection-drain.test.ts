/**
 * Tests for `TimelineProjectionClient.drain(timeoutMs)` (PR-A C5).
 *
 * T9 — `drain` waits for in-flight worker requests to settle without
 *      rejecting them, returning early on full drain or on `timeoutMs`
 *      with a warn log. Unlike `shutdown`, the worker stays alive.
 *
 * Implementation note: we exercise drain by injecting synthetic
 * entries into the private `pending` map (and resolving them
 * externally). This isolates the drain semantics from the real
 * worker_threads / SQLite dependency.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/util/logger.js', () => ({
  default: loggerMocks,
}));

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

type ProjectionInternals = {
  pending: Map<number, PendingEntry>;
};

describe('timeline-projection drain (T9)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T9a: drain resolves immediately when no requests are in flight', async () => {
    const { timelineProjection } = await import('../../src/daemon/timeline-projection.js');
    expect(timelineProjection.getPendingCount()).toBe(0);

    const start = Date.now();
    await timelineProjection.drain(1_000);
    expect(Date.now() - start).toBeLessThan(50);
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });

  it('T9b: drain waits for pending requests to settle (no early timeout, no warn)', async () => {
    const { timelineProjection } = await import('../../src/daemon/timeline-projection.js');
    const internals = timelineProjection as unknown as ProjectionInternals;

    // Inject two synthetic in-flight requests.
    let resolveA: (value: unknown) => void = () => {};
    let resolveB: (value: unknown) => void = () => {};
    internals.pending.set(1001, { resolve: (v) => { resolveA(v); }, reject: () => {} });
    internals.pending.set(1002, { resolve: (v) => { resolveB(v); }, reject: () => {} });
    expect(timelineProjection.getPendingCount()).toBe(2);

    const drainPromise = timelineProjection.drain(5_000);
    let drainSettled = false;
    drainPromise.then(() => { drainSettled = true; });

    await new Promise((r) => setTimeout(r, 50));
    expect(drainSettled).toBe(false);

    // Simulate worker responses by removing entries from the map (the real
    // handleWorkerMessage path does this).
    internals.pending.delete(1001);
    internals.pending.delete(1002);
    resolveA(undefined);
    resolveB(undefined);

    await drainPromise;
    expect(timelineProjection.getPendingCount()).toBe(0);
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });

  it('T9c: drain returns after timeout and logs warn when requests remain', async () => {
    const { timelineProjection } = await import('../../src/daemon/timeline-projection.js');
    const internals = timelineProjection as unknown as ProjectionInternals;

    internals.pending.set(2001, { resolve: () => {}, reject: () => {} });
    expect(timelineProjection.getPendingCount()).toBe(1);

    const start = Date.now();
    await timelineProjection.drain(100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(95);
    expect(elapsed).toBeLessThan(400);

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingCount: 1,
        timeoutMs: 100,
      }),
      'TimelineProjection: drain timed out',
    );

    // Drain did NOT reject the pending entry — clean up for next test.
    internals.pending.delete(2001);
  });

  it('T9d: drain does not terminate the worker (unlike shutdown)', async () => {
    const { timelineProjection } = await import('../../src/daemon/timeline-projection.js');
    const internals = timelineProjection as unknown as ProjectionInternals & { worker: unknown };

    // No pending — drain returns immediately and worker state is unchanged.
    const workerBefore = internals.worker;
    await timelineProjection.drain(100);
    const workerAfter = internals.worker;
    expect(workerAfter).toBe(workerBefore);
  });
});
