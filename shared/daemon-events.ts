export const DAEMON_MSG = {
  RECONNECTED: 'daemon.reconnected',
  DISCONNECTED: 'daemon.disconnected',
  UPGRADE_BLOCKED: 'daemon.upgrade_blocked',
  // Emitted by the daemon right after it spawns the (detached) upgrade script,
  // just before the running process is killed & restarted. The server relays it
  // to browsers so the UI can show an "upgrading…" state next to the daemon
  // version instead of a bare disconnect. Cleared on the next reconnect/online.
  UPGRADING: 'daemon.upgrading',
  /** Controlled node → server: result of a MACHINE_EXEC request (RemoteExecResult). */
  MACHINE_EXEC_RESULT: 'machine.exec_result',
} as const;

export type DaemonMessageType = (typeof DAEMON_MSG)[keyof typeof DAEMON_MSG];
