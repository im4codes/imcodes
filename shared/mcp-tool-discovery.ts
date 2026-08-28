/** Protocol constants for the minimal MCP lazy-tool bootstrap surface. */
export const MCP_TOOL_DISCOVERY_NAME = 'mcp_tool_search' as const;

/**
 * MCP-server-local bootstrap guidance. The full capability routing policy is
 * already injected once by transport-runtime-assembly; repeating it here makes
 * clients prepend the same policy to every exposed tool.
 */
export const MCP_TOOL_DISCOVERY_SERVER_INSTRUCTIONS =
  'Core delegation, supervision-task and memory tools are listed by default. Use mcp_tool_search to activate any other tool by task or name; the server will publish the updated tool list.';


/**
 * Core tools stay listed and callable WITHOUT a discovery round-trip.
 *
 * Lazy-loading the whole catalog shrinks the default tool surface, but it also
 * makes multi-agent orchestration depend on every client remembering to search
 * first. Delegation, the supervision task registry, and basic memory are used on
 * essentially every turn, and a client that cached an older tool list or calls by
 * name would hit `Tool <name> disabled` instead. Those stay on; everything else
 * (cron, machines, file transfer, computer-use, capability, alias, message pins,
 * memory administration) is discovered on demand.
 */
export const MCP_TOOL_DISCOVERY_DEFAULT_ACTIVE: readonly string[] = Object.freeze([
  // delegation + audit receipts
  'send_message',
  'send_list_targets',
  'send_stop',
  'delegation_reply',
  'peer_audit_reply',
  // supervision task registry
  'supervision_task_start',
  'supervision_task_update',
  'supervision_task_finish',
  'supervision_task_list',
  'supervision_task_get',
  'supervision_task_intent',
  'supervision_task_file_event',
  // memory basics + identity
  'search_memory',
  'save_observation',
  'save_preference',
  'session_runtime_identity_get',
]);

export function isDefaultActiveMcpTool(name: string): boolean {
  return MCP_TOOL_DISCOVERY_DEFAULT_ACTIVE.includes(name);
}

export const MCP_TOOL_DISCOVERY_LIMITS = Object.freeze({
  QUERY_CHARS: 160,
  RESULTS: 24,
});

export const MCP_TOOL_DISCOVERY_STATUS = Object.freeze({
  OK: 'ok',
  ERROR: 'error',
});

export const MCP_TOOL_DISCOVERY_REASON = Object.freeze({
  VALIDATION_FAILED: 'validation_failed',
});
