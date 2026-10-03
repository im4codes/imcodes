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
  /** Administrative same-object recovery; evidence-, lease-, and transition-checked. */
  RECOVER: 'supervision_task_recover',
  /** Bounded retention census/apply; apply is administrative and provenance-preserving. */
  HOUSEKEEPING: 'supervision_task_housekeeping',
} as const);
export const SUPERVISION_MCP_RETIRED_MESSAGE =
  'retired: use IMCODES_TASK pair markers, or plain send_message when pairs are not enabled' as const;
export type SupervisionMcpToolName = typeof SUPERVISION_MCP_TOOLS[keyof typeof SUPERVISION_MCP_TOOLS];

export const SUPERVISION_MCP_TOOL_NAME_LIST: readonly SupervisionMcpToolName[] = Object.freeze([
  SUPERVISION_MCP_TOOLS.INTENT,
  SUPERVISION_MCP_TOOLS.LIST,
  SUPERVISION_MCP_TOOLS.GET,
  SUPERVISION_MCP_TOOLS.RECOVER,
  SUPERVISION_MCP_TOOLS.HOUSEKEEPING,
]);

/**
 * Historical registration names retained for internal/test decoding. The live
 * server removes these entries before publishing its callable catalog.
 *
 * Keeping this compatibility list separate from the advertised catalog lets
 * stored task projections and migration tests decode old rows without making
 * the names model-callable again.
 */
export const SUPERVISION_MCP_REGISTERED_TOOLS: readonly SupervisionMcpToolName[] = Object.freeze([
  SUPERVISION_MCP_TOOLS.INTENT,
  SUPERVISION_MCP_TOOLS.LIST,
  SUPERVISION_MCP_TOOLS.GET,
  SUPERVISION_MCP_TOOLS.RECOVER,
  SUPERVISION_MCP_TOOLS.HOUSEKEEPING,
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

/**
 * Explicit caller revision authority for an object that has NO revision bound
 * yet (read-only review, zero-byte base bind, unbound slice). Revision-
 * authoritative intents (record_validation, finish) always require the caller
 * to state the revision it acted on; this value states "no revision was bound"
 * and is refused as soon as any real revision is bound to the task or owner.
 */
export const SUPERVISION_UNBOUND_REVISION = '(unbound)';
