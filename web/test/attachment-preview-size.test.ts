import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_PREVIEW_CHROME,
  ATTACHMENT_PREVIEW_MARGIN_PX,
  LIGHTBOX_ZOOM_CAP,
  attachmentPreviewLeft,
  attachmentPreviewSize,
  lightboxActualSizeScale,
} from '../src/attachment-preview-size.js';

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const aspect = (size: { width: number; height: number }) => size.width / size.height;

describe('attachmentPreviewSize', () => {
  it('shows a 1970 x 350 chat screenshot wide enough to read on a desktop (the old fixed box made it a 264 x 47 sliver)', () => {
    const size = attachmentPreviewSize({ viewport: DESKTOP, natural: { width: 1970, height: 350 }, availableHeight: 700 });
    expect(size.width).toBeGreaterThan(1200); // 1970 -> 1311: two thirds of its own pixels, not 13 %
    expect(size.width).toBeLessThanOrEqual(DESKTOP.width * 0.92);
    expect(aspect(size)).toBeCloseTo(1970 / 350, 1);
    expect(size.width / 1970).toBeGreaterThan(0.6);
  });

  it('shows a 1200 x 1600 phone screenshot as tall as the viewport allows, keeping its shape', () => {
    const size = attachmentPreviewSize({ viewport: DESKTOP, natural: { width: 1200, height: 1600 }, availableHeight: 800 });
    expect(size.height + ATTACHMENT_PREVIEW_CHROME.height).toBeLessThanOrEqual(DESKTOP.height * 0.62 + 1);
    expect(size.height).toBeGreaterThan(480);
    expect(aspect(size)).toBeCloseTo(0.75, 2);
    // a very tall strip (a long page) gets more of the height than an ordinary picture
    const tall = attachmentPreviewSize({ viewport: DESKTOP, natural: { width: 800, height: 3600 }, availableHeight: 800 });
    expect(tall.height + ATTACHMENT_PREVIEW_CHROME.height).toBeLessThanOrEqual(DESKTOP.height * 0.82 + 1);
    expect(tall.height).toBeGreaterThan(size.height);
  });

  it('never enlarges a picture beyond its own pixels: a 16 px icon stays 16 px, a 200 x 100 picture stays 200 x 100', () => {
    expect(attachmentPreviewSize({ viewport: DESKTOP, natural: { width: 16, height: 16 } })).toEqual({ width: 16, height: 16 });
    expect(attachmentPreviewSize({ viewport: PHONE, natural: { width: 200, height: 100 } })).toEqual({ width: 200, height: 100 });
  });

  it('never exceeds the room above the chip, nor the viewport width minus the margins', () => {
    const cramped = attachmentPreviewSize({ viewport: DESKTOP, natural: { width: 1200, height: 1600 }, availableHeight: 300 });
    expect(cramped.height + ATTACHMENT_PREVIEW_CHROME.height).toBeLessThanOrEqual(300);
    expect(aspect(cramped)).toBeCloseTo(0.75, 1);
    const narrow = attachmentPreviewSize({ viewport: PHONE, natural: { width: 1970, height: 350 } });
    expect(narrow.width + ATTACHMENT_PREVIEW_CHROME.width).toBeLessThanOrEqual(PHONE.width - 2 * ATTACHMENT_PREVIEW_MARGIN_PX);
    expect(narrow.width).toBeGreaterThan(300);
  });

  it('scales with the viewport (a larger window shows more) and is stable for the same inputs', () => {
    const small = attachmentPreviewSize({ viewport: { width: 800, height: 600 }, natural: { width: 3000, height: 2000 } });
    const large = attachmentPreviewSize({ viewport: { width: 2560, height: 1440 }, natural: { width: 3000, height: 2000 } });
    expect(large.width).toBeGreaterThan(small.width);
    expect(attachmentPreviewSize({ viewport: DESKTOP, natural: { width: 3000, height: 2000 } })).toEqual(attachmentPreviewSize({ viewport: DESKTOP, natural: { width: 3000, height: 2000 } }));
  });

  it('answers 0 x 0 for a picture of no size, and copes with an unknown viewport and tiny room', () => {
    for (const natural of [{ width: 0, height: 10 }, { width: 10, height: 0 }, { width: NaN, height: 5 }, { width: -4, height: 4 }]) {
      expect(attachmentPreviewSize({ viewport: DESKTOP, natural })).toEqual({ width: 0, height: 0 });
    }
    expect(attachmentPreviewSize({ viewport: { width: 0, height: 0 }, natural: { width: 500, height: 400 } })).toEqual({ width: expect.any(Number), height: expect.any(Number) });
    const size = attachmentPreviewSize({ viewport: DESKTOP, natural: { width: 500, height: 400 }, availableHeight: 5 });
    expect(size.width).toBeGreaterThanOrEqual(1);
    expect(size.height).toBeGreaterThanOrEqual(1);
  });

  it('an 8000 px photo is brought down to the bubble, not shown at its size', () => {
    const size = attachmentPreviewSize({ viewport: DESKTOP, natural: { width: 8000, height: 6000 }, availableHeight: 800 });
    expect(size.width).toBeLessThan(DESKTOP.width);
    expect(size.height + ATTACHMENT_PREVIEW_CHROME.height).toBeLessThanOrEqual(DESKTOP.height * 0.62 + 1);
  });
});

describe('attachmentPreviewLeft', () => {
  it('keeps the bubble inside the viewport: pulled left near the right edge, held off the left edge', () => {
    expect(attachmentPreviewLeft({ anchorLeft: 300, outerWidth: 400, viewportWidth: 1440 })).toBe(300);
    expect(attachmentPreviewLeft({ anchorLeft: 1300, outerWidth: 900, viewportWidth: 1440 })).toBe(1440 - 900 - ATTACHMENT_PREVIEW_MARGIN_PX);
    expect(attachmentPreviewLeft({ anchorLeft: -50, outerWidth: 400, viewportWidth: 1440 })).toBe(ATTACHMENT_PREVIEW_MARGIN_PX);
    // wider than the viewport can never push the bubble off the left edge
    expect(attachmentPreviewLeft({ anchorLeft: 500, outerWidth: 2000, viewportWidth: 1440 })).toBe(ATTACHMENT_PREVIEW_MARGIN_PX);
  });
});

describe('lightboxActualSizeScale (the zoom that shows one picture pixel per screen pixel)', () => {
  it('is the ratio of the picture\'s pixels to the size it is fitted at: a 1970 px wide strip fitted at 360 px is read at 5.47x', () => {
    expect(lightboxActualSizeScale({ width: 1970, height: 350 }, { width: 360, height: 64 })).toBeCloseTo(1970 / 360, 4);
    expect(lightboxActualSizeScale({ width: 1200, height: 1600 }, { width: 300, height: 400 })).toBeCloseTo(4, 4);
  });

  it('is 0 (nothing to gain) for a picture already shown at its pixels, and capped so a huge picture cannot zoom without bound', () => {
    expect(lightboxActualSizeScale({ width: 300, height: 200 }, { width: 300, height: 200 })).toBe(0);
    expect(lightboxActualSizeScale({ width: 300, height: 200 }, { width: 320, height: 213 })).toBe(0);
    expect(lightboxActualSizeScale({ width: 8000, height: 6000 }, { width: 100, height: 75 })).toBe(LIGHTBOX_ZOOM_CAP);
    for (const bad of [{ width: 0, height: 5 }, { width: NaN, height: 5 }]) {
      expect(lightboxActualSizeScale(bad, { width: 100, height: 100 })).toBe(0);
      expect(lightboxActualSizeScale({ width: 100, height: 100 }, bad)).toBe(0);
    }
  });
});
