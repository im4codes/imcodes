import { describe, expect, it } from 'vitest';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import {
  DAEMON_UPGRADE_BLOCK_REASON,
  normalizeDaemonUpgradeTargetVersion,
  validateControlledNodeUpgradeBlockedMessage,
} from '../../shared/daemon-upgrade.js';

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

describe('controlled-node upgrade blocker validation', () => {
  it('accepts only the exact bounded minimal frame', () => {
    expect(validateControlledNodeUpgradeBlockedMessage({
      type: DAEMON_MSG.UPGRADE_BLOCKED,
      reason: DAEMON_UPGRADE_BLOCK_REASON.ALREADY_IN_PROGRESS,
    })).toEqual({
      ok: true,
      value: {
        type: DAEMON_MSG.UPGRADE_BLOCKED,
        reason: DAEMON_UPGRADE_BLOCK_REASON.ALREADY_IN_PROGRESS,
      },
    });

    expect(validateControlledNodeUpgradeBlockedMessage({
      type: DAEMON_MSG.UPGRADE_BLOCKED,
      reason: DAEMON_UPGRADE_BLOCK_REASON.ALREADY_IN_PROGRESS,
      extra: true,
    })).toEqual({ ok: false });
    expect(validateControlledNodeUpgradeBlockedMessage({
      type: DAEMON_MSG.UPGRADE_BLOCKED,
      reason: '',
    })).toEqual({ ok: false });
    expect(validateControlledNodeUpgradeBlockedMessage({
      type: DAEMON_MSG.UPGRADE_BLOCKED,
      reason: 123,
    })).toEqual({ ok: false });
    expect(validateControlledNodeUpgradeBlockedMessage({
      type: DAEMON_MSG.UPGRADE_BLOCKED,
      reason: 'x'.repeat(129),
    })).toEqual({
      ok: true,
      value: {
        type: DAEMON_MSG.UPGRADE_BLOCKED,
        reason: 'x'.repeat(128),
      },
    });
  });
});
