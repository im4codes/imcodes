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
  /**
   * Everything is in place except the one grant only the person at the machine
   * can give. Distinct from UNAVAILABLE because the two need opposite things
   * from the operator: one is "this machine cannot do remote control", the
   * other is "click allow on that Mac". Collapsing them -- which is what
   * advertising nothing did -- leaves a machine that is one dialog away from
   * working looking permanently unsupported.
   */
  PERMISSION_REQUIRED: 'permission_required',
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
    || !input.encoder
    || !input.disclosure) {
    return EMPTY_PROFILE;
  }

  // Screen recording is the one input a machine cannot grant itself, so its
  // absence is reported rather than hidden. The advertised set deliberately
  // carries NO capture capability: that is what makes it unlaunchable, and it
  // is exactly the shape the web resolver reads as "screen recording
  // required". Without it the node advertised nothing at all and the browser
  // could not tell a Mac awaiting one click from a Mac that will never work.
  if (!input.screenRecording) {
    return Object.freeze({
      mode: MACOS_REMOTE_DESKTOP_READINESS_MODE.PERMISSION_REQUIRED,
      sessionCapabilities: Object.freeze([
        REMOTE_DESKTOP_SESSION_CAPABILITY,
        REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
        REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
      ]),
      adapterCapabilities: Object.freeze([REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY]),
    });
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
