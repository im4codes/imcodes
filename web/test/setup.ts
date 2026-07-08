/**
 * Global test setup for the web project (jsdom environment).
 *
 * Ensures `localStorage` and `sessionStorage` are always proper Storage
 * implementations.  Some vitest/jsdom combinations produce a plain object
 * without the standard methods which makes `localStorage.clear()` throw.
 */

import { afterEach } from 'vitest';
import { resetWebSharedCachesForTests } from './reset-shared-caches.js';

function ensureStorage(name: 'localStorage' | 'sessionStorage'): void {
  const existing = globalThis[name];
  if (existing && typeof existing.clear === 'function' && typeof existing.setItem === 'function') {
    return; // Already a proper Storage
  }

  const store: Record<string, string> = {};
  const impl = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };

  Object.defineProperty(globalThis, name, {
    value: impl,
    writable: true,
    configurable: true,
  });
}

ensureStorage('localStorage');
ensureStorage('sessionStorage');

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
