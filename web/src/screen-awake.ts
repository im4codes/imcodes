/**
 * Keep the screen on while a long foreground task runs (voice notepad).
 * Native builds use the keep-awake plugin (iOS idle timer / Android
 * FLAG_KEEP_SCREEN_ON). Browsers — and older app binaries that received this
 * web bundle over the air without the plugin — fall back to the Screen Wake
 * Lock API, which the browser drops while the page is hidden, so it is
 * re-acquired on return.
 */
import { KeepAwake } from '@capacitor-community/keep-awake';

type WakeLockSentinelLike = { release: () => Promise<void> };
type WakeLockApi = { request: (type: 'screen') => Promise<WakeLockSentinelLike> };

function isNative(): boolean {
  return !!(globalThis as any).Capacitor?.isNativePlatform?.();
}

/** Acquire; returns a release function. Never throws. */
export function holdScreenAwake(): () => void {
  let released = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let usingNative = false;

  const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
  const requestWebLock = () => {
    if (released || !wakeLock || sentinel || document.visibilityState !== 'visible') return;
    wakeLock.request('screen').then((lock) => {
      if (released) void lock.release().catch(() => undefined);
      else sentinel = lock;
    }).catch(() => undefined);
  };
  const onVisibility = () => {
    if (document.visibilityState !== 'visible') return;
    sentinel = null;
    requestWebLock();
  };
  const startWebFallback = () => {
    if (released || !wakeLock) return;
    document.addEventListener('visibilitychange', onVisibility);
    requestWebLock();
  };

  if (isNative()) {
    KeepAwake.keepAwake().then(() => {
      usingNative = true;
      if (released) void KeepAwake.allowSleep().catch(() => undefined);
    }).catch(startWebFallback);
  } else {
    startWebFallback();
  }

  return () => {
    if (released) return;
    released = true;
    document.removeEventListener('visibilitychange', onVisibility);
    if (usingNative) void KeepAwake.allowSleep().catch(() => undefined);
    const lock = sentinel;
    sentinel = null;
    if (lock) void lock.release().catch(() => undefined);
  };
}
