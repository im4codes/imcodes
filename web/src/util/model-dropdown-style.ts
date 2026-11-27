import type { JSX } from 'preact';

export const MODEL_DROPDOWN_HORIZONTAL_INSET_PX = 8;
export const MODEL_DROPDOWN_BOTTOM_INSET_PX = 8;
export const MODEL_DROPDOWN_TOP_MARGIN_PX = 16;
export const MODEL_DROPDOWN_TRIGGER_GAP_PX = 4;
export const MODEL_DROPDOWN_VIEWPORT_HEIGHT_CAP_RATIO = 0.55;
export const MODEL_DROPDOWN_OPEN_BELOW_THRESHOLD_PX = 180;
export const MODEL_DROPDOWN_MIN_HEIGHT_PX = 96;
export const MODEL_DROPDOWN_MIN_WIDTH_PX = 200;
export const MODEL_DROPDOWN_FALLBACK_MAX_WIDTH_PX = 160;

const SAFE_TOP_CSS = 'max(var(--sat, 0px), env(safe-area-inset-top, 0px))';
const SAFE_BOTTOM_CSS = 'max(var(--sab, 0px), env(safe-area-inset-bottom, 0px))';

export interface ModelDropdownTriggerRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
}

export interface ModelDropdownViewport {
  innerWidth: number;
  innerHeight: number;
  visualViewportWidth?: number | null;
  visualViewportHeight?: number | null;
  visualViewportOffsetTop?: number | null;
  visualViewportOffsetLeft?: number | null;
  safeAreaTop?: number | null;
  safeAreaBottom?: number | null;
  safeAreaLeft?: number | null;
  safeAreaRight?: number | null;
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Read measurable top safe-area inset in CSS px from `--sat` and `.layout`
 * (`margin-top: env(safe-area-inset-top)`). Returns `0` when unresolvable.
 */
export function readSafeAreaTopPx(
  doc: Document | undefined = typeof document !== 'undefined' ? document : undefined,
): number {
  if (!doc || typeof getComputedStyle === 'undefined') return 0;
  const root = doc.documentElement;
  const satRaw = root ? Number.parseFloat(getComputedStyle(root).getPropertyValue('--sat')) : Number.NaN;
  const sat = Number.isFinite(satRaw) && satRaw > 0 ? satRaw : 0;

  const layoutEl = doc.querySelector('.layout');
  if (!layoutEl) return sat;

  const marginTopRaw = Number.parseFloat(getComputedStyle(layoutEl).marginTop);
  const marginTop = Number.isFinite(marginTopRaw) && marginTopRaw > 0 ? marginTopRaw : 0;
  const rectTop = layoutEl.getBoundingClientRect().top;
  const layoutTop = Number.isFinite(rectTop) && rectTop > 0 ? rectTop : 0;
  return Math.max(sat, marginTop, layoutTop);
}

/**
 * Read measurable bottom safe-area inset in CSS px from `--sab`.
 * Returns `0` when unresolvable.
 */
export function readSafeAreaBottomPx(
  doc: Document | undefined = typeof document !== 'undefined' ? document : undefined,
): number {
  if (!doc || typeof getComputedStyle === 'undefined') return 0;
  const root = doc.documentElement;
  const sabRaw = root ? Number.parseFloat(getComputedStyle(root).getPropertyValue('--sab')) : Number.NaN;
  return Number.isFinite(sabRaw) && sabRaw > 0 ? sabRaw : 0;
}

/**
 * Read measurable left safe-area inset in CSS px from `--sal` and `.layout`
 * (`padding-left: var(--sal)`). Returns `0` when unresolvable.
 */
export function readSafeAreaLeftPx(
  doc: Document | undefined = typeof document !== 'undefined' ? document : undefined,
): number {
  if (!doc || typeof getComputedStyle === 'undefined') return 0;
  const root = doc.documentElement;
  const salRaw = root ? Number.parseFloat(getComputedStyle(root).getPropertyValue('--sal')) : Number.NaN;
  const sal = Number.isFinite(salRaw) && salRaw > 0 ? salRaw : 0;

  const layoutEl = doc.querySelector('.layout');
  if (!layoutEl) return sal;

  const padLeftRaw = Number.parseFloat(getComputedStyle(layoutEl).paddingLeft);
  const padLeft = Number.isFinite(padLeftRaw) && padLeftRaw > 0 ? padLeftRaw : 0;
  const rectLeft = layoutEl.getBoundingClientRect().left;
  const layoutLeft = Number.isFinite(rectLeft) && rectLeft > 0 ? rectLeft : 0;
  return Math.max(sal, padLeft, layoutLeft);
}

/**
 * Read measurable right safe-area inset in CSS px from `--sar` and `.layout`
 * (`padding-right: var(--sar)`). Returns `0` when unresolvable.
 */
export function readSafeAreaRightPx(
  doc: Document | undefined = typeof document !== 'undefined' ? document : undefined,
): number {
  if (!doc || typeof getComputedStyle === 'undefined') return 0;
  const root = doc.documentElement;
  const sarRaw = root ? Number.parseFloat(getComputedStyle(root).getPropertyValue('--sar')) : Number.NaN;
  const sar = Number.isFinite(sarRaw) && sarRaw > 0 ? sarRaw : 0;

  const layoutEl = doc.querySelector('.layout');
  if (!layoutEl) return sar;

  const padRightRaw = Number.parseFloat(getComputedStyle(layoutEl).paddingRight);
  const padRight = Number.isFinite(padRightRaw) && padRightRaw > 0 ? padRightRaw : 0;
  const viewWidth = doc.defaultView?.innerWidth ?? 0;
  const rectRight = layoutEl.getBoundingClientRect().right;
  const layoutRight = viewWidth > 0 && Number.isFinite(rectRight) && rectRight < viewWidth
    ? Math.max(0, viewWidth - rectRight)
    : 0;
  return Math.max(sar, padRight, layoutRight);
}

export interface ModelDropdownStyleOptions {
  minWidth?: number;
  preferredWidth?: number;
  viewportHeightCapRatio?: number;
  maxHeightPx?: number;
  preferExactWidth?: boolean;
  centerHorizontally?: boolean;
}

/**
 * Resolve standard options for the two-column Quick SDK / Model switcher menu.
 *
 * - Mobile (<= 640px): ~90% viewport width, centered horizontally within safe
 *   areas, ~52% viewport height (up to 520px).
 * - Desktop (> 640px): ~540px width, ~52% viewport height (up to 500px).
 */
export function resolveQuickSdkDropdownOptions(effectiveWidth: number): ModelDropdownStyleOptions {
  if (effectiveWidth > 0 && effectiveWidth <= 640) {
    return {
      preferredWidth: Math.max(300, Math.round(effectiveWidth * 0.9)),
      minWidth: Math.min(300, Math.round(effectiveWidth * 0.85)),
      preferExactWidth: true,
      centerHorizontally: true,
      viewportHeightCapRatio: 0.52,
      maxHeightPx: 520,
    };
  }
  return {
    preferredWidth: effectiveWidth > 0 ? Math.min(540, Math.round(effectiveWidth * 0.86)) : 540,
    minWidth: 420,
    preferExactWidth: true,
    viewportHeightCapRatio: 0.52,
    maxHeightPx: 500,
  };
}

/**
 * Compute fixed portal positioning and bounded `maxHeight` / `maxWidth` for
 * `.menu-dropdown-models`.
 *
 * Intersects layout bounds with `visualViewport` (`width`, `height`,
 * `offsetLeft`, `offsetTop`) and all four safe-area insets (`sat`, `sab`,
 * `sal`, `sar`) so the menu stays clear of notches, landscape side cutouts,
 * home indicators, and on-screen keyboards.
 */
export function computeModelDropdownStyle(
  rect: ModelDropdownTriggerRect,
  viewport: ModelDropdownViewport,
  options?: ModelDropdownStyleOptions,
): JSX.CSSProperties {
  const layoutWidth = isPositiveFinite(viewport.innerWidth) ? viewport.innerWidth : 0;
  const layoutHeight = isPositiveFinite(viewport.innerHeight) ? viewport.innerHeight : 0;
  const visibleLeft = isNonNegativeFinite(viewport.visualViewportOffsetLeft) ? viewport.visualViewportOffsetLeft : 0;
  const vvWidth = isPositiveFinite(viewport.visualViewportWidth) ? viewport.visualViewportWidth : layoutWidth;
  const visibleRight = layoutWidth > 0 ? Math.min(layoutWidth, visibleLeft + vvWidth) : visibleLeft + vvWidth;
  const effectiveWidth = Math.max(0, visibleRight - visibleLeft);

  const visibleTop = isPositiveFinite(viewport.visualViewportOffsetTop) ? viewport.visualViewportOffsetTop : 0;
  const vvHeight = isPositiveFinite(viewport.visualViewportHeight) ? viewport.visualViewportHeight : layoutHeight;
  const visibleBottom = layoutHeight > 0 ? Math.min(layoutHeight, visibleTop + vvHeight) : visibleTop + vvHeight;
  const effectiveHeight = Math.max(0, visibleBottom - visibleTop);

  const safeTop = isNonNegativeFinite(viewport.safeAreaTop) ? viewport.safeAreaTop : 0;
  const safeBottom = isNonNegativeFinite(viewport.safeAreaBottom) ? viewport.safeAreaBottom : 0;
  const safeLeft = isNonNegativeFinite(viewport.safeAreaLeft) ? viewport.safeAreaLeft : 0;
  const safeRight = isNonNegativeFinite(viewport.safeAreaRight) ? viewport.safeAreaRight : 0;

  const topSafeBoundary = Math.max(visibleTop, safeTop) + MODEL_DROPDOWN_TOP_MARGIN_PX;
  const bottomSafeBoundary = Math.min(visibleBottom, layoutHeight > 0 ? layoutHeight - safeBottom : visibleBottom)
    - MODEL_DROPDOWN_BOTTOM_INSET_PX;

  const targetAboveBottomY = Math.min(
    rect.top - MODEL_DROPDOWN_TRIGGER_GAP_PX,
    bottomSafeBoundary,
  );
  const minBottomInset = Math.max(
    MODEL_DROPDOWN_BOTTOM_INSET_PX + safeBottom,
    layoutHeight - visibleBottom + MODEL_DROPDOWN_BOTTOM_INSET_PX,
  );
  const bottomPx = Math.max(
    minBottomInset,
    Math.round(layoutHeight - targetAboveBottomY),
  );
  const resolvedAboveBottomY = layoutHeight - bottomPx;
  const availableAbove = Math.floor(resolvedAboveBottomY - topSafeBoundary);

  const rawBelowTopY = Math.max(
    Math.round(rect.bottom + MODEL_DROPDOWN_TRIGGER_GAP_PX),
    Math.round(visibleTop + MODEL_DROPDOWN_TOP_MARGIN_PX),
  );
  const effectiveBelowTopY = Math.max(rawBelowTopY, Math.round(safeTop + MODEL_DROPDOWN_TOP_MARGIN_PX));
  const availableBelow = Math.floor(bottomSafeBoundary - effectiveBelowTopY);

  const shouldOpenBelow =
    availableAbove < MODEL_DROPDOWN_OPEN_BELOW_THRESHOLD_PX && availableBelow > availableAbove;

  const heightCapRatio = isPositiveFinite(options?.viewportHeightCapRatio)
    ? options.viewportHeightCapRatio
    : MODEL_DROPDOWN_VIEWPORT_HEIGHT_CAP_RATIO;
  const rawViewportCap = Math.floor(effectiveHeight * heightCapRatio);
  const boundedViewportCap = isPositiveFinite(options?.maxHeightPx)
    ? Math.min(rawViewportCap, Math.floor(options.maxHeightPx))
    : rawViewportCap;

  let maxHeight: string;
  if (shouldOpenBelow) {
    const numericRoom = Math.max(0, availableBelow);
    const tinyFloor = numericRoom < MODEL_DROPDOWN_MIN_HEIGHT_PX
      ? Math.min(MODEL_DROPDOWN_MIN_HEIGHT_PX, Math.max(0, Math.floor(visibleBottom - effectiveBelowTopY - safeBottom)))
      : MODEL_DROPDOWN_MIN_HEIGHT_PX;
    const numericCap = effectiveHeight > 0
      ? Math.min(boundedViewportCap, Math.max(tinyFloor, numericRoom))
      : MODEL_DROPDOWN_MIN_HEIGHT_PX;
    const maxVisibleBelowRoom = Math.max(
      0,
      Math.floor(visibleBottom - effectiveBelowTopY - MODEL_DROPDOWN_BOTTOM_INSET_PX),
    );
    const cssTopExpr = `max(${effectiveBelowTopY}px, calc(${SAFE_TOP_CSS} + ${MODEL_DROPDOWN_TOP_MARGIN_PX}px))`;
    const cssBottomBound = `calc(${layoutHeight - MODEL_DROPDOWN_BOTTOM_INSET_PX}px - ${cssTopExpr} - ${SAFE_BOTTOM_CSS})`;
    maxHeight = `min(${numericCap}px, max(0px, min(${maxVisibleBelowRoom}px, ${cssBottomBound})))`;
  } else {
    const numericRoom = Math.max(0, availableAbove);
    const tinyFloor = numericRoom < MODEL_DROPDOWN_MIN_HEIGHT_PX
      ? Math.min(MODEL_DROPDOWN_MIN_HEIGHT_PX, Math.max(0, Math.floor(resolvedAboveBottomY - Math.max(visibleTop, safeTop))))
      : MODEL_DROPDOWN_MIN_HEIGHT_PX;
    const numericCap = effectiveHeight > 0
      ? Math.min(boundedViewportCap, Math.max(tinyFloor, numericRoom))
      : MODEL_DROPDOWN_MIN_HEIGHT_PX;
    const cssSafeAboveRoom = `calc(${resolvedAboveBottomY}px - ${SAFE_TOP_CSS} - ${MODEL_DROPDOWN_TOP_MARGIN_PX}px)`;
    const cssTopRoom = visibleTop > 0
      ? `min(${Math.max(0, Math.floor(resolvedAboveBottomY - visibleTop - MODEL_DROPDOWN_TOP_MARGIN_PX))}px, ${cssSafeAboveRoom})`
      : cssSafeAboveRoom;
    maxHeight = `min(${numericCap}px, max(0px, ${cssTopRoom}))`;
  }

  const leftSafeBoundary = Math.max(visibleLeft, safeLeft) + MODEL_DROPDOWN_HORIZONTAL_INSET_PX;
  const rightInsetFromLayoutRight = Math.max(Math.max(0, layoutWidth - visibleRight), safeRight)
    + MODEL_DROPDOWN_HORIZONTAL_INSET_PX;
  const rightSafeBoundary = Math.max(leftSafeBoundary, layoutWidth - rightInsetFromLayoutRight);
  const horizontalLimit = Math.max(0, Math.floor(rightSafeBoundary - leftSafeBoundary));

  const requestedMinWidth = isPositiveFinite(options?.minWidth) ? options.minWidth : MODEL_DROPDOWN_MIN_WIDTH_PX;
  const clampedMinWidth = Math.max(0, Math.min(requestedMinWidth, horizontalLimit));
  const preferredWidth = isPositiveFinite(options?.preferredWidth)
    ? Math.min(options.preferredWidth, horizontalLimit)
    : undefined;

  const isRightHalf = rect.left + rect.width / 2 > visibleLeft + effectiveWidth / 2;

  const resolvedWidth = options?.preferExactWidth && preferredWidth !== undefined
    ? `${Math.round(preferredWidth)}px`
    : 'max-content';

  const style: JSX.CSSProperties = {
    position: 'fixed',
    zIndex: 2147483646,
    width: resolvedWidth,
    minWidth: `${Math.round(clampedMinWidth)}px`,
    maxHeight,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
  };

  if (shouldOpenBelow) {
    style.top = `max(${effectiveBelowTopY}px, calc(${SAFE_TOP_CSS} + ${MODEL_DROPDOWN_TOP_MARGIN_PX}px))`;
    style.bottom = 'auto';
  } else {
    style.bottom = `${bottomPx}px`;
    style.top = 'auto';
  }

  if (options?.centerHorizontally && preferredWidth !== undefined) {
    const leftOffset = Math.round(leftSafeBoundary + Math.max(0, horizontalLimit - preferredWidth) / 2);
    style.left = `${leftOffset}px`;
    style.right = 'auto';
    style.maxWidth = `${Math.round(horizontalLimit)}px`;
  } else if (isRightHalf) {
    const idealRightOffset = Math.max(rightInsetFromLayoutRight, layoutWidth - rect.right);
    const maxShiftRightOffset = preferredWidth !== undefined
      ? Math.max(
        rightInsetFromLayoutRight,
        layoutWidth - Math.min(rightSafeBoundary, leftSafeBoundary + preferredWidth),
      )
      : idealRightOffset;
    const rightOffset = preferredWidth !== undefined
      ? Math.min(idealRightOffset, maxShiftRightOffset)
      : idealRightOffset;
    const availableLeftWidth = Math.max(0, Math.floor(layoutWidth - rightOffset - leftSafeBoundary));
    style.right = `${Math.round(rightOffset)}px`;
    style.left = 'auto';
    style.maxWidth = `${Math.round(Math.min(availableLeftWidth, horizontalLimit))}px`;
  } else {
    const idealLeftOffset = Math.max(leftSafeBoundary, rect.left);
    const maxShiftLeftOffset = preferredWidth !== undefined
      ? Math.max(leftSafeBoundary, rightSafeBoundary - preferredWidth)
      : Math.max(leftSafeBoundary, rightSafeBoundary - clampedMinWidth);
    const leftOffset = Math.min(idealLeftOffset, maxShiftLeftOffset);
    const availableRightWidth = Math.max(0, Math.floor(rightSafeBoundary - leftOffset));
    style.left = `${Math.round(leftOffset)}px`;
    style.right = 'auto';
    style.maxWidth = `${Math.round(Math.min(availableRightWidth, horizontalLimit))}px`;
  }

  return style;
}
