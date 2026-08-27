/**
 * Supervision MCP tool names.
 *
 * Deliberately a separate module from shared/memory-mcp-contracts.ts: these
 * tools are exact server-backed registry operations, not fuzzy-memory contract
 * tools, so they sit outside that contract list and its schema firewall — the
 * same separation shared/message-pins.ts already uses.
 */
export const SUPERVISION_MCP_TOOLS = Object.freeze({
  /** The ONLY model-facing way to change task state. Never accepts a status. */
  INTENT: 'supervision_task_intent',
  LIST: 'supervision_task_list',
  GET: 'supervision_task_get',
  /** Administrative recovery; enum-restricted and transition-checked. */
  RECOVER: 'supervision_task_recover',
} as const);
export type SupervisionMcpToolName = typeof SUPERVISION_MCP_TOOLS[keyof typeof SUPERVISION_MCP_TOOLS];

export const SUPERVISION_MCP_TOOL_NAME_LIST: readonly SupervisionMcpToolName[] = Object.freeze([
  SUPERVISION_MCP_TOOLS.INTENT,
  SUPERVISION_MCP_TOOLS.LIST,
  SUPERVISION_MCP_TOOLS.GET,
  SUPERVISION_MCP_TOOLS.RECOVER,
]);

/**
 * Tools this module registers onto the live MCP server today.
 *
 * INTENT and RECOVER are absent from the legacy supervision family in
 * shared/memory-mcp-contracts.ts, so registering them here is additive and
 * cannot shadow an existing handler.
 */
export const SUPERVISION_MCP_REGISTERED_TOOLS: readonly SupervisionMcpToolName[] = Object.freeze([
  SUPERVISION_MCP_TOOLS.INTENT,
  SUPERVISION_MCP_TOOLS.LIST,
  SUPERVISION_MCP_TOOLS.GET,
  SUPERVISION_MCP_TOOLS.RECOVER,
]);

/**
 * Consolidated: the legacy supervision family no longer publishes these names,
 * so the audited handlers now own them. Kept as an empty, asserted-empty list
 * so a future re-introduction of a duplicate registration is caught by test
 * rather than by a server-construction crash in production.
 */
export const SUPERVISION_MCP_PENDING_CONSOLIDATION: readonly SupervisionMcpToolName[] = Object.freeze([]);

/**
 * Argument names a supervision tool must NEVER accept from a model.
 * `status` is the important one: lifecycle transitions are daemon-owned.
 */
export const SUPERVISION_MCP_FORBIDDEN_ARG_NAMES: readonly string[] = Object.freeze([
  'status', 'lifecycleStatus', 'toStatus', 'nextStatus', 'taskStatus',
]);
