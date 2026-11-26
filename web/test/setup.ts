/**
 * Global test setup for the web project (jsdom environment).
 *
 * Ensures `localStorage` and `sessionStorage` are always proper Storage
 * implementations.  Some vitest/jsdom combinations produce a plain object
 * without the standard methods which makes `localStorage.clear()` throw.
 */

import { afterAll, afterEach, vi } from 'vitest';
import { ensureJsdomStorage } from './memory-storage.js';
import { resetWebSharedCachesForTests } from './reset-shared-caches.js';

ensureJsdomStorage('localStorage');
ensureJsdomStorage('sessionStorage');

// jsdom does not implement Element.scrollIntoView; components that scroll a
// highlighted row into view (e.g. inline pickers) call it during effects.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: () => {},
    writable: true,
    configurable: true,
  });
}

// jsdom does not implement document.execCommand; the composer's paste handler
// and the caret-preserving alias-marker insert both use `insertText`. Shim it
// to a no-op returning false so those paths don't throw in tests.
if (typeof document !== 'undefined' && typeof (document as { execCommand?: unknown }).execCommand !== 'function') {
  Object.defineProperty(document, 'execCommand', {
    value: () => false,
    writable: true,
    configurable: true,
  });
}

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

// preact/hooks flushes effects after the next paint via requestAnimationFrame
// PLUS a 35 ms setTimeout fallback. When a file's last render lands just
// before teardown, that fallback fires into a torn-down jsdom and throws
// `cancelAnimationFrame is not defined` (reported as an unhandled error).
// Drain it while the environment is still alive.
afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});
