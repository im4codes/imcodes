import { hasDomBlockingOverlay } from './keyboard-shortcuts.js';

export type MobileNavigationAction = 'serverPrev' | 'serverNext' | 'tabPrev' | 'tabNext';
export type MobileNavigationDirection = 'up' | 'down' | 'left' | 'right';

export interface MobileNavigationGestureProgress {
  readonly dx: number;
  readonly dy: number;
  readonly direction: MobileNavigationDirection | null;
  readonly action: MobileNavigationAction | null;
  readonly distance: number;
  readonly threshold: number;
  readonly progress: number;
  readonly armed: boolean;
}

export interface TouchPointSnapshot {
  readonly identifier: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly target?: EventTarget | null;
}

export interface TouchEventLike {
  readonly touches: ArrayLike<TouchPointSnapshot>;
  readonly changedTouches?: ArrayLike<TouchPointSnapshot>;
  readonly target?: EventTarget | null;
}

export const MOBILE_SWIPE_PRIMARY_THRESHOLD_PX = 56;
export const MOBILE_SWIPE_PER_FINGER_MIN_PX = 28;
export const MOBILE_SWIPE_DOMINANCE_RATIO = 1.35;
export const MOBILE_SWIPE_PINCH_OPPOSING_MIN_PX = 12;
const MOBILE_SWIPE_DIRECTION_DEADZONE_PX = 4;

const DIRECTION_TO_ACTION: Record<MobileNavigationDirection, MobileNavigationAction> = {
  up: 'serverPrev',
  down: 'serverNext',
  left: 'tabPrev',
  right: 'tabNext',
};

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

const MOBILE_GESTURE_BOTTOM_CONTROL_SELECTOR = [
  '.controls-wrapper',
  '.mobile-controls',
  '.subcard-bar',
  '.subsession-bar',
  '.subsession-strip',
  '.subcard-scroll',
  '.subsession-row-with-close',
  '.subsession-close-all-strip',
  '.team-discussion-bottom',
  '.shortcuts-row',
  '.shortcuts',
  '.shortcuts-meta-scroll',
  '.shortcut-dpad',
  '.tab-bar',
  '[data-mobile-gesture-ignore="true"]',
].join(', ');

const MOBILE_GESTURE_BLOCKING_TARGET_SELECTOR = [
  MOBILE_GESTURE_BLOCKING_DOM_SELECTOR,
  MOBILE_GESTURE_BOTTOM_CONTROL_SELECTOR,
  '.remote-desktop-panel',
  '.remote-desktop-workspace',
  '.remote-desktop-wall',
  '[data-remote-desktop-surface="true"]',
  '[data-shortcut-recording="true"]',
  '.resize-hover-surface',
  '[data-resize-handle]',
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

function resolveElementTarget(
  target: EventTarget | null | undefined,
): { closest?: (selector: string) => unknown } | null {
  if (!target || typeof target !== 'object') return null;
  const candidate = target as {
    closest?: (selector: string) => unknown;
    parentElement?: { closest?: (selector: string) => unknown } | null;
  };
  if (typeof candidate.closest === 'function') return candidate;
  if (candidate.parentElement && typeof candidate.parentElement.closest === 'function') {
    return candidate.parentElement;
  }
  return null;
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
  const el = resolveElementTarget(target);
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
  readonly onProgress?: (progress: MobileNavigationGestureProgress | null) => void;
}

interface GestureEvaluation {
  readonly opposing: boolean;
  readonly progress: MobileNavigationGestureProgress | null;
  readonly action: MobileNavigationAction | null;
}

/**
 * Pure two-finger 4-direction swipe recognizer.
 * Emits live threshold/direction progress during active 2-finger drag, triggers
 * navigation only upon `touchend` while armed past threshold, rejects pinch/spread
 * zoom, 1-finger scrolling, 3+ finger touches, bottom control surfaces, and
 * diagonal ambiguity, and emits at most one navigation action until all touches lift.
 */
export class TwoFingerSwipeTracker {
  private phase: TrackerPhase = 'idle';
  private startPoints = new Map<number, { x: number; y: number }>();
  private lastPoints = new Map<number, { x: number; y: number }>();
  private lockedTouches = new Map<number, EventTarget | null>();
  private hudVisible = false;
  private readonly canTrack: (target: EventTarget | null | undefined) => boolean;
  private readonly onProgress?: (progress: MobileNavigationGestureProgress | null) => void;

  constructor(options: TwoFingerSwipeTrackerOptions = {}) {
    this.canTrack = options.canTrack ?? (() => true);
    this.onProgress = options.onProgress;
  }

  private emitProgress(next: MobileNavigationGestureProgress | null): void {
    if (next === null) {
      if (!this.hudVisible) return;
      this.hudVisible = false;
      this.onProgress?.(null);
      return;
    }
    this.hudVisible = true;
    this.onProgress?.(next);
  }

  private canTrackTouchList(touches?: ArrayLike<TouchPointSnapshot>): boolean {
    if (!touches) return true;
    for (let i = 0; i < touches.length; i++) {
      const point = touches[i];
      if (point?.target && !this.canTrack(point.target)) {
        return false;
      }
    }
    return true;
  }

  private canTrackEvent(event: TouchEventLike): boolean {
    if (!this.canTrack(event.target)) return false;
    if (!this.canTrackTouchList(event.touches)) return false;
    if (!this.canTrackTouchList(event.changedTouches)) return false;
    return true;
  }

  private clearTrackedPoints(): void {
    this.startPoints.clear();
    this.lastPoints.clear();
  }

  private snapshotLockedTouches(event: TouchEventLike): void {
    this.lockedTouches.clear();
    for (let i = 0; i < event.touches.length; i++) {
      const point = event.touches[i];
      if (!point) continue;
      this.lockedTouches.set(point.identifier, point.target ?? event.target ?? null);
    }
  }

  private hasDisconnectedLockedTarget(): boolean {
    for (const target of this.lockedTouches.values()) {
      if (
        target
        && typeof (target as Node).isConnected === 'boolean'
        && !(target as Node).isConnected
      ) {
        return true;
      }
    }
    return false;
  }

  private shouldRecoverStaleLockOnTwoFingerStart(event: TouchEventLike): boolean {
    if (event.changedTouches && event.changedTouches.length >= 2) {
      return true;
    }
    if (this.hasDisconnectedLockedTarget()) {
      return true;
    }
    if (this.lockedTouches.size > 0) {
      for (let i = 0; i < event.touches.length; i++) {
        const point = event.touches[i];
        if (point && this.lockedTouches.has(point.identifier)) {
          return false;
        }
      }
      return true;
    }
    return false;
  }

  private enterStopPhase(phase: 'triggered' | 'locked_out', event: TouchEventLike): void {
    this.phase = phase;
    this.clearTrackedPoints();
    this.snapshotLockedTouches(event);
    this.emitProgress(null);
  }

  private updateTrackedPositions(touches?: ArrayLike<TouchPointSnapshot>): void {
    if (!touches) return;
    for (let i = 0; i < touches.length; i++) {
      const point = touches[i];
      if (!point || !this.startPoints.has(point.identifier)) continue;
      this.lastPoints.set(point.identifier, { x: point.clientX, y: point.clientY });
    }
  }

  private evaluateTrackedState(): GestureEvaluation {
    const ids = Array.from(this.startPoints.keys());
    if (ids.length !== 2) return { opposing: false, progress: null, action: null };
    const id1 = ids[0]!;
    const id2 = ids[1]!;
    const start1 = this.startPoints.get(id1);
    const start2 = this.startPoints.get(id2);
    const end1 = this.lastPoints.get(id1);
    const end2 = this.lastPoints.get(id2);
    if (!start1 || !start2 || !end1 || !end2) return { opposing: false, progress: null, action: null };

    const dx1 = end1.x - start1.x;
    const dy1 = end1.y - start1.y;
    const dx2 = end2.x - start2.x;
    const dy2 = end2.y - start2.y;

    if (isOpposingFingerMovement(dx1, dy1, dx2, dy2)) {
      return { opposing: true, progress: null, action: null };
    }

    const dx = (dx1 + dx2) / 2;
    const dy = (dy1 + dy2) / 2;
    const absAvgDx = Math.abs(dx);
    const absAvgDy = Math.abs(dy);
    const isVertical = absAvgDy >= absAvgDx;
    const avgPrimary = isVertical ? dy : dx;
    const absPrimary = isVertical ? absAvgDy : absAvgDx;
    const absCrossAvg = isVertical ? absAvgDx : absAvgDy;

    let direction: MobileNavigationDirection | null = null;
    if (
      absPrimary >= MOBILE_SWIPE_DIRECTION_DEADZONE_PX
      && absPrimary >= absCrossAvg * MOBILE_SWIPE_DOMINANCE_RATIO
    ) {
      if (isVertical) {
        direction = avgPrimary < 0 ? 'up' : 'down';
      } else {
        direction = avgPrimary < 0 ? 'left' : 'right';
      }
    }

    const committedAction = isVertical
      ? classifySingleAxisSwipe(dy1, dy2, absAvgDx, 'serverPrev', 'serverNext')
      : classifySingleAxisSwipe(dx1, dx2, absAvgDy, 'tabPrev', 'tabNext');
    const armed = committedAction !== null;
    const distance = direction ? absPrimary : 0;
    const progress = armed
      ? 1
      : (direction ? Math.min(0.99, distance / MOBILE_SWIPE_PRIMARY_THRESHOLD_PX) : 0);

    return {
      opposing: false,
      action: committedAction,
      progress: {
        dx,
        dy,
        direction,
        action: direction ? DIRECTION_TO_ACTION[direction] : null,
        distance,
        threshold: MOBILE_SWIPE_PRIMARY_THRESHOLD_PX,
        progress,
        armed,
      },
    };
  }

  reset(): void {
    this.phase = 'idle';
    this.clearTrackedPoints();
    this.lockedTouches.clear();
    this.emitProgress(null);
  }

  onTouchStart(event: TouchEventLike): void {
    const count = event.touches.length;
    if (count > 2) {
      this.enterStopPhase('locked_out', event);
      return;
    }
    if (count === 1) {
      if (this.phase !== 'idle') {
        this.reset();
      }
      if (!this.canTrackEvent(event)) {
        this.enterStopPhase('locked_out', event);
      }
      return;
    }
    if (count === 2) {
      if (this.phase !== 'idle') {
        if (this.phase === 'tracking') {
          this.enterStopPhase('locked_out', event);
          return;
        }
        if (!this.shouldRecoverStaleLockOnTwoFingerStart(event)) {
          this.snapshotLockedTouches(event);
          return;
        }
        this.reset();
      }
      if (!this.canTrackEvent(event)) {
        this.enterStopPhase('locked_out', event);
        return;
      }
      const first = event.touches[0];
      const second = event.touches[1];
      if (!first || !second || first.identifier === second.identifier) {
        this.enterStopPhase('locked_out', event);
        return;
      }
      this.clearTrackedPoints();
      this.lockedTouches.clear();
      this.startPoints.set(first.identifier, { x: first.clientX, y: first.clientY });
      this.startPoints.set(second.identifier, { x: second.clientX, y: second.clientY });
      this.lastPoints.set(first.identifier, { x: first.clientX, y: first.clientY });
      this.lastPoints.set(second.identifier, { x: second.clientX, y: second.clientY });
      this.phase = 'tracking';
      this.emitProgress({
        dx: 0,
        dy: 0,
        direction: null,
        action: null,
        distance: 0,
        threshold: MOBILE_SWIPE_PRIMARY_THRESHOLD_PX,
        progress: 0,
        armed: false,
      });
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
        this.enterStopPhase('locked_out', event);
      } else if (this.hasDisconnectedLockedTarget()) {
        this.reset();
      }
      return null;
    }
    if (count !== 2 || !this.canTrackEvent(event)) {
      this.enterStopPhase('locked_out', event);
      return null;
    }
    const first = event.touches[0];
    const second = event.touches[1];
    if (!first || !second || !this.startPoints.has(first.identifier) || !this.startPoints.has(second.identifier)) {
      this.enterStopPhase('locked_out', event);
      return null;
    }

    this.updateTrackedPositions(event.touches);
    const evaluation = this.evaluateTrackedState();
    if (evaluation.opposing) {
      this.enterStopPhase('locked_out', event);
      return null;
    }

    this.emitProgress(evaluation.progress);
    return null;
  }

  onTouchEnd(event: TouchEventLike): MobileNavigationAction | null {
    const remainingCount = event.touches.length;
    if (this.phase !== 'tracking') {
      if (remainingCount === 0) {
        this.reset();
      } else if (this.phase === 'idle' && remainingCount > 2) {
        this.enterStopPhase('locked_out', event);
      } else {
        this.snapshotLockedTouches(event);
      }
      return null;
    }

    if (remainingCount > 2 || !this.canTrackEvent(event)) {
      if (remainingCount === 0) {
        this.reset();
      } else {
        this.enterStopPhase('locked_out', event);
      }
      return null;
    }

    this.updateTrackedPositions(event.touches);
    this.updateTrackedPositions(event.changedTouches);
    const evaluation = this.evaluateTrackedState();

    if (!evaluation.opposing && evaluation.action) {
      if (remainingCount === 0) {
        this.reset();
      } else {
        this.enterStopPhase('triggered', event);
      }
      return evaluation.action;
    }

    if (remainingCount === 0) {
      this.reset();
    } else {
      this.enterStopPhase('locked_out', event);
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
  readonly onProgress?: (progress: MobileNavigationGestureProgress | null) => void;
}

export function attachMobileNavigationGestures(options: AttachMobileNavigationGesturesOptions): () => void {
  if (!options.isMobile) return () => {};
  const win = options.windowTarget ?? (typeof window !== 'undefined' ? window : undefined);
  if (!win) return () => {};

  const doc = options.document ?? win.document;
  const tracker = new TwoFingerSwipeTracker({
    canTrack: (target) => canHandleMobileNavigationGesture(target, {
      isMobile: options.isMobile,
      hasBlockingOverlay: options.isBlocked?.() ?? false,
      document: doc,
    }),
    onProgress: options.onProgress,
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
  const handleWindowBlur = () => tracker.reset();
  const handleVisibilityChange = () => {
    if (doc && doc.visibilityState !== 'visible') {
      tracker.reset();
    }
  };

  const listenerOpts: AddEventListenerOptions = { passive: true, capture: true };
  win.addEventListener('touchstart', handleTouchStart, listenerOpts);
  win.addEventListener('touchmove', handleTouchMove, listenerOpts);
  win.addEventListener('touchend', handleTouchEnd, listenerOpts);
  win.addEventListener('touchcancel', handleTouchCancel, listenerOpts);
  win.addEventListener('blur', handleWindowBlur);
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', handleVisibilityChange);
  }

  return () => {
    tracker.reset();
    win.removeEventListener('touchstart', handleTouchStart, listenerOpts);
    win.removeEventListener('touchmove', handleTouchMove, listenerOpts);
    win.removeEventListener('touchend', handleTouchEnd, listenerOpts);
    win.removeEventListener('touchcancel', handleTouchCancel, listenerOpts);
    win.removeEventListener('blur', handleWindowBlur);
    if (doc && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  };
}
