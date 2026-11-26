import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  RemoteDesktopUnattendedPasswordService,
  UNATTENDED_PASSWORD_TARGET_STATE,
  createVersionedDummyVerifier,
  deriveUnattendedPasswordVerifier,
  timingDistributionWithinBaseline,
  type ResolvedUnattendedPasswordTarget,
} from '../src/services/remote-desktop-unattended-password.js';

const RUN_GATE = process.env.RUN_REMOTE_DESKTOP_PASSWORD_TIMING_GATE === '1';
const PASSWORD = 'Dedicated runner 8! password';
const peppers = {
  currentVersion: 'timing-v1',
  resolve: (version: string) => version === 'timing-v1'
    ? 'dedicated-runner-pepper-is-at-least-thirty-two-bytes'
    : null,
};

describe.skipIf(!RUN_GATE)('unattended password timing distribution gate', () => {
  it('keeps every failure class within 20% of unknown after warm-up', async () => {
    const real = await deriveUnattendedPasswordVerifier({ password: PASSWORD, peppers });
    const dummy = await createVersionedDummyVerifier({ peppers });
    const targets: Record<string, ResolvedUnattendedPasswordTarget> = {
      unknown: { state: UNATTENDED_PASSWORD_TARGET_STATE.UNKNOWN, hostId: null, credential: null },
      retired: { state: UNATTENDED_PASSWORD_TARGET_STATE.RETIRED, hostId: 'host-a', credential: null },
      disabled: { state: UNATTENDED_PASSWORD_TARGET_STATE.DISABLED, hostId: 'host-a', credential: null },
      offline: { state: UNATTENDED_PASSWORD_TARGET_STATE.OFFLINE, hostId: 'host-a', credential: null },
      unsupported: { state: UNATTENDED_PASSWORD_TARGET_STATE.UNSUPPORTED, hostId: 'host-a', credential: null },
      wrong: {
        state: UNATTENDED_PASSWORD_TARGET_STATE.ENABLED,
        hostId: 'host-a',
        credential: { ...real, generation: 1, changedAt: 1, disabledAt: null },
      },
    };
    const service = new RemoteDesktopUnattendedPasswordService({
      targets: { resolve: async (publicNodeId) => targets[publicNodeId]! },
      rateLimiter: {
        admit: async () => ({ allowed: true, dummyWorkAllowed: false, cooldownUntil: null }),
      },
      peppers,
      dummyVerifier: dummy,
    });
    const sample = async (target: string): Promise<number> => {
      const started = performance.now();
      await service.verify({ publicNodeId: target, password: 'always wrong', source: 'isolated-runner' });
      return performance.now() - started;
    };
    for (let index = 0; index < 100; index += 1) await sample('unknown');
    const distributions: Record<string, number[]> = {};
    for (const target of Object.keys(targets)) {
      distributions[target] = [];
      for (let index = 0; index < 500; index += 1) distributions[target]!.push(await sample(target));
    }
    for (const target of Object.keys(targets).filter((value) => value !== 'unknown')) {
      expect(timingDistributionWithinBaseline({
        baseline: distributions.unknown!,
        candidate: distributions[target]!,
        tolerance: 0.2,
      }), `${target} timing distribution diverged`).toBe(true);
    }
  }, 20 * 60_000);
});
