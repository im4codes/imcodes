import { describe, it, expect, vi } from 'vitest';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import { MSG_DAEMON_ONLINE, MSG_DAEMON_OFFLINE } from '@shared/ack-protocol.js';
import {
  nextDaemonUpgradingState,
  daemonUpgradingLabel,
  type DaemonUpgradingState,
} from '../src/util/daemon-upgrade-status.js';

describe('nextDaemonUpgradingState', () => {
  it('begins the badge with the target version on UPGRADING', () => {
    expect(nextDaemonUpgradingState(DAEMON_MSG.UPGRADING, '2026.4.2000-dev.7'))
      .toEqual({ targetVersion: '2026.4.2000-dev.7' });
  });

  it('falls back to an empty target version when the daemon supplies none', () => {
    expect(nextDaemonUpgradingState(DAEMON_MSG.UPGRADING)).toEqual({ targetVersion: '' });
    expect(nextDaemonUpgradingState(DAEMON_MSG.UPGRADING, undefined)).toEqual({ targetVersion: '' });
    // Non-string (defensive against a malformed payload) → empty, never throws.
    expect(nextDaemonUpgradingState(DAEMON_MSG.UPGRADING, 123 as unknown)).toEqual({ targetVersion: '' });
    expect(nextDaemonUpgradingState(DAEMON_MSG.UPGRADING, null as unknown)).toEqual({ targetVersion: '' });
  });

  it('clears the badge when the daemon comes back (online / reconnected)', () => {
    expect(nextDaemonUpgradingState(MSG_DAEMON_ONLINE)).toBeNull();
    expect(nextDaemonUpgradingState(DAEMON_MSG.RECONNECTED)).toBeNull();
  });

  it('leaves the badge untouched (undefined) for unrelated messages', () => {
    // undefined is the "keep current state" sentinel — distinct from null (clear).
    expect(nextDaemonUpgradingState(DAEMON_MSG.DISCONNECTED)).toBeUndefined();
    expect(nextDaemonUpgradingState(DAEMON_MSG.UPGRADE_BLOCKED)).toBeUndefined();
    expect(nextDaemonUpgradingState(MSG_DAEMON_OFFLINE)).toBeUndefined();
    expect(nextDaemonUpgradingState('daemon.stats')).toBeUndefined();
    expect(nextDaemonUpgradingState('session_list')).toBeUndefined();
  });

  it('does NOT clear on DISCONNECTED — the badge must survive the upgrade restart', () => {
    // The whole point: during an upgrade the daemon disconnects, but the badge
    // stays up until the new version reconnects. So DISCONNECTED is a no-op.
    expect(nextDaemonUpgradingState(DAEMON_MSG.DISCONNECTED)).toBeUndefined();
  });
});

describe('daemonUpgradingLabel', () => {
  const fmt = (v: string) => v.replace(/-dev\.\d+$/, '-dev'); // stand-in for formatDaemonVersionShort
  const t = vi.fn((key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key);

  it('returns empty string when not upgrading', () => {
    expect(daemonUpgradingLabel(null, t, fmt)).toBe('');
  });

  it('uses the "upgrading to vX" key with the FORMATTED target version', () => {
    const state: DaemonUpgradingState = { targetVersion: '2026.4.2000-dev.7' };
    expect(daemonUpgradingLabel(state, t, fmt)).toBe(
      'sidebar.daemon_upgrading_to:{"version":"2026.4.2000-dev"}',
    );
    expect(t).toHaveBeenCalledWith('sidebar.daemon_upgrading_to', { version: '2026.4.2000-dev' });
  });

  it('uses the generic "upgrading" key when the target version is unknown', () => {
    expect(daemonUpgradingLabel({ targetVersion: '' }, t, fmt)).toBe('sidebar.daemon_upgrading');
  });
});
