import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A projection worker that accepts requests and never answers.
 *
 * This is the saturated shape, not a crashed one: the thread is alive, the
 * request is delivered, and the reply simply does not arrive inside the query
 * timeout. That distinction is the whole point -- a crash is durable and a
 * stall is momentary, and only the durable case may send work to the main
 * thread.
 */
class SilentWorker {
  unref(): void {}
  on(): this { return this; }
  postMessage(): void { /* deliberately never replies */ }
  terminate(): Promise<number> { return Promise.resolve(0); }
}

vi.mock('node:worker_threads', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  Worker: SilentWorker,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('timeline projection client: saturation is not absence', () => {
  afterEach(() => {
    vi.resetModules();
    vi.useRealTimers();
  });

  it('raises TimelineProjectionBusyError instead of returning null when the worker stalls', async () => {
    // Returning null here is what made the incident possible: callers read null
    // as "there is no projection", and the documented response to that is to run
    // the heavy read, synthesize and sanitize on the main event loop. Under load
    // that converts a slow worker into a blocked daemon.
    const { timelineProjection, TimelineProjectionBusyError } =
      await import('../../src/daemon/timeline-projection.js');

    const query = timelineProjection.queryByTypes({
      sessionId: 'deck_saturated_brain',
      types: ['assistant.text'],
      limit: 10,
    });

    await expect(query).rejects.toBeInstanceOf(TimelineProjectionBusyError);
  }, 15_000);

  it('still returns null when there is genuinely no worker to ask', async () => {
    // The by-design absence path must survive: with no worker at all there is
    // nothing to wait for, so null (and the main-thread fallback it licenses)
    // remains correct.
    vi.resetModules();
    vi.doMock('node:worker_threads', async (importOriginal) => ({
      ...(await importOriginal() as Record<string, unknown>),
      Worker: class {
        constructor() { throw new Error('worker unavailable in this environment'); }
      },
    }));
    const { timelineProjection } = await import('../../src/daemon/timeline-projection.js');
    await expect(timelineProjection.queryByTypes({
      sessionId: 'deck_no_worker',
      types: ['assistant.text'],
      limit: 10,
    })).resolves.toBeNull();
  }, 15_000);
});
