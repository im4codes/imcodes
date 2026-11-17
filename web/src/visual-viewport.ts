const VIEWPORT_SETTLE_DELAY_MS = 200;

interface ViewportScheduler {
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(handle: number): void;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function normalizeDocumentClientHeight(
  documentClientHeight: number,
  windowInnerHeight: number,
  cssZoom: number,
): number {
  if (!isPositiveFinite(cssZoom) || Math.abs(cssZoom - 1) <= 0.001) {
    return documentClientHeight;
  }
  const zoomedToUnzoomed = documentClientHeight * cssZoom;
  if (!isPositiveFinite(windowInnerHeight)) {
    return zoomedToUnzoomed;
  }
  const candidates = [zoomedToUnzoomed, documentClientHeight];
  if (cssZoom < 1 && documentClientHeight < windowInnerHeight) {
    candidates.push(documentClientHeight / cssZoom);
  }
  let best = candidates[0]!;
  let bestDelta = Math.abs(best - windowInnerHeight);
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const delta = Math.abs(candidate - windowInnerHeight);
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  // `clientHeight` is an integer CSS pixel count, so `Math.round(innerH / zoom) * zoom`
  // can drift by up to `cssZoom` px (e.g. 866 * 0.9 = 779.4 vs 780). Snap sub-step
  // rounding back to `windowInnerHeight` so closed-keyboard zoom never creates phantom shrink.
  if (bestDelta <= Math.ceil(cssZoom) + 1) {
    return windowInnerHeight;
  }
  return best;
}

/**
 * Safari can briefly report a visual viewport taller than the actual document
 * viewport while its browser chrome or window geometry is settling. Never let
 * that transient value grow the app beyond the currently visible layout box.
 * When whole-page CSS `zoom` is active on `<html>`, `documentElement.clientHeight`
 * is reported in zoomed CSS pixels (`≈ innerHeight / cssZoom`), so normalize it
 * back into unzoomed viewport pixels before comparing against `visualViewport.height`.
 */
export function boundedVisualViewportHeight(
  visualViewportHeight: number,
  windowInnerHeight: number,
  documentClientHeight: number,
  cssZoom = 1,
): number | null {
  if (!isPositiveFinite(visualViewportHeight)) return null;
  const candidates = [visualViewportHeight];
  if (isPositiveFinite(windowInnerHeight)) candidates.push(windowInnerHeight);
  if (isPositiveFinite(documentClientHeight)) {
    candidates.push(normalizeDocumentClientHeight(documentClientHeight, windowInnerHeight, cssZoom));
  }
  return Math.min(...candidates);
}

function browserViewportScheduler(): ViewportScheduler {
  return {
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimer: (handle) => window.clearTimeout(handle),
  };
}

/**
 * WebKit can fire visualViewport.resize before visualViewport.height reflects
 * the new geometry. Apply once immediately, then re-read on two paints and once
 * after browser-chrome animation settles. A new event replaces stale follow-ups.
 */
export function createSettledViewportUpdater(
  update: () => void,
  scheduler: ViewportScheduler = browserViewportScheduler(),
): { schedule: () => void; cancel: () => void } {
  let firstFrame: number | null = null;
  let secondFrame: number | null = null;
  let settleTimer: number | null = null;

  const cancel = () => {
    if (firstFrame !== null) scheduler.cancelFrame(firstFrame);
    if (secondFrame !== null) scheduler.cancelFrame(secondFrame);
    if (settleTimer !== null) scheduler.clearTimer(settleTimer);
    firstFrame = null;
    secondFrame = null;
    settleTimer = null;
  };

  const schedule = () => {
    cancel();
    update();
    firstFrame = scheduler.requestFrame(() => {
      firstFrame = null;
      update();
      secondFrame = scheduler.requestFrame(() => {
        secondFrame = null;
        update();
      });
    });
    settleTimer = scheduler.setTimer(() => {
      settleTimer = null;
      update();
    }, VIEWPORT_SETTLE_DELAY_MS);
  };

  return { schedule, cancel };
}
