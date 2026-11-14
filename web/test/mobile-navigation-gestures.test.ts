/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  MOBILE_NAVIGATION_GESTURE_KEYCAPS,
  TwoFingerSwipeTracker,
  attachMobileNavigationGestures,
  canHandleMobileNavigationGesture,
  type TouchPointSnapshot,
} from '../src/mobile-navigation-gestures.js';

function dispatchTouch(
  target: EventTarget,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  touches: TouchPointSnapshot[],
): void {
  const evt = new Event(type, { bubbles: true, cancelable: true }) as Event & {
    touches: TouchPointSnapshot[];
  };
  Object.defineProperty(evt, 'touches', { configurable: true, value: touches });
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
  ])('recognizes $label and enforces single-trigger latch until fingers lift', ({ start, move, expected, keycaps }) => {
    const tracker = new TwoFingerSwipeTracker();
    tracker.onTouchStart({ touches: start });
    expect(tracker.onTouchMove({ touches: move })).toBe(expected);
    expect(MOBILE_NAVIGATION_GESTURE_KEYCAPS[expected]).toEqual(keycaps);

    // Further movement in the same gesture must NOT re-trigger
    expect(tracker.onTouchMove({
      touches: move.map((pt) => ({ ...pt, clientX: pt.clientX + 50, clientY: pt.clientY + 50 })),
    })).toBeNull();

    // Lifting only 1 finger does not unlock a new trigger
    tracker.onTouchEnd({ touches: [move[0]!] });
    expect(tracker.onTouchMove({
      touches: move.map((pt) => ({ ...pt, clientY: pt.clientY - 120 })),
    })).toBeNull();

    // Lifting all fingers resets so a fresh gesture works
    tracker.onTouchEnd({ touches: [] });
    tracker.onTouchStart({ touches: start });
    expect(tracker.onTouchMove({ touches: move })).toBe(expected);
  });

  it('ignores 1-finger scrolling, short jitter, single-finger stall, and diagonal ambiguity', () => {
    const tracker = new TwoFingerSwipeTracker();

    // 1-finger scroll
    tracker.onTouchStart({ touches: [{ identifier: 1, clientX: 100, clientY: 100 }] });
    expect(tracker.onTouchMove({ touches: [{ identifier: 1, clientX: 100, clientY: 300 }] })).toBeNull();
    tracker.onTouchEnd({ touches: [] });

    // Short jitter (< 48px average)
    tracker.onTouchStart({
      touches: [
        { identifier: 1, clientX: 100, clientY: 200 },
        { identifier: 2, clientX: 150, clientY: 200 },
      ],
    });
    expect(tracker.onTouchMove({
      touches: [
        { identifier: 1, clientX: 100, clientY: 235 },
        { identifier: 2, clientX: 150, clientY: 235 },
      ],
    })).toBeNull();
    tracker.onTouchEnd({ touches: [] });

    // One finger moves 90px, second finger stays < 28px (stalled) -> rejected
    tracker.onTouchStart({
      touches: [
        { identifier: 1, clientX: 100, clientY: 200 },
        { identifier: 2, clientX: 150, clientY: 200 },
      ],
    });
    expect(tracker.onTouchMove({
      touches: [
        { identifier: 1, clientX: 100, clientY: 290 },
        { identifier: 2, clientX: 150, clientY: 215 },
      ],
    })).toBeNull();
    tracker.onTouchEnd({ touches: [] });

    // Diagonal ambiguity (60px horizontal vs 55px vertical -> 60 < 55 * 1.35)
    tracker.onTouchStart({
      touches: [
        { identifier: 1, clientX: 100, clientY: 200 },
        { identifier: 2, clientX: 150, clientY: 200 },
      ],
    });
    expect(tracker.onTouchMove({
      touches: [
        { identifier: 1, clientX: 160, clientY: 255 },
        { identifier: 2, clientX: 210, clientY: 255 },
      ],
    })).toBeNull();
  });

  it('rejects pinch/spread, 3+ finger touches, and resets cleanly on touchcancel', () => {
    const tracker = new TwoFingerSwipeTracker();

    // Pinch spread on Y (one moves up, one moves down) -> locked out even if both then move down
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
    expect(tracker.onTouchMove({
      touches: [
        { identifier: 1, clientX: 120, clientY: 320 },
        { identifier: 2, clientX: 160, clientY: 320 },
      ],
    })).toBeNull();
    tracker.onTouchEnd({ touches: [] });

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
    expect(tracker.onTouchMove({
      touches: [
        { identifier: 1, clientX: 100, clientY: 300 },
        { identifier: 2, clientX: 150, clientY: 300 },
      ],
    })).toBeNull();
    tracker.onTouchEnd({ touches: [] });

    // touchcancel resets state so next gesture works immediately
    tracker.onTouchStart({
      touches: [
        { identifier: 1, clientX: 100, clientY: 200 },
        { identifier: 2, clientX: 150, clientY: 200 },
      ],
    });
    tracker.onTouchCancel();
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
    })).toBe('serverNext');
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
});
