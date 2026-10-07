import { CONTROLLED_NODE_UPGRADE_WAIT_REASON, DAEMON_UPGRADE_BLOCK_REASON } from '@shared/daemon-upgrade.js';

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
  | 'toast.upgrade_blocked_install_failed'
  | 'toast.upgrade_blocked_unknown';

/**
 * Keep wire reasons explicit. The former default mapped every reason unknown to
 * the web bundle (including memory compression) to `p2p_active`, which produced
 * the false "Team is still running" warning even with zero active P2P runs.
 */
export function daemonUpgradeBlockedToastKey(reason: string): DaemonUpgradeBlockedToastKey {
  switch (reason) {
    case DAEMON_UPGRADE_BLOCK_REASON.P2P_ACTIVE: return 'toast.upgrade_blocked_p2p_active';
    case DAEMON_UPGRADE_BLOCK_REASON.AUTO_DELIVER_ACTIVE: return 'toast.upgrade_blocked_auto_deliver_active';
    case DAEMON_UPGRADE_BLOCK_REASON.MASTER_COMPACTION_ACTIVE: return 'toast.upgrade_blocked_master_compaction_active';
    case DAEMON_UPGRADE_BLOCK_REASON.COMPRESSION_ACTIVE: return 'toast.upgrade_blocked_compression_active';
    case DAEMON_UPGRADE_BLOCK_REASON.TRANSPORT_BUSY: return 'toast.upgrade_blocked_transport_busy';
    case DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY: return 'toast.upgrade_blocked_session_busy';
    case DAEMON_UPGRADE_BLOCK_REASON.COOLDOWN_ACTIVE: return 'toast.upgrade_blocked_cooldown_active';
    case DAEMON_UPGRADE_BLOCK_REASON.TOOLCHAIN_UNAVAILABLE: return 'toast.upgrade_blocked_toolchain_unavailable';
    case DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED: return 'toast.upgrade_blocked_install_failed';
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

export type DaemonUpgradeReasonLabelKey =
  | 'server.daemon_auto_upgrade_reason_p2p_active'
  | 'server.daemon_auto_upgrade_reason_auto_deliver_active'
  | 'server.daemon_auto_upgrade_reason_master_compaction_active'
  | 'server.daemon_auto_upgrade_reason_transport_busy'
  | 'server.daemon_auto_upgrade_reason_session_busy'
  | 'server.daemon_auto_upgrade_reason_cooldown_active'
  | 'server.daemon_auto_upgrade_reason_already_in_progress'
  | 'server.daemon_auto_upgrade_reason_retry_backoff'
  | 'server.daemon_auto_upgrade_reason_version_unchanged'
  | 'server.daemon_auto_upgrade_reason_install_failed'
  | 'server.daemon_auto_upgrade_reason_toolchain_unavailable'
  | 'server.daemon_auto_upgrade_reason_unknown';

/**
 * Plain-language label for why an automatic upgrade is waiting or failed. Keyed
 * by the daemon's own wire reasons (the daemon's busy gates are the definition
 * of "not idle"); a reason this build does not know falls back to a generic
 * label instead of showing a raw code or throwing.
 */
export function daemonUpgradeReasonLabelKey(reason: string | null | undefined): DaemonUpgradeReasonLabelKey {
  switch (reason) {
    case DAEMON_UPGRADE_BLOCK_REASON.P2P_ACTIVE: return 'server.daemon_auto_upgrade_reason_p2p_active';
    case DAEMON_UPGRADE_BLOCK_REASON.AUTO_DELIVER_ACTIVE: return 'server.daemon_auto_upgrade_reason_auto_deliver_active';
    case DAEMON_UPGRADE_BLOCK_REASON.MASTER_COMPACTION_ACTIVE: return 'server.daemon_auto_upgrade_reason_master_compaction_active';
    case DAEMON_UPGRADE_BLOCK_REASON.TRANSPORT_BUSY: return 'server.daemon_auto_upgrade_reason_transport_busy';
    case DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY: return 'server.daemon_auto_upgrade_reason_session_busy';
    case DAEMON_UPGRADE_BLOCK_REASON.COOLDOWN_ACTIVE: return 'server.daemon_auto_upgrade_reason_cooldown_active';
    case DAEMON_UPGRADE_BLOCK_REASON.ALREADY_IN_PROGRESS: return 'server.daemon_auto_upgrade_reason_already_in_progress';
    case CONTROLLED_NODE_UPGRADE_WAIT_REASON.RETRY_BACKOFF: return 'server.daemon_auto_upgrade_reason_retry_backoff';
    case CONTROLLED_NODE_UPGRADE_WAIT_REASON.VERSION_UNCHANGED_AFTER_UPGRADE: return 'server.daemon_auto_upgrade_reason_version_unchanged';
    case DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED: return 'server.daemon_auto_upgrade_reason_install_failed';
    case DAEMON_UPGRADE_BLOCK_REASON.TOOLCHAIN_UNAVAILABLE: return 'server.daemon_auto_upgrade_reason_toolchain_unavailable';
    default: return 'server.daemon_auto_upgrade_reason_unknown';
  }
}
