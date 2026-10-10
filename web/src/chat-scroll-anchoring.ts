export type MeasuredScrollCorrection =
  | { kind: 'pin'; targetTop: number }
  | { kind: 'anchor'; delta: number };

/**
 * Decide the single scroll correction after a virtual row measurement.
 * `wasAtBottom` is sampled before the row grows; using post-growth geometry
 * here is the source of the streaming pin/anchor feedback loop.
 */
export function computeMeasuredScrollCorrection({
  wasAtBottom,
  autoFollow,
  currentTop,
  scrollHeight,
  clientHeight,
  anchorDelta,
}: {
  wasAtBottom: boolean;
  autoFollow: boolean;
  currentTop: number;
  scrollHeight: number;
  clientHeight: number;
  anchorDelta: number;
}): MeasuredScrollCorrection | null {
  if (wasAtBottom) {
    if (!autoFollow) return null;
    const targetTop = Math.max(0, scrollHeight - clientHeight);
    return Math.abs(currentTop - targetTop) <= 1 ? null : { kind: 'pin', targetTop };
  }
  return !autoFollow && anchorDelta !== 0 ? { kind: 'anchor', delta: anchorDelta } : null;
}

/** A DOM row identity plus where its top edge sat in SCROLL-CONTENT coordinates. */
export interface ReaderAnchor {
  id: string;
  /**
   * row.top - viewport.top + scrollTop when recorded. Content coordinates do not
   * change when the reader scrolls (touch, momentum, wheel), only when layout above
   * the row changes - so a difference later is a layout shift by definition and
   * never needs a "did the reader move?" guess.
   */
  contentTop: number;
}

/**
 * Choose the reader's anchor: the first row that reaches into the viewport.
 * `rows` are in document order with viewport-relative tops/bottoms.
 */
export function pickReaderAnchor(
  rows: ReadonlyArray<{ id: string; top: number; bottom: number }>,
  viewportTop: number,
  scrollTop: number,
): ReaderAnchor | null {
  for (const row of rows) {
    if (row.bottom > viewportTop + 1) return { id: row.id, contentTop: row.top - viewportTop + scrollTop };
  }
  return null;
}

/**
 * How far layout above the anchor moved it (positive = pushed down). Sub-half-pixel
 * noise is ignored so fractional layout cannot make a correction oscillate.
 */
export function computeReaderAnchorDelta(recordedContentTop: number, currentContentTop: number): number {
  const delta = currentContentTop - recordedContentTop;
  return Math.abs(delta) > 0.5 ? delta : 0;
}

/**
 * The virtual list's top offset: `x = spacer + bias` where the spacer is the
 * estimated/measured height of every row above the mounted range and `bias`
 * absorbs layout shifts above the reader. `x >= 0` renders as a spacer height;
 * `x < 0` renders as a negative margin (the content above scroll origin is simply
 * out of reach until the viewport is idle and `reconcileTopOffset` moves it back).
 * Absorbing a shift here moves nothing on screen and writes no scrollTop, so a
 * reader is never fought while a finger or momentum owns the scroller.
 */
export function topOffsetStyle(x: number): { height: number; marginTop: number } {
  return x >= 0 ? { height: x, marginTop: 0 } : { height: 0, marginTop: x };
}

/**
 * Bring a top offset that cannot be shown as-is back to something a scroller can
 * represent, with ONE scrollTop compensation the caller applies once the viewport
 * is idle:
 *  - `x < 0`: content sits above the scroll origin (unreachable). Shift it back down
 *    by `-x` and add `-x` to scrollTop.
 *  - `x > 0` while nothing is above the mounted range (`atTop`): a blank gap above
 *    the first message. Take as much of it as scrollTop can give (`min(x, scrollTop)`)
 *    off scrollTop, moving content up by the same amount. What scrollTop cannot give
 *    stays as blank space above the first message: closing it would move the
 *    message the reader is looking at, so it is left as top padding.
 * Returns the new offset and the scrollTop delta, or null when nothing to do.
 */
export function reconcileTopOffset(x: number, atTop: boolean, scrollTop: number): { x: number; scrollTopDelta: number } | null {
  if (x < 0) return { x: 0, scrollTopDelta: -x };
  if (atTop && x > 0) {
    const take = Math.min(x, Math.max(0, scrollTop));
    return take > 0 ? { x: x - take, scrollTopDelta: 0 - take } : null;
  }
  return null;
}
