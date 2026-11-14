/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  MOBILE_LONG_PRESS_DRAG_START_PX,
  MOBILE_LONG_PRESS_MS,
  MOBILE_LONG_PRESS_STILL_TOLERANCE_PX,
  MOBILE_NAV_GESTURE_ACTIVE_CLASS,
  MOBILE_NAVIGATION_GESTURE_KEYCAPS,
  MOBILE_SWIPE_HORIZONTAL_MAX_STEPS,
  MOBILE_SWIPE_PRIMARY_THRESHOLD_PX,
  MOBILE_SWIPE_STEP_BAND_HORIZONTAL_PX,
  MOBILE_SWIPE_STEP_BAND_VERTICAL_PX,
  MOBILE_SWIPE_STEP_HYSTERESIS_PX,
  MOBILE_SWIPE_VERTICAL_MAX_STEPS_DEFAULT,
  MOBILE_SWIPE_VERTICAL_MAX_STEPS_MEDIUM,
  MOBILE_SWIPE_VERTICAL_MAX_STEPS_TALL,
  TwoFingerSwipeTracker,
  attachMobileNavigationGestures,
  canHandleMobileNavigationGesture,
  getMobileNavigationGestureKeycaps,
  getMobileSwipeStepThresholdPx,
  isMobileNavigationGestureActive,
  resolveMobileSwipeVerticalMaxSteps,
  type MobileNavigationAction,
  type MobileNavigationGestureProgress,
  type TouchPointSnapshot,
} from '../src/mobile-navigation-gestures.js';

function dispatchTouch(
  target: EventTarget,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  touches: TouchPointSnapshot[],
  changedTouches: TouchPointSnapshot[] = [],
): Event {
  const evt = new Event(type, { bubbles: true, cancelable: true }) as Event & {
    touches: TouchPointSnapshot[];
    changedTouches: TouchPointSnapshot[];
  };
  Object.defineProperty(evt, 'touches', { configurable: true, value: touches });
  Object.defineProperty(evt, 'changedTouches', { configurable: true, value: changedTouches });
  target.dispatchEvent(evt);
  return evt;
}

describe('mobile-navigation-gestures', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    document.documentElement.className = '';
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
  });

  it('removes 2F keycaps and formats single/multi-step keycaps cleanly', () => {
    expect(MOBILE_NAVIGATION_GESTURE_KEYCAPS).toEqual({
      serverPrev: ['↑'],
      serverNext: ['↓'],
      tabPrev: ['←'],
      tabNext: ['→'],
    });
    expect(JSON.stringify(MOBILE_NAVIGATION_GESTURE_KEYCAPS)).not.toContain('2F');
    expect(getMobileNavigationGestureKeycaps('serverPrev', 1)).toEqual(['↑']);
    expect(getMobileNavigationGestureKeycaps('serverNext', 3)).toEqual(['↓', '×3']);
    expect(getMobileNavigationGestureKeycaps('tabPrev', 2)).toEqual(['←', '×2']);
    expect(getMobileNavigationGestureKeycaps('tabNext', 1)).toEqual(['→']);
  });

  it('resolves vertical max steps from viewport height breakpoints', () => {
    expect(resolveMobileSwipeVerticalMaxSteps(undefined)).toBe(MOBILE_SWIPE_VERTICAL_MAX_STEPS_DEFAULT);
    expect(resolveMobileSwipeVerticalMaxSteps(568)).toBe(3);
    expect(resolveMobileSwipeVerticalMaxSteps(739)).toBe(3);
    expect(resolveMobileSwipeVerticalMaxSteps(740)).toBe(MOBILE_SWIPE_VERTICAL_MAX_STEPS_MEDIUM);
    expect(resolveMobileSwipeVerticalMaxSteps(799)).toBe(4);
    expect(resolveMobileSwipeVerticalMaxSteps(800)).toBe(MOBILE_SWIPE_VERTICAL_MAX_STEPS_TALL);
    expect(resolveMobileSwipeVerticalMaxSteps(932)).toBe(5);

    expect(getMobileSwipeStepThresholdPx(1, true)).toBe(MOBILE_SWIPE_PRIMARY_THRESHOLD_PX);
    expect(getMobileSwipeStepThresholdPx(2, true)).toBe(56 + MOBILE_SWIPE_STEP_BAND_VERTICAL_PX);
    expect(getMobileSwipeStepThresholdPx(5, true)).toBe(56 + 4 * MOBILE_SWIPE_STEP_BAND_VERTICAL_PX);
    expect(getMobileSwipeStepThresholdPx(2, false)).toBe(56 + MOBILE_SWIPE_STEP_BAND_HORIZONTAL_PX);
    expect(getMobileSwipeStepThresholdPx(3, false)).toBe(56 + 2 * MOBILE_SWIPE_STEP_BAND_HORIZONTAL_PX);
  });

  it.each([
    { label: 'swipe up -> serverPrev', direction: 'up' as const, dx: 0, dy: -70, expected: 'serverPrev' as const },
    { label: 'swipe down -> serverNext', direction: 'down' as const, dx: 0, dy: 70, expected: 'serverNext' as const },
    { label: 'swipe left -> tabPrev', direction: 'left' as const, dx: -70, dy: 0, expected: 'tabPrev' as const },
    { label: 'swipe right -> tabNext', direction: 'right' as const, dx: 70, dy: 0, expected: 'tabNext' as const },
  ])('recognizes 1-finger long-press + drag $label only on release past threshold', ({ direction, dx, dy, expected }) => {
    vi.useFakeTimers();
    const progressEvents: Array<MobileNavigationGestureProgress | null> = [];
    const tracker = new TwoFingerSwipeTracker({
      viewportHeight: 667,
      onProgress: (p) => progressEvents.push(p),
    });

    tracker.onTouchStart({ touches: [{ identifier: 1, clientX: 160, clientY: 300 }] });
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    expect(progressEvents).toEqual([]);

    // Move just past dragStartPx -> enters tracking unarmed
    const scaleStart = (MOBILE_LONG_PRESS_DRAG_START_PX + 4) / Math.hypot(dx, dy);
    expect(tracker.onTouchMove({
      touches: [{ identifier: 1, clientX: 160 + dx * scaleStart, clientY: 300 + dy * scaleStart }],
    })).toBeNull();
    expect(progressEvents.at(-1)).toMatchObject({
      direction,
      action: expected,
      threshold: MOBILE_SWIPE_PRIMARY_THRESHOLD_PX,
      armed: false,
      step: 0,
    });

    // Move past step-1 threshold -> arms step 1 without firing during touchmove
    expect(tracker.onTouchMove({
      touches: [{ identifier: 1, clientX: 160 + dx, clientY: 300 + dy }],
    })).toBeNull();
    expect(progressEvents.at(-1)).toMatchObject({
      direction,
      action: expected,
      progress: 1,
      armed: true,
      step: 1,
      maxSteps: 3,
    });

    // Triggers on release and clears HUD
    const trigger = tracker.evaluateTouchEnd({
      touches: [],
      changedTouches: [{ identifier: 1, clientX: 160 + dx, clientY: 300 + dy }],
    });
    expect(trigger).toEqual({ action: expected, step: 1 });
    expect(progressEvents.at(-1)).toBeNull();
  });

  it('tracks multi-level steps horizontally (max 3) and vertically (3 default, 4 at >=740px, 5 at >=800px)', () => {
    vi.useFakeTimers();
    const runDrag = (viewportHeight: number, dx: number, dy: number, availableSteps?: number) => {
      const progressEvents: Array<MobileNavigationGestureProgress | null> = [];
      const tracker = new TwoFingerSwipeTracker({
        viewportHeight,
        getAvailableSteps: availableSteps !== undefined ? () => availableSteps : undefined,
        onProgress: (p) => progressEvents.push(p),
      });
      tracker.onTouchStart({ touches: [{ identifier: 1, clientX: 180, clientY: 400 }] });
      vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
      tracker.onTouchMove({ touches: [{ identifier: 1, clientX: 180 + dx, clientY: 400 + dy }] });
      const latest = progressEvents.at(-1);
      const trigger = tracker.evaluateTouchEnd({
        touches: [],
        changedTouches: [{ identifier: 1, clientX: 180 + dx, clientY: 400 + dy }],
      });
      return { latest, trigger };
    };

    // Horizontal maxes at 3 even on tall 900px screen
    expect(runDrag(900, 60, 0).trigger).toEqual({ action: 'tabNext', step: 1 });
    expect(runDrag(900, 105, 0).trigger).toEqual({ action: 'tabNext', step: 2 });
    expect(runDrag(900, 150, 0).trigger).toEqual({ action: 'tabNext', step: 3 });
    expect(runDrag(900, 260, 0).trigger).toEqual({ action: 'tabNext', step: 3 });
    expect(runDrag(900, -150, 0).latest?.horizontalMaxSteps).toBe(MOBILE_SWIPE_HORIZONTAL_MAX_STEPS);

    // Vertical: 667px -> 3 levels; 760px -> 4 levels; 844px -> 5 levels
    expect(runDrag(667, 0, 250).trigger).toEqual({ action: 'serverNext', step: 3 });
    expect(runDrag(760, 0, -250).trigger).toEqual({ action: 'serverPrev', step: 4 });
    expect(runDrag(844, 0, -245).trigger).toEqual({ action: 'serverPrev', step: 5 });

    // Available step count clamps max reached step cleanly and zero blocks triggers
    expect(runDrag(844, 0, 250, 2).trigger).toEqual({ action: 'serverNext', step: 2 });
    const zeroAvail = runDrag(844, 0, 150, 0);
    expect(zeroAvail.trigger).toBeNull();
    expect(zeroAvail.latest).toMatchObject({ direction: 'down', armed: false, step: 0, maxSteps: 0 });
  });

  it('applies boundary hysteresis so small hand jitter never oscillates tiers or falsely arms/disarms', () => {
    vi.useFakeTimers();
    const progressEvents: Array<MobileNavigationGestureProgress | null> = [];
    const tracker = new TwoFingerSwipeTracker({
      viewportHeight: 844,
      onProgress: (p) => progressEvents.push(p),
    });

    tracker.onTouchStart({ touches: [{ identifier: 1, clientX: 200, clientY: 400 }] });
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);

    // Cross into vertical step 2 (>= 102px)
    tracker.onTouchMove({ touches: [{ identifier: 1, clientX: 200, clientY: 296 }] }); // dy = -104 -> step 2
    expect(progressEvents.at(-1)?.step).toBe(2);

    // Slight jitter back above 102 - 8 = 94px stays locked on step 2
    tracker.onTouchMove({ touches: [{ identifier: 1, clientX: 200, clientY: 304 }] }); // dy = -96
    expect(progressEvents.at(-1)?.step).toBe(2);

    // Deliberate pull below hysteresis floor (93 < 94) drops to step 1
    tracker.onTouchMove({ touches: [{ identifier: 1, clientX: 200, clientY: 307 }] }); // dy = -93
    expect(progressEvents.at(-1)?.step).toBe(1);

    // Minor jitter inside step-1 hysteresis (>= 56 - 8 = 48px) stays on step 1
    tracker.onTouchMove({ touches: [{ identifier: 1, clientX: 200, clientY: 350 }] }); // dy = -50
    expect(progressEvents.at(-1)?.step).toBe(1);
    expect(progressEvents.at(-1)?.armed).toBe(true);

    // Pulling back further (< 48px) disarms cleanly and triggers nothing on release
    tracker.onTouchMove({ touches: [{ identifier: 1, clientX: 200, clientY: 353 }] }); // dy = -47
    expect(progressEvents.at(-1)?.step).toBe(0);
    expect(progressEvents.at(-1)?.armed).toBe(false);
    expect(MOBILE_SWIPE_STEP_HYSTERESIS_PX).toBe(8);
    expect(tracker.evaluateTouchEnd({ touches: [] })).toBeNull();
    expect(progressEvents.at(-1)).toBeNull();
  });

  it('completely disables 2-finger and 3+ finger touches across idle, pending, ready, and active tracking', () => {
    vi.useFakeTimers();
    const progressEvents: Array<MobileNavigationGestureProgress | null> = [];
    const activeStates: boolean[] = [];
    const tracker = new TwoFingerSwipeTracker({
      viewportHeight: 844,
      onProgress: (p) => progressEvents.push(p),
      onActiveChange: (active) => activeStates.push(active),
    });

    // 1) Direct 2-finger swipe does nothing
    tracker.onTouchStart({
      touches: [
        { identifier: 1, clientX: 120, clientY: 200 },
        { identifier: 2, clientX: 180, clientY: 205 },
      ],
    });
    expect(tracker.onTouchMove({
      touches: [
        { identifier: 1, clientX: 120, clientY: 340 },
        { identifier: 2, clientX: 180, clientY: 345 },
      ],
    })).toBeNull();
    expect(tracker.evaluateTouchEnd({ touches: [] })).toBeNull();
    expect(progressEvents).toEqual([]);
    expect(activeStates).toEqual([]);

    // 2) Adding 2nd finger while actively tracking 1-finger drag immediately cancels HUD & locks out
    tracker.onTouchStart({ touches: [{ identifier: 1, clientX: 120, clientY: 200 }] });
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    tracker.onTouchMove({ touches: [{ identifier: 1, clientX: 120, clientY: 280 }] });
    expect(progressEvents.at(-1)?.armed).toBe(true);
    expect(tracker.isActive()).toBe(true);

    tracker.onTouchStart({
      touches: [
        { identifier: 1, clientX: 120, clientY: 280 },
        { identifier: 2, clientX: 180, clientY: 280 },
      ],
    });
    expect(tracker.isActive()).toBe(false);
    expect(progressEvents.at(-1)).toBeNull();
    expect(tracker.onTouchEnd({ touches: [{ identifier: 1, clientX: 120, clientY: 280 }] })).toBeNull();
    expect(tracker.onTouchEnd({ touches: [] })).toBeNull();

    // 3) 3-finger touch also locks out
    tracker.onTouchStart({
      touches: [
        { identifier: 1, clientX: 100, clientY: 200 },
        { identifier: 2, clientX: 150, clientY: 200 },
        { identifier: 3, clientX: 200, clientY: 200 },
      ],
    });
    expect(tracker.onTouchEnd({ touches: [] })).toBeNull();
  });

  it('ignores 1-finger scrolling, short jitter, diagonal ambiguity, and resets cleanly on touchcancel', () => {
    vi.useFakeTimers();
    const progressEvents: Array<MobileNavigationGestureProgress | null> = [];
    const tracker = new TwoFingerSwipeTracker({
      onProgress: (p) => progressEvents.push(p),
    });

    // Normal 1-finger scroll never shows HUD or triggers
    tracker.onTouchStart({ touches: [{ identifier: 1, clientX: 100, clientY: 100 }] });
    expect(tracker.onTouchMove({ touches: [{ identifier: 1, clientX: 100, clientY: 300 }] })).toBeNull();
    expect(tracker.onTouchEnd({ touches: [] })).toBeNull();
    expect(progressEvents).toEqual([]);

    // Diagonal ambiguity after long-press -> no direction, unarmed
    tracker.onTouchStart({ touches: [{ identifier: 1, clientX: 100, clientY: 200 }] });
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    tracker.onTouchMove({ touches: [{ identifier: 1, clientX: 170, clientY: 265 }] });
    expect(progressEvents.at(-1)).toMatchObject({
      direction: null,
      action: null,
      armed: false,
      step: 0,
      progress: 0,
    });
    expect(tracker.onTouchEnd({ touches: [] })).toBeNull();

    // touchcancel while armed clears HUD and resets so next gesture works immediately
    tracker.onTouchStart({ touches: [{ identifier: 1, clientX: 100, clientY: 200 }] });
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    tracker.onTouchMove({ touches: [{ identifier: 1, clientX: 100, clientY: 280 }] });
    expect(progressEvents.at(-1)?.armed).toBe(true);
    tracker.onTouchCancel();
    expect(progressEvents.at(-1)).toBeNull();

    tracker.onTouchStart({ touches: [{ identifier: 1, clientX: 100, clientY: 200 }] });
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    tracker.onTouchMove({ touches: [{ identifier: 1, clientX: 100, clientY: 280 }] });
    expect(tracker.onTouchEnd({ touches: [] })).toBe('serverNext');
  });

  it('blocks gestures when !isMobile or blocking overlays/surfaces are active', () => {
    const mainTarget = document.createElement('div');
    document.body.appendChild(mainTarget);

    expect(canHandleMobileNavigationGesture(mainTarget, { isMobile: false, document })).toBe(false);
    expect(canHandleMobileNavigationGesture(mainTarget, { isMobile: true, hasBlockingOverlay: true, document })).toBe(false);
    expect(canHandleMobileNavigationGesture(mainTarget, { isMobile: true, document })).toBe(true);

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    expect(canHandleMobileNavigationGesture(mainTarget, { isMobile: true, document })).toBe(false);
    dialog.remove();

    const sidebar = document.createElement('div');
    sidebar.className = 'mobile-sidebar-overlay open';
    document.body.appendChild(sidebar);
    expect(canHandleMobileNavigationGesture(mainTarget, { isMobile: true, document })).toBe(false);
    sidebar.remove();

    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: mainTarget });
    expect(canHandleMobileNavigationGesture(mainTarget, { isMobile: true, document })).toBe(false);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });

    const input = document.createElement('textarea');
    document.body.appendChild(input);
    expect(canHandleMobileNavigationGesture(input, { isMobile: true, document })).toBe(false);
  });

  it('attaches capture listeners only when isMobile is true and stays resilient to child stopPropagation', () => {
    vi.useFakeTimers();
    const desktopAction = vi.fn();
    const detachDesktop = attachMobileNavigationGestures({
      isMobile: false,
      onAction: desktopAction,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    dispatchTouch(host, 'touchstart', [{ identifier: 1, clientX: 100, clientY: 200 }]);
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    dispatchTouch(host, 'touchmove', [{ identifier: 1, clientX: 100, clientY: 290 }]);
    dispatchTouch(host, 'touchend', []);
    expect(desktopAction).not.toHaveBeenCalled();
    detachDesktop();

    const mobileAction = vi.fn();
    host.addEventListener('touchend', (e) => e.stopPropagation());
    const detachMobile = attachMobileNavigationGestures({
      isMobile: true,
      viewportHeight: 844,
      onAction: mobileAction,
    });

    dispatchTouch(host, 'touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]);
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    dispatchTouch(host, 'touchmove', [{ identifier: 1, clientX: 100, clientY: 190 }]); // -110px -> step 2
    dispatchTouch(host, 'touchend', []);

    dispatchTouch(host, 'touchstart', [{ identifier: 2, clientX: 200, clientY: 200 }]);
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    dispatchTouch(host, 'touchmove', [{ identifier: 2, clientX: 280, clientY: 200 }]); // +80px -> step 1
    dispatchTouch(host, 'touchend', []);

    expect(mobileAction).toHaveBeenCalledTimes(2);
    expect(mobileAction).toHaveBeenNthCalledWith(1, 'serverPrev', 2);
    expect(mobileAction).toHaveBeenNthCalledWith(2, 'tabNext', 1);
    detachMobile();
  });

  it('F1: evaluates step from touchend changedTouches and never duplicates during touchmove', () => {
    vi.useFakeTimers();
    const actions: Array<{ action: MobileNavigationAction; step: number }> = [];
    const progressStates: Array<MobileNavigationGestureProgress | null> = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const detach = attachMobileNavigationGestures({
      isMobile: true,
      viewportHeight: 844,
      onAction: (action, step) => actions.push({ action, step }),
      onProgress: (p) => progressStates.push(p),
    });

    dispatchTouch(host, 'touchstart', [{ identifier: 1, clientX: 120, clientY: 200 }]);
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    dispatchTouch(host, 'touchmove', [{ identifier: 1, clientX: 120, clientY: 225 }]);
    expect(actions).toEqual([]);
    expect(progressStates.at(-1)?.armed).toBe(false);
    dispatchTouch(host, 'touchend', [], [{ identifier: 1, clientX: 120, clientY: 355 }]); // 155px down -> step 3
    expect(actions).toEqual([{ action: 'serverNext', step: 3 }]);
    expect(progressStates.at(-1)).toBeNull();
    detach();
  });

  it('F2: blocks VoiceOverlay and sibling role-less fullscreen overlays/backdrops while allowing non-blocking chat-history-overlay', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);

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

    const statusPill = document.createElement('div');
    statusPill.className = 'chat-history-overlay';
    document.body.appendChild(statusPill);
    expect(canHandleMobileNavigationGesture(target, { isMobile: true, document })).toBe(true);
  });

  it('decouples bottom drag/scroll control surfaces from mobile navigation', () => {
    const mainPane = document.createElement('div');
    mainPane.className = 'session-pane';
    document.body.appendChild(mainPane);

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
      expect(canHandleMobileNavigationGesture(textNode, { isMobile: true, document })).toBe(false);
      expect(canHandleMobileNavigationGesture(mainPane, { isMobile: true, document })).toBe(true);
      container.remove();
    }
  });

  it('recovers across consecutive swipes on DOM unmount, blur, and visibilitychange', () => {
    vi.useFakeTimers();
    const actions: Array<{ action: MobileNavigationAction; step: number }> = [];
    let currentPane = document.createElement('div');
    currentPane.className = 'session-pane';
    document.body.appendChild(currentPane);

    const detach = attachMobileNavigationGestures({
      isMobile: true,
      viewportHeight: 844,
      onAction: (action, step) => {
        actions.push({ action, step });
        currentPane.remove();
        currentPane = document.createElement('div');
        currentPane.className = 'session-pane';
        document.body.appendChild(currentPane);
      },
    });

    dispatchTouch(currentPane, 'touchstart', [{ identifier: 1, clientX: 250, clientY: 300, target: currentPane }]);
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    dispatchTouch(currentPane, 'touchmove', [{ identifier: 1, clientX: 135, clientY: 300, target: currentPane }]); // 115px left -> step 2
    dispatchTouch(currentPane, 'touchend', []);
    expect(actions).toEqual([{ action: 'tabPrev', step: 2 }]);

    // Interrupted sequence heals cleanly on blur
    dispatchTouch(currentPane, 'touchstart', [{ identifier: 2, clientX: 100, clientY: 300, target: currentPane }]);
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    dispatchTouch(currentPane, 'touchmove', [{ identifier: 2, clientX: 100, clientY: 220, target: currentPane }]);
    expect(isMobileNavigationGestureActive(document)).toBe(true);
    window.dispatchEvent(new Event('blur'));
    expect(isMobileNavigationGestureActive(document)).toBe(false);

    // Next sequence heals after visibilitychange
    dispatchTouch(currentPane, 'touchstart', [{ identifier: 3, clientX: 100, clientY: 300, target: currentPane }]);
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    dispatchTouch(currentPane, 'touchmove', [{ identifier: 3, clientX: 100, clientY: 140, target: currentPane }]); // 160px up -> step 3
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(isMobileNavigationGestureActive(document)).toBe(false);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));

    dispatchTouch(currentPane, 'touchstart', [{ identifier: 4, clientX: 100, clientY: 300, target: currentPane }]);
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    dispatchTouch(currentPane, 'touchmove', [{ identifier: 4, clientX: 100, clientY: 380, target: currentPane }]);
    dispatchTouch(currentPane, 'touchend', []);
    expect(actions).toEqual([
      { action: 'tabPrev', step: 2 },
      { action: 'serverNext', step: 1 },
    ]);
    detach();
  });

  it('calls preventDefault and sets active class during 1-finger long-press drag while leaving normal scroll unintercepted', () => {
    vi.useFakeTimers();
    const pane = document.createElement('div');
    pane.className = 'chat-view';
    document.body.appendChild(pane);

    const actions: Array<{ action: MobileNavigationAction; step: number }> = [];
    const progressLog: Array<MobileNavigationGestureProgress | null> = [];
    const detach = attachMobileNavigationGestures({
      isMobile: true,
      viewportHeight: 667,
      onAction: (action, step) => actions.push({ action, step }),
      onProgress: (p) => progressLog.push(p),
    });

    // Normal 1-finger scroll -> NEVER calls preventDefault
    const s1 = dispatchTouch(pane, 'touchstart', [{ identifier: 1, clientX: 100, clientY: 300 }]);
    const m1 = dispatchTouch(pane, 'touchmove', [{ identifier: 1, clientX: 100, clientY: 200 }]);
    const e1 = dispatchTouch(pane, 'touchend', [], [{ identifier: 1, clientX: 100, clientY: 180 }]);
    expect(s1.defaultPrevented).toBe(false);
    expect(m1.defaultPrevented).toBe(false);
    expect(e1.defaultPrevented).toBe(false);
    expect(isMobileNavigationGestureActive(document)).toBe(false);
    expect(actions).toEqual([]);

    // Active 1-finger long-press + drag
    const startEvt = dispatchTouch(pane, 'touchstart', [{ identifier: 7, clientX: 160, clientY: 300 }]);
    expect(startEvt.defaultPrevented).toBe(false);
    dispatchTouch(pane, 'touchmove', [{ identifier: 7, clientX: 163, clientY: 297 }]);
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    expect(isMobileNavigationGestureActive(document)).toBe(false);

    const dragStartEvt = dispatchTouch(pane, 'touchmove', [{
      identifier: 7,
      clientX: 163,
      clientY: 297 - (MOBILE_LONG_PRESS_DRAG_START_PX + 6),
    }]);
    expect(dragStartEvt.defaultPrevented).toBe(true);
    expect(document.documentElement.classList.contains(MOBILE_NAV_GESTURE_ACTIVE_CLASS)).toBe(true);
    expect(progressLog.at(-1)?.direction).toBe('up');
    expect(progressLog.at(-1)?.armed).toBe(false);

    const dragArmEvt = dispatchTouch(pane, 'touchmove', [{ identifier: 7, clientX: 163, clientY: 297 - 80 }]);
    expect(dragArmEvt.defaultPrevented).toBe(true);
    expect(progressLog.at(-1)?.armed).toBe(true);

    const endEvt = dispatchTouch(pane, 'touchend', [], [{ identifier: 7, clientX: 163, clientY: 297 - 80 }]);
    expect(endEvt.defaultPrevented).toBe(true);
    expect(actions).toEqual([{ action: 'serverPrev', step: 1 }]);
    expect(isMobileNavigationGestureActive(document)).toBe(false);
    expect(progressLog.at(-1)).toBeNull();
    detach();
  });

  it('never triggers on long-press without swipe, sub-threshold drag, diagonal drag, or immediate swipe before long-press', () => {
    vi.useFakeTimers();
    const pane = document.createElement('div');
    pane.className = 'chat-view';
    document.body.appendChild(pane);

    const actions: string[] = [];
    const progressLog: Array<MobileNavigationGestureProgress | null> = [];
    const detach = attachMobileNavigationGestures({
      isMobile: true,
      onAction: (a) => actions.push(a),
      onProgress: (p) => progressLog.push(p),
    });

    // 1) Long-press hold without dragging
    dispatchTouch(pane, 'touchstart', [{ identifier: 1, clientX: 150, clientY: 300 }]);
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS + 100);
    dispatchTouch(pane, 'touchend', []);
    expect(actions).toEqual([]);
    expect(progressLog).toEqual([]);

    // 2) Drag past tolerance before timer expires
    dispatchTouch(pane, 'touchstart', [{ identifier: 2, clientX: 150, clientY: 300 }]);
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS - 100);
    dispatchTouch(pane, 'touchmove', [{ identifier: 2, clientX: 150, clientY: 300 - (MOBILE_LONG_PRESS_STILL_TOLERANCE_PX + 10) }]);
    vi.advanceTimersByTime(200);
    dispatchTouch(pane, 'touchmove', [{ identifier: 2, clientX: 150, clientY: 180 }]);
    dispatchTouch(pane, 'touchend', []);
    expect(actions).toEqual([]);
    expect(progressLog).toEqual([]);

    // 3) Long-press + drag < threshold -> HUD opens, release cancels without switch
    dispatchTouch(pane, 'touchstart', [{ identifier: 3, clientX: 150, clientY: 300 }]);
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    dispatchTouch(pane, 'touchmove', [{ identifier: 3, clientX: 150, clientY: 265 }]);
    expect(progressLog.at(-1)?.armed).toBe(false);
    dispatchTouch(pane, 'touchend', []);
    expect(actions).toEqual([]);
    expect(progressLog.at(-1)).toBeNull();

    // 4) Long-press + diagonal drag -> unarmed
    dispatchTouch(pane, 'touchstart', [{ identifier: 4, clientX: 150, clientY: 300 }]);
    vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    dispatchTouch(pane, 'touchmove', [{ identifier: 4, clientX: 225, clientY: 370 }]);
    expect(progressEventsArmed(progressLog)).toBe(false);
    dispatchTouch(pane, 'touchend', []);
    expect(actions).toEqual([]);

    detach();
  });

  it('ignores 1-finger long-press + drag inside inputs, controls, and editable elements, and cleans timer on detach', () => {
    vi.useFakeTimers();
    const controls = document.createElement('div');
    controls.className = 'controls-wrapper';
    const controlsInput = document.createElement('div');
    controlsInput.className = 'controls-input';
    controls.appendChild(controlsInput);

    const standaloneInput = document.createElement('input');
    const standaloneTextarea = document.createElement('textarea');
    const standaloneSelect = document.createElement('select');
    const editableDiv = document.createElement('div');
    editableDiv.setAttribute('contenteditable', 'true');

    document.body.append(controls, standaloneInput, standaloneTextarea, standaloneSelect, editableDiv);

    const actions: string[] = [];
    const progressLog: Array<MobileNavigationGestureProgress | null> = [];
    const detach = attachMobileNavigationGestures({
      isMobile: true,
      onAction: (a) => actions.push(a),
      onProgress: (p) => progressLog.push(p),
    });

    for (const el of [controls, controlsInput, standaloneInput, standaloneTextarea, standaloneSelect, editableDiv]) {
      expect(canHandleMobileNavigationGesture(el, { isMobile: true, document })).toBe(false);
      const s = dispatchTouch(el, 'touchstart', [{ identifier: 1, clientX: 120, clientY: 300 }]);
      vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS + 50);
      const m = dispatchTouch(el, 'touchmove', [{ identifier: 1, clientX: 120, clientY: 180 }]);
      const e = dispatchTouch(el, 'touchend', []);
      expect(s.defaultPrevented).toBe(false);
      expect(m.defaultPrevented).toBe(false);
      expect(e.defaultPrevented).toBe(false);
      expect(isMobileNavigationGestureActive(document)).toBe(false);
    }

    expect(actions).toEqual([]);
    expect(progressLog).toEqual([]);

    const pane = document.createElement('div');
    pane.className = 'chat-view';
    document.body.appendChild(pane);
    dispatchTouch(pane, 'touchstart', [{ identifier: 9, clientX: 120, clientY: 300 }]);
    vi.advanceTimersByTime(100);
    detach();
    vi.advanceTimersByTime(500);
    expect(isMobileNavigationGestureActive(document)).toBe(false);
  });
});

function progressEventsArmed(log: Array<MobileNavigationGestureProgress | null>): boolean {
  return Boolean(log.at(-1)?.armed);
}
