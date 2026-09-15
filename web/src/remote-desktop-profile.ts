import {
  REMOTE_DESKTOP_ENCODER_CAPABILITY,
  REMOTE_DESKTOP_CAPTURE_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY,
  REMOTE_DESKTOP_SESSION_CAPABILITY,
  REMOTE_DESKTOP_UNSUPPORTED_PROFILE_CAPABILITY,
  isRemoteDesktopSessionProfileCapability,
  resolveRemoteDesktopSessionProfile,
  type RemoteDesktopPlatform,
  type RemoteDesktopSessionProfile,
} from '@shared/remote-desktop-platform.js';
import { MACHINE_ACCESS_ROLES } from '@shared/remote-exec.js';
import { REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY } from '@shared/remote-desktop-access.js';
import { isControlledNodeCapability } from '@shared/controlled-node-capabilities.js';

/**
 * Web behavior derived from one complete advertised session profile. Operating
 * system metadata is deliberately absent: it is descriptive, not authority.
 */
export interface RemoteDesktopWebProfile {
  profile: RemoteDesktopSessionProfile;
  input: boolean;
  explicitClipboard: boolean;
  lockScreen: boolean;
  capturePrivacy: boolean;
  displayControl: boolean;
}

export const REMOTE_DESKTOP_WEB_READINESS = {
  READY: 'ready',
  VIEW_ONLY: 'view_only',
  SCREEN_RECORDING_REQUIRED: 'screen_recording_required',
  UNSUPPORTED_PROFILE: 'unsupported_profile',
  UNAVAILABLE: 'unavailable',
} as const;

export type RemoteDesktopWebReadinessKind = typeof REMOTE_DESKTOP_WEB_READINESS[
  keyof typeof REMOTE_DESKTOP_WEB_READINESS
];

export interface RemoteDesktopMachineCandidate {
  online: boolean;
  execEnabled: boolean;
  accessRole?: typeof MACHINE_ACCESS_ROLES[number];
  capabilities?: readonly unknown[];
}

/**
 * Capability-authoritative launch eligibility for node list/menu surfaces.
 * Descriptive OS metadata is deliberately absent from the input contract.
 */
export function canOpenRemoteDesktopMachine(
  machine: RemoteDesktopMachineCandidate,
): boolean {
  const role = machine.accessRole ?? MACHINE_ACCESS_ROLES[0];
  return machine.online
    && machine.execEnabled
    && (role === MACHINE_ACCESS_ROLES[0] || role === MACHINE_ACCESS_ROLES[2])
    && resolveRemoteDesktopWebProfile(machine.capabilities) !== null;
}

/**
 * Presentation-only readiness derived from advertised capabilities. It may
 * explain why a macOS adapter is unavailable, but only a resolved profile can
 * authorize opening a session or exposing controls.
 */
export interface RemoteDesktopWebReadiness {
  kind: RemoteDesktopWebReadinessKind;
  platform: RemoteDesktopPlatform | null;
  profile: RemoteDesktopWebProfile | null;
  screenRecordingReady: boolean | null;
  accessibilityReady: boolean | null;
  viewOnly: boolean;
  unsupportedActions: {
    lockScreen: boolean;
    capturePrivacy: boolean;
    displayControl: boolean;
  };
}

const CAPTURE_CAPABILITIES = new Set<string>(Object.values(REMOTE_DESKTOP_CAPTURE_CAPABILITY));
const PLATFORM_CAPABILITIES = new Set<string>(Object.values(REMOTE_DESKTOP_PLATFORM_CAPABILITY));
const MACOS_MISSING_CAPTURE_PROFILE = new Set<string>([
  REMOTE_DESKTOP_SESSION_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
  REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
]);

function unresolvedReadiness(
  kind: RemoteDesktopWebReadinessKind,
  platform: RemoteDesktopPlatform | null,
): RemoteDesktopWebReadiness {
  const knownMacosBaseline = platform === 'macos'
    && kind === REMOTE_DESKTOP_WEB_READINESS.SCREEN_RECORDING_REQUIRED;
  return {
    kind,
    platform,
    profile: null,
    screenRecordingReady: knownMacosBaseline ? false : null,
    accessibilityReady: null,
    viewOnly: false,
    unsupportedActions: {
      lockScreen: knownMacosBaseline,
      capturePrivacy: knownMacosBaseline,
      displayControl: knownMacosBaseline,
    },
  };
}

export function resolveRemoteDesktopWebProfile(
  capabilities: readonly unknown[] | undefined,
): RemoteDesktopWebProfile | null {
  const profile = resolveRemoteDesktopSessionProfile(capabilities);
  if (!profile) return null;

  if (profile.kind === 'legacy_windows_v2') {
    // The additive adapter tokens did not exist for Windows v2. Preserve its
    // established browser contract instead of interpreting their absence as a
    // downgrade. A dual-profile Windows worker takes the strict v3 branch.
    return {
      profile,
      input: true,
      explicitClipboard: true,
      lockScreen: true,
      capturePrivacy: profile.capturePrivacy,
      displayControl: true,
    };
  }

  return {
    profile,
    input: profile.input,
    explicitClipboard: profile.explicitClipboard,
    lockScreen: profile.lockScreen,
    capturePrivacy: profile.capturePrivacy,
    displayControl: profile.displayControl,
  };
}

/**
 * Resolve Web readiness without consulting `machine.os`. A narrowly
 * recognizable macOS baseline that is missing only its capture adapter is
 * reported as Screen Recording unavailable, while every contradictory or
 * unknown profile remains a generic fail-closed profile error.
 */
export function resolveRemoteDesktopWebReadiness(
  capabilities: readonly unknown[] | undefined,
): RemoteDesktopWebReadiness {
  const profile = resolveRemoteDesktopWebProfile(capabilities);
  if (profile) {
    const macos = profile.profile.platform === 'macos';
    const viewOnly = macos && !profile.input;
    return {
      kind: viewOnly
        ? REMOTE_DESKTOP_WEB_READINESS.VIEW_ONLY
        : REMOTE_DESKTOP_WEB_READINESS.READY,
      platform: profile.profile.platform,
      profile,
      screenRecordingReady: macos ? true : null,
      accessibilityReady: macos ? profile.input : null,
      viewOnly,
      unsupportedActions: {
        lockScreen: macos && !profile.lockScreen,
        capturePrivacy: macos && !profile.capturePrivacy,
        displayControl: macos && !profile.displayControl,
      },
    };
  }

  if (!Array.isArray(capabilities)
    || capabilities.some((capability) => typeof capability !== 'string')) {
    return unresolvedReadiness(REMOTE_DESKTOP_WEB_READINESS.UNAVAILABLE, null);
  }
  const strings = capabilities as readonly string[];
  const platforms = strings.filter((capability) => PLATFORM_CAPABILITIES.has(capability));
  const macosIntent = strings.includes(REMOTE_DESKTOP_SESSION_CAPABILITY)
    && platforms.length === 1
    && platforms[0] === REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS;
  if (!macosIntent) {
    return unresolvedReadiness(REMOTE_DESKTOP_WEB_READINESS.UNAVAILABLE, null);
  }

  const hasUnknownProfile = strings.includes(REMOTE_DESKTOP_UNSUPPORTED_PROFILE_CAPABILITY)
    || strings.some((capability) => capability.startsWith('remote.desktop.')
      && !isRemoteDesktopSessionProfileCapability(capability)
      && !isControlledNodeCapability(capability));
  const hasUnexpectedProfileCapability = strings.some((capability) => (
    isRemoteDesktopSessionProfileCapability(capability)
      && !MACOS_MISSING_CAPTURE_PROFILE.has(capability)
  ));
  const missingOnlyCapture = !hasUnknownProfile
    && !hasUnexpectedProfileCapability
    && strings.includes(REMOTE_DESKTOP_ENCODER_CAPABILITY.H264)
    && strings.includes(REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY)
    && !strings.some((capability) => CAPTURE_CAPABILITIES.has(capability));
  return unresolvedReadiness(
    missingOnlyCapture
      ? REMOTE_DESKTOP_WEB_READINESS.SCREEN_RECORDING_REQUIRED
      : REMOTE_DESKTOP_WEB_READINESS.UNSUPPORTED_PROFILE,
    'macos',
  );
}
