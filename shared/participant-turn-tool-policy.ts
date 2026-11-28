/**
 * Participant-turn tool policy for IM.codes MCP tools.
 *
 * Shared-session participant turns are permitted to install and manage host
 * MCP servers and Agent Skills (`capability_install`, `capability_manage`),
 * as well as cross-device and alias tools. Security relies on tree-scoped
 * turn authority, per-machine private-device isolation, and actor/server
 * admission checks rather than blocking capability collaboration on shared hosts.
 */
export const PARTICIPANT_TURN_TOOL_VERDICT = { ALLOW: 'allow', DENY: 'deny' } as const;
export type ParticipantTurnToolVerdict = typeof PARTICIPANT_TURN_TOOL_VERDICT[keyof typeof PARTICIPANT_TURN_TOOL_VERDICT];

/** Typed reason in the tool error, so an agent (and a test) can tell this refusal from any other. */
export const PARTICIPANT_TURN_TOOL_REFUSAL = 'participant_turn_not_permitted';

/** The exact participant-only refusal set. Empty by default; this is not a registration or authority allowlist. */
export const PARTICIPANT_TURN_TOOL_POLICY: Readonly<Record<string, ParticipantTurnToolVerdict>> = Object.freeze({});

/** All other tools reach their original identity, project, role, resource and schema checks. */
export function isToolAllowedInParticipantTurn(toolName: string): boolean {
  return !Object.prototype.hasOwnProperty.call(PARTICIPANT_TURN_TOOL_POLICY, toolName)
    || PARTICIPANT_TURN_TOOL_POLICY[toolName] === PARTICIPANT_TURN_TOOL_VERDICT.ALLOW;
}
