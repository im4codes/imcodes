/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TASK_PAIR_PANEL_BOTTOM_GAP_PX,
  TASK_PAIR_PANEL_MAX_HEIGHT_VAR,
  TASK_PAIR_PANEL_MIN_USABLE_PX,
  bindTaskPairPanelFit,
  computeTaskPairPanelFit,
} from '../src/task-pair-panel-fit.js';

/**
 * The expanded mobile task-status panel used to be `65vh` tall regardless of
 * the chat area, so its lower part was clipped by `.chat-main` (under the
 * progress bar / agent row / composer) and its last cards could not be
 * reached. The bound is now measured; the real-browser proof is
 * test/perf/browser/mobile-task-panel-fit.spec.mjs.
 */
describe('computeTaskPairPanelFit', () => {
  it('bounds the panel to the chat area minus the bottom gap', () => {
    const fit = computeTaskPairPanelFit({ panelTop: 100, hostBottom: 542, viewportBottom: 844 });
    expect(fit).toEqual({ maxHeight: 542 - 100 - TASK_PAIR_PANEL_BOTTOM_GAP_PX, cramped: false });
  });

  it('never exceeds the visual viewport (software keyboard open)', () => {
    const fit = computeTaskPairPanelFit({ panelTop: 100, hostBottom: 700, viewportBottom: 380 });
    expect(fit.maxHeight).toBe(380 - 100 - TASK_PAIR_PANEL_BOTTOM_GAP_PX);
    expect(fit.cramped).toBe(false);
  });

  it('is cramped when less than a usable sliver is left, and never negative', () => {
    expect(computeTaskPairPanelFit({ panelTop: 100, hostBottom: 100 + TASK_PAIR_PANEL_BOTTOM_GAP_PX + TASK_PAIR_PANEL_MIN_USABLE_PX - 1, viewportBottom: 900 }).cramped).toBe(true);
    expect(computeTaskPairPanelFit({ panelTop: 100, hostBottom: 100 + TASK_PAIR_PANEL_BOTTOM_GAP_PX + TASK_PAIR_PANEL_MIN_USABLE_PX, viewportBottom: 900 }).cramped).toBe(false);
    expect(computeTaskPairPanelFit({ panelTop: 300, hostBottom: 200, viewportBottom: 900 })).toEqual({ maxHeight: 0, cramped: true });
  });

  it('treats a non-finite measurement as cramped rather than publishing NaN', () => {
    expect(computeTaskPairPanelFit({ panelTop: Number.NaN, hostBottom: 500, viewportBottom: 500 }).cramped).toBe(true);
  });
});

describe('bindTaskPairPanelFit', () => {
  let resizeCallbacks: Array<() => void>;
  let observed: Element[];
  let viewportListeners: Map<string, Set<() => void>>;
  let viewportState: { offsetTop: number; height: number };
  let frames: FrameRequestCallback[];
  const flushFrames = () => { const pending = frames; frames = []; pending.forEach((callback) => callback(0)); };
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalRaf = window.requestAnimationFrame;
  const originalCancelRaf = window.cancelAnimationFrame;
  const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');

  const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: bottom === top ? 0 : 390, width: bottom === top ? 0 : 390, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  function scene(layout: { titlebar: [number, number]; main: [number, number] }) {
    document.body.innerHTML = '<div class="chat-main"><div class="chat-titlebar"><aside data-testid="panel"></aside></div></div>';
    const main = document.querySelector('.chat-main') as HTMLElement;
    const titlebar = document.querySelector('.chat-titlebar') as HTMLElement;
    const panel = document.querySelector('aside') as HTMLElement;
    const state = { titlebar: layout.titlebar, main: layout.main };
    main.getBoundingClientRect = () => rect(state.main[0], state.main[1]);
    titlebar.getBoundingClientRect = () => rect(state.titlebar[0], state.titlebar[1]);
    return { main, titlebar, panel, state };
  }

  beforeEach(() => {
    resizeCallbacks = [];
    observed = [];
    viewportListeners = new Map();
    viewportState = { offsetTop: 0, height: 844 };
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) { resizeCallbacks.push(callback); }
      observe(target: Element) { observed.push(target); }
      disconnect() { observed = []; }
      unobserve() {}
    } as never;
    frames = [];
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }) as never;
    window.cancelAnimationFrame = (() => undefined) as never;
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        get offsetTop() { return viewportState.offsetTop; },
        get height() { return viewportState.height; },
        addEventListener: (type: string, listener: () => void) => { (viewportListeners.get(type) ?? viewportListeners.set(type, new Set()).get(type)!).add(listener); },
        removeEventListener: (type: string, listener: () => void) => { viewportListeners.get(type)?.delete(listener); },
      },
    });
  });
  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCancelRaf;
    if (originalVisualViewport) Object.defineProperty(window, 'visualViewport', originalVisualViewport);
    else delete (window as { visualViewport?: unknown }).visualViewport;
    document.body.innerHTML = '';
  });

  it('publishes the measured bound (panel top to chat-main bottom) for the stylesheet', () => {
    const { panel } = scene({ titlebar: [40, 80], main: [0, 542] });
    const cramped = vi.fn();
    bindTaskPairPanelFit(panel, cramped);
    // top = titlebar bottom + 4 = 84; bound = 542 - 84 - gap.
    expect(panel.style.getPropertyValue(TASK_PAIR_PANEL_MAX_HEIGHT_VAR)).toBe(`${542 - 84 - TASK_PAIR_PANEL_BOTTOM_GAP_PX}px`);
    expect(cramped).toHaveBeenLastCalledWith(false);
  });

  it('uses the 40px minimum offset when the titlebar is short', () => {
    const { panel } = scene({ titlebar: [0, 20], main: [0, 500] });
    bindTaskPairPanelFit(panel, vi.fn());
    expect(panel.style.getPropertyValue(TASK_PAIR_PANEL_MAX_HEIGHT_VAR)).toBe(`${500 - 40 - TASK_PAIR_PANEL_BOTTOM_GAP_PX}px`);
  });

  it('re-measures when the chat area resizes and when the visual viewport shrinks (keyboard)', () => {
    const { panel, state } = scene({ titlebar: [40, 80], main: [0, 700] });
    const cramped = vi.fn();
    bindTaskPairPanelFit(panel, cramped);
    const before = Number.parseInt(panel.style.getPropertyValue(TASK_PAIR_PANEL_MAX_HEIGHT_VAR), 10);

    state.main = [0, 600];
    resizeCallbacks.forEach((callback) => callback());
    flushFrames();
    expect(Number.parseInt(panel.style.getPropertyValue(TASK_PAIR_PANEL_MAX_HEIGHT_VAR), 10)).toBe(before - 100);

    // Keyboard: the visual viewport ends at 300, above the (unchanged) chat-main bottom.
    viewportState.height = 300;
    viewportListeners.get('resize')?.forEach((listener) => listener());
    flushFrames();
    expect(panel.style.getPropertyValue(TASK_PAIR_PANEL_MAX_HEIGHT_VAR)).toBe(`${300 - 84 - TASK_PAIR_PANEL_BOTTOM_GAP_PX}px`);
    expect(cramped).toHaveBeenLastCalledWith(false);

    // Keyboard plus a tiny chat: too little room -> cramped, and it recovers.
    viewportState.height = 150;
    viewportListeners.get('resize')?.forEach((listener) => listener());
    flushFrames();
    expect(cramped).toHaveBeenLastCalledWith(true);
    viewportState.height = 844;
    viewportListeners.get('scroll')?.forEach((listener) => listener());
    flushFrames();
    expect(cramped).toHaveBeenLastCalledWith(false);
    // Several events in one frame are coalesced into one measurement.
    const calls = cramped.mock.calls.length;
    viewportListeners.get('resize')?.forEach((listener) => { listener(); listener(); });
    flushFrames();
    expect(cramped.mock.calls.length).toBe(calls + 1);
  });

  it('observes chat-main and the titlebar, and cleans up completely', () => {
    const { panel, main, titlebar } = scene({ titlebar: [40, 80], main: [0, 600] });
    const cleanup = bindTaskPairPanelFit(panel, vi.fn());
    expect(observed).toEqual([main, titlebar]);
    expect(viewportListeners.get('resize')?.size).toBe(1);
    cleanup();
    expect(panel.style.getPropertyValue(TASK_PAIR_PANEL_MAX_HEIGHT_VAR)).toBe('');
    expect(viewportListeners.get('resize')?.size).toBe(0);
    expect(viewportListeners.get('scroll')?.size).toBe(0);
    expect(observed).toEqual([]);
  });

  it('measures a panel directly inside chat-main from its 40px top offset', () => {
    document.body.innerHTML = '<div class="chat-main"><aside></aside></div>';
    const main = document.querySelector('.chat-main') as HTMLElement;
    main.getBoundingClientRect = () => rect(10, 410);
    const panel = document.querySelector('aside') as HTMLElement;
    bindTaskPairPanelFit(panel, vi.fn());
    expect(panel.style.getPropertyValue(TASK_PAIR_PANEL_MAX_HEIGHT_VAR)).toBe(`${410 - 50 - TASK_PAIR_PANEL_BOTTOM_GAP_PX}px`);
  });

  it('does nothing without a chat-main host, and never collapses an unlaid-out (zero-size) chat', () => {
    document.body.innerHTML = '<div><aside></aside></div>';
    const orphanCramped = vi.fn();
    const orphan = document.querySelector('aside') as HTMLElement;
    bindTaskPairPanelFit(orphan, orphanCramped)();
    expect(orphanCramped).toHaveBeenLastCalledWith(false);
    expect(orphan.style.getPropertyValue(TASK_PAIR_PANEL_MAX_HEIGHT_VAR)).toBe('');

    const { panel } = scene({ titlebar: [0, 0], main: [0, 0] });
    const zero = vi.fn();
    bindTaskPairPanelFit(panel, zero);
    expect(zero).toHaveBeenLastCalledWith(false);
    expect(panel.style.getPropertyValue(TASK_PAIR_PANEL_MAX_HEIGHT_VAR)).toBe('');
  });
});

describe('stylesheet: mobile expanded panel is bounded by the measured variable', () => {
  const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
  const css = readFileSync(join(WEB_ROOT, 'src/styles.css'), 'utf8');
  const bound = new RegExp(`max-height:\\s*var\\(${TASK_PAIR_PANEL_MAX_HEIGHT_VAR},\\s*min\\(65vh, calc\\(100dvh - 160px\\)\\)\\)`);

  it('never uses the viewport-relative height for the expanded mobile panel (only as the pre-measurement fallback)', () => {
    const rules = [
      /\.chat-titlebar > \.task-pair-status-panel\.is-mobile:not\(\.is-collapsed\) \{([^}]*)\}/g,
      /\.chat-titlebar > \.task-pair-status-panel:not\(\.is-collapsed\) \{([^}]*)\}/g,
    ].flatMap((pattern) => [...css.matchAll(pattern)].map((match) => match[1]!));
    expect(rules.length).toBeGreaterThanOrEqual(3);
    for (const body of rules.filter((entry) => /position:\s*absolute|max-height/.test(entry))) {
      expect(body).toMatch(bound);
      expect(body).toMatch(/height:\s*auto/);
      expect(body).not.toMatch(/(^|[;\s])height:\s*min\(65vh/);
    }
  });

  it('leaves the desktop panel rule unchanged (fixed 65vh box)', () => {
    const desktop = /\.chat-titlebar > \.task-pair-status-panel \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(desktop).toMatch(/height:\s*min\(65vh, calc\(100dvh - 160px\)\)/);
    expect(desktop).not.toContain(TASK_PAIR_PANEL_MAX_HEIGHT_VAR);
  });

  it('keeps the rows list as the only scroll container so every card is reachable', () => {
    const rows = /\.task-pair-status-rows \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rows).toMatch(/overflow-y:\s*auto/);
    expect(rows).toMatch(/min-height:\s*0/);
    const toggle = /\.task-pair-status-toggle \{\s*width: 100%;([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(toggle).toMatch(/flex-shrink:\s*0/);
  });
});
