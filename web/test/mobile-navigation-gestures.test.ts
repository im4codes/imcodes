/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  MOBILE_NAVIGATION_GESTURE_KEYCAPS,
  MOBILE_SWIPE_PRIMARY_THRESHOLD_PX,
  TwoFingerSwipeTracker,
  attachMobileNavigationGestures,
  canHandleMobileNavigationGesture,
  type MobileNavigationGestureProgress,
  type TouchPointSnapshot,
} from '../src/mobile-navigation-gestures.js';

function dispatchTouch(
  target: EventTarget,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  touches: TouchPointSnapshot[],
  changedTouches: TouchPointSnapshot[] = [],
): void {
  const evt = new Event(type, { bubbles: true, cancelable: true }) as Event & {
    touches: TouchPointSnapshot[];
    changedTouches: TouchPointSnapshot[];
  };
  Object.defineProperty(evt, 'touches', { configurable: true, value: touches });
  Object.defineProperty(evt, 'changedTouches', { configurable: true, value: changedTouches });
  target.dispatchEvent(evt);
}

describe('mobile-navigation-gestures', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
  });

  it.each([
    {
      label: 'swipe up -> serverPrev',
      direction: 'up',
      start: [
        { identifier: 1, clientX: 120, clientY: 300 },
        { identifier: 2, clientX: 180, clientY: 305 },
      ],
      move: [
        { identifier: 1, clientX: 124, clientY: 230 },
        { identifier: 2, clientX: 182, clientY: 235 },
      ],
      expected: 'serverPrev',
      keycaps: ['2F', '↑'],
    },
    {
      label: 'swipe down -> serverNext',
      direction: 'down',
      start: [
        { identifier: 1, clientX: 120, clientY: 200 },
        { identifier: 2, clientX: 180, clientY: 205 },
      ],
      move: [
        { identifier: 1, clientX: 118, clientY: 270 },
        { identifier: 2, clientX: 183, clientY: 275 },
      ],
      expected: 'serverNext',
      keycaps: ['2F', '↓'],
    },
    {
      label: 'swipe left -> tabPrev',
      direction: 'left',
      start: [
        { identifier: 1, clientX: 250, clientY: 300 },
        { identifier: 2, clientX: 255, clientY: 350 },
      ],
      move: [
        { identifier: 1, clientX: 180, clientY: 304 },
        { identifier: 2, clientX: 185, clientY: 352 },
      ],
      expected: 'tabPrev',
      keycaps: ['2F', '←'],
    },
    {
      label: 'swipe right -> tabNext',
      direction: 'right',
      start: [
        { identifier: 1, clientX: 100, clientY: 300 },
        { identifier: 2, clientX: 105, clientY: 350 },
      ],
      move: [
        { identifier: 1, clientX: 170, clientY: 298 },
        { identifier: 2, clientX: 175, clientY: 354 },
      ],
      expected: 'tabNext',
      keycaps: ['2F', '→'],
    },
  ])('recognizes $label only on release past threshold and enforces single-trigger latch until all fingers lift', ({ direction, start, move, expected, keycaps }) => {
    const progressEvents: Array<MobileNavigationGestureProgress | null> = [];
    const tracker = new TwoFingerSwipeTracker({
      onProgress: (p) => progressEvents.push(p),
    });

    tracker.onTouchStart({ touches: start });
    expect(progressEvents.at(-1)).toEqual({
      dx: 0,
      dy: 0,
      direction: null,
      action: null,
      distance: 0,
      threshold: MOBILE_SWIPE_PRIMARY_THRESHOLD_PX,
      progress: 0,
      armed: false,
    });

    // Does NOT trigger mid-drag on touchmove; instead arms progress state
    expect(tracker.onTouchMove({ touches: move })).toBeNull();
    expect(progressEvents.at(-1)).toMatchObject({
      direction,
      action: expected,
      threshold: MOBILE_SWIPE_PRIMARY_THRESHOLD_PX,
      progress: 1,
      armed: true,
    });
    expect(MOBILE_NAVIGATION_GESTURE_KEYCAPS[expected]).toEqual(keycaps);

    // Sequential lift: lifting 1 finger while armed triggers once and clears HUD
    expect(tracker.onTouchEnd({ touches: [move[0]!], changedTouches: [move[1]!] })).toBe(expected);
    expect(progressEvents.at(-1)).toBeNull();

    // Remaining movement and lifting 2nd finger must NOT re-trigger
    expect(tracker.onTouchMove({
      touches: [{ ...move[0]!, clientX: move[0]!.clientX + 50, clientY: move[0]!.clientY - 120 }],
    })).toBeNull();
    expect(tracker.onTouchEnd({ touches: [], changedTouches: [move[0]!] })).toBeNull();

    // Lifting all fingers resets so a fresh gesture works
    tracker.onTouchStart({ touches: start });
    expect(tracker.onTouchMove({ touches: move })).toBeNull();
    expect(tracker.onTouchEnd({ touches: [], changedTouches: move })).toBe(expected);
    expect(progressEvents.at(-1)).toBeNull();
  });

  it('ignores 1-finger scrolling, short jitter, single-finger stall, and diagonal ambiguity', () => {
    const progressEvents: Array<MobileNavigationGestureProgress | null> = [];
    const tracker = new TwoFingerSwipeTracker({
      onProgress: (p) => progressEvents.push(p),
    });

    // 1-finger scroll never shows HUD or triggers
    tracker.onTouchStart({ touches: [{ identifier: 1, clientX: 100, clientY: 100 }] });
    expect(tracker.onTouchMove({ touches: [{ identifier: 1, clientX: 100, clientY: 300 }] })).toBeNull();
    expect(tracker.onTouchEnd({ touches: [] })).toBeNull();
    expect(progressEvents).toEqual([]);

    // Short jitter (< 56px threshold) stays unarmed and does not trigger on release
    tracker.onTouchStart({
      touches: [
        { identifier: 1, clientX: 100, clientY: 200 },
        { identifier: 2, clientX: 150, clientY: 200 },
      ],
    });
    expect(tracker.onTouchMove({
      touches: [
        { identifier: 1, clientX: 100, clientY: 240 },
        { identifier: 2, clientX: 150, clientY: 240 },
      ],
    })).toBeNull();
    expect(progressEvents.at(-1)).toMatchObject({
      direction: 'down',
      action: 'serverNext',
      armed: false,
    });
    expect(progressEvents.at(-1)!.progress).toBeGreaterThan(0.5);
    expect(progressEvents.at(-1)!.progress).toBeLessThan(1);
    expect(tracker.onTouchEnd({ touches: [] })).toBeNull();
    expect(progressEvents.at(-1)).toBeNull();

    // One finger moves 110px, second finger stays < 28px (stalled) -> stays unarmed and rejected
    tracker.onTouchStart({
      touches: [
        { identifier: 1, clientX: 100, clientY: 200 },
        { identifier: 2, clientX: 150, clientY: 200 },
      ],
    });
    expect(tracker.onTouchMove({
      touches: [
        { identifier: 1, clientX: 100, clientY: 310 },
        { identifier: 2, clientX: 150, clientY: 215 },
      ],
    })).toBeNull();
    expect(progressEvents.at(-1)?.armed).toBe(false);
    expect(tracker.onTouchEnd({ touches: [] })).toBeNull();

    // Diagonal ambiguity (70px horizontal vs 65px vertical -> 70 < 65 * 1.35) -> no direction, unarmed
    tracker.onTouchStart({
      touches: [
        { identifier: 1, clientX: 100, clientY: 200 },
        { identifier: 2, clientX: 150, clientY: 200 },
      ],
    });
    expect(tracker.onTouchMove({
      touches: [
        { identifier: 1, clientX: 170, clientY: 265 },
        { identifier: 2, clientX: 220, clientY: 265 },
      ],
    })).toBeNull();
    expect(progressEvents.at(-1)).toMatchObject({
      direction: null,
      action: null,
      armed: false,
      progress: 0,
    });
    expect(tracker.onTouchEnd({ touches: [] })).toBeNull();
  });

  it('rejects pinch/spread, 3+ finger touches, pull-back below threshold, and resets cleanly on touchcancel', () => {
    const progressEvents: Array<MobileNavigationGestureProgress | null> = [];
    const tracker = new TwoFingerSwipeTracker({
      onProgress: (p) => progressEvents.push(p),
    });

    // Pinch spread on Y (one moves up, one moves down) -> locked out & HUD hidden even if both then move down
    tracker.onTouchStart({
      touches: [
        { identifier: 1, clientX: 120, clientY: 200 },
        { identifier: 2, clientX: 160, clientY: 210 },
      ],
    });
    expect(tracker.onTouchMove({
      touches: [
        { identifier: 1, clientX: 120, clientY: 180 },
        { identifier: 2, clientX: 160, clientY: 230 },
      ],
    })).toBeNull();
    expect(progressEvents.at(-1)).toBeNull();
    expect(tracker.onTouchMove({
      touches: [
        { identifier: 1, clientX: 120, clientY: 320 },
        { identifier: 2, clientX: 160, clientY: 320 },
      ],
    })).toBeNull();
    expect(tracker.onTouchEnd({ touches: [] })).toBeNull();

    // Slide past threshold (armed: true), then pull back below threshold (armed: false) before lifting -> NO trigger
    tracker.onTouchStart({
      touches: [
        { identifier: 1, clientX: 100, clientY: 200 },
        { identifier: 2, clientX: 150, clientY: 200 },
      ],
    });
    tracker.onTouchMove({
      touches: [
        { identifier: 1, clientX: 100, clientY: 280 },
        { identifier: 2, clientX: 150, clientY: 280 },
      ],
    });
    expect(progressEvents.at(-1)?.armed).toBe(true);
    tracker.onTouchMove({
      touches: [
        { identifier: 1, clientX: 100, clientY: 220 },
        { identifier: 2, clientX: 150, clientY: 220 },
      ],
    });
    expect(progressEvents.at(-1)?.armed).toBe(false);
    expect(tracker.onTouchEnd({ touches: [] })).toBeNull();
    expect(progressEvents.at(-1)).toBeNull();

    // 3rd finger touch locks out until all lift
    tracker.onTouchStart({
      touches: [
        { identifier: 1, clientX: 100, clientY: 200 },
        { identifier: 2, clientX: 150, clientY: 200 },
      ],
    });
    tracker.onTouchStart({
      touches: [
        { identifier: 1, clientX: 100, clientY: 200 },
        { identifier: 2, clientX: 150, clientY: 200 },
        { identifier: 3, clientX: 200, clientY: 200 },
      ],
    });
    expect(progressEvents.at(-1)).toBeNull();
    expect(tracker.onTouchMove({
      touches: [
        { identifier: 1, clientX: 100, clientY: 300 },
        { identifier: 2, clientX: 150, clientY: 300 },
      ],
    })).toBeNull();
    expect(tracker.onTouchEnd({ touches: [] })).toBeNull();

    // touchcancel while armed clears HUD and resets state so next gesture works immediately
    tracker.onTouchStart({
      touches: [
        { identifier: 1, clientX: 100, clientY: 200 },
        { identifier: 2, clientX: 150, clientY: 200 },
      ],
    });
    tracker.onTouchMove({
      touches: [
        { identifier: 1, clientX: 100, clientY: 280 },
        { identifier: 2, clientX: 150, clientY: 280 },
      ],
    });
    expect(progressEvents.at(-1)?.armed).toBe(true);
    tracker.onTouchCancel();
    expect(progressEvents.at(-1)).toBeNull();

    tracker.onTouchStart({
      touches: [
        { identifier: 1, clientX: 100, clientY: 200 },
        { identifier: 2, clientX: 150, clientY: 200 },
      ],
    });
    expect(tracker.onTouchMove({
      touches: [
        { identifier: 1, clientX: 100, clientY: 280 },
        { identifier: 2, clientX: 150, clientY: 280 },
      ],
    })).toBeNull();
    expect(tracker.onTouchEnd({ touches: [] })).toBe('serverNext');
  });

  it('blocks gestures when !isMobile or blocking overlays/surfaces are active', () => {
    const mainTarget = document.createElement('div');
    document.body.appendChild(mainTarget);

    expect(canHandleMobileNavigationGesture(mainTarget, { isMobile: false, document })).toBe(false);
    expect(canHandleMobileNavigationGesture(mainTarget, { isMobile: true, hasBlockingOverlay: true, document })).toBe(false);
    expect(canHandleMobileNavigationGesture(mainTarget, { isMobile: true, document })).toBe(true);

    // Mobile sidebar open
    const sidebar = document.createElement('div');
    sidebar.className = 'mobile-sidebar-overlay open';
    document.body.appendChild(sidebar);
    expect(canHandleMobileNavigationGesture(mainTarget, { isMobile: true, document })).toBe(false);
    sidebar.remove();

    // Dialog / modal
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    expect(canHandleMobileNavigationGesture(mainTarget, { isMobile: true, document })).toBe(false);
    dialog.remove();

    // ImageLightbox
    const lightbox = document.createElement('div');
    lightbox.className = 'fb-lightbox';
    document.body.appendChild(lightbox);
    expect(canHandleMobileNavigationGesture(mainTarget, { isMobile: true, document })).toBe(false);
    lightbox.remove();

    // Remote desktop surface target
    const remotePanel = document.createElement('div');
    remotePanel.className = 'remote-desktop-panel';
    const canvas = document.createElement('canvas');
    remotePanel.appendChild(canvas);
    document.body.appendChild(remotePanel);
    expect(canHandleMobileNavigationGesture(canvas, { isMobile: true, document })).toBe(false);
    remotePanel.remove();

    // Fullscreen element active
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: mainTarget });
    expect(canHandleMobileNavigationGesture(mainTarget, { isMobile: true, document })).toBe(false);
  });

  it('attaches capture listeners only when isMobile is true and stays resilient to child stopPropagation', () => {
    const desktopAction = vi.fn();
    const detachDesktop = attachMobileNavigationGestures({
      isMobile: false,
      onAction: desktopAction,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    dispatchTouch(host, 'touchstart', [
      { identifier: 1, clientX: 100, clientY: 200 },
      { identifier: 2, clientX: 150, clientY: 200 },
    ]);
    dispatchTouch(host, 'touchmove', [
      { identifier: 1, clientX: 100, clientY: 290 },
      { identifier: 2, clientX: 150, clientY: 290 },
    ]);
    dispatchTouch(host, 'touchend', []);
    expect(desktopAction).not.toHaveBeenCalled();
    detachDesktop();

    const mobileAction = vi.fn();
    host.addEventListener('touchend', (e) => e.stopPropagation());
    const detachMobile = attachMobileNavigationGestures({
      isMobile: true,
      onAction: mobileAction,
    });

    dispatchTouch(host, 'touchstart', [
      { identifier: 1, clientX: 100, clientY: 200 },
      { identifier: 2, clientX: 150, clientY: 200 },
    ]);
    dispatchTouch(host, 'touchmove', [
      { identifier: 1, clientX: 100, clientY: 120 },
      { identifier: 2, clientX: 150, clientY: 120 },
    ]);
    dispatchTouch(host, 'touchend', []);

    // Second gesture still works because capture touchend reset the latch despite host stopPropagation
    dispatchTouch(host, 'touchstart', [
      { identifier: 1, clientX: 200, clientY: 200 },
      { identifier: 2, clientX: 200, clientY: 250 },
    ]);
    dispatchTouch(host, 'touchmove', [
      { identifier: 1, clientX: 280, clientY: 200 },
      { identifier: 2, clientX: 280, clientY: 250 },
    ]);
    dispatchTouch(host, 'touchend', []);

    expect(mobileAction).toHaveBeenCalledTimes(2);
    expect(mobileAction).toHaveBeenNthCalledWith(1, 'serverPrev');
    expect(mobileAction).toHaveBeenNthCalledWith(2, 'tabNext');
    detachMobile();
  });

  it.each([
    {
      label: 'fast coalesced up -> serverPrev',
      start: [{ identifier: 1, clientX: 120, clientY: 280 }, { identifier: 2, clientX: 170, clientY: 282 }],
      subThresholdMove: [{ identifier: 1, clientX: 120, clientY: 245 }, { identifier: 2, clientX: 170, clientY: 247 }],
      endChanged: [{ identifier: 1, clientX: 120, clientY: 200 }, { identifier: 2, clientX: 170, clientY: 202 }],
      expected: 'serverPrev',
    },
    {
      label: 'fast coalesced down -> serverNext',
      start: [{ identifier: 1, clientX: 120, clientY: 200 }, { identifier: 2, clientX: 170, clientY: 202 }],
      subThresholdMove: [{ identifier: 1, clientX: 120, clientY: 240 }, { identifier: 2, clientX: 170, clientY: 242 }],
      endChanged: [{ identifier: 1, clientX: 120, clientY: 280 }, { identifier: 2, clientX: 170, clientY: 282 }],
      expected: 'serverNext',
    },
    {
      label: 'fast coalesced left -> tabPrev',
      start: [{ identifier: 1, clientX: 240, clientY: 200 }, { identifier: 2, clientX: 242, clientY: 250 }],
      subThresholdMove: [{ identifier: 1, clientX: 205, clientY: 200 }, { identifier: 2, clientX: 207, clientY: 250 }],
      endChanged: [{ identifier: 1, clientX: 160, clientY: 200 }, { identifier: 2, clientX: 162, clientY: 250 }],
      expected: 'tabPrev',
    },
    {
      label: 'fast coalesced right -> tabNext',
      start: [{ identifier: 1, clientX: 100, clientY: 200 }, { identifier: 2, clientX: 102, clientY: 250 }],
      subThresholdMove: [{ identifier: 1, clientX: 140, clientY: 200 }, { identifier: 2, clientX: 142, clientY: 250 }],
      endChanged: [{ identifier: 1, clientX: 180, clientY: 200 }, { identifier: 2, clientX: 182, clientY: 250 }],
      expected: 'tabNext',
    },
  ])('F1: evaluates $label when threshold is crossed only in touchend changedTouches', ({ start, subThresholdMove, endChanged, expected }) => {
    const actions: string[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const detach = attachMobileNavigationGestures({
      isMobile: true,
      onAction: (action) => actions.push(action),
    });

    dispatchTouch(host, 'touchstart', start);
    dispatchTouch(host, 'touchmove', subThresholdMove);
    expect(actions).toEqual([]);
    dispatchTouch(host, 'touchend', [], endChanged);
    expect(actions).toEqual([expected]);
    detach();
  });

  it('F1: handles sequential lift, blocks partner-below-threshold promotion, rejects coalesced pinch, and never duplicates touchmove trigger', () => {
    const actions: string[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const detach = attachMobileNavigationGestures({
      isMobile: true,
      onAction: (action) => actions.push(action),
    });

    // Sequential lift where both fingers already crossed threshold on first lift -> triggers once on first touchend, second lift is no-op
    dispatchTouch(host, 'touchstart', [{ identifier: 1, clientX: 100, clientY: 200 }, { identifier: 2, clientX: 150, clientY: 200 }]);
    dispatchTouch(
      host,
      'touchend',
      [{ identifier: 2, clientX: 150, clientY: 280 }],
      [{ identifier: 1, clientX: 100, clientY: 280 }],
    );
    expect(actions).toEqual(['serverNext']);
    dispatchTouch(host, 'touchmove', [{ identifier: 2, clientX: 150, clientY: 340 }]);
    dispatchTouch(host, 'touchend', [], [{ identifier: 2, clientX: 150, clientY: 360 }]);
    expect(actions).toEqual(['serverNext']);

    // Partner lifts below threshold (20px) -> remaining finger dragging further past 90px must NOT promote/trigger
    actions.length = 0;
    dispatchTouch(host, 'touchstart', [{ identifier: 1, clientX: 100, clientY: 200 }, { identifier: 2, clientX: 150, clientY: 200 }]);
    dispatchTouch(
      host,
      'touchend',
      [{ identifier: 2, clientX: 150, clientY: 220 }],
      [{ identifier: 1, clientX: 100, clientY: 220 }],
    );
    dispatchTouch(host, 'touchmove', [{ identifier: 2, clientX: 150, clientY: 310 }]);
    dispatchTouch(host, 'touchend', [], [{ identifier: 2, clientX: 150, clientY: 340 }]);
    expect(actions).toEqual([]);

    // Only triggers on touchend (not during touchmove), and still does not duplicate on subsequent touchend
    detach();
    actions.length = 0;
    const progressStates: Array<MobileNavigationGestureProgress | null> = [];
    const detachWithProgress = attachMobileNavigationGestures({
      isMobile: true,
      onAction: (action) => actions.push(action),
      onProgress: (p) => progressStates.push(p),
    });
    dispatchTouch(host, 'touchstart', [{ identifier: 1, clientX: 100, clientY: 200 }, { identifier: 2, clientX: 150, clientY: 200 }]);
    dispatchTouch(host, 'touchmove', [{ identifier: 1, clientX: 100, clientY: 280 }, { identifier: 2, clientX: 150, clientY: 280 }]);
    expect(actions).toEqual([]);
    expect(progressStates.at(-1)?.armed).toBe(true);
    dispatchTouch(host, 'touchend', [], [{ identifier: 1, clientX: 100, clientY: 300 }, { identifier: 2, clientX: 150, clientY: 300 }]);
    expect(actions).toEqual(['serverNext']);
    expect(progressStates.at(-1)).toBeNull();

    // Coalesced pinch/spread in touchend changedTouches stays rejected
    actions.length = 0;
    dispatchTouch(host, 'touchstart', [{ identifier: 1, clientX: 120, clientY: 200 }, { identifier: 2, clientX: 160, clientY: 200 }]);
    dispatchTouch(host, 'touchend', [], [{ identifier: 1, clientX: 120, clientY: 160 }, { identifier: 2, clientX: 160, clientY: 260 }]);
    expect(actions).toEqual([]);

    detachWithProgress();
  });

  it('F2: blocks VoiceOverlay and sibling role-less fullscreen overlays/backdrops while allowing non-blocking chat-history-overlay', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);

    // Exact VoiceOverlay DOM shape (even without role="dialog") + textarea child must block
    const backdrop = document.createElement('div');
    backdrop.className = 'voice-overlay-backdrop';
    const overlay = document.createElement('div');
    overlay.className = 'voice-overlay';
    const ta = document.createElement('textarea');
    overlay.appendChild(ta);
    document.body.appendChild(backdrop);
    document.body.appendChild(overlay);
    expect(canHandleMobileNavigationGesture(ta, { isMobile: true, document })).toBe(false);
    overlay.remove();
    backdrop.remove();
    expect(canHandleMobileNavigationGesture(target, { isMobile: true, document })).toBe(true);

    // Sibling role-less fullscreen overlays & backdrops across components
    for (const cls of [
      'mobile-server-menu',
      'ask-dialog-overlay',
      'fb-overlay',
      'mobile-fb-overlay',
      'fb-conflict-overlay',
      'html-fullscreen-preview',
      'onboarding-overlay',
      'openspec-auto-details-backdrop',
      'cloud-docs-modal-backdrop',
      'qp-backdrop',
      'controls-composer-backdrop',
      'peer-audit-overlay',
      'session-usage-backdrop',
      'modal-backdrop',
      'daemon-details-backdrop',
    ]) {
      const node = document.createElement('div');
      node.className = cls;
      document.body.appendChild(node);
      expect(canHandleMobileNavigationGesture(target, { isMobile: true, document })).toBe(false);
      node.remove();
    }

    // Non-blocking chat history status pill does NOT suppress gestures
    const statusPill = document.createElement('div');
    statusPill.className = 'chat-history-overlay';
    document.body.appendChild(statusPill);
    expect(canHandleMobileNavigationGesture(target, { isMobile: true, document })).toBe(true);
  });

  it('decouples bottom drag/scroll control surfaces and mixed-origin touches from 2-finger navigation', () => {
    const mainPane = document.createElement('div');
    mainPane.className = 'session-pane';
    document.body.appendChild(mainPane);

    // Every bottom control / scrollable strip / resize handle must return false from canHandleMobileNavigationGesture
    for (const selectorSpec of [
      { cls: 'controls-wrapper' },
      { cls: 'mobile-controls' },
      { cls: 'subcard-bar' },
      { cls: 'subsession-bar' },
      { cls: 'subsession-strip' },
      { cls: 'subcard-scroll' },
      { cls: 'subsession-row-with-close' },
      { cls: 'subsession-close-all-strip' },
      { cls: 'team-discussion-bottom' },
      { cls: 'shortcuts-row' },
      { cls: 'shortcuts' },
      { cls: 'shortcuts-meta-scroll' },
      { cls: 'shortcut-dpad' },
      { cls: 'tab-bar' },
      { attr: ['data-mobile-gesture-ignore', 'true'] as const },
      { cls: 'resize-hover-surface' },
      { attr: ['data-resize-handle', 'true'] as const },
    ]) {
      const container = document.createElement('div');
      if ('cls' in selectorSpec && selectorSpec.cls) container.className = selectorSpec.cls;
      if ('attr' in selectorSpec && selectorSpec.attr) {
        container.setAttribute(selectorSpec.attr[0], selectorSpec.attr[1]);
      }
      const btn = document.createElement('button');
      const textNode = document.createTextNode('item');
      btn.appendChild(textNode);
      container.appendChild(btn);
      document.body.appendChild(container);

      expect(canHandleMobileNavigationGesture(container, { isMobile: true, document })).toBe(false);
      expect(canHandleMobileNavigationGesture(btn, { isMobile: true, document })).toBe(false);
      // Mobile WebKit can report a Text node inside a button as touch target
      expect(canHandleMobileNavigationGesture(textNode, { isMobile: true, document })).toBe(false);

      // Legitimate swipe on mainPane still works
      expect(canHandleMobileNavigationGesture(mainPane, { isMobile: true, document })).toBe(true);
      container.remove();
    }

    // End-to-end mixed-origin touch tests through attachMobileNavigationGestures
    const controls = document.createElement('div');
    controls.className = 'controls-wrapper';
    const subScroll = document.createElement('div');
    subScroll.className = 'subcard-scroll';
    const tabBar = document.createElement('div');
    tabBar.className = 'tab-bar';
    document.body.appendChild(controls);
    document.body.appendChild(subScroll);
    document.body.appendChild(tabBar);

    const actions: string[] = [];
    const progressLog: Array<MobileNavigationGestureProgress | null> = [];
    const detach = attachMobileNavigationGestures({
      isMobile: true,
      onAction: (a) => actions.push(a),
      onProgress: (p) => progressLog.push(p),
    });

    // 1) Both fingers inside .controls-wrapper -> ignored, no HUD
    dispatchTouch(controls, 'touchstart', [{ identifier: 1, clientX: 100, clientY: 500 }, { identifier: 2, clientX: 150, clientY: 500 }]);
    dispatchTouch(controls, 'touchmove', [{ identifier: 1, clientX: 200, clientY: 500 }, { identifier: 2, clientX: 250, clientY: 500 }]);
    dispatchTouch(controls, 'touchend', [], [{ identifier: 1, clientX: 200, clientY: 500 }, { identifier: 2, clientX: 250, clientY: 500 }]);
    expect(actions).toEqual([]);
    expect(progressLog).toEqual([]);

    // 2) Finger 1 starts inside .subcard-scroll, Finger 2 lands on .session-pane -> NOT hijacked
    dispatchTouch(subScroll, 'touchstart', [{ identifier: 1, clientX: 100, clientY: 450 }]);
    dispatchTouch(mainPane, 'touchstart', [{ identifier: 1, clientX: 100, clientY: 450 }, { identifier: 2, clientX: 150, clientY: 300 }]);
    dispatchTouch(mainPane, 'touchmove', [{ identifier: 1, clientX: 100, clientY: 350 }, { identifier: 2, clientX: 150, clientY: 200 }]);
    dispatchTouch(mainPane, 'touchend', []);
    expect(actions).toEqual([]);
    expect(progressLog).toEqual([]);

    // 3) Finger 1 starts on .session-pane, Finger 2 lands on .controls-wrapper -> NOT hijacked
    dispatchTouch(mainPane, 'touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]);
    dispatchTouch(controls, 'touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }, { identifier: 2, clientX: 150, clientY: 500 }]);
    dispatchTouch(mainPane, 'touchmove', [{ identifier: 1, clientX: 200, clientY: 300 }, { identifier: 2, clientX: 250, clientY: 500 }]);
    dispatchTouch(mainPane, 'touchend', []);
    expect(actions).toEqual([]);
    expect(progressLog).toEqual([]);

    // 4) Simultaneous 2-finger touchstart where event.target is mainPane, but touches[1].target is .tab-bar -> NOT hijacked
    dispatchTouch(mainPane, 'touchstart', [
      { identifier: 1, clientX: 100, clientY: 200, target: mainPane },
      { identifier: 2, clientX: 150, clientY: 40, target: tabBar },
    ]);
    dispatchTouch(mainPane, 'touchmove', [
      { identifier: 1, clientX: 200, clientY: 200, target: mainPane },
      { identifier: 2, clientX: 250, clientY: 40, target: tabBar },
    ]);
    dispatchTouch(mainPane, 'touchend', []);
    expect(actions).toEqual([]);
    expect(progressLog).toEqual([]);

    // 5) Subsequent clean 2-finger gesture on .session-pane recovers and triggers normally
    dispatchTouch(mainPane, 'touchstart', [{ identifier: 1, clientX: 100, clientY: 200 }, { identifier: 2, clientX: 150, clientY: 200 }]);
    dispatchTouch(mainPane, 'touchmove', [{ identifier: 1, clientX: 100, clientY: 120 }, { identifier: 2, clientX: 150, clientY: 120 }]);
    expect(progressLog.at(-1)?.armed).toBe(true);
    dispatchTouch(mainPane, 'touchend', []);
    expect(actions).toEqual(['serverPrev']);
    expect(progressLog.at(-1)).toBeNull();

    detach();
  });
});
