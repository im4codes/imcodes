/**
 * Owner-only requests the server forwards to one machine's daemon to read or
 * change that machine's agent configuration (Agent Skills, MCP servers). The
 * transport failures are common to all of them.
 */
export const MACHINE_CONFIG_REQUEST_ERROR = {
  DAEMON_OFFLINE: 'daemon_offline',
  TIMEOUT: 'timeout',
} as const;
