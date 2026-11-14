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
export const MOBILE_LONG_PRESS_MS = 380;
export const MOBILE_LONG_PRESS_STILL_TOLERANCE_PX = 12;
export const MOBILE_LONG_PRESS_DRAG_START_PX = 10;
export const MOBILE_NAV_GESTURE_ACTIVE_CLASS = 'mobile-nav-gesture-active';
export const MOBILE_NAV_GESTURE_ACTIVE_EVENT = 'imcodes:mobile-nav-gesture-active';
const MOBILE_SWIPE_DIRECTION_DEADZONE_PX = 4;
const MOBILE_GESTURE_RECENT_WINDOW_MS = 350;

const lastCompletedGestureAtByDoc = new WeakMap<Document, number>();
let lastCompletedGestureAtFallback = 0;

function resolveTargetDocument(doc?: Document): Document | undefined {
  return doc ?? (typeof document !== 'undefined' ? document : undefined);
}

export function isMobileNavigationGestureActive(doc?: Document): boolean {
  const resolved = resolveTargetDocument(doc);
  return resolved?.documentElement?.classList?.contains(MOBILE_NAV_GESTURE_ACTIVE_CLASS) ?? false;
}

export function wasMobileNavigationGestureRecentlyActive(
  doc?: Document,
  windowMs: number = MOBILE_GESTURE_RECENT_WINDOW_MS,
): boolean {
  const resolved = resolveTargetDocument(doc);
  const ts = resolved ? (lastCompletedGestureAtByDoc.get(resolved) ?? 0) : lastCompletedGestureAtFallback;
  return ts > 0 && Date.now() - ts < windowMs;
}

function markMobileNavigationGestureCompleted(doc?: Document): void {
  const now = Date.now();
  const resolved = resolveTargetDocument(doc);
  if (resolved) {
    lastCompletedGestureAtByDoc.set(resolved, now);
  } else {
    lastCompletedGestureAtFallback = now;
  }
}

function setMobileNavigationGestureActiveState(doc: Document | undefined, active: boolean): void {
  if (!doc) return;
  doc.documentElement?.classList?.toggle(MOBILE_NAV_GESTURE_ACTIVE_CLASS, active);
  if (typeof CustomEvent === 'function' && typeof doc.dispatchEvent === 'function') {
    doc.dispatchEvent(new CustomEvent(MOBILE_NAV_GESTURE_ACTIVE_EVENT, { detail: { active } }));
  }
}

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
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[contenteditable="plaintext-only"]',
  '.controls-input',
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

type TrackerPhase =
  | 'idle'
  | 'long_press_pending'
  | 'long_press_ready'
  | 'tracking'
  | 'triggered'
  | 'locked_out';

type ActiveTrackingMode = 'one_finger' | 'two_finger' | null;

export interface TwoFingerSwipeTrackerOptions {
  readonly canTrack?: (target: EventTarget | null | undefined) => boolean;
  readonly onProgress?: (progress: MobileNavigationGestureProgress | null) => void;
  readonly onActiveChange?: (active: boolean) => void;
  readonly longPressMs?: number;
  readonly stillTolerancePx?: number;
  readonly dragStartPx?: number;
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}

interface GestureEvaluation {
  readonly opposing: boolean;
  readonly progress: MobileNavigationGestureProgress | null;
  readonly action: MobileNavigationAction | null;
}

/**
 * Mobile 4-direction navigation swipe recognizer supporting:
 * 1) Two-finger swipe anywhere outside overlays and bottom control bars;
 * 2) One-finger long-press + combined drag outside input/control bars.
 *
 * Emits live threshold/direction progress during active tracking, triggers
 * navigation only upon `touchend` while armed past threshold, rejects pinch/spread
 * zoom, normal 1-finger scrolling, long-press without drag, 3+ finger touches,
 * bottom control/input surfaces, and diagonal ambiguity.
 */
export class TwoFingerSwipeTracker {
  private phase: TrackerPhase = 'idle';
  private activeMode: ActiveTrackingMode = null;
  private startPoints = new Map<number, { x: number; y: number }>();
  private lastPoints = new Map<number, { x: number; y: number }>();
  private lockedTouches = new Map<number, EventTarget | null>();
  private pendingTouchId: number | null = null;
  private pendingStartPoint: { x: number; y: number } | null = null;
  private pendingLastPoint: { x: number; y: number } | null = null;
  private longPressAnchor: { x: number; y: number } | null = null;
  private pendingTarget: EventTarget | null = null;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private hudVisible = false;
  private activeNotified = false;
  private readonly canTrack: (target: EventTarget | null | undefined) => boolean;
  private readonly onProgress?: (progress: MobileNavigationGestureProgress | null) => void;
  private readonly onActiveChange?: (active: boolean) => void;
  private readonly longPressMs: number;
  private readonly stillTolerancePx: number;
  private readonly dragStartPx: number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (id: ReturnType<typeof setTimeout>) => void;

  constructor(options: TwoFingerSwipeTrackerOptions = {}) {
    this.canTrack = options.canTrack ?? (() => true);
    this.onProgress = options.onProgress;
    this.onActiveChange = options.onActiveChange;
    this.longPressMs = options.longPressMs ?? MOBILE_LONG_PRESS_MS;
    this.stillTolerancePx = options.stillTolerancePx ?? MOBILE_LONG_PRESS_STILL_TOLERANCE_PX;
    this.dragStartPx = options.dragStartPx ?? MOBILE_LONG_PRESS_DRAG_START_PX;
    this.setTimer = options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((id) => globalThis.clearTimeout(id));
  }

  isActive(): boolean {
    return this.phase === 'tracking' || this.phase === 'triggered';
  }

  private setActive(active: boolean): void {
    if (this.activeNotified === active) return;
    this.activeNotified = active;
    this.onActiveChange?.(active);
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

  private clearLongPressTimer(): void {
    if (this.longPressTimer !== null) {
      this.clearTimer(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private clearPendingOneFinger(): void {
    this.clearLongPressTimer();
    this.pendingTouchId = null;
    this.pendingStartPoint = null;
    this.pendingLastPoint = null;
    this.longPressAnchor = null;
    this.pendingTarget = null;
  }

  private clearTrackedPoints(): void {
    this.startPoints.clear();
    this.lastPoints.clear();
    this.activeMode = null;
  }

  private findTouchById(
    touches: ArrayLike<TouchPointSnapshot> | undefined,
    identifier: number | null,
  ): TouchPointSnapshot | null {
    if (!touches || identifier === null) return null;
    for (let i = 0; i < touches.length; i++) {
      const point = touches[i];
      if (point && point.identifier === identifier) return point;
    }
    return null;
  }

  private snapshotLockedTouches(event: TouchEventLike): void {
    const next = new Map<number, EventTarget | null>();
    for (let i = 0; i < event.touches.length; i++) {
      const point = event.touches[i];
      if (!point) continue;
      const target = point.target ?? this.lockedTouches.get(point.identifier) ?? event.target ?? null;
      next.set(point.identifier, target);
    }
    this.lockedTouches = next;
  }

  private matchesLockedTouch(point: TouchPointSnapshot): boolean {
    if (!this.lockedTouches.has(point.identifier)) {
      return false;
    }
    const lockedTarget = this.lockedTouches.get(point.identifier) ?? null;
    if (point.target && lockedTarget && point.target !== lockedTarget) {
      return false;
    }
    return true;
  }

  private hasMatchingLockedTouch(touches: ArrayLike<TouchPointSnapshot>): boolean {
    for (let i = 0; i < touches.length; i++) {
      const point = touches[i];
      if (point && this.matchesLockedTouch(point)) {
        return true;
      }
    }
    return false;
  }

  private shouldRecoverStaleLockOnTwoFingerStart(event: TouchEventLike): boolean {
    if (event.changedTouches && event.changedTouches.length >= 2) {
      return true;
    }
    if (this.lockedTouches.size > 0) {
      return !this.hasMatchingLockedTouch(event.touches);
    }
    return false;
  }

  private enterStopPhase(phase: 'triggered' | 'locked_out', event: TouchEventLike): void {
    this.clearPendingOneFinger();
    this.phase = phase;
    this.clearTrackedPoints();
    this.snapshotLockedTouches(event);
    this.emitProgress(null);
    if (phase === 'locked_out') {
      this.setActive(false);
    }
  }

  private updateTrackedPositions(touches?: ArrayLike<TouchPointSnapshot>): void {
    if (!touches) return;
    for (let i = 0; i < touches.length; i++) {
      const point = touches[i];
      if (!point || !this.startPoints.has(point.identifier)) continue;
      this.lastPoints.set(point.identifier, { x: point.clientX, y: point.clientY });
    }
  }

  private buildEvaluation(
    primary1: number,
    primary2: number,
    cross1: number,
    cross2: number,
    dx: number,
    dy: number,
    opposing: boolean,
  ): GestureEvaluation {
    if (opposing) {
      return { opposing: true, progress: null, action: null };
    }

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
      ? classifySingleAxisSwipe(primary1, primary2, absAvgDx, 'serverPrev', 'serverNext')
      : classifySingleAxisSwipe(cross1, cross2, absAvgDy, 'tabPrev', 'tabNext');
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

  private evaluateTrackedState(): GestureEvaluation {
    const ids = Array.from(this.startPoints.keys());
    if (this.activeMode === 'one_finger') {
      if (ids.length !== 1) return { opposing: false, progress: null, action: null };
      const id = ids[0]!;
      const start = this.startPoints.get(id);
      const end = this.lastPoints.get(id);
      if (!start || !end) return { opposing: false, progress: null, action: null };
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      return this.buildEvaluation(dy, dy, dx, dx, dx, dy, false);
    }

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
    const dx = (dx1 + dx2) / 2;
    const dy = (dy1 + dy2) / 2;
    return this.buildEvaluation(
      dy1,
      dy2,
      dx1,
      dx2,
      dx,
      dy,
      isOpposingFingerMovement(dx1, dy1, dx2, dy2),
    );
  }

  private lockOutActiveGesture(event: TouchEventLike): void {
    this.enterStopPhase('locked_out', event);
  }

  reset(): void {
    this.clearPendingOneFinger();
    this.phase = 'idle';
    this.clearTrackedPoints();
    this.lockedTouches.clear();
    this.emitProgress(null);
    this.setActive(false);
  }

  onTouchStart(event: TouchEventLike): void {
    const count = event.touches.length;
    if (count > 2) {
      this.lockOutActiveGesture(event);
      return;
    }
    if (count === 1) {
      if (this.phase !== 'idle') {
        this.reset();
      }
      const first = event.touches[0];
      if (!first || !this.canTrackEvent(event)) {
        this.enterStopPhase('locked_out', event);
        return;
      }
      this.pendingTouchId = first.identifier;
      this.pendingStartPoint = { x: first.clientX, y: first.clientY };
      this.pendingLastPoint = { x: first.clientX, y: first.clientY };
      this.longPressAnchor = null;
      this.pendingTarget = first.target ?? event.target ?? null;
      this.phase = 'long_press_pending';
      this.longPressTimer = this.setTimer(() => {
        this.longPressTimer = null;
        if (this.phase !== 'long_press_pending') return;
        if (this.pendingTarget && !this.canTrack(this.pendingTarget)) {
          this.clearPendingOneFinger();
          this.phase = 'locked_out';
          return;
        }
        this.longPressAnchor = this.pendingLastPoint ?? this.pendingStartPoint;
        this.phase = 'long_press_ready';
      }, this.longPressMs);
      return;
    }
    if (count === 2) {
      if (this.phase !== 'idle' && this.phase !== 'long_press_pending' && this.phase !== 'long_press_ready') {
        if (this.phase === 'tracking') {
          this.lockOutActiveGesture(event);
          return;
        }
        if (!this.shouldRecoverStaleLockOnTwoFingerStart(event)) {
          this.snapshotLockedTouches(event);
          return;
        }
        this.reset();
      }
      this.clearPendingOneFinger();
      if (!this.canTrackEvent(event)) {
        this.lockOutActiveGesture(event);
        return;
      }
      const first = event.touches[0];
      const second = event.touches[1];
      if (!first || !second || first.identifier === second.identifier) {
        this.lockOutActiveGesture(event);
        return;
      }
      this.clearTrackedPoints();
      this.lockedTouches.clear();
      this.activeMode = 'two_finger';
      this.startPoints.set(first.identifier, { x: first.clientX, y: first.clientY });
      this.startPoints.set(second.identifier, { x: second.clientX, y: second.clientY });
      this.lastPoints.set(first.identifier, { x: first.clientX, y: first.clientY });
      this.lastPoints.set(second.identifier, { x: second.clientX, y: second.clientY });
      this.phase = 'tracking';
      this.setActive(true);
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

    if (this.phase === 'long_press_pending') {
      if (count !== 1 || !this.canTrackEvent(event)) {
        this.clearPendingOneFinger();
        this.phase = 'locked_out';
        return null;
      }
      const touch = this.findTouchById(event.touches, this.pendingTouchId);
      if (!touch || !this.pendingStartPoint) {
        this.clearPendingOneFinger();
        this.phase = 'locked_out';
        return null;
      }
      const moveDist = Math.hypot(
        touch.clientX - this.pendingStartPoint.x,
        touch.clientY - this.pendingStartPoint.y,
      );
      if (moveDist > this.stillTolerancePx) {
        // User is scrolling/dragging before long-press armed: cancel & lock out for this touch sequence.
        this.clearPendingOneFinger();
        this.phase = 'locked_out';
        return null;
      }
      this.pendingLastPoint = { x: touch.clientX, y: touch.clientY };
      return null;
    }

    if (this.phase === 'long_press_ready') {
      if (count !== 1 || !this.canTrackEvent(event)) {
        this.clearPendingOneFinger();
        this.phase = 'locked_out';
        return null;
      }
      const touch = this.findTouchById(event.touches, this.pendingTouchId);
      const anchor = this.longPressAnchor ?? this.pendingStartPoint;
      if (!touch || !anchor) {
        this.clearPendingOneFinger();
        this.phase = 'locked_out';
        return null;
      }
      this.pendingLastPoint = { x: touch.clientX, y: touch.clientY };
      const dragDist = Math.hypot(touch.clientX - anchor.x, touch.clientY - anchor.y);
      if (dragDist < this.dragStartPx) {
        return null;
      }
      this.clearPendingOneFinger();
      this.clearTrackedPoints();
      this.activeMode = 'one_finger';
      this.startPoints.set(touch.identifier, anchor);
      this.lastPoints.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
      this.phase = 'tracking';
      this.setActive(true);
      const evaluation = this.evaluateTrackedState();
      this.emitProgress(evaluation.progress);
      return null;
    }

    if (this.phase !== 'tracking') {
      if (count > 2 && this.phase === 'idle') {
        this.enterStopPhase('locked_out', event);
      } else if (
        this.lockedTouches.size > 0
        && !this.hasMatchingLockedTouch(event.touches)
      ) {
        this.reset();
      }
      return null;
    }

    if (this.activeMode === 'one_finger') {
      if (count !== 1 || !this.canTrackEvent(event)) {
        this.lockOutActiveGesture(event);
        return null;
      }
      const first = event.touches[0];
      if (!first || !this.startPoints.has(first.identifier)) {
        this.lockOutActiveGesture(event);
        return null;
      }
      this.updateTrackedPositions(event.touches);
      const evaluation = this.evaluateTrackedState();
      this.emitProgress(evaluation.progress);
      return null;
    }

    if (count !== 2 || !this.canTrackEvent(event)) {
      this.lockOutActiveGesture(event);
      return null;
    }
    const first = event.touches[0];
    const second = event.touches[1];
    if (!first || !second || !this.startPoints.has(first.identifier) || !this.startPoints.has(second.identifier)) {
      this.lockOutActiveGesture(event);
      return null;
    }

    this.updateTrackedPositions(event.touches);
    const evaluation = this.evaluateTrackedState();
    if (evaluation.opposing) {
      this.lockOutActiveGesture(event);
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
      } else if (this.phase === 'long_press_pending' || this.phase === 'long_press_ready') {
        if (!this.findTouchById(event.touches, this.pendingTouchId)) {
          this.clearPendingOneFinger();
          this.phase = 'locked_out';
        }
      } else if (this.phase === 'idle' && remainingCount > 2) {
        this.enterStopPhase('locked_out', event);
      } else {
        this.snapshotLockedTouches(event);
      }
      return null;
    }

    const expectedMaxRemaining = this.activeMode === 'one_finger' ? 1 : 2;
    if (remainingCount > expectedMaxRemaining || !this.canTrackEvent(event)) {
      if (remainingCount === 0) {
        this.reset();
      } else {
        this.lockOutActiveGesture(event);
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
      this.lockOutActiveGesture(event);
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
  readonly longPressMs?: number;
}

export function attachMobileNavigationGestures(options: AttachMobileNavigationGesturesOptions): () => void {
  if (!options.isMobile) return () => {};
  const win = options.windowTarget ?? (typeof window !== 'undefined' ? window : undefined);
  if (!win) return () => {};
  const doc = options.document ?? win.document;

  const preventTouchDefault = (e: TouchEvent) => {
    if (e.cancelable !== false && typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
  };

  const tracker = new TwoFingerSwipeTracker({
    canTrack: (target) => canHandleMobileNavigationGesture(target, {
      isMobile: options.isMobile,
      hasBlockingOverlay: options.isBlocked?.() ?? false,
      document: doc,
    }),
    onProgress: options.onProgress,
    onActiveChange: (active) => setMobileNavigationGestureActiveState(doc, active),
    longPressMs: options.longPressMs,
  });

  const handleTouchStart = (e: TouchEvent) => {
    tracker.onTouchStart(e);
    if (tracker.isActive()) {
      preventTouchDefault(e);
    }
  };
  const handleTouchMove = (e: TouchEvent) => {
    const action = tracker.onTouchMove(e);
    if (tracker.isActive()) {
      preventTouchDefault(e);
    }
    if (action) options.onAction(action);
  };
  const handleTouchEnd = (e: TouchEvent) => {
    const wasActive = tracker.isActive();
    const action = tracker.onTouchEnd(e);
    if (wasActive) {
      preventTouchDefault(e);
      if (e.touches.length === 0) {
        markMobileNavigationGestureCompleted(doc);
      }
    }
    if (action) options.onAction(action);
  };
  const handleTouchCancel = (e: TouchEvent) => {
    const wasActive = tracker.isActive();
    tracker.onTouchCancel();
    if (wasActive) {
      preventTouchDefault(e);
      markMobileNavigationGestureCompleted(doc);
    }
  };
  const handleWindowBlur = () => tracker.reset();
  const handleVisibilityChange = () => {
    if (doc && doc.visibilityState !== 'visible') {
      tracker.reset();
    }
  };

  const listenerOpts: AddEventListenerOptions = { passive: false, capture: true };
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
