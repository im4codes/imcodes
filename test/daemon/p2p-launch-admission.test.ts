import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearAutoDeliverP2pLocksForTests,
  evaluateP2pLaunchAdmission,
  getAutoDeliverP2pLock,
  hasActiveP2pRunForMainSession,
  registerAutoDeliverP2pLock,
  releaseAutoDeliverP2pLock,
} from '../../src/daemon/p2p-launch-admission.js';

describe('P2P launch admission — Auto Deliver lock', () => {
  beforeEach(() => {
    clearAutoDeliverP2pLocksForTests();
  });

  it('allows normal manual launches when no Auto Deliver lock is active', () => {
    expect(evaluateP2pLaunchAdmission({
      mainSession: 'deck_proj',
      origin: { kind: 'manual', commandId: 'manual-1' },
      activeRuns: [],
    })).toEqual({ ok: true });
  });

  it('blocks manual and force-like manual launches while Auto Deliver owns the Team lane', () => {
    registerAutoDeliverP2pLock({
      runId: 'auto-run-1',
      owningMainSessionName: 'deck_proj',
      generation: 2,
      allowedComboIds: ['openspec_auto_deliver.implementation_audit_repair'],
    });

    expect(evaluateP2pLaunchAdmission({
      mainSession: 'deck_proj',
      origin: { kind: 'manual', commandId: 'manual-force-true' },
      activeRuns: [],
    })).toEqual({
      ok: false,
      reason: 'auto_deliver_active',
      activeAutoDeliverRunId: 'auto-run-1',
      owningMainSessionName: 'deck_proj',
    });
  });

  it('allows only matching Auto Deliver metadata and designated combo ids through the lock', () => {
    registerAutoDeliverP2pLock({
      runId: 'auto-run-2',
      owningMainSessionName: 'deck_proj',
      generation: 7,
      allowedComboIds: ['openspec_auto_deliver.spec_audit_repair'],
    });

    const matchingOrigin = {
      kind: 'openspec_auto_deliver' as const,
      autoDeliver: {
        runId: 'auto-run-2',
        changeName: 'openspec-auto-delivery',
        owningMainSessionName: 'deck_proj',
        generation: 7,
        stage: 'spec_audit_repair',
        attemptId: 'attempt-1',
        comboId: 'openspec_auto_deliver.spec_audit_repair',
      },
    };

    expect(evaluateP2pLaunchAdmission({
      mainSession: 'deck_proj',
      origin: matchingOrigin,
      activeRuns: [],
    })).toEqual({ ok: true });

    for (const origin of [
      { ...matchingOrigin, autoDeliver: { ...matchingOrigin.autoDeliver, runId: 'other-run' } },
      { ...matchingOrigin, autoDeliver: { ...matchingOrigin.autoDeliver, owningMainSessionName: 'deck_other' } },
      { ...matchingOrigin, autoDeliver: { ...matchingOrigin.autoDeliver, generation: 8 } },
      { ...matchingOrigin, autoDeliver: { ...matchingOrigin.autoDeliver, comboId: 'openspec' } },
      { ...matchingOrigin, autoDeliver: { ...matchingOrigin.autoDeliver, comboId: undefined } },
    ]) {
      expect(evaluateP2pLaunchAdmission({
        mainSession: 'deck_proj',
        origin,
        activeRuns: [],
      })).toMatchObject({
        ok: false,
        reason: 'auto_deliver_active',
        activeAutoDeliverRunId: 'auto-run-2',
      });
    }
  });

  it('releases only the matching run lock and then restores normal Team launch admission', () => {
    registerAutoDeliverP2pLock({
      runId: 'auto-run-3',
      owningMainSessionName: 'deck_proj',
      generation: 1,
    });

    expect(releaseAutoDeliverP2pLock('deck_proj', 'wrong-run')).toBe(false);
    expect(getAutoDeliverP2pLock('deck_proj')).toMatchObject({ runId: 'auto-run-3' });

    expect(releaseAutoDeliverP2pLock('deck_proj', 'auto-run-3')).toBe(true);
    expect(getAutoDeliverP2pLock('deck_proj')).toBeUndefined();
    expect(evaluateP2pLaunchAdmission({
      mainSession: 'deck_proj',
      origin: { kind: 'manual', commandId: 'manual-after-release' },
      activeRuns: [],
    })).toEqual({ ok: true });
  });

  it('detects active manual Team runs by owning main session without treating terminal runs as busy', () => {
    expect(hasActiveP2pRunForMainSession([
      {
        id: 'manual-active',
        mainSession: 'deck_proj',
        initiatorSession: 'deck_proj_brain',
        status: 'running',
        launchOrigin: { kind: 'manual', commandId: 'manual-1' },
      },
      {
        id: 'manual-done',
        mainSession: 'deck_proj',
        initiatorSession: 'deck_proj_brain',
        status: 'completed',
        launchOrigin: { kind: 'manual', commandId: 'manual-2' },
      },
    ], 'deck_proj')).toBe(true);

    expect(hasActiveP2pRunForMainSession([
      {
        id: 'manual-done',
        mainSession: 'deck_proj',
        initiatorSession: 'deck_proj_brain',
        status: 'completed',
        launchOrigin: { kind: 'manual', commandId: 'manual-2' },
      },
      {
        id: 'other-active',
        mainSession: 'deck_other',
        initiatorSession: 'deck_other_brain',
        status: 'running',
        launchOrigin: { kind: 'manual', commandId: 'manual-3' },
      },
    ], 'deck_proj')).toBe(false);
  });
});
