/**
 * THE participant-authority boundary for supervision.
 *
 * Authority is an IDENTITY, never a name. A session name is a reusable handle:
 * a restarted Brain, a replacement window and a cloned session group can all
 * present the same `sessionName` while being different runtimes. Every gate that
 * decides "may this caller read / continue / finish / receive for this task"
 * must therefore compare the full persistent identity.
 *
 * This module exists because that comparison was previously restated at five
 * separate call sites (supervision-state-store, delegation-reply-store,
 * delegation-reply-ingress, peer-audit-reply-ingress, send-tool) and weakened to
 * a bare `sessionName` string membership at the task-visibility gate. One
 * definition, imported everywhere, is the only way those cannot drift apart
 * again.
 *
 * Fail-closed is deliberate: a missing or blank field is NOT a wildcard, it is
 * an unusable identity, and an unusable identity matches nothing.
 */

/** The five fields that together name one supervision runtime. */
export interface SupervisionPersistentIdentity {
  sessionName: string;
  sessionInstanceId: string;
  runtimeEpoch: string;
  agentType: string;
  providerFamily: string;
}

/** Anything carrying an identity: a registry assignment, a snapshot row. */
export interface SupervisionIdentityBearer {
  role?: string;
  identity?: Partial<SupervisionPersistentIdentity> | undefined;
}

const IDENTITY_FIELDS = [
  'sessionName', 'sessionInstanceId', 'runtimeEpoch', 'agentType', 'providerFamily',
] as const satisfies readonly (keyof SupervisionPersistentIdentity)[];

/**
 * Is this a usable identity? Every field must be a non-blank string.
 *
 * Callers use this to fail closed BEFORE comparing, so a half-built identity can
 * never be silently treated as "matches whatever is also half-built".
 */
export function isUsableSupervisionIdentity(
  value: Partial<SupervisionPersistentIdentity> | null | undefined,
): value is SupervisionPersistentIdentity {
  if (!value) return false;
  return IDENTITY_FIELDS.every((field) => {
    const candidate = value[field];
    return typeof candidate === 'string' && candidate.trim().length > 0;
  });
}

/**
 * Exact identity equality across all five fields.
 *
 * Two identities that agree on `sessionName` alone do NOT match: that is the
 * whole point. An unusable identity on either side matches nothing.
 */
export function supervisionIdentityMatches(
  left: Partial<SupervisionPersistentIdentity> | null | undefined,
  right: Partial<SupervisionPersistentIdentity> | null | undefined,
): boolean {
  if (!isUsableSupervisionIdentity(left) || !isUsableSupervisionIdentity(right)) return false;
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

/** Every assignment on the task bound to exactly this identity. */
export function supervisionParticipantAssignments<T extends SupervisionIdentityBearer>(
  assignments: readonly T[] | undefined,
  identity: Partial<SupervisionPersistentIdentity> | null | undefined,
): T[] {
  if (!Array.isArray(assignments) || !isUsableSupervisionIdentity(identity)) return [];
  return assignments.filter((assignment) => supervisionIdentityMatches(assignment?.identity, identity));
}

/**
 * Does this exact identity participate in the task?
 *
 * Read, continuation and finish gates all share this predicate, so a stale
 * instance, a clone, or a same-name/different-epoch runtime is refused
 * everywhere rather than at whichever entry point remembered to check.
 */
export function isSupervisionTaskParticipant(
  assignments: readonly SupervisionIdentityBearer[] | undefined,
  identity: Partial<SupervisionPersistentIdentity> | null | undefined,
): boolean {
  return supervisionParticipantAssignments(assignments, identity).length > 0;
}

/**
 * Is this exact identity the task's COORDINATOR?
 *
 * Dispatch authority lives on the coordinator assignment bound to the task, so
 * "some available Brain in the same project" is never an answer. Only an
 * explicit authorized rebind of that same assignment moves the identity.
 */
export function isSupervisionTaskCoordinator(
  assignments: readonly SupervisionIdentityBearer[] | undefined,
  identity: Partial<SupervisionPersistentIdentity> | null | undefined,
): boolean {
  return supervisionParticipantAssignments(assignments, identity)
    .some((assignment) => assignment.role === 'coordinator');
}
