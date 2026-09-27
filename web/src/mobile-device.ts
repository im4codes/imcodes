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
