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
import {
  SUPERVISION_WORKTREE_GC_DEFAULT_LIMIT,
  runSupervisionWorktreeGc,
  type SupervisionWorktreeGcDeps,
  type SupervisionWorktreeGcResult,
} from './supervision-worktree-gc.js';
import { inspectSupervisionAssignmentWorktree } from './supervision-worktree-inspector.js';
import { advancePendingRepliesForReboundCoordinator } from './delegation-reply-ingress.js';
import { setSupervisionLiveParticipantsResolver } from './supervision-state-store.js';
import { resolveLiveSupervisionParticipants } from './supervision-brain-authority.js';
import { getTransportQueueStore } from './transport-queue-store.js';

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
 * The caller's live durable session identity plus observational metadata.
 */
function liveCallerIdentity(callerSessionName: string | undefined) {
  const name = callerSessionName?.trim();
  if (!name) return undefined;
  const session = listSessions().find((candidate) => candidate.name === name);
  if (!session) return undefined;
  return {
    sessionName: session.name,
    sessionInstanceId: session.sessionInstanceId ?? '',
    runtimeEpoch: session.runtimeEpoch ?? '',
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
      const task = registry.getTaskRecord(assignment.taskId);
      if (!task || !callerProjectName || task.projectName !== callerProjectName) {
        return { ok: false, reason: 'owner_mismatch' };
      }
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
    convergeValidatedAssignment: ({ taskId, assignmentId }) => {
      const registry = getSupervisionTaskRegistry();
      const assignment = registry.getAssignment(assignmentId);
      if (!assignment || assignment.taskId !== taskId) return [];
      return registry.convergeValidatedAssignment(assignmentId, Date.now(), (candidate) => {
        const inspected = inspectSupervisionAssignmentWorktree({
          sessionName: candidate.identity.sessionName,
          assignmentId: candidate.assignmentId,
        });
        return inspected.ok ? inspected.snapshot : undefined;
      });
    },
    convergeExactReworkAssignment: ({ taskId, assignmentId }) => {
      const registry = getSupervisionTaskRegistry();
      const assignment = registry.getAssignment(assignmentId);
      if (!assignment || assignment.taskId !== taskId) return undefined;
      return registry.convergeExactReworkAssignment(assignmentId);
    },
    list: (filter) => getSupervisionTaskRegistry().list(filter as never) as never,
    get: (taskId) => getSupervisionTaskRegistry().get(taskId) as never,
    recover: (input) => {
      return getSupervisionTaskRegistry().recoverTask(input);
    },
    cancelStaleAuditorAsProjectBrain: (input) => getSupervisionTaskRegistry().cancelStaleAuditorAsProjectBrain(input),
    rebindAuditAssignment: (input) => getSupervisionTaskRegistry().rebindAuditAssignment(input),
    recoverOrphanedDelegatedAuditor: (input) => (
      getSupervisionTaskRegistry().recoverOrphanedDelegatedAuditor(input)
    ),
    rebindValidatedImplementerAssignment: (input) => getSupervisionTaskRegistry().rebindValidatedImplementerAssignment(input),
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
    resolveCompletionEvidence: (input) => (
      getSupervisionTaskRegistry().resolveCancelledCompletionEvidence(input)
    ),
    housekeeping: (input) => getSupervisionTaskRegistry().reconcileHousekeeping(input),
  };
}

function resolveWorktreeRegistryReference(assignmentId: string, expectedTaskId?: string) {
  try {
    const registry = getSupervisionTaskRegistry();
    const assignment = registry.getAssignment(assignmentId);
    if (!assignment || (expectedTaskId && assignment.taskId !== expectedTaskId)) return { available: true };
    const task = registry.get(assignment.taskId);
    if (!task) return { available: true };
    return {
      available: true,
      assignment: {
        assignmentId: assignment.assignmentId,
        taskId: assignment.taskId,
        status: assignment.status,
        leaseId: assignment.leaseId,
        role: assignment.role,
        ...(assignment.auditAttemptId ? { auditAttemptId: assignment.auditAttemptId } : {}),
        ...(assignment.auditRevision ? { auditRevision: assignment.auditRevision } : {}),
        ...(assignment.verdict ? { verdict: assignment.verdict } : {}),
      },
      task: {
        taskId: task.taskId,
        projectName: task.projectName,
        status: task.status,
        ...(task.archivedAt === undefined ? {} : { archivedAt: task.archivedAt }),
        ...(task.commitSha ? { commitSha: task.commitSha } : {}),
        ...(task.pushRemoteRef ? { pushRemoteRef: task.pushRemoteRef } : {}),
        ...(task.finalization ? { finalization: task.finalization } : {}),
        assignments: task.assignments.map((candidate) => ({
          assignmentId: candidate.assignmentId,
          status: candidate.status,
          leaseId: candidate.leaseId,
          role: candidate.role,
          ...(candidate.auditAttemptId ? { auditAttemptId: candidate.auditAttemptId } : {}),
          ...(candidate.auditRevision ? { auditRevision: candidate.auditRevision } : {}),
          ...(candidate.verdict ? { verdict: candidate.verdict } : {}),
        })),
      },
      claims: task.fileClaims.map((claim) => ({
        assignmentId: claim.assignmentId,
        path: claim.path,
      })),
      auditReceipts: (task.auditReceipts ?? []).map((receipt) => ({
        assignmentId: receipt.assignmentId,
        attemptId: receipt.attemptId,
        revision: receipt.revision,
        receiptKind: receipt.receiptKind,
        ...(receipt.verdict ? { verdict: receipt.verdict } : {}),
      })),
      completionEvidence: (task.completionEvidence ?? []).map((record) => ({
        sourceAssignmentId: record.sourceAssignmentId,
        status: record.status,
        ...(record.adoptedByAssignmentId ? { adoptedByAssignmentId: record.adoptedByAssignmentId } : {}),
        revision: record.revision,
        files: record.files,
      })),
    };
  } catch {
    return { available: false };
  }
}

export function createSupervisionWorktreeGcDeps(): SupervisionWorktreeGcDeps {
  return {
    resolveRegistryReference: (metadata) => (
      resolveWorktreeRegistryReference(metadata.assignmentId, metadata.taskId)
    ),
    resolveRegistryReferenceByAssignment: ({ assignmentId }) => (
      resolveWorktreeRegistryReference(assignmentId)
    ),
    protectedPaths: [process.cwd(), ...listSessions().map((session) => session.projectDir)],
  };
}

/** One restart-safe, cursor-persisted GC page scheduled by the daemon tick. */
export async function runScheduledSupervisionWorktreeGcBatch(
  now = Date.now(),
  options: {
    registry?: ReturnType<typeof getSupervisionTaskRegistry>;
    worktreesRoot?: string;
    deps?: SupervisionWorktreeGcDeps;
  } = {},
): Promise<SupervisionWorktreeGcResult | undefined> {
  if (process.env.VITEST && !options.worktreesRoot) return undefined;
  const registry = options.registry ?? getSupervisionTaskRegistry();
  const state = registry.nextWorktreeGcBatch(now);
  if (!state) return undefined;
  const result = await runSupervisionWorktreeGc({
    projectName: state.projectName,
    mode: 'apply',
    ...(options.worktreesRoot ? { worktreesRoot: options.worktreesRoot } : {}),
    ...(state.cursor ? { cursor: state.cursor } : {}),
    limit: SUPERVISION_WORKTREE_GC_DEFAULT_LIMIT,
  }, options.deps ?? createSupervisionWorktreeGcDeps());
  registry.recordWorktreeGcBatch({
    projectName: state.projectName,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    hasMore: result.hasMore,
    result: {
      scanned: result.scanned,
      deleted: result.deleted,
      retained: result.retained,
      releasedBytes: result.releasedBytes,
      entries: result.entries.map((entry) => ({
        assignmentId: entry.assignmentId,
        action: entry.action,
        reason: entry.reason,
      })),
    },
    now,
  });
  return result;
}

export function createSupervisionMcpToolDeps(): SupervisionMcpToolDeps {
  // `imcodes memory mcp` runs as its OWN process with its own module state, so
  // the registration done in lifecycle.startup() does not exist here. Without
  // this the process that actually serves the supervision tools had
  // resolveLiveParticipants undefined: restart identity convergence silently
  // never ran and a rotated same-name owner was refused with owner_mismatch in
  // production, while the startup-based test stayed green. Registering on the
  // construction path covers every MCP entry, and the resolver is read at call
  // time so it does not matter that the registry singleton may already exist.
  setSupervisionLiveParticipantsResolver(
    (projectName) => resolveLiveSupervisionParticipants(projectName),
  );
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
    retireSupersededAuditDelivery: ({ sessionName, messageId }) => {
      try {
        const store = getTransportQueueStore();
        const pending = store.readSnapshot(sessionName, 'orphaned_auditor_rebind_retire')
          .pendingMessageEntries.some((entry) => entry.clientMessageId === messageId);
        if (pending) store.markDeleted(sessionName, messageId);
      } catch {
        // The registry event is the durable supersession authority. Queue
        // cleanup is best-effort and the replacement target is independently
        // keyed, so a stale old-target row cannot authorize execution.
      }
    },
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
    worktreeGc: async (input) => runSupervisionWorktreeGc(input, createSupervisionWorktreeGcDeps()),
    dispatchReadyAudit: async (taskId) => {
      const { dispatchReadyAudit } = await import('./send-tool.js');
      return dispatchReadyAudit(taskId);
    },
  };
}
