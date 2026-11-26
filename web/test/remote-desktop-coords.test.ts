/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { mapRemoteDesktopVideoPoint } from '@shared/remote-desktop.js';
import {
  clientPointToRectSpace,
  clientPointToStageLocalCss,
  cssLayoutViewportSize,
  domRectToCssLayoutRect,
  resolveCssZoomMetrics,
  stageLocalCssToClientPoint,
} from '../src/remote-desktop-coords.js';
import {
  clampRemoteDesktopViewport,
  panRemoteDesktopViewportAtEdge,
  viewportFromRemoteDesktopPinch,
} from '../src/remote-desktop-viewport.js';
import { applyUiScale } from '../src/ui-scale.js';

function makeRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON() { return this; },
  } as DOMRect;
}

function setupZoomRegime(regime: 'chrome' | 'webkit', scalePct: number, innerWidth = 1000, innerHeight = 800) {
  const z = applyUiScale(scalePct);
  const rootWidth = regime === 'chrome' ? innerWidth : innerWidth / z;
  const rootHeight = regime === 'chrome' ? innerHeight : innerHeight / z;
  const fakeDoc = {
    documentElement: {
      style: document.documentElement.style,
      getBoundingClientRect: () => makeRect(0, 0, rootWidth, rootHeight),
    },
  } as unknown as Document;
  const fakeWin = { innerWidth, innerHeight };
  return { z, fakeDoc, fakeWin };
}

describe('remote-desktop-coords', () => {
  it('returns identity factors when uiScale is 100%', () => {
    const { fakeDoc, fakeWin } = setupZoomRegime('chrome', 100);
    const metrics = resolveCssZoomMetrics(fakeDoc, fakeWin);
    expect(metrics).toEqual({
      cssZoom: 1,
      rectIsZoomed: true,
      clientPerRect: 1,
      rectPerCss: 1,
    });
    expect(clientPointToRectSpace(123, 456, metrics)).toEqual({ x: 123, y: 456 });
    expect(clientPointToStageLocalCss(123, 456, { left: 23, top: 56 }, metrics)).toEqual({ x: 100, y: 400 });
    expect(stageLocalCssToClientPoint(100, 400, { left: 23, top: 56 }, metrics)).toEqual({ x: 123, y: 456 });
  });

  it.each([60, 80, 100, 125, 150])('maps desktop clicks, letterboxed video, zoomed+panned viewport, and touch round-trips cleanly at %i%% in BOTH Chrome and WebKit', (pct) => {
    for (const regime of ['chrome', 'webkit'] as const) {
      const { z, fakeDoc, fakeWin } = setupZoomRegime(regime, pct, 1280, 800);
      const metrics = resolveCssZoomMetrics(fakeDoc, fakeWin);
      expect(metrics.cssZoom).toBeCloseTo(z, 4);
      if (pct !== 100) {
        expect(metrics.rectIsZoomed).toBe(regime === 'chrome');
      }

      // Stage sits at pre-zoom CSS offset (100, 80) with CSS size 400x300 (4:3).
      // 16:9 video content rendered inside 400x300 fits to 400x225 centered at local top = 37.5.
      // Apply panel zoom scale=2, pan=(30, -20) around stage center (200, 150):
      // transformed video rect in CSS px: left = 100 + 30 - 200 = -70, top = 80 - 20 - 150 = -90, w = 800, h = 600.
      const rectScale = regime === 'chrome' ? z : 1;
      const stageRect = makeRect(100 * rectScale, 80 * rectScale, 400 * rectScale, 300 * rectScale);
      const videoRect = makeRect(-70 * rectScale, -90 * rectScale, 800 * rectScale, 600 * rectScale);

      // Content in transformed video rect spans horizontal [-70..730] (w=800) and vertical [-90 + 75 .. -90 + 525] = [-15 .. 435] (h=450) in CSS px.
      // Helper to pick a visual screen clientX/Y for target normalized video point (nx, ny):
      const targetCssX = -70 + 800 * 0.75; // 530? Wait: check stage local: 530 - 100 = 430 (outside), pick nx=0.5, ny=0.5 -> (330, 210), and nx=0.25, ny=0.25 -> (130, 97.5)
      const cases = [
        { nx: 0.5, ny: 0.5, cssX: -70 + 800 * 0.5, cssY: -15 + 450 * 0.5 }, // (330, 210) -> inside stage (100..500, 80..380)
        { nx: 0.25, ny: 0.25, cssX: -70 + 800 * 0.25, cssY: -15 + 450 * 0.25 }, // (130, 97.5) -> inside stage
      ];

      for (const c of cases) {
        const clientX = c.cssX * z;
        const clientY = c.cssY * z;

        // 1. Desktop mouse stage bounds check + video mapping
        const stagePt = clientPointToRectSpace(clientX, clientY, metrics);
        expect(stagePt.x).toBeGreaterThanOrEqual(stageRect.left);
        expect(stagePt.x).toBeLessThanOrEqual(stageRect.right);
        expect(stagePt.y).toBeGreaterThanOrEqual(stageRect.top);
        expect(stagePt.y).toBeLessThanOrEqual(stageRect.bottom);

        const mapped = mapRemoteDesktopVideoPoint({
          clientX: stagePt.x,
          clientY: stagePt.y,
          viewportLeft: videoRect.left,
          viewportTop: videoRect.top,
          viewportWidth: videoRect.width,
          viewportHeight: videoRect.height,
          videoWidth: 1920,
          videoHeight: 1080,
        });
        expect(mapped).not.toBeNull();
        expect(mapped!.x).toBeCloseTo(c.nx, 4);
        expect(mapped!.y).toBeCloseTo(c.ny, 4);

        // 2. Touch -> stage-local pre-zoom CSS -> virtualMouseClientPoint -> video mapping round-trip
        const local = clientPointToStageLocalCss(clientX, clientY, stageRect, metrics);
        expect(local.x).toBeCloseTo(c.cssX - 100, 4);
        expect(local.y).toBeCloseTo(c.cssY - 80, 4);

        const roundTripClient = stageLocalCssToClientPoint(local.x, local.y, stageRect, metrics);
        expect(roundTripClient.x).toBeCloseTo(clientX, 4);
        expect(roundTripClient.y).toBeCloseTo(clientY, 4);
      }

      // 3. Stage-local CSS edge pan & pinch stay scale-invariant against stage.clientWidth=400
      const geom = { stageWidth: 400, stageHeight: 300, contentWidth: 400, contentHeight: 300 };
      const nearRightEdgeClientX = (100 + 395) * z;
      const nearRightEdgeClientY = (80 + 150) * z;
      const edgeLocal = clientPointToStageLocalCss(nearRightEdgeClientX, nearRightEdgeClientY, stageRect, metrics);
      const edgePan = panRemoteDesktopViewportAtEdge({ scale: 2, x: 0, y: 0 }, edgeLocal, 16, geom);
      expect(edgePan.active).toBe(true);
      expect(edgePan.viewport.x).toBeLessThan(0);

      const pinchLocal = clientPointToStageLocalCss((100 + 300) * z, (80 + 200) * z, stageRect, metrics);
      expect(viewportFromRemoteDesktopPinch({ scale: 1, x: 0, y: 0 }, pinchLocal, pinchLocal, 2, geom)).toEqual(
        clampRemoteDesktopViewport({ scale: 2, x: -100, y: -50 }, geom),
      );

      // 4. Fixed-position popover rect + viewport size stay in pre-zoom CSS layout px
      const triggerRect = makeRect(200 * rectScale, 150 * rectScale, 40 * rectScale, 28 * rectScale);
      const cssTrigger = domRectToCssLayoutRect(triggerRect, metrics);
      expect(cssTrigger.left).toBeCloseTo(200, 4);
      expect(cssTrigger.bottom).toBeCloseTo(178, 4);
      const cssViewport = cssLayoutViewportSize(metrics, fakeWin);
      expect(cssViewport.width).toBeCloseTo(1280 / z, 4);
      expect(cssViewport.height).toBeCloseTo(800 / z, 4);
    }
    applyUiScale(100);
  });

  it('falls back cleanly to element clientWidth comparison when rootRect is unavailable in jsdom', () => {
    const z = applyUiScale(125);
    const fakeDoc = {
      documentElement: {
        style: document.documentElement.style,
        getBoundingClientRect: () => makeRect(0, 0, 0, 0),
      },
    } as unknown as Document;
    const chromeRef = { clientWidth: 400, getBoundingClientRect: () => makeRect(0, 0, 400 * z, 300 * z) };
    const webkitRef = { clientWidth: 400, getBoundingClientRect: () => makeRect(0, 0, 400, 300) };

    expect(resolveCssZoomMetrics(fakeDoc, { innerWidth: 0 }, chromeRef).rectIsZoomed).toBe(true);
    expect(resolveCssZoomMetrics(fakeDoc, { innerWidth: 0 }, webkitRef).rectIsZoomed).toBe(false);
    applyUiScale(100);
  });
});
