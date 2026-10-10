import { describe, expect, it } from 'vitest';
import { DAEMON_UPGRADE_BLOCK_REASON } from '../../shared/daemon-upgrade.js';
import {
  DAEMON_UPGRADE_BLOCKED_TOAST_THROTTLE_MS,
  daemonUpgradeBlockedToastKey,
  daemonUpgradeReasonLabelKey,
  shouldShowDaemonUpgradeBlockedToast,
} from '../src/daemon-upgrade-blocked.js';

describe('daemon upgrade blocked toast', () => {
  it('maps every daemon blocker to its own message instead of falling back to Team', () => {
    expect(daemonUpgradeBlockedToastKey('p2p_active')).toBe('toast.upgrade_blocked_p2p_active');
    expect(daemonUpgradeBlockedToastKey('auto_deliver_active')).toBe('toast.upgrade_blocked_auto_deliver_active');
    expect(daemonUpgradeBlockedToastKey('master_compaction_active')).toBe('toast.upgrade_blocked_master_compaction_active');
    expect(daemonUpgradeBlockedToastKey('compression_active')).toBe('toast.upgrade_blocked_compression_active');
    expect(daemonUpgradeBlockedToastKey('transport_busy')).toBe('toast.upgrade_blocked_transport_busy');
    expect(daemonUpgradeBlockedToastKey('session_busy')).toBe('toast.upgrade_blocked_session_busy');
    expect(daemonUpgradeBlockedToastKey('cooldown_active')).toBe('toast.upgrade_blocked_cooldown_active');
    expect(daemonUpgradeBlockedToastKey('toolchain_unavailable')).toBe('toast.upgrade_blocked_toolchain_unavailable');
    expect(daemonUpgradeBlockedToastKey(DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED)).toBe('toast.upgrade_blocked_install_failed');
    expect(daemonUpgradeBlockedToastKey('future_reason')).toBe('toast.upgrade_blocked_unknown');
  });

  it('suppresses minute-by-minute retries for the same reason', () => {
    const shownAt = 1_000_000;
    const previous = { reason: 'compression_active', shownAt };

    expect(shouldShowDaemonUpgradeBlockedToast(previous, 'compression_active', shownAt + 60_000)).toBe(false);
    expect(shouldShowDaemonUpgradeBlockedToast(
      previous,
      'compression_active',
      shownAt + DAEMON_UPGRADE_BLOCKED_TOAST_THROTTLE_MS,
    )).toBe(true);
  });

  it('shows a changed blocker immediately', () => {
    expect(shouldShowDaemonUpgradeBlockedToast(
      { reason: 'compression_active', shownAt: 1_000_000 },
      'transport_busy',
      1_000_001,
    )).toBe(true);
  });
});

describe('daemon upgrade reason labels', () => {
  it('gives every known reason its own label and unknown ones a generic one', () => {
    for (const reason of [
      'p2p_active', 'auto_deliver_active', 'master_compaction_active', 'transport_busy', 'session_busy',
      'cooldown_active', 'already_in_progress', 'retry_backoff', 'install_failed', 'toolchain_unavailable',
      // A daemon that has just started (or is recovering after a crash) names its own hold.
      'starting_up', 'unclean_shutdown_recovery',
    ]) {
      expect(daemonUpgradeReasonLabelKey(reason)).toBe(`server.daemon_auto_upgrade_reason_${reason}`);
    }
    expect(daemonUpgradeReasonLabelKey('version_unchanged_after_upgrade')).toBe('server.daemon_auto_upgrade_reason_version_unchanged');
    expect(daemonUpgradeReasonLabelKey('something_new')).toBe('server.daemon_auto_upgrade_reason_unknown');
    expect(daemonUpgradeReasonLabelKey(null)).toBe('server.daemon_auto_upgrade_reason_unknown');
    expect(daemonUpgradeReasonLabelKey(undefined)).toBe('server.daemon_auto_upgrade_reason_unknown');
  });
});


describe('daemon upgrade deferral labels exist in every locale', () => {
  it.each(['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko'])('%s', async (locale) => {
    const messages = (await import(`../src/i18n/locales/${locale}.json`)).default as { server: Record<string, string> };
    for (const reason of ['starting_up', 'unclean_shutdown_recovery']) {
      expect(messages.server[`daemon_auto_upgrade_reason_${reason}`], `${locale} ${reason}`).toBeTruthy();
    }
  });
});
