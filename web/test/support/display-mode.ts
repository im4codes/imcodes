import { vi } from 'vitest';

/**
 * jsdom has no `matchMedia`. This installs one whose `(display-mode: ...)` answers are chosen by the test, and returns a way to flip the
 * answer (an app window opening, a browser moving a tab into an app) and a restore function.
 */
export function stubDisplayMode(initial: 'browser' | 'standalone' | 'fullscreen' = 'browser') {
  let mode: string = initial;
  const listeners = new Set<() => void>();
  const original = window.matchMedia;
  window.matchMedia = vi.fn((query: string) => ({
    matches: query === `(display-mode: ${mode})`,
    media: query,
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
  })) as unknown as typeof window.matchMedia;
  return {
    set(next: string) { mode = next; for (const listener of [...listeners]) listener(); },
    restore() { window.matchMedia = original; },
  };
}

/** Pretend to be a given browser (the install guidance depends on the user agent). Returns a restore function. */
export function stubUserAgent(userAgent: string, maxTouchPoints = 0): () => void {
  const originalAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
  const originalTouch = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
  return () => {
    if (originalAgent) Object.defineProperty(navigator, 'userAgent', originalAgent); else delete (navigator as unknown as Record<string, unknown>).userAgent;
    if (originalTouch) Object.defineProperty(navigator, 'maxTouchPoints', originalTouch); else delete (navigator as unknown as Record<string, unknown>).maxTouchPoints;
  };
}
