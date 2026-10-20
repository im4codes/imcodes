/**
 * macOS automatic-unlock policy.
 *
 * This is deliberately NOT the Windows auto-unlock path. There the secret
 * travels Server → controlled node inside
 * `ControlledNodeAutoUnlockCommand.secret`. On macOS it must never leave the
 * machine it was typed on: the operator stores it locally into the file-based
 * System keychain, an ACL pins that item to the signed agent's exact designated
 * requirement, and the LoginWindow agent reads it in-process.
 *
 * Nothing in this module can carry the secret. There is no `secret` field, no
 * `password`, no buffer — only a *reference* to where the agent should look and
 * a decision about whether it is allowed to look at all. That makes "the
 * credential is never sent through the daemon, the Server, the browser, custom
 * IPC, argv, environment, telemetry or logs" a property of the type rather than
 * a promise in a comment: there is no field to put it in and no getter to leak.
 *
 * Default is disabled. Turning it on is an explicit local action.
 */

import {
  MACOS_REMOTE_DESKTOP_SESSION_TYPE,
  isMacosRemoteDesktopSessionType,
  type MacosRemoteDesktopSessionType,
} from './macos-remote-desktop-session-type.js';

export const MACOS_AUTO_UNLOCK_POLICY = {
  /** No automatic unlock. The default, and the value used for anything unclear. */
  DISABLED: 'disabled',
  /** Only at the login window: post-boot, nobody logged in. */
  LOGIN_WINDOW_ONLY: 'loginwindow_only',
  /** Login window and a locked Aqua session. */
  ALWAYS: 'always',
} as const;

export type MacosAutoUnlockPolicy =
  (typeof MACOS_AUTO_UNLOCK_POLICY)[keyof typeof MACOS_AUTO_UNLOCK_POLICY];

export const MACOS_AUTO_UNLOCK_DEFAULT_POLICY: MacosAutoUnlockPolicy =
  MACOS_AUTO_UNLOCK_POLICY.DISABLED;

export function isMacosAutoUnlockPolicy(value: unknown): value is MacosAutoUnlockPolicy {
  return value === MACOS_AUTO_UNLOCK_POLICY.DISABLED
    || value === MACOS_AUTO_UNLOCK_POLICY.LOGIN_WINDOW_ONLY
    || value === MACOS_AUTO_UNLOCK_POLICY.ALWAYS;
}

/** Anything unrecognized resolves to disabled rather than to a guess. */
export function normalizeMacosAutoUnlockPolicy(value: unknown): MacosAutoUnlockPolicy {
  return isMacosAutoUnlockPolicy(value) ? value : MACOS_AUTO_UNLOCK_DEFAULT_POLICY;
}

/**
 * Security domains this feature explicitly does NOT cover.
 *
 * FileVault preboot runs before macOS is up: it is EFI-era code with its own
 * credential store, and neither the System keychain nor a LaunchAgent exists
 * yet. Claiming it would be claiming a capability that cannot be implemented,
 * so it is named here and refused rather than quietly attempted.
 */
export const MACOS_AUTO_UNLOCK_EXCLUDED_DOMAIN = {
  FILEVAULT_PREBOOT: 'filevault_preboot',
} as const;

/** The unlock surfaces this feature can actually serve. */
export const MACOS_AUTO_UNLOCK_SURFACE = {
  /** Post-boot login window; nobody is logged in. */
  LOGIN_WINDOW: 'login_window',
  /** A logged-in Aqua session that is locked. */
  LOCKED_SESSION: 'locked_session',
  /** Pre-boot FileVault. Never served; present so it can be refused by name. */
  FILEVAULT_PREBOOT: 'filevault_preboot',
} as const;

export type MacosAutoUnlockSurface =
  (typeof MACOS_AUTO_UNLOCK_SURFACE)[keyof typeof MACOS_AUTO_UNLOCK_SURFACE];

export const MACOS_AUTO_UNLOCK_LIMITS = {
  /** One-shot attempts before the lockout. Deliberately small. */
  MAX_ATTEMPTS: 3,
  /** How long a lockout lasts once the attempts are spent. */
  LOCKOUT_MS: 15 * 60 * 1000,
} as const;

export const MACOS_AUTO_UNLOCK_REFUSAL = {
  POLICY_DISABLED: 'policy_disabled',
  SURFACE_NOT_PERMITTED: 'surface_not_permitted',
  FILEVAULT_PREBOOT_UNSUPPORTED: 'filevault_preboot_unsupported',
  SIGNER_MISMATCH: 'signer_mismatch',
  USER_MISMATCH: 'user_mismatch',
  SESSION_MISMATCH: 'session_mismatch',
  GENERATION_MISMATCH: 'generation_mismatch',
  CREDENTIAL_UNAVAILABLE: 'credential_unavailable',
  ATTEMPTS_EXHAUSTED: 'attempts_exhausted',
  LOCKED_OUT: 'locked_out',
} as const;

export type MacosAutoUnlockRefusal =
  (typeof MACOS_AUTO_UNLOCK_REFUSAL)[keyof typeof MACOS_AUTO_UNLOCK_REFUSAL];

/**
 * Where the agent reads the credential, and who is allowed to.
 *
 * `designatedRequirement` is the ACL the keychain item is created with. It is
 * the exact stable requirement of the signed agent, not a bundle id: a bundle
 * id can be claimed by any unsigned binary that sets Info.plist, while the
 * designated requirement pins the signing identity.
 */
export interface MacosAutoUnlockCredentialReference {
  /** File-based System keychain path. Never the login keychain. */
  keychainPath: string;
  service: string;
  account: string;
  designatedRequirement: string;
}

/** The exact principal an unlock attempt is bound to. */
export interface MacosAutoUnlockBinding {
  localUserName: string;
  localUserUid: number;
  sessionType: MacosRemoteDesktopSessionType;
  auditSessionId: number;
  workerGeneration: number;
}

export interface MacosAutoUnlockAttemptState {
  attempts: number;
  /** Epoch ms when a lockout ends; 0 when not locked out. */
  lockedOutUntilMs: number;
}

export const MACOS_AUTO_UNLOCK_INITIAL_STATE: Readonly<MacosAutoUnlockAttemptState> =
  Object.freeze({ attempts: 0, lockedOutUntilMs: 0 });

export interface MacosAutoUnlockRequest {
  policy: MacosAutoUnlockPolicy;
  surface: MacosAutoUnlockSurface;
  /** Binding the credential was enrolled against. */
  enrolled: MacosAutoUnlockBinding;
  /** Binding observed right now. */
  observed: MacosAutoUnlockBinding;
  /** Designated requirement the agent actually presented. */
  presentedDesignatedRequirement: string;
  credential: MacosAutoUnlockCredentialReference;
  /** Whether the keychain item was found AND the ACL admitted this reader. */
  credentialReadable: boolean;
  state: MacosAutoUnlockAttemptState;
  nowMs: number;
}

export type MacosAutoUnlockDecision =
  | { allowed: true; nextState: MacosAutoUnlockAttemptState }
  | { allowed: false; refusal: MacosAutoUnlockRefusal; nextState: MacosAutoUnlockAttemptState };

function policyPermits(
  policy: MacosAutoUnlockPolicy,
  surface: MacosAutoUnlockSurface,
): boolean {
  if (policy === MACOS_AUTO_UNLOCK_POLICY.LOGIN_WINDOW_ONLY) {
    return surface === MACOS_AUTO_UNLOCK_SURFACE.LOGIN_WINDOW;
  }
  if (policy === MACOS_AUTO_UNLOCK_POLICY.ALWAYS) {
    return surface === MACOS_AUTO_UNLOCK_SURFACE.LOGIN_WINDOW
      || surface === MACOS_AUTO_UNLOCK_SURFACE.LOCKED_SESSION;
  }
  return false;
}

function bindingMatches(
  enrolled: MacosAutoUnlockBinding,
  observed: MacosAutoUnlockBinding,
): MacosAutoUnlockRefusal | null {
  if (enrolled.localUserUid !== observed.localUserUid
    || enrolled.localUserName !== observed.localUserName) {
    return MACOS_AUTO_UNLOCK_REFUSAL.USER_MISMATCH;
  }
  // A different audit session is a different graphical instance, even when the
  // session type matches: authority must not migrate into a successor.
  if (enrolled.sessionType !== observed.sessionType
    || enrolled.auditSessionId !== observed.auditSessionId) {
    return MACOS_AUTO_UNLOCK_REFUSAL.SESSION_MISMATCH;
  }
  if (enrolled.workerGeneration !== observed.workerGeneration) {
    return MACOS_AUTO_UNLOCK_REFUSAL.GENERATION_MISMATCH;
  }
  return null;
}

function refuse(
  refusal: MacosAutoUnlockRefusal,
  state: MacosAutoUnlockAttemptState,
): MacosAutoUnlockDecision {
  return { allowed: false, refusal, nextState: state };
}

/**
 * Decide whether one unlock attempt may proceed.
 *
 * Fail-closed at every branch, and ordered so a refusal never depends on a
 * check that could itself have leaked something: policy and surface are settled
 * before the signer, and the signer before anything touches the credential.
 *
 * The returned state is the caller's new attempt ledger. A refusal that is not
 * the credential's fault does not burn an attempt — otherwise a misconfigured
 * policy would silently consume the operator's retries.
 */
export function decideMacosAutoUnlock(request: MacosAutoUnlockRequest): MacosAutoUnlockDecision {
  const { state } = request;

  if (request.surface === MACOS_AUTO_UNLOCK_SURFACE.FILEVAULT_PREBOOT) {
    // Named and refused rather than attempted. There is no OS running to ask.
    return refuse(MACOS_AUTO_UNLOCK_REFUSAL.FILEVAULT_PREBOOT_UNSUPPORTED, state);
  }
  if (request.policy === MACOS_AUTO_UNLOCK_POLICY.DISABLED) {
    return refuse(MACOS_AUTO_UNLOCK_REFUSAL.POLICY_DISABLED, state);
  }
  if (!policyPermits(request.policy, request.surface)) {
    return refuse(MACOS_AUTO_UNLOCK_REFUSAL.SURFACE_NOT_PERMITTED, state);
  }
  if (!isMacosRemoteDesktopSessionType(request.observed.sessionType)) {
    return refuse(MACOS_AUTO_UNLOCK_REFUSAL.SESSION_MISMATCH, state);
  }
  // The signer is checked before the credential is consulted at all: a wrong
  // signer must not even reach the keychain.
  if (request.presentedDesignatedRequirement !== request.credential.designatedRequirement
    || request.credential.designatedRequirement.length === 0) {
    return refuse(MACOS_AUTO_UNLOCK_REFUSAL.SIGNER_MISMATCH, state);
  }
  const mismatch = bindingMatches(request.enrolled, request.observed);
  if (mismatch !== null) return refuse(mismatch, state);

  if (state.lockedOutUntilMs > request.nowMs) {
    return refuse(MACOS_AUTO_UNLOCK_REFUSAL.LOCKED_OUT, state);
  }
  if (!request.credentialReadable) {
    // Missing item and denied ACL are one answer on purpose: distinguishing
    // them would tell a caller whether the item exists.
    return refuse(MACOS_AUTO_UNLOCK_REFUSAL.CREDENTIAL_UNAVAILABLE, state);
  }

  // A lockout that has expired starts a fresh ledger rather than resuming a
  // spent one.
  const attempts = state.lockedOutUntilMs > 0 && state.lockedOutUntilMs <= request.nowMs
    ? 0
    : state.attempts;
  if (attempts >= MACOS_AUTO_UNLOCK_LIMITS.MAX_ATTEMPTS) {
    return refuse(MACOS_AUTO_UNLOCK_REFUSAL.ATTEMPTS_EXHAUSTED, {
      attempts,
      lockedOutUntilMs: request.nowMs + MACOS_AUTO_UNLOCK_LIMITS.LOCKOUT_MS,
    });
  }
  return {
    allowed: true,
    nextState: { attempts: attempts + 1, lockedOutUntilMs: 0 },
  };
}

/** A successful unlock clears the ledger; a spent attempt must not linger. */
export function macosAutoUnlockStateAfterSuccess(): MacosAutoUnlockAttemptState {
  return { attempts: 0, lockedOutUntilMs: 0 };
}

/**
 * Whether the node may advertise the auto-unlock capability.
 *
 * Fail-closed: an unreadable credential or a disabled policy means the
 * capability is not advertised, so the Server never offers an unlock the node
 * cannot perform.
 */
export function macosAutoUnlockCapabilityAvailable(
  policy: MacosAutoUnlockPolicy,
  credentialReadable: boolean,
): boolean {
  return policy !== MACOS_AUTO_UNLOCK_POLICY.DISABLED && credentialReadable;
}

/** Surfaces the capability actually covers. FileVault preboot is never listed. */
export function macosAutoUnlockSupportedSurfaces(
  policy: MacosAutoUnlockPolicy,
): readonly MacosAutoUnlockSurface[] {
  if (policy === MACOS_AUTO_UNLOCK_POLICY.LOGIN_WINDOW_ONLY) {
    return Object.freeze([MACOS_AUTO_UNLOCK_SURFACE.LOGIN_WINDOW]);
  }
  if (policy === MACOS_AUTO_UNLOCK_POLICY.ALWAYS) {
    return Object.freeze([
      MACOS_AUTO_UNLOCK_SURFACE.LOGIN_WINDOW,
      MACOS_AUTO_UNLOCK_SURFACE.LOCKED_SESSION,
    ]);
  }
  return Object.freeze([]);
}

/** Convenience for the enrolment path: the login window is always Aqua's peer. */
export function macosAutoUnlockSurfaceForSessionType(
  sessionType: MacosRemoteDesktopSessionType,
): MacosAutoUnlockSurface {
  return sessionType === MACOS_REMOTE_DESKTOP_SESSION_TYPE.LOGIN_WINDOW
    ? MACOS_AUTO_UNLOCK_SURFACE.LOGIN_WINDOW
    : MACOS_AUTO_UNLOCK_SURFACE.LOCKED_SESSION;
}
