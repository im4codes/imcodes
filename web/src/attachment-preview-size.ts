/**
 * How large an attachment image is shown. Pure functions of the viewport and the image, so the numbers are testable without a
 * browser: the hover bubble above a composer chip used to be a fixed 264 x 240 box, which made a 1970 x 350 screenshot of a chat
 * (text and all) a 264 x 47 sliver nobody could read.
 */

export interface PreviewSize { width: number; height: number }

/** Space the bubble spends around the picture itself: its padding and the caption line, in CSS px. */
export const ATTACHMENT_PREVIEW_CHROME: PreviewSize = Object.freeze({ width: 14, height: 40 });
/** Kept clear of the viewport edges. */
export const ATTACHMENT_PREVIEW_MARGIN_PX = 12;

export const ATTACHMENT_PREVIEW_FRACTIONS = Object.freeze({
  /** An ordinary picture: up to this share of the viewport width / height. */
  width: 0.66,
  height: 0.62,
  /** A wide strip (aspect >= WIDE_ASPECT: a screenshot of one chat column, a banner) gets nearly the whole width, since its height is small anyway. */
  wideWidth: 0.92,
  /** A tall strip (aspect <= TALL_ASPECT: a phone screenshot, a long page) gets most of the height. */
  tallHeight: 0.82,
});
export const ATTACHMENT_PREVIEW_WIDE_ASPECT = 2.2;
export const ATTACHMENT_PREVIEW_TALL_ASPECT = 0.55;

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

/**
 * The size of the picture inside the hover bubble. Keeps the aspect ratio, never enlarges the picture beyond its own pixels (a 16 px
 * icon stays 16 px; nothing is blurred by upscaling), and never exceeds the room: `availableHeight` is the space between the chip
 * and the top of the viewport.
 */
export function attachmentPreviewSize(input: {
  viewport: PreviewSize;
  natural: PreviewSize;
  availableHeight?: number;
  chrome?: PreviewSize;
}): PreviewSize {
  const { viewport, natural } = input;
  if (!positive(natural.width) || !positive(natural.height)) return { width: 0, height: 0 };
  const chrome = input.chrome ?? ATTACHMENT_PREVIEW_CHROME;
  const aspect = natural.width / natural.height;
  const widthShare = aspect >= ATTACHMENT_PREVIEW_WIDE_ASPECT ? ATTACHMENT_PREVIEW_FRACTIONS.wideWidth : ATTACHMENT_PREVIEW_FRACTIONS.width;
  const heightShare = aspect <= ATTACHMENT_PREVIEW_TALL_ASPECT ? ATTACHMENT_PREVIEW_FRACTIONS.tallHeight : ATTACHMENT_PREVIEW_FRACTIONS.height;
  const viewportWidth = positive(viewport.width) ? viewport.width : natural.width;
  const viewportHeight = positive(viewport.height) ? viewport.height : natural.height;
  const roomHeight = positive(input.availableHeight ?? NaN) ? Math.min(viewportHeight * heightShare, input.availableHeight!) : viewportHeight * heightShare;
  const maxWidth = Math.max(1, Math.min(viewportWidth * widthShare, viewportWidth - 2 * ATTACHMENT_PREVIEW_MARGIN_PX) - chrome.width);
  const maxHeight = Math.max(1, roomHeight - chrome.height);
  const scale = Math.min(1, maxWidth / natural.width, maxHeight / natural.height);
  return { width: Math.max(1, Math.round(natural.width * scale)), height: Math.max(1, Math.round(natural.height * scale)) };
}

/** The left edge of a bubble of `outerWidth`, anchored at the chip but kept inside the viewport. */
export function attachmentPreviewLeft(input: { anchorLeft: number; outerWidth: number; viewportWidth: number }): number {
  const maxLeft = input.viewportWidth - input.outerWidth - ATTACHMENT_PREVIEW_MARGIN_PX;
  return Math.max(ATTACHMENT_PREVIEW_MARGIN_PX, Math.min(input.anchorLeft, maxLeft));
}

/** Largest zoom the lightbox allows on top of "fit": at least the shared 4x, more when the picture is shown much smaller than its pixels. */
export const LIGHTBOX_ZOOM_CAP = 16;

/**
 * The lightbox scale at which one image pixel is one screen pixel ("100%"), relative to the fitted size, or 0 when the fitted picture
 * is already at (or beyond) its natural size (nothing to gain). `fitted` is the size the picture occupies at rest.
 */
export function lightboxActualSizeScale(natural: PreviewSize, fitted: PreviewSize): number {
  if (!positive(natural.width) || !positive(natural.height) || !positive(fitted.width) || !positive(fitted.height)) return 0;
  const scale = Math.max(natural.width / fitted.width, natural.height / fitted.height);
  return scale > 1.05 ? Math.min(scale, LIGHTBOX_ZOOM_CAP) : 0;
}
