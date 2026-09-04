import { listSessions, type SessionRecord } from '../store/session-store.js';
import { resolvePeerAuditProviderFamily } from './peer-audit-candidates.js';
import type { PersistedSupervisionTaskAssignmentIdentity } from './supervision-state-store.js';

/**
 * The daemon's CURRENT authoritative Brain identity for a project, read from the
 * live session registry.
 *
 * Defined once and shared by every production convergence call site: a stale
 * coordinator epoch is only ever repaired against this answer, never against a
 * caller-supplied guess. A restart rotates `runtimeEpoch`, which is exactly the
 * drift this exists to close, so the identity is returned in full (name,
 * instance, epoch, agent type, provider family) and the caller compares the
 * stable parts itself.
 *
 * Fail-closed by construction. It returns undefined unless EXACTLY ONE live,
 * non-stopped, top-level Brain owns the project, so a same-named clone, a
 * sub-session, or two competing Brains all yield no answer rather than a guess.
 * It never picks the first row of an ambiguous list and never matches on
 * project or session name alone.
 */
export function resolveAuthoritativeBrainIdentity(
  projectName: string | null | undefined,
  sessions: readonly SessionRecord[] = listSessions(),
): PersistedSupervisionTaskAssignmentIdentity | undefined {
  const project = projectName?.trim();
  if (!project) return undefined;
  const brains = sessions.filter((session) => (
    session.projectName === project
    && session.role === 'brain'
    // A sub-session can carry a brain-ish role but never owns project authority.
    && !session.parentSession
    && session.state !== 'stopped'
    && Boolean(session.sessionInstanceId)
    && Boolean(session.runtimeEpoch)
  ));
  if (brains.length !== 1) return undefined;
  const brain = brains[0]!;
  return {
    sessionName: brain.name,
    sessionInstanceId: brain.sessionInstanceId!,
    runtimeEpoch: brain.runtimeEpoch!,
    agentType: brain.agentType,
    providerFamily: resolvePeerAuditProviderFamily(brain),
  };
}

/**
 * Every live, non-stopped session in a project, as supervision identities.
 *
 * The registry's restart identity convergence needs to know which runtimes the
 * daemon can actually SEE, so a rotated instance/epoch is only ever accepted
 * against an observed runtime rather than a caller's claim. It was previously
 * supplied only by tests, which meant the production singleton had no resolver
 * at all and restart convergence silently never ran -- the R12 audit's P1.
 *
 * Deliberately unfiltered beyond liveness: the registry itself applies the
 * uniqueness and sessionName/agentType/providerFamily matching, and keeping
 * that decision in one place is what stops the rule drifting again.
 */
export function resolveLiveSupervisionParticipants(
  projectName: string | null | undefined,
  sessions: readonly SessionRecord[] = listSessions(),
): PersistedSupervisionTaskAssignmentIdentity[] {
  const project = projectName?.trim();
  if (!project) return [];
  return sessions
    .filter((session) => (
      session.projectName === project
      && session.state !== 'stopped'
      && Boolean(session.sessionInstanceId)
      && Boolean(session.runtimeEpoch)
    ))
    .map((session) => ({
      sessionName: session.name,
      sessionInstanceId: session.sessionInstanceId!,
      runtimeEpoch: session.runtimeEpoch!,
      agentType: session.agentType,
      providerFamily: resolvePeerAuditProviderFamily(session),
    }));
}
