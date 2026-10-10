/**
 * Only exec_remote is refused solely because a shared-session participant started the current turn.
 * Other registered tools retain their original authority checks; unknown names are still rejected by registration/discovery.
 * Participant provenance and private pair-field projections are independent of this execution restriction.
 */
import { MEMORY_MCP_TOOL_NAMES } from './memory-mcp-contracts.js';

export const PARTICIPANT_TURN_TOOL_VERDICT = { ALLOW: 'allow', DENY: 'deny' } as const;
export type ParticipantTurnToolVerdict = typeof PARTICIPANT_TURN_TOOL_VERDICT[keyof typeof PARTICIPANT_TURN_TOOL_VERDICT];

/** Typed reason in the tool error, so an agent (and a test) can tell this refusal from any other. */
export const PARTICIPANT_TURN_TOOL_REFUSAL = 'participant_turn_not_permitted';

const { ALLOW, DENY } = PARTICIPANT_TURN_TOOL_VERDICT;

/** The exact participant-only refusal set. This is not a registration or authority allowlist. */
export const PARTICIPANT_TURN_TOOL_POLICY: Readonly<Record<string, ParticipantTurnToolVerdict>> = Object.freeze({
  [MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE]: DENY,
});

/** All other tools reach their original identity, project, role, resource and schema checks. */
export function isToolAllowedInParticipantTurn(toolName: string): boolean {
  return !Object.hasOwn(PARTICIPANT_TURN_TOOL_POLICY, toolName) || PARTICIPANT_TURN_TOOL_POLICY[toolName] === ALLOW;
}
