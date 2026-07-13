export const DAEMON_UPGRADE_BLOCKED_TOAST_THROTTLE_MS = 15 * 60_000;

export type DaemonUpgradeBlockedToastState = {
  reason: string;
  shownAt: number;
};

export type DaemonUpgradeBlockedToastKey =
  | 'toast.upgrade_blocked_p2p_active'
  | 'toast.upgrade_blocked_auto_deliver_active'
  | 'toast.upgrade_blocked_master_compaction_active'
  | 'toast.upgrade_blocked_compression_active'
  | 'toast.upgrade_blocked_transport_busy'
  | 'toast.upgrade_blocked_session_busy'
  | 'toast.upgrade_blocked_cooldown_active'
  | 'toast.upgrade_blocked_toolchain_unavailable'
  | 'toast.upgrade_blocked_unknown';

/**
 * Keep wire reasons explicit. The former default mapped every reason unknown to
 * the web bundle (including memory compression) to `p2p_active`, which produced
 * the false "Team is still running" warning even with zero active P2P runs.
 */
export function daemonUpgradeBlockedToastKey(reason: string): DaemonUpgradeBlockedToastKey {
  switch (reason) {
    case 'p2p_active': return 'toast.upgrade_blocked_p2p_active';
    case 'auto_deliver_active': return 'toast.upgrade_blocked_auto_deliver_active';
    case 'master_compaction_active': return 'toast.upgrade_blocked_master_compaction_active';
    case 'compression_active': return 'toast.upgrade_blocked_compression_active';
    case 'transport_busy': return 'toast.upgrade_blocked_transport_busy';
    case 'session_busy': return 'toast.upgrade_blocked_session_busy';
    case 'cooldown_active': return 'toast.upgrade_blocked_cooldown_active';
    case 'toolchain_unavailable': return 'toast.upgrade_blocked_toolchain_unavailable';
    default: return 'toast.upgrade_blocked_unknown';
  }
}

/** Server-driven auto-upgrades retry transient blockers every minute. Show the
 * first blocker immediately, but do not turn each retry into another toast. */
export function shouldShowDaemonUpgradeBlockedToast(
  previous: DaemonUpgradeBlockedToastState | null,
  reason: string,
  now: number,
  throttleMs = DAEMON_UPGRADE_BLOCKED_TOAST_THROTTLE_MS,
): boolean {
  if (!previous || previous.reason !== reason) return true;
  return now - previous.shownAt >= throttleMs;
}
