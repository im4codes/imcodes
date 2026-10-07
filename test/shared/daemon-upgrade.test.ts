import { describe, expect, it } from 'vitest';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import {
  CONTROLLED_NODE_UPGRADE_RETRY_DELAYS_MS,
  CONTROLLED_NODE_UPGRADE_STAGGER_MAX_MS,
  DAEMON_UPGRADE_BLOCK_REASON,
  DAEMON_UPGRADE_BUSY_BLOCK_REASONS,
  DAEMON_UPGRADE_SOURCE,
  controlledNodeUpgradeRetryDelayMs,
  controlledNodeUpgradeStaggerMs,
  isDaemonAutoUpgradeAvailable,
  isDaemonAutoUpgradeDisabledByEnv,
  isDaemonUpgradeBusyBlockReason,
  isRetryableDaemonUpgradeBlockReason,
  resolveDaemonUpgradeForce,
  normalizeDaemonUpgradeTargetVersion,
  validateControlledNodeUpgradeBlockedMessage,
} from '../../shared/daemon-upgrade.js';

describe('deployment auto-upgrade gate', () => {
  it('only disables automatic upgrades for explicit opt-out values', () => {
    expect(isDaemonAutoUpgradeDisabledByEnv({ IMCODES_DISABLE_AUTO_UPGRADE: '1' })).toBe(true);
    expect(isDaemonAutoUpgradeDisabledByEnv({ IMCODES_DISABLE_AUTO_UPGRADE: 'true' })).toBe(true);
    expect(isDaemonAutoUpgradeDisabledByEnv({ IMCODES_DISABLE_AUTO_UPGRADE: '0' })).toBe(false);
    expect(isDaemonAutoUpgradeDisabledByEnv({ IMCODES_DISABLE_AUTO_UPGRADE: 'false' })).toBe(false);
    expect(isDaemonAutoUpgradeDisabledByEnv({})).toBe(false);
  });
});

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

describe('controlled upgrade rollback envelope', () => {
  it('accepts only a bounded concrete target version with the controlled blocker', () => {
    expect(validateControlledNodeUpgradeBlockedMessage({
      type: DAEMON_MSG.UPGRADE_BLOCKED,
      reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED,
      targetVersion: '2026.9.4544-dev.5197',
    })).toEqual({ ok: true, value: {
      type: DAEMON_MSG.UPGRADE_BLOCKED,
      reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED,
      targetVersion: '2026.9.4544-dev.5197',
    } });
    expect(validateControlledNodeUpgradeBlockedMessage({
      type: DAEMON_MSG.UPGRADE_BLOCKED,
      reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED,
      targetVersion: 'latest',
    })).toEqual({ ok: false });
  });
});

describe('resolveDaemonUpgradeSource', () => {
  it('treats a missing or unknown source (older servers) as auto so the opt-out still holds', async () => {
    const { resolveDaemonUpgradeSource, DAEMON_UPGRADE_SOURCE } = await import('../../shared/daemon-upgrade.js');
    expect(resolveDaemonUpgradeSource(undefined)).toBe(DAEMON_UPGRADE_SOURCE.AUTO);
    expect(resolveDaemonUpgradeSource('bogus')).toBe(DAEMON_UPGRADE_SOURCE.AUTO);
    expect(resolveDaemonUpgradeSource(DAEMON_UPGRADE_SOURCE.MANUAL)).toBe(DAEMON_UPGRADE_SOURCE.MANUAL);
    expect(resolveDaemonUpgradeSource(DAEMON_UPGRADE_SOURCE.REPLAY)).toBe(DAEMON_UPGRADE_SOURCE.REPLAY);
  });
});

describe('controlled-node upgrade retry schedule', () => {
  it('backs off with each attempt and repeats the last delay instead of giving up', () => {
    const delays = [1, 2, 3, 4, 5, 50].map(controlledNodeUpgradeRetryDelayMs);
    expect(delays.slice(0, 4)).toEqual([...CONTROLLED_NODE_UPGRADE_RETRY_DELAYS_MS]);
    expect(delays[4]).toBe(CONTROLLED_NODE_UPGRADE_RETRY_DELAYS_MS.at(-1));
    expect(delays[5]).toBe(CONTROLLED_NODE_UPGRADE_RETRY_DELAYS_MS.at(-1));
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
  });

  it('never returns an immediate or negative delay, whatever the attempt count', () => {
    for (const attempts of [0, -3, 0.5, Number.NaN]) {
      const delay = controlledNodeUpgradeRetryDelayMs(attempts);
      expect(delay).toBeGreaterThanOrEqual(CONTROLLED_NODE_UPGRADE_RETRY_DELAYS_MS[0]);
    }
  });
});

describe('controlled-node upgrade stagger', () => {
  it('is stable per node, bounded, and spreads a fleet instead of firing it together', () => {
    const ids = Array.from({ length: 64 }, (_, i) => `node-${i.toString(16).padStart(32, '0')}`);
    const delays = ids.map(controlledNodeUpgradeStaggerMs);
    expect(delays).toEqual(ids.map(controlledNodeUpgradeStaggerMs));
    for (const delay of delays) {
      expect(Number.isInteger(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(CONTROLLED_NODE_UPGRADE_STAGGER_MAX_MS);
    }
    // A fleet must not all land on one instant (the thundering herd this prevents).
    expect(new Set(delays).size).toBeGreaterThan(ids.length / 2);
    expect(controlledNodeUpgradeStaggerMs('')).toBe(0);
  });
});

describe('forced manual upgrade', () => {
  it('forces only an explicit force:true on a manual upgrade', () => {
    expect(resolveDaemonUpgradeForce(true, DAEMON_UPGRADE_SOURCE.MANUAL)).toBe(true);
    for (const raw of [false, undefined, null, 'true', 1, {}, []]) {
      expect(resolveDaemonUpgradeForce(raw, DAEMON_UPGRADE_SOURCE.MANUAL)).toBe(false);
    }
    // Auto and replay always ignore it, so a stray field can never bypass the idle gates.
    expect(resolveDaemonUpgradeForce(true, DAEMON_UPGRADE_SOURCE.AUTO)).toBe(false);
    expect(resolveDaemonUpgradeForce(true, DAEMON_UPGRADE_SOURCE.REPLAY)).toBe(false);
  });
});

describe('the daemon\'s busy gates', () => {
  it('names exactly the five gates and treats each as retryable, never as a failure', () => {
    expect([...DAEMON_UPGRADE_BUSY_BLOCK_REASONS].sort()).toEqual([
      'auto_deliver_active', 'master_compaction_active', 'p2p_active', 'session_busy', 'transport_busy',
    ]);
    for (const reason of DAEMON_UPGRADE_BUSY_BLOCK_REASONS) {
      expect(isDaemonUpgradeBusyBlockReason(reason)).toBe(true);
      expect(isRetryableDaemonUpgradeBlockReason(reason)).toBe(true);
    }
    expect(isRetryableDaemonUpgradeBlockReason(DAEMON_UPGRADE_BLOCK_REASON.COOLDOWN_ACTIVE)).toBe(true);
    expect(isRetryableDaemonUpgradeBlockReason(DAEMON_UPGRADE_BLOCK_REASON.ALREADY_IN_PROGRESS)).toBe(true);
  });

  it('keeps failures and the daemon opt-out out of the retryable set', () => {
    for (const reason of [
      DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED,
      DAEMON_UPGRADE_BLOCK_REASON.TOOLCHAIN_UNAVAILABLE,
      DAEMON_UPGRADE_BLOCK_REASON.AUTO_UPGRADE_DISABLED,
      'artifact_download_failed',
      'native_quiesce_failed',
    ]) {
      expect(isRetryableDaemonUpgradeBlockReason(reason)).toBe(false);
    }
  });
});

describe('what the server may upgrade on its own', () => {
  it('moves only a strictly older daemon on the same release channel', () => {
    expect(isDaemonAutoUpgradeAvailable('2026.4.904-dev.100', '2026.4.905-dev.877')).toBe(true);
    expect(isDaemonAutoUpgradeAvailable('2026.4.904', '2026.4.905')).toBe(true);
    // current, newer daemon, unknown versions
    expect(isDaemonAutoUpgradeAvailable('2026.4.905-dev.877', '2026.4.905-dev.877')).toBe(false);
    expect(isDaemonAutoUpgradeAvailable('2026.4.906-dev.1', '2026.4.905-dev.877')).toBe(false);
    expect(isDaemonAutoUpgradeAvailable(null, '2026.4.905')).toBe(false);
    expect(isDaemonAutoUpgradeAvailable('2026.4.904', undefined)).toBe(false);
    expect(isDaemonAutoUpgradeAvailable('not-a-version', '2026.4.905')).toBe(false);
    // cross-channel stays an operator decision
    expect(isDaemonAutoUpgradeAvailable('2026.4.905', '2026.4.905-dev.877')).toBe(false);
    expect(isDaemonAutoUpgradeAvailable('2026.4.905-dev.877', '2026.4.905')).toBe(false);
    expect(isDaemonAutoUpgradeAvailable('2026.4.800', '2026.4.905-dev.877')).toBe(false);
  });
});
