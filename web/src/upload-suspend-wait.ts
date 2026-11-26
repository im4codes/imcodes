export const UPLOAD_SUSPEND_MAX_WAIT_MS = 30 * 60 * 1000;
export const UPLOAD_FOREGROUND_RESUME_GRACE_MS = 10_000;
export const UPLOAD_POST_RESUME_SETTLE_MS = 250;
export const UPLOAD_MAX_LIFECYCLE_PAUSES = 50;
export const UPLOAD_MAX_GRACE_RETRIES_PER_EPOCH = 3;

export interface UploadLifecycleRecoveryState {
  lifecyclePauses: number;
  graceEpoch: number;
  graceRetriesInEpoch: number;
}

let backgroundEpoch = 0;
let isSuspendedByLifecycle = false;
let lastSuspendStartedAt = 0;
let lastForegroundResumeAt = 0;
let listenersInstalled = false;
const resumeWaiters = new Set<() => void>();

function createAbortError(): Error {
  const err = new Error('Upload canceled');
  err.name = 'AbortError';
  return err;
}

function markSuspended(): void {
  if (!isSuspendedByLifecycle) {
    isSuspendedByLifecycle = true;
    backgroundEpoch += 1;
    lastSuspendStartedAt = Date.now();
  }
}

function markResumed(): void {
  if (isSuspendedByLifecycle || lastSuspendStartedAt > lastForegroundResumeAt) {
    isSuspendedByLifecycle = false;
    backgroundEpoch += 1;
    lastForegroundResumeAt = Date.now();
    for (const notify of [...resumeWaiters]) {
      notify();
    }
  }
}

function isEnvironmentPhysicallySuspended(): boolean {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return hidden || offline;
}

function onVisibilityChange(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    markSuspended();
  } else if (!isEnvironmentPhysicallySuspended()) {
    markResumed();
  }
}

function onPageHide(): void {
  markSuspended();
}

function onOffline(): void {
  markSuspended();
}

function onPotentialResume(): void {
  if (!isEnvironmentPhysicallySuspended()) {
    markResumed();
  }
}

function ensureLifecycleListeners(): void {
  if (listenersInstalled) return;
  if (typeof document === 'undefined' && typeof window === 'undefined') return;
  listenersInstalled = true;
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPotentialResume);
    window.addEventListener('focus', onPotentialResume);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onPotentialResume);
  }
}

ensureLifecycleListeners();

export function notifyUploadAppStateChange(isActive: boolean): void {
  ensureLifecycleListeners();
  if (isActive) {
    onPotentialResume();
  } else {
    markSuspended();
  }
}

export function getUploadBackgroundEpoch(): number {
  ensureLifecycleListeners();
  return backgroundEpoch;
}

export function resetUploadLifecycleForTests(): void {
  backgroundEpoch = 0;
  isSuspendedByLifecycle = false;
  lastSuspendStartedAt = 0;
  lastForegroundResumeAt = 0;
  resumeWaiters.clear();
  listenersInstalled = false;
  ensureLifecycleListeners();
}

export function getUploadResumeWaiterCountForTests(): number {
  return resumeWaiters.size;
}

export function createUploadLifecycleRecoveryState(): UploadLifecycleRecoveryState {
  return {
    lifecyclePauses: 0,
    graceEpoch: -1,
    graceRetriesInEpoch: 0,
  };
}

export function isUploadEnvironmentSuspended(): boolean {
  return isSuspendedByLifecycle || isEnvironmentPhysicallySuspended();
}

function waitAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Pause retry consumption while the app is backgrounded or offline, waking immediately
 * on foreground/online transition, AbortSignal cancellation, or the bounded maxWaitMs.
 * Returns true if the caller waited for a suspended period, false if not suspended.
 */
export function waitForUploadResumeIfSuspended(
  signal?: AbortSignal,
  maxWaitMs = UPLOAD_SUSPEND_MAX_WAIT_MS,
): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  if (!isUploadEnvironmentSuspended()) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resumeWaiters.delete(settleIfForegroundReady);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onEnvironmentChange);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onEnvironmentChange);
        window.removeEventListener('pageshow', onEnvironmentChange);
        window.removeEventListener('online', onEnvironmentChange);
      }
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    };

    const settleIfForegroundReady = () => {
      if (!isEnvironmentPhysicallySuspended() && !isSuspendedByLifecycle) {
        finish();
      }
    };

    const onEnvironmentChange = () => {
      if (!isEnvironmentPhysicallySuspended()) {
        markResumed();
        finish();
      }
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createAbortError());
    };

    resumeWaiters.add(settleIfForegroundReady);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onEnvironmentChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onEnvironmentChange);
      window.addEventListener('pageshow', onEnvironmentChange);
      window.addEventListener('online', onEnvironmentChange);
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    if (!isEnvironmentPhysicallySuspended() && !isSuspendedByLifecycle) {
      finish();
      return;
    }

    timer = setTimeout(finish, Math.max(100, maxWaitMs));
  });
}

/**
 * Recognizes failures caused by mobile backgrounding or iOS WKWebView freezing:
 * 1. Currently suspended (hidden/offline/background app state) -> waits for resume.
 * 2. Crossed `backgroundEpoch` (e.g. iOS XHR/WebRTC fails *after* returning to foreground).
 * 3. Within `UPLOAD_FOREGROUND_RESUME_GRACE_MS` right after returning to foreground (bounded per epoch).
 */
export async function recoverUploadFromLifecycleIfNeeded(
  attemptEpoch: number,
  state: UploadLifecycleRecoveryState,
  signal?: AbortSignal,
): Promise<'suspended' | 'crossed_epoch' | 'grace' | 'none'> {
  ensureLifecycleListeners();
  if (signal?.aborted) {
    throw createAbortError();
  }

  const currentEpoch = backgroundEpoch;
  if (isUploadEnvironmentSuspended()) {
    if (state.lifecyclePauses >= UPLOAD_MAX_LIFECYCLE_PAUSES) return 'none';
    state.lifecyclePauses += 1;
    state.graceEpoch = backgroundEpoch;
    state.graceRetriesInEpoch = 0;
    await waitForUploadResumeIfSuspended(signal);
    return 'suspended';
  }

  if (currentEpoch !== attemptEpoch) {
    if (state.lifecyclePauses >= UPLOAD_MAX_LIFECYCLE_PAUSES) return 'none';
    state.lifecyclePauses += 1;
    state.graceEpoch = currentEpoch;
    state.graceRetriesInEpoch = 0;
    await waitAbortable(UPLOAD_POST_RESUME_SETTLE_MS, signal);
    return 'crossed_epoch';
  }

  const withinGrace = lastSuspendStartedAt > 0
    && lastForegroundResumeAt > 0
    && (Date.now() - lastForegroundResumeAt) <= UPLOAD_FOREGROUND_RESUME_GRACE_MS;
  if (withinGrace) {
    if (state.graceEpoch !== currentEpoch) {
      state.graceEpoch = currentEpoch;
      state.graceRetriesInEpoch = 0;
    }
    if (state.graceRetriesInEpoch < UPLOAD_MAX_GRACE_RETRIES_PER_EPOCH
      && state.lifecyclePauses < UPLOAD_MAX_LIFECYCLE_PAUSES) {
      state.graceRetriesInEpoch += 1;
      state.lifecyclePauses += 1;
      await waitAbortable(UPLOAD_POST_RESUME_SETTLE_MS, signal);
      return 'grace';
    }
  }

  return 'none';
}
