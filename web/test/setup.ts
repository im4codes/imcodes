/**
 * Global test setup for the web project (jsdom environment).
 *
 * Ensures `localStorage` and `sessionStorage` are always proper Storage
 * implementations.  Some vitest/jsdom combinations produce a plain object
 * without the standard methods which makes `localStorage.clear()` throw.
 */

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
