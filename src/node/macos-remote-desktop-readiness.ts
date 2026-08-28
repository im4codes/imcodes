import {
  REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
  REMOTE_DESKTOP_INPUT_CAPABILITY,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
  type RemoteDesktopAdapterCapability,
} from '../../shared/remote-desktop-access.js';
import {
  REMOTE_DESKTOP_CAPTURE_CAPABILITY,
  REMOTE_DESKTOP_ENCODER_CAPABILITY,
  REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY,
  REMOTE_DESKTOP_SESSION_CAPABILITY,
  resolveRemoteDesktopSessionProfile,
} from '../../shared/remote-desktop-platform.js';

export const MACOS_REMOTE_DESKTOP_READINESS_MODE = Object.freeze({
  UNAVAILABLE: 'unavailable',
  VIEW: 'view',
  CONTROL: 'control',
} as const);

export type MacosRemoteDesktopReadinessMode = typeof MACOS_REMOTE_DESKTOP_READINESS_MODE[
  keyof typeof MACOS_REMOTE_DESKTOP_READINESS_MODE
];

export interface MacosRemoteDesktopReadinessInput {
  artifactVerified: boolean;
  activeUserQualified: boolean;
  screenRecording: boolean;
  encoder: boolean;
  accessibility: boolean;
  clipboard: boolean;
  disclosure: boolean;
  /** Local evidence only; it does not authorize the unqualified display-control profile. */
  virtualDisplay?: boolean;
  /** Local evidence only; it does not authorize the unqualified lock-screen profile. */
  loginWindow?: boolean;
}

export interface MacosRemoteDesktopRuntimeProfile {
  mode: MacosRemoteDesktopReadinessMode;
  sessionCapabilities: readonly string[];
  adapterCapabilities: readonly RemoteDesktopAdapterCapability[];
}

const EMPTY_PROFILE: MacosRemoteDesktopRuntimeProfile = Object.freeze({
  mode: MACOS_REMOTE_DESKTOP_READINESS_MODE.UNAVAILABLE,
  sessionCapabilities: Object.freeze([]),
  adapterCapabilities: Object.freeze([]),
});

/**
 * Convert currently effective local readiness into one exact advertisement.
 * This function never requests TCC access and never infers support from the OS.
 */
export function resolveMacosRemoteDesktopRuntimeProfile(
  input: MacosRemoteDesktopReadinessInput,
): MacosRemoteDesktopRuntimeProfile {
  if (!input.artifactVerified
    || !input.activeUserQualified
    || !input.screenRecording
    || !input.encoder
    || !input.disclosure) {
    return EMPTY_PROFILE;
  }

  const control = input.accessibility;
  const sessionCapabilities = [
    REMOTE_DESKTOP_SESSION_CAPABILITY,
    REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
    REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT,
    REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
    ...(control && input.clipboard
      ? [REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY]
      : []),
  ] as const;
  const adapterCapabilities: readonly RemoteDesktopAdapterCapability[] = Object.freeze([
    REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
    REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
    ...(control ? [REMOTE_DESKTOP_INPUT_CAPABILITY] : []),
  ]);
  if (resolveRemoteDesktopSessionProfile([
    ...sessionCapabilities,
    ...adapterCapabilities,
  ]) === null) {
    return EMPTY_PROFILE;
  }
  return Object.freeze({
    mode: control
      ? MACOS_REMOTE_DESKTOP_READINESS_MODE.CONTROL
      : MACOS_REMOTE_DESKTOP_READINESS_MODE.VIEW,
    sessionCapabilities: Object.freeze(sessionCapabilities),
    adapterCapabilities,
  });
}
