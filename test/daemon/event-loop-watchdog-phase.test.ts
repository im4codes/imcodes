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

beforeEach(() => {
  vi.useFakeTimers();
  recordStall.mockReset();
  setEventLoopWatchdogPhase(EVENT_LOOP_WATCHDOG_IDLE_PHASE);
});
afterEach(() => {
  stopEventLoopWatchdog();
  vi.useRealTimers();
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

  it('blames a stall on a named phase only when that phase was actually running', () => {
    startEventLoopWatchdog();
    // A console pass ran and finished long ago ...
    withEventLoopWatchdogPhase('supervision-console.synchronize-durable-events', () => undefined);
    // ... then something unlabelled blocks the loop for 400 ms. Before the fix the
    // sticky label made this a "synchronize-durable-events" stall.
    vi.setSystemTime(Date.now() + 400);
    vi.advanceTimersByTime(100);
    expect(recordStall).toHaveBeenCalledTimes(1);
    expect(recordStall.mock.calls[0]![0]).toMatchObject({ phase: EVENT_LOOP_WATCHDOG_IDLE_PHASE });
    expect(recordStall.mock.calls[0]![0].stallMs).toBeGreaterThan(75);
  });

  it('still names the phase for a stall that happens INSIDE a scoped phase', () => {
    startEventLoopWatchdog();
    withEventLoopWatchdogPhase('supervision-console.build-snapshot', () => {
      vi.setSystemTime(Date.now() + 400);
      vi.advanceTimersByTime(100);
    });
    expect(recordStall.mock.calls[0]![0]).toMatchObject({ phase: 'supervision-console.build-snapshot' });
  });
});
