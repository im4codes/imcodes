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

/**
 * Safari can briefly report a visual viewport taller than the actual document
 * viewport while its browser chrome or window geometry is settling. Never let
 * that transient value grow the app beyond the currently visible layout box.
 */
export function boundedVisualViewportHeight(
  visualViewportHeight: number,
  windowInnerHeight: number,
  documentClientHeight: number,
): number | null {
  if (!isPositiveFinite(visualViewportHeight)) return null;
  const candidates = [visualViewportHeight];
  if (isPositiveFinite(windowInnerHeight)) candidates.push(windowInnerHeight);
  if (isPositiveFinite(documentClientHeight)) candidates.push(documentClientHeight);
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
