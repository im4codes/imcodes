/** Phone/tablet detection used by the app shell. */
export function isMobileUserAgent(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /iPhone|iPad|iPod|Android/i.test(userAgent);
}

export type MobileLayoutOptions = {
  userAgent?: string;
  width?: number;
  pointerCoarse?: boolean;
  maxTouchPoints?: number;
  native?: boolean;
};

/**
 * Device decision for the app shell. This deliberately does not inspect
 * viewport width: a desktop window may be resized narrow without becoming a
 * phone layout, while desktop-site mobile browsers still expose touch.
 */
export function isMobileDevice(options: MobileLayoutOptions = {}): boolean {
  const userAgent = options.userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const maxTouchPoints = options.maxTouchPoints ?? (typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints || 0);
  const capacitor = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  const native = options.native ?? Boolean(capacitor?.isNativePlatform?.());
  if (native || isMobileUserAgent(userAgent)) return true;
  // iPadOS desktop-class Safari identifies as Macintosh but still exposes a
  // multi-touch surface. Treat it as mobile regardless of its CSS width.
  if (maxTouchPoints > 1 && /Macintosh|Mac OS X/i.test(userAgent)) return true;
  const coarse = options.pointerCoarse ?? (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false);
  return coarse && maxTouchPoints > 0;
}

/** Responsive panel decision; unlike the app shell, panels compact in narrow desktop windows. */
export function isMobileLayout(options: MobileLayoutOptions = {}): boolean {
  const width = options.width ?? (typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : undefined);
  return isMobileDevice(options) || (width !== undefined && width <= 720);
}
