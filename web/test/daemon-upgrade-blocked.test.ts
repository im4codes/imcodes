import { describe, expect, it } from 'vitest';
import {
  DAEMON_UPGRADE_BLOCKED_TOAST_THROTTLE_MS,
  daemonUpgradeBlockedToastKey,
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
