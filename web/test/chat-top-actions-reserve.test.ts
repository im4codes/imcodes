/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { getChatTopActionsReserve } from '../src/chat-top-actions-reserve.js';

function setZoom(zoom: string | null): void {
  document.documentElement.style.cssText = '';
  if (zoom != null) document.documentElement.style.setProperty('--imcodes-ui-zoom', zoom);
}

function makeActions({ offsetWidth, rectWidth }: { offsetWidth: number; rectWidth: number }): HTMLElement {
  const actions = document.createElement('div');
  Object.defineProperty(actions, 'offsetWidth', { configurable: true, value: offsetWidth });
  actions.getBoundingClientRect = () => ({ width: rectWidth } as DOMRect);
  return actions;
}

describe('chat top actions reserve', () => {
  afterEach(() => {
    setZoom(null);
  });

  it.each([
    [0.6, 120],
    [0.7, 120],
    [0.75, 120],
    [0.8, 120],
    [1, 120],
    [1.25, 120],
    [1.5, 120],
  ])('uses the unscaled width for CSS zoom %s', (zoom, layoutWidth) => {
    setZoom(String(zoom));
    const actions = makeActions({ offsetWidth: 0, rectWidth: layoutWidth * zoom });
    expect(getChatTopActionsReserve(actions)).toBe(layoutWidth + 14);
  });

  it('prefers offsetWidth when layout is available', () => {
    setZoom('0.7');
    const actions = makeActions({ offsetWidth: 137, rectWidth: 95.9 });
    expect(getChatTopActionsReserve(actions)).toBe(151);
  });

  it('rounds fractional layout widths up without inflating exact decimal zoom divisions', () => {
    setZoom('0.7');
    // 84 / 0.7 in IEEE-754 float is 120.00000000000001; should stay 120 + 14 = 134
    expect(getChatTopActionsReserve(makeActions({ offsetWidth: 0, rectWidth: 84 }))).toBe(134);
    setZoom('1');
    expect(getChatTopActionsReserve(makeActions({ offsetWidth: 0, rectWidth: 95.2 }))).toBe(110);
  });

  it('returns null for invalid, missing, or non-positive measurements', () => {
    setZoom('not-a-number');
    expect(getChatTopActionsReserve(makeActions({ offsetWidth: 0, rectWidth: 0 }))).toBeNull();
    expect(getChatTopActionsReserve(makeActions({ offsetWidth: 0, rectWidth: -10 }))).toBeNull();
    expect(getChatTopActionsReserve(makeActions({ offsetWidth: 0, rectWidth: Number.NaN }))).toBeNull();
  });
});
