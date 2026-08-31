import { ALIAS_MCP_TOOLS } from './alias-types.js';
import { CAPABILITY_MCP_TOOL_NAMES } from './capability-management.js';
import { MEMORY_MCP_TOOL_NAMES } from './memory-mcp-contracts.js';
import { MESSAGE_PIN_MCP_TOOLS } from './message-pins.js';
import { SUPERVISION_MCP_TOOLS } from './supervision-mcp-tools.js';
export {
  MCP_TOOL_DISCOVERY_DESCRIPTION,
  MCP_TOOL_DISCOVERY_REFRESH_INSTRUCTIONS,
} from './mcp-tool-distribution.js';

/** Protocol constants for the minimal MCP lazy-tool bootstrap surface. */
export const MCP_TOOL_DISCOVERY_NAME = 'mcp_tool_search' as const;

/**
 * One model-visible routing hint, attached to the discovery tool only.
 *
 * Do not publish this as MCP server instructions: some hosts compose server
 * instructions into every exposed tool definition, multiplying the same text
 * by the bootstrap tool count on every request.
 */
export const MCP_TOOL_GROUP_QUERY_PREFIX = 'group:' as const;

export interface McpToolGroupDefinition {
  id: string;
  summary: string;
  tools: readonly string[];
}

/** Stable capability bundles. Search results expose only this bounded metadata. */
export const MCP_TOOL_GROUPS: readonly McpToolGroupDefinition[] = Object.freeze([
  Object.freeze({
    id: 'supervision',
    summary: 'Delegate work, report audits, and operate the supervised task lifecycle.',
    tools: Object.freeze([
      MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE, MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS,
      MEMORY_MCP_TOOL_NAMES.SEND_STOP, MEMORY_MCP_TOOL_NAMES.DELEGATION_REPLY,
      MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY, MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START,
      MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_UPDATE, MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH,
      MEMORY_MCP_TOOL_NAMES.SUPERVISION_INTEGRATION_FINALIZE,
      MEMORY_MCP_TOOL_NAMES.DESTROY_EXECUTION_CLONE,
      SUPERVISION_MCP_TOOLS.LIST, SUPERVISION_MCP_TOOLS.GET, SUPERVISION_MCP_TOOLS.INTENT,
      MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FILE_EVENT, SUPERVISION_MCP_TOOLS.RECOVER,
      SUPERVISION_MCP_TOOLS.HOUSEKEEPING,
    ]),
  }),
  Object.freeze({
    id: 'memory-curation',
    summary: 'Recall, inspect, curate, archive, restore, update, and give feedback on memory.',
    tools: Object.freeze([
      MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY, MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION,
      MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE, MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES,
      MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES, MEMORY_MCP_TOOL_NAMES.ARCHIVE_MEMORY,
      MEMORY_MCP_TOOL_NAMES.RESTORE_MEMORY, MEMORY_MCP_TOOL_NAMES.DELETE_MEMORY,
      MEMORY_MCP_TOOL_NAMES.UPDATE_MEMORY, MEMORY_MCP_TOOL_NAMES.MEMORY_FEEDBACK,
      MEMORY_MCP_TOOL_NAMES.SESSION_RUNTIME_IDENTITY_GET,
    ]),
  }),
  Object.freeze({
    id: 'scheduling',
    summary: 'Create, inspect, update, and cancel self-wake or targeted scheduled work.',
    tools: Object.freeze([
      MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF, MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF,
      MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF, MEMORY_MCP_TOOL_NAMES.CRON_CREATE,
      MEMORY_MCP_TOOL_NAMES.CRON_LIST, MEMORY_MCP_TOOL_NAMES.CRON_UPDATE,
      MEMORY_MCP_TOOL_NAMES.CRON_DELETE,
    ]),
  }),
  Object.freeze({
    id: 'aliases-pins',
    summary: 'Manage exact aliases and persistent message pins without fuzzy-memory lookup.',
    tools: Object.freeze([
      ALIAS_MCP_TOOLS.SAVE, ALIAS_MCP_TOOLS.LIST, ALIAS_MCP_TOOLS.RESOLVE, ALIAS_MCP_TOOLS.DELETE,
      MESSAGE_PIN_MCP_TOOLS.SAVE, MESSAGE_PIN_MCP_TOOLS.LIST,
      MESSAGE_PIN_MCP_TOOLS.GET, MESSAGE_PIN_MCP_TOOLS.DELETE,
    ]),
  }),
  Object.freeze({
    id: 'managed-machines',
    summary: 'List authorized managed machines and execute bounded remote commands.',
    tools: Object.freeze([MEMORY_MCP_TOOL_NAMES.LIST_MACHINES, MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE]),
  }),
  Object.freeze({
    id: 'file-transfer-computer-use',
    summary: 'Transfer explicit files and inspect or operate authorized remote computer-use sessions.',
    tools: Object.freeze([
      MEMORY_MCP_TOOL_NAMES.SEND_FILE_TO_MACHINE, MEMORY_MCP_TOOL_NAMES.FETCH_FILE_FROM_MACHINE,
      MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_DOCS, MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL,
    ]),
  }),
  Object.freeze({
    id: 'capability-management',
    summary: 'List, install, inspect, activate, update, disable, restore, or uninstall managed capabilities.',
    tools: Object.freeze([...CAPABILITY_MCP_TOOL_NAMES]),
  }),
]);


/**
 * Core tools stay listed and callable WITHOUT a discovery round-trip.
 *
 * The stable bootstrap is deliberately limited to the tools needed to discover
 * peers, report delegated/audit work, operate the supervision state machine, and
 * perform basic memory recall/recording/source expansion. Scheduling and exact
 * aliases are also core because agents rely on them across ordinary turns and
 * cached tool lists. Pins, machines, file transfer, computer use, capability
 * management and memory administration remain explicit-on-demand.
 */
export const MCP_TOOL_DISCOVERY_DEFAULT_ACTIVE: readonly string[] = Object.freeze([
  // delegation + audit receipts
  MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE,
  MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS,
  MEMORY_MCP_TOOL_NAMES.SEND_STOP,
  MEMORY_MCP_TOOL_NAMES.DELEGATION_REPLY,
  MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY,
  // supervision task registry
  MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START,
  MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_UPDATE,
  MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH,
  SUPERVISION_MCP_TOOLS.LIST,
  SUPERVISION_MCP_TOOLS.GET,
  SUPERVISION_MCP_TOOLS.INTENT,
  MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FILE_EVENT,
  // memory basics + identity
  MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY,
  MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION,
  MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE,
  MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
  MEMORY_MCP_TOOL_NAMES.SESSION_RUNTIME_IDENTITY_GET,
  // Scheduling must work from cached tool lists and before a discovery turn.
  MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF,
  MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF,
  MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF,
  MEMORY_MCP_TOOL_NAMES.CRON_CREATE,
  MEMORY_MCP_TOOL_NAMES.CRON_LIST,
  MEMORY_MCP_TOOL_NAMES.CRON_UPDATE,
  MEMORY_MCP_TOOL_NAMES.CRON_DELETE,
  // Exact aliases are a normal prompt/reference primitive, not administration.
  ALIAS_MCP_TOOLS.SAVE,
  ALIAS_MCP_TOOLS.LIST,
  ALIAS_MCP_TOOLS.RESOLVE,
  ALIAS_MCP_TOOLS.DELETE,
]);

export function isDefaultActiveMcpTool(name: string): boolean {
  return MCP_TOOL_DISCOVERY_DEFAULT_ACTIVE.includes(name);
}

export function getMcpToolGroupById(id: string): McpToolGroupDefinition | undefined {
  return MCP_TOOL_GROUPS.find((group) => group.id === id);
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
