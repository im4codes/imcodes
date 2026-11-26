import { useCallback, useEffect, useRef } from 'preact/hooks';

/**
 * Single-flight `requestAnimationFrame` scheduler.
 *
 * WHY THIS EXISTS — the lock-screen freeze.
 *
 * While the display is asleep (macOS lock screen, monitor sleep, window
 * occlusion) the browser produces NO frames, so `requestAnimationFrame`
 * callbacks are queued and never run. Timers and WebSocket messages are NOT
 * stopped the same way: a foreground tab whose screen locked does not
 * necessarily transition to `hidden` (see the comment in app.tsx's resume
 * handler), and even when it does, inbound WS frames are I/O events rather
 * than throttled timers. Preact's own passive-effect flush does not stall
 * either — `preact/hooks` schedules it with `afterNextFrame`, which races rAF
 * against a 35ms `setTimeout` fallback and therefore keeps running effects.
 *
 * The result is a producer/consumer asymmetry: effects keep firing, each one
 * calls `requestAnimationFrame(...)`, and NOTHING drains the queue. A raw
 * `useEffect(() => { requestAnimationFrame(cb) }, [events])` therefore grows
 * an unbounded backlog for the whole duration of the lock, and the browser
 * executes ALL of it inside the single first frame after unlock. Every entry
 * does a forced synchronous layout, so that one frame can take seconds —
 * during which compositor-driven CSS animations still look perfectly smooth
 * while the main thread cannot service a click. That is the reported symptom.
 *
 * This hook makes the backlog bounded at one entry per component instance:
 * repeat calls replace the pending callback instead of appending a new frame,
 * and unmount cancels it.
 *
 * Deliberately NOT done here: skipping the schedule when
 * `document.visibilityState !== 'visible'`. A locked screen may leave the tab
 * reporting `visible`, so such a guard would provide false safety while
 * changing nothing. Coalescing is correct regardless of what the browser
 * reports.
 *
 * @returns a stable `schedule(fn)` — the latest `fn` wins, and at most one
 *          animation frame is ever outstanding for this component.
 */
export function useCoalescedFrame(): (fn: () => void) => void {
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    pendingRef.current = null;
  }, []);

  return useCallback((fn: () => void) => {
    pendingRef.current = fn;
    // Already have a frame in flight — the callback above replaced its work.
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const run = pendingRef.current;
      pendingRef.current = null;
      run?.();
    });
  }, []);
}
