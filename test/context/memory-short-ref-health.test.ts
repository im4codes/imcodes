import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runMock, incrementCounterMock, warnOncePerHourMock } = vi.hoisted(() => ({
  runMock: vi.fn(),
  incrementCounterMock: vi.fn(),
  warnOncePerHourMock: vi.fn(),
}));

// Both existing signals are stubbed out entirely: the point is that the failure
// is still reportable when neither of them can carry it. The counter is a
// process-local map that a restart clears, and the throttled warning ends up in
// the daemon log — on the same disk whose exhaustion is the failure being
// reported, with write errors swallowed.
vi.mock('../../src/store/context-store-worker-client.js', () => ({
  getContextStoreClient: () => ({ run: runMock }),
}));
vi.mock('../../src/util/metrics.js', () => ({ incrementCounter: incrementCounterMock }));
vi.mock('../../src/util/rate-limited-warn.js', () => ({ warnOncePerHour: warnOncePerHourMock }));

import {
  getMemoryShortRefHealth,
  loadMemoryShortRefsFromStore,
  registerMemoryShortRefs,
  resetMemoryShortRefsForTests,
} from '../../src/context/memory-short-ref.js';

describe('memory short refs — persistence failure leaves the process', () => {
  let priorPath: string | undefined;
  let priorLegacy: string | undefined;

  beforeEach(() => {
    priorPath = process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    priorLegacy = process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH;
    delete process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH = '/nonexistent/imcodes-test/legacy.json';
    vi.clearAllMocks();
    resetMemoryShortRefsForTests();
  });

  afterEach(() => {
    resetMemoryShortRefsForTests();
    if (priorPath === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_PATH = priorPath;
    if (priorLegacy === undefined) delete process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH;
    else process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH = priorLegacy;
  });

  const entry = {
    kind: 'projection' as const,
    id: 'fb7a7af3-3185-45a4-ac47-b26a57142353',
    namespace: { scope: 'personal' as const, userId: 'u1', projectId: 'p1' },
  };

  it('reports nothing while persistence is healthy', async () => {
    runMock.mockResolvedValue(1);
    registerMemoryShortRefs([entry]);
    await vi.waitFor(() => expect(runMock).toHaveBeenCalled());
    expect(getMemoryShortRefHealth()).toBeUndefined();
  });

  it('exposes a disk-full write failure through a channel that is neither the store nor the log', async () => {
    runMock.mockRejectedValue(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));

    registerMemoryShortRefs([entry]);
    await vi.waitFor(() => expect(getMemoryShortRefHealth()).toBeDefined());

    expect(getMemoryShortRefHealth()).toMatchObject({
      stage: 'persist_store',
      failures: 1,
      lastError: expect.stringContaining('ENOSPC'),
    });
    expect(getMemoryShortRefHealth()!.lastFailureAt).toBeGreaterThan(0);
  });

  it('stays set after the failure so a later reader still sees it', async () => {
    vi.useFakeTimers();
    try {
      // Sticky while unresolved: whoever reconnects after the incident has to
      // be able to learn that handles stopped persisting.
      runMock.mockRejectedValue(new Error('ENOSPC: no space left on device'));
      registerMemoryShortRefs([entry]);
      await vi.waitFor(() => expect(getMemoryShortRefHealth()).toBeDefined());

      // Any number of later reads report the same standing failure.
      expect(getMemoryShortRefHealth()).toBeDefined();
      expect(getMemoryShortRefHealth()).toBeDefined();

      // A retry failure accumulates rather than resetting, so a stuck disk is
      // distinguishable from a single blip.
      registerMemoryShortRefs([{ ...entry, id: 'second-id' }]);
      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => expect(getMemoryShortRefHealth()!.failures).toBeGreaterThan(1));
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries failed rows and clears the heartbeat only after they are durable', async () => {
    vi.useFakeTimers();
    try {
      runMock
        .mockRejectedValueOnce(new Error('context-store worker unavailable for op: upsertMemoryShortRefs'))
        .mockResolvedValueOnce(1);

      registerMemoryShortRefs([entry]);
      await vi.waitFor(() => expect(getMemoryShortRefHealth()).toMatchObject({ stage: 'persist_store' }));
      const queuedWhileDown = { ...entry, id: 'queued-while-worker-down' };
      registerMemoryShortRefs([queuedWhileDown]);

      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(2));

      expect(runMock.mock.calls[1]).toEqual([
        'upsertMemoryShortRefs',
        [expect.arrayContaining([
          expect.objectContaining({ id: entry.id }),
          expect.objectContaining({ id: queuedWhileDown.id }),
        ])],
      ]);
      expect(getMemoryShortRefHealth()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed warm-load too, not only writes', async () => {
    runMock.mockRejectedValue(new Error('context_store_unavailable'));
    await loadMemoryShortRefsFromStore();
    expect(getMemoryShortRefHealth()).toMatchObject({ stage: 'warm_load' });
  });
  it('reports discarded rows too, since those handles are lost the same way', async () => {
    // A row dropped as unusable means that memory is no longer reachable by
    // handle after a restart — the same loss as a failed write, so it belongs on
    // the same off-box signal rather than only in machine-local counters.
    runMock.mockImplementation(async (op: string) => (op === 'listMemoryShortRefs'
      ? [{ ref: 'proj:aaaaaaaaaaaaa', kind: 'projection', id: 'x', namespaceKey: '', namespaceJson: '{bad', lastSeenAt: 1 }]
      : 1));

    await loadMemoryShortRefsFromStore();
    expect(getMemoryShortRefHealth()).toMatchObject({ stage: 'discarded_warm_load' });
  });
});
