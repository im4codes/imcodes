import { DAEMON_MSG } from '@shared/daemon-events.js';
import { MSG_DAEMON_ONLINE } from '@shared/ack-protocol.js';

/** State of the "daemon upgrading…" badge. `null` = not upgrading. */
export type DaemonUpgradingState = { targetVersion: string } | null;

/**
 * Pure reducer for the daemon-upgrade badge, given an incoming WS message type.
 *
 * - `DAEMON_MSG.UPGRADING` → begin/refresh the badge, carrying the target
 *   version (empty string when the daemon didn't supply a usable one).
 * - `MSG_DAEMON_ONLINE` / `DAEMON_MSG.RECONNECTED` → the (possibly upgraded)
 *   daemon is back, so clear the badge (`null`).
 * - anything else → `undefined`, meaning "not relevant, keep current state".
 *
 * Returning a discriminated `undefined` (vs `null`) lets the caller distinguish
 * "clear it" from "leave it alone" without re-listing the message types.
 */
export function nextDaemonUpgradingState(
  msgType: string,
  rawTargetVersion?: unknown,
): DaemonUpgradingState | undefined {
  if (msgType === DAEMON_MSG.UPGRADING) {
    return { targetVersion: typeof rawTargetVersion === 'string' ? rawTargetVersion : '' };
  }
  if (msgType === MSG_DAEMON_ONLINE || msgType === DAEMON_MSG.RECONNECTED) {
    return null;
  }
  return undefined;
}

/**
 * Human-facing label for the badge. Returns `''` when not upgrading so callers
 * can gate rendering on a falsy value. When a target version is known it reads
 * "Upgrading to vX…"; otherwise the generic "Upgrading…".
 */
export function daemonUpgradingLabel(
  state: DaemonUpgradingState,
  t: (key: string, opts?: Record<string, unknown>) => string,
  formatVersion: (v: string) => string,
): string {
  if (!state) return '';
  return state.targetVersion
    ? t('sidebar.daemon_upgrading_to', { version: formatVersion(state.targetVersion) })
    : t('sidebar.daemon_upgrading');
}
