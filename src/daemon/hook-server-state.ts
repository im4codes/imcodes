import { HOOK_SESSION_CREDENTIAL_HEADER } from '../../shared/hook-session-credential.js';

export const MEMORY_MCP_HTTP_PATH = '/mcp';

export const MEMORY_MCP_HTTP_HEADERS = {
  SESSION: 'x-imcodes-session',
  SESSION_INSTANCE_ID: 'x-imcodes-session-instance-id',
  SERVER_ID: 'x-imcodes-server-id',
  TOOL_CATALOG_MODE: 'x-imcodes-mcp-catalog-mode',
  HOOK_CREDENTIAL: HOOK_SESSION_CREDENTIAL_HEADER,
} as const;

const liveHookServerPorts = new Map<object, number>();

export function setLiveHookServerPort(server: object, port: number): void {
  liveHookServerPorts.set(server, port);
}

export function clearLiveHookServerPort(server: object): void {
  liveHookServerPorts.delete(server);
}

/**
 * Return the port of a currently listening hook server in this process, or
 * `null` when no hook server has bound cleanly yet (or all have closed).
 */
export function getActiveHookServerPort(): number | null {
  let latest: number | null = null;
  for (const port of liveHookServerPorts.values()) {
    latest = port;
  }
  return latest;
}
