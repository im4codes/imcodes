import { getActiveCssZoom } from './ui-scale.js';

export interface CssZoomMetrics {
  /** Active whole-page CSS zoom factor on `document.documentElement` (`1` when inactive). */
  cssZoom: number;
  /** Whether `getBoundingClientRect()` returns zoomed viewport pixels (`true` on Chrome >= 128) or pre-zoom layout pixels (`false` on WebKit). */
  rectIsZoomed: boolean;
  /** Factor converting `DOMRect` coordinates to viewport `clientX/Y` pixels (`1` on Chrome, `cssZoom` on WebKit). */
  clientPerRect: number;
  /** Factor converting pre-zoom element CSS pixels (`clientWidth`, `style.left`, `translate3d`) to `DOMRect` pixels (`cssZoom` on Chrome, `1` on WebKit). */
  rectPerCss: number;
}

export interface Point2D {
  x: number;
  y: number;
}

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
  right?: number;
  bottom?: number;
}

export interface ElementLayoutBox {
  getBoundingClientRect(): RectLike;
  clientWidth: number;
}

/**
 * Derive how active CSS `zoom` on `document.documentElement` relates viewport `clientX/Y`
 * pixels, `getBoundingClientRect()` coordinates, and pre-zoom element CSS layout pixels.
 *
 * Determined strictly from live DOM geometry (no user-agent sniffing):
 * - Chrome (>= 128): `rootRect.width === window.innerWidth` -> `DOMRect` is in viewport px (`clientPerRect = 1`, `rectPerCss = cssZoom`).
 * - WebKit (Safari / WKWebView / Catalyst): `rootRect.width ≈ window.innerWidth / cssZoom` -> `DOMRect` is in pre-zoom CSS px while `clientX/Y` and `innerWidth` are viewport px (`clientPerRect = cssZoom`, `rectPerCss = 1`).
 */
export function resolveCssZoomMetrics(
  doc: Document | undefined = typeof document !== 'undefined' ? document : undefined,
  win: Pick<Window, 'innerWidth'> | undefined = typeof window !== 'undefined' ? window : undefined,
  referenceElement?: ElementLayoutBox | null,
): CssZoomMetrics {
  const rawZoom = getActiveCssZoom(doc);
  const cssZoom = Number.isFinite(rawZoom) && rawZoom > 0 ? rawZoom : 1;
  if (Math.abs(cssZoom - 1) < 0.0005) {
    return { cssZoom: 1, rectIsZoomed: true, clientPerRect: 1, rectPerCss: 1 };
  }

  let rectIsZoomed = true;
  const rootWidth = doc?.documentElement?.getBoundingClientRect?.().width ?? 0;
  const innerWidth = win?.innerWidth ?? 0;
  if (rootWidth > 0 && innerWidth > 0) {
    rectIsZoomed = Math.abs(rootWidth - innerWidth) <= Math.abs(rootWidth * cssZoom - innerWidth);
  } else if (referenceElement && referenceElement.clientWidth > 0) {
    const refWidth = referenceElement.getBoundingClientRect().width;
    if (refWidth > 0) {
      rectIsZoomed = Math.abs(refWidth - referenceElement.clientWidth * cssZoom)
        <= Math.abs(refWidth - referenceElement.clientWidth);
    }
  }

  return {
    cssZoom,
    rectIsZoomed,
    clientPerRect: rectIsZoomed ? 1 : cssZoom,
    rectPerCss: rectIsZoomed ? cssZoom : 1,
  };
}

/** Convert a viewport `clientX/Y` point into `getBoundingClientRect()` coordinate space. */
export function clientPointToRectSpace(
  clientX: number,
  clientY: number,
  metrics: Pick<CssZoomMetrics, 'clientPerRect'>,
): Point2D {
  return {
    x: clientX / metrics.clientPerRect,
    y: clientY / metrics.clientPerRect,
  };
}

/** Convert a viewport `clientX/Y` point into stage-local pre-zoom CSS pixels (`0..stage.clientWidth/Height`). */
export function clientPointToStageLocalCss(
  clientX: number,
  clientY: number,
  stageRect: Pick<RectLike, 'left' | 'top'>,
  metrics: Pick<CssZoomMetrics, 'clientPerRect' | 'rectPerCss'>,
): Point2D {
  const rectPt = clientPointToRectSpace(clientX, clientY, metrics);
  return {
    x: (rectPt.x - stageRect.left) / metrics.rectPerCss,
    y: (rectPt.y - stageRect.top) / metrics.rectPerCss,
  };
}

/** Convert stage-local pre-zoom CSS pixels (`virtualMouse`, pinch centroid) back into viewport `clientX/Y` pixels. */
export function stageLocalCssToClientPoint(
  localX: number,
  localY: number,
  stageRect: Pick<RectLike, 'left' | 'top'>,
  metrics: Pick<CssZoomMetrics, 'clientPerRect' | 'rectPerCss'>,
): Point2D {
  const rectX = stageRect.left + localX * metrics.rectPerCss;
  const rectY = stageRect.top + localY * metrics.rectPerCss;
  return {
    x: rectX * metrics.clientPerRect,
    y: rectY * metrics.clientPerRect,
  };
}

/** Convert a `DOMRect` into pre-zoom CSS layout pixels (appropriate for `position: fixed` styling). */
export function domRectToCssLayoutRect(
  rect: RectLike,
  metrics: Pick<CssZoomMetrics, 'rectPerCss'>,
): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
  const scale = metrics.rectPerCss;
  const left = rect.left / scale;
  const top = rect.top / scale;
  const width = rect.width / scale;
  const height = rect.height / scale;
  return {
    left,
    top,
    width,
    height,
    right: (rect.right ?? rect.left + rect.width) / scale,
    bottom: (rect.bottom ?? rect.top + rect.height) / scale,
  };
}

/** Logical viewport size in pre-zoom CSS layout pixels (`window.innerWidth/Height / cssZoom`) for `position: fixed`. */
export function cssLayoutViewportSize(
  metrics: Pick<CssZoomMetrics, 'cssZoom'>,
  win: Pick<Window, 'innerWidth' | 'innerHeight'> | undefined = typeof window !== 'undefined' ? window : undefined,
): { width: number; height: number } {
  return {
    width: (win?.innerWidth ?? 0) / metrics.cssZoom,
    height: (win?.innerHeight ?? 0) / metrics.cssZoom,
  };
}
