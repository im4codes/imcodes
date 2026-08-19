/**
 * Shared vocabulary for the 8-direction window resize affordance.
 *
 * `SubSessionWindow` and `FloatingPanel` implement the same gesture and render
 * the same handles, so the direction list, the hit geometry, and the class-name
 * shape live here once instead of being restated (and drifting) in both.
 *
 * The styling itself is in `styles.css` under "Resize handles" — these classes
 * are the contract between the two components and that stylesheet.
 */

export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Every handle a resizable window renders. Corners last so they paint on top. */
export const RESIZE_DIRS: readonly ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/**
 * Width of the edge grab strip, mirroring `.resize-n`/`.resize-e` &c. in
 * `styles.css`. Exported because `FloatingPanel` stacks its bottom drag strip
 * directly above the south handle and must not overlap it.
 */
export const RESIZE_EDGE_PX = 6;

/**
 * Class list for one handle. `is-resizing` keeps the indicator lit for the whole
 * drag: the pointer routinely leaves the 6px strip once a resize is underway,
 * and `:hover` alone would blink the affordance out mid-gesture.
 */
export function resizeHandleClass(dir: ResizeDir, activeDir: ResizeDir | null): string {
  return `resize-handle resize-${dir}${activeDir === dir ? ' is-resizing' : ''}`;
}
