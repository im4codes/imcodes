import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runMock, incrementCounterMock, warnOncePerHourMock } = vi.hoisted(() => ({
  runMock: vi.fn(),
  incrementCounterMock: vi.fn(),
  warnOncePerHourMock: vi.fn(),
}));

vi.mock('../../src/store/context-store-worker-client.js', () => ({
  getContextStoreClient: () => ({ run: runMock }),
}));
vi.mock('../../src/util/metrics.js', () => ({ incrementCounter: incrementCounterMock }));
vi.mock('../../src/util/rate-limited-warn.js', () => ({ warnOncePerHour: warnOncePerHourMock }));

import { registerMemoryShortRefs, resetMemoryShortRefsForTests } from '../../src/context/memory-short-ref.js';

/**
 * The whole point of moving handles off the JSON file was that its write errors
 * were swallowed, so a full disk silently stopped persisting handles and nobody
 * found out until they died on the next restart. Persisting to the store must
 * not reintroduce that: a failed write is still non-fatal for the running
 * process, but it has to be observable.
 */
describe('memory short refs — persistence failures stay observable', () => {
  let priorPath: string | undefined;

  beforeEach(() => {
    priorPath = process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    delete process.env.IMCODES_MEMORY_SHORT_REF_PATH; // select the store path
    vi.clearAllMocks();
    resetMemoryShortRefsForTests();
  });

  afterEach(() => {
    resetMemoryShortRefsForTests();
    if (priorPath === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_PATH = priorPath;
  });

  const entry = {
    kind: 'projection' as const,
    id: 'fb7a7af3-3185-45a4-ac47-b26a57142353',
    namespace: { scope: 'personal' as const, userId: 'user-1', projectId: 'repo-1' },
  };

  it('reports a counter and a rate-limited warning when the store write fails', async () => {
    runMock.mockRejectedValue(new Error('context_store_unavailable'));

    const refs = registerMemoryShortRefs([entry]);
    expect(refs).toHaveLength(1);
    await vi.waitFor(() => expect(incrementCounterMock).toHaveBeenCalled());

    expect(incrementCounterMock).toHaveBeenCalledWith(
      'mem.startup.silent_failure',
      { source: 'memory-short-ref-upsert' },
    );
    expect(warnOncePerHourMock).toHaveBeenCalledWith(
      'mem.startup.silent_failure.memory-short-ref-upsert',
      expect.objectContaining({ error: 'context_store_unavailable' }),
    );
  });

  it('keeps registration non-fatal and in-memory resolution working when the write fails', async () => {
    runMock.mockRejectedValue(new Error('SQLITE_BUSY'));
    // Registration must not throw: the caller is a synchronous render path.
    expect(() => registerMemoryShortRefs([entry])).not.toThrow();
    await vi.waitFor(() => expect(warnOncePerHourMock).toHaveBeenCalled());
  });

  it('stays quiet on a successful write', async () => {
    runMock.mockResolvedValue(1);
    registerMemoryShortRefs([entry]);
    await Promise.resolve();
    await Promise.resolve();
    expect(incrementCounterMock).not.toHaveBeenCalled();
    expect(warnOncePerHourMock).not.toHaveBeenCalled();
  });
});
