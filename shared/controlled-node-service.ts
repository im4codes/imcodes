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
  /**
   * POSIX only: the service manager respawned the node this many times inside the
   * window without it ever publishing a lease. A node that keeps dying is not
   * "starting" however often a poll happens to catch it alive between restarts.
   */
  CRASH_LOOP_RESTARTS: 3,
} as const;

/**
 * Two different questions, two different signals:
 *  - "did this process get an authenticated acknowledgement from the server?" is the health LEASE
 *    (`health-lease.json`, written only on an authenticated heartbeat ack). A self-upgrade judges its new node by it:
 *    the new node must be connected and authenticated to count as installed.
 *  - "is this process alive and working, or wedged?" is the LIVENESS lease (`liveness-lease.json`) and, on Linux,
 *    the systemd watchdog pulse. They are renewed while the node's connection machinery is making progress -- an
 *    acknowledgement, OR a connection attempt / failure / scheduled retry. A server that cannot be reached is not a
 *    wedged node: restarting it (SIGABRT every WatchdogSec, killing the remote-desktop worker) cures nothing, so an
 *    outage must not look like a hang to the watchdog.
 */
export const CONTROLLED_NODE_LIVENESS_LEASE_FILE = 'liveness-lease.json' as const;
export const CONTROLLED_NODE_LIVENESS_WRITE_INTERVAL_MS = 15_000 as const;
/**
 * Connection activity (or an ack) must have been seen within this long for the liveness signals to be renewed. A
 * healthy node acks every 5 s and a node that cannot connect retries about every 25 s (20 s connect timeout + backoff
 * of at most 5 s); a node with neither is stuck. It is shorter than every watchdog threshold (180 s), so a stuck
 * node is still restarted no sooner than the threshold after its last renewal.
 */
export const CONTROLLED_NODE_LIVENESS_ACTIVITY_WINDOW_MS = 90_000 as const;
/** A node that has had no authenticated ack for this long says so in its log (at most once per repeat interval). */
/**
 * Backstop for a process that is stuck INSIDE its connection handling: a server that accepts the connection (so sockets keep
 * opening) but never acknowledges this node cannot be told from a server that is unreachable by connection activity alone. When
 * sockets have been opening for this long without a single authenticated ack, renewal stops and the platform watchdog restarts the
 * node. Each time that happens WITHOUT an ack in between, the next period doubles (45 min, 90 min, ... up to 12 h; the level is kept
 * in a small file because the restart is a new process), so a node that is permanently refused (a revoked credential) is restarted a
 * handful of times a day at most; the first authenticated ack resets it. A server that cannot be reached at all never opens a socket
 * and is never restarted.
 */
export const CONTROLLED_NODE_LIVENESS_UNACKED_OPEN_BACKSTOP_MS = 45 * 60_000;
export const CONTROLLED_NODE_LIVENESS_UNACKED_OPEN_BACKSTOP_MAX_MS = 12 * 60 * 60_000;
export const CONTROLLED_NODE_LIVENESS_BACKSTOP_STATE_FILE = 'liveness-backstop.json' as const;
/** The backstop period at a given level (0 = the first restart). */
export function controlledNodeLivenessBackstopMs(level: number): number {
  const safe = Number.isSafeInteger(level) && level > 0 ? Math.min(level, 20) : 0;
  return Math.min(CONTROLLED_NODE_LIVENESS_UNACKED_OPEN_BACKSTOP_MS * 2 ** safe, CONTROLLED_NODE_LIVENESS_UNACKED_OPEN_BACKSTOP_MAX_MS);
}
export const CONTROLLED_NODE_UNREACHABLE_WARN_AFTER_MS = 5 * 60_000;
export const CONTROLLED_NODE_UNREACHABLE_WARN_REPEAT_MS = 30 * 60_000;

/** The systemd `WatchdogSec` of the Linux unit (also the survival proof for a lease-less target). */
export const CONTROLLED_NODE_LINUX_WATCHDOG_SEC = 180 as const;
/**
 * A Linux node that predates the health lease still proves authentication: the unit
 * kills a node that sent no authenticated `WATCHDOG=1` for WatchdogSec, so one that
 * lived this long under the SAME pid was acknowledged by the server. A node that
 * publishes the liveness lease (CONTROLLED_NODE_LIVENESS_LEASE_FILE) feeds the
 * watchdog without being authenticated, so for it this proof does not exist: it
 * must publish the health lease.
 */
export const CONTROLLED_NODE_LINUX_WATCHDOG_SURVIVAL_MS = (CONTROLLED_NODE_LINUX_WATCHDOG_SEC + 30) * 1000;

/** Rollback image kept beside each replaced artifact until the new node is healthy. */
export const CONTROLLED_NODE_UPGRADE_BACKUP_SUFFIX = '.upgrade-old' as const;
/**
 * A POSIX upgrade script runs the whole health window plus a rollback, so the
 * transient unit that hosts it must outlive both (it was 10 minutes, shorter than
 * the 15-minute health cap).
 */
export const CONTROLLED_NODE_POSIX_UPGRADE_SCRIPT_TIMEOUT_MIN = 25 as const;
/** Time the transient unit gets to finish a rollback after systemd asks it to stop. */
export const CONTROLLED_NODE_POSIX_UPGRADE_SCRIPT_STOP_TIMEOUT_MIN = 5 as const;

/** Durable outcome of the last controlled-node self-upgrade, written beside the install journal. */
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
/**
 * The machine owner's explicit opt-out: a file with this name in the node's
 * install directory (beside the executable) makes the watchdog leave a Disabled
 * node task disabled. It logs `task_disabled_kept` once and does nothing else;
 * removing the file restores the default (re-enable).
 */
export const CONTROLLED_NODE_WATCHDOG_KEEP_DISABLED_MARKER = 'watchdog-keep-disabled' as const;

/** New nodes advertise that their own self-upgrade script has backup/health rollback semantics. */
export const CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY = 'controlled-node.safe-self-upgrade.v2' as const;

export const CONTROLLED_NODE_UPGRADE_RESCUE_AUDIT_ACTION = {
  INTENT: 'controlled_node.upgrade_rescue.intent',
  RESULT: 'controlled_node.upgrade_rescue.result',
  RESTART_INTENT: 'controlled_node.upgrade_rescue.restart_intent',
  RESTART_RESULT: 'controlled_node.upgrade_rescue.restart_result',
} as const;
