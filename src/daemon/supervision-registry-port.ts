/**
 * Production binding between the supervision MCP tools and the real registry.
 *
 * This binding existed ONLY in tests. `createMemoryMcpServerFromEnv()`
 * constructed the server with three arguments, so the fourth
 * (`supervisionToolDeps`) fell back to `{}` and `deps.registry` was undefined in
 * every daemon process. The tools were registered and published on the MCP
 * surface, but every call answered `unavailable: supervision registry not
 * bound` -- a feature that looked present and was permanently inert.
 */
import { getSupervisionTaskRegistry } from './supervision-state-store.js';
import { listSessions, type SessionRecord } from '../store/session-store.js';
import { resolveEffectiveProjectName } from '../../shared/session-scope.js';
import type {
  SupervisionMcpToolDeps,
  SupervisionRegistryPort,
} from './supervision-mcp-tools.js';
import { resolvePeerAuditProviderFamily } from './peer-audit-candidates.js';

/**
 * One live-session authority check shared by the MCP project list and the Web
 * console subscription.  A caller-supplied project/session pair is never
 * authoritative on its own: the session must currently be the unparented Brain
 * whose effective project matches the requested project exactly.
 */
export function isAuthorizedSupervisionProjectBrain(
  scope: { projectName: string; coordinatorSessionName: string },
  sessions: readonly SessionRecord[],
): boolean {
  const coordinator = sessions.find((session) => session.name === scope.coordinatorSessionName);
  return Boolean(coordinator
    && coordinator.role === 'brain'
    && !coordinator.parentSession
    && resolveEffectiveProjectName(coordinator, sessions) === scope.projectName);
}

/**
 * Resolve the registry PER CALL, never once at construction.
 *
 * The registry is a lazily-opened singleton over a SQLite file. Capturing it in
 * a closure would pin whichever instance existed when the MCP server was built,
 * so a daemon restart (or any reset that reopens the database) would leave the
 * tools bound to a closed handle while still reporting themselves as bound --
 * strictly worse than the unbound error, because it fails silently. Looking it
 * up on each call means the tools always speak to the current binding.
 */
export function createSupervisionRegistryPort(): SupervisionRegistryPort {
  return {
    getStatus: (taskId) => getSupervisionTaskRegistry().get(taskId)?.status,
    applyIntent: (input) => getSupervisionTaskRegistry().applyTaskIntent(input),
    finishAssignment: ({ assignmentId, callerSessionName }) => {
      const registry = getSupervisionTaskRegistry();
      const assignment = registry.getAssignment(assignmentId);
      if (!assignment) return { ok: false, reason: 'not_found' };
      if (assignment.identity.sessionName !== callerSessionName) {
        return { ok: false, reason: 'owner_mismatch' };
      }
      return registry.finishAssignment({
        assignmentId,
        identity: assignment.identity,
      });
    },
    list: (filter) => getSupervisionTaskRegistry().list(filter as never) as never,
    get: (taskId) => getSupervisionTaskRegistry().get(taskId) as never,
    recover: (input) => {
      return getSupervisionTaskRegistry().recoverTask(input);
    },
    rebindAuditAssignment: (input) => getSupervisionTaskRegistry().rebindAuditAssignment(input),
    housekeeping: (input) => getSupervisionTaskRegistry().reconcileHousekeeping(input),
  };
}

export function createSupervisionMcpToolDeps(): SupervisionMcpToolDeps {
  return {
    registry: createSupervisionRegistryPort(),
    isProjectBrain: (caller) => {
      const sessionName = caller.sessionName?.trim();
      const projectName = caller.projectName?.trim();
      if (!sessionName || !projectName) return false;
      const sessions = listSessions();
      return isAuthorizedSupervisionProjectBrain({
        projectName,
        coordinatorSessionName: sessionName,
      }, sessions);
    },
    resolveSessionIdentity: (sessionName) => {
      const session = listSessions().find((candidate) => candidate.name === sessionName);
      if (!session?.sessionInstanceId || !session.runtimeEpoch) return undefined;
      return {
        sessionName: session.name,
        sessionInstanceId: session.sessionInstanceId,
        runtimeEpoch: session.runtimeEpoch,
        agentType: session.agentType,
        providerFamily: resolvePeerAuditProviderFamily(session),
      };
    },
  };
}
