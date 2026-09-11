import { useCallback, useEffect, useState } from 'preact/hooks';

export interface FullscreenControl {
  /** Is *this* element the one the browser is currently showing fullscreen? */
  active: boolean;
  /** Can this browser put this element fullscreen at all? */
  supported: boolean;
  /** Enter fullscreen on this element, or leave if it is already the one. Resolves false if the browser refused. */
  toggle(): Promise<boolean>;
}

/** Does the browser offer fullscreen here at all? */
export function fullscreenSupported(): boolean {
  if (typeof document === 'undefined') return false;
  // An iframe without `allowfullscreen` reports `false` here, and so does a
  // browser that has it disabled by policy. Offering a button that can only
  // fail is worse than offering none.
  if (document.fullscreenEnabled === false) return false;
  return typeof Element.prototype.requestFullscreen === 'function';
}

/**
 * Fullscreen for one element.
 *
 * Three things this gets right that an inline `document.fullscreenElement
 * ? exit() : request()` does not, which is why it lives in one place rather
 * than being written out at each button:
 *
 * - `active` is identity, not truthiness. With truthiness, any *other* element
 *   being fullscreen makes this button claim to be on, and pressing it drops
 *   the other element out of fullscreen instead of putting this one in.
 * - The state comes from the `fullscreenchange` event, because Esc leaves
 *   fullscreen with no click at all. A flag we set ourselves would then say
 *   "on" over a window that is plainly not.
 * - `requestFullscreen()` rejects — no user activation, iOS Safari refusing a
 *   non-video element, a policy block. Resolving false keeps the toolbar alive
 *   and lets the caller say so, where an unhandled rejection says nothing to
 *   anyone but the console.
 */
export function useFullscreen(ref: { current: HTMLElement | null }): FullscreenControl {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const sync = (): void => {
      setActive(Boolean(ref.current) && document.fullscreenElement === ref.current);
    };
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [ref]);

  const toggle = useCallback(async (): Promise<boolean> => {
    const element = ref.current;
    if (!element) return false;
    try {
      if (document.fullscreenElement === element) {
        await document.exitFullscreen();
        return true;
      }
      // Requesting while a different element holds fullscreen is a swap, and
      // the browser handles it. Exiting first would flash the page.
      await element.requestFullscreen();
      return true;
    } catch {
      // The event listener above is the source of truth, so there is nothing
      // to roll back here.
      return false;
    }
  }, [ref]);

  return { active, supported: fullscreenSupported(), toggle };
}
