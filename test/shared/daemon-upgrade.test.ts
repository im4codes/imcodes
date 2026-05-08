import { describe, expect, it } from 'vitest';
import { normalizeDaemonUpgradeTargetVersion } from '../../shared/daemon-upgrade.js';

describe('daemon upgrade target validation', () => {
  it('accepts latest, semver, and dev calver targets', () => {
    expect(normalizeDaemonUpgradeTargetVersion(undefined)).toBe('latest');
    expect(normalizeDaemonUpgradeTargetVersion('latest')).toBe('latest');
    expect(normalizeDaemonUpgradeTargetVersion('1.2.3')).toBe('1.2.3');
    expect(normalizeDaemonUpgradeTargetVersion('2026.5.2026-dev.2005')).toBe('2026.5.2026-dev.2005');
  });

  it('rejects package specs, URLs, paths, and shell metacharacters', () => {
    for (const value of [
      'imcodes@latest',
      'http://registry/imcodes',
      '../imcodes',
      '2026.5.2026-dev.2005;touch /tmp/pwn',
      '2026.5.2026-dev.2005 && id',
      '@scope/pkg',
    ]) {
      expect(() => normalizeDaemonUpgradeTargetVersion(value)).toThrow('invalid_target_version');
    }
  });
});
