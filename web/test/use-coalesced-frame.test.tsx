import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from 'preact';
import { useCoalescedFrame } from '../src/hooks/useCoalescedFrame.js';

/**
 * Reproduces the lock-screen state that the whole web test suite cannot
 * otherwise express: `requestAnimationFrame` NEVER runs, while everything else
 * (renders, effects, timers) keeps going. `web/vitest.fake-timers.ts`
 * deliberately keeps animation frames real for the rest of the suite, so the
 * stall is installed locally here and restored afterwards.
 */
function installStalledRaf() {
  const queue: FrameRequestCallback[] = [];
  const cancelled = new Set<number>();
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancel = globalThis.cancelAnimationFrame;
  let nextId = 1;

  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: (cb: FrameRequestCallback) => {
      const id = nextId++;
      queue.push(((t: number) => { if (!cancelled.has(id)) cb(t); }) as FrameRequestCallback);
      return id;
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    value: (id: number) => { cancelled.add(id); },
    configurable: true,
    writable: true,
  });

  return {
    /** Frames queued but never executed — the post-unlock backlog. */
    get pending() { return queue.length - cancelled.size; },
    get queued() { return queue.length; },
    get cancelled() { return cancelled.size; },
    flush() {
      const batch = queue.splice(0, queue.length);
      for (const cb of batch) cb(0);
    },
    restore() {
      Object.defineProperty(globalThis, 'requestAnimationFrame', { value: prevRaf, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: prevCancel, configurable: true, writable: true });
    },
  };
}

/** Preact flushes passive effects via `afterNextFrame` — rAF raced against a
 *  35ms setTimeout. With rAF stalled the timeout wins, so wait it out. */
const settleEffects = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('useCoalescedFrame — bounded backlog while frames are stalled', () => {
  let raf: ReturnType<typeof installStalledRaf>;
  let host: HTMLDivElement;

  beforeEach(() => {
    raf = installStalledRaf();
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    render(null, host);
    host.remove();
    raf.restore();
  });

  it('keeps at most one outstanding frame no matter how many schedules arrive', async () => {
    let schedule!: (fn: () => void) => void;
    function Probe() {
      schedule = useCoalescedFrame();
      return null;
    }
    render(<Probe />, host);
    await settleEffects();
    // Preact schedules its own passive-effect flush through rAF (racing a 35ms
    // setTimeout), so baseline from after mount rather than from zero.
    const baseline = raf.queued;

    // 500 timeline updates arriving while the display is asleep.
    for (let i = 0; i < 500; i++) schedule(() => { /* follow-latest */ });

    // The naive `requestAnimationFrame(...)`-per-update pattern this replaces
    // would have queued 500 callbacks, all of which the browser then executes
    // inside the first frame after unlock.
    expect(raf.queued - baseline).toBe(1);
  });

  it('runs only the most recent callback when frames resume', () => {
    let schedule!: (fn: () => void) => void;
    function Probe() {
      schedule = useCoalescedFrame();
      return null;
    }
    render(<Probe />, host);

    const ran: number[] = [];
    for (let i = 0; i < 10; i++) schedule(() => ran.push(i));
    expect(ran).toEqual([]);

    raf.flush();
    expect(ran).toEqual([9]);
  });

  it('re-arms after a frame lands', () => {
    let schedule!: (fn: () => void) => void;
    function Probe() {
      schedule = useCoalescedFrame();
      return null;
    }
    render(<Probe />, host);

    const ran: string[] = [];
    schedule(() => ran.push('a'));
    raf.flush();
    schedule(() => ran.push('b'));
    raf.flush();
    expect(ran).toEqual(['a', 'b']);
  });

  it('cancels the pending frame on unmount so a stalled backlog cannot outlive the component', async () => {
    let schedule!: (fn: () => void) => void;
    function Probe() {
      schedule = useCoalescedFrame();
      return null;
    }
    render(<Probe />, host);
    await settleEffects();

    const ran: string[] = [];
    schedule(() => ran.push('after-unmount'));
    const cancelledBefore = raf.cancelled;

    render(null, host);
    expect(raf.cancelled).toBe(cancelledBefore + 1);

    raf.flush();
    expect(ran).toEqual([]);
  });
});
