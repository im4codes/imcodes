export const DAEMON_MSG = {
  RECONNECTED: 'daemon.reconnected',
  DISCONNECTED: 'daemon.disconnected',
  UPGRADE_BLOCKED: 'daemon.upgrade_blocked',
} as const;

export type DaemonMessageType = (typeof DAEMON_MSG)[keyof typeof DAEMON_MSG];
