import { getActiveCssZoom } from './ui-scale.js';

const CHAT_TOP_ACTIONS_RIGHT_OFFSET_PX = 8;
const CHAT_TOP_ACTIONS_GAP_PX = 6;
const CHAT_TOP_ACTIONS_RESERVE_EXTRA_PX = CHAT_TOP_ACTIONS_RIGHT_OFFSET_PX + CHAT_TOP_ACTIONS_GAP_PX;

/**
 * Return the unscaled CSS width needed to keep the titlebar clear of its
 * absolutely positioned action buttons. `offsetWidth` is in the element's
 * layout coordinate space, while getBoundingClientRect() is zoomed in browsers
 * that implement CSS zoom. The latter is retained as a jsdom/no-layout fallback.
 */
export function getChatTopActionsReserve(actions: HTMLElement): number | null {
  const layoutWidth = actions.offsetWidth;
  const unzoomedWidth = layoutWidth > 0
    ? layoutWidth
    : actions.getBoundingClientRect().width / getActiveCssZoom();
  if (!Number.isFinite(unzoomedWidth) || unzoomedWidth <= 0) return null;
  // Division by a decimal CSS zoom can produce a value one machine epsilon
  // above an integer (for example, 84 / 0.7). Keep that exact layout width from
  // acquiring an unnecessary extra pixel while still rounding real fractions up.
  const roundedLayoutWidth = Math.ceil(
    unzoomedWidth - Number.EPSILON * Math.max(1, Math.abs(unzoomedWidth)),
  );
  return roundedLayoutWidth + CHAT_TOP_ACTIONS_RESERVE_EXTRA_PX;
}
