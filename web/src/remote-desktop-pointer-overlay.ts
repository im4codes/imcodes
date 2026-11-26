/**
 * Which pointer positions belong to the remote desktop, and which belong to a
 * window floating above it.
 *
 * The desktop forwards pointer movement from a WINDOW-level capture listener
 * that decides purely by coordinates, deliberately ignoring `event.target`:
 * pointer capture retargets events to whichever element is being dragged, so
 * target ownership cannot answer "is the pointer over the desktop?".
 *
 * That was fine while nothing of ours was painted on top. The file transfer
 * panel now covers the whole desktop while it is open, so without this guard
 * every pointer move over it would still be driving the remote cursor -- the
 * remote screen flickered and its window edges lit up.
 *
 * Hit-testing resolves both concerns at once: it is pure geometry, so it does
 * not inherit the pointer-capture problem, and it respects occlusion, so it
 * knows the window is in front.
 */

/**
 * Floating children painted over the presented desktop. Pointer input must not
 * fall through these into the remote machine.
 */
export const REMOTE_DESKTOP_OVERLAY_CLASS = 'remote-desktop-file-window';
export const REMOTE_DESKTOP_MENUBAR_RESTORE_CLASS = 'remote-desktop-menubar-restore';

/**
 * Is one of our overlays painted over the desktop at this point?
 *
 * `clientX/Y` are viewport pixels, which `document.elementFromPoint` accepts directly in
 * both Blink and WebKit even when CSS `zoom` is active on `document.documentElement`.
 *
 * `elementAtPoint` is injectable because jsdom has no layout engine and its
 * `elementFromPoint` always returns null -- a test could otherwise only ever
 * observe "not occluded" and would pass against a guard that never fires.
 */
export function isPointOverRemoteDesktopOverlay(
  clientX: number,
  clientY: number,
  elementAtPoint: (x: number, y: number) => Element | null = (x, y) => (
    typeof document !== 'undefined' && typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(x, y)
      : null
  ),
): boolean {
  const element = elementAtPoint(clientX, clientY);
  return Boolean(
    element
    && typeof element.closest === 'function'
    && (
      element.closest(`.${REMOTE_DESKTOP_OVERLAY_CLASS}`)
      || element.closest(`.${REMOTE_DESKTOP_MENUBAR_RESTORE_CLASS}`)
    ),
  );
}
