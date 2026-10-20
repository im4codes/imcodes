import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MACOS_AUTO_UNLOCK_DEFAULT_POLICY,
  MACOS_AUTO_UNLOCK_INITIAL_STATE,
  MACOS_AUTO_UNLOCK_LIMITS,
  MACOS_AUTO_UNLOCK_POLICY,
  MACOS_AUTO_UNLOCK_REFUSAL,
  MACOS_AUTO_UNLOCK_SURFACE,
  decideMacosAutoUnlock,
  macosAutoUnlockCapabilityAvailable,
  macosAutoUnlockStateAfterSuccess,
  macosAutoUnlockSupportedSurfaces,
  normalizeMacosAutoUnlockPolicy,
  type MacosAutoUnlockBinding,
  type MacosAutoUnlockRequest,
} from '../../src/node/macos-remote-desktop-auto-unlock.js';
import { MACOS_REMOTE_DESKTOP_SESSION_TYPE } from '../../src/node/macos-remote-desktop-session-type.js';

const REQUIREMENT = 'identifier "to.aiDesk.remote-desktop.launch-agent" and anchor apple generic';

function binding(overrides: Partial<MacosAutoUnlockBinding> = {}): MacosAutoUnlockBinding {
  return {
    localUserName: 'operator',
    localUserUid: 501,
    sessionType: MACOS_REMOTE_DESKTOP_SESSION_TYPE.LOGIN_WINDOW,
    auditSessionId: 100_001,
    workerGeneration: 4,
    ...overrides,
  };
}

function request(overrides: Partial<MacosAutoUnlockRequest> = {}): MacosAutoUnlockRequest {
  return {
    policy: MACOS_AUTO_UNLOCK_POLICY.LOGIN_WINDOW_ONLY,
    surface: MACOS_AUTO_UNLOCK_SURFACE.LOGIN_WINDOW,
    enrolled: binding(),
    observed: binding(),
    presentedDesignatedRequirement: REQUIREMENT,
    credential: {
      keychainPath: '/Library/Keychains/System.keychain',
      service: 'to.aiDesk.remote-desktop.auto-unlock',
      account: 'operator',
      designatedRequirement: REQUIREMENT,
    },
    credentialReadable: true,
    state: { ...MACOS_AUTO_UNLOCK_INITIAL_STATE },
    nowMs: 1_000_000,
    ...overrides,
  };
}

describe('macOS remote-desktop automatic unlock', () => {
  it('is disabled unless explicitly opted in', () => {
    expect(MACOS_AUTO_UNLOCK_DEFAULT_POLICY).toBe(MACOS_AUTO_UNLOCK_POLICY.DISABLED);
    // Anything unrecognized resolves to disabled rather than to a guess.
    for (const value of [undefined, null, '', 'enabled', 'always ', 1, {}]) {
      expect(normalizeMacosAutoUnlockPolicy(value)).toBe(MACOS_AUTO_UNLOCK_POLICY.DISABLED);
    }
    const decision = decideMacosAutoUnlock(
      request({ policy: MACOS_AUTO_UNLOCK_POLICY.DISABLED }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.refusal)
      .toBe(MACOS_AUTO_UNLOCK_REFUSAL.POLICY_DISABLED);
    // A refusal that is not the credential's fault must not burn a retry.
    expect(decision.nextState).toEqual(MACOS_AUTO_UNLOCK_INITIAL_STATE);
  });

  it('honours the surface each policy mode actually covers', () => {
    expect(macosAutoUnlockSupportedSurfaces(MACOS_AUTO_UNLOCK_POLICY.DISABLED)).toEqual([]);
    expect(macosAutoUnlockSupportedSurfaces(MACOS_AUTO_UNLOCK_POLICY.LOGIN_WINDOW_ONLY))
      .toEqual([MACOS_AUTO_UNLOCK_SURFACE.LOGIN_WINDOW]);
    expect(macosAutoUnlockSupportedSurfaces(MACOS_AUTO_UNLOCK_POLICY.ALWAYS))
      .toEqual([MACOS_AUTO_UNLOCK_SURFACE.LOGIN_WINDOW, MACOS_AUTO_UNLOCK_SURFACE.LOCKED_SESSION]);
    // loginwindow_only must refuse a locked Aqua session.
    const locked = decideMacosAutoUnlock(request({
      surface: MACOS_AUTO_UNLOCK_SURFACE.LOCKED_SESSION,
      enrolled: binding({ sessionType: MACOS_REMOTE_DESKTOP_SESSION_TYPE.AQUA }),
      observed: binding({ sessionType: MACOS_REMOTE_DESKTOP_SESSION_TYPE.AQUA }),
    }));
    expect(locked.allowed === false && locked.refusal)
      .toBe(MACOS_AUTO_UNLOCK_REFUSAL.SURFACE_NOT_PERMITTED);
    expect(decideMacosAutoUnlock(request({
      policy: MACOS_AUTO_UNLOCK_POLICY.ALWAYS,
      surface: MACOS_AUTO_UNLOCK_SURFACE.LOCKED_SESSION,
      enrolled: binding({ sessionType: MACOS_REMOTE_DESKTOP_SESSION_TYPE.AQUA }),
      observed: binding({ sessionType: MACOS_REMOTE_DESKTOP_SESSION_TYPE.AQUA }),
    })).allowed).toBe(true);
  });

  it('refuses FileVault preboot by name under every policy', () => {
    // Pre-boot is EFI-era: no System keychain and no LaunchAgent exist yet, so
    // claiming it would be claiming something unimplementable.
    for (const policy of Object.values(MACOS_AUTO_UNLOCK_POLICY)) {
      const decision = decideMacosAutoUnlock(request({
        policy,
        surface: MACOS_AUTO_UNLOCK_SURFACE.FILEVAULT_PREBOOT,
      }));
      expect(decision.allowed, policy).toBe(false);
      expect(decision.allowed === false && decision.refusal, policy)
        .toBe(MACOS_AUTO_UNLOCK_REFUSAL.FILEVAULT_PREBOOT_UNSUPPORTED);
    }
    for (const policy of Object.values(MACOS_AUTO_UNLOCK_POLICY)) {
      expect(macosAutoUnlockSupportedSurfaces(policy))
        .not.toContain(MACOS_AUTO_UNLOCK_SURFACE.FILEVAULT_PREBOOT);
    }
  });

  it('refuses a wrong signer before the credential is consulted', () => {
    const decision = decideMacosAutoUnlock(request({
      presentedDesignatedRequirement: 'identifier "to.aiDesk.impostor" and anchor apple generic',
    }));
    expect(decision.allowed === false && decision.refusal)
      .toBe(MACOS_AUTO_UNLOCK_REFUSAL.SIGNER_MISMATCH);
    // An empty requirement is not "no constraint"; it is a refusal.
    expect(decideMacosAutoUnlock(request({
      presentedDesignatedRequirement: '',
      credential: { ...request().credential, designatedRequirement: '' },
    })).allowed).toBe(false);
  });

  it('refuses a different user, session or generation', () => {
    for (const [label, observed, refusal] of [
      ['uid', binding({ localUserUid: 502 }), MACOS_AUTO_UNLOCK_REFUSAL.USER_MISMATCH],
      ['name', binding({ localUserName: 'other' }), MACOS_AUTO_UNLOCK_REFUSAL.USER_MISMATCH],
      ['asid', binding({ auditSessionId: 100_002 }), MACOS_AUTO_UNLOCK_REFUSAL.SESSION_MISMATCH],
      ['type', binding({ sessionType: MACOS_REMOTE_DESKTOP_SESSION_TYPE.AQUA }),
        MACOS_AUTO_UNLOCK_REFUSAL.SESSION_MISMATCH],
      ['generation', binding({ workerGeneration: 5 }),
        MACOS_AUTO_UNLOCK_REFUSAL.GENERATION_MISMATCH],
    ] as const) {
      const decision = decideMacosAutoUnlock(request({ observed }));
      expect(decision.allowed, label).toBe(false);
      expect(decision.allowed === false && decision.refusal, label).toBe(refusal);
    }
  });

  it('gives one answer for a missing item and a denied ACL', () => {
    // Distinguishing them would tell a caller whether the item exists.
    const decision = decideMacosAutoUnlock(request({ credentialReadable: false }));
    expect(decision.allowed === false && decision.refusal)
      .toBe(MACOS_AUTO_UNLOCK_REFUSAL.CREDENTIAL_UNAVAILABLE);
  });

  it('bounds attempts, locks out, and clears the ledger on success', () => {
    let state = { ...MACOS_AUTO_UNLOCK_INITIAL_STATE };
    for (let attempt = 1; attempt <= MACOS_AUTO_UNLOCK_LIMITS.MAX_ATTEMPTS; attempt += 1) {
      const decision = decideMacosAutoUnlock(request({ state }));
      expect(decision.allowed, `attempt ${attempt}`).toBe(true);
      state = decision.nextState;
      expect(state.attempts).toBe(attempt);
    }
    const exhausted = decideMacosAutoUnlock(request({ state }));
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.allowed === false && exhausted.refusal)
      .toBe(MACOS_AUTO_UNLOCK_REFUSAL.ATTEMPTS_EXHAUSTED);
    expect(exhausted.nextState.lockedOutUntilMs)
      .toBe(1_000_000 + MACOS_AUTO_UNLOCK_LIMITS.LOCKOUT_MS);

    // Still locked out one millisecond before expiry.
    const during = decideMacosAutoUnlock(request({
      state: exhausted.nextState,
      nowMs: exhausted.nextState.lockedOutUntilMs - 1,
    }));
    expect(during.allowed === false && during.refusal)
      .toBe(MACOS_AUTO_UNLOCK_REFUSAL.LOCKED_OUT);

    // An expired lockout starts a fresh ledger, not a spent one.
    const after = decideMacosAutoUnlock(request({
      state: exhausted.nextState,
      nowMs: exhausted.nextState.lockedOutUntilMs,
    }));
    expect(after.allowed).toBe(true);
    expect(after.nextState).toEqual({ attempts: 1, lockedOutUntilMs: 0 });

    expect(macosAutoUnlockStateAfterSuccess()).toEqual({ attempts: 0, lockedOutUntilMs: 0 });
  });

  it('fails the capability closed', () => {
    expect(macosAutoUnlockCapabilityAvailable(MACOS_AUTO_UNLOCK_POLICY.DISABLED, true)).toBe(false);
    expect(macosAutoUnlockCapabilityAvailable(MACOS_AUTO_UNLOCK_POLICY.ALWAYS, false)).toBe(false);
    expect(macosAutoUnlockCapabilityAvailable(MACOS_AUTO_UNLOCK_POLICY.ALWAYS, true)).toBe(true);
  });

  it('has nowhere to put the secret', () => {
    // Structural, not aspirational: the module must expose no field, parameter
    // or return value that could carry the credential off the machine.
    const source = readFileSync(
      resolve(__dirname, '../../src/node/macos-remote-desktop-auto-unlock.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');
    for (const forbidden of ['secret', 'password', 'passphrase', 'plaintext', 'Buffer']) {
      expect(code, forbidden).not.toMatch(new RegExp(forbidden, 'iu'));
    }
    // And it must not reach for the wire contract that does carry one.
    expect(code).not.toContain('controlled-node-auto-unlock');
  });
});
