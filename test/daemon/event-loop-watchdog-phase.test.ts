import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordStall = vi.fn();
vi.mock('../../src/util/daemon-status.js', () => ({ recordDaemonEventLoopStall: (arg: unknown) => recordStall(arg) }));
vi.mock('../../src/util/logger.js', () => ({ default: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

import logger from '../../src/util/logger.js';
import {
  __resetPeriodicPassesForTests,
  PERIODIC_PASS_STALL_BUDGET_MS,
  runPeriodicPass,
  EVENT_LOOP_WATCHDOG_IDLE_PHASE,
  EVENT_LOOP_WATCHDOG_THRESHOLD_MS,
  getEventLoopWatchdogPhase,
  setEventLoopWatchdogClockForTests,
  setEventLoopWatchdogPhase,
  startEventLoopWatchdog,
  stopEventLoopWatchdog,
  withEventLoopWatchdogPhase,
  type EventLoopWatchdogClock,
} from '../../src/daemon/event-loop-watchdog.js';

/**
 * A clock the test fully controls. The watchdog compares timestamps, so the only
 * thing that matters is WHEN time passes relative to its interval tick -- not how
 * fast the machine is. `block` is "the event loop was busy for N ms" (time moves,
 * no timer can run); `run` is "the loop is free for N ms" (due ticks fire, once
 * each, exactly like an overdue Node interval). Nothing here reads the real time.
 */
class ManualClock implements EventLoopWatchdogClock {
  wall = 1_000_000;
  mono = 0;
  private callback: (() => void) | undefined;
  private intervalMs = 0;
  private due = 0;
  wallNow = (): number => this.wall;
  monotonicNow = (): number => this.mono;
  setInterval = (callback: () => void, ms: number): ReturnType<typeof setInterval> => {
    this.callback = callback;
    this.intervalMs = ms;
    this.due = this.wall + ms;
    return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
  };
  clearInterval = (): void => { this.callback = undefined; };
  /** The loop is busy: time passes and nothing else runs. */
  block(ms: number): void {
    this.wall += ms;
    this.mono += ms;
  }
  /** The loop is busy just long enough for the next tick to run exactly `lateMs` late. */
  blockUntilTickIsLate(lateMs: number): void {
    this.block(this.due - this.wall + lateMs);
  }
  /** The loop is free: let `ms` pass, firing the interval whenever it is due. */
  run(ms: number): void {
    const end = this.wall + ms;
    while (this.callback && this.due <= end) {
      const at = Math.max(this.due, this.wall);
      this.mono += at - this.wall;
      this.wall = at;
      this.callback();
      this.due = this.wall + this.intervalMs;
    }
    this.mono += end - this.wall;
    this.wall = end;
  }
}

let clock: ManualClock;
const busyWait = (ms: number): void => clock.block(ms);
const sleep = async (ms: number): Promise<void> => { clock.run(ms); };

beforeEach(() => {
  clock = new ManualClock();
  setEventLoopWatchdogClockForTests(clock);
  recordStall.mockReset();
  setEventLoopWatchdogPhase(EVENT_LOOP_WATCHDOG_IDLE_PHASE);
});
afterEach(() => {
  __resetPeriodicPassesForTests();
  stopEventLoopWatchdog();
  setEventLoopWatchdogClockForTests(null);
});

describe('event-loop watchdog phase attribution (tsk_cd_send_spinner_console_sync)', () => {
  it('restores the previous phase after a scoped phase, even when the work throws', () => {
    expect(getEventLoopWatchdogPhase()).toBe(EVENT_LOOP_WATCHDOG_IDLE_PHASE);
    withEventLoopWatchdogPhase('outer', () => {
      expect(getEventLoopWatchdogPhase()).toBe('outer');
      withEventLoopWatchdogPhase('inner', () => expect(getEventLoopWatchdogPhase()).toBe('inner'));
      expect(getEventLoopWatchdogPhase()).toBe('outer');
    });
    expect(() => withEventLoopWatchdogPhase('boom', () => { throw new Error('x'); })).toThrow('x');
    expect(getEventLoopWatchdogPhase()).toBe(EVENT_LOOP_WATCHDOG_IDLE_PHASE);
  });

  // The stall timer fires AFTER the blocking work returns, i.e. after the scope
  // restored the phase. The manual clock reproduces exactly that ordering
  // (block, then let the tick run) without depending on real time.
  it('names the scope for a stall that was really caused inside it -- and counts it once', async () => {
    startEventLoopWatchdog();
    await sleep(120);
    recordStall.mockReset();
    withEventLoopWatchdogPhase('supervision-console.build-snapshot', () => busyWait(220));
    await sleep(350);
    const named = recordStall.mock.calls.map(([arg]) => arg as { phase: string; stallMs: number });
    expect(named.filter((stall) => stall.phase === 'supervision-console.build-snapshot')).toHaveLength(1);
    expect(named.find((stall) => stall.phase === 'supervision-console.build-snapshot')!.stallMs).toBeGreaterThanOrEqual(200);
    // The tick that finally ran must not blame the same milliseconds on the idle phase.
    expect(named.filter((stall) => stall.phase === EVENT_LOOP_WATCHDOG_IDLE_PHASE)).toHaveLength(0);
  });

  it('does not blame an earlier finished scope for an unrelated stall', async () => {
    startEventLoopWatchdog();
    await sleep(120);
    withEventLoopWatchdogPhase('supervision-console.synchronize-durable-events', () => undefined);
    recordStall.mockReset();
    busyWait(220); // unlabelled work
    await sleep(350);
    const stalls = recordStall.mock.calls.map(([arg]) => arg as { phase: string });
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    expect(stalls.every((stall) => stall.phase === EVENT_LOOP_WATCHDOG_IDLE_PHASE)).toBe(true);
  });

  it('a short scope reports nothing and leaves the tick to judge', async () => {
    startEventLoopWatchdog();
    await sleep(120);
    recordStall.mockReset();
    withEventLoopWatchdogPhase('short', () => busyWait(20));
    await sleep(250);
    expect(recordStall).not.toHaveBeenCalled();
  });

  // The threshold is the whole contract of the detector, so pin both sides of it.
  it('treats a tick exactly at the threshold as quiet and one just above it as a stall', async () => {
    startEventLoopWatchdog();
    await sleep(120);
    recordStall.mockReset();
    clock.blockUntilTickIsLate(EVENT_LOOP_WATCHDOG_THRESHOLD_MS); // the tick lands exactly at the limit
    await sleep(250);
    expect(recordStall).not.toHaveBeenCalled();
    clock.blockUntilTickIsLate(EVENT_LOOP_WATCHDOG_THRESHOLD_MS + 1);
    await sleep(250);
    expect(recordStall).toHaveBeenCalledTimes(1);
    expect(recordStall.mock.calls[0]![0]).toMatchObject({
      phase: EVENT_LOOP_WATCHDOG_IDLE_PHASE,
      stallMs: EVENT_LOOP_WATCHDOG_THRESHOLD_MS + 1,
    });
  });

  it('a scope exactly at the threshold reports nothing; one just above reports under its own name', async () => {
    startEventLoopWatchdog();
    await sleep(120);
    recordStall.mockReset();
    withEventLoopWatchdogPhase('at-limit', () => busyWait(EVENT_LOOP_WATCHDOG_THRESHOLD_MS));
    expect(recordStall).not.toHaveBeenCalled();
    withEventLoopWatchdogPhase('over-limit', () => busyWait(EVENT_LOOP_WATCHDOG_THRESHOLD_MS + 1));
    expect(recordStall).toHaveBeenCalledTimes(1);
    expect(recordStall.mock.calls[0]![0]).toMatchObject({ phase: 'over-limit' });
  });

  // A nested over-threshold scope's milliseconds are already inside its
  // parent's. Counting both used to report (and discount) the block once per
  // nesting level, which over-discounted the next tick and hid a real stall.
  it('reports a nested over-threshold scope once, from the outermost, and discounts it once', async () => {
    startEventLoopWatchdog();
    await sleep(120);
    recordStall.mockReset();
    withEventLoopWatchdogPhase('outer-scope', () => {
      withEventLoopWatchdogPhase('inner-scope', () => busyWait(220));
    });
    await sleep(350);
    const stalls = recordStall.mock.calls.map(([arg]) => arg as { phase: string; stallMs: number });
    expect(stalls.map((stall) => stall.phase)).toEqual(['outer-scope']);
    // The clock here is the test's own (ManualClock), so the numbers are exact: counted once it is ~220 ms, counted per nesting level 440.
    expect(stalls[0]!.stallMs).toBeGreaterThanOrEqual(200);
    expect(stalls[0]!.stallMs).toBeLessThan(320);
  });

  it('does not over-discount: an unlabelled stall right after a nested scope still reads as idle', async () => {
    startEventLoopWatchdog();
    await sleep(120);
    withEventLoopWatchdogPhase('outer-scope', () => {
      withEventLoopWatchdogPhase('inner-scope', () => busyWait(100));
    });
    recordStall.mockReset();
    busyWait(220); // unlabelled, within the same tick window
    await sleep(350);
    const stalls = recordStall.mock.calls.map(([arg]) => arg as { phase: string });
    expect(stalls.some((stall) => stall.phase === EVENT_LOOP_WATCHDOG_IDLE_PHASE)).toBe(true);
  });

  it('a scope that throws still closes its depth, so the next top-level scope reports', async () => {
    startEventLoopWatchdog();
    await sleep(120);
    expect(() => withEventLoopWatchdogPhase('boom', () => { throw new Error('x'); })).toThrow('x');
    recordStall.mockReset();
    withEventLoopWatchdogPhase('after-throw', () => busyWait(220));
    await sleep(350);
    expect(recordStall.mock.calls.map(([arg]) => (arg as { phase: string }).phase)).toContain('after-throw');
  });
});

// 215, 2026-10-07: a 2.4 s freeze every 60 s reported as the anonymous `daemon-main-loop` for days, because the stall
// detector is a timer that only sees a block after it ended. A periodic pass now names itself.
describe('periodic pass stall budget', () => {
  const warnings = () => (logger.warn as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter(([, message]) => message === 'periodic pass stalled the daemon main thread')
    .map(([fields]) => fields as { pass: string; stalledMs: number; stalls: number; wallMs: number; budgetMs: number });

  beforeEach(() => { (logger.warn as unknown as ReturnType<typeof vi.fn>).mockClear(); });

  it('names the pass for a stall that ends while it is in flight, and logs one line naming it when over budget', async () => {
    startEventLoopWatchdog();
    await sleep(120);
    recordStall.mockReset();
    await runPeriodicPass('supervision-convergence-dispatch', async () => {
      busyWait(2400); // the synchronous work between awaits
      await sleep(250);
    });
    const stalls = recordStall.mock.calls.map(([arg]) => arg as { phase: string; stallMs: number });
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({ phase: 'pass:supervision-convergence-dispatch' });
    expect(stalls[0]!.stallMs).toBeGreaterThanOrEqual(2300);
    const logged = warnings();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ pass: 'supervision-convergence-dispatch', stalls: 1, budgetMs: PERIODIC_PASS_STALL_BUDGET_MS });
    expect(logged[0]!.stalledMs).toBeGreaterThanOrEqual(2300);
  });

  it('a quiet pass, and one below the budget, log nothing; a stall after it ended is anonymous again', async () => {
    startEventLoopWatchdog();
    await sleep(120);
    await runPeriodicPass('quiet', async () => { await sleep(200); });
    await runPeriodicPass('short', async () => { busyWait(PERIODIC_PASS_STALL_BUDGET_MS - 100); await sleep(250); });
    expect(warnings()).toHaveLength(0);
    recordStall.mockReset();
    busyWait(400);
    await sleep(250);
    expect(recordStall.mock.calls.every(([arg]) => (arg as { phase: string }).phase === EVENT_LOOP_WATCHDOG_IDLE_PHASE)).toBe(true);
  });

  it('a narrower scoped label wins over the pass label, and overlapping passes are all named', async () => {
    startEventLoopWatchdog();
    await sleep(120);
    recordStall.mockReset();
    await runPeriodicPass('outer', async () => {
      withEventLoopWatchdogPhase('inner-scope', () => busyWait(500));
      await sleep(250);
    });
    expect(recordStall.mock.calls.map(([arg]) => (arg as { phase: string }).phase)).toEqual(['inner-scope']);
    recordStall.mockReset();
    await Promise.all([
      runPeriodicPass('a', async () => { await Promise.resolve(); busyWait(600); await sleep(250); }),
      runPeriodicPass('b', async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }),
    ]);
    expect(recordStall.mock.calls.some(([arg]) => (arg as { phase: string }).phase.startsWith('pass:'))).toBe(true);
  });

  it('returns the pass value, propagates its error, and always deregisters', async () => {
    startEventLoopWatchdog();
    await sleep(120);
    await expect(runPeriodicPass('ok', async () => 42)).resolves.toBe(42);
    await expect(runPeriodicPass('boom', async () => { throw new Error('x'); })).rejects.toThrow('x');
    recordStall.mockReset();
    busyWait(400);
    await sleep(250);
    expect(recordStall.mock.calls.every(([arg]) => (arg as { phase: string }).phase === EVENT_LOOP_WATCHDOG_IDLE_PHASE)).toBe(true);
  });
});
