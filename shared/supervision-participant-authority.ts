/**
 * THE participant-authority boundary for supervision.
 *
 * Durable authority is exactly projectName + sessionName. Project scope is
 * enforced by the task/caller boundary; within that project, a daemon restart,
 * provider migration, or runtime replacement does not change the participant.
 *
 * This module exists because that comparison was previously restated at five
 * separate call sites (supervision-state-store, delegation-reply-store,
 * delegation-reply-ingress, peer-audit-reply-ingress, send-tool) and weakened to
 * a bare `sessionName` string membership at the task-visibility gate. One
 * definition, imported everywhere, is the only way those cannot drift apart
 * again.
 *
 * Runtime instance, epoch, agent type and provider family remain useful
 * observational/fencing metadata, but never decide visibility or ownership.
 */

/** Durable session name plus observational runtime metadata. */
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

/**
 * Is this a usable durable session identity? Project scope is checked by the
 * caller because assignments intentionally do not duplicate task.projectName.
 */
export function isUsableSupervisionIdentity(
  value: Partial<SupervisionPersistentIdentity> | null | undefined,
): value is SupervisionPersistentIdentity {
  return typeof value?.sessionName === 'string' && value.sessionName.trim().length > 0;
}

/**
 * Durable identity equality within an already-authorized project scope.
 */
export function supervisionIdentityMatches(
  left: Partial<SupervisionPersistentIdentity> | null | undefined,
  right: Partial<SupervisionPersistentIdentity> | null | undefined,
): boolean {
  if (!isUsableSupervisionIdentity(left) || !isUsableSupervisionIdentity(right)) return false;
  return left.sessionName === right.sessionName;
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
 * Does this durable session participate in the already project-scoped task?
 */
export function isSupervisionTaskParticipant(
  assignments: readonly SupervisionIdentityBearer[] | undefined,
  identity: Partial<SupervisionPersistentIdentity> | null | undefined,
): boolean {
  return supervisionParticipantAssignments(assignments, identity).length > 0;
}

/**
 * Is this durable session the task's COORDINATOR?
 *
 * Dispatch authority remains bound to the coordinator assignment; runtime
 * metadata rotation does not move that assignment to another logical session.
 */
export function isSupervisionTaskCoordinator(
  assignments: readonly SupervisionIdentityBearer[] | undefined,
  identity: Partial<SupervisionPersistentIdentity> | null | undefined,
): boolean {
  return supervisionParticipantAssignments(assignments, identity)
    .some((assignment) => assignment.role === 'coordinator');
}
