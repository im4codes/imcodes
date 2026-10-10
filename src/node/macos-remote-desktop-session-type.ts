/**
 * macOS session-type authority for the remote-desktop LaunchAgent.
 *
 * A LoginWindow session is not a smaller Aqua session; it is a different
 * principal. Nobody is logged in, so there is no user whose clipboard, files,
 * keychain, shell or Computer Use surface could legitimately be reached. The
 * only thing that exists to serve is the login screen itself: pixels out, and
 * pointer/keyboard in so an operator can actually log in.
 *
 * The capability profile is therefore derived from the session type alone
 * rather than intersected with a configured set. An intersection would let a
 * future adapter that advertises clipboard "inherit" it at the login window by
 * accident; deriving it means the LoginWindow answer cannot be widened without
 * editing this file and turning its counterfactuals red.
 */

/** The two session types this LaunchAgent is loaded into. */
export const MACOS_REMOTE_DESKTOP_SESSION_TYPE = {
  AQUA: 'Aqua',
  LOGIN_WINDOW: 'LoginWindow',
} as const;

export type MacosRemoteDesktopSessionType =
  (typeof MACOS_REMOTE_DESKTOP_SESSION_TYPE)[keyof typeof MACOS_REMOTE_DESKTOP_SESSION_TYPE];

/**
 * Exact `LimitLoadToSessionType` value for the installed plist.
 *
 * Order is fixed so the generated plist is byte-stable across installs; a
 * plist whose bytes move for no reason defeats the artifact verification that
 * compares installed content against what was signed.
 */
export const MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_SESSION_TYPES: readonly MacosRemoteDesktopSessionType[] =
  Object.freeze([
    MACOS_REMOTE_DESKTOP_SESSION_TYPE.AQUA,
    MACOS_REMOTE_DESKTOP_SESSION_TYPE.LOGIN_WINDOW,
  ]);

export function isMacosRemoteDesktopSessionType(
  value: unknown,
): value is MacosRemoteDesktopSessionType {
  return value === MACOS_REMOTE_DESKTOP_SESSION_TYPE.AQUA
    || value === MACOS_REMOTE_DESKTOP_SESSION_TYPE.LOGIN_WINDOW;
}

/** What a worker in a given session type is permitted to do. */
export interface MacosRemoteDesktopSessionCapabilities {
  capture: boolean;
  pointer: boolean;
  keyboard: boolean;
  clipboard: boolean;
  fileTransfer: boolean;
  keychain: boolean;
  shell: boolean;
  computerUse: boolean;
}

const AQUA_CAPABILITIES: Readonly<MacosRemoteDesktopSessionCapabilities> = Object.freeze({
  capture: true,
  pointer: true,
  keyboard: true,
  clipboard: true,
  fileTransfer: true,
  keychain: true,
  shell: true,
  computerUse: true,
});

/**
 * Login screen: capture and input only.
 *
 * Every `false` below is load-bearing. There is no logged-in user at the login
 * window, so a clipboard read would be reading whatever the *previous* session
 * left behind, and a shell or Computer Use surface would run as a principal the
 * operator never authenticated as.
 */
const LOGIN_WINDOW_CAPABILITIES: Readonly<MacosRemoteDesktopSessionCapabilities> = Object.freeze({
  capture: true,
  pointer: true,
  keyboard: true,
  clipboard: false,
  fileTransfer: false,
  keychain: false,
  shell: false,
  computerUse: false,
});

export function macosRemoteDesktopSessionCapabilities(
  sessionType: MacosRemoteDesktopSessionType,
): Readonly<MacosRemoteDesktopSessionCapabilities> {
  return sessionType === MACOS_REMOTE_DESKTOP_SESSION_TYPE.LOGIN_WINDOW
    ? LOGIN_WINDOW_CAPABILITIES
    : AQUA_CAPABILITIES;
}

/**
 * The identity a worker generation is bound to.
 *
 * `auditSessionId` is the kernel audit session (ASID). It is included because
 * the session type alone does not distinguish two different login windows, and
 * a challenge alone does not survive being replayed into a successor session.
 */
export interface MacosRemoteDesktopSessionAuthority {
  sessionType: MacosRemoteDesktopSessionType;
  auditSessionId: number;
  launchChallenge: string;
  workerGeneration: number;
}

/** Minimum bytes for the launch challenge; matches the LaunchAgent contract. */
export const MACOS_REMOTE_DESKTOP_LAUNCH_CHALLENGE_BYTES = 43;

export function isMacosRemoteDesktopSessionAuthority(
  value: unknown,
): value is MacosRemoteDesktopSessionAuthority {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort().join(',');
  // Exact keys: an extra field here would be one a later consumer could read
  // without this validator ever having checked it.
  if (keys !== 'auditSessionId,launchChallenge,sessionType,workerGeneration') {
    return false;
  }
  return isMacosRemoteDesktopSessionType(candidate.sessionType)
    && Number.isSafeInteger(candidate.auditSessionId)
    && (candidate.auditSessionId as number) > 0
    && typeof candidate.launchChallenge === 'string'
    && candidate.launchChallenge.length >= MACOS_REMOTE_DESKTOP_LAUNCH_CHALLENGE_BYTES
    && Number.isSafeInteger(candidate.workerGeneration)
    && (candidate.workerGeneration as number) > 0;
}

/**
 * Whether authority established for `previous` may still be honoured for
 * `next`.
 *
 * Always false unless every field is identical. In particular a LoginWindow
 * authority must never survive into the Aqua session that logging in creates,
 * and vice versa: that transition is exactly the moment the principal changes,
 * so carrying a lease across it would grant the new principal a route the
 * operator authorized against the old one.
 */
export function macosRemoteDesktopAuthorityMayMigrate(
  previous: MacosRemoteDesktopSessionAuthority,
  next: MacosRemoteDesktopSessionAuthority,
): boolean {
  return previous.sessionType === next.sessionType
    && previous.auditSessionId === next.auditSessionId
    && previous.launchChallenge === next.launchChallenge
    && previous.workerGeneration === next.workerGeneration;
}

/**
 * Capture backend for a given macOS release.
 *
 * ScreenCaptureKit only became usable at the login window in 14.4; before that
 * the only backend that can see the login screen is CGDisplayStream. Selecting
 * on the running OS rather than at build time matters because one signed
 * artifact ships to both.
 */
export const MACOS_REMOTE_DESKTOP_CAPTURE_BACKEND = {
  SCREEN_CAPTURE_KIT: 'screencapturekit',
  CG_DISPLAY_STREAM: 'cgdisplaystream',
} as const;

export type MacosRemoteDesktopCaptureBackend =
  (typeof MACOS_REMOTE_DESKTOP_CAPTURE_BACKEND)[keyof typeof MACOS_REMOTE_DESKTOP_CAPTURE_BACKEND];

/** First macOS release whose ScreenCaptureKit serves the login window. */
export const MACOS_LOGIN_WINDOW_SCREEN_CAPTURE_KIT_MINIMUM = Object.freeze({
  major: 14,
  minor: 4,
});

export function macosRemoteDesktopCaptureBackend(
  sessionType: MacosRemoteDesktopSessionType,
  productVersion: string,
): MacosRemoteDesktopCaptureBackend | null {
  const match = /^(\d+)\.(\d+)(?:\.\d+)*$/u.exec(productVersion.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return null;
  // The Aqua session has had a working ScreenCaptureKit path since 12.3, which
  // is already the artifact's minimum, so only the login window needs the
  // older backend.
  if (sessionType === MACOS_REMOTE_DESKTOP_SESSION_TYPE.AQUA) {
    return MACOS_REMOTE_DESKTOP_CAPTURE_BACKEND.SCREEN_CAPTURE_KIT;
  }
  const atLeast = major > MACOS_LOGIN_WINDOW_SCREEN_CAPTURE_KIT_MINIMUM.major
    || (major === MACOS_LOGIN_WINDOW_SCREEN_CAPTURE_KIT_MINIMUM.major
      && minor >= MACOS_LOGIN_WINDOW_SCREEN_CAPTURE_KIT_MINIMUM.minor);
  return atLeast
    ? MACOS_REMOTE_DESKTOP_CAPTURE_BACKEND.SCREEN_CAPTURE_KIT
    : MACOS_REMOTE_DESKTOP_CAPTURE_BACKEND.CG_DISPLAY_STREAM;
}
