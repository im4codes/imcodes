/**
 * Production MCP registration for the supervision registry.
 *
 * This is the module the audited state machine reaches production through. It
 * follows the established separate-module pattern (capability-mcp-tools,
 * message-pin-mcp-tools) and registers onto the same MCP server, so it needs no
 * edit to shared/memory-mcp-contracts.ts or src/daemon/memory-mcp-tools.ts.
 *
 * Every schema enum is spread from the SAME constant the state machine uses, so
 * the published tool surface cannot drift from the transition table.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SUPERVISION_MCP_TOOLS,
  SUPERVISION_MCP_REGISTERED_TOOLS,
  type SupervisionMcpToolName,
} from '../../shared/supervision-mcp-tools.js';
import {
  SUPERVISION_INTENTS,
  resolveSupervisionIntent,
  type SupervisionIntent,
} from './supervision-intent-ops.js';
import {
  SUPERVISION_TASK_RECOVERY_TARGET_STATUSES,
  SUPERVISION_BRAIN_COORDINATION_RECOVERY_STATUSES,
  SUPERVISION_RECOVERY_LEASE_ACTIONS,
  SUPERVISION_COMPLETION_EVIDENCE_DECISIONS,
  SUPERVISION_TASK_LIFECYCLE_STATUSES,
  isSupervisionTaskLifecycleStatus,
  type SupervisionTaskRecoveryTargetStatus,
  type SupervisionBrainCoordinationRecoveryStatus,
  type SupervisionRecoveryLeaseAction,
  type SupervisionCompletionEvidenceDecision,
  type SupervisionTaskLifecycleStatus,
} from '../../shared/supervision-config.js';
import { SUPERVISION_CONSOLE_VALIDATION_STATES } from '../../shared/supervision-task-console.js';
import {
  isSupervisionTaskParticipant,
  isSupervisionTaskCoordinator,
  supervisionIdentityMatches,
  type SupervisionPersistentIdentity,
} from '../../shared/supervision-participant-authority.js';
import type { McpRuntimeCaller } from './memory-mcp-caller.js';
import { advanceSupervisionTaskAfterFinish } from './supervision-convergence-wire.js';

type ToolResult = Record<string, unknown>;

/** @deprecated Import SupervisionTaskRecoveryTargetStatus from the shared contract. */
export type SupervisionRecoveryTargetStatus = SupervisionTaskRecoveryTargetStatus;

/** Recovery may not move a shipped terminal. Cancelled recovery is evidence-derived below. */
const RECOVERY_FORBIDDEN_SOURCES: readonly SupervisionTaskLifecycleStatus[] =
  Object.freeze(['finalized', 'pushed']);

/**
 * Minimal shape the visibility guards need. Mirrors the registry snapshot so no
 * conversion layer can quietly drop the participant list.
 */
export interface SupervisionVisibilityItem {
  taskId?: string;
  projectName?: string;
  classification?: string;
  status?: string;
  currentRevision?: string;
  assignments?: ReadonlyArray<{
    assignmentId?: string;
    role?: string;
    status?: string;
    leaseId?: string;
    auditAttemptId?: string;
    auditRevision?: string;
    verdict?: string;
    identity?: { sessionName?: string };
  }>;
}

/**
 * Who may see a task: any session holding an assignment on it.
 *
 * Absence of an assignment list is NOT read as "open to everyone" -- it yields
 * an empty participant set, so the caller is refused.
 */
/**
 * Participation is an IDENTITY, not a name.
 *
 * This previously mapped assignments to `identity.sessionName` and did a string
 * `.includes()`, so a stale instance, a cloned session group, or any same-name /
 * different-epoch runtime passed every visibility and continuation gate. An
 * unresolvable caller identity fails closed: no identity, no participation.
 */
export function supervisionCallerParticipates(
  item: SupervisionVisibilityItem | undefined,
  callerIdentity: Partial<SupervisionPersistentIdentity> | undefined,
): boolean {
  return isSupervisionTaskParticipant(item?.assignments as never, callerIdentity);
}

export type SupervisionOwnerScope =
  | { ok: true; ownerSessionName: string; source: 'target' | 'ownerSessionName' | 'caller_default' }
  | { ok: false; reason: 'conflicting_owner_filter' };

/**
 * Resolve the owner filter.
 *
 * `target` is the legacy published alias of `ownerSessionName`. If BOTH are
 * supplied they must agree: silently preferring one would let a caller believe
 * it filtered by the other. With neither, the scope defaults to the caller --
 * the same default the legacy handler used, so a caller never accidentally
 * enumerates the whole registry.
 */
export function resolveSupervisionOwnerScope(input: {
  target?: string;
  ownerSessionName?: string;
  callerSessionName: string;
}): SupervisionOwnerScope {
  const target = input.target?.trim() || undefined;
  const owner = input.ownerSessionName?.trim() || undefined;
  if (target && owner && target !== owner) return { ok: false, reason: 'conflicting_owner_filter' };
  if (owner) return { ok: true, ownerSessionName: owner, source: 'ownerSessionName' };
  if (target) return { ok: true, ownerSessionName: target, source: 'target' };
  return { ok: true, ownerSessionName: input.callerSessionName, source: 'caller_default' };
}

export interface SupervisionRegistryPort {
  getStatus(taskId: string): string | undefined;
  applyIntent(input: {
    taskId: string;
    assignmentId?: string;
    intent: SupervisionIntent;
    toStatus: SupervisionTaskLifecycleStatus | null;
    validationState?: string;
    note?: string;
  }): void | { ok: true; value?: unknown; replay?: boolean } | { ok: false; reason: string };
  finishAssignment?(input: {
    assignmentId: string;
    callerSessionName: string;
    callerProjectName?: string;
    projectBrain?: boolean;
    rebindIdentity?: {
      sessionName: string; sessionInstanceId: string; runtimeEpoch: string;
      agentType: string; providerFamily: string;
    };
    rebindProjectName?: string;
  }): { ok: true; value: unknown; replay?: boolean } | { ok: false; reason: string };
  convergeValidatedAssignment?(input: { taskId: string; assignmentId: string }): unknown;
  convergeExactReworkAssignment?(input: { taskId: string; assignmentId: string }): unknown;
  list(filter: {
    projectName?: string; status?: string; topLevelTaskId?: string; ownerSessionName?: string;
    includeArchived?: boolean; history?: boolean; cursor?: string; limit?: number;
  }): SupervisionVisibilityItem[];
  get(taskId: string): SupervisionVisibilityItem | undefined;
  recover(input: { taskId: string; toStatus: SupervisionRecoveryTargetStatus; reason: string }):
    | void
    | { ok: true; value?: { status?: string }; replay?: boolean }
    | { ok: false; reason: string };
  cancelStaleAuditorAsProjectBrain?(input: {
    taskId: string; auditorAssignmentId: string; callerProjectName: string; reason: string;
  }): { ok: true; value?: unknown } | { ok: false; reason: string };
  rebindAuditAssignment?(input: {
    taskId: string;
    assignmentId: string;
    identity: {
      sessionName: string; sessionInstanceId: string; runtimeEpoch: string;
      agentType: string; providerFamily: string;
    };
    callerProjectName: string;
    reason: string;
  }): { ok: true; value?: unknown; replay?: boolean } | { ok: false; reason: string };
  rebindTaskAssignmentRevision?(input: {
    taskId: string;
    assignmentId: string;
    fromRevision?: string;
    toRevision: string;
    ownedFiles?: string[];
    scopeFiles?: string[];
    leaseAction: SupervisionRecoveryLeaseAction;
    idempotencyKey: string;
    evidenceManifestSha256?: string;
    reason: string;
  }): { ok: true; value?: unknown; replay?: boolean } | { ok: false; reason: string };
  coordinateTaskAssignment?(input: {
    taskId: string;
    assignmentId: string;
    taskStatus?: SupervisionBrainCoordinationRecoveryStatus;
    assignmentStatus?: SupervisionBrainCoordinationRecoveryStatus;
    scopeFiles?: string[];
    leaseAction: SupervisionRecoveryLeaseAction;
    identity?: {
      sessionName: string; sessionInstanceId: string; runtimeEpoch: string;
      agentType: string; providerFamily: string;
    };
    idempotencyKey: string;
    reason: string;
  }): { ok: true; value?: unknown; replay?: boolean } | { ok: false; reason: string };
  resolveCompletionEvidence?(input: {
    taskId: string;
    evidenceId: string;
    targetAssignmentId: string;
    decision: SupervisionCompletionEvidenceDecision;
    reason: string;
  }): { ok: true; value?: unknown; replay?: boolean } | { ok: false; reason: string };
  housekeeping(input: { mode: 'dryRun' | 'apply'; projectName: string; cursor?: string; limit?: number }): unknown;
}

export interface SupervisionMcpToolDeps {
  /** Injected in tests; production supplies the real registry. */
  registry?: SupervisionRegistryPort;
  /** Fail-closed administrative gate for recover. */
  isAdmin?: (caller: McpRuntimeCaller) => boolean;
  /** Live daemon identity gate; caller fields alone never establish Brain authority. */
  isProjectBrain?: (caller: McpRuntimeCaller) => boolean;
  /** Connects an authorized coordinator rebind to the returns it owns. */
  advancePendingRepliesForReboundCoordinator?: (input: {
    taskId: string;
    coordinatorAssignmentId: string;
    origin: { sessionName: string; sessionInstanceId: string; runtimeEpoch: string };
  }) => number;
  resolveSessionIdentity?: (sessionName: string) => {
    sessionName: string; sessionInstanceId: string; runtimeEpoch: string;
    agentType: string; providerFamily: string; projectName: string;
  } | undefined;
  /** Physical worktree cleanup shares the already-authorized housekeeping ingress. */
  worktreeGc?: (input: {
    mode: 'dryRun' | 'apply'; projectName: string; cursor?: string; limit?: number;
  }) => Promise<unknown>;
  /** Post-commit automatic audit materialization. Errors never roll back the legal handoff. */
  dispatchReadyAudit?: (taskId: string) => Promise<unknown>;
}

function ok(value: ToolResult): ToolResult { return { status: 'ok', ...value }; }
function err(reason: string, detail?: string): ToolResult {
  return detail ? { status: 'error', reason, detail } : { status: 'error', reason };
}

/**
 * Published input schemas.
 *
 * The intent tool has NO status property at all — a model cannot express a
 * lifecycle string here even malformed, and `.strict()` rejects one smuggled in
 * as an extra key.
 */
export const SUPERVISION_MCP_TOOL_SHAPES = {
  [SUPERVISION_MCP_TOOLS.INTENT]: {
    intent: z.enum([...SUPERVISION_INTENTS] as [string, ...string[]]),
    taskId: z.string().min(1),
    assignmentId: z.string().min(1).optional(),
    rebindSessionName: z.string().min(1).optional(),
    validationState: z.enum([...SUPERVISION_CONSOLE_VALIDATION_STATES] as [string, ...string[]]).optional(),
    note: z.string().max(2000).optional(),
  },
  [SUPERVISION_MCP_TOOLS.LIST]: {
    status: z.enum([...SUPERVISION_TASK_LIFECYCLE_STATUSES] as [string, ...string[]]).optional(),
    topLevelTaskId: z.string().min(1).optional(),
    ownerSessionName: z.string().min(1).optional(),
    /** Legacy published alias of ownerSessionName; kept for compatibility. */
    target: z.string().min(1).optional(),
    includeArchived: z.boolean().optional(),
    history: z.boolean().optional(),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  [SUPERVISION_MCP_TOOLS.GET]: {
    taskId: z.string().min(1),
  },
  [SUPERVISION_MCP_TOOLS.RECOVER]: {
    taskId: z.string().min(1),
    toStatus: z.enum([...SUPERVISION_TASK_RECOVERY_TARGET_STATUSES]).optional(),
    assignmentId: z.string().min(1).optional(),
    rebindSessionName: z.string().min(1).optional(),
    fromRevision: z.string().min(1).optional(),
    toRevision: z.string().min(1).optional(),
    ownedFiles: z.unknown().optional(),
    evidenceManifestSha256: z.string().optional(),
    taskStatus: z.enum([...SUPERVISION_BRAIN_COORDINATION_RECOVERY_STATUSES]).optional(),
    assignmentStatus: z.enum([...SUPERVISION_BRAIN_COORDINATION_RECOVERY_STATUSES]).optional(),
    scopeFiles: z.unknown().optional(),
    leaseAction: z.enum([...SUPERVISION_RECOVERY_LEASE_ACTIONS]).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    reason: z.string().min(1).max(2000),
    completionEvidenceDecision: z.enum([...SUPERVISION_COMPLETION_EVIDENCE_DECISIONS]).optional(),
    evidenceId: z.string().min(1).optional(),
    targetAssignmentId: z.string().min(1).optional(),
  },
  [SUPERVISION_MCP_TOOLS.HOUSEKEEPING]: {
    mode: z.enum(['dryRun', 'apply']),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
} as const;

const DESCRIPTIONS: Record<SupervisionMcpToolName, string> = {
  // Kept terse on purpose: every byte here is published to every MCP client and
  // the shared tool surface is already over its size budget.
  [SUPERVISION_MCP_TOOLS.INTENT]: 'Advance a supervision task by intent; the daemon owns the status.',
  [SUPERVISION_MCP_TOOLS.LIST]: 'List project tasks for its Brain, otherwise tasks you participate in.',
  [SUPERVISION_MCP_TOOLS.GET]: 'Read a project task as its Brain, otherwise a task you participate in.',
  [SUPERVISION_MCP_TOOLS.RECOVER]: 'Restricted task recovery.',
  [SUPERVISION_MCP_TOOLS.HOUSEKEEPING]: 'Bounded task retention census or administrative apply; provenance is retained.',
};

export function createSupervisionMcpToolHandlers(
  caller: McpRuntimeCaller,
  deps: SupervisionMcpToolDeps = {},
): Record<SupervisionMcpToolName, (args?: unknown) => Promise<ToolResult>> {
  const registry = deps.registry;
  const isAdmin = deps.isAdmin ?? (() => false);
  const isProjectBrain = deps.isProjectBrain ?? (() => false);
  // Fail closed: no caller session means no default scope and no participation.
  const callerSession = typeof (caller as { sessionName?: unknown })?.sessionName === 'string'
    ? (caller as { sessionName: string }).sessionName
    : '';
  // The caller's LIVE identity, resolved from the daemon session store. Caller
  // fields alone never establish authority, and an unresolvable caller fails
  // closed at every participant gate below.
  const callerIdentity = (): SupervisionPersistentIdentity | undefined => (
    callerSession ? deps.resolveSessionIdentity?.(callerSession) : undefined
  );
  const need = (): SupervisionRegistryPort | undefined => registry;

  return {
    async [SUPERVISION_MCP_TOOLS.INTENT](args) {
      const input = (args ?? {}) as Record<string, unknown>;
      const reg = need();
      if (!reg) return err('unavailable', 'supervision registry not bound');
      const taskId = String(input.taskId ?? '');
      const task = reg.get(taskId);
      const requestedAssignmentId = input.assignmentId === undefined ? undefined : String(input.assignmentId);
      const intent = String(input.intent ?? '');
      const callerAssignments = (task?.assignments ?? []).filter(
        (assignment) => supervisionIdentityMatches(assignment.identity, callerIdentity()) && assignment.assignmentId,
      );
      const callerBoundAssignmentId = requestedAssignmentId
        ? callerAssignments.find((assignment) => assignment.assignmentId === requestedAssignmentId)?.assignmentId
        : callerAssignments.length === 1 ? callerAssignments[0]?.assignmentId : undefined;
      // Coordination authority is the task's OWN coordinator assignment, matched
      // on exact identity. "Any project Brain" let a second main-session Brain --
      // a cloned group, a replacement window -- drive assignments on a task it
      // never dispatched, which is the substitution this boundary forbids.
      const coordinatorMayAct = Boolean(
        requestedAssignmentId
        && task?.projectName
        && caller.projectName === task.projectName
        && isSupervisionTaskCoordinator(task.assignments as never, callerIdentity())
        && task.assignments?.some((assignment) => assignment.assignmentId === requestedAssignmentId),
      );
      const boundAssignmentId = callerBoundAssignmentId
        ?? (coordinatorMayAct ? requestedAssignmentId : undefined);
      if (requestedAssignmentId && !boundAssignmentId) {
        return err('identity_rejected', 'assignment is not visible to this caller');
      }
      const boundAssignment = boundAssignmentId
        ? task?.assignments?.find((assignment) => assignment.assignmentId === boundAssignmentId)
        : undefined;
      if (intent === 'open_audit' && task?.classification === 'integration_slice') {
        const historicalAudit = (task.assignments ?? []).some((assignment) => (
          assignment.role === 'auditor' && Boolean(assignment.auditAttemptId)
        ));
        if (!historicalAudit) {
          return err('role_forbidden', 'integration_slice cannot open an audit; merge validated slices first');
        }
      }
      // `cancel` is the one intent with both task- and assignment-scoped forms.
      // Only an explicit assignmentId selects the narrow form. Inferring the
      // caller's sole assignment here made a task-level cancel report success
      // while leaving the durable task row unchanged when that assignment was
      // already retired.
      const intentAssignmentId = intent === 'cancel' && !requestedAssignmentId
        ? undefined
        : boundAssignmentId;
      // `finish` is assignment-scoped. A matching structured audit may have
      // arrived while the durable task was still ready_for_audit (or a legacy
      // task/assignment pair was desynchronised), so applying the task-level
      // transition table first made the only valid terminal edge unreachable.
      // The registry verifies the exact audit revision/attempt and atomically
      // revokes this assignment's lease and claims.
      if (intent === 'finish' && boundAssignmentId && reg.finishAssignment) {
        if (input.status !== undefined) {
          return err('model_supplied_status', 'Lifecycle status is daemon-owned; send an intent instead.');
        }
        const rebindSessionName = input.rebindSessionName === undefined
          ? undefined : String(input.rebindSessionName).trim();
        if (rebindSessionName && !coordinatorMayAct) {
          return err('identity_rejected', "only the task's own coordinator may rebind a drifted implementation assignment");
        }
        const rebind = rebindSessionName ? deps.resolveSessionIdentity?.(rebindSessionName) : undefined;
        if (rebindSessionName && (!rebind || rebind.projectName !== task?.projectName)) {
          return err('identity_rejected', 'rebind target is not a live same-project session');
        }
        const finished = reg.finishAssignment({
          assignmentId: boundAssignmentId,
          callerSessionName: callerSession,
          ...(caller.projectName ? { callerProjectName: caller.projectName } : {}),
          ...(coordinatorMayAct ? { projectBrain: true } : {}),
          ...(rebind ? {
            rebindIdentity: {
              sessionName: rebind.sessionName,
              sessionInstanceId: rebind.sessionInstanceId,
              runtimeEpoch: rebind.runtimeEpoch,
              agentType: rebind.agentType,
              providerFamily: rebind.providerFamily,
            },
            rebindProjectName: rebind.projectName,
          } : {}),
        });
        if (!finished.ok) return err(finished.reason, `task finish rejected: ${finished.reason}`);
        // The finish that just committed is the EVENT that can leave this
        // aggregate ready for its next automatic step. Without this wire the
        // only thing carrying it forward was the 60s watchdog tick.
        await advanceSupervisionTaskAfterFinish(taskId, deps.dispatchReadyAudit);
        return ok({ intent: 'finish', fromStatus: task?.status ?? reg.getStatus(taskId), toStatus: (finished.value as { status?: unknown }).status ?? null, item: finished.value, idempotentReplay: finished.replay === true });
      }
      // Delegates to the audited pure state machine; the status-rejection and
      // transition table live there, not restated here.
      const outcome = resolveSupervisionIntent({
        request: {
          intent: String(input.intent ?? ''),
          taskId: String(input.taskId ?? ''),
          assignmentId: input.assignmentId === undefined ? undefined : String(input.assignmentId),
          validationState: input.validationState === undefined ? undefined : String(input.validationState),
          note: input.note === undefined ? undefined : String(input.note),
          status: input.status,
        },
        // Recovery after assignment-scoped cancellation must reuse the same
        // logical task. When the aggregate is already implementing, a leased
        // delegated replacement assignment still owns its own delegated ->
        // implementing edge; feeding the aggregate status into the pure state
        // machine incorrectly made both start and claim unreachable.
        // Assignment-scoped intents must be resolved against the assignment,
        // not the aggregate task.  A legitimate REWORK receipt can leave the
        // owner at `rework` while an older daemon still projects the task as
        // `ready_for_audit`; consulting the aggregate made both validation and
        // the subsequent audit handoff unreachable.  Task-only cancel remains
        // task-scoped because intentAssignmentId is deliberately absent above.
        currentStatus: intent !== 'cancel' && intentAssignmentId && boundAssignment
          ? boundAssignment.status
          : reg.getStatus(taskId),
      });
      if (!outcome.ok) return err(outcome.refusal ?? 'refused', outcome.detail);
      const applied = reg.applyIntent({
        taskId,
        ...(intentAssignmentId ? { assignmentId: intentAssignmentId } : {}),
        intent: outcome.intent!,
        toStatus: outcome.toStatus ?? null,
        validationState: outcome.validationState,
        note: input.note === undefined ? undefined : String(input.note),
      });
      if (applied && !applied.ok) return err(applied.reason, `task intent rejected: ${applied.reason}`);
      if (outcome.intent === 'record_validation' && outcome.validationState === 'passed'
        && intentAssignmentId) {
        // Validation is the event that makes FINISHED/open_audit uniquely
        // decidable. Converge the exact object immediately; the periodic tick
        // is only a restart backstop, never the primary production wire.
        reg.convergeValidatedAssignment?.({ taskId, assignmentId: intentAssignmentId });
        try {
          await deps.dispatchReadyAudit?.(taskId);
        } catch {
          // The validation and handoff commits remain authoritative. The
          // deterministic dispatcher records its own blocker and can replay.
        }
      }
      if (outcome.intent === 'open_audit') {
        try {
          await deps.dispatchReadyAudit?.(taskId);
        } catch {
          // The ready_for_audit commit is authoritative. The dispatcher owns
          // its durable blocker report and the one-shot boot sweep retries a
          // crash between this commit and materialization.
        }
      }
      return ok({
        intent: outcome.intent, fromStatus: outcome.fromStatus,
        toStatus: outcome.intent === 'record_validation' && outcome.validationState === 'passed'
          ? reg.getStatus(taskId) ?? outcome.toStatus ?? null
          : outcome.toStatus ?? null,
        validationState: outcome.validationState,
      });
    },

    async [SUPERVISION_MCP_TOOLS.LIST](args) {
      const input = (args ?? {}) as Record<string, unknown>;
      const reg = need();
      if (!reg) return err('unavailable', 'supervision registry not bound');
      const status = input.status === undefined ? undefined : String(input.status);
      // Fail closed even though zod already constrains it: a caller reaching the
      // handler directly must not be able to widen the filter.
      if (status !== undefined && !isSupervisionTaskLifecycleStatus(status)) {
        return err('invalid_status', 'status must be a fixed lifecycle id');
      }
      const includeArchived = input.includeArchived === true;
      const history = input.history === true;
      if (includeArchived && history) {
        return err('validation_failed', 'includeArchived and history are mutually exclusive');
      }
      const historyFilter = {
        ...(includeArchived ? { includeArchived: true } : {}),
        ...(history ? { history: true } : {}),
        ...(input.cursor === undefined ? {} : { cursor: String(input.cursor) }),
        ...(input.limit === undefined ? {} : { limit: Number(input.limit) }),
      };
      const projectName = caller.projectName?.trim() || '';
      if (projectName && isProjectBrain(caller)) {
        const explicitOwner = input.ownerSessionName === undefined
          ? input.target === undefined ? undefined : String(input.target)
          : String(input.ownerSessionName);
        if (input.target !== undefined && input.ownerSessionName !== undefined
          && String(input.target) !== String(input.ownerSessionName)) {
          return err('conflicting_owner_filter', 'target and ownerSessionName disagree');
        }
        const tasks = reg.list({
            projectName,
            status,
            topLevelTaskId: input.topLevelTaskId === undefined ? undefined : String(input.topLevelTaskId),
            ...(explicitOwner ? { ownerSessionName: explicitOwner } : {}),
            ...historyFilter,
          });
        return ok({
          tasks,
          count: tasks.length,
          ownerScope: 'project_brain',
        });
      }
      const scope = resolveSupervisionOwnerScope({
        target: input.target === undefined ? undefined : String(input.target),
        ownerSessionName: input.ownerSessionName === undefined ? undefined : String(input.ownerSessionName),
        callerSessionName: callerSession,
      });
      if (!scope.ok) return err(scope.reason, 'target and ownerSessionName disagree');
      const rows = reg.list({
        status,
        topLevelTaskId: input.topLevelTaskId === undefined ? undefined : String(input.topLevelTaskId),
        ownerSessionName: scope.ownerSessionName,
        ...historyFilter,
      });
      // Post-filter: an explicit owner filter must never widen visibility beyond
      // the tasks this caller actually participates in.
      const identity = callerIdentity();
      const tasks = rows.filter((row) => supervisionCallerParticipates(row, identity));
      return ok({
        tasks,
        count: tasks.length,
        ownerScope: scope.source,
      });
    },

    async [SUPERVISION_MCP_TOOLS.GET](args) {
      const input = (args ?? {}) as Record<string, unknown>;
      const reg = need();
      if (!reg) return err('unavailable', 'supervision registry not bound');
      const task = reg.get(String(input.taskId ?? ''));
      // Deliberately the SAME refusal for "does not exist" and "exists but you
      // are not a participant". Distinguishing them would turn this tool into an
      // existence oracle for other coordinators' task ids.
      const taskProjectName = typeof (task as { projectName?: unknown } | undefined)?.projectName === 'string'
        ? String((task as { projectName: string }).projectName)
        : '';
      const brainMayRead = Boolean(task && caller.projectName && isProjectBrain(caller)
        && taskProjectName === caller.projectName);
      if (!task || (!brainMayRead && !supervisionCallerParticipates(task, callerIdentity()))) {
        return err('identity_rejected', 'task is not visible to this caller');
      }
      return ok({ task });
    },

    async [SUPERVISION_MCP_TOOLS.RECOVER](args) {
      const input = (args ?? {}) as Record<string, unknown>;
      const reg = need();
      if (!reg) return err('unavailable', 'supervision registry not bound');
      const assignmentId = String(input.assignmentId ?? '').trim();
      const rebindSessionName = String(input.rebindSessionName ?? '').trim();
      const fromRevision = String(input.fromRevision ?? '').trim();
      const toRevision = String(input.toRevision ?? '').trim();
      const ownedFiles = Array.isArray(input.ownedFiles)
        ? input.ownedFiles.map((path) => String(path))
        : [];
      const evidenceManifestSha256 = String(input.evidenceManifestSha256 ?? '').trim();
      const taskStatus = String(input.taskStatus ?? '').trim();
      const assignmentStatus = String(input.assignmentStatus ?? '').trim();
      const scopeFiles = Array.isArray(input.scopeFiles)
        ? input.scopeFiles.map((path) => String(path))
        : [];
      const leaseAction = String(input.leaseAction ?? '').trim();
      const idempotencyKey = String(input.idempotencyKey ?? '').trim();
      const reason = String(input.reason ?? '').trim();
      const taskId = String(input.taskId ?? '');
      const completionEvidenceDecision = String(input.completionEvidenceDecision ?? '').trim();
      if (completionEvidenceDecision) {
        const evidenceId = String(input.evidenceId ?? '').trim();
        const targetAssignmentId = String(input.targetAssignmentId ?? '').trim();
        if (!SUPERVISION_COMPLETION_EVIDENCE_DECISIONS.includes(
          completionEvidenceDecision as SupervisionCompletionEvidenceDecision,
        ) || !evidenceId || !targetAssignmentId || !reason
          || assignmentId || rebindSessionName || fromRevision || toRevision
          || taskStatus || assignmentStatus || scopeFiles.length > 0 || leaseAction
          || idempotencyKey || input.toStatus !== undefined) {
          return err('validation_failed', 'completion evidence resolution requires only taskId, evidenceId, targetAssignmentId, completionEvidenceDecision and reason');
        }
        const task = reg.get(taskId);
        const taskProjectName = typeof task?.projectName === 'string' ? task.projectName : '';
        const authorized = isAdmin(caller) || Boolean(
          caller.projectName && caller.projectName === taskProjectName && isProjectBrain(caller),
        );
        if (!task || !authorized) return err('forbidden', 'completion evidence resolution requires the authoritative project Brain or administrator');
        const resolved = reg.resolveCompletionEvidence?.({
          taskId, evidenceId, targetAssignmentId,
          decision: completionEvidenceDecision as SupervisionCompletionEvidenceDecision,
          reason,
        });
        if (!resolved) return err('unavailable', 'completion evidence resolution is not bound');
        if (!resolved.ok) return err(resolved.reason, `completion evidence resolution rejected: ${resolved.reason}`);
        return ok({ taskId, evidenceId, targetAssignmentId, decision: completionEvidenceDecision, replay: resolved.replay === true });
      }
      const revisionRecoveryRequested = Boolean(fromRevision || toRevision);
      if (revisionRecoveryRequested) {
        const compatibleProjectionStatus = (value: unknown) => (
          value === undefined || String(value).trim() === 'rework'
        );
        if (!assignmentId || !toRevision
          || !reason || !idempotencyKey
          || !SUPERVISION_RECOVERY_LEASE_ACTIONS.includes(leaseAction as SupervisionRecoveryLeaseAction)
          || rebindSessionName
          || !compatibleProjectionStatus(input.taskStatus)
          || !compatibleProjectionStatus(input.assignmentStatus)
          || !compatibleProjectionStatus(input.toStatus)) {
          return err('validation_failed', 'revision recovery requires assignmentId, toRevision, leaseAction, idempotencyKey and reason; fromRevision/ownedFiles/scopeFiles/evidenceManifestSha256 are optional metadata');
        }
        const task = reg.get(taskId);
        const taskProjectName = typeof task?.projectName === 'string' ? task.projectName : '';
        const authorized = isAdmin(caller) || Boolean(
          caller.projectName && caller.projectName === taskProjectName && isProjectBrain(caller),
        );
        if (!task || !authorized) {
          return err('forbidden', 'revision recovery requires the authoritative project Brain or administrator');
        }
        const beforeAssignment = task.assignments?.find((candidate) => candidate.assignmentId === assignmentId);
        const alreadyRepaired = task.status === 'rework'
          && task.currentRevision === toRevision
          && beforeAssignment?.status === 'rework'
          && Boolean(beforeAssignment.leaseId)
          && beforeAssignment.auditRevision === toRevision
          && beforeAssignment.verdict?.trim().toUpperCase() === 'REWORK';
        // An exact REWORK receipt is stronger than caller-supplied recovery
        // metadata. Repair the same implementation object first; if it closes
        // the split there is no revision rebind left to perform.
        const converged = reg.convergeExactReworkAssignment?.({ taskId, assignmentId });
        const after = reg.get(taskId);
        const repaired = after?.status === 'rework' && after.assignments?.some((candidate) => (
          candidate.assignmentId === assignmentId && candidate.status === 'rework'
        ));
        if (converged && repaired) {
          return ok({
            taskId, assignmentId, toRevision,
            replay: alreadyRepaired,
            converged: 'exact_rework_receipt',
          });
        }
        const rebound = reg.rebindTaskAssignmentRevision?.({
          taskId, assignmentId,
          ...(fromRevision ? { fromRevision } : {}),
          toRevision,
          ...(Array.isArray(input.ownedFiles) ? { ownedFiles } : {}),
          ...(Array.isArray(input.scopeFiles) ? { scopeFiles } : {}),
          leaseAction: leaseAction as SupervisionRecoveryLeaseAction,
          idempotencyKey,
          ...(typeof input.evidenceManifestSha256 === 'string' ? { evidenceManifestSha256 } : {}),
          reason,
        });
        if (!rebound) return err('unavailable', 'revision recovery is not bound');
        if (!rebound.ok) return err(rebound.reason, `revision recovery rejected: ${rebound.reason}`);
        return ok({ taskId, assignmentId, ...(fromRevision ? { fromRevision } : {}), toRevision, replay: rebound.replay === true });
      }
      const coordinationOverrideRequested = Boolean(
        taskStatus || assignmentStatus || scopeFiles.length > 0 || leaseAction || idempotencyKey,
      );
      if (coordinationOverrideRequested) {
        if (!assignmentId || !reason || !idempotencyKey
          || !SUPERVISION_RECOVERY_LEASE_ACTIONS.includes(leaseAction as SupervisionRecoveryLeaseAction)
          || (!taskStatus && !assignmentStatus && scopeFiles.length === 0
            && leaseAction === 'preserve' && !rebindSessionName)
          || input.toStatus !== undefined) {
          return err('validation_failed', 'coordination override requires assignmentId, leaseAction, idempotencyKey, reason, and at least one taskStatus/assignmentStatus/scopeFiles/lease mutation/rebindSessionName field only');
        }
        const task = reg.get(taskId);
        const taskProjectName = typeof task?.projectName === 'string' ? task.projectName : '';
        const authorized = isAdmin(caller) || Boolean(
          caller.projectName && caller.projectName === taskProjectName && isProjectBrain(caller),
        );
        if (!task || !authorized) {
          return err('forbidden', 'coordination override requires the authoritative project Brain or administrator');
        }
        const identity = rebindSessionName
          ? deps.resolveSessionIdentity?.(rebindSessionName)
          : undefined;
        if (rebindSessionName && !identity) {
          return err('identity_rejected', 'coordination identity target has no live daemon-observed identity');
        }
        if (identity && identity.projectName !== taskProjectName) {
          return err('forbidden', 'coordination identity target must belong to the task project');
        }
        const reboundIdentity = identity ? {
          sessionName: identity.sessionName,
          sessionInstanceId: identity.sessionInstanceId,
          runtimeEpoch: identity.runtimeEpoch,
          agentType: identity.agentType,
          providerFamily: identity.providerFamily,
        } : undefined;
        const coordinated = reg.coordinateTaskAssignment?.({
          taskId,
          assignmentId,
          ...(taskStatus ? { taskStatus: taskStatus as SupervisionBrainCoordinationRecoveryStatus } : {}),
          ...(assignmentStatus ? { assignmentStatus: assignmentStatus as SupervisionBrainCoordinationRecoveryStatus } : {}),
          ...(scopeFiles.length > 0 ? { scopeFiles } : {}),
          leaseAction: leaseAction as SupervisionRecoveryLeaseAction,
          ...(reboundIdentity ? { identity: reboundIdentity } : {}),
          idempotencyKey,
          reason,
        });
        if (!coordinated) return err('unavailable', 'coordination override is not bound');
        if (!coordinated.ok) return err(coordinated.reason, `coordination override rejected: ${coordinated.reason}`);
        // THE WIRE. An authorized rebind of a COORDINATOR assignment must carry
        // that coordinator's pending returns with it. Without this the rebind
        // succeeded while every reply stayed addressed to the retired runtime --
        // the capability existed but nothing invoked it.
        let advancedReturns = 0;
        if (reboundIdentity) {
          const reboundAssignment = reg.get?.(taskId) as {
            assignments?: Array<{ assignmentId?: string; role?: string }>;
          } | undefined;
          const isCoordinator = reboundAssignment?.assignments
            ?.some((candidate) => candidate.assignmentId === assignmentId && candidate.role === 'coordinator');
          if (isCoordinator) {
            advancedReturns = deps.advancePendingRepliesForReboundCoordinator?.({
              taskId,
              coordinatorAssignmentId: assignmentId,
              origin: {
                sessionName: reboundIdentity.sessionName,
                sessionInstanceId: reboundIdentity.sessionInstanceId,
                runtimeEpoch: reboundIdentity.runtimeEpoch,
              },
            }) ?? 0;
          }
        }
        // Surface the count only when returns actually moved, so the ordinary
        // coordination-override response shape is unchanged.
        return ok({
          taskId, assignmentId, replay: coordinated.replay === true,
          ...(advancedReturns > 0 ? { advancedReturns } : {}),
        });
      }
      // tsk_4iu: a project Brain must be able to retire an exact stale auditor
      // from the PUBLIC path even after a final NON-PASS verdict. Previously
      // task_recover returned role_forbidden and task_intent cancel reported
      // the assignment as not visible, so one orphaned auditor blocked
      // successor binding with no operator exit.
      if (assignmentId && !rebindSessionName && String(input.toStatus ?? '') === 'cancelled') {
        if (!reason) return err('validation_failed', 'stale auditor cancellation requires a reason');
        const task = reg.get(taskId);
        const taskProjectName = typeof task?.projectName === 'string' ? task.projectName : '';
        if (!task || !caller.projectName || caller.projectName !== taskProjectName
          || (!isAdmin(caller) && !isProjectBrain(caller))) {
          return err('forbidden', 'stale auditor cancellation requires the authoritative project Brain or administrator');
        }
        const cancelled = reg.cancelStaleAuditorAsProjectBrain?.({
          taskId, auditorAssignmentId: assignmentId, callerProjectName: taskProjectName, reason,
        });
        if (!cancelled) return err('unavailable', 'stale auditor cancellation is not bound');
        if (!cancelled.ok) return err(cancelled.reason, `stale auditor cancellation rejected: ${cancelled.reason}`);
        return ok({ taskId, assignmentId, status: 'cancelled' });
      }
      if (assignmentId || rebindSessionName) {
        if (!assignmentId || !rebindSessionName || !reason) return err('validation_failed', 'audit rebind requires assignmentId, rebindSessionName and reason');
        const task = reg.get(taskId);
        const taskProjectName = typeof task?.projectName === 'string' ? task.projectName : '';
        if (!task || !caller.projectName || caller.projectName !== taskProjectName
          || (!isAdmin(caller) && !isProjectBrain(caller))) {
          return err('forbidden', 'audit identity rebind requires the authoritative project Brain or administrator');
        }
        const identity = deps.resolveSessionIdentity?.(rebindSessionName);
        if (!identity) return err('identity_rejected', 'rebind target has no live daemon-observed identity');
        if (identity.projectName !== taskProjectName) {
          return err('forbidden', 'audit identity target must belong to the task project');
        }
        const rebound = reg.rebindAuditAssignment?.({
          taskId,
          assignmentId,
          identity: {
            sessionName: identity.sessionName,
            sessionInstanceId: identity.sessionInstanceId,
            runtimeEpoch: identity.runtimeEpoch,
            agentType: identity.agentType,
            providerFamily: identity.providerFamily,
          },
          callerProjectName: taskProjectName,
          reason,
        });
        if (!rebound) return err('unavailable', 'audit identity rebind is not bound');
        if (!rebound.ok) return err(rebound.reason, `audit identity rebind rejected: ${rebound.reason}`);
        return ok({ taskId, assignmentId, rebindSessionName, replay: rebound.replay === true });
      }
      const target = String(input.toStatus ?? '');
      if (!(SUPERVISION_TASK_RECOVERY_TARGET_STATUSES as readonly string[]).includes(target)) {
        return err('invalid_target_status', 'recovery target must be a restricted enum member');
      }
      const current = reg.getStatus(taskId);
      const task = reg.get(taskId);
      const taskProjectName = typeof task?.projectName === 'string' ? task.projectName : '';
      const evidenceRecovery = current === 'cancelled' && target === 'recovered';
      const projectBrainMayRecover = evidenceRecovery
        && Boolean(caller.projectName)
        && caller.projectName === taskProjectName
        && isProjectBrain(caller);
      if (!isAdmin(caller) && !projectBrainMayRecover) {
        return err('forbidden', 'administrative recovery is not authorized for this caller');
      }
      if (!current || !isSupervisionTaskLifecycleStatus(current)) return err('unknown_task');
      if (RECOVERY_FORBIDDEN_SOURCES.includes(current)) {
        return err('illegal_transition', `recovery cannot move a ${current} task`);
      }
      if (!reason) return err('reason_required');
      const recovered = reg.recover({ taskId, toStatus: target as SupervisionRecoveryTargetStatus, reason });
      if (recovered && !recovered.ok) return err(recovered.reason, `task recovery rejected: ${recovered.reason}`);
      const actualStatus = recovered?.value?.status ?? target;
      return ok({ taskId, fromStatus: current, toStatus: actualStatus });
    },

    async [SUPERVISION_MCP_TOOLS.HOUSEKEEPING](args) {
      const input = (args ?? {}) as Record<string, unknown>;
      const reg = need();
      if (!reg) return err('unavailable', 'supervision registry not bound');
      const projectName = caller.projectName?.trim() || '';
      if (!projectName || (!isAdmin(caller) && !isProjectBrain(caller))) {
        return err('forbidden', 'housekeeping requires the authoritative project Brain or administrator');
      }
      const mode = String(input.mode ?? '');
      if (mode !== 'dryRun' && mode !== 'apply') return err('validation_failed', 'mode must be dryRun or apply');
      const result = reg.housekeeping({
        mode,
        projectName,
        ...(input.cursor === undefined ? {} : { cursor: String(input.cursor) }),
        ...(input.limit === undefined ? {} : { limit: Number(input.limit) }),
      });
      let worktrees: unknown = {
        mode,
        registryAvailable: false,
        entries: [],
        diagnostics: [{ code: 'worktree_gc_not_bound' }],
      };
      if (deps.worktreeGc) {
        try {
          worktrees = await deps.worktreeGc({
            mode,
            projectName,
            ...(input.cursor === undefined ? {} : { cursor: String(input.cursor) }),
            ...(input.limit === undefined ? {} : { limit: Number(input.limit) }),
          });
        } catch {
          // Registry housekeeping remains authoritative even when the optional
          // filesystem census fails. Apply must fail closed inside the GC and
          // this diagnostic deliberately carries no local path/error text.
          worktrees = {
            mode,
            registryAvailable: false,
            entries: [],
            diagnostics: [{ code: 'worktree_gc_failed' }],
          };
        }
      }
      return ok({ result, worktrees });
    },
  };
}

function toolResult(result: ToolResult): CallToolResult {
  return {
    structuredContent: result,
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: result.status === 'error',
  };
}

export function registerSupervisionMcpTools(
  server: McpServer,
  caller: McpRuntimeCaller,
  deps: SupervisionMcpToolDeps = {},
): ReadonlyMap<string, RegisteredTool> {
  const handlers = createSupervisionMcpToolHandlers(caller, deps);
  const registered = new Map<string, RegisteredTool>();
  for (const name of SUPERVISION_MCP_REGISTERED_TOOLS) {
    registered.set(name, server.registerTool(name, {
      description: DESCRIPTIONS[name],
      inputSchema: SUPERVISION_MCP_TOOL_SHAPES[name],
    }, async (args: unknown) => toolResult(await handlers[name](args))));
  }
  return registered;
}
