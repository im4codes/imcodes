import { describe, expect, it } from 'vitest';
import {
  enrollmentAbiDigest,
  CONTROLLED_NODE_ABI_GLIBC217,
  CONTROLLED_NODE_ABI_MODERN,
  CONTROLLED_NODE_RUNTIME_ABI_PROFILE,
  isControlledNodeAbiTarget,
  normalizeControlledNodeAbiProfile,
} from '../../shared/controlled-node-abi.js';

describe('controlled-node ABI profile', () => {
  it('preserves the missing-field modern default without accepting invalid profile forms', () => {
    expect(CONTROLLED_NODE_RUNTIME_ABI_PROFILE).toBe(CONTROLLED_NODE_ABI_MODERN);
    expect(normalizeControlledNodeAbiProfile(undefined)).toBe(CONTROLLED_NODE_ABI_MODERN);
    for (const invalid of [null, '', false, 0, [], {}, ['modern'], 'MODERN', 'linux-glibc28']) {
      expect(normalizeControlledNodeAbiProfile(invalid)).toBeNull();
    }
  });
  it('never turns the compatibility profile into a fake architecture or GUI/arm claim', () => {
    expect(isControlledNodeAbiTarget('linux', 'x64', CONTROLLED_NODE_ABI_GLIBC217)).toBe(true);
    for (const [os, arch] of [['linux', 'arm64'], ['mac', 'x64'], ['win', 'x64'], ['linux', 'glibc217']]) {
      expect(isControlledNodeAbiTarget(os, arch, CONTROLLED_NODE_ABI_GLIBC217)).toBe(false);
    }
    expect(isControlledNodeAbiTarget('mac', 'universal', undefined)).toBe(true);
  });
});

describe('server-owned enrollment ABI authorization', () => {
  const modernDigest = 'a'.repeat(64);
  const compatDigest = 'b'.repeat(64);
  const binding = { os: 'linux', arch: 'x64', sha256: modernDigest, allowVariants: true,
    variants: { [CONTROLLED_NODE_ABI_GLIBC217]: compatDigest } };
  it('keeps primary modern binding and authorizes only its verified compat variant', () => {
    expect(enrollmentAbiDigest(binding, CONTROLLED_NODE_ABI_MODERN)).toBe(modernDigest);
    expect(enrollmentAbiDigest(binding, CONTROLLED_NODE_ABI_GLIBC217)).toBe(compatDigest);
    expect(enrollmentAbiDigest({ ...binding, allowVariants: false }, CONTROLLED_NODE_ABI_GLIBC217)).toBeNull();
    expect(enrollmentAbiDigest({ ...binding, arch: 'arm64' }, CONTROLLED_NODE_ABI_GLIBC217)).toBeNull();
  });
  it.each([null, {}, [], 'unknown', 17])('rejects unknown stored ABI instead of treating %j as variant authority', (abiProfile) => {
    expect(enrollmentAbiDigest({ ...binding, abiProfile }, CONTROLLED_NODE_ABI_GLIBC217)).toBeNull();
  });
  it.each([null, [], {}, { [CONTROLLED_NODE_ABI_GLIBC217]: 'bad' }])('rejects missing or malformed server-owned variant pins %j', (variants) => {
    expect(enrollmentAbiDigest({ ...binding, variants }, CONTROLLED_NODE_ABI_GLIBC217)).toBeNull();
  });
});
