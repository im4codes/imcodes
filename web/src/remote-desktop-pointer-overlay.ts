/**
 * Which pointer positions belong to the remote desktop, and which belong to a
 * window floating above it.
 *
 * The desktop forwards pointer movement from a WINDOW-level capture listener
 * that decides purely by coordinates, deliberately ignoring `event.target`:
 * pointer capture retargets events to whichever element is being dragged, so
 * target ownership cannot answer "is the pointer over the desktop?".
 *
 * That was fine while nothing of ours was painted on top. Once the file
 * transfer panel became a real draggable, resizable window, every drag over
 * the desktop was ALSO driving the remote cursor -- the remote screen
 * flickered and the drag felt like it kept breaking.
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

/**
 * Is one of our overlays painted over the desktop at this point?
 *
 * `elementAtPoint` is injectable because jsdom has no layout engine and its
 * `elementFromPoint` always returns null -- a test could otherwise only ever
 * observe "not occluded" and would pass against a guard that never fires.
 */
export function isPointOverRemoteDesktopOverlay(
  clientX: number,
  clientY: number,
  elementAtPoint: (x: number, y: number) => Element | null =
    (x, y) => document.elementFromPoint(x, y),
): boolean {
  const element = elementAtPoint(clientX, clientY);
  return Boolean(element?.closest(`.${REMOTE_DESKTOP_OVERLAY_CLASS}`));
}

/**
 * A default size for the file window that leaves room to actually move it.
 *
 * FloatingPanel clamps with `clampGeometryFullyIntoWorkspace`, so a window is
 * confined to `workspace - size` in each axis. The workspace is the viewport
 * minus the session tab bar and a 100px bottom reserve, which on a laptop is
 * often only ~750px tall -- so a fixed 720px-tall default left about 36px of
 * travel and about 36px of growth. Both gestures started correctly and then
 * appeared to "break" the moment they hit that wall.
 *
 * The old drawer sized itself RELATIVE to the panel (`calc(100% - 24px)`);
 * turning it into a window is what turned those into absolute pixels. This
 * restores the relative intent.
 */
export function remoteDesktopFileWindowDefaultSize(
  viewportWidth: number,
  viewportHeight: number,
): { width: number; height: number } {
  return {
    width: Math.max(720, Math.min(1120, Math.round(viewportWidth * 0.72))),
    height: Math.max(420, Math.min(720, Math.round(viewportHeight * 0.62))),
  };
}
