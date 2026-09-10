import {
  reserveWorkspaceBottom,
  viewportWorkspaceBelowSessionTabs,
} from './desktop-window-maximize.js';

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

/** Never smaller than the window's own minimums. */
const FILE_WINDOW_MIN_W = 720;
const FILE_WINDOW_MIN_H = 420;

/**
 * Enough room left over that a drag visibly moves the window.
 *
 * FloatingPanel confines a window to `workspace - size`, so a window exactly
 * the size of the workspace cannot be dragged at all -- which is precisely how
 * the fixed 1120x720 default came across as "drag just stops".
 */
const FILE_WINDOW_MIN_TRAVEL = 80;

/**
 * How big the file window should open.
 *
 * The request is "same size as the remote desktop window, so I never have to
 * resize it", and that is what `hostSize` delivers whenever it fits. The only
 * adjustment is the travel floor above: on a display where the desktop window
 * already fills the workspace, matching it exactly would produce a window that
 * cannot be moved, so it gives back up to FILE_WINDOW_MIN_TRAVEL pixels.
 *
 * Only the FIRST open uses this at all: FloatingPanel persists geometry per
 * window id, so once the window has been dragged or resized that size is what
 * reopens. This is the starting point, not a cap.
 *
 * It errs large on purpose. A default small enough that the panes show nothing
 * forces a resize before the window is usable, which is exactly the friction
 * this is meant to remove.
 */
export function remoteDesktopFileWindowDefaultSize(options: {
  viewportWidth: number;
  viewportHeight: number;
  /** Measured size of the remote desktop window, when it can be measured. */
  hostSize?: { width: number; height: number } | null;
  /** Workspace the clamp will apply; defaults to FloatingPanel's own. */
  workspace?: { w: number; h: number };
}): { width: number; height: number } {
  const workspace = options.workspace ?? {
    w: options.viewportWidth,
    h: options.viewportHeight,
  };

  // With no host to copy, open as large as the workspace allows: `fit` below
  // still subtracts the travel floor, so this is the biggest window that can
  // also be dragged. A fraction of the viewport was the wrong fallback -- it
  // could open small enough that the panes show almost nothing, which is the
  // opposite of the point.
  const wanted = options.hostSize ?? { width: workspace.w, height: workspace.h };

  const fit = (want: number, available: number, min: number): number => {
    // Leave travel, but never at the cost of going under the minimum: below
    // that the clamp would fight the minimum instead and the window would be
    // resized on first paint.
    const ceiling = Math.max(min, available - FILE_WINDOW_MIN_TRAVEL);
    return Math.max(min, Math.min(want, ceiling));
  };

  return {
    width: fit(wanted.width, workspace.w, FILE_WINDOW_MIN_W),
    height: fit(wanted.height, workspace.h, FILE_WINDOW_MIN_H),
  };
}

/**
 * The workspace FloatingPanel's clamp will actually use.
 *
 * Deliberately the same two helpers the panel itself calls rather than a
 * private approximation: a sizing rule computed against a different workspace
 * than the clamp enforces is how a window ends up resized on first paint.
 */
export function remoteDesktopFileWindowWorkspace(): { w: number; h: number } {
  const bounds = reserveWorkspaceBottom(viewportWorkspaceBelowSessionTabs({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    minW: FILE_WINDOW_MIN_W,
    minH: FILE_WINDOW_MIN_H,
  }));
  return { w: bounds.w, h: bounds.h };
}
