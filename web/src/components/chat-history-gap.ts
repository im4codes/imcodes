/**
 * Where the "earlier messages are still loading" marker goes in a chat list.
 *
 * A window reopened after a long time shows the newest messages next to its stale cache while the hole
 * between them is filled newest→oldest (see timeline/catchup/gap-store.ts). The marker is a row of the
 * list itself — between the older cached block and the stitched newest block — so it scrolls with the
 * content and its arrival/removal goes through the same layout/anchor path as any other row.
 *
 * Pure and structural (it never needs the concrete ViewItem type) so it is unit-testable.
 */

/** Stable key of the marker row; never an event id, so reader-anchor capture (which picks event rows) skips it. */
export const HISTORY_GAP_MARKER_KEY = 'history-gap';

export interface GapPlaceableItem {
  ts?: number;
  event?: { ts?: number };
  toolEvents?: readonly { ts?: number }[];
  statusItems?: readonly GapPlaceableItem[];
}

/** The timestamp an item starts at, or undefined when it carries none (then it never decides a position). */
export function viewItemStartTs(item: GapPlaceableItem): number | undefined {
  if (typeof item.ts === 'number' && Number.isFinite(item.ts)) return item.ts;
  if (typeof item.event?.ts === 'number' && Number.isFinite(item.event.ts)) return item.event.ts;
  const firstTool = item.toolEvents?.[0]?.ts;
  if (typeof firstTool === 'number' && Number.isFinite(firstTool)) return firstTool;
  const firstStatus = item.statusItems?.[0];
  return firstStatus ? viewItemStartTs(firstStatus) : undefined;
}

/**
 * Insert `marker` before the first item that begins at or after the stitched newest block (`gap.upperTs`).
 * Returns `items` itself (same reference) when there is no hole to mark, so memoised consumers stay put.
 * When every listed item is already part of the newest block the marker sits at the top: the hole lies
 * above everything rendered.
 */
export function insertHistoryGapMarker<T extends GapPlaceableItem>(
  items: readonly T[],
  gap: { upperTs: number | null } | null | undefined,
  marker: T,
): readonly T[] {
  if (!gap || gap.upperTs === null || items.length === 0) return items;
  let index = -1;
  for (let i = 0; i < items.length; i += 1) {
    const ts = viewItemStartTs(items[i]!);
    if (ts !== undefined && ts >= gap.upperTs) {
      index = i;
      break;
    }
  }
  // Nothing at or above the stitched block is listed (it is not rendered yet): nothing to place the marker against.
  if (index < 0) return items;
  return [...items.slice(0, index), marker, ...items.slice(index)];
}
