import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordStall = vi.fn();
vi.mock('../../src/util/daemon-status.js', () => ({ recordDaemonEventLoopStall: (arg: unknown) => recordStall(arg) }));
vi.mock('../../src/util/logger.js', () => ({ default: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

import {
  EVENT_LOOP_WATCHDOG_IDLE_PHASE,
  getEventLoopWatchdogPhase,
  setEventLoopWatchdogPhase,
  startEventLoopWatchdog,
  stopEventLoopWatchdog,
  withEventLoopWatchdogPhase,
} from '../../src/daemon/event-loop-watchdog.js';

/** Blocks the event loop for real: the watchdog's timer can only run afterwards. */
function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* spin */ }
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  recordStall.mockReset();
  setEventLoopWatchdogPhase(EVENT_LOOP_WATCHDOG_IDLE_PHASE);
});
afterEach(() => {
  stopEventLoopWatchdog();
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
  // restored the phase. These use real timers and a real busy-wait for that reason.
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
