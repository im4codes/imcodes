import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  drainMasterCompactions,
  getInflightMasterCompactionCount,
  isAcceptingMasterCompactions,
  registerMasterCompaction,
  resetMasterCompactionRegistryForTests,
  resumeAcceptingMasterCompactions,
  stopAcceptingMasterCompactions,
} from '../../src/daemon/master-compaction-registry.js';

describe('master compaction registry', () => {
  afterEach(() => {
    resetMasterCompactionRegistryForTests();
    vi.useRealTimers();
  });

  it('tracks registered master compactions until they settle', async () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    const tracked = registerMasterCompaction(() => promise, { sessionName: 'deck_repo_brain', namespaceKey: 'personal::::::user-1::repo' });

    expect(tracked.skipped).toBe(false);
    expect(getInflightMasterCompactionCount()).toBe(1);
    resolve();
    if (!tracked.skipped) await tracked.promise;
    expect(getInflightMasterCompactionCount()).toBe(0);
  });

  it('bounded drain reports remaining work on timeout', async () => {
    vi.useFakeTimers();
    registerMasterCompaction(() => new Promise(() => {}), { sessionName: 'deck_repo_brain' });
    const drain = drainMasterCompactions(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(drain).resolves.toMatchObject({
      snapshotCount: 1,
      drained: 0,
      remainingFromSnapshot: 1,
      registeredDuringDrain: 0,
      timedOut: true,
    });
  });

  it('can stop accepting new work during shutdown', () => {
    expect(isAcceptingMasterCompactions()).toBe(true);
    stopAcceptingMasterCompactions('test-reset');
    expect(isAcceptingMasterCompactions()).toBe(false);
  });

  it('does not start master compaction work after admission is closed', () => {
    const factory = vi.fn(async () => {});
    stopAcceptingMasterCompactions('shutdown');

    const result = registerMasterCompaction(factory, { sessionName: 'deck_repo_brain' });

    expect(result).toEqual({ skipped: true, reason: 'shutdown' });
    expect(factory).not.toHaveBeenCalled();
    expect(getInflightMasterCompactionCount()).toBe(0);
  });

  it('resumes accepting work after a reversible freeze', async () => {
    stopAcceptingMasterCompactions('upgrade-pending');
    expect(registerMasterCompaction(async () => {}, { sessionName: 'deck_repo_brain' })).toEqual({
      skipped: true,
      reason: 'upgrade-pending',
    });

    resumeAcceptingMasterCompactions();
    const result = registerMasterCompaction(async () => {}, { sessionName: 'deck_repo_brain' });
    expect(result.skipped).toBe(false);
    if (!result.skipped) await result.promise;
  });

  it('reports registrations that occur during a drain snapshot', async () => {
    let resolveFirst!: () => void;
    const first = new Promise<void>((r) => { resolveFirst = r; });
    const registered = registerMasterCompaction(() => first, { sessionName: 'deck_repo_brain' });
    expect(registered.skipped).toBe(false);

    const drain = drainMasterCompactions(5000);
    registerMasterCompaction(() => new Promise(() => {}), { sessionName: 'deck_repo_other' });
    resolveFirst();

    await expect(drain).resolves.toMatchObject({
      snapshotCount: 1,
      drained: 1,
      remainingFromSnapshot: 0,
      registeredDuringDrain: 1,
      timedOut: false,
    });
  });
});
