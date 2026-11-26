import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  computeModelDropdownStyle,
  MODEL_DROPDOWN_TOP_MARGIN_PX,
  MODEL_DROPDOWN_TRIGGER_GAP_PX,
  MODEL_DROPDOWN_VIEWPORT_HEIGHT_CAP_RATIO,
  readSafeAreaBottomPx,
  readSafeAreaTopPx,
} from '../src/util/model-dropdown-style.js';

/**
 * Evaluate a CSS length expression containing `min()`, `max()`, `calc()`, `px`,
 * `--sat`, `--sab`, `env(safe-area-inset-top, 0px)`, and `env(safe-area-inset-bottom, 0px)`.
 */
function evalCssPx(expr: string | number | undefined, vars: { sat?: number; sab?: number } = {}): number {
  if (typeof expr === 'number') return expr;
  if (typeof expr !== 'string') throw new Error(`Expected string/number CSS value, got ${String(expr)}`);
  const sat = vars.sat ?? 0;
  const sab = vars.sab ?? 0;
  let normalized = expr
    .replace(/var\(--sat,\s*0px\)/g, `${sat}`)
    .replace(/var\(--sab,\s*0px\)/g, `${sab}`)
    .replace(/env\(safe-area-inset-top,\s*0px\)/g, `${sat}`)
    .replace(/env\(safe-area-inset-bottom,\s*0px\)/g, `${sab}`)
    .replace(/(-?\d+(?:\.\d+)?)px/g, '$1')
    .replace(/\bmin\(/g, 'Math.min(')
    .replace(/\bmax\(/g, 'Math.max(')
    .replace(/\bcalc\(/g, '(');

  if (!/^[0-9+*/().,\sMathminax-]+$/.test(normalized)) {
    throw new Error(`Unexpected token in CSS expression: ${expr} -> ${normalized}`);
  }
  const result = Function(`"use strict"; return (${normalized});`)();
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new Error(`Non-numeric result evaluating ${expr}: ${String(result)}`);
  }
  return result;
}

describe('computeModelDropdownStyle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.style.removeProperty('--sat');
    document.documentElement.style.removeProperty('--sab');
    document.body.innerHTML = '';
  });

  it('caps portrait iPhone height below 55% viewport and keeps top edge below status bar + top margin', () => {
    const safeAreaTop = 59;
    const rect = { top: 770, bottom: 804, left: 260, right: 350, width: 90 };
    const style = computeModelDropdownStyle(rect, {
      innerWidth: 390,
      innerHeight: 844,
      visualViewportWidth: 390,
      visualViewportHeight: 844,
      safeAreaTop,
      safeAreaBottom: 34,
    });

    expect(style.position).toBe('fixed');
    expect(style.overflowY).toBe('auto');
    expect(style.overscrollBehavior).toBe('contain');
    expect(style.top).toBe('auto');
    expect(style.bottom).toBe(`${844 - rect.top + MODEL_DROPDOWN_TRIGGER_GAP_PX}px`);

    const maxHeightStr = String(style.maxHeight);
    expect(maxHeightStr).toContain('env(safe-area-inset-top, 0px)');
    expect(maxHeightStr).toContain('var(--sat, 0px)');

    const resolvedMaxHeight = evalCssPx(style.maxHeight, { sat: safeAreaTop });
    const resolvedBottom = evalCssPx(style.bottom);
    const dropdownBottomY = 844 - resolvedBottom;
    const dropdownTopY = dropdownBottomY - resolvedMaxHeight;

    expect(resolvedMaxHeight).toBeLessThanOrEqual(844 * MODEL_DROPDOWN_VIEWPORT_HEIGHT_CAP_RATIO);
    expect(dropdownTopY).toBeGreaterThanOrEqual(safeAreaTop + MODEL_DROPDOWN_TOP_MARGIN_PX);
  });

  it('prevents status-bar overlap via CSS env(safe-area-inset-top) even when JS safeAreaTop reads 0', () => {
    const rect = { top: 480, bottom: 512, left: 260, right: 350, width: 90 };
    const style = computeModelDropdownStyle(rect, {
      innerWidth: 390,
      innerHeight: 844,
      safeAreaTop: 0,
    });

    const resolvedMaxHeight = evalCssPx(style.maxHeight, { sat: 59 });
    const dropdownBottomY = 844 - evalCssPx(style.bottom);
    const dropdownTopY = dropdownBottomY - resolvedMaxHeight;

    expect(resolvedMaxHeight).toBe(401);
    expect(dropdownTopY).toBeGreaterThanOrEqual(59 + MODEL_DROPDOWN_TOP_MARGIN_PX);
  });

  it('caps extreme model list space on iPhone SE (375x667, sat=20px)', () => {
    const rect = { top: 595, bottom: 627, left: 240, right: 330, width: 90 };
    const style = computeModelDropdownStyle(rect, {
      innerWidth: 375,
      innerHeight: 667,
      safeAreaTop: 20,
    });

    const resolvedMaxHeight = evalCssPx(style.maxHeight, { sat: 20 });
    const dropdownTopY = 667 - evalCssPx(style.bottom) - resolvedMaxHeight;

    expect(resolvedMaxHeight).toBe(Math.floor(667 * MODEL_DROPDOWN_VIEWPORT_HEIGHT_CAP_RATIO));
    expect(dropdownTopY).toBeGreaterThanOrEqual(20 + MODEL_DROPDOWN_TOP_MARGIN_PX);
  });

  it('keeps short / landscape / keyboard-open viewports strictly below the safe-area top boundary', () => {
    const safeAreaTop = 59;
    // Direct short viewport (390x420)
    const shortStyle = computeModelDropdownStyle(
      { top: 340, bottom: 372, left: 220, right: 320, width: 100 },
      {
        innerWidth: 390,
        innerHeight: 420,
        visualViewportHeight: 420,
        safeAreaTop,
      },
    );
    const shortMaxH = evalCssPx(shortStyle.maxHeight, { sat: safeAreaTop });
    const shortTopY = 420 - evalCssPx(shortStyle.bottom) - shortMaxH;
    expect(shortMaxH).toBeLessThanOrEqual(420 * MODEL_DROPDOWN_VIEWPORT_HEIGHT_CAP_RATIO);
    expect(shortTopY).toBeGreaterThanOrEqual(safeAreaTop + MODEL_DROPDOWN_TOP_MARGIN_PX);

    // Constrained mid-short trigger (rect.top = 260 on 390x420)
    const tightStyle = computeModelDropdownStyle(
      { top: 260, bottom: 292, left: 220, right: 320, width: 100 },
      {
        innerWidth: 390,
        innerHeight: 420,
        visualViewportHeight: 420,
        safeAreaTop,
      },
    );
    const tightMaxH = evalCssPx(tightStyle.maxHeight, { sat: safeAreaTop });
    const tightTopY = 420 - evalCssPx(tightStyle.bottom) - tightMaxH;
    expect(tightMaxH).toBe(260 - MODEL_DROPDOWN_TRIGGER_GAP_PX - (safeAreaTop + MODEL_DROPDOWN_TOP_MARGIN_PX));
    expect(tightTopY).toBe(safeAreaTop + MODEL_DROPDOWN_TOP_MARGIN_PX);

    // iOS keyboard open: layout innerHeight stays 844 while visualViewport.height shrinks to 420
    const kbStyle = computeModelDropdownStyle(
      { top: 340, bottom: 372, left: 220, right: 320, width: 100 },
      {
        innerWidth: 390,
        innerHeight: 844,
        visualViewportHeight: 420,
        safeAreaTop,
        safeAreaBottom: 34,
      },
    );
    expect(kbStyle.bottom).toBe(`${844 - 340 + MODEL_DROPDOWN_TRIGGER_GAP_PX}px`);
    const kbMaxH = evalCssPx(kbStyle.maxHeight, { sat: safeAreaTop, sab: 34 });
    const kbBottomY = 844 - evalCssPx(kbStyle.bottom);
    expect(kbMaxH).toBeLessThanOrEqual(420 * MODEL_DROPDOWN_VIEWPORT_HEIGHT_CAP_RATIO);
    expect(kbBottomY - kbMaxH).toBeGreaterThanOrEqual(safeAreaTop + MODEL_DROPDOWN_TOP_MARGIN_PX);
  });

  it('factors measurable top safe inset into shouldOpenBelow so notched short viewports flip cleanly', () => {
    const safeAreaTop = 59;
    // Without safeAreaTop, 200 - 8 = 192 >= 180 would stay above; with sat=59 + 16, only 121px fits above vs 180px below
    const style = computeModelDropdownStyle(
      { top: 200, bottom: 232, left: 20, right: 120, width: 100 },
      {
        innerWidth: 390,
        innerHeight: 420,
        safeAreaTop,
      },
    );
    expect(style.bottom).toBe('auto');
    expect(evalCssPx(style.top, { sat: safeAreaTop })).toBe(232 + MODEL_DROPDOWN_TRIGGER_GAP_PX);
    const maxH = evalCssPx(style.maxHeight, { sat: safeAreaTop });
    expect(232 + MODEL_DROPDOWN_TRIGGER_GAP_PX + maxH).toBeLessThanOrEqual(420 - 8);
  });

  it('opens below when space above is small, respecting triggerGap, top safe area, and bottom safe area', () => {
    const style = computeModelDropdownStyle(
      { top: 100, bottom: 132, left: 20, right: 120, width: 100 },
      {
        innerWidth: 390,
        innerHeight: 844,
        safeAreaTop: 59,
        safeAreaBottom: 34,
      },
    );

    expect(style.bottom).toBe('auto');
    expect(String(style.top)).toContain('env(safe-area-inset-top, 0px)');
    expect(String(style.maxHeight)).toContain('env(safe-area-inset-bottom, 0px)');

    const topPx = evalCssPx(style.top, { sat: 59 });
    const maxH = evalCssPx(style.maxHeight, { sat: 59, sab: 34 });
    expect(topPx).toBe(132 + MODEL_DROPDOWN_TRIGGER_GAP_PX);
    expect(maxH).toBe(Math.floor(844 * MODEL_DROPDOWN_VIEWPORT_HEIGHT_CAP_RATIO));
    expect(topPx + maxH).toBeLessThanOrEqual(844 - 34 - 8);

    // Trigger overlapping status bar still pushes dropdown top below safeAreaTop + margin
    const clampedTopStyle = computeModelDropdownStyle(
      { top: 10, bottom: 40, left: 20, right: 120, width: 100 },
      {
        innerWidth: 390,
        innerHeight: 844,
        safeAreaTop: 59,
        safeAreaBottom: 34,
      },
    );
    expect(evalCssPx(clampedTopStyle.top, { sat: 59 })).toBe(59 + MODEL_DROPDOWN_TOP_MARGIN_PX);
  });

  it('preserves desktop positioning, viewport fraction cap, and left/right alignment', () => {
    const rightHalf = computeModelDropdownStyle(
      { top: 820, bottom: 852, left: 1000, right: 1080, width: 80 },
      {
        innerWidth: 1440,
        innerHeight: 900,
        safeAreaTop: 0,
      },
    );
    expect(rightHalf.bottom).toBe('84px');
    expect(rightHalf.top).toBe('auto');
    expect(rightHalf.right).toBe('360px');
    expect(rightHalf.left).toBe('auto');
    expect(rightHalf.minWidth).toBe('200px');
    expect(rightHalf.maxWidth).toBe('1072px');
    expect(evalCssPx(rightHalf.maxHeight)).toBe(Math.floor(900 * MODEL_DROPDOWN_VIEWPORT_HEIGHT_CAP_RATIO));

    const leftHalf = computeModelDropdownStyle(
      { top: 820, bottom: 852, left: 100, right: 180, width: 80 },
      {
        innerWidth: 1440,
        innerHeight: 900,
        safeAreaTop: 0,
      },
    );
    expect(leftHalf.left).toBe('100px');
    expect(leftHalf.right).toBe('auto');
    expect(leftHalf.maxWidth).toBe('1332px');
  });

  it('falls back cleanly when visualViewport is missing and reads DOM safe area insets', () => {
    const style = computeModelDropdownStyle(
      { top: 700, bottom: 732, left: 50, right: 150, width: 100 },
      {
        innerWidth: 375,
        innerHeight: 768,
        visualViewportWidth: null,
        visualViewportHeight: null,
        visualViewportOffsetTop: null,
      },
    );
    expect(style.bottom).toBe('72px');
    expect(evalCssPx(style.maxHeight)).toBe(Math.floor(768 * MODEL_DROPDOWN_VIEWPORT_HEIGHT_CAP_RATIO));

    document.documentElement.style.setProperty('--sat', '47px');
    document.documentElement.style.setProperty('--sab', '34px');
    const layout = document.createElement('div');
    layout.className = 'layout';
    layout.style.marginTop = '59px';
    vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue({
      top: 59,
      bottom: 844,
      left: 0,
      right: 390,
      width: 390,
      height: 785,
      x: 0,
      y: 59,
      toJSON: () => ({}),
    });
    document.body.appendChild(layout);

    expect(readSafeAreaTopPx(document)).toBe(59);
    expect(readSafeAreaBottomPx(document)).toBe(34);
  });

  it('clamps wide two-column split menus inside desktop, 390px, and 320px viewports', () => {
    // 1440x900 desktop: left-half trigger opens flush; center-right shifts safely; far-right aligns right
    const desktopLeft = computeModelDropdownStyle(
      { top: 820, bottom: 852, left: 100, right: 180, width: 80 },
      { innerWidth: 1440, innerHeight: 900, safeAreaTop: 0 },
      { minWidth: 340, preferredWidth: 416 },
    );
    expect(desktopLeft.left).toBe('100px');
    expect(desktopLeft.minWidth).toBe('340px');
    expect(desktopLeft.maxWidth).toBe('1332px');

    const desktopFarRight = computeModelDropdownStyle(
      { top: 820, bottom: 852, left: 1340, right: 1420, width: 80 },
      { innerWidth: 1440, innerHeight: 900, safeAreaTop: 0 },
      { minWidth: 340, preferredWidth: 416 },
    );
    expect(desktopFarRight.right).toBe('20px');
    expect(desktopFarRight.left).toBe('auto');

    // 390x844 mobile: trigger near right side shifts inward so 374px menu fits within [8, 382]
    const mobile390Right = computeModelDropdownStyle(
      { top: 760, bottom: 794, left: 240, right: 320, width: 80 },
      { innerWidth: 390, innerHeight: 844, safeAreaTop: 47, safeAreaBottom: 34 },
      { minWidth: 280, preferredWidth: 374, viewportHeightCapRatio: 0.46, maxHeightPx: 340 },
    );
    expect(mobile390Right.right).toBe('8px');
    expect(mobile390Right.maxWidth).toBe('374px');
    expect(mobile390Right.minWidth).toBe('280px');
    expect(evalCssPx(mobile390Right.maxHeight, { sat: 47 })).toBe(340);

    // 390x844 mobile: trigger on left half shifts left inset to 8px when preferredWidth = 374
    const mobile390Left = computeModelDropdownStyle(
      { top: 760, bottom: 794, left: 30, right: 110, width: 80 },
      { innerWidth: 390, innerHeight: 844, safeAreaTop: 47, safeAreaBottom: 34 },
      { minWidth: 280, preferredWidth: 374, viewportHeightCapRatio: 0.46, maxHeightPx: 340 },
    );
    expect(mobile390Left.left).toBe('8px');
    expect(mobile390Left.maxWidth).toBe('374px');

    // 320x568 ultra-narrow mobile: clamps both maxWidth and preferred/min width inside [8, 312]
    const mobile320 = computeModelDropdownStyle(
      { top: 500, bottom: 534, left: 180, right: 260, width: 80 },
      { innerWidth: 320, innerHeight: 568, safeAreaTop: 0, safeAreaBottom: 0 },
      { minWidth: 280, preferredWidth: 374, viewportHeightCapRatio: 0.46, maxHeightPx: 340 },
    );
    expect(mobile320.right).toBe('8px');
    expect(mobile320.maxWidth).toBe('304px');
    expect(mobile320.minWidth).toBe('280px');
    expect(evalCssPx(mobile320.maxHeight)).toBe(Math.floor(568 * 0.46));

    // Short keyboard-open mobile viewport stays bounded above trigger and below safeAreaTop
    const mobileKeyboard = computeModelDropdownStyle(
      { top: 330, bottom: 364, left: 180, right: 260, width: 80 },
      { innerWidth: 390, innerHeight: 844, visualViewportWidth: 390, visualViewportHeight: 390, safeAreaTop: 47, safeAreaBottom: 34 },
      { minWidth: 280, preferredWidth: 374, viewportHeightCapRatio: 0.46, maxHeightPx: 340 },
    );
    expect(evalCssPx(mobileKeyboard.maxHeight, { sat: 47 })).toBe(179);
  });
});
