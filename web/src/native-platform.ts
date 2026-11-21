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

export type NativeHostScaleMode =
  | 'designed-for-ipad'
  | 'native-page-zoom'
  | 'native-1x'
  | 'legacy-css'
  | 'none';

export type NativeHostInfo = {
  isMacDesktop?: boolean;
  pageZoomApplied?: boolean;
  scaleMode?: NativeHostScaleMode;
};

export type PcAppMediaAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export interface PcAppVoicePermissions {
  mic: PcAppMediaAccessStatus;
  speech: PcAppMediaAccessStatus | 'unavailable';
  platform: string;
  nativeSpeechAvailable: boolean;
}

export type PcAppVoiceEvent =
  | { type: 'start' }
  | { type: 'level'; value: number }
  | { type: 'result'; text: string; isFinal: boolean }
  | { type: 'error'; code: string; target?: 'mic' | 'speech'; message?: string }
  | { type: 'end' };

export type PcAppSpeechModelChoice = 'system' | 'qwen3-0.6b' | 'qwen3-1.7b';

export interface PcAppSpeechModelStatus {
  selectedModel: PcAppSpeechModelChoice;
  activeBackend: PcAppSpeechModelChoice;
  state: 'idle' | 'downloading' | 'ready' | 'failed' | 'unsupported';
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  mlxSupported: boolean;
  error?: string;
  modelDir?: string;
}

export interface PcAppVoiceInputDevice {
  uid: string;
  name: string;
  transport: string;
  isDefault: boolean;
  isPhysical: boolean;
}

export interface PcAppBridge {
  platform?: string;
  isElectron?: boolean;
  voice?: {
    isNativeSpeechSupported?: () => boolean;
    getPermissions?: () => Promise<PcAppVoicePermissions>;
    requestPermissions?: () => Promise<PcAppVoicePermissions>;
    openPrivacySettings?: (target: 'microphone' | 'speech') => Promise<boolean>;
    startListening?: (options?: { locale?: string }) => Promise<{ ok: boolean; error?: string; target?: 'mic' | 'speech' }>;
    stopListening?: (options?: { abort?: boolean }) => Promise<void>;
    getSpeechModel?: () => Promise<PcAppSpeechModelChoice>;
    setSpeechModel?: (model: PcAppSpeechModelChoice) => Promise<PcAppSpeechModelStatus>;
    getSpeechModelStatus?: () => Promise<PcAppSpeechModelStatus>;
    getInputDevices?: () => Promise<PcAppVoiceInputDevice[]>;
    getInputDevice?: () => Promise<string>;
    setInputDevice?: (uid: string) => Promise<string>;
    getSelectedInputDevice?: () => Promise<string>;
    setSelectedInputDevice?: (uid: string) => Promise<string>;
    subscribe?: (listener: (event: PcAppVoiceEvent) => void) => () => void;
  };
}

export type NativePlatformEnvironment = {
  capacitor?: CapacitorRuntime | null;
  navigator?: NavigatorLike | null;
  matchMedia?: MatchMediaLike | null;
  innerWidth?: number;
  nativeHost?: NativeHostInfo | null;
  pcApp?: PcAppBridge | null;
};

export const NATIVE_HOST_EVENT = 'imcodes:native-host';
export const IOS_MAC_DESKTOP_CLASS = 'native-mac-desktop';
export const IOS_MAC_TEXT_SCALE_CLASS = 'native-ios-mac';
export const IOS_MAC_TERMINAL_FONT_SIZE = 15;

export function readNativePlatformEnvironment(): NativePlatformEnvironment {
  const runtime = globalThis as typeof globalThis & {
    Capacitor?: CapacitorRuntime;
    __IMCODES_NATIVE_HOST__?: NativeHostInfo;
    __IMCODES_PC_APP__?: PcAppBridge;
  };
  return {
    capacitor: runtime.Capacitor,
    navigator: globalThis.navigator,
    matchMedia: typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia.bind(globalThis)
      : undefined,
    innerWidth: globalThis.innerWidth,
    nativeHost: runtime.__IMCODES_NATIVE_HOST__,
    pcApp: runtime.__IMCODES_PC_APP__,
  };
}

/** Returns the Electron PC App preload bridge when running inside IM.codes desktop shell. */
export function getPcAppBridge(env: NativePlatformEnvironment = readNativePlatformEnvironment()): PcAppBridge | null {
  const bridge = env.pcApp;
  if (!bridge || typeof bridge !== 'object') return null;
  if (bridge.isElectron !== true && typeof bridge.voice !== 'object') return null;
  return bridge;
}

/**
 * Returns true when running inside the Electron PC App desktop shell (`apps/pc-app`),
 * independent of Capacitor iOS/Mac Catalyst detection.
 */
export function isPcAppDesktop(env: NativePlatformEnvironment = readNativePlatformEnvironment()): boolean {
  return getPcAppBridge(env) !== null;
}

/**
 * Returns true when running inside an Electron PC App shell whose native OS speech
 * bridge is active (macOS Swift SFSpeechRecognizer). Windows `pc-app` returns false so
 * it retains the standard VoiceOverlay fallback instead of routing to inline dictation.
 */
export function isPcAppInlineVoiceSupported(
  env: NativePlatformEnvironment = readNativePlatformEnvironment(),
): boolean {
  return getPcAppBridge(env)?.voice?.isNativeSpeechSupported?.() === true;
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
  if (!hasDesktopPointer) return false;
  return maxTouchPoints <= 1 || !/iPhone|iPod/i.test(userAgent);
}

/**
 * Returns true when running inside a Designed-for-iPad macOS native shell (both older OTA shells
 * lacking `__IMCODES_NATIVE_HOST__` and newer native shells reporting `scaleMode: 'designed-for-ipad'`),
 * excluding Mac Catalyst (`native-1x`) and intermediate shells that already applied native `pageZoom`.
 */
export function isDesignedForIpadMac(env: NativePlatformEnvironment = readNativePlatformEnvironment()): boolean {
  if (!isNativeMacDesktop(env)) return false;
  const host = env.nativeHost;
  if (host?.scaleMode === 'designed-for-ipad' || host?.scaleMode === 'legacy-css') return true;
  if (host?.scaleMode === 'native-1x' || host?.scaleMode === 'native-page-zoom' || host?.scaleMode === 'none') {
    return false;
  }
  if (host?.pageZoomApplied === true) return false;
  // An explicit Catalyst signal (`{ isMacDesktop: true, pageZoomApplied: false, scaleMode: 'native-1x' }`)
  // or legacy boolean signal without designed-for-ipad scaleMode renders at 1:1 desktop scale.
  if (typeof host?.isMacDesktop === 'boolean' && typeof host?.pageZoomApplied === 'boolean') {
    return false;
  }
  return true;
}

/**
 * Legacy chat-only text inflation (`html.native-ios-mac`) is disabled in favor of uniform
 * whole-page CSS zoom via `ui-scale.ts`.
 */
export function shouldUseIosMacTextScale(_env: NativePlatformEnvironment = readNativePlatformEnvironment()): boolean {
  return false;
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
