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
 * Some compositor-backed drag strips have failed to repaint `:hover` until the
 * pointer is pressed. Keep an explicit target-phase state as the durable path;
 * CSS `:hover` remains a no-JS fallback.
 */
const RESIZE_HANDLE_HOVER_CLASS = 'is-pointer-hovered';

function setResizeHandleHover(event: Event, hovered: boolean): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  target.classList.toggle(RESIZE_HANDLE_HOVER_CLASS, hovered);
}

function setResizeHandlePointerHover(event: PointerEvent, hovered: boolean): void {
  if (event.pointerType === 'touch') return;
  setResizeHandleHover(event, hovered);
}

/** Shared event handlers for every transparent resize hit surface. */
export const resizeHandleHoverEvents = {
  onPointerEnter: (event: PointerEvent) => setResizeHandlePointerHover(event, true),
  onPointerMove: (event: PointerEvent) => setResizeHandlePointerHover(event, true),
  onPointerLeave: (event: PointerEvent) => setResizeHandlePointerHover(event, false),
  onPointerCancel: (event: PointerEvent) => setResizeHandlePointerHover(event, false),
  onMouseEnter: (event: MouseEvent) => setResizeHandleHover(event, true),
  onMouseMove: (event: MouseEvent) => setResizeHandleHover(event, true),
  onMouseLeave: (event: MouseEvent) => setResizeHandleHover(event, false),
} as const;

/**
 * Class list for one handle. `is-resizing` keeps the indicator lit for the whole
 * drag: the pointer routinely leaves the 6px strip once a resize is underway,
 * and `:hover` alone would blink the affordance out mid-gesture.
 */
export function resizeHandleClass(dir: ResizeDir, activeDir: ResizeDir | null): string {
  return `resize-handle resize-hover-surface resize-${dir}${activeDir === dir ? ' is-resizing' : ''}`;
}
