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
  safeAreaTop?: number | null;
  safeAreaBottom?: number | null;
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

export interface ModelDropdownStyleOptions {
  minWidth?: number;
  preferredWidth?: number;
  viewportHeightCapRatio?: number;
  maxHeightPx?: number;
}

/**
 * Compute fixed portal positioning and bounded `maxHeight` for `.menu-dropdown-models`.
 *
 * Combines JS viewport/safe-area metrics (including `visualViewport`) with CSS
 * `min(...)` / `max(var(--sat, 0px), env(safe-area-inset-top, 0px))` so the menu
 * never stretches behind the iOS status bar / Dynamic Island or overflows short
 * keyboard-open viewports even when `--sat` does not resolve numerically in JS.
 */
export function computeModelDropdownStyle(
  rect: ModelDropdownTriggerRect,
  viewport: ModelDropdownViewport,
  options?: ModelDropdownStyleOptions,
): JSX.CSSProperties {
  const layoutWidth = isPositiveFinite(viewport.innerWidth) ? viewport.innerWidth : 0;
  const layoutHeight = isPositiveFinite(viewport.innerHeight) ? viewport.innerHeight : 0;
  const effectiveWidth = isPositiveFinite(viewport.visualViewportWidth)
    ? Math.min(layoutWidth > 0 ? layoutWidth : viewport.visualViewportWidth, viewport.visualViewportWidth)
    : layoutWidth;
  const effectiveHeight = isPositiveFinite(viewport.visualViewportHeight)
    ? Math.min(layoutHeight > 0 ? layoutHeight : viewport.visualViewportHeight, viewport.visualViewportHeight)
    : layoutHeight;
  const visibleTop = isPositiveFinite(viewport.visualViewportOffsetTop) ? viewport.visualViewportOffsetTop : 0;
  const visibleBottom = isPositiveFinite(viewport.visualViewportHeight)
    ? Math.min(layoutHeight > 0 ? layoutHeight : visibleTop + effectiveHeight, visibleTop + effectiveHeight)
    : layoutHeight;

  const safeTop = isNonNegativeFinite(viewport.safeAreaTop) ? viewport.safeAreaTop : 0;
  const safeBottom = isNonNegativeFinite(viewport.safeAreaBottom) ? viewport.safeAreaBottom : 0;

  const targetAboveBottomY = Math.min(
    rect.top - MODEL_DROPDOWN_TRIGGER_GAP_PX,
    visibleBottom - MODEL_DROPDOWN_BOTTOM_INSET_PX,
  );
  const bottomPx = Math.max(
    MODEL_DROPDOWN_HORIZONTAL_INSET_PX,
    Math.round(layoutHeight - targetAboveBottomY),
  );
  const resolvedAboveBottomY = layoutHeight - bottomPx;
  const topSafeBoundary = Math.max(visibleTop, safeTop) + MODEL_DROPDOWN_TOP_MARGIN_PX;
  const availableAbove = Math.floor(resolvedAboveBottomY - topSafeBoundary);

  const rawBelowTopY = Math.max(
    Math.round(rect.bottom + MODEL_DROPDOWN_TRIGGER_GAP_PX),
    Math.round(visibleTop + MODEL_DROPDOWN_TOP_MARGIN_PX),
  );
  const effectiveBelowTopY = Math.max(rawBelowTopY, Math.round(safeTop + MODEL_DROPDOWN_TOP_MARGIN_PX));
  const bottomSafeBoundary = Math.min(visibleBottom, layoutHeight - safeBottom) - MODEL_DROPDOWN_BOTTOM_INSET_PX;
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

  const isRightHalf = rect.left + rect.width / 2 > effectiveWidth / 2;
  const horizontalLimit = Math.max(0, effectiveWidth - MODEL_DROPDOWN_HORIZONTAL_INSET_PX * 2);
  const requestedMinWidth = isPositiveFinite(options?.minWidth) ? options.minWidth : MODEL_DROPDOWN_MIN_WIDTH_PX;
  const clampedMinWidth = Math.max(0, Math.min(requestedMinWidth, horizontalLimit));
  const preferredWidth = isPositiveFinite(options?.preferredWidth)
    ? Math.min(options.preferredWidth, horizontalLimit)
    : undefined;

  const style: JSX.CSSProperties = {
    position: 'fixed',
    zIndex: 2147483646,
    width: 'max-content',
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

  if (isRightHalf) {
    const minRightInset = MODEL_DROPDOWN_HORIZONTAL_INSET_PX + Math.max(0, layoutWidth - effectiveWidth);
    const idealRightOffset = Math.max(minRightInset, layoutWidth - rect.right);
    const maxShiftRightOffset = preferredWidth !== undefined
      ? Math.max(minRightInset, layoutWidth - targetRightBound(effectiveWidth, preferredWidth))
      : idealRightOffset;
    const rightOffset = preferredWidth !== undefined
      ? Math.min(idealRightOffset, maxShiftRightOffset)
      : idealRightOffset;
    const availableLeftWidth = Math.max(
      MODEL_DROPDOWN_FALLBACK_MAX_WIDTH_PX,
      layoutWidth - rightOffset - MODEL_DROPDOWN_HORIZONTAL_INSET_PX,
    );
    style.right = `${Math.round(rightOffset)}px`;
    style.left = 'auto';
    style.maxWidth = `${Math.round(Math.min(availableLeftWidth, horizontalLimit))}px`;
  } else {
    const idealLeftOffset = Math.max(MODEL_DROPDOWN_HORIZONTAL_INSET_PX, rect.left);
    const maxShiftLeftOffset = preferredWidth !== undefined
      ? Math.max(MODEL_DROPDOWN_HORIZONTAL_INSET_PX, effectiveWidth - preferredWidth - MODEL_DROPDOWN_HORIZONTAL_INSET_PX)
      : idealLeftOffset;
    const leftOffset = preferredWidth !== undefined
      ? Math.min(idealLeftOffset, maxShiftLeftOffset)
      : idealLeftOffset;
    const maxAvailableWidth = Math.max(
      MODEL_DROPDOWN_FALLBACK_MAX_WIDTH_PX,
      effectiveWidth - leftOffset - MODEL_DROPDOWN_HORIZONTAL_INSET_PX,
    );
    style.left = `${Math.round(leftOffset)}px`;
    style.right = 'auto';
    style.maxWidth = `${Math.round(Math.min(maxAvailableWidth, horizontalLimit))}px`;
  }

  return style;
}

function targetRightBound(effectiveWidth: number, preferredWidth: number): number {
  return Math.min(
    effectiveWidth - MODEL_DROPDOWN_HORIZONTAL_INSET_PX,
    MODEL_DROPDOWN_HORIZONTAL_INSET_PX + preferredWidth,
  );
}
