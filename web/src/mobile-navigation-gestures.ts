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
  readonly step: number;
  readonly maxSteps: number;
  readonly horizontalMaxSteps: number;
  readonly verticalMaxSteps: number;
}

export interface MobileNavigationTrigger {
  readonly action: MobileNavigationAction;
  readonly step: number;
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
export const MOBILE_SWIPE_STEP_BAND_HORIZONTAL_PX = 44;
export const MOBILE_SWIPE_STEP_BAND_VERTICAL_PX = 46;
export const MOBILE_SWIPE_STEP_HYSTERESIS_PX = 8;
export const MOBILE_SWIPE_HORIZONTAL_MAX_STEPS = 3;
export const MOBILE_SWIPE_VERTICAL_MAX_STEPS_DEFAULT = 3;
export const MOBILE_SWIPE_VERTICAL_MAX_STEPS_MEDIUM = 4;
export const MOBILE_SWIPE_VERTICAL_MAX_STEPS_TALL = 5;
export const MOBILE_SWIPE_TALL_VIEWPORT_HEIGHT_4_PX = 740;
export const MOBILE_SWIPE_TALL_VIEWPORT_HEIGHT_5_PX = 800;
export const MOBILE_SWIPE_DOMINANCE_RATIO = 1.35;
export const MOBILE_LONG_PRESS_MS = 380;
export const MOBILE_LONG_PRESS_STILL_TOLERANCE_PX = 12;
export const MOBILE_LONG_PRESS_DRAG_START_PX = 10;
export const MOBILE_NAV_GESTURE_ACTIVE_CLASS = 'mobile-nav-gesture-active';
export const MOBILE_NAV_GESTURE_ACTIVE_EVENT = 'imcodes:mobile-nav-gesture-active';
const MOBILE_SWIPE_DIRECTION_DEADZONE_PX = 4;
const MOBILE_GESTURE_RECENT_WINDOW_MS = 350;

export function resolveMobileSwipeVerticalMaxSteps(viewportHeight?: number): number {
  if (viewportHeight === undefined || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return MOBILE_SWIPE_VERTICAL_MAX_STEPS_DEFAULT;
  }
  if (viewportHeight >= MOBILE_SWIPE_TALL_VIEWPORT_HEIGHT_5_PX) {
    return MOBILE_SWIPE_VERTICAL_MAX_STEPS_TALL;
  }
  if (viewportHeight >= MOBILE_SWIPE_TALL_VIEWPORT_HEIGHT_4_PX) {
    return MOBILE_SWIPE_VERTICAL_MAX_STEPS_MEDIUM;
  }
  return MOBILE_SWIPE_VERTICAL_MAX_STEPS_DEFAULT;
}

export function getMobileSwipeStepThresholdPx(step: number, isVertical: boolean): number {
  if (!Number.isFinite(step) || step <= 1) {
    return MOBILE_SWIPE_PRIMARY_THRESHOLD_PX;
  }
  const bandPx = isVertical ? MOBILE_SWIPE_STEP_BAND_VERTICAL_PX : MOBILE_SWIPE_STEP_BAND_HORIZONTAL_PX;
  return MOBILE_SWIPE_PRIMARY_THRESHOLD_PX + (Math.trunc(step) - 1) * bandPx;
}

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
  serverPrev: ['↑'],
  serverNext: ['↓'],
  tabPrev: ['←'],
  tabNext: ['→'],
};

export function getMobileNavigationGestureKeycaps(
  action: MobileNavigationAction,
  step = 1,
): readonly string[] {
  const normalizedStep = Number.isFinite(step) ? Math.max(1, Math.trunc(step)) : 1;
  const base = MOBILE_NAVIGATION_GESTURE_KEYCAPS[action];
  return normalizedStep > 1 ? [...base, `×${normalizedStep}`] : base;
}

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

type TrackerPhase =
  | 'idle'
  | 'long_press_pending'
  | 'long_press_ready'
  | 'tracking'
  | 'triggered'
  | 'locked_out';

export interface TwoFingerSwipeTrackerOptions {
  readonly canTrack?: (target: EventTarget | null | undefined) => boolean;
  readonly onProgress?: (progress: MobileNavigationGestureProgress | null) => void;
  readonly onActiveChange?: (active: boolean) => void;
  readonly longPressMs?: number;
  readonly stillTolerancePx?: number;
  readonly dragStartPx?: number;
  readonly viewportHeight?: number;
  readonly getViewportHeight?: () => number | undefined;
  readonly getAvailableSteps?: (direction: MobileNavigationDirection) => number;
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}

interface GestureEvaluation {
  readonly opposing: boolean;
  readonly progress: MobileNavigationGestureProgress | null;
  readonly action: MobileNavigationAction | null;
  readonly step: number;
}

/**
 * Mobile 4-direction navigation swipe recognizer supporting one-finger
 * long-press + drag outside input/control bars and overlays.
 *
 * Emits live multi-step threshold/direction progress during active tracking,
 * triggers multi-step navigation (1..3 horizontally; 1..3/4/5 vertically by
 * viewport height) on `touchend` with anti-jitter hysteresis between levels,
 * and rejects multi-finger touches (2+ fingers lock out immediately), normal
 * 1-finger scrolling, long-press without drag, bottom control/input surfaces,
 * and diagonal ambiguity.
 */
export class TwoFingerSwipeTracker {
  private phase: TrackerPhase = 'idle';
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
  private lastCommittedDirection: MobileNavigationDirection | null = null;
  private lastCommittedStep = 0;
  private lastTrigger: MobileNavigationTrigger | null = null;
  private readonly canTrack: (target: EventTarget | null | undefined) => boolean;
  private readonly onProgress?: (progress: MobileNavigationGestureProgress | null) => void;
  private readonly onActiveChange?: (active: boolean) => void;
  private readonly longPressMs: number;
  private readonly stillTolerancePx: number;
  private readonly dragStartPx: number;
  private readonly viewportHeight?: number;
  private readonly getViewportHeight?: () => number | undefined;
  private readonly getAvailableSteps?: (direction: MobileNavigationDirection) => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (id: ReturnType<typeof setTimeout>) => void;

  constructor(options: TwoFingerSwipeTrackerOptions = {}) {
    this.canTrack = options.canTrack ?? (() => true);
    this.onProgress = options.onProgress;
    this.onActiveChange = options.onActiveChange;
    this.longPressMs = options.longPressMs ?? MOBILE_LONG_PRESS_MS;
    this.stillTolerancePx = options.stillTolerancePx ?? MOBILE_LONG_PRESS_STILL_TOLERANCE_PX;
    this.dragStartPx = options.dragStartPx ?? MOBILE_LONG_PRESS_DRAG_START_PX;
    this.viewportHeight = options.viewportHeight;
    this.getViewportHeight = options.getViewportHeight;
    this.getAvailableSteps = options.getAvailableSteps;
    this.setTimer = options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((id) => globalThis.clearTimeout(id));
  }

  isActive(): boolean {
    return this.phase === 'tracking' || this.phase === 'triggered';
  }

  getLastTriggeredResult(): MobileNavigationTrigger | null {
    return this.lastTrigger;
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
    this.lastCommittedDirection = null;
    this.lastCommittedStep = 0;
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

  private resolveAxisMaxSteps(direction: MobileNavigationDirection | null, verticalMaxSteps: number, horizontalMaxSteps: number): number {
    if (!direction) return verticalMaxSteps;
    const axisCap = (direction === 'up' || direction === 'down') ? verticalMaxSteps : horizontalMaxSteps;
    if (!this.getAvailableSteps) return axisCap;
    const available = this.getAvailableSteps(direction);
    if (!Number.isFinite(available) || available <= 0) return 0;
    return Math.min(axisCap, Math.trunc(available));
  }

  private resolveStepWithHysteresis(
    direction: MobileNavigationDirection | null,
    distance: number,
    isVertical: boolean,
    maxSteps: number,
  ): number {
    if (!direction || maxSteps <= 0) {
      this.lastCommittedDirection = direction;
      this.lastCommittedStep = 0;
      return 0;
    }

    let rawStep = 0;
    for (let k = 1; k <= maxSteps; k++) {
      if (distance >= getMobileSwipeStepThresholdPx(k, isVertical)) {
        rawStep = k;
      } else {
        break;
      }
    }

    const prevStep = this.lastCommittedDirection === direction
      ? Math.min(this.lastCommittedStep, maxSteps)
      : 0;

    let step = rawStep;
    if (prevStep > rawStep) {
      let held = prevStep;
      while (held > rawStep) {
        const exitThreshold = getMobileSwipeStepThresholdPx(held, isVertical) - MOBILE_SWIPE_STEP_HYSTERESIS_PX;
        if (distance >= exitThreshold) {
          step = held;
          break;
        }
        held -= 1;
      }
    }

    this.lastCommittedDirection = direction;
    this.lastCommittedStep = step;
    return step;
  }

  private buildEvaluation(dx: number, dy: number): GestureEvaluation {
    const horizontalMaxSteps = MOBILE_SWIPE_HORIZONTAL_MAX_STEPS;
    const verticalMaxSteps = resolveMobileSwipeVerticalMaxSteps(
      this.viewportHeight ?? this.getViewportHeight?.(),
    );

    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const isVertical = absDy >= absDx;
    const primary = isVertical ? dy : dx;
    const absPrimary = isVertical ? absDy : absDx;
    const absCross = isVertical ? absDx : absDy;

    let direction: MobileNavigationDirection | null = null;
    if (
      absPrimary >= MOBILE_SWIPE_DIRECTION_DEADZONE_PX
      && absPrimary >= absCross * MOBILE_SWIPE_DOMINANCE_RATIO
    ) {
      if (isVertical) {
        direction = primary < 0 ? 'up' : 'down';
      } else {
        direction = primary < 0 ? 'left' : 'right';
      }
    }

    const distance = direction ? absPrimary : 0;
    const maxSteps = this.resolveAxisMaxSteps(direction, verticalMaxSteps, horizontalMaxSteps);
    const step = this.resolveStepWithHysteresis(direction, distance, isVertical, maxSteps);
    const armed = step > 0;
    const action = direction ? DIRECTION_TO_ACTION[direction] : null;
    const committedAction = armed ? action : null;
    const progress = armed
      ? 1
      : (direction && maxSteps > 0 ? Math.min(0.99, distance / MOBILE_SWIPE_PRIMARY_THRESHOLD_PX) : 0);

    return {
      opposing: false,
      action: committedAction,
      step,
      progress: {
        dx,
        dy,
        direction,
        action,
        distance,
        threshold: MOBILE_SWIPE_PRIMARY_THRESHOLD_PX,
        progress,
        armed,
        step,
        maxSteps,
        horizontalMaxSteps,
        verticalMaxSteps,
      },
    };
  }

  private evaluateTrackedState(): GestureEvaluation {
    const ids = Array.from(this.startPoints.keys());
    if (ids.length !== 1) return { opposing: false, progress: null, action: null, step: 0 };
    const id = ids[0]!;
    const start = this.startPoints.get(id);
    const end = this.lastPoints.get(id);
    if (!start || !end) return { opposing: false, progress: null, action: null, step: 0 };
    return this.buildEvaluation(end.x - start.x, end.y - start.y);
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
    this.lastTrigger = null;
    const count = event.touches.length;
    if (count >= 2) {
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
    }
  }

  onTouchMove(event: TouchEventLike): MobileNavigationAction | null {
    const count = event.touches.length;
    if (count === 0) {
      this.reset();
      return null;
    }
    if (count >= 2) {
      this.lockOutActiveGesture(event);
      return null;
    }

    if (this.phase === 'long_press_pending') {
      if (!this.canTrackEvent(event)) {
        this.lockOutActiveGesture(event);
        return null;
      }
      const touch = this.findTouchById(event.touches, this.pendingTouchId);
      if (!touch || !this.pendingStartPoint) {
        this.lockOutActiveGesture(event);
        return null;
      }
      const moveDist = Math.hypot(
        touch.clientX - this.pendingStartPoint.x,
        touch.clientY - this.pendingStartPoint.y,
      );
      if (moveDist > this.stillTolerancePx) {
        // User is scrolling/dragging before long-press armed: cancel & lock out for this touch sequence.
        this.lockOutActiveGesture(event);
        return null;
      }
      this.pendingLastPoint = { x: touch.clientX, y: touch.clientY };
      return null;
    }

    if (this.phase === 'long_press_ready') {
      if (!this.canTrackEvent(event)) {
        this.lockOutActiveGesture(event);
        return null;
      }
      const touch = this.findTouchById(event.touches, this.pendingTouchId);
      const anchor = this.longPressAnchor ?? this.pendingStartPoint;
      if (!touch || !anchor) {
        this.lockOutActiveGesture(event);
        return null;
      }
      this.pendingLastPoint = { x: touch.clientX, y: touch.clientY };
      const dragDist = Math.hypot(touch.clientX - anchor.x, touch.clientY - anchor.y);
      if (dragDist < this.dragStartPx) {
        return null;
      }
      this.clearPendingOneFinger();
      this.clearTrackedPoints();
      this.startPoints.set(touch.identifier, anchor);
      this.lastPoints.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
      this.phase = 'tracking';
      this.setActive(true);
      const evaluation = this.evaluateTrackedState();
      this.emitProgress(evaluation.progress);
      return null;
    }

    if (this.phase !== 'tracking') {
      if (
        this.lockedTouches.size > 0
        && !this.hasMatchingLockedTouch(event.touches)
      ) {
        this.reset();
      }
      return null;
    }

    if (!this.canTrackEvent(event)) {
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

  evaluateTouchEnd(event: TouchEventLike): MobileNavigationTrigger | null {
    const remainingCount = event.touches.length;
    if (this.phase !== 'tracking') {
      if (remainingCount === 0) {
        this.reset();
      } else if (this.phase === 'long_press_pending' || this.phase === 'long_press_ready') {
        if (!this.findTouchById(event.touches, this.pendingTouchId) || remainingCount >= 2) {
          this.lockOutActiveGesture(event);
        }
      } else if (remainingCount >= 2) {
        this.lockOutActiveGesture(event);
      } else {
        this.snapshotLockedTouches(event);
      }
      return null;
    }

    if (remainingCount !== 0 || !this.canTrackEvent(event)) {
      if (remainingCount === 0) {
        this.reset();
      } else {
        this.lockOutActiveGesture(event);
      }
      return null;
    }

    this.updateTrackedPositions(event.changedTouches);
    const evaluation = this.evaluateTrackedState();

    if (!evaluation.opposing && evaluation.action && evaluation.step > 0) {
      const trigger: MobileNavigationTrigger = {
        action: evaluation.action,
        step: evaluation.step,
      };
      this.lastTrigger = trigger;
      this.reset();
      return trigger;
    }

    this.lastTrigger = null;
    this.reset();
    return null;
  }

  onTouchEnd(event: TouchEventLike): MobileNavigationAction | null {
    return this.evaluateTouchEnd(event)?.action ?? null;
  }

  onTouchCancel(): void {
    this.lastTrigger = null;
    this.reset();
  }
}

export const MobileNavigationGestureTracker = TwoFingerSwipeTracker;

export interface AttachMobileNavigationGesturesOptions {
  readonly isMobile: boolean;
  readonly windowTarget?: Window;
  readonly document?: Document;
  readonly isBlocked?: () => boolean;
  readonly onAction: (action: MobileNavigationAction, step: number) => void;
  readonly onProgress?: (progress: MobileNavigationGestureProgress | null) => void;
  readonly longPressMs?: number;
  readonly viewportHeight?: number;
  readonly getViewportHeight?: () => number | undefined;
  readonly getAvailableSteps?: (direction: MobileNavigationDirection) => number;
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
    viewportHeight: options.viewportHeight,
    getViewportHeight: options.getViewportHeight ?? (() => win.innerHeight),
    getAvailableSteps: options.getAvailableSteps,
  });

  const handleTouchStart = (e: TouchEvent) => {
    tracker.onTouchStart(e);
    if (tracker.isActive()) {
      preventTouchDefault(e);
    }
  };
  const handleTouchMove = (e: TouchEvent) => {
    tracker.onTouchMove(e);
    if (tracker.isActive()) {
      preventTouchDefault(e);
    }
  };
  const handleTouchEnd = (e: TouchEvent) => {
    const wasActive = tracker.isActive();
    const trigger = tracker.evaluateTouchEnd(e);
    if (wasActive) {
      preventTouchDefault(e);
      if (e.touches.length === 0) {
        markMobileNavigationGestureCompleted(doc);
      }
    }
    if (trigger) options.onAction(trigger.action, trigger.step);
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
