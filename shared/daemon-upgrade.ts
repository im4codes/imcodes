import { DAEMON_MSG } from './daemon-events.js';

export const DAEMON_UPGRADE_TARGET_LATEST = 'latest';

export const DAEMON_UPGRADE_BLOCK_REASON = {
  ALREADY_IN_PROGRESS: 'already_in_progress',
  INSTALL_FAILED: 'install_failed',
} as const;

export interface ControlledNodeUpgradeBlockedMessage {
  [key: string]: unknown;
  type: typeof DAEMON_MSG.UPGRADE_BLOCKED;
  reason: string;
}

/** CONTROLLED nodes expose only this exact, bounded upgrade-blocker envelope. */
export function validateControlledNodeUpgradeBlockedMessage(
  value: unknown,
): { ok: true; value: ControlledNodeUpgradeBlockedMessage } | { ok: false } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2) return { ok: false };
  if (record.type !== DAEMON_MSG.UPGRADE_BLOCKED) return { ok: false };
  if (typeof record.reason !== 'string' || record.reason.length < 1) {
    return { ok: false };
  }
  return {
    ok: true,
    // The daemon's exception text is diagnostic only. Bound what crosses the
    // trust boundary without dropping a recoverable frame merely because an old
    // runtime included a long URL or platform error in its message.
    value: { type: DAEMON_MSG.UPGRADE_BLOCKED, reason: record.reason.slice(0, 128) },
  };
}

export const DAEMON_UPGRADE_BLOCKED_SYNC_PROTOCOL = {
  AUTH_REVISION_FIELD: 'upgradeBlockedSyncRevision',
  REVISION: 1,
} as const;

export const DAEMON_UPGRADE_BLOCKED_ACK_DISPOSITION = {
  ACCEPTED: 'accepted',
  OBSOLETE: 'obsolete',
  SUPERSEDED: 'superseded',
} as const;

export type DaemonUpgradeBlockedAckDisposition =
  (typeof DAEMON_UPGRADE_BLOCKED_ACK_DISPOSITION)[keyof typeof DAEMON_UPGRADE_BLOCKED_ACK_DISPOSITION];

export const DAEMON_UPGRADE_DELIVERY_STATUS = {
  SENT: 'sent',
  PENDING_OFFLINE: 'pending_offline',
  ALREADY_IN_PROGRESS: 'already_in_progress',
  BACKOFF: 'backoff',
  SUPPRESSED: 'suppressed',
  PENDING_PUBLICATION: 'pending_publication',
  PREPARING_RESCUE: 'preparing_rescue',
  INVALID_TARGET: 'invalid_target',
} as const;

export type DaemonUpgradeDeliveryStatus =
  (typeof DAEMON_UPGRADE_DELIVERY_STATUS)[keyof typeof DAEMON_UPGRADE_DELIVERY_STATUS];

const DAEMON_UPGRADE_TARGET_VERSION_RE = /^[0-9]+(?:\.[0-9]+){1,3}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

export function normalizeDaemonUpgradeTargetVersion(value: unknown): string {
  if (value == null || value === '') return DAEMON_UPGRADE_TARGET_LATEST;
  if (typeof value !== 'string') throw new Error('invalid_target_version');
  const targetVersion = value.trim();
  if (targetVersion === DAEMON_UPGRADE_TARGET_LATEST) return targetVersion;
  if (!DAEMON_UPGRADE_TARGET_VERSION_RE.test(targetVersion)) {
    throw new Error('invalid_target_version');
  }
  return targetVersion;
}

export function shouldSendDaemonUpgradeTargetVersion(targetVersion: string): boolean {
  return targetVersion !== DAEMON_UPGRADE_TARGET_LATEST;
}
