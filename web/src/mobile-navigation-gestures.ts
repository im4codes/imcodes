import { hasDomBlockingOverlay } from './keyboard-shortcuts.js';

export type MobileNavigationAction = 'serverPrev' | 'serverNext' | 'tabPrev' | 'tabNext';

export interface TouchPointSnapshot {
  readonly identifier: number;
  readonly clientX: number;
  readonly clientY: number;
}

export interface TouchEventLike {
  readonly touches: ArrayLike<TouchPointSnapshot>;
  readonly changedTouches?: ArrayLike<TouchPointSnapshot>;
  readonly target?: EventTarget | null;
}

export const MOBILE_SWIPE_PRIMARY_THRESHOLD_PX = 48;
export const MOBILE_SWIPE_PER_FINGER_MIN_PX = 28;
export const MOBILE_SWIPE_DOMINANCE_RATIO = 1.35;
export const MOBILE_SWIPE_PINCH_OPPOSING_MIN_PX = 12;

export const MOBILE_NAVIGATION_GESTURE_KEYCAPS: Record<MobileNavigationAction, readonly string[]> = {
  serverPrev: ['2F', '↑'],
  serverNext: ['2F', '↓'],
  tabPrev: ['2F', '←'],
  tabNext: ['2F', '→'],
};

// Fullscreen overlays, backdrops, and drawers across the UI that may omit role="dialog".
const MOBILE_GESTURE_BLOCKING_DOM_SELECTOR = [
  '.mobile-sidebar-overlay.open',
  '.mobile-server-menu',
  '.voice-overlay-backdrop',
  '.voice-overlay',
  '.ask-dialog-overlay',
  '.fb-overlay',
  '.mobile-fb-overlay',
  '.fb-lightbox',
  '.fb-conflict-overlay',
  '.html-fullscreen-preview',
  '.onboarding-overlay',
  '.openspec-auto-details-backdrop',
  '.cloud-docs-modal-backdrop',
  '.qp-backdrop',
  '.controls-composer-backdrop',
  '.peer-audit-overlay',
  '.session-usage-backdrop',
  '.modal-backdrop',
  '.daemon-details-backdrop',
].join(', ');

const MOBILE_GESTURE_BLOCKING_TARGET_SELECTOR = [
  MOBILE_GESTURE_BLOCKING_DOM_SELECTOR,
  '.remote-desktop-panel',
  '.remote-desktop-workspace',
  '.remote-desktop-wall',
  '[data-remote-desktop-surface="true"]',
  '[data-shortcut-recording="true"]',
  '[aria-modal="true"]',
  '[role="dialog"]:not([aria-modal="false"]):not(.feature-announcement)',
  '[role="alertdialog"]',
  '.modal-overlay',
  '.dialog-backdrop',
  '.dialog-overlay',
].join(', ');

export interface MobileNavigationGestureGuardOptions {
  readonly isMobile: boolean;
  readonly hasBlockingOverlay?: boolean;
  readonly document?: Document;
}

export function canHandleMobileNavigationGesture(
  target: EventTarget | null | undefined,
  options: MobileNavigationGestureGuardOptions,
): boolean {
  if (!options.isMobile || options.hasBlockingOverlay) return false;
  const doc = options.document ?? (typeof document !== 'undefined' ? document : undefined);
  if (hasDomBlockingOverlay(doc)) return false;
  if (doc) {
    if (doc.fullscreenElement) return false;
    if (doc.querySelector(MOBILE_GESTURE_BLOCKING_DOM_SELECTOR)) return false;
  }
  const el = target as { closest?: (selector: string) => unknown } | null | undefined;
  if (el && typeof el.closest === 'function' && el.closest(MOBILE_GESTURE_BLOCKING_TARGET_SELECTOR)) {
    return false;
  }
  return true;
}

function classifySingleAxisSwipe(
  primary1: number,
  primary2: number,
  absCrossAvg: number,
  negativeAction: MobileNavigationAction,
  positiveAction: MobileNavigationAction,
): MobileNavigationAction | null {
  const avgPrimary = (primary1 + primary2) / 2;
  const absPrimary = Math.abs(avgPrimary);
  if (absPrimary < MOBILE_SWIPE_PRIMARY_THRESHOLD_PX) return null;
  if (absPrimary < absCrossAvg * MOBILE_SWIPE_DOMINANCE_RATIO) return null;
  if (
    avgPrimary < 0
    && primary1 <= -MOBILE_SWIPE_PER_FINGER_MIN_PX
    && primary2 <= -MOBILE_SWIPE_PER_FINGER_MIN_PX
  ) {
    return negativeAction;
  }
  if (
    avgPrimary > 0
    && primary1 >= MOBILE_SWIPE_PER_FINGER_MIN_PX
    && primary2 >= MOBILE_SWIPE_PER_FINGER_MIN_PX
  ) {
    return positiveAction;
  }
  return null;
}

function isOpposingFingerMovement(dx1: number, dy1: number, dx2: number, dy2: number): boolean {
  const minX = Math.min(Math.abs(dx1), Math.abs(dx2));
  if (dx1 * dx2 < 0 && minX >= MOBILE_SWIPE_PINCH_OPPOSING_MIN_PX) {
    return true;
  }
  const minY = Math.min(Math.abs(dy1), Math.abs(dy2));
  if (dy1 * dy2 < 0 && minY >= MOBILE_SWIPE_PINCH_OPPOSING_MIN_PX) {
    return true;
  }
  const mag1 = Math.hypot(dx1, dy1);
  const mag2 = Math.hypot(dx2, dy2);
  if (
    mag1 >= MOBILE_SWIPE_PINCH_OPPOSING_MIN_PX
    && mag2 >= MOBILE_SWIPE_PINCH_OPPOSING_MIN_PX
    && (dx1 * dx2 + dy1 * dy2) < 0
  ) {
    return true;
  }
  return false;
}

type TrackerPhase = 'idle' | 'tracking' | 'triggered' | 'locked_out';

export interface TwoFingerSwipeTrackerOptions {
  readonly canTrack?: (target: EventTarget | null | undefined) => boolean;
}

/**
 * Pure two-finger 4-direction swipe recognizer.
 * Evaluates displacement across `touchmove` and `touchend` (`changedTouches`),
 * rejects pinch/spread zoom, 1-finger scrolling, 3+ finger touches, jitter, and
 * diagonal ambiguity, and emits at most one navigation action until all touches lift.
 */
export class TwoFingerSwipeTracker {
  private phase: TrackerPhase = 'idle';
  private startPoints = new Map<number, { x: number; y: number }>();
  private lastPoints = new Map<number, { x: number; y: number }>();
  private readonly canTrack: (target: EventTarget | null | undefined) => boolean;

  constructor(options: TwoFingerSwipeTrackerOptions = {}) {
    this.canTrack = options.canTrack ?? (() => true);
  }

  private clearTrackedPoints(): void {
    this.startPoints.clear();
    this.lastPoints.clear();
  }

  private updateTrackedPositions(touches?: ArrayLike<TouchPointSnapshot>): void {
    if (!touches) return;
    for (let i = 0; i < touches.length; i++) {
      const point = touches[i];
      if (!point || !this.startPoints.has(point.identifier)) continue;
      this.lastPoints.set(point.identifier, { x: point.clientX, y: point.clientY });
    }
  }

  private evaluateTrackedPoints(): MobileNavigationAction | null {
    const ids = Array.from(this.startPoints.keys());
    if (ids.length !== 2) return null;
    const id1 = ids[0]!;
    const id2 = ids[1]!;
    const start1 = this.startPoints.get(id1);
    const start2 = this.startPoints.get(id2);
    const end1 = this.lastPoints.get(id1);
    const end2 = this.lastPoints.get(id2);
    if (!start1 || !start2 || !end1 || !end2) return null;

    const dx1 = end1.x - start1.x;
    const dy1 = end1.y - start1.y;
    const dx2 = end2.x - start2.x;
    const dy2 = end2.y - start2.y;

    if (isOpposingFingerMovement(dx1, dy1, dx2, dy2)) {
      this.phase = 'locked_out';
      this.clearTrackedPoints();
      return null;
    }

    const absAvgDx = Math.abs((dx1 + dx2) / 2);
    const absAvgDy = Math.abs((dy1 + dy2) / 2);
    return absAvgDy >= absAvgDx
      ? classifySingleAxisSwipe(dy1, dy2, absAvgDx, 'serverPrev', 'serverNext')
      : classifySingleAxisSwipe(dx1, dx2, absAvgDy, 'tabPrev', 'tabNext');
  }

  reset(): void {
    this.phase = 'idle';
    this.clearTrackedPoints();
  }

  onTouchStart(event: TouchEventLike): void {
    const count = event.touches.length;
    if (count > 2) {
      this.phase = 'locked_out';
      this.clearTrackedPoints();
      return;
    }
    if (count === 2) {
      if (this.phase !== 'idle') {
        if (this.phase === 'tracking') {
          this.phase = 'locked_out';
          this.clearTrackedPoints();
        }
        return;
      }
      if (!this.canTrack(event.target)) {
        this.phase = 'locked_out';
        this.clearTrackedPoints();
        return;
      }
      const first = event.touches[0];
      const second = event.touches[1];
      if (!first || !second || first.identifier === second.identifier) {
        this.phase = 'locked_out';
        this.clearTrackedPoints();
        return;
      }
      this.clearTrackedPoints();
      this.startPoints.set(first.identifier, { x: first.clientX, y: first.clientY });
      this.startPoints.set(second.identifier, { x: second.clientX, y: second.clientY });
      this.lastPoints.set(first.identifier, { x: first.clientX, y: first.clientY });
      this.lastPoints.set(second.identifier, { x: second.clientX, y: second.clientY });
      this.phase = 'tracking';
    }
  }

  onTouchMove(event: TouchEventLike): MobileNavigationAction | null {
    const count = event.touches.length;
    if (count === 0) {
      this.reset();
      return null;
    }
    if (this.phase !== 'tracking') {
      if (count > 2 && this.phase === 'idle') {
        this.phase = 'locked_out';
      }
      return null;
    }
    if (count !== 2 || !this.canTrack(event.target)) {
      this.phase = 'locked_out';
      this.clearTrackedPoints();
      return null;
    }
    const first = event.touches[0];
    const second = event.touches[1];
    if (!first || !second || !this.startPoints.has(first.identifier) || !this.startPoints.has(second.identifier)) {
      this.phase = 'locked_out';
      this.clearTrackedPoints();
      return null;
    }

    this.updateTrackedPositions(event.touches);
    const action = this.evaluateTrackedPoints();
    if (!action) return null;

    this.phase = 'triggered';
    this.clearTrackedPoints();
    return action;
  }

  onTouchEnd(event: TouchEventLike): MobileNavigationAction | null {
    const remainingCount = event.touches.length;
    if (this.phase !== 'tracking') {
      if (remainingCount === 0) {
        this.reset();
      } else if (this.phase === 'idle' && remainingCount > 2) {
        this.phase = 'locked_out';
      }
      return null;
    }

    if (remainingCount > 2 || !this.canTrack(event.target)) {
      if (remainingCount === 0) {
        this.reset();
      } else {
        this.phase = 'locked_out';
        this.clearTrackedPoints();
      }
      return null;
    }

    this.updateTrackedPositions(event.touches);
    this.updateTrackedPositions(event.changedTouches);
    const action = this.evaluateTrackedPoints();

    if (action) {
      if (remainingCount === 0) {
        this.reset();
      } else {
        this.phase = 'triggered';
        this.clearTrackedPoints();
      }
      return action;
    }

    if (remainingCount === 0) {
      this.reset();
    } else {
      this.phase = 'locked_out';
      this.clearTrackedPoints();
    }
    return null;
  }

  onTouchCancel(): void {
    this.reset();
  }
}

export interface AttachMobileNavigationGesturesOptions {
  readonly isMobile: boolean;
  readonly windowTarget?: Window;
  readonly document?: Document;
  readonly isBlocked?: () => boolean;
  readonly onAction: (action: MobileNavigationAction) => void;
}

export function attachMobileNavigationGestures(options: AttachMobileNavigationGesturesOptions): () => void {
  if (!options.isMobile) return () => {};
  const win = options.windowTarget ?? (typeof window !== 'undefined' ? window : undefined);
  if (!win) return () => {};

  const tracker = new TwoFingerSwipeTracker({
    canTrack: (target) => canHandleMobileNavigationGesture(target, {
      isMobile: options.isMobile,
      hasBlockingOverlay: options.isBlocked?.() ?? false,
      document: options.document ?? win.document,
    }),
  });

  const handleTouchStart = (e: TouchEvent) => tracker.onTouchStart(e);
  const handleTouchMove = (e: TouchEvent) => {
    const action = tracker.onTouchMove(e);
    if (action) options.onAction(action);
  };
  const handleTouchEnd = (e: TouchEvent) => {
    const action = tracker.onTouchEnd(e);
    if (action) options.onAction(action);
  };
  const handleTouchCancel = () => tracker.onTouchCancel();

  const listenerOpts: AddEventListenerOptions = { passive: true, capture: true };
  win.addEventListener('touchstart', handleTouchStart, listenerOpts);
  win.addEventListener('touchmove', handleTouchMove, listenerOpts);
  win.addEventListener('touchend', handleTouchEnd, listenerOpts);
  win.addEventListener('touchcancel', handleTouchCancel, listenerOpts);

  return () => {
    tracker.reset();
    win.removeEventListener('touchstart', handleTouchStart, listenerOpts);
    win.removeEventListener('touchmove', handleTouchMove, listenerOpts);
    win.removeEventListener('touchend', handleTouchEnd, listenerOpts);
    win.removeEventListener('touchcancel', handleTouchCancel, listenerOpts);
  };
}
