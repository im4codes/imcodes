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

export type NativePlatformEnvironment = {
  capacitor?: CapacitorRuntime | null;
  navigator?: NavigatorLike | null;
  matchMedia?: MatchMediaLike | null;
  innerWidth?: number;
};

export const IOS_MAC_TEXT_SCALE_CLASS = 'native-ios-mac';
export const IOS_MAC_TERMINAL_FONT_SIZE = 15;

function readNativePlatformEnvironment(): NativePlatformEnvironment {
  const runtime = globalThis as typeof globalThis & { Capacitor?: CapacitorRuntime };
  return {
    capacitor: runtime.Capacitor,
    navigator: globalThis.navigator,
    matchMedia: typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia.bind(globalThis)
      : undefined,
    innerWidth: globalThis.innerWidth,
  };
}

function getNativePlatform(env: NativePlatformEnvironment): string | null {
  const capacitor = env.capacitor;
  if (capacitor?.isNativePlatform?.() !== true) return null;
  const platform = capacitor.getPlatform?.();
  return typeof platform === 'string' && platform.length > 0 ? platform : null;
}

export function shouldUseIosMacTextScale(env: NativePlatformEnvironment = readNativePlatformEnvironment()): boolean {
  if (getNativePlatform(env) !== 'ios') return false;

  const navigatorLike = env.navigator;
  const maxTouchPoints = navigatorLike?.maxTouchPoints ?? 0;
  if (maxTouchPoints > 1) return false;

  const platformText = [
    navigatorLike?.platform,
    navigatorLike?.userAgentData?.platform,
    navigatorLike?.userAgent,
  ].filter(Boolean).join(' ').toLowerCase();
  if (platformText.includes('mac')) return true;

  const hasDesktopPointer = env.matchMedia?.('(hover: hover) and (pointer: fine)').matches === true;
  const hasDesktopWidth = (env.innerWidth ?? 0) >= 768;
  return hasDesktopPointer && hasDesktopWidth;
}

export function applyNativePlatformClasses(
  root: HTMLElement | undefined = globalThis.document?.documentElement,
  env: NativePlatformEnvironment = readNativePlatformEnvironment(),
): void {
  if (!root) return;
  const platform = getNativePlatform(env);
  if (platform) root.dataset.nativePlatform = platform;
  else delete root.dataset.nativePlatform;
  root.classList.toggle(IOS_MAC_TEXT_SCALE_CLASS, shouldUseIosMacTextScale(env));
}
