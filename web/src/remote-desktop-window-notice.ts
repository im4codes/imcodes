/**
 * "The browser would not open the remote desktop window." A blocked `window.open` returns null and, before this, every caller dropped it:
 * the click did nothing and nothing said why. The opener publishes here and one mounted notice host (RemoteDesktopWindowBlockedNotice)
 * tells the user, wherever the click happened. A module-level channel (not React state) because the callers are scattered buttons.
 */
type Listener = (serial: number) => void;

const listeners = new Set<Listener>();
let serial = 0;

export function publishRemoteDesktopWindowBlocked(): void {
  serial += 1;
  for (const listener of [...listeners]) listener(serial);
}

export function subscribeRemoteDesktopWindowBlocked(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam. */
export function resetRemoteDesktopWindowNoticeForTests(): void {
  listeners.clear();
  serial = 0;
}
