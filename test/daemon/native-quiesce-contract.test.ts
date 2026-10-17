import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contract tests for the upgrade quiesce seam.
 *
 * These drive the REAL exported functions, not a model. They never run the
 * production upgrade path, which spawns processes and mutates the global npm
 * install — that is why the ordering is asserted at this seam instead.
 *
 * The fault being guarded is a SIGBUS: the detached upgrade replaces
 * node_datachannel.node in place while this process still has it mapped, the
 * daemon restarts, and shutdown finally calls into the addon — by which time
 * the pages behind that mapping belong to a different file.
 */
const cleanupCalls = { count: 0 };
const cleanupThrows = { value: false };

vi.mock('node-datachannel', () => ({
  cleanup: () => {
    if (cleanupThrows.value) throw new Error('native cleanup failed');
    cleanupCalls.count += 1;
  },
  initLogger: () => {},
  PeerConnection: class { close() {} },
}));

async function freshModule() {
  vi.resetModules();
  cleanupCalls.count = 0;
  cleanupThrows.value = false;
  // The addon, `leases` and cleanup() all live in the worker isolate now, so
  // this contract is exercised where it is actually implemented. `vi.mock`
  // cannot reach across a thread boundary, and a test that pretended otherwise
  // would be asserting against a mock nothing under test ever calls.
  return import('../../src/daemon/direct-file-transfer-worker.js');
}

beforeEach(() => { cleanupCalls.count = 0; cleanupThrows.value = false; });
afterEach(() => { vi.restoreAllMocks(); });

describe('native quiesce contract', () => {
  it('a timed-out drain keeps running, and a retry joins it instead of cleaning up', async () => {
    const mod = await freshModule();
    expect(await mod.initializeDirectFileTransfer()).toBe(true);

    // A PRODUCTION-SHAPED lease with a live transfer whose writeChain never
    // settles. Real closeLease removes it from `leases` first, then blocks in
    // closeTransferResources — so the drain is stuck AFTER removal and BEFORE
    // the addon calls that follow. That is the exact window the fix guards.
    const blocked = mod.__installBlockedLeaseForTests();
    expect(blocked, 'test seam required to hold a real lease open').not.toBeNull();

    const first = await mod.quiesceDirectFileTransferNative(20);
    expect(first.ok, 'a drain that times out must fail closed').toBe(false);
    expect(first.reason).toBe('quiesce_drain_timeout');
    expect(cleanupCalls.count, 'a failed drain must not clean up the addon').toBe(0);
    expect(
      blocked!.nativeCallsAfterDrain(),
      'the drain is still parked before its addon calls',
    ).toBe(0);

    // The dangerous case. `leases` is already empty because the first attempt
    // removed the entry before blocking, so an implementation that re-snapshots
    // the map sees zero leases, races nothing, and reports success — cleaning up
    // and authorizing replacement while those addon calls are still pending.
    const second = await mod.quiesceDirectFileTransferNative(20);
    expect(
      second.ok,
      'a retry must join the unresolved drain, not succeed on an emptied map',
    ).toBe(false);
    expect(second.reason).toBe('quiesce_drain_timeout');
    expect(cleanupCalls.count, 'no cleanup while the real drain is unresolved').toBe(0);
    expect(blocked!.nativeCallsAfterDrain()).toBe(0);

    // Release the block: the retained drain now completes for real.
    blocked!.release();
    const third = await mod.quiesceDirectFileTransferNative(1_000);
    expect(third.ok, 'once the real drain completes, quiescence is proven').toBe(true);
    expect(third.closedLeases, 'the retained lease count survives the timeouts').toBe(1);
    expect(
      blocked!.nativeCallsAfterDrain(),
      'the addon calls the drain owed must have run before cleanup',
    ).toBe(2);
    expect(cleanupCalls.count, 'exactly one cleanup across all three attempts').toBe(1);
  });

  it('fails closed when native cleanup throws', async () => {
    const mod = await freshModule();
    expect(await mod.initializeDirectFileTransfer()).toBe(true);
    cleanupThrows.value = true;

    const result = await mod.quiesceDirectFileTransferNative();
    expect(
      result.ok,
      'a cleanup that threw leaves the old mapping possibly callable; replacement must not be authorized',
    ).toBe(false);

    // And a retry must still attempt it rather than report success.
    cleanupThrows.value = false;
    const retry = await mod.quiesceDirectFileTransferNative();
    expect(retry.ok, 'once cleanup succeeds the quiesce completes').toBe(true);
    expect(cleanupCalls.count, 'the retry must actually reach the addon').toBeGreaterThanOrEqual(1);
  });

  it('concurrent quiesce callers observe the same real outcome', async () => {
    const mod = await freshModule();
    expect(await mod.initializeDirectFileTransfer()).toBe(true);
    const [a, b] = await Promise.all([
      mod.quiesceDirectFileTransferNative(),
      mod.quiesceDirectFileTransferNative(),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(cleanupCalls.count, 'still exactly once under concurrency').toBe(1);
  });

  it('closes admission and cleans the addon exactly once', async () => {
    const mod = await freshModule();
    expect(await mod.initializeDirectFileTransfer()).toBe(true);
    expect(mod.isDirectFileTransferAvailable()).toBe(true);
    expect(mod.isDirectTransferNativeQuiesced()).toBe(false);

    const ack = await mod.quiesceDirectFileTransferNative();
    expect(ack.ok, 'an idle runtime must quiesce cleanly').toBe(true);

    // Admission must be closed, so nothing new can reach the addon.
    expect(mod.isDirectTransferNativeQuiesced()).toBe(true);
    expect(
      mod.isDirectFileTransferAvailable(),
      'a quiesced runtime must report unavailable so callers fall back to relay',
    ).toBe(false);
    expect(cleanupCalls.count, 'cleanup must run while the addon file is still the original').toBe(1);
  });

  it('does not re-enter the addon when SIGTERM shutdown follows an upgrade quiesce', async () => {
    const mod = await freshModule();
    expect(await mod.initializeDirectFileTransfer()).toBe(true);
    await mod.quiesceDirectFileTransferNative();
    expect(cleanupCalls.count).toBe(1);

    // By now the upgrade may have replaced the file on disk. The shutdown path
    // must NOT call into it a second time — that call is the fault site.
    await mod.shutdownDirectFileTransfers();
    expect(
      cleanupCalls.count,
      'SIGTERM after a quiesce must not enter a possibly-replaced mapping',
    ).toBe(1);
  });

  it('is idempotent across repeated quiesce calls', async () => {
    const mod = await freshModule();
    expect(await mod.initializeDirectFileTransfer()).toBe(true);
    await mod.quiesceDirectFileTransferNative();
    await mod.quiesceDirectFileTransferNative();
    expect(cleanupCalls.count, 'a second quiesce must be a no-op, not a second cleanup').toBe(1);
  });

  it('cleans up exactly once when two shutdowns race', async () => {
    const mod = await freshModule();
    expect(await mod.initializeDirectFileTransfer()).toBe(true);

    // The serial case is already covered by `rtc = null`, so it cannot show
    // whether the once-guard is load-bearing. Concurrency can: both callers
    // await the lease drain and would otherwise observe a non-null runtime
    // before either of them clears it, and cleanup on a replaced mapping is
    // exactly the fault this exists to prevent.
    await Promise.all([
      mod.shutdownDirectFileTransfers(),
      mod.shutdownDirectFileTransfers(),
    ]);
    expect(
      cleanupCalls.count,
      'concurrent shutdowns must not both enter the addon',
    ).toBe(1);
  });

  it('still cleans up exactly once when only shutdown runs (no upgrade)', async () => {
    const mod = await freshModule();
    expect(await mod.initializeDirectFileTransfer()).toBe(true);
    await mod.shutdownDirectFileTransfers();
    await mod.shutdownDirectFileTransfers();
    expect(
      cleanupCalls.count,
      'the ordinary shutdown path must remain exactly-once as well',
    ).toBe(1);
  });
});
