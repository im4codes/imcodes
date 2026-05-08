export interface ActionMenuRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ActionMenuSizeLike {
  width: number;
  height: number;
}

export const CHAT_ACTION_MENU_VIEWPORT_MARGIN = 8;
export const CHAT_ACTION_MENU_ANCHOR_GAP = 8;
export const CHAT_ACTION_MENU_FALLBACK_SIZE: ActionMenuSizeLike = {
  width: 260,
  height: 36,
};

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Position the Copy/Quote action menu near the pointer/selection anchor while
 * keeping the rendered popup inside the visible chat container. Coordinates are
 * returned as top-left offsets relative to `containerRect` for an absolutely
 * positioned menu.
 */
export function positionChatActionMenu(
  anchorClientX: number,
  anchorClientY: number,
  containerRect: ActionMenuRectLike,
  menuSize: ActionMenuSizeLike = CHAT_ACTION_MENU_FALLBACK_SIZE,
): { x: number; y: number } {
  const margin = CHAT_ACTION_MENU_VIEWPORT_MARGIN;
  const gap = CHAT_ACTION_MENU_ANCHOR_GAP;
  const availableWidth = Math.max(0, containerRect.width - margin * 2);
  const availableHeight = Math.max(0, containerRect.height - margin * 2);
  const menuWidth = Math.max(0, Math.min(menuSize.width || CHAT_ACTION_MENU_FALLBACK_SIZE.width, availableWidth || menuSize.width));
  const menuHeight = Math.max(0, Math.min(menuSize.height || CHAT_ACTION_MENU_FALLBACK_SIZE.height, availableHeight || menuSize.height));

  const anchorX = anchorClientX - containerRect.left;
  const anchorY = anchorClientY - containerRect.top;
  const x = clamp(anchorX - menuWidth / 2, margin, Math.max(margin, containerRect.width - menuWidth - margin));

  const aboveY = anchorY - menuHeight - gap;
  const belowY = anchorY + gap;
  const y = aboveY >= margin
    ? aboveY
    : clamp(belowY, margin, Math.max(margin, containerRect.height - menuHeight - margin));

  return { x, y };
}
