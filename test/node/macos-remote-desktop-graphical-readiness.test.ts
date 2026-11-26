import { beforeEach, describe, expect, it } from 'vitest';

import {
  MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_MESSAGE,
  MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_ERROR,
  MacosRemoteDesktopGraphicalReadinessAdmissionLedger,
} from '../../src/node/macos-remote-desktop-graphical-readiness.js';
import {
  MACOS_REMOTE_DESKTOP_BOOTSTRAP_MESSAGE,
  MACOS_REMOTE_DESKTOP_BOOTSTRAP_VERSION,
  type MacosRemoteDesktopBootstrapGrant,
} from '../../src/node/macos-remote-desktop-global-agent-bootstrap.js';
import type { MacosRemoteDesktopGraphicalSessionAuthority } from '../../src/node/user-session-launcher.js';

const authority: MacosRemoteDesktopGraphicalSessionAuthority = Object.freeze({
  kind: 'loginwindow_bootstrap',
  sessionType: 'LoginWindow',
  uid: 88,
  auditSessionId: 100000,
  pidVersion: 44,
});

function grant(overrides: Partial<MacosRemoteDesktopBootstrapGrant> = {}):
MacosRemoteDesktopBootstrapGrant {
  return Object.freeze({
    type: MACOS_REMOTE_DESKTOP_BOOTSTRAP_MESSAGE.GRANT,
    bootstrapVersion: MACOS_REMOTE_DESKTOP_BOOTSTRAP_VERSION,
    uid: 88,
    auditSessionId: 100000,
    sessionType: 'LoginWindow',
    instanceNonce: 'N'.repeat(43),
    workerGeneration: 7,
    challenge: 'C'.repeat(43),
    socketPath: '/private/var/run/imcodes-node/graphical-sessions/88/100000/remote-desktop-agent.sock',
    ...overrides,
  });
}

function frame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_MESSAGE,
    ipcVersion: 1,
    workerGeneration: 7,
    uid: 88,
    auditSessionId: 100000,
    pidVersion: 44,
    sessionType: 'LoginWindow',
    launchChallenge: 'C'.repeat(43),
    capture: true,
    encoder: true,
    input: true,
    clipboard: false,
    display: true,
    disclosure: true,
    graphicalSession: true,
    cleanupReachable: true,
    ...overrides,
  });
}

let ledger: MacosRemoteDesktopGraphicalReadinessAdmissionLedger;

beforeEach(() => {
  ledger = new MacosRemoteDesktopGraphicalReadinessAdmissionLedger();
});

function admit(
  currentAuthority: MacosRemoteDesktopGraphicalSessionAuthority,
  currentGrant: MacosRemoteDesktopBootstrapGrant,
  encoded: string,
) {
  const result = ledger.admit(currentAuthority, currentGrant, encoded);
  return result.ok ? result.admission : null;
}

describe('macOS authenticated graphical readiness admission', () => {
  it('admits the exact post-composition LoginWindow profile', () => {
    const currentGrant = grant();
    const admitted = admit(
      authority, currentGrant, frame(),
    );
    expect(admitted).toEqual({
      workerGeneration: 7,
      uid: 88,
      auditSessionId: 100000,
      pidVersion: 44,
      sessionType: 'LoginWindow',
      instanceNonce: 'N'.repeat(43),
      launchChallenge: 'C'.repeat(43),
      screenRecording: true,
      encoder: true,
      accessibility: true,
      clipboard: false,
      disclosure: true,
      virtualDisplay: true,
    });
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(ledger.isCurrent(
      admitted!, authority, currentGrant,
    )).toBe(true);
  });

  it.each([
    ['uid', { uid: 501 }],
    ['audit session', { auditSessionId: 100001 }],
    ['pid version', { pidVersion: 45 }],
    ['worker generation', { workerGeneration: 8 }],
    ['challenge', { launchChallenge: 'R'.repeat(43) }],
    ['session type', { sessionType: 'Aqua' }],
    ['pre-composition capture', { capture: false }],
    ['missing encoder', { encoder: false }],
    ['missing input', { input: false }],
    ['forbidden clipboard', { clipboard: true }],
    ['missing disclosure', { disclosure: false }],
    ['lost graphical session', { graphicalSession: false }],
    ['unreachable teardown', { cleanupReachable: false }],
  ])('rejects mismatched or incomplete %s evidence', (_name, override) => {
    expect(admit(
      authority, grant(), frame(override),
    )).toBeNull();
  });

  it('rejects unknown fields and Aqua authority without invoking an Aqua resolver', () => {
    expect(admit(
      authority, grant(), frame({ extra: true }),
    )).toBeNull();
    const aqua: MacosRemoteDesktopGraphicalSessionAuthority = Object.freeze({
      kind: 'aqua_user',
      sessionType: 'Aqua',
      auditSessionId: 100003,
      pidVersion: 45,
      user: Object.freeze({
        name: 'desktop-user', uid: 501, gid: 20,
        home: '/Users/desktop-user', tempDir: '/private/var/folders/test/T/',
      }),
    });
    expect(admit(
      aqua, grant({ uid: 501, auditSessionId: 100003, sessionType: 'Aqua' }), frame(),
    )).toBeNull();
  });

  it('rejects malformed, missing, control-delimited, and oversized frames', () => {
    const valid = JSON.parse(frame()) as Record<string, unknown>;
    delete valid.cleanupReachable;
    for (const encoded of [
      '',
      '{',
      '[]',
      JSON.stringify(valid),
      `${frame()}\n`,
      ' '.repeat(256 * 1024 + 16 * 1024),
    ]) {
      expect(admit(
        authority, grant(), encoded,
      )).toBeNull();
    }
  });

  it('binds the frame to the current grant as well as the authenticated principal', () => {
    expect(admit(
      authority, grant({ uid: 89 }), frame(),
    )).toBeNull();
    expect(admit(
      authority, grant({ auditSessionId: 100001 }), frame(),
    )).toBeNull();
    expect(admit(
      authority, grant({ workerGeneration: 8 }), frame(),
    )).toBeNull();
    expect(admit(
      authority, grant({ challenge: 'R'.repeat(43) }), frame(),
    )).toBeNull();
    expect(admit(
      authority, grant({ instanceNonce: 'short' }), frame(),
    )).toBeNull();
  });

  it('invalidates the accepted object on restart, successor, or reconstructed replay', () => {
    const currentGrant = grant();
    const admitted = admit(
      authority, currentGrant, frame(),
    )!;
    expect(ledger.isCurrent(
      admitted, authority, grant(),
    )).toBe(false);
    const successorAuthority: MacosRemoteDesktopGraphicalSessionAuthority = Object.freeze({
      ...authority,
      auditSessionId: 100001,
      pidVersion: 45,
    });
    expect(ledger.isCurrent(
      admitted, successorAuthority, grant(),
    )).toBe(false);
    expect(ledger.isCurrent(
      { ...admitted }, authority, currentGrant,
    )).toBe(false);
    expect(ledger.revoke(admitted)).toBe(true);
    expect(ledger.isCurrent(
      admitted, authority, currentGrant,
    )).toBe(false);
    expect(ledger.revoke(admitted)).toBe(false);
  });

  it('consumes an accepted attestation once and keeps replay consumed after revoke', () => {
    const currentGrant = grant();
    const first = ledger.admit(authority, currentGrant, frame());
    expect(first.ok).toBe(true);
    const replay = ledger.admit(authority, currentGrant, frame());
    expect(replay).toEqual({
      ok: false,
      reason: MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_ERROR.REPLAY,
    });
    if (!first.ok) throw new Error('expected admission');
    expect(ledger.revoke(first.admission)).toBe(true);
    expect(ledger.admit(authority, currentGrant, frame())).toEqual({
      ok: false,
      reason: MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_ERROR.REPLAY,
    });
  });

  it('bounds tombstones while the generation fence still rejects an evicted replay', () => {
    ledger = new MacosRemoteDesktopGraphicalReadinessAdmissionLedger(2);
    const firstGrant = grant();
    expect(ledger.admit(authority, firstGrant, frame()).ok).toBe(true);
    for (const workerGeneration of [8, 9]) {
      const challenge = String(workerGeneration).repeat(43).slice(0, 43);
      expect(ledger.admit(
        authority,
        grant({
          workerGeneration,
          challenge,
          instanceNonce: String(workerGeneration + 1).repeat(43).slice(0, 43),
        }),
        frame({ workerGeneration, launchChallenge: challenge }),
      ).ok).toBe(true);
    }
    expect(ledger.trackedConsumedCount()).toBe(2);
    expect(ledger.admit(authority, firstGrant, frame())).toEqual({
      ok: false,
      reason: MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_ERROR.STALE_GENERATION,
    });
  });
});
