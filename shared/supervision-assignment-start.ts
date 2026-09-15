/**
 * Automatic, idempotent start of a delegated supervision assignment.
 *
 * A formal IM.codes sub-session that received its task and is visibly
 * executing it must never stay projected as `delegated` because the model
 * forgot to call start/claim, and the Brain must never have to poll or remind
 * it. The daemon therefore performs the same delegated -> implementing edge
 * itself, from authoritative execution evidence only:
 *
 * - provider activity (tool call/result, assistant text/thinking) observed on
 *   the live runtime AFTER the task message was handed to that runtime;
 * - the recipient's own daemon-authenticated assignment ACK (a supervision
 *   intent naming its assignment);
 * - a controlled file event recorded for its assignment.
 *
 * Ordinary unrelated messages, provider-native collaboration agents, and
 * forged / stale-runtime / wrong-assignment evidence never start anything.
 */
import { MCP_ERROR_REASONS, type MCPErrorReason } from './memory-mcp-errors.js';

export const SUPERVISION_ASSIGNMENT_START_EVIDENCE = {
  PROVIDER_ACTIVITY: 'provider_activity',
  ASSIGNMENT_ACK: 'assignment_ack',
  FILE_EVENT: 'file_event',
} as const;
export type SupervisionAssignmentStartEvidence =
  typeof SUPERVISION_ASSIGNMENT_START_EVIDENCE[keyof typeof SUPERVISION_ASSIGNMENT_START_EVIDENCE];

/** Registry event source for the automatic delegated -> implementing edge. */
export const SUPERVISION_ASSIGNMENT_AUTO_START_SOURCE = 'assignment_auto_start' as const;

/**
 * How the task message is known to have reached the live runtime. Only these
 * proofs may converge a rotated runtime instance/epoch onto the assignment.
 */
export const SUPERVISION_ASSIGNMENT_DELIVERY_PROOF = {
  /** The live runtime is dispatching the task message in its current turn. */
  ACTIVE_DISPATCH: 'active_dispatch',
  /**
   * A durable delivery tombstone names the live runtime as the recipient and was
   * stamped with the provider conversation that runtime still holds.
   */
  DELIVERY_TOMBSTONE: 'delivery_tombstone',
  /** The recipient itself named the assignment through an authenticated call. */
  AUTHENTICATED_ACK: 'authenticated_ack',
} as const;
export type SupervisionAssignmentDeliveryProof =
  typeof SUPERVISION_ASSIGNMENT_DELIVERY_PROOF[keyof typeof SUPERVISION_ASSIGNMENT_DELIVERY_PROOF];

/**
 * Structured exact error for a delegated assignment whose first authoritative
 * execution evidence could not atomically start it. The assignment is held
 * fail-closed and the coordinating Brain must repair it in place.
 */
export const SUPERVISION_ASSIGNMENT_AUTO_START_REFUSED_ERROR =
  'assignment auto start refused: authoritative execution evidence could not atomically start the delegated assignment' as const;

/**
 * Is this exact error one refused automatic start (`<refused error>: <refusal>`)?
 * The single parser for the family, shared by the producer and every authority
 * edge that must recognize its report.
 */
export function isAssignmentStartRefusalError(exactError: unknown): exactError is string {
  return typeof exactError === 'string'
    && exactError.startsWith(`${SUPERVISION_ASSIGNMENT_AUTO_START_REFUSED_ERROR}: `);
}

/** Why an automatic start was refused. Stable wire values. */
export const SUPERVISION_ASSIGNMENT_START_REFUSALS = {
  /** The task message reached a runtime that is no longer the live one. */
  DELIVERED_TO_REPLACED_RUNTIME: 'delivered_to_replaced_runtime',
  /** The live runtime identity does not match the assignment and nothing proves delivery to it. */
  RUNTIME_IDENTITY_MISMATCH: 'runtime_identity_mismatch',
  /** The task revision moved while the assignment was still delegated. */
  REVISION_SUPERSEDED: 'revision_superseded',
  /** The registry could not record the start. */
  START_PERSISTENCE_FAILED: 'start_persistence_failed',
} as const;
export type SupervisionAssignmentStartRefusal =
  typeof SUPERVISION_ASSIGNMENT_START_REFUSALS[keyof typeof SUPERVISION_ASSIGNMENT_START_REFUSALS];

/** Hidden Brain timeline event: a dispatched assignment's live lifecycle status changed. */
export const SUPERVISION_ASSIGNMENT_STATUS_TIMELINE_EVENT = 'supervision.assignment.status' as const;

/** An assignment already held fail-closed by a blocker the Brain has not repaired. */
export const SUPERVISION_ASSIGNMENT_START_HELD = 'held_by_blocker' as const;

/**
 * The fail-closed answer an authenticated ACK receives when its delegated
 * assignment cannot start. Existing MCP reason vocabulary; the refusal code and
 * the required behavior travel in the detail.
 */
export function describeAssignmentStartRefusal(
  refusal: SupervisionAssignmentStartRefusal | typeof SUPERVISION_ASSIGNMENT_START_HELD,
): { reason: MCPErrorReason; detail: string } {
  const reason = refusal === SUPERVISION_ASSIGNMENT_START_REFUSALS.REVISION_SUPERSEDED
    ? MCP_ERROR_REASONS.REVISION_CONFLICT
    : refusal === SUPERVISION_ASSIGNMENT_START_REFUSALS.START_PERSISTENCE_FAILED
      ? MCP_ERROR_REASONS.INTERNAL_ERROR
      : refusal === SUPERVISION_ASSIGNMENT_START_HELD
        ? MCP_ERROR_REASONS.SCOPE_FORBIDDEN
        : MCP_ERROR_REASONS.IDENTITY_REJECTED;
  return {
    reason,
    detail: `${SUPERVISION_ASSIGNMENT_AUTO_START_REFUSED_ERROR}: ${refusal}. Stop work on this assignment; the daemon holds it fail-closed and reports the structured blocker to the Brain.`,
  };
}
