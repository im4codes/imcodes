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
import { supervisionIdentityMatches } from '../../shared/supervision-participant-authority.js';
import type {
  SupervisionMcpToolDeps,
  SupervisionRegistryPort,
} from './supervision-mcp-tools.js';
import { resolvePeerAuditProviderFamily } from './peer-audit-candidates.js';
import { runSupervisionWorktreeGc } from './supervision-worktree-gc.js';
import { inspectSupervisionAssignmentWorktree } from './supervision-worktree-inspector.js';
import { advancePendingRepliesForReboundCoordinator } from './delegation-reply-ingress.js';

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
/**
 * The caller's exact live identity, or undefined when it cannot be established.
 *
 * Supervision authority is an identity, never a name: a replacement runtime
 * reuses the session name but is a different `sessionInstanceId`/`runtimeEpoch`
 * and inherits nothing. Callers that cannot be resolved fail closed.
 */
function liveCallerIdentity(callerSessionName: string | undefined) {
  const name = callerSessionName?.trim();
  if (!name) return undefined;
  const session = listSessions().find((candidate) => candidate.name === name);
  if (!session?.sessionInstanceId || !session.runtimeEpoch) return undefined;
  return {
    sessionName: session.name,
    sessionInstanceId: session.sessionInstanceId,
    runtimeEpoch: session.runtimeEpoch,
    agentType: session.agentType,
    providerFamily: resolvePeerAuditProviderFamily(session),
  };
}

export function createSupervisionRegistryPort(): SupervisionRegistryPort {
  return {
    getStatus: (taskId) => getSupervisionTaskRegistry().get(taskId)?.status,
    applyIntent: (input) => getSupervisionTaskRegistry().applyTaskIntent(input),
    finishAssignment: ({
      assignmentId, callerSessionName, callerProjectName, projectBrain,
      rebindIdentity, rebindProjectName,
    }) => {
      const registry = getSupervisionTaskRegistry();
      const assignment = registry.getAssignment(assignmentId);
      if (!assignment) return { ok: false, reason: 'not_found' };
      if (projectBrain && callerProjectName) {
        const callerIdentity = liveCallerIdentity(callerSessionName);
        if (!callerIdentity) return { ok: false, reason: 'owner_mismatch' };
        return registry.finishAssignmentAsProjectBrain({
          assignmentId,
          callerProjectName,
          callerIdentity,
          ...(rebindIdentity ? { rebindIdentity } : {}),
          ...(rebindProjectName ? { rebindProjectName } : {}),
        });
      }
      // The owner path must resolve the caller's LIVE identity and prove it is
      // the bound owner. Comparing sessionName and then handing the registry the
      // STORED identity made the registry's own exact check compare the stored
      // identity against itself -- vacuously true -- so a replacement runtime
      // reusing the name finished another instance's assignment.
      const callerIdentity = liveCallerIdentity(callerSessionName);
      if (!callerIdentity || !supervisionIdentityMatches(assignment.identity, callerIdentity)) {
        return { ok: false, reason: 'owner_mismatch' };
      }
      return registry.finishAssignment({
        assignmentId,
        identity: callerIdentity,
      });
    },
    list: (filter) => getSupervisionTaskRegistry().list(filter as never) as never,
    get: (taskId) => getSupervisionTaskRegistry().get(taskId) as never,
    recover: (input) => {
      return getSupervisionTaskRegistry().recoverTask(input);
    },
    cancelStaleAuditorAsProjectBrain: (input) => getSupervisionTaskRegistry().cancelStaleAuditorAsProjectBrain(input),
    rebindAuditAssignment: (input) => getSupervisionTaskRegistry().rebindAuditAssignment(input),
    rebindTaskAssignmentRevision: (input) => {
      const registry = getSupervisionTaskRegistry();
      const assignment = registry.getAssignment(input.assignmentId);
      if (!assignment || assignment.taskId !== input.taskId) return { ok: false, reason: 'not_found' };
      const inspected = inspectSupervisionAssignmentWorktree({
        sessionName: assignment.identity.sessionName,
        assignmentId: assignment.assignmentId,
      });
      if (!inspected.ok) return { ok: false, reason: inspected.reason };
      return registry.rebindTaskAssignmentRevision({ ...input, worktreeSnapshot: inspected.snapshot });
    },
    coordinateTaskAssignment: (input) => getSupervisionTaskRegistry().coordinateTaskAssignment(input),
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
    // Production wiring for the coordinator-rebind -> pending-return connection.
    advancePendingRepliesForReboundCoordinator: (input) => (
      advancePendingRepliesForReboundCoordinator(input)
    ),
    resolveSessionIdentity: (sessionName) => {
      const sessions = listSessions();
      const session = sessions.find((candidate) => candidate.name === sessionName);
      if (!session?.sessionInstanceId || !session.runtimeEpoch) return undefined;
      const projectName = resolveEffectiveProjectName(session, sessions);
      if (!projectName) return undefined;
      return {
        sessionName: session.name,
        sessionInstanceId: session.sessionInstanceId,
        runtimeEpoch: session.runtimeEpoch,
        agentType: session.agentType,
        providerFamily: resolvePeerAuditProviderFamily(session),
        projectName,
      };
    },
    worktreeGc: async (input) => runSupervisionWorktreeGc(input, {
      // Every lookup resolves the live singleton at call time. A closed or
      // replaced SQLite handle therefore fails closed rather than authorizing
      // deletion from a captured, stale snapshot.
      resolveRegistryReference: (metadata) => {
        try {
          const registry = getSupervisionTaskRegistry();
          const assignment = registry.getAssignment(metadata.assignmentId);
          const task = registry.get(metadata.taskId);
          if (!assignment || !task) return { available: true };
          return {
            available: true,
            assignment: {
              assignmentId: assignment.assignmentId,
              taskId: assignment.taskId,
              status: assignment.status,
              leaseId: assignment.leaseId,
            },
            task: {
              taskId: task.taskId,
              projectName: task.projectName,
              status: task.status,
              ...(task.archivedAt === undefined ? {} : { archivedAt: task.archivedAt }),
              assignments: task.assignments.map((candidate) => ({
                assignmentId: candidate.assignmentId,
                status: candidate.status,
                leaseId: candidate.leaseId,
              })),
            },
            claims: task.fileClaims.map((claim) => ({
              assignmentId: claim.assignmentId,
              path: claim.path,
            })),
          };
        } catch {
          return { available: false };
        }
      },
      // A live session cwd is a second, independent authority signal. Even a
      // corrupt terminal registry row cannot make the directory currently in
      // use by an agent eligible for deletion.
      protectedPaths: [process.cwd(), ...listSessions().map((session) => session.projectDir)],
    }),
    dispatchReadyAudit: async (taskId) => {
      const { dispatchReadyAudit } = await import('./send-tool.js');
      return dispatchReadyAudit(taskId);
    },
  };
}
