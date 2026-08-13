/** Stable service identities shared by the controlled node and Server upgrade orchestration. */
export const CONTROLLED_NODE_SERVICE = {
  /** Windows Task Scheduler task name (full daemon uses `imcodes-daemon`). */
  WINDOWS_TASK: 'imcodes-node',
  /** Independent application-health watchdog; distinct from the process task. */
  WINDOWS_WATCHDOG_TASK: 'imcodes-node-watchdog',
  /** First-hop rescue task used while a legacy Windows upgrader replaces itself. */
  WINDOWS_LEGACY_UPGRADE_RESCUE_TASK: 'imcodes-node-upgrade-rescue',
  /** macOS LaunchDaemon label (full daemon uses `imcodes.daemon`). */
  MACOS_LABEL: 'cc.imcodes.node',
  /** Separate periodic authenticated-health supervisor for the macOS daemon. */
  MACOS_WATCHDOG_LABEL: 'cc.imcodes.node.watchdog',
  /** Linux systemd unit name. */
  LINUX_UNIT: 'imcodes-node.service',
} as const;

export const CONTROLLED_NODE_WINDOWS_INSTALL_DIR = 'imcodes-node' as const;
export const CONTROLLED_NODE_WINDOWS_LEGACY_UPGRADE_RESCUE_DIR = 'imcodes-node-upgrade-rescue' as const;

/** New nodes advertise that their own self-upgrade script has backup/health rollback semantics. */
export const CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY = 'controlled-node.safe-self-upgrade.v2' as const;

export const CONTROLLED_NODE_UPGRADE_RESCUE_AUDIT_ACTION = {
  INTENT: 'controlled_node.upgrade_rescue.intent',
  RESULT: 'controlled_node.upgrade_rescue.result',
} as const;
