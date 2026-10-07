/** Stable service identities shared by the controlled node and Server upgrade orchestration. */
export const CONTROLLED_NODE_SERVICE = {
  /** Windows Task Scheduler task name (full daemon uses `imcodes-daemon`). */
  WINDOWS_TASK: 'imcodes-node',
  /** Independent application-health watchdog; distinct from the process task. */
  WINDOWS_WATCHDOG_TASK: 'imcodes-node-watchdog',
  /** First-hop rescue task used while a legacy Windows upgrader replaces itself. */
  WINDOWS_LEGACY_UPGRADE_RESCUE_TASK: 'imcodes-node-upgrade-rescue',
  /** One-shot task that clears a legacy process's stale in-memory upgrade latch. */
  WINDOWS_LEGACY_UPGRADE_RESTART_TASK: 'imcodes-node-upgrade-restart',
  /** macOS LaunchDaemon label (full daemon uses `imcodes.daemon`). */
  MACOS_LABEL: 'cc.imcodes.node',
  /** Separate periodic authenticated-health supervisor for the macOS daemon. */
  MACOS_WATCHDOG_LABEL: 'cc.imcodes.node.watchdog',
  /** Linux systemd unit name. */
  LINUX_UNIT: 'imcodes-node.service',
} as const;

export const CONTROLLED_NODE_WINDOWS_INSTALL_DIR = 'imcodes-node' as const;
export const CONTROLLED_NODE_WINDOWS_LEGACY_UPGRADE_RESCUE_DIR = 'imcodes-node-upgrade-rescue' as const;
export const CONTROLLED_NODE_WINDOWS_UPGRADE_TASK_PREFIX = 'imcodes-node-upgrade-' as const;
/** Durable crash-recovery intent written beside the installed Windows executable. */
export const CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_FILE = 'upgrade-in-progress.json' as const;
export const CONTROLLED_NODE_WINDOWS_UPGRADE_TRANSACTION_VERSION = 2 as const;
export const CONTROLLED_NODE_WINDOWS_UPGRADE_PRODUCT = 'imcodes-controlled-node-upgrade' as const;
export const CONTROLLED_NODE_WINDOWS_UPGRADE_PREFLIGHT_FAILED = 'preflight_failed' as const;
export const CONTROLLED_NODE_WINDOWS_RELEASE_TRUST_PREFLIGHT_FAILURE =
  'remote desktop worker Authenticode verification failed' as const;
export const CONTROLLED_NODE_WINDOWS_RELEASE_SIGNER_ANCHOR_PREFLIGHT_FAILURE =
  'remote desktop worker signer is not trusted by this controlled node build' as const;
export const CONTROLLED_NODE_WINDOWS_RELEASE_MANIFEST_PREFLIGHT_FAILURE =
  'controlled node release manifest does not match the staged executable' as const;

/**
 * Authenticated-health window of a Windows self-upgrade. The new node is given
 * time in proportion to how it is actually starting, not a fixed 120 s that a
 * slow, loaded or antivirus-scanned machine can miss (a real node needed 119 s
 * of the old 120 s):
 *  - the window is measured from the moment the node process is first seen, not
 *    from `Start-ScheduledTask`;
 *  - it is at least `BASE_WINDOW_MS` from that moment, then extended for as long
 *    as the node process stays alive (it is still starting or connecting);
 *  - it never exceeds `HARD_CAP_MS`, and a node that never appears gives up after
 *    `SPAWN_ALLOWANCE_MS`; one that vanished after the floor for
 *    `ABSENT_POLLS_AFTER_FLOOR` polls in a row is not "starting", it is dead.
 * The server's own failure backoff (10m/30m/2h/6h) applies after a rollback.
 */
export const CONTROLLED_NODE_UPGRADE_HEALTH = {
  BASE_WINDOW_MS: 120_000,
  SPAWN_ALLOWANCE_MS: 180_000,
  HARD_CAP_MS: 15 * 60_000,
  POLL_MS: 2_000,
  ABSENT_POLLS_AFTER_FLOOR: 3,
} as const;

/** Durable outcome of the last Windows self-upgrade, written beside the executable. */
export const CONTROLLED_NODE_UPGRADE_RESULT_FILE = 'last-upgrade-result.json' as const;
export const CONTROLLED_NODE_UPGRADE_RESULT_STATUS = {
  /** An upgrade transaction began for `targetVersion` and has no outcome yet. */
  IN_PROGRESS: 'in_progress',
  SUCCESS: 'success',
  ROLLBACK_STARTED: 'rollback_started',
  ROLLED_BACK: 'rolled_back',
  ROLLBACK_FAILED: 'rollback_failed',
  /** The rollback script died before finishing; recorded by the node that found it. */
  ROLLBACK_INTERRUPTED: 'rollback_interrupted',
} as const;
export type ControlledNodeUpgradeResultStatus =
  (typeof CONTROLLED_NODE_UPGRADE_RESULT_STATUS)[keyof typeof CONTROLLED_NODE_UPGRADE_RESULT_STATUS];
/**
 * A `rollback_started` record that has not advanced for this long belongs to a
 * rollback script that is no longer running (a real rollback takes seconds).
 */
export const CONTROLLED_NODE_UPGRADE_ROLLBACK_STALL_MS = 10 * 60_000;

/**
 * The watchdog re-enables the node's own scheduled task when something outside
 * the product disabled it. Without this it restarted a Disabled task every two
 * minutes, silently failing each time, and the node stayed offline for hours.
 */
export const CONTROLLED_NODE_WATCHDOG_REENABLE_DISABLED_TASK = true as const;

/** New nodes advertise that their own self-upgrade script has backup/health rollback semantics. */
export const CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY = 'controlled-node.safe-self-upgrade.v2' as const;

export const CONTROLLED_NODE_UPGRADE_RESCUE_AUDIT_ACTION = {
  INTENT: 'controlled_node.upgrade_rescue.intent',
  RESULT: 'controlled_node.upgrade_rescue.result',
  RESTART_INTENT: 'controlled_node.upgrade_rescue.restart_intent',
  RESTART_RESULT: 'controlled_node.upgrade_rescue.restart_result',
} as const;
