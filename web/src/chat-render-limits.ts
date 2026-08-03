export const RICH_TEXT_ENHANCEMENT_CHAR_LIMIT = 20_000;
export const CHAT_INITIAL_RENDER_ITEM_LIMIT = 250;
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
