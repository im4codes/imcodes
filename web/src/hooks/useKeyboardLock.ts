import { useEffect } from 'preact/hooks';

/**
 * Keyboard Lock: the only way a web page can receive the shortcuts the
 * browser keeps for itself.
 *
 * Command+T, Command+N, Command+W, Control+T, Control+W and their kin never
 * reach a page at all -- the browser acts on them before the renderer is told
 * a key was pressed, so no keydown handler runs and no `preventDefault` can
 * forward them to a remote machine. That is why those chords appear to be
 * "not forwarded" while every other key is: the remote-desktop client never
 * saw them.
 *
 * `navigator.keyboard.lock()` exists for exactly this case (remote desktop and
 * remote terminal clients are its motivating use case). It can expose browser
 * shortcuts such as Ctrl+W/T only in supporting browsers while fullscreen;
 * Safari/Firefox do not implement the API, and OS-level shortcuts such as
 * Cmd+Q cannot be reliably captured by a web page in any browser. It only
 * takes effect while the page holds fullscreen, and the browser then requires a held Escape
 * to leave, so the operator can still get out. Chromium-only today: Safari and
 * Firefox implement neither half, and there the on-screen keyboard's own
 * modifier keys stay the way to send a browser-reserved chord.
 */
interface KeyboardLockApi {
  lock(codes?: readonly string[]): Promise<void>;
  unlock(): void;
}

function keyboardLockApi(): KeyboardLockApi | null {
  if (typeof navigator === 'undefined') return null;
  const keyboard = (navigator as Navigator & { keyboard?: Partial<KeyboardLockApi> }).keyboard;
  if (!keyboard || typeof keyboard.lock !== 'function' || typeof keyboard.unlock !== 'function') {
    return null;
  }
  return keyboard as KeyboardLockApi;
}

/** Can this browser hand the page the shortcuts it normally keeps? */
export function keyboardLockSupported(): boolean {
  return keyboardLockApi() !== null;
}

/**
 * Holds the lock while `active`, releases it as soon as that stops being true
 * (leaving fullscreen, losing control of the remote, unmounting).
 *
 * A rejected `lock()` is not an error worth surfacing: it means this browser
 * refused -- no fullscreen yet, or a policy block -- and every key that does
 * reach the page keeps working exactly as before.
 */
export function useKeyboardLock(active: boolean): void {
  useEffect(() => {
    const keyboard = keyboardLockApi();
    if (!active || !keyboard) return;
    void keyboard.lock().catch(() => {});
    return () => keyboard.unlock();
  }, [active]);
}
