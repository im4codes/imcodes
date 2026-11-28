/**
 * Shared-session participant turns must not persist or mutate host-level capabilities
 * (MCP/Skill install or uninstall/manage, which would execute inside future owner turns).
 * Cross-device and alias tools remain governed by their authoritative actor/server
 * admission checks so participants can reach their own authorized test devices/aliases
 * without ever reaching unshared owner devices.
 */
export const PARTICIPANT_TURN_TOOL_VERDICT = { ALLOW: 'allow', DENY: 'deny' } as const;
export type ParticipantTurnToolVerdict = typeof PARTICIPANT_TURN_TOOL_VERDICT[keyof typeof PARTICIPANT_TURN_TOOL_VERDICT];

/** Typed reason in the tool error, so an agent (and a test) can tell this refusal from any other. */
export const PARTICIPANT_TURN_TOOL_REFUSAL = 'participant_turn_not_permitted';

/** The exact participant-only refusal set. This is not a registration or authority allowlist. */
export const PARTICIPANT_TURN_TOOL_POLICY: Readonly<Record<string, ParticipantTurnToolVerdict>> = Object.freeze({
  capability_install: PARTICIPANT_TURN_TOOL_VERDICT.DENY,
  capability_manage: PARTICIPANT_TURN_TOOL_VERDICT.DENY,
});

/** All other tools reach their original identity, project, role, resource and schema checks. */
export function isToolAllowedInParticipantTurn(toolName: string): boolean {
  return !Object.prototype.hasOwnProperty.call(PARTICIPANT_TURN_TOOL_POLICY, toolName)
    || PARTICIPANT_TURN_TOOL_POLICY[toolName] === PARTICIPANT_TURN_TOOL_VERDICT.ALLOW;
}
