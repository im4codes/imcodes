import { describe, it, expect, vi, afterEach } from 'vitest';
import { TrailingThrottle } from './trailing-throttle.js';

afterEach(() => {
  vi.useRealTimers();
});

function makeThrottle(intervalMs = 100) {
  const emitted: string[] = [];
  const throttle = new TrailingThrottle<string>(intervalMs, (v) => { emitted.push(v); });
  return { throttle, emitted };
}

describe('TrailingThrottle', () => {
  it('emits the first push for a key immediately (leading edge)', () => {
    vi.useFakeTimers();
    const { throttle, emitted } = makeThrottle();

    throttle.push('k', 'a');

    expect(emitted).toEqual(['a']);
  });

  it('coalesces pushes inside the window and emits only the last one (trailing edge)', () => {
    vi.useFakeTimers();
    const { throttle, emitted } = makeThrottle();

    throttle.push('k', 'a');
    throttle.push('k', 'b');
    throttle.push('k', 'c');
    expect(emitted).toEqual(['a']);

    vi.advanceTimersByTime(99);
    expect(emitted).toEqual(['a']);

    vi.advanceTimersByTime(1);
    expect(emitted).toEqual(['a', 'c']);
  });

  it('reopens the window after the trailing emit', () => {
    vi.useFakeTimers();
    const { throttle, emitted } = makeThrottle();

    throttle.push('k', 'a');
    throttle.push('k', 'b');
    vi.advanceTimersByTime(100);
    expect(emitted).toEqual(['a', 'b']);

    vi.advanceTimersByTime(100);
    throttle.push('k', 'c');
    expect(emitted).toEqual(['a', 'b', 'c']);
  });

  it('keys are independent', () => {
    vi.useFakeTimers();
    const { throttle, emitted } = makeThrottle();

    throttle.push('k1', 'a');
    throttle.push('k2', 'b');

    expect(emitted).toEqual(['a', 'b']);
  });

  it('pushNow bypasses the window and drops the coalesced value', () => {
    vi.useFakeTimers();
    const { throttle, emitted } = makeThrottle();

    throttle.push('k', 'a');
    throttle.push('k', 'stale');
    throttle.pushNow('k', 'urgent');
    expect(emitted).toEqual(['a', 'urgent']);

    // The dropped value must never arrive late and overwrite the urgent one.
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual(['a', 'urgent']);
  });

  it('clear discards a pending value without emitting it', () => {
    vi.useFakeTimers();
    const { throttle, emitted } = makeThrottle();

    throttle.push('k', 'a');
    throttle.push('k', 'pending');
    throttle.clear('k');

    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual(['a']);
  });

  it('clear resets the window so the next push emits immediately', () => {
    vi.useFakeTimers();
    const { throttle, emitted } = makeThrottle();

    throttle.push('k', 'a');
    throttle.clear('k');
    throttle.push('k', 'b');

    expect(emitted).toEqual(['a', 'b']);
  });

  it('flush emits a pending value early and is a no-op when nothing is pending', () => {
    vi.useFakeTimers();
    const { throttle, emitted } = makeThrottle();

    throttle.push('k', 'a');
    throttle.flush('k');
    expect(emitted).toEqual(['a']);

    throttle.push('k', 'b');
    throttle.flush('k');
    expect(emitted).toEqual(['a', 'b']);

    // No duplicate when the scheduled timer later fires.
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual(['a', 'b']);
  });

  it('clearAll drops every key and cancels their timers', () => {
    vi.useFakeTimers();
    const { throttle, emitted } = makeThrottle();

    throttle.push('k1', 'a');
    throttle.push('k1', 'pending1');
    throttle.push('k2', 'b');
    throttle.push('k2', 'pending2');
    throttle.clearAll();

    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual(['a', 'b']);
  });

  it('bounds emit rate under a sustained high-frequency push storm', () => {
    vi.useFakeTimers();
    const { throttle, emitted } = makeThrottle(250);

    // 36 updates/s for 4s — the measured MiniMax thinking-progress rate.
    for (let i = 0; i < 144; i += 1) {
      throttle.push('k', `v${i}`);
      vi.advanceTimersByTime(1000 / 36);
    }

    // ~4s at one per 250ms, rather than 144 raw frames.
    expect(emitted.length).toBeLessThanOrEqual(18);
    expect(emitted.length).toBeGreaterThan(0);
  });
});
