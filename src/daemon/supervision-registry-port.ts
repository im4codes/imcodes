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
import { getSupervisionTaskRegistry, SUPERVISION_REVISION_AUTHORITATIVE_INTENTS } from './supervision-state-store.js';
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
import {
  freezeSupervisionIntegrationBundle,
  verifySupervisionIntegrationBundle,
} from './supervision-integration-bundle.js';
import { projectSupervisionSnapshotToAssignmentScope } from './supervision-integration-scope.js';
import { advancePendingRepliesForReboundCoordinator } from './delegation-reply-ingress.js';
import { setSupervisionLiveParticipantsResolver } from './supervision-state-store.js';
import { resolveLiveSupervisionParticipants } from './supervision-brain-authority.js';
import { getTransportQueueStore, type TransportQueueStore } from './transport-queue-store.js';
import {
  exactManualSupervisionExecutionBinding,
  isUniqueAuthoritativeProjectBrainCaller,
  resolveAutomaticAuditCrossVendorAvailability,
  resolveSelectedSupervisionExecutionBinding,
} from './send-tool.js';
import { autoStartAssignmentFromAck } from './assignment-auto-start.js';
import { SUPERVISION_ASSIGNMENT_START_EVIDENCE } from '../../shared/supervision-assignment-start.js';
import { getSessionRuntimeType } from '../../shared/agent-types.js';
import { resolveEffectiveSessionModel } from '../../shared/session-model.js';

export function retireExactSupersededAuditDelivery(
  store: Pick<TransportQueueStore, 'cancelQueuedMessage'>,
  input: {
    sessionName: string;
    messageId: string;
    recipient: { sessionInstanceId: string; runtimeEpoch: string };
  },
): boolean {
  return store.cancelQueuedMessage(
    input.sessionName,
    input.messageId,
    input.recipient,
  ).status === 'accepted';
}

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
  const caller = sessions.find((session) => session.name === scope.coordinatorSessionName);
  return isUniqueAuthoritativeProjectBrainCaller(caller, scope.projectName, sessions);
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
    startAssignmentFromAck: ({ taskId, assignmentId, callerSessionName, evidenceEventId, intent, expectedRevision }) => {
      const sessions = listSessions();
      const session = sessions.find((candidate) => candidate.name === callerSessionName);
      const callerIdentity = liveCallerIdentity(callerSessionName);
      const projectName = session ? resolveEffectiveProjectName(session, sessions) : undefined;
      // Converging onto a runtime needs a complete live identity to converge to.
      if (!callerIdentity?.sessionInstanceId || !callerIdentity.runtimeEpoch || !projectName) return { status: 'ignored' };
      const outcome = autoStartAssignmentFromAck({
        taskId,
        assignmentId,
        projectName,
        callerIdentity,
        evidence: SUPERVISION_ASSIGNMENT_START_EVIDENCE.ASSIGNMENT_ACK,
        evidenceEventId,
        // A revision-authoritative intent carries its revision into the start's
        // lock: when the registry would refuse that intent, nothing starts first.
        // An omitted revision is refused there too, never skipped.
        ...(intent && SUPERVISION_REVISION_AUTHORITATIVE_INTENTS.includes(intent)
          ? { expectedRevision: expectedRevision ?? '' }
          : {}),
      });
      if (outcome.status === 'refused') return { status: 'refused', refusal: outcome.refusal };
      if (outcome.status === 'revision_refused') return { status: 'revision_refused', reason: outcome.reason };
      return { status: outcome.status };
    },
    applyIntent: (input) => getSupervisionTaskRegistry().applyTaskIntent(input),
    finishAssignment: ({
      assignmentId, callerSessionName, callerProjectName, projectBrain,
      rebindIdentity, rebindProjectName, expectedRevision,
    }) => {
      // Caller revision authority is mandatory on every public FINISHED path;
      // the registry re-checks it against the locked rows before any write.
      if (typeof expectedRevision !== 'string' || !expectedRevision.trim()) {
        return { ok: false, reason: 'expected_revision_required' };
      }
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
          expectedRevision,
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
        expectedRevision,
      });
    },
    convergeValidatedAssignment: async ({ taskId, assignmentId }) => {
      const registry = getSupervisionTaskRegistry();
      const assignment = registry.getAssignment(assignmentId);
      const task = registry.getTaskRecord(taskId);
      if (!assignment || assignment.taskId !== taskId || !task) return { ok: false, reason: 'not_found' };
      const revision = assignment.auditRevision?.trim() || task.currentRevision?.trim();
      if (!revision || (assignment.auditRevision && assignment.auditRevision !== revision)
        || (task.currentRevision && task.currentRevision !== revision)) {
        return { ok: false, reason: 'old_revision' };
      }
      const validationAuthority = registry.readyAuditValidationAuthoritySnapshot({
        taskId, assignmentId, revision, allowLegacy: true,
      });
      if (!validationAuthority) return { ok: false, reason: 'stale_audit_revision' };
      // Without the task's base, `files` only ever reflects uncommitted
      // working-tree state: an implementer who committed before validation
      // (the required, documented workflow) has a clean tree relative to
      // their own HEAD, so freezing would see zero files no matter how large
      // the real change is -- the exact "authoritative immutable integration
      // bundle unavailable or mismatched" failure reproduced on tsk_t2f.
      const inspected = await inspectSupervisionAssignmentWorktree({
        sessionName: assignment.identity.sessionName,
        assignmentId: assignment.assignmentId,
        baseRevision: task.baseRevision,
      });
      if (!inspected.ok) return { ok: false, reason: inspected.reason };
      const projected = projectSupervisionSnapshotToAssignmentScope({
        snapshot: inspected.snapshot,
        scopeFiles: assignment.scopeFiles,
      });
      if (!projected.ok || projected.snapshot.stagedPaths.length > 0
        || projected.snapshot.conflictedPaths.length > 0) {
        return { ok: false, reason: projected.ok ? 'manifest_mismatch' : projected.reason };
      }
      const frozen = freezeSupervisionIntegrationBundle({
        taskId, assignmentId, revision,
        snapshot: projected.snapshot,
        scopeFiles: projected.scopeFiles,
      });
      if (!frozen.ok) return { ok: false, reason: frozen.reason };
      const verified = verifySupervisionIntegrationBundle(frozen.bundle);
      if (!verified.ok) return { ok: false, reason: verified.reason };
      const bound = registry.bindIntegrationBundle({
        taskId, assignmentId, identity: assignment.identity, revision, bundle: frozen.bundle,
        validationAuthority,
      });
      if (!bound.ok) return { ok: false, reason: bound.reason };
      return registry.convergeValidatedAssignment(assignmentId, Date.now(), async (candidate) => {
        const current = await inspectSupervisionAssignmentWorktree({
          sessionName: candidate.identity.sessionName,
          assignmentId: candidate.assignmentId,
          baseRevision: task.baseRevision,
        });
        return current.ok ? current.snapshot : undefined;
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
    rebindTaskAssignmentRevision: async (input) => {
      const registry = getSupervisionTaskRegistry();
      const assignment = registry.getAssignment(input.assignmentId);
      if (!assignment || assignment.taskId !== input.taskId) return { ok: false, reason: 'not_found' };
      const inspected = await inspectSupervisionAssignmentWorktree({
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
    retireSupersededAuditDelivery: ({ sessionName, messageId, recipient }) => {
      try {
        return retireExactSupersededAuditDelivery(
          getTransportQueueStore(),
          { sessionName, messageId, recipient },
        );
      } catch {
        return false;
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
        role: session.role,
      };
    },
    resolveAuditorRecoveryBinding: (sessionName) => {
      const sessions = listSessions();
      const session = sessions.find((candidate) => candidate.name === sessionName);
      if (!session) return undefined;
      const projectName = resolveEffectiveProjectName(session, sessions);
      return projectName
        ? resolveSelectedSupervisionExecutionBinding(projectName, sessions, session)
        : undefined;
    },
    // Same pool-scoped eligibility as automatic audit routing, so recovery and
    // routing can never disagree about whether a cross-vendor auditor exists.
    resolveAuditorRecoveryCrossVendorAvailability: (input) => (
      resolveAutomaticAuditCrossVendorAvailability(input)
    ),
    resolveManualExecutionBinding: (sessionName) => {
      const sessions = listSessions();
      const session = sessions.find((candidate) => candidate.name === sessionName);
      const projectName = session ? resolveEffectiveProjectName(session, sessions) : undefined;
      const model = resolveEffectiveSessionModel(session);
      if (!session || !projectName || session.state === 'stopped' || !session.sessionInstanceId
        || !session.runtimeEpoch || !model
        || (session.runtimeType ?? getSessionRuntimeType(session.agentType)) !== 'transport') return undefined;
      return exactManualSupervisionExecutionBinding({
        sessionName: session.name,
        sessionInstanceId: session.sessionInstanceId,
        runtimeEpoch: session.runtimeEpoch,
        agentType: session.agentType,
        providerFamily: resolvePeerAuditProviderFamily(session),
        runtimeType: 'transport',
        model,
        ...(session.ccPreset ? { ccPresetId: session.ccPreset } : {}),
      }, 'primary');
    },
    worktreeGc: async (input) => runSupervisionWorktreeGc(input, createSupervisionWorktreeGcDeps()),
    dispatchReadyAudit: async (taskId) => {
      const { dispatchReadyAudit } = await import('./send-tool.js');
      return dispatchReadyAudit(taskId);
    },
  };
}
