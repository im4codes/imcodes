import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runMock, incrementCounterMock, warnOncePerHourMock, writeFileSyncMock, mkdirSyncMock } = vi.hoisted(() => ({
  runMock: vi.fn(),
  incrementCounterMock: vi.fn(),
  warnOncePerHourMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
}));

// The production-route test below strips VITEST/NODE_ENV so it exercises the
// real routing. Should the routing regress, the file branch would reactivate and
// write to the runner's actual home directory — a red test must never touch a
// developer's real data, and the true-negative procedure for this file would
// trigger exactly that. Stub the writes so the failure state is hermetic, which
// also lets the test assert positively that no file was written.
vi.mock('node:fs', () => ({
  writeFileSync: writeFileSyncMock,
  mkdirSync: mkdirSyncMock,
  readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
}));

vi.mock('../../src/store/context-store-worker-client.js', () => ({
  getContextStoreClient: () => ({ run: runMock }),
}));
vi.mock('../../src/util/metrics.js', () => ({ incrementCounter: incrementCounterMock }));
vi.mock('../../src/util/rate-limited-warn.js', () => ({ warnOncePerHour: warnOncePerHourMock }));

import {
  getMemoryShortRefHealth,
  registerMemoryShortRefs,
  resetMemoryShortRefsForTests,
  resolveMemoryShortRef,
} from '../../src/context/memory-short-ref.js';

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
      'mem.short_ref.persist_failure',
      { stage: 'persist_store' },
    );
    expect(warnOncePerHourMock).toHaveBeenCalledWith(
      'mem.short_ref.persist_failure.persist_store',
      expect.objectContaining({ error: 'context_store_unavailable' }),
    );
  });

  it('routes a production process to the store, not a JSON file', async () => {
    // Regression: the path resolver returned ~/.imcodes/memory-short-refs.json
    // for any process that wasn't a test, which inverted the routing — real
    // daemons kept writing the JSON file while only tests exercised the store,
    // so the migration and its failure reporting never ran where they mattered.
    //
    // The ambient VITEST flag makes a plain assertion here useless: it sends the
    // OLD code down the store branch too, and the test passes either way. Drop
    // the test markers so this exercises the real production route.
    const priorVitest = process.env.VITEST;
    const priorNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    process.env.NODE_ENV = 'production';
    try {
      runMock.mockResolvedValue(1);
      registerMemoryShortRefs([entry]);
      await vi.waitFor(() => expect(runMock).toHaveBeenCalled());
      expect(runMock).toHaveBeenCalledWith('upsertMemoryShortRefs', [
        expect.arrayContaining([expect.objectContaining({ id: entry.id, kind: 'projection' })]),
      ], { timeoutMs: 30_000 });
      // The file branch must stay dormant without an explicit path override.
      expect(writeFileSyncMock).not.toHaveBeenCalled();
    } finally {
      if (priorVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = priorVitest;
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  });

  it('keeps registration non-fatal and in-memory resolution working when the write fails', async () => {
    runMock.mockRejectedValue(new Error('SQLITE_BUSY'));
    // Registration must not throw: the caller is a synchronous render path.
    let refs: string[] = [];
    expect(() => { refs = registerMemoryShortRefs([entry]); }).not.toThrow();
    await vi.waitFor(() => expect(warnOncePerHourMock).toHaveBeenCalled());
    // The unpersisted handle still resolves for the life of this process.
    expect(resolveMemoryShortRef(refs[0]!, entry.namespace)).toMatchObject({ id: entry.id });
  });

  it('clears a file-write alert after the complete cache is written successfully', () => {
    process.env.IMCODES_MEMORY_SHORT_REF_PATH = '/tmp/imcodes-short-ref-health-test.json';
    writeFileSyncMock
      .mockImplementationOnce(() => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); })
      .mockImplementationOnce(() => undefined);

    registerMemoryShortRefs([entry]);
    expect(getMemoryShortRefHealth()).toMatchObject({ stage: 'persist_file' });

    registerMemoryShortRefs([{ ...entry, id: 'file-recovery-row' }]);
    expect(getMemoryShortRefHealth()).toBeUndefined();
  });

  it('reports a failed warm-load instead of returning an ambiguous zero', async () => {
    // A warm-load failure leaves every handle issued before this restart
    // unresolvable for the whole process, and `0` alone is indistinguishable
    // from "nothing was stored".
    runMock.mockRejectedValue(new Error('context_store_unavailable'));
    const { loadMemoryShortRefsFromStore } = await import('../../src/context/memory-short-ref.js');

    await expect(loadMemoryShortRefsFromStore()).resolves.toBe(0);
    expect(runMock).toHaveBeenCalledWith(
      'listMemoryShortRefs',
      [expect.any(Number)],
      { timeoutMs: 30_000 },
    );
    expect(incrementCounterMock).toHaveBeenCalledWith(
      'mem.short_ref.persist_failure',
      { stage: 'warm_load' },
    );
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
