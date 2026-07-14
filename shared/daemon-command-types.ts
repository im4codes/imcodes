export const DAEMON_COMMAND_TYPES = {
  DAEMON_UPGRADE: 'daemon.upgrade',
  SERVER_DELETE: 'server.delete',
  SESSION_CANCEL: 'session.cancel',
  SESSION_EXECUTION_CLONES: 'session.execution_clones',
  SESSION_UPDATE_TRANSPORT_CONFIG: 'session.update_transport_config',
  SUBSESSION_UPDATE_TRANSPORT_CONFIG: 'subsession.update_transport_config',
  /** Server → controlled node: run a one-shot command locally (RemoteExecRequest). */
  MACHINE_EXEC: 'machine.exec',
  /** Server → controlled node: invoke one typed Computer Use tool locally. */
  COMPUTER_USE: 'computer.use',
} as const;

export type DaemonCommandType =
  typeof DAEMON_COMMAND_TYPES[keyof typeof DAEMON_COMMAND_TYPES];
