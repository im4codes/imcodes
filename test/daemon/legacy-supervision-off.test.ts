/**
 * The legacy supervision periodic passes are OFF by default (shared/legacy-supervision.ts): with the switch off the daemon schedules and runs
 * none of them -- no watchdog timer, no lifecycle convergence / audit re-dispatch tick, no per-heartbeat legacy re-import -- and with it on
 * they run as before. The suite's setup turns the switch on for the legacy tests; this file controls it per test.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_SUPERVISION_PERIODIC_DEFAULT_ENABLED,
  LEGACY_SUPERVISION_PERIODIC_ENV,
  isLegacySupervisionPeriodicEnabled,
} from '../../shared/legacy-supervision.js';

const importLegacyTasks = vi.hoisted(() => vi.fn(() => 0));
const dispatchTick = vi.hoisted(() => vi.fn(async () => ({ converged: [], audits: [] })));
vi.mock('../../src/daemon/task-pairs/legacy-import.js', () => ({ importLegacyTasks }));

const previous = process.env[LEGACY_SUPERVISION_PERIODIC_ENV];
function setSwitch(value: string | undefined): void {
  if (value === undefined) delete process.env[LEGACY_SUPERVISION_PERIODIC_ENV];
  else process.env[LEGACY_SUPERVISION_PERIODIC_ENV] = value;
}

// The daemon modules are large; the first import of each pays the transform. Warm them once so no test's budget is spent on it.
beforeAll(async () => {
  await import('../../src/daemon/send-tool.js');
  await import('../../src/daemon/supervision-automation.js');
  await import('../../src/daemon/task-pairs/scheduler.js');
}, 120_000);
beforeEach(() => { importLegacyTasks.mockClear(); dispatchTick.mockClear(); });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock('../../src/daemon/send-tool.js');
  vi.resetModules();
  setSwitch(previous);
});

describe('the switch', () => {
  it('is off unless asked for, accepts the usual spellings, and ignores anything else', () => {
    expect(LEGACY_SUPERVISION_PERIODIC_DEFAULT_ENABLED).toBe(false);
    expect(isLegacySupervisionPeriodicEnabled({})).toBe(false);
    for (const on of ['1', 'true', 'ON', ' yes ']) expect(isLegacySupervisionPeriodicEnabled({ [LEGACY_SUPERVISION_PERIODIC_ENV]: on })).toBe(true);
    for (const off of ['0', 'false', 'off', 'no', '', 'maybe']) expect(isLegacySupervisionPeriodicEnabled({ [LEGACY_SUPERVISION_PERIODIC_ENV]: off })).toBe(false);
  });
});

describe('the implementation watchdog', () => {
  async function initAutomation() {
    vi.resetModules();
    // The watchdog hands the audit re-dispatch to the send tool's tick; a stub keeps this test from running the real one in the background.
    vi.doMock('../../src/daemon/send-tool.js', () => ({ runSupervisionConvergenceTick: dispatchTick }));
    const registryModule = await import('../../src/daemon/supervision-state-store.js');
    const list = vi.spyOn(registryModule.SupervisionTaskRegistry.prototype, 'list');
    const converge = vi.spyOn(registryModule.SupervisionTaskRegistry.prototype, 'convergeLifecycle');
    const housekeeping = vi.spyOn(registryModule.SupervisionTaskRegistry.prototype, 'runApprovedHousekeepingBatch');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { supervisionAutomation } = await import('../../src/daemon/supervision-automation.js');
    supervisionAutomation.init();
    return { list, converge, housekeeping, setIntervalSpy };
  }

  it('schedules nothing and never reads the legacy registry when the switch is off', async () => {
    setSwitch(undefined);
    // Only the interval is faked: the pass itself yields on real macrotasks and must be allowed to finish.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { list, converge, housekeeping, setIntervalSpy } = await initAutomation();
    // Three minutes of daemon time: the per-minute pass would have run three times plus its immediate first run.
    await vi.advanceTimersByTimeAsync(180_000);
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(setIntervalSpy.mock.calls.filter(([, delay]) => delay === 60_000)).toHaveLength(0);
    expect(list).not.toHaveBeenCalled();
    expect(converge).not.toHaveBeenCalled();
    expect(housekeeping).not.toHaveBeenCalled();
    expect(dispatchTick).not.toHaveBeenCalled();
    // What a browser replays for deadlines: no assignment projection is ever published, so a session simply has no deadline (the wire
    // helper answers undefined, the same as for any session with nothing to wake) -- no error, no stale armed schedule.
    const projection = await import('../../src/daemon/supervision-heartbeat-projection.js');
    expect(projection.getSupervisionHeartbeatProjection('deck_proj_w1')).toBeUndefined();
    expect(projection.getSupervisionHeartbeatProjectionForWire('deck_proj_w1')).toBeUndefined();
  });

  it('runs the pass (immediately, then every minute) when the switch is on', async () => {
    setSwitch('1');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { list, housekeeping, setIntervalSpy } = await initAutomation();
    expect(setIntervalSpy.mock.calls.filter(([, delay]) => delay === 60_000)).toHaveLength(1);
    // The immediate first pass, then one more per fake minute; each is allowed to finish before the next tick.
    await vi.waitFor(() => { expect(housekeeping.mock.calls.length).toBeGreaterThanOrEqual(1); }, { timeout: 20_000, interval: 10 });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => { expect(housekeeping.mock.calls.length).toBeGreaterThanOrEqual(2); }, { timeout: 20_000, interval: 10 });
    expect(list).toHaveBeenCalled();
    await vi.waitFor(() => { expect(dispatchTick).toHaveBeenCalled(); }, { timeout: 20_000, interval: 10 });
  });
});

describe('the convergence / audit re-dispatch tick', () => {
  it('does nothing with the switch off: no convergence, no list, no worktree GC', async () => {
    setSwitch(undefined);
    const registryModule = await import('../../src/daemon/supervision-state-store.js');
    const list = vi.spyOn(registryModule.SupervisionTaskRegistry.prototype, 'list');
    const converge = vi.spyOn(registryModule.SupervisionTaskRegistry.prototype, 'convergeLifecycle');
    const gc = vi.fn(async () => undefined);
    const { runSupervisionConvergenceTick, dispatchReadyAuditSweep } = await import('../../src/daemon/send-tool.js');
    await expect(runSupervisionConvergenceTick({ runScheduledWorktreeGcBatch: gc })).resolves.toEqual({ converged: [], audits: [], skipped: true });
    await expect(dispatchReadyAuditSweep({ runScheduledWorktreeGcBatch: gc })).resolves.toEqual([]);
    expect(list).not.toHaveBeenCalled();
    expect(converge).not.toHaveBeenCalled();
    expect(gc).not.toHaveBeenCalled();
  });

  it('runs the same tick with the switch on', async () => {
    setSwitch('1');
    const registryModule = await import('../../src/daemon/supervision-state-store.js');
    const converge = vi.spyOn(registryModule.SupervisionTaskRegistry.prototype, 'convergeLifecycle');
    const gc = vi.fn(async () => undefined);
    const { runSupervisionConvergenceTick } = await import('../../src/daemon/send-tool.js');
    await runSupervisionConvergenceTick({ runScheduledWorktreeGcBatch: gc });
    expect(converge).toHaveBeenCalledTimes(1);
    expect(gc).toHaveBeenCalledTimes(1);
  });
});

describe('the pair heartbeat', () => {
  async function tickOnce() {
    vi.resetModules();
    const { TaskPairStore, setTaskPairStoreForTests } = await import('../../src/daemon/task-pairs/store.js');
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    const { TaskPairAutomation } = await import('../../src/daemon/task-pairs/scheduler.js');
    const automation = new TaskPairAutomation({ now: () => 1_800_000_000_000 });
    await automation.tick();
    setTaskPairStoreForTests(undefined);
  }

  it('does not re-import the whole legacy registry on every tick when the switch is off', async () => {
    setSwitch(undefined);
    await tickOnce();
    expect(importLegacyTasks).not.toHaveBeenCalled();
  });

  it('re-imports on every tick when the switch is on', async () => {
    setSwitch('1');
    await tickOnce();
    expect(importLegacyTasks).toHaveBeenCalledTimes(1);
  });
});
