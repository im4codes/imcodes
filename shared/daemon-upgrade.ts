export const DAEMON_UPGRADE_TARGET_LATEST = 'latest';

export const DAEMON_UPGRADE_DELIVERY_STATUS = {
  SENT: 'sent',
  PENDING_OFFLINE: 'pending_offline',
  ALREADY_IN_PROGRESS: 'already_in_progress',
  BACKOFF: 'backoff',
  SUPPRESSED: 'suppressed',
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
