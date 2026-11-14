type CapacitorRuntime = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
};

type UserAgentDataLike = {
  platform?: string;
};

type NavigatorLike = {
  platform?: string;
  userAgent?: string;
  maxTouchPoints?: number;
  userAgentData?: UserAgentDataLike;
};

type MatchMediaLike = (query: string) => { matches: boolean };

export type NativeHostScaleMode = 'none' | 'native-1x' | 'native-page-zoom' | 'legacy-css';

export type NativeHostInfo = {
  isMacDesktop?: boolean;
  pageZoomApplied?: boolean;
  scaleMode?: NativeHostScaleMode;
};

export type NativePlatformEnvironment = {
  capacitor?: CapacitorRuntime | null;
  navigator?: NavigatorLike | null;
  matchMedia?: MatchMediaLike | null;
  innerWidth?: number;
  nativeHost?: NativeHostInfo | null;
};

export const NATIVE_HOST_EVENT = 'imcodes:native-host';
export const IOS_MAC_DESKTOP_CLASS = 'native-mac-desktop';
export const IOS_MAC_TEXT_SCALE_CLASS = 'native-ios-mac';
export const IOS_MAC_TERMINAL_FONT_SIZE = 15;

function readNativePlatformEnvironment(): NativePlatformEnvironment {
  const runtime = globalThis as typeof globalThis & {
    Capacitor?: CapacitorRuntime;
    __IMCODES_NATIVE_HOST__?: NativeHostInfo;
  };
  return {
    capacitor: runtime.Capacitor,
    navigator: globalThis.navigator,
    matchMedia: typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia.bind(globalThis)
      : undefined,
    innerWidth: globalThis.innerWidth,
    nativeHost: runtime.__IMCODES_NATIVE_HOST__,
  };
}

function getNativePlatform(env: NativePlatformEnvironment): string | null {
  const capacitor = env.capacitor;
  if (capacitor?.isNativePlatform?.() !== true) return null;
  const platform = capacitor.getPlatform?.();
  return typeof platform === 'string' && platform.length > 0 ? platform : null;
}

/**
 * Detects whether the Capacitor iOS bundle is running on macOS
 * ("Designed for iPad" / Mac Catalyst) rather than on a real iPhone/iPad.
 */
export function isNativeMacDesktop(env: NativePlatformEnvironment = readNativePlatformEnvironment()): boolean {
  if (getNativePlatform(env) !== 'ios') return false;

  if (typeof env.nativeHost?.isMacDesktop === 'boolean') {
    return env.nativeHost.isMacDesktop;
  }

  const navigatorLike = env.navigator;
  const maxTouchPoints = navigatorLike?.maxTouchPoints ?? 0;
  // Real iPhones and iPads expose multi-touch (>= 2 points), including iPads with a trackpad.
  if (maxTouchPoints > 1) return false;

  const platformMarker = [
    navigatorLike?.platform,
    navigatorLike?.userAgentData?.platform,
  ].filter(Boolean).join(' ').toLowerCase();
  if (platformMarker.includes('mac')) return true;

  const userAgent = navigatorLike?.userAgent ?? '';
  // Note: real iPhone/iPad UAs contain "like Mac OS X", so only match Mac UA without Apple mobile tokens.
  if (/Macintosh|Mac OS X/i.test(userAgent) && !/iPhone|iPad|iPod/i.test(userAgent)) {
    return true;
  }

  const hasDesktopPointer = env.matchMedia?.('(hover: hover) and (pointer: fine)').matches === true;
  return hasDesktopPointer && !/iPhone|iPod/i.test(userAgent);
}

export function shouldUseIosMacTextScale(env: NativePlatformEnvironment = readNativePlatformEnvironment()): boolean {
  if (!isNativeMacDesktop(env)) return false;
  const host = env.nativeHost;
  if (host?.scaleMode === 'legacy-css') return true;
  if (host?.scaleMode === 'native-1x' || host?.scaleMode === 'native-page-zoom' || host?.scaleMode === 'none') {
    return false;
  }
  // When native WKWebView.pageZoom already compensates macOS's 0.77x Designed-for-iPad scaling,
  // avoid stacking CSS font-size overrides on top of the zoomed viewport.
  if (host?.pageZoomApplied === true) return false;
  // An authoritative native host reporting { isMacDesktop: true, pageZoomApplied: false }
  // (e.g. Mac Catalyst .mac idiom) already renders at 1:1 desktop scale without CSS bumping.
  // Legacy native shells without __IMCODES_NATIVE_HOST__ keep the CSS/terminal fallback.
  if (typeof host?.isMacDesktop === 'boolean' && typeof host?.pageZoomApplied === 'boolean') {
    return false;
  }
  return true;
}

export function applyNativePlatformClasses(
  root: HTMLElement | undefined = globalThis.document?.documentElement,
  env: NativePlatformEnvironment = readNativePlatformEnvironment(),
): void {
  if (!root) return;
  const platform = getNativePlatform(env);
  if (platform) root.dataset.nativePlatform = platform;
  else delete root.dataset.nativePlatform;
  root.classList.toggle(IOS_MAC_DESKTOP_CLASS, isNativeMacDesktop(env));
  root.classList.toggle(IOS_MAC_TEXT_SCALE_CLASS, shouldUseIosMacTextScale(env));
}
