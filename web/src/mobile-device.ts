/**
 * Phone/tablet detection used by the app shell to choose its mobile layout.
 * Components that must agree with that layout (e.g. the task status panel)
 * use this instead of a viewport-width guess: some mobile WebViews report a
 * CSS width above the narrow-screen breakpoint while the app is in its mobile
 * layout.
 */
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
 * The one layout decision shared by the app shell and responsive panels.
 * iPadOS can deliberately advertise a desktop Macintosh UA, and Capacitor
 * WebViews can report a wide CSS viewport, so UA/width alone is insufficient.
 */
export function isMobileLayout(options: MobileLayoutOptions = {}): boolean {
  const userAgent = options.userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const width = options.width ?? (typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : undefined);
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
  return width !== undefined && (width <= 720 || (coarse && width <= 1024));
}
