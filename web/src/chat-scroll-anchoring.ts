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
