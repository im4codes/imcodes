import { timingSafeEqual } from 'node:crypto';

import type { MacosRemoteDesktopBootstrapGrant } from './macos-remote-desktop-global-agent-bootstrap.js';
import { MACOS_REMOTE_DESKTOP_SESSION_TYPE } from './macos-remote-desktop-session-type.js';
import type { MacosRemoteDesktopGraphicalSessionAuthority } from './user-session-launcher.js';

export const MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_MESSAGE =
  'remote_desktop.macos_ipc.graphical_readiness' as const;
export const MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_VERSION = 1 as const;

const MAX_GRAPHICAL_READINESS_FRAME_BYTES = 256 * 1024 + 16 * 1024;
const DEFAULT_MAX_TRACKED_CONSUMED_ATTESTATIONS = 4_096;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/u;

export const MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_ERROR = Object.freeze({
  INVALID_FRAME: 'macos_remote_desktop_graphical_readiness_invalid_frame',
  INVALID_AUTHORITY: 'macos_remote_desktop_graphical_readiness_invalid_authority',
  INVALID_GRANT: 'macos_remote_desktop_graphical_readiness_invalid_grant',
  BINDING_MISMATCH: 'macos_remote_desktop_graphical_readiness_binding_mismatch',
  INCOMPLETE_PROFILE: 'macos_remote_desktop_graphical_readiness_incomplete_profile',
  REPLAY: 'macos_remote_desktop_graphical_readiness_replay',
  STALE_GENERATION: 'macos_remote_desktop_graphical_readiness_stale_generation',
} as const);

export type MacosRemoteDesktopGraphicalReadinessError =
  typeof MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_ERROR[
    keyof typeof MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_ERROR
  ];

interface EncodedGraphicalReadiness {
  readonly type: typeof MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_MESSAGE;
  readonly ipcVersion: typeof MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_VERSION;
  readonly workerGeneration: number;
  readonly uid: number;
  readonly auditSessionId: number;
  readonly pidVersion: number;
  readonly sessionType: typeof MACOS_REMOTE_DESKTOP_SESSION_TYPE.LOGIN_WINDOW;
  readonly launchChallenge: string;
  readonly capture: boolean;
  readonly encoder: boolean;
  readonly input: boolean;
  readonly clipboard: false;
  readonly display: boolean;
  readonly disclosure: boolean;
  readonly graphicalSession: boolean;
  readonly cleanupReachable: boolean;
}

export interface MacosRemoteDesktopGraphicalReadinessAdmission {
  readonly workerGeneration: number;
  readonly uid: number;
  readonly auditSessionId: number;
  readonly pidVersion: number;
  readonly sessionType: typeof MACOS_REMOTE_DESKTOP_SESSION_TYPE.LOGIN_WINDOW;
  readonly instanceNonce: string;
  readonly launchChallenge: string;
  readonly screenRecording: true;
  readonly encoder: true;
  readonly accessibility: true;
  readonly clipboard: false;
  readonly disclosure: true;
  readonly virtualDisplay: boolean;
}

interface AdmissionBinding {
  readonly authority: MacosRemoteDesktopGraphicalSessionAuthority;
  readonly grant: MacosRemoteDesktopBootstrapGrant;
}

export type MacosRemoteDesktopGraphicalReadinessAdmissionResult =
  | {
    readonly ok: true;
    readonly admission: MacosRemoteDesktopGraphicalReadinessAdmission;
  }
  | {
    readonly ok: false;
    readonly reason: MacosRemoteDesktopGraphicalReadinessError;
  };

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
}

function positiveUint32(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value <= 0xffff_ffff;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function sameSecret(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string'
    || !SECRET_RE.test(left) || !SECRET_RE.test(right)) return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function decode(encoded: string): EncodedGraphicalReadiness | null {
  if (typeof encoded !== 'string'
    || encoded.length === 0
    || Buffer.byteLength(encoded, 'utf8') >= MAX_GRAPHICAL_READINESS_FRAME_BYTES
    || /[\0\r\n]/u.test(encoded)) return null;
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value, [
      'type', 'ipcVersion', 'workerGeneration', 'uid', 'auditSessionId',
      'pidVersion', 'sessionType', 'launchChallenge', 'capture', 'encoder',
      'input', 'clipboard', 'display', 'disclosure', 'graphicalSession',
      'cleanupReachable',
    ])) return null;
  const frame = value as Record<string, unknown>;
  if (frame.type !== MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_MESSAGE
    || frame.ipcVersion !== MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_VERSION
    || !positiveSafeInteger(frame.workerGeneration)
    || !positiveUint32(frame.uid)
    || !positiveUint32(frame.auditSessionId)
    || !positiveUint32(frame.pidVersion)
    || frame.sessionType !== MACOS_REMOTE_DESKTOP_SESSION_TYPE.LOGIN_WINDOW
    || !SECRET_RE.test(String(frame.launchChallenge ?? ''))
    || [
      frame.capture, frame.encoder, frame.input, frame.clipboard, frame.display,
      frame.disclosure, frame.graphicalSession, frame.cleanupReachable,
    ].some((item) => typeof item !== 'boolean')) return null;
  return frame as unknown as EncodedGraphicalReadiness;
}

/**
 * Admit the native post-composition attestation for one current LoginWindow.
 *
 * The authority and grant are inputs produced by the bootstrap and Cx7 IPC
 * authority chains. This module does not parse a hello, inspect a socket, or
 * recreate either authority. An accepted result is opaque: later currentness
 * checks require the same authority and grant object identities, so teardown
 * or a reconstructed/replayed successor cannot revive it from matching bytes.
 */
export class MacosRemoteDesktopGraphicalReadinessAdmissionLedger {
  private readonly bindings = new WeakMap<object, AdmissionBinding>();
  private readonly consumed = new Set<string>();
  private readonly consumedQueue: string[] = [];
  private highestConsumedGeneration = 0;

  constructor(
    private readonly maxTrackedConsumedAttestations =
      DEFAULT_MAX_TRACKED_CONSUMED_ATTESTATIONS,
  ) {
    if (!Number.isSafeInteger(maxTrackedConsumedAttestations)
      || maxTrackedConsumedAttestations <= 0) {
      throw new Error(MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_ERROR.INVALID_FRAME);
    }
  }

  admit(
    authority: MacosRemoteDesktopGraphicalSessionAuthority,
    grant: MacosRemoteDesktopBootstrapGrant,
    encoded: string,
  ): MacosRemoteDesktopGraphicalReadinessAdmissionResult {
    const frame = decode(encoded);
    if (!frame) return this.reject(
      MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_ERROR.INVALID_FRAME,
    );
    if (authority.kind !== 'loginwindow_bootstrap'
      || authority.sessionType !== MACOS_REMOTE_DESKTOP_SESSION_TYPE.LOGIN_WINDOW) {
      return this.reject(
        MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_ERROR.INVALID_AUTHORITY,
      );
    }
    if (grant.sessionType !== MACOS_REMOTE_DESKTOP_SESSION_TYPE.LOGIN_WINDOW
      || !exactKeys(grant, [
        'type', 'bootstrapVersion', 'uid', 'auditSessionId', 'sessionType',
        'instanceNonce', 'workerGeneration', 'challenge', 'socketPath',
      ])
      || !SECRET_RE.test(grant.instanceNonce)) {
      return this.reject(MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_ERROR.INVALID_GRANT);
    }
    if (frame.uid !== authority.uid
      || frame.auditSessionId !== authority.auditSessionId
      || frame.pidVersion !== authority.pidVersion
      || frame.uid !== grant.uid
      || frame.auditSessionId !== grant.auditSessionId
      || frame.workerGeneration !== grant.workerGeneration
      || !sameSecret(frame.launchChallenge, grant.challenge)) {
      return this.reject(
        MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_ERROR.BINDING_MISMATCH,
      );
    }
    // Adapter advertisement is all-or-nothing. A false bit is not a smaller
    // advertised profile; it is an unavailable LoginWindow composition.
    if (!frame.capture
      || !frame.encoder
      || !frame.input
      || frame.clipboard
      || !frame.disclosure
      || !frame.graphicalSession
      || !frame.cleanupReachable) {
      return this.reject(
        MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_ERROR.INCOMPLETE_PROFILE,
      );
    }

    const consumedKey = [
      frame.workerGeneration,
      frame.uid,
      frame.auditSessionId,
      frame.pidVersion,
      grant.instanceNonce,
      frame.launchChallenge,
    ].join('/');
    if (this.consumed.has(consumedKey)) {
      return this.reject(MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_ERROR.REPLAY);
    }
    if (frame.workerGeneration <= this.highestConsumedGeneration) {
      return this.reject(
        MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_ERROR.STALE_GENERATION,
      );
    }

    const admission: MacosRemoteDesktopGraphicalReadinessAdmission = Object.freeze({
      workerGeneration: frame.workerGeneration,
      uid: frame.uid,
      auditSessionId: frame.auditSessionId,
      pidVersion: frame.pidVersion,
      sessionType: MACOS_REMOTE_DESKTOP_SESSION_TYPE.LOGIN_WINDOW,
      instanceNonce: grant.instanceNonce,
      launchChallenge: frame.launchChallenge,
      screenRecording: true,
      encoder: true,
      accessibility: true,
      clipboard: false,
      disclosure: true,
      virtualDisplay: frame.display,
    });
    this.rememberConsumed(consumedKey, frame.workerGeneration);
    this.bindings.set(admission, { authority, grant });
    return Object.freeze({ ok: true, admission });
  }

  isCurrent(
    admission: MacosRemoteDesktopGraphicalReadinessAdmission,
    authority: MacosRemoteDesktopGraphicalSessionAuthority,
    grant: MacosRemoteDesktopBootstrapGrant,
  ): boolean {
    const binding = this.bindings.get(admission);
    return binding?.authority === authority && binding.grant === grant;
  }

  revoke(admission: MacosRemoteDesktopGraphicalReadinessAdmission): boolean {
    return this.bindings.delete(admission);
  }

  trackedConsumedCount(): number {
    return this.consumed.size;
  }

  private reject(
    reason: MacosRemoteDesktopGraphicalReadinessError,
  ): MacosRemoteDesktopGraphicalReadinessAdmissionResult {
    return Object.freeze({ ok: false, reason });
  }

  private rememberConsumed(key: string, generation: number): void {
    this.highestConsumedGeneration = generation;
    this.consumed.add(key);
    this.consumedQueue.push(key);
    if (this.consumedQueue.length <= this.maxTrackedConsumedAttestations) return;
    const oldest = this.consumedQueue.shift();
    if (oldest) this.consumed.delete(oldest);
  }
}

const defaultAdmissionLedger =
  new MacosRemoteDesktopGraphicalReadinessAdmissionLedger();

export function admitMacosRemoteDesktopGraphicalReadinessWithReason(
  authority: MacosRemoteDesktopGraphicalSessionAuthority,
  grant: MacosRemoteDesktopBootstrapGrant,
  encoded: string,
): MacosRemoteDesktopGraphicalReadinessAdmissionResult {
  return defaultAdmissionLedger.admit(authority, grant, encoded);
}

export function admitMacosRemoteDesktopGraphicalReadiness(
  authority: MacosRemoteDesktopGraphicalSessionAuthority,
  grant: MacosRemoteDesktopBootstrapGrant,
  encoded: string,
): MacosRemoteDesktopGraphicalReadinessAdmission | null {
  const result = admitMacosRemoteDesktopGraphicalReadinessWithReason(
    authority, grant, encoded,
  );
  return result.ok ? result.admission : null;
}

/** True only while the exact authority/grant objects that admitted it remain current. */
export function isMacosRemoteDesktopGraphicalReadinessCurrent(
  admission: MacosRemoteDesktopGraphicalReadinessAdmission,
  authority: MacosRemoteDesktopGraphicalSessionAuthority,
  grant: MacosRemoteDesktopBootstrapGrant,
): boolean {
  return defaultAdmissionLedger.isCurrent(admission, authority, grant);
}

/** Synchronously revoke an admission before closing IPC or replacing a session. */
export function revokeMacosRemoteDesktopGraphicalReadiness(
  admission: MacosRemoteDesktopGraphicalReadinessAdmission,
): boolean {
  return defaultAdmissionLedger.revoke(admission);
}
