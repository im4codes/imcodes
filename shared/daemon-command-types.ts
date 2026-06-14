export const DAEMON_COMMAND_TYPES = {
  DAEMON_UPGRADE: 'daemon.upgrade',
  SERVER_DELETE: 'server.delete',
  SESSION_CANCEL: 'session.cancel',
  SESSION_EXECUTION_CLONES: 'session.execution_clones',
  SESSION_UPDATE_TRANSPORT_CONFIG: 'session.update_transport_config',
  SUBSESSION_UPDATE_TRANSPORT_CONFIG: 'subsession.update_transport_config',
} as const;

export type DaemonCommandType =
  typeof DAEMON_COMMAND_TYPES[keyof typeof DAEMON_COMMAND_TYPES];
