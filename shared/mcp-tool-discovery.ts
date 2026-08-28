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
 * Only the genuinely heavy or rare surfaces stay lazy: controlled-machine exec,
 * file transfer, computer-use, capability management, message pins and execution
 * clones.
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
  // memory: the whole surface, not just reads. Recall, provenance and curation
  // are used constantly, and a half-lazy memory API is worse than none because
  // the model cannot tell which half it has.
  'search_memory',
  'save_observation',
  'save_preference',
  'list_memory_summaries',
  'get_memory_sources',
  'archive_memory',
  'restore_memory',
  'delete_memory',
  'update_memory',
  'memory_feedback',
  // aliases: tiny schemas, referenced inline in ordinary work
  'save_alias',
  'list_aliases',
  'resolve_alias',
  'delete_alias',
  // scheduling: self-wakeup drives loops; a hidden cron tool silently breaks them
  'cron_create_self',
  'cron_update_self',
  'cron_cancel_self',
  'cron_create',
  'cron_list',
  'cron_update',
  'cron_delete',
  // message pins: four tiny CRUD schemas, used inline like aliases
  'pin_message',
  'list_message_pins',
  'get_message_pin',
  'delete_message_pin',
  // identity
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
