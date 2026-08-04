export const RICH_TEXT_ENHANCEMENT_CHAR_LIMIT = 20_000;

/**
 * How many view-items a full chat renders before the user scrolls up.
 *
 * A chat window shows roughly 10-30 items at a time, so this only needs enough
 * slack that the first scroll gesture does not immediately hit the "load older"
 * boundary — the scroll handler auto-reveals `CHAT_RENDER_ITEM_INCREMENT` more
 * (anchored, so the reading position does not jump) once `scrollTop < 100`.
 *
 * Mount cost per window measures as roughly a 900 ms fixed cost plus 10 ms per
 * rendered item on a 20x-CPU-throttled browser, so the initial limit dominates
 * a cold load. Restoring 4 windows with 300 events each:
 *
 *   limit 250   13920 ms      limit 60   6488 ms
 *   limit 120   10161 ms      limit 30   4869 ms
 *
 * 60 keeps ~2x the visible tail while cutting the cold-load block in half.
 */
export const CHAT_INITIAL_RENDER_ITEM_LIMIT = 60;
export const CHAT_RENDER_ITEM_INCREMENT = 250;

/**
 * Preview-mode chat (SubSessionCard) only displays a ~250 px tall thumbnail.
 * The user can see ~5–10 messages at the bottom; everything above scrolls
 * out of view and is not interactive (no "load older" button in preview).
 *
 * Before this cap, every SubSessionCard rebuilt `viewItems` over ALL events
 * on mount, so a page refresh with many sub-sessions × hundreds of events
 * blocked the main thread for seconds and made the sub-session buttons
 * unresponsive until every card finished its first render pass. Mobile felt
 * the cost worst because it has less CPU to spend on the redundant work.
 *
 * 50 visible view-items is plenty for the visual tail; we slice the upstream
 * events to `PREVIEW_EVENT_TAIL_LIMIT` first (with slack for the filter
 * pass) so `buildViewItems` itself processes a small list, not the whole
 * timeline.
 */
export const PREVIEW_RENDER_ITEM_LIMIT = 50;
export const PREVIEW_EVENT_TAIL_LIMIT = 200;

export function shouldSkipRichTextEnhancement(text: string): boolean {
  return text.length > RICH_TEXT_ENHANCEMENT_CHAR_LIMIT;
}
