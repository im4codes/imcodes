import {
  REMOTE_DESKTOP_ADAPTER_CAPABILITIES,
  REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
  REMOTE_DESKTOP_DEFAULT_SHIELDED_ROUTE_CAPABILITY,
  REMOTE_DESKTOP_INPUT_CAPABILITY,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
  REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY,
  REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY,
  type RemoteDesktopAdapterCapability,
} from './remote-desktop-access.js';
import { REMOTE_DESKTOP_CAPABILITY } from './remote-desktop.js';
import { REMOTE_DESKTOP_INSTALLABLE_CAPABILITY } from './remote-desktop-install.js';
import { CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY } from './controlled-node-auto-unlock.js';

/**
 * Additive profile marker. The legacy Windows v2 capability remains valid on
 * its own; this marker is accepted only together with one complete adapter
 * profile so Server/Web never infer native behavior from `os`.
 */
export const REMOTE_DESKTOP_SESSION_CAPABILITY = 'remote.desktop.session.v3' as const;

export const REMOTE_DESKTOP_PLATFORM_CAPABILITY = {
  WINDOWS: 'remote.desktop.platform.windows.v1',
  MACOS: 'remote.desktop.platform.macos.v1',
  LINUX: 'remote.desktop.platform.linux.v1',
} as const;

export type RemoteDesktopPlatform = 'windows' | 'macos' | 'linux';
export type RemoteDesktopPlatformCapability = typeof REMOTE_DESKTOP_PLATFORM_CAPABILITY[
  keyof typeof REMOTE_DESKTOP_PLATFORM_CAPABILITY
];

export const REMOTE_DESKTOP_CAPTURE_CAPABILITY = {
  WINDOWS_DXGI: 'remote.desktop.capture.windows.dxgi.v1',
  MACOS_SCREEN_CAPTURE_KIT: 'remote.desktop.capture.macos.screencapturekit.v1',
  LINUX_PORTAL_PIPEWIRE: 'remote.desktop.capture.linux.portal-pipewire.v1',
  LINUX_X11: 'remote.desktop.capture.linux.x11.v1',
} as const;

export type RemoteDesktopCaptureBackend = 'windows_dxgi'
  | 'macos_screencapturekit'
  | 'linux_portal_pipewire'
  | 'linux_x11';
export type RemoteDesktopCaptureCapability = typeof REMOTE_DESKTOP_CAPTURE_CAPABILITY[
  keyof typeof REMOTE_DESKTOP_CAPTURE_CAPABILITY
];

export const REMOTE_DESKTOP_ENCODER_CAPABILITY = {
  H264: 'remote.desktop.encoder.h264.v1',
} as const;

export const REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY =
  'remote.desktop.clipboard.explicit.v1' as const;
export const REMOTE_DESKTOP_DISPLAY_CONTROL_CAPABILITY =
  'remote.desktop.display.control.v1' as const;
/**
 * Persisted by capability ingress when a well-formed but unknown
 * `remote.desktop.*` token is advertised. It lets unrelated future features
 * remain forward-compatible without filtering an unknown remote-desktop
 * profile into a narrower profile that old code might authorize.
 */
export const REMOTE_DESKTOP_UNSUPPORTED_PROFILE_CAPABILITY =
  'remote.desktop.profile.unsupported.v1' as const;

export const REMOTE_DESKTOP_SESSION_PROFILE_CAPABILITIES = Object.freeze([
  REMOTE_DESKTOP_SESSION_CAPABILITY,
  ...Object.values(REMOTE_DESKTOP_PLATFORM_CAPABILITY),
  ...Object.values(REMOTE_DESKTOP_CAPTURE_CAPABILITY),
  ...Object.values(REMOTE_DESKTOP_ENCODER_CAPABILITY),
  REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY,
  REMOTE_DESKTOP_DISPLAY_CONTROL_CAPABILITY,
  REMOTE_DESKTOP_UNSUPPORTED_PROFILE_CAPABILITY,
]) as readonly string[];

const PROFILE_RELEVANT_CAPABILITIES = new Set<string>([
  REMOTE_DESKTOP_CAPABILITY,
  ...REMOTE_DESKTOP_SESSION_PROFILE_CAPABILITIES,
  ...REMOTE_DESKTOP_ADAPTER_CAPABILITIES,
]);
const KNOWN_REMOTE_DESKTOP_NON_PROFILE_CAPABILITIES = new Set<string>([
  REMOTE_DESKTOP_INSTALLABLE_CAPABILITY,
  REMOTE_DESKTOP_DEFAULT_SHIELDED_ROUTE_CAPABILITY,
  CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY,
]);
const PLATFORM_CAPABILITIES = Object.values(REMOTE_DESKTOP_PLATFORM_CAPABILITY) as string[];
const CAPTURE_CAPABILITIES = Object.values(REMOTE_DESKTOP_CAPTURE_CAPABILITY) as string[];

export interface RemoteDesktopSessionProfile {
  kind: 'legacy_windows_v2' | 'common_v3';
  capability: typeof REMOTE_DESKTOP_CAPABILITY | typeof REMOTE_DESKTOP_SESSION_CAPABILITY;
  platform: RemoteDesktopPlatform;
  capture: RemoteDesktopCaptureBackend;
  encoder: 'h264';
  input: boolean;
  explicitClipboard: boolean;
  localDisclosure: boolean;
  capturePrivacy: boolean;
  lockScreen: boolean;
  displayControl: boolean;
  /** Canonical known profile capabilities used for authority hashing. */
  capabilities: readonly string[];
}

function oneOf(set: ReadonlySet<string>, candidates: readonly string[]): string | null {
  const selected = candidates.filter((candidate) => set.has(candidate));
  return selected.length === 1 ? selected[0]! : null;
}

function platformForCapability(capability: string): RemoteDesktopPlatform | null {
  if (capability === REMOTE_DESKTOP_PLATFORM_CAPABILITY.WINDOWS) return 'windows';
  if (capability === REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS) return 'macos';
  if (capability === REMOTE_DESKTOP_PLATFORM_CAPABILITY.LINUX) return 'linux';
  return null;
}

function captureForCapability(capability: string): RemoteDesktopCaptureBackend | null {
  if (capability === REMOTE_DESKTOP_CAPTURE_CAPABILITY.WINDOWS_DXGI) return 'windows_dxgi';
  if (capability === REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT) {
    return 'macos_screencapturekit';
  }
  if (capability === REMOTE_DESKTOP_CAPTURE_CAPABILITY.LINUX_PORTAL_PIPEWIRE) {
    return 'linux_portal_pipewire';
  }
  if (capability === REMOTE_DESKTOP_CAPTURE_CAPABILITY.LINUX_X11) return 'linux_x11';
  return null;
}

function platformCaptureCompatible(
  platform: RemoteDesktopPlatform,
  capture: RemoteDesktopCaptureBackend,
): boolean {
  if (platform === 'windows') return capture === 'windows_dxgi';
  if (platform === 'macos') return capture === 'macos_screencapturekit';
  return capture === 'linux_portal_pipewire' || capture === 'linux_x11';
}

/**
 * Resolve one exact native adapter profile. Unrelated controlled-node
 * capabilities are ignored, but an unknown `remote.desktop.*` profile token
 * fails closed so future versions cannot accidentally inherit v3 authority.
 */
export function resolveRemoteDesktopSessionProfile(
  capabilities: readonly unknown[] | undefined,
): RemoteDesktopSessionProfile | null {
  if (!Array.isArray(capabilities)) return null;
  const strings = capabilities.filter((value): value is string => typeof value === 'string');
  if (strings.length !== capabilities.length) return null;
  if (strings.some((value) => value.startsWith('remote.desktop.')
    && !PROFILE_RELEVANT_CAPABILITIES.has(value)
    && !KNOWN_REMOTE_DESKTOP_NON_PROFILE_CAPABILITIES.has(value))) return null;

  const known = new Set(strings.filter((value) => PROFILE_RELEVANT_CAPABILITIES.has(value)));
  const hasCommon = known.has(REMOTE_DESKTOP_SESSION_CAPABILITY);
  const hasLegacy = known.has(REMOTE_DESKTOP_CAPABILITY);
  if (known.has(REMOTE_DESKTOP_UNSUPPORTED_PROFILE_CAPABILITY)) return null;

  if (!hasCommon) {
    if (!hasLegacy) return null;
    return {
      kind: 'legacy_windows_v2',
      capability: REMOTE_DESKTOP_CAPABILITY,
      platform: 'windows',
      capture: 'windows_dxgi',
      encoder: 'h264',
      input: known.has(REMOTE_DESKTOP_INPUT_CAPABILITY),
      explicitClipboard: false,
      localDisclosure: known.has(REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY),
      capturePrivacy: known.has(REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY),
      lockScreen: known.has(REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY),
      displayControl: false,
      capabilities: Object.freeze([...known].sort()),
    };
  }

  const platformCapability = oneOf(known, PLATFORM_CAPABILITIES);
  const captureCapability = oneOf(known, CAPTURE_CAPABILITIES);
  if (!platformCapability || !captureCapability
    || !known.has(REMOTE_DESKTOP_ENCODER_CAPABILITY.H264)
    || !known.has(REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY)) return null;

  const platform = platformForCapability(platformCapability);
  const capture = captureForCapability(captureCapability);
  if (!platform || !capture || !platformCaptureCompatible(platform, capture)) return null;
  if (hasLegacy && platform !== 'windows') return null;

  const input = known.has(REMOTE_DESKTOP_INPUT_CAPABILITY);
  const explicitClipboard = known.has(REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY);
  if (explicitClipboard && !input) return null;

  const capturePrivacy = known.has(REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY);
  const lockScreen = known.has(REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY);
  const displayControl = known.has(REMOTE_DESKTOP_DISPLAY_CONTROL_CAPABILITY);
  // The first macOS adapter deliberately supports only an unlocked active
  // user session. Refuse capability combinations that would widen it by typo.
  if (platform === 'macos' && (capturePrivacy || lockScreen || displayControl
    || known.has(REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY))) return null;

  return {
    kind: 'common_v3',
    capability: REMOTE_DESKTOP_SESSION_CAPABILITY,
    platform,
    capture,
    encoder: 'h264',
    input,
    explicitClipboard,
    localDisclosure: true,
    capturePrivacy,
    lockScreen,
    displayControl,
    capabilities: Object.freeze([...known].sort()),
  };
}

/** Stable, domain-separated material; Server hashes this string for routes. */
export function remoteDesktopSessionProfileIdentity(profile: RemoteDesktopSessionProfile): string {
  return `imcodes.remote-desktop.profile.v1\0${profile.capabilities.join('\0')}`;
}

export function isRemoteDesktopSessionProfileCapability(
  value: unknown,
): value is string | RemoteDesktopAdapterCapability {
  return typeof value === 'string' && PROFILE_RELEVANT_CAPABILITIES.has(value);
}
