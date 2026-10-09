/**
 * Which MCP tools an agent may call while its CURRENT TURN was started by a shared-session PARTICIPANT (not the owner).
 *
 * A share lets a participant talk to one owner session; the agent that answers runs on the owner's machine with the owner's tools.
 * Machine operations already follow the participant's own access (shared-machine-authority). Every other tool acts through the owner's
 * account or daemon -- cron jobs that later run as the owner, the owner's aliases and pins, owner-wide memory writes and preferences,
 * restarting/closing/switching other sessions, installing MCP servers into every agent's config -- and none of that was part of the
 * share (the direct web surface already denies a participant `MEMORY_MUTATE`, stop, close ...). One table decides, so a new tool does
 * not become reachable from a participant turn by accident: an unlisted tool is DENIED.
 *
 * `allow` here means "not refused for being a participant turn"; the tool's own scoping still applies (project-bound memory reads,
 * Brain-only checks, the participant's own machine access for the machine tools, the exact-session binding of replies).
 */
import { ALIAS_MCP_TOOLS } from './alias-types.js';
import { CAPABILITY_MCP_TOOL } from './capability-management.js';
import { EXECUTION_POOL_MCP_TOOLS } from './execution-pool-mcp.js';
import { MCP_TOOL_DISCOVERY_NAME } from './mcp-tool-discovery.js';
import { MEMORY_MCP_TOOL_NAMES } from './memory-mcp-contracts.js';
import { MESSAGE_PIN_MCP_TOOLS } from './message-pins.js';

export const PARTICIPANT_TURN_TOOL_VERDICT = { ALLOW: 'allow', DENY: 'deny' } as const;
export type ParticipantTurnToolVerdict = typeof PARTICIPANT_TURN_TOOL_VERDICT[keyof typeof PARTICIPANT_TURN_TOOL_VERDICT];

/** Typed reason in the tool error, so an agent (and a test) can tell this refusal from any other. */
export const PARTICIPANT_TURN_TOOL_REFUSAL = 'participant_turn_not_permitted';

const { ALLOW, DENY } = PARTICIPANT_TURN_TOOL_VERDICT;
const N = MEMORY_MCP_TOOL_NAMES;

export const PARTICIPANT_TURN_TOOL_POLICY: Readonly<Record<string, ParticipantTurnToolVerdict>> = Object.freeze({
  // Project-scoped reads.
  [N.SEARCH_MEMORY]: ALLOW,
  [N.LIST_MEMORY_SUMMARIES]: ALLOW,
  [N.GET_MEMORY_SOURCES]: ALLOW,
  [N.MEMORY_INJECTION_GET]: ALLOW,
  [N.SESSION_RUNTIME_IDENTITY_GET]: ALLOW,
  [MCP_TOOL_DISCOVERY_NAME]: ALLOW,
  [CAPABILITY_MCP_TOOL.LIST]: ALLOW,
  [CAPABILITY_MCP_TOOL.STATUS]: ALLOW,
  // Agent-to-agent traffic: the participant context travels with the message (send-participant-context.ts), replies are bound to the exact session.
  [N.SEND_MESSAGE]: ALLOW,
  [N.SEND_LIST_TARGETS]: ALLOW,
  [N.DELEGATION_REPLY]: ALLOW,
  [N.PEER_AUDIT_REPLY]: ALLOW,
  [N.DESTROY_EXECUTION_CLONE]: ALLOW,
  // Work the session itself is assigned (bound to the exact pair role by the tool).
  [N.PAIR_LIST]: ALLOW,
  [N.PAIR_GET]: ALLOW,
  [N.PAIR_TASK_GET]: ALLOW,
  [N.PAIR_TASK_UPDATE]: ALLOW,
  [N.PAIR_TASK_CHECK]: ALLOW,
  [N.PAIR_RESOURCE_CLAIM]: ALLOW,
  [N.PAIR_VERDICT]: ALLOW,
  [N.PAIR_GET_MAX_CONCURRENCY]: ALLOW,
  // Machine tools authorise against the PARTICIPANT's own machine access themselves (shared-machine-authority).
  [N.LIST_MACHINES]: ALLOW,
  [N.EXEC_REMOTE]: ALLOW,
  [N.SEND_FILE_TO_MACHINE]: ALLOW,
  [N.FETCH_FILE_FROM_MACHINE]: ALLOW,
  [N.COMPUTER_USE_DOCS]: ALLOW,
  [N.COMPUTER_USE_CALL]: ALLOW,
  // Owner-level actions: refused.
  [N.ARCHIVE_MEMORY]: DENY,
  [N.RESTORE_MEMORY]: DENY,
  [N.DELETE_MEMORY]: DENY,
  [N.UPDATE_MEMORY]: DENY,
  [N.MEMORY_FEEDBACK]: DENY,
  [N.SAVE_OBSERVATION]: DENY,
  [N.SAVE_PREFERENCE]: DENY,
  [N.MEMORY_INJECTION_SET]: DENY,
  [N.SESSION_IDENTITY_GET]: DENY,
  [N.SESSION_IDENTITY_SET]: DENY,
  [N.SESSION_IDENTITY_CLEAR]: DENY,
  [N.SESSION_IDENTITY_REFRESH]: DENY,
  [N.VERIFICATION_MACHINE_LIST]: DENY,
  [N.VERIFICATION_MACHINE_SET]: DENY,
  [N.VERIFICATION_MACHINE_REMOVE]: DENY,
  [N.VERIFICATION_MACHINE_VERIFY]: DENY,
  [N.PAIR_CREATE]: DENY,
  [N.PAIR_DISPATCH]: DENY,
  [N.PAIR_CLOSE]: DENY,
  [N.PAIR_REASSIGN]: DENY,
  [N.PAIR_NEXT_ROUND]: DENY,
  [N.PAIR_SET_MAX_CONCURRENCY]: DENY,
  [N.PAIR_WORKSPACE_GC]: DENY,
  [N.SESSION_RESTART]: DENY,
  [N.SESSION_CLOSE]: DENY,
  [N.SESSION_MODEL]: DENY,
  [N.SEND_STOP]: DENY,
  [N.CRON_CREATE_SELF]: DENY,
  [N.CRON_UPDATE_SELF]: DENY,
  [N.CRON_CANCEL_SELF]: DENY,
  [N.CRON_CREATE]: DENY,
  [N.CRON_LIST]: DENY,
  [N.CRON_UPDATE]: DENY,
  [N.CRON_DELETE]: DENY,
  [N.SUPERVISION_TASK_START]: DENY,
  [N.SUPERVISION_TASK_UPDATE]: DENY,
  [N.SUPERVISION_TASK_FINISH]: DENY,
  [N.SUPERVISION_INTEGRATION_PREFLIGHT]: DENY,
  [N.SUPERVISION_INTEGRATION_FINALIZE]: DENY,
  [N.SUPERVISION_TASK_FILE_EVENT]: DENY,
  [CAPABILITY_MCP_TOOL.INSTALL]: DENY,
  [CAPABILITY_MCP_TOOL.MANAGE]: DENY,
  [ALIAS_MCP_TOOLS.RESOLVE]: DENY,
  [ALIAS_MCP_TOOLS.LIST]: DENY,
  [ALIAS_MCP_TOOLS.SAVE]: DENY,
  [ALIAS_MCP_TOOLS.DELETE]: DENY,
  [MESSAGE_PIN_MCP_TOOLS.LIST]: DENY,
  [MESSAGE_PIN_MCP_TOOLS.GET]: DENY,
  [MESSAGE_PIN_MCP_TOOLS.SAVE]: DENY,
  [MESSAGE_PIN_MCP_TOOLS.DELETE]: DENY,
  [EXECUTION_POOL_MCP_TOOLS.GET]: DENY,
  [EXECUTION_POOL_MCP_TOOLS.SET]: DENY,
});

/** Unlisted tools are refused: a tool added later is not reachable from a participant turn until someone classifies it. */
export function isToolAllowedInParticipantTurn(toolName: string): boolean {
  return PARTICIPANT_TURN_TOOL_POLICY[toolName] === ALLOW;
}
