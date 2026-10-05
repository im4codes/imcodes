import { DAEMON_MSG } from './daemon-events.js';
import { compareImcodesVersions, getReleaseChannel } from './imcodes-version.js';

export const DAEMON_UPGRADE_TARGET_LATEST = 'latest';

/**
 * Deployment-level opt-out for server-driven automatic upgrades. The image
 * must not set this value itself; an operator can still provide it explicitly
 * while manual and replayed upgrades remain available.
 */
export function isDaemonAutoUpgradeDisabledByEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.IMCODES_DISABLE_AUTO_UPGRADE === '1'
    || env.IMCODES_DISABLE_AUTO_UPGRADE === 'true';
}

/** Origin of a daemon upgrade command. Auto is retained only for legacy
 * controlled-node recovery; full daemons never receive it on reconnect. */
export const DAEMON_UPGRADE_SOURCE = {
  AUTO: 'auto',
  MANUAL: 'manual',
  REPLAY: 'replay',
} as const;

export type DaemonUpgradeSource = typeof DAEMON_UPGRADE_SOURCE[keyof typeof DAEMON_UPGRADE_SOURCE];

/**
 * Wire source of a received daemon.upgrade command. Servers older than the
 * manual-upgrade change send no source and only ever pushed automatic
 * upgrades, so a missing or unknown source is treated as auto: the daemon's
 * autoUpgrade:false / IMCODES_DISABLE_AUTO_UPGRADE opt-out must still hold
 * against them.
 */
export function resolveDaemonUpgradeSource(raw: unknown): DaemonUpgradeSource {
  return raw === DAEMON_UPGRADE_SOURCE.MANUAL || raw === DAEMON_UPGRADE_SOURCE.REPLAY || raw === DAEMON_UPGRADE_SOURCE.AUTO
    ? raw
    : DAEMON_UPGRADE_SOURCE.AUTO;
}

/**
 * Returns true when the daemon should show the operator an upgrade action.
 * Release-channel mismatches are actionable even when semver ordering says the
 * stable build is newer than the server's dev build: the server still
 * converges daemons to its own channel when the operator confirms.
 */
export function isDaemonUpgradeAvailable(
  current: string | null | undefined,
  latest: string | null | undefined,
): boolean {
  if (!current || !latest || current === latest) return false;
  if (getReleaseChannel(current) !== getReleaseChannel(latest)) return true;
  const compared = compareImcodesVersions(current, latest);
  return compared === null ? false : compared < 0;
}

export const DAEMON_UPGRADE_BLOCK_REASON = {
  ALREADY_IN_PROGRESS: 'already_in_progress',
  INSTALL_FAILED: 'install_failed',
  TRANSPORT_BUSY: 'transport_busy',
  SESSION_BUSY: 'session_busy',
  COOLDOWN_ACTIVE: 'cooldown_active',
  TOOLCHAIN_UNAVAILABLE: 'toolchain_unavailable',
} as const;

export const CONTROLLED_NODE_UPGRADE_STATUS = {
  CURRENT: 'current',
  AVAILABLE: 'available',
  DEFERRED: 'deferred',
  UPGRADING: 'upgrading',
  FAILED: 'failed',
} as const;

export type ControlledNodeUpgradeStatus =
  (typeof CONTROLLED_NODE_UPGRADE_STATUS)[keyof typeof CONTROLLED_NODE_UPGRADE_STATUS];

export function isRetryableDaemonUpgradeBlockReason(reason: string): boolean {
  return reason === DAEMON_UPGRADE_BLOCK_REASON.ALREADY_IN_PROGRESS
    || reason === DAEMON_UPGRADE_BLOCK_REASON.TRANSPORT_BUSY
    || reason === DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY
    || reason === DAEMON_UPGRADE_BLOCK_REASON.COOLDOWN_ACTIVE;
}

export interface ControlledNodeUpgradeBlockedMessage {
  [key: string]: unknown;
  type: typeof DAEMON_MSG.UPGRADE_BLOCKED;
  reason: string;
  targetVersion?: string;
}

/** CONTROLLED nodes expose only this exact, bounded upgrade-blocker envelope. */
export function validateControlledNodeUpgradeBlockedMessage(
  value: unknown,
): { ok: true; value: ControlledNodeUpgradeBlockedMessage } | { ok: false } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const record = value as Record<string, unknown>;
  if (record.type !== DAEMON_MSG.UPGRADE_BLOCKED) return { ok: false };
  if (typeof record.reason !== 'string' || record.reason.length < 1) return { ok: false };
  const keys = Object.keys(record);
  if (!keys.every((key) => key === 'type' || key === 'reason' || key === 'targetVersion')) return { ok: false };
  const targetVersion = typeof record.targetVersion === 'string' && DAEMON_UPGRADE_TARGET_VERSION_RE.test(record.targetVersion)
    ? record.targetVersion
    : undefined;
  if (record.targetVersion !== undefined && !targetVersion) return { ok: false };
  return {
    ok: true,
    value: { type: DAEMON_MSG.UPGRADE_BLOCKED, reason: record.reason.slice(0, 128), ...(targetVersion ? { targetVersion } : {}) },
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

/** Server-authoritative lifecycle states exposed to the controlled-node UI. */
export const DAEMON_UPGRADE_LIFECYCLE_STATUS = {
  PENDING_OFFLINE: 'pending_offline',
  PENDING_PUBLICATION: 'pending_publication',
  SENT: 'sent',
  TERMINAL_BLOCKED: 'terminal_blocked',
  SUPERSEDED: 'superseded',
} as const;
export type DaemonUpgradeLifecycleStatus = typeof DAEMON_UPGRADE_LIFECYCLE_STATUS[keyof typeof DAEMON_UPGRADE_LIFECYCLE_STATUS];

export interface DaemonUpgradeStatusSnapshot {
  upgradeId: string;
  targetVersion: string;
  source: DaemonUpgradeSource;
  status: DaemonUpgradeLifecycleStatus;
  createdAt: number;
  updatedAt: number;
  lastSentAt: number | null;
}

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
