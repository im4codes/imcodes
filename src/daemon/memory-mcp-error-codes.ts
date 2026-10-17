/**
 * Error codes returned by the daemon-side `/mcp/memory` RPC handler
 * (`hook-server.ts`) and interpreted by the stdio memory-MCP client
 * (`memory-mcp-server.ts`). Shared here so both sides match on the exact
 * string instead of duplicating a literal that could drift.
 */
export const DAEMON_MEMORY_WORKER_STALE_RUNTIME_ERROR = 'daemon_memory_worker_stale_runtime';
