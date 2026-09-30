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

/** A DOM row identity plus where its top edge sat relative to the viewport top. */
export interface ReaderAnchor {
  id: string;
  /** row.top - viewport.top when recorded (negative when the row starts above the viewport). */
  offset: number;
  /** scrollTop when recorded. If it differs later, the READER scrolled: adopt, never undo. */
  scrollTop: number;
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
    if (row.bottom > viewportTop + 1) return { id: row.id, offset: row.top - viewportTop, scrollTop };
  }
  return null;
}

/**
 * Scroll correction that keeps a reader's anchor row exactly where it was,
 * whatever changed above it (a virtual row measured, a banner mounting, an
 * image loading). The DOM position is the truth, so it is applied once and is
 * idempotent: after the correction the delta is 0. Sub-half-pixel noise is
 * ignored so fractional layout cannot make it oscillate.
 */
export function computeReaderAnchorDelta(recordedOffset: number, currentOffset: number): number {
  const delta = currentOffset - recordedOffset;
  return Math.abs(delta) > 0.5 ? delta : 0;
}
