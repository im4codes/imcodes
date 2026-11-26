import { afterAll, afterEach } from 'vitest';
import { ensureJsdomStorage } from './memory-storage.js';
import { resetWebSharedCachesForTests } from './reset-shared-caches.js';

ensureJsdomStorage('localStorage');
ensureJsdomStorage('sessionStorage');

if (typeof globalThis.requestAnimationFrame !== 'function') {
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    configurable: true,
  });
}

if (typeof globalThis.cancelAnimationFrame !== 'function') {
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    value: (id: number) => clearTimeout(id),
    configurable: true,
  });
}

afterEach(async () => {
  await resetWebSharedCachesForTests();
});

/**
 * Let Preact's after-paint pair settle before the environment disappears.
 *
 * `preact/hooks` schedules after-paint effects through its internal
 * `afterNextFrame`, which arms BOTH a real animation frame and a real 100ms
 * timeout; whichever fires first calls `cancelAnimationFrame`. A file that ends
 * with that pair still armed leaves the loser to fire after vitest has deleted
 * the jsdom globals, so the identifier no longer resolves and the whole run
 * dies on an uncaught `ReferenceError` -- every assertion green, exit code 1.
 * It is a race with teardown, which is why it only shows up under full-suite
 * load and never when the file is run alone.
 *
 * Waiting one frame here settles the pair while the globals still exist. The
 * two alternatives were both worse: overriding `options.requestAnimationFrame`
 * changes the flush timing these suites are written against (animation frames
 * are unfaked on purpose, see `vitest.fake-timers.ts`), and making the globals
 * non-configurable so teardown cannot delete them breaks `vi.stubGlobal`.
 */
afterAll(async () => {
  await new Promise<void>((resolve) => {
    const settle = (): void => {
      clearTimeout(fallback);
      // One further task, so work the frame callback itself queues also runs.
      setTimeout(resolve, 0);
    };
    // The frame is the fast path; the timeout bounds a jsdom that never paints.
    const fallback = setTimeout(settle, 150);
    requestAnimationFrame(settle);
  });
});
