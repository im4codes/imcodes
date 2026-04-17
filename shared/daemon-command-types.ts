export const DAEMON_COMMAND_TYPES = {
  SESSION_UPDATE_TRANSPORT_CONFIG: 'session.update_transport_config',
  SUBSESSION_UPDATE_TRANSPORT_CONFIG: 'subsession.update_transport_config',
} as const;

export type DaemonCommandType =
  typeof DAEMON_COMMAND_TYPES[keyof typeof DAEMON_COMMAND_TYPES];
