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
  SUPERVISION_UNBOUND_REVISION,
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
  SUPERVISION_BRAIN_RECOVERY_MODES,
  SUPERVISION_BRAIN_REVISION_RESET_LEASE_ACTIONS,
  SUPERVISION_BRAIN_REVISION_RESET_REFUSALS,
  SUPERVISION_BRAIN_REVISION_RESET_STATUSES,
  buildSupervisionBrainRevisionResetGuidance,
  SUPERVISION_RECOVERY_LEASE_ACTIONS,
  SUPERVISION_COMPLETION_EVIDENCE_DECISIONS,
  SUPERVISION_TASK_LIFECYCLE_STATUSES,
  isSupervisionTaskLifecycleStatus,
  type SupervisionTaskRecoveryTargetStatus,
  type SupervisionBrainCoordinationRecoveryStatus,
  type SupervisionBrainRevisionResetStatus,
  type SupervisionRecoveryLeaseAction,
  type SupervisionCompletionEvidenceDecision,
  type SupervisionTaskLifecycleStatus,
} from '../../shared/supervision-config.js';
import { SUPERVISION_CONSOLE_VALIDATION_STATES } from '../../shared/supervision-task-console.js';
import {
  SUPERVISION_ASSIGNMENT_START_HELD,
  describeAssignmentStartRefusal,
  type SupervisionAssignmentStartRefusal,
} from '../../shared/supervision-assignment-start.js';
import {
  isSupervisionTaskParticipant,
  isSupervisionTaskCoordinator,
  supervisionIdentityMatches,
  type SupervisionPersistentIdentity,
} from '../../shared/supervision-participant-authority.js';
import type { McpRuntimeCaller } from './memory-mcp-caller.js';
import { advanceSupervisionTaskAfterFinish } from './supervision-convergence-wire.js';
import logger from '../util/logger.js';
import { getSessionRuntimeType } from '../../shared/agent-types.js';
import { deterministicAutomaticAuditDeliveryMessageId } from '../../shared/send-message-id.js';
import type { SupervisionTaskRegistryRejectDetail } from './supervision-state-store.js';
import {
  type SupervisionAuditDegradedReason,
  type SupervisionAuditRoutingReason,
  supervisionSelectedExecutionBindingMatches,
  type SupervisionExecutionBinding,
  type SupervisionProvisioningEvidence,
} from '../../shared/supervision-execution-pool.js';
import {
  evaluateSupervisionAuditorRecoveryRouting,
  type SupervisionAuditorRecoveryCrossVendorAvailability,
} from '../../shared/supervision-auditor-recovery.js';

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
  auditPolicy?: string;
  validationState?: string;
  assignments?: ReadonlyArray<{
    assignmentId?: string;
    role?: string;
    required?: boolean;
    status?: string;
    leaseId?: string;
    auditAttemptId?: string;
    auditRevision?: string;
    verdict?: string;
    validationState?: string;
    generation?: number;
    executionBinding?: SupervisionExecutionBinding;
    provisioning?: SupervisionProvisioningEvidence;
    auditRoutingReason?: SupervisionAuditRoutingReason;
    auditDegradedReason?: SupervisionAuditDegradedReason;
    identity?: {
      sessionName?: string;
      sessionInstanceId?: string;
      runtimeEpoch?: string;
      agentType?: string;
      providerFamily?: string;
    };
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
  callerProjectName?: string | null,
): boolean {
  return Boolean(item?.projectName && callerProjectName
    && item.projectName === callerProjectName
    && isSupervisionTaskParticipant(item.assignments as never, callerIdentity));
}

/**
 * Resolve authority for one already-persisted task.
 *
 * Runtime identity is preferred when the daemon can observe it, but the task's
 * durable coordinator row is the restart-safe authority of last resort.  That
 * fallback is deliberately task-local: a session name alone never grants
 * project-wide Brain authority, and project scope must still match exactly.
 */
export function supervisionTaskCallerAuthority(input: {
  item: SupervisionVisibilityItem | undefined;
  callerSessionName: string;
  callerProjectName?: string | null;
  liveIdentity?: (Partial<SupervisionPersistentIdentity> & { projectName?: string }) | undefined;
  liveProjectBrain?: boolean;
}): {
  projectName: string;
  participantMayRead: boolean;
  coordinatorMayAct: boolean;
  projectBrainMayRead: boolean;
} {
  const callerSessionName = input.callerSessionName.trim();
  const rawProjectName = input.callerProjectName?.trim() || '';
  const observedSessionName = input.liveIdentity?.sessionName?.trim() || '';
  const observedProjectName = input.liveIdentity?.projectName?.trim() || '';
  const usableLiveIdentity = Boolean(input.liveIdentity
    && observedSessionName === callerSessionName && observedProjectName);
  const liveIdentityConflict = Boolean(input.liveIdentity && !usableLiveIdentity);
  // A resolver result for some other session is not the caller's identity.
  // Ignore it rather than letting target-resolution mocks/data poison the
  // independently verified live-Brain lane; it still grants no participant
  // authority. A same-session observed cross-project identity remains binding
  // and therefore fails the task project check below.
  const projectName = usableLiveIdentity ? observedProjectName : rawProjectName;
  const projectMatches = Boolean(input.item?.projectName && projectName
    && input.item.projectName === projectName);
  const stableIdentity = callerSessionName ? { sessionName: callerSessionName } : undefined;
  const durableCoordinator = Boolean(projectMatches && !liveIdentityConflict
    && isSupervisionTaskCoordinator(input.item?.assignments as never, stableIdentity));
  // A unique live top-level project Brain is the project's coordination
  // authority even when an older coordinator row exists.  The row remains
  // durable provenance; it is not a veto held by a stale epoch or a retired
  // window.  `liveProjectBrain` is daemon-observed and project-scoped, so this
  // does not widen authority to participants or same-name stale runtimes.
  const coordinatorMayAct = durableCoordinator
    || Boolean(projectMatches && input.liveProjectBrain);
  const participantMayRead = Boolean(projectMatches && usableLiveIdentity && input.liveIdentity
    && supervisionCallerParticipates(input.item, input.liveIdentity, projectName));
  return {
    projectName,
    participantMayRead,
    coordinatorMayAct,
    projectBrainMayRead: Boolean(projectMatches && input.liveProjectBrain),
  };
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
    /** Caller revision authority; mandatory for revision-authoritative intents. */
    expectedRevision?: string;
  }): void | { ok: true; value?: unknown; replay?: boolean } | { ok: false; reason: string };
  finishAssignment?(input: {
    assignmentId: string;
    callerSessionName: string;
    /** Mandatory caller revision authority for FINISHED. */
    expectedRevision: string;
    callerProjectName?: string;
    projectBrain?: boolean;
    rebindIdentity?: {
      sessionName: string; sessionInstanceId: string; runtimeEpoch: string;
      agentType: string; providerFamily: string;
    };
    rebindProjectName?: string;
  }): { ok: true; value: unknown; replay?: boolean } | { ok: false; reason: string };
  /**
   * Authenticated assignment ACK: start the caller's own delegated implementer
   * assignment from its live daemon-resolved identity (see
   * src/daemon/assignment-auto-start.ts). Absent in ports without a registry.
   */
  startAssignmentFromAck?(input: {
    taskId: string;
    assignmentId: string;
    callerSessionName: string;
    evidenceEventId: string;
    /** The acknowledging intent; the port enforces that intent's own revision authority. */
    intent?: string;
    expectedRevision?: string;
  }): { status: 'started' | 'already_started' | 'not_delivered' | 'ignored' }
    | { status: 'held' }
    | { status: 'refused'; refusal: SupervisionAssignmentStartRefusal }
    | { status: 'revision_refused'; reason: string };
  convergeValidatedAssignment?(input: { taskId: string; assignmentId: string }):
    | unknown[] | { ok: false; reason: string }
    | Promise<unknown[] | { ok: false; reason: string }>;
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
    executionBinding?: SupervisionExecutionBinding;
    authoritativeBrainOverride?: true;
  }): { ok: true; value?: unknown; replay?: boolean } | { ok: false; reason: string };
  recoverOrphanedDelegatedAuditor?(input: {
    taskId: string;
    assignmentId: string;
    identity: {
      sessionName: string; sessionInstanceId: string; runtimeEpoch: string;
      agentType: string; providerFamily: string;
    };
    executionBinding: SupervisionExecutionBinding;
    /** The routing statement the SAME assignment carries after the rebind. */
    auditRoutingReason?: SupervisionAuditRoutingReason;
    auditDegradedReason?: SupervisionAuditDegradedReason;
    expectedGeneration: number;
    expectedRevision: string;
    auditAttemptId: string;
    callerProjectName: string;
    supersededDeliveryMessageId: string;
    deliveryMessageId: string;
    idempotencyKey: string;
    reason: string;
    ownedFiles?: readonly string[];
    evidenceManifestSha256?: string;
    validateOnly?: boolean;
  }): { ok: true; value?: unknown; replay?: boolean } | { ok: false; reason: string };
  rebindValidatedImplementerAssignment?(input: {
    taskId: string;
    assignmentId: string;
    identity: {
      sessionName: string; sessionInstanceId: string; runtimeEpoch: string;
      agentType: string; providerFamily: string;
    };
    expectedRevision: string;
    ownedFiles: string[];
    evidenceManifestSha256: string;
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
  }): Promise<{ ok: true; value?: unknown; replay?: boolean } | {
    ok: false; reason: string; detail?: SupervisionTaskRegistryRejectDetail;
  }>;
  resetTaskToRevisionAsBrain?(input: {
    taskId: string;
    assignmentId: string;
    toRevision: string;
    taskStatus: SupervisionBrainRevisionResetStatus;
    leaseAction: SupervisionRecoveryLeaseAction;
    idempotencyKey: string;
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
    executionBinding?: SupervisionExecutionBinding;
    provisioning?: SupervisionProvisioningEvidence;
    expectedRevision?: string;
    expectedGeneration?: number;
    evidenceManifestSha256?: string;
    idempotencyKey: string;
    reason: string;
    authoritativeBrainOverride?: true;
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

/**
 * A reactive post-validation/post-open audit dispatch that resolves WITHOUT
 * throwing but also without actually delivering anything (`ignored`, or
 * `blocked` for a reason the daemon-side dispatcher did not itself already
 * report to a coordinator) used to be indistinguishable from a genuine
 * `dispatched`/`replayed` success at these call sites -- both were simply
 * awaited and discarded. That silence is exactly what made a real incident
 * (tsk_v4n/tsk_v2a: an audit sat with zero auditor assignment for several
 * minutes) impossible to diagnose from any log. This does not change control
 * flow or retry behavior -- the periodic 60s watchdog tick remains the sole
 * retry mechanism, unchanged -- it only makes a non-delivering outcome
 * visible instead of invisible.
 */
function logNonDeliveringAuditDispatch(taskId: string, intent: string, result: unknown): void {
  const status = result && typeof result === 'object' && 'status' in result
    ? (result as { status?: unknown }).status
    : undefined;
  if (status === 'dispatched' || status === 'replayed') return;
  logger.warn({ taskId, intent, result }, 'Reactive audit dispatch did not deliver');
}

/**
 * The same "did this actually deliver an auditor" read as
 * {@link logNonDeliveringAuditDispatch}, but returned for the RESPONSE
 * instead of only the server log — so the caller (often a Brain that just
 * committed a validation or opened an audit) can see a real reason like
 * `missing_audit_policy` immediately, instead of getting a bare successful
 * transition and having to separately call supervision_task_get and inspect
 * the task's blocker field to discover the audit never dispatched.
 */
function nonDeliveringAuditDispatchSummary(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || !('status' in result)) return undefined;
  const status = (result as { status?: unknown }).status;
  if (status === 'dispatched' || status === 'replayed') return undefined;
  const reason = 'reason' in result ? (result as { reason?: unknown }).reason : undefined;
  return typeof reason === 'string' && reason.trim()
    ? `audit_dispatch_${String(status)}: ${reason}`
    : `audit_dispatch_${String(status)}`;
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
  /** CAS retirement of the superseded target's exact pending queue identity. */
  retireSupersededAuditDelivery?: (input: {
    sessionName: string;
    messageId: string;
    recipient: { sessionInstanceId: string; runtimeEpoch: string };
  }) => boolean | Promise<boolean>;
  resolveSessionIdentity?: (sessionName: string) => {
    sessionName: string; sessionInstanceId: string; runtimeEpoch: string;
    agentType: string; providerFamily: string; projectName: string; role?: string;
  } | undefined;
  /** Exact project-pool selection for an auditor recovery target. */
  resolveAuditorRecoveryBinding?: (sessionName: string) => SupervisionExecutionBinding | undefined;
  /**
   * Is any cross-vendor auditor usable for the audited session right now, by
   * the pool-scoped automatic-audit eligibility? Consulted only before a
   * same-family rebind under `auto_allow_degraded`; `undefined` refuses it.
   */
  resolveAuditorRecoveryCrossVendorAvailability?: (input: {
    scopeSessionName: string;
    auditedSessionName: string;
  }) => SupervisionAuditorRecoveryCrossVendorAvailability | undefined
    | Promise<SupervisionAuditorRecoveryCrossVendorAvailability | undefined>;
  /** Exact live transport binding selected manually by the authoritative Brain. */
  resolveManualExecutionBinding?: (sessionName: string) => SupervisionExecutionBinding | undefined;
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
    /**
     * Exact revision the caller acted on. REQUIRED for record_validation and
     * finish: a delayed or retried call for a predecessor revision is refused
     * with old_revision instead of being applied to the successor.
     */
    expectedRevision: z.string().optional(),
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
    recoveryMode: z.enum([...SUPERVISION_BRAIN_RECOVERY_MODES]).optional(),
    toStatus: z.enum([...SUPERVISION_TASK_RECOVERY_TARGET_STATUSES]).optional(),
    assignmentId: z.string().min(1).optional(),
    rebindSessionName: z.string().min(1).optional(),
    expectedRevision: z.string().min(1).optional(),
    expectedGeneration: z.number().int().min(0).optional(),
    auditAttemptId: z.string().min(1).optional(),
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
  // the shared tool surface is already over its size budget (the bootstrap
  // surface has ZERO headroom, so the LIST text below was fitted within the same
  // byte length). List retention semantics, documented here because the
  // published text cannot grow: default = unarchived tasks; history = ARCHIVED
  // tasks only, so a live task (including a non-terminal `recovered` one that
  // housekeeping has not archived yet) is absent from history while
  // supervision_task_get still reads it; includeArchived = both. An explicit
  // non-terminal `status` filter is a lifecycle projection that ignores
  // archivedAt and is never returned under history. Pinned by the 'recovered
  // task' visibility tests in supervision-mcp-registration.test.ts.
  [SUPERVISION_MCP_TOOLS.INTENT]: 'Task intent; validation and finish require expectedRevision.',
  [SUPERVISION_MCP_TOOLS.LIST]: 'Tasks (Brain: project, else yours); history=archived only, not live.',
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
  const callerIdentity = () => (
    callerSession ? deps.resolveSessionIdentity?.(callerSession) : undefined
  );
  const callerAuthority = () => {
    const identity = callerIdentity();
    return {
      identity,
      // The daemon-resolved project is the durable scope. A sub-session's raw
      // MCP project field may still be its generated session namespace before
      // the first task intent; read and write gates must not disagree on that
      // pre-start projection.
      projectName: identity?.projectName?.trim() || caller.projectName?.trim() || '',
    };
  };
  const taskAuthority = (task: SupervisionVisibilityItem | undefined) => {
    const authority = callerAuthority();
    return supervisionTaskCallerAuthority({
      item: task,
      callerSessionName: callerSession,
      callerProjectName: authority.projectName,
      liveIdentity: authority.identity,
      liveProjectBrain: isProjectBrain(caller),
    });
  };
  const need = (): SupervisionRegistryPort | undefined => registry;

  /**
   * Add the final repair action only after the live project-Brain gate passed.
   * Ordinary participants receive the original refusal verbatim and therefore
   * do not learn or appear to hold the Brain-only reset capability.
   */
  const brainRepairRefusal = (
    task: SupervisionVisibilityItem | undefined,
    reason: string,
    detail?: string,
    hint?: { assignmentId?: string; toRevision?: string },
  ): ToolResult => {
    // A revision rejection where NOTHING has ever been bound (task.currentRevision
    // absent, and the named assignment's auditRevision absent too) is not a real
    // conflict -- it is the first-report shape, and the task's own visible fields
    // give the caller no way to discover what to send instead: baseRevision looks
    // like the right value and is silently refused. This is public API guidance
    // (the SUPERVISION_UNBOUND_REVISION sentinel), not a Brain-only repair
    // capability, so surface it to every caller, not only a repairing Brain.
    if (reason === 'old_revision') {
      const hintedAssignment = hint?.assignmentId
        ? task?.assignments?.find((candidate) => candidate.assignmentId === hint.assignmentId)
        : undefined;
      const taskUnbound = !task?.currentRevision?.trim();
      const assignmentUnbound = !hintedAssignment || !hintedAssignment.auditRevision?.trim();
      if (taskUnbound && assignmentUnbound) {
        detail = `${detail ?? reason}; this task/assignment has never recorded a revision yet -- pass expectedRevision: "${SUPERVISION_UNBOUND_REVISION}" instead of a git hash for the first report`;
      }
    }
    if (!taskAuthority(task).projectBrainMayRead) return err(reason, detail);
    const assignment = hint?.assignmentId
      ? task?.assignments?.find((candidate) => candidate.assignmentId === hint.assignmentId)
      : task?.assignments?.find((candidate) => candidate.role === 'implementer')
        ?? task?.assignments?.find((candidate) => candidate.role === 'coordinator')
        ?? task?.assignments?.[0];
    const assignmentId = hint?.assignmentId?.trim() || assignment?.assignmentId?.trim();
    const toRevision = hint?.toRevision?.trim()
      || assignment?.auditRevision?.trim()
      || task?.currentRevision?.trim();
    const guidance = buildSupervisionBrainRevisionResetGuidance({
      taskId: task?.taskId,
      assignmentId,
      toRevision,
    });
    return err(reason, `${detail ?? reason}. ${guidance}`);
  };

  return {
    async [SUPERVISION_MCP_TOOLS.INTENT](args) {
      const input = (args ?? {}) as Record<string, unknown>;
      const reg = need();
      if (!reg) return err('unavailable', 'supervision registry not bound');
      const taskId = String(input.taskId ?? '');
      const task = reg.get(taskId);
      const authority = callerAuthority();
      const requestedAssignmentId = input.assignmentId === undefined ? undefined : String(input.assignmentId);
      const intent = String(input.intent ?? '');
      const exactTaskAuthority = taskAuthority(task);
      const authoritativeProjectBrainMayAct = exactTaskAuthority.projectBrainMayRead;
      const callerAssignments = (task?.assignments ?? []).filter(
        (assignment) => task?.projectName === exactTaskAuthority.projectName
          && supervisionIdentityMatches(assignment.identity, authority.identity)
          && assignment.assignmentId,
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
        && exactTaskAuthority.coordinatorMayAct
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
      const expectedRevision = typeof input.expectedRevision === 'string' && input.expectedRevision.trim()
        ? input.expectedRevision.trim()
        : undefined;
      if ((intent === 'record_validation' || intent === 'finish') && !expectedRevision) {
        return err('expected_revision_required', `${intent} requires expectedRevision: the exact current revision you acted on`);
      }
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
          expectedRevision: expectedRevision!,
          // Use the daemon-resolved project scope, not the optional/stale MCP
          // environment hint. Read/intent authorization above already proved
          // this exact live identity against that scope; handing the raw hint
          // to the production port made a successful handoff report
          // owner_mismatch when the child MCP omitted IMCODES_PROJECT_NAME.
          ...(authority.projectName ? { callerProjectName: authority.projectName } : {}),
          // finishAssignmentAsProjectBrain exists for two cases ONLY: the
          // coordinator closing an assignment it does not itself own (no
          // callerBoundAssignmentId -- boundAssignmentId came from the
          // coordinator fallback), or an explicit rebind. Its non-auditor
          // branch unconditionally refuses role_forbidden unless a rebind was
          // requested (state-store's #finishAssignmentAsProjectBrainLocked),
          // so routing a coordinator's ordinary finish of ITS OWN
          // non-auditor assignment (e.g. integration_owner) through here --
          // which `coordinatorMayAct` alone cannot distinguish from the
          // legitimate cases -- always failed even though the plain
          // finishAssignment path below would have accepted it directly.
          ...(coordinatorMayAct && (!callerBoundAssignmentId || rebind) ? { projectBrain: true } : {}),
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
        if (!finished.ok) return brainRepairRefusal(
          task, finished.reason, `task finish rejected: ${finished.reason}`,
          { assignmentId: boundAssignmentId, toRevision: expectedRevision },
        );
        // The finish that just committed is the EVENT that can leave this
        // aggregate ready for its next automatic step. Without this wire the
        // only thing carrying it forward was the 60s watchdog tick.
        await advanceSupervisionTaskAfterFinish(taskId, deps.dispatchReadyAudit);
        return ok({ intent: 'finish', fromStatus: task?.status ?? reg.getStatus(taskId), toStatus: (finished.value as { status?: unknown }).status ?? null, item: finished.value, idempotentReplay: finished.replay === true });
      }
      // Authenticated assignment ACK. A recipient naming its OWN delegated
      // implementer assignment in any lifecycle intent is executing it, so the
      // daemon starts it first (idempotent, atomic, fail-closed) instead of
      // refusing the intent or waiting for a separate start/claim call.
      let startedByAck = false;
      if (callerBoundAssignmentId && boundAssignment?.role === 'implementer'
        && boundAssignment.status === 'delegated' && intent !== 'cancel'
        && input.status === undefined && reg.startAssignmentFromAck && callerSession) {
        const acked = reg.startAssignmentFromAck({
          taskId,
          assignmentId: callerBoundAssignmentId,
          callerSessionName: callerSession,
          evidenceEventId: `supervision_task_intent:${intent}`,
          intent,
          ...(expectedRevision ? { expectedRevision } : {}),
        });
        if (acked.status === 'revision_refused') {
          // Same refusal, same wording, as the registry's own intent refusal.
          return brainRepairRefusal(
            task, acked.reason, `task intent rejected: ${acked.reason}`,
            { assignmentId: callerBoundAssignmentId, toRevision: expectedRevision },
          );
        }
        if (acked.status === 'refused' || acked.status === 'held') {
          const refused = describeAssignmentStartRefusal(
            acked.status === 'refused' ? acked.refusal : SUPERVISION_ASSIGNMENT_START_HELD,
          );
          return err(refused.reason, refused.detail);
        }
        startedByAck = acked.status === 'started' || acked.status === 'already_started';
      }
      // start/claim are satisfied by that start, or by an earlier one: a repeated
      // ACK converges on the same state instead of an illegal_transition.
      if ((intent === 'start' || intent === 'claim') && input.status === undefined
        && callerBoundAssignmentId && boundAssignment?.role === 'implementer'
        && (startedByAck || boundAssignment.status === 'implementing')) {
        return ok({
          intent,
          fromStatus: startedByAck ? 'delegated' : 'implementing',
          toStatus: 'implementing',
          idempotentReplay: !startedByAck,
        });
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
          ? (startedByAck ? 'implementing' : boundAssignment.status)
          : reg.getStatus(taskId),
      });
      if (!outcome.ok) {
        const brainOverrideStatus = outcome.refusal === 'illegal_transition'
          && authoritativeProjectBrainMayAct
          && boundAssignmentId
          ? intent === 'start' || intent === 'claim'
            ? 'implementing'
            : intent === 'cancel'
              ? 'cancelled'
              : undefined
          : undefined;
        if (brainOverrideStatus) {
          const coordinated = reg.coordinateTaskAssignment?.({
            taskId,
            assignmentId: boundAssignmentId!,
            taskStatus: brainOverrideStatus,
            assignmentStatus: brainOverrideStatus,
            leaseAction: brainOverrideStatus === 'cancelled' ? 'clear' : 'renew',
            idempotencyKey: `brain-intent:${taskId}:${boundAssignmentId}:${intent}:${boundAssignment?.status ?? task?.status ?? 'unknown'}:${brainOverrideStatus}`,
            reason: String(input.note ?? '').trim()
              || `authoritative Brain manual ${intent} lifecycle override`,
            authoritativeBrainOverride: true,
          });
          if (!coordinated) return err('unavailable', 'Brain lifecycle override is not bound');
          if (!coordinated.ok) return brainRepairRefusal(
            task, coordinated.reason, `Brain lifecycle override rejected: ${coordinated.reason}`,
            { assignmentId: boundAssignmentId },
          );
          return ok({
            intent,
            fromStatus: boundAssignment?.status ?? task?.status ?? null,
            toStatus: brainOverrideStatus,
            item: coordinated.value,
            idempotentReplay: coordinated.replay === true,
          });
        }
        return brainRepairRefusal(
          task, outcome.refusal ?? 'refused', outcome.detail,
          { assignmentId: boundAssignmentId },
        );
      }
      // Set only when a post-commit projection could not be completed. It never
      // negates the committed transition; it tells the caller what still needs
      // to converge so they do not have to guess from an error.
      let convergenceOutcome: string | undefined;
      // Set only when the reactive audit dispatch that record_validation/
      // open_audit trigger did not actually deliver an auditor (e.g.
      // missing_audit_policy). Previously this was logged server-side only
      // (see logNonDeliveringAuditDispatch) and silently dropped from the
      // response, so the caller saw a bare successful transition with no way
      // to learn the audit itself never dispatched short of a separate
      // supervision_task_get call to inspect the task's blocker field.
      let auditDispatchOutcome: string | undefined;
      const applied = reg.applyIntent({
        taskId,
        ...(intentAssignmentId ? { assignmentId: intentAssignmentId } : {}),
        intent: outcome.intent!,
        toStatus: outcome.toStatus ?? null,
        validationState: outcome.validationState,
        note: input.note === undefined ? undefined : String(input.note),
        ...(expectedRevision ? { expectedRevision } : {}),
      });
      if (applied && !applied.ok) return brainRepairRefusal(
        task, applied.reason, `task intent rejected: ${applied.reason}`,
        { assignmentId: intentAssignmentId, toRevision: expectedRevision },
      );
      if (outcome.intent === 'record_validation' && outcome.validationState === 'passed'
        && intentAssignmentId) {
        // Validation is the event that makes FINISHED/open_audit uniquely
        // decidable. Converge the exact object immediately; the periodic tick
        // is only a restart backstop, never the primary production wire.
        // The validation edge is ALREADY COMMITTED by applyIntent above. A
        // failure here is a secondary projection failing, not the transition,
        // so returning an error would tell the caller their validation did not
        // land while the store says it did — the caller then cannot tell which
        // of the two to believe, and re-running is the wrong move because the
        // state machine has already advanced. Report it as an outcome on a
        // SUCCESSFUL response instead, exactly as the audit dispatch below
        // already does, and let the same-object convergence backstop retry.
        try {
          const convergence = await reg.convergeValidatedAssignment?.({ taskId, assignmentId: intentAssignmentId });
          if (convergence && !Array.isArray(convergence) && convergence.ok === false) {
            convergenceOutcome = convergence.reason;
          }
        } catch (error) {
          // A convergence that throws is still only a projection failing.
          convergenceOutcome = error instanceof Error ? error.message : String(error);
        }
        try {
          const auditTrigger = await deps.dispatchReadyAudit?.(taskId);
          logNonDeliveringAuditDispatch(taskId, 'record_validation', auditTrigger);
          auditDispatchOutcome = nonDeliveringAuditDispatchSummary(auditTrigger);
        } catch (error) {
          // The validation and handoff commits remain authoritative. The
          // deterministic dispatcher records its own blocker and can replay --
          // but a thrown error here must still be VISIBLE, not silently
          // discarded. A real incident (tsk_v4n/tsk_v2a) sat with zero
          // auditor for minutes and left no trace anywhere explaining why,
          // because this exact catch block previously swallowed everything.
          logger.warn(
            { err: error, taskId, intent: 'record_validation' },
            'Reactive post-validation audit dispatch threw',
          );
          auditDispatchOutcome = error instanceof Error ? error.message : String(error);
        }
      }
      if (outcome.intent === 'open_audit') {
        try {
          const auditTrigger = await deps.dispatchReadyAudit?.(taskId);
          logNonDeliveringAuditDispatch(taskId, 'open_audit', auditTrigger);
          auditDispatchOutcome = nonDeliveringAuditDispatchSummary(auditTrigger);
        } catch (error) {
          // The ready_for_audit commit is authoritative. The dispatcher owns
          // its durable blocker report and the one-shot boot sweep retries a
          // crash between this commit and materialization -- but see the
          // comment on the `record_validation` branch above: this must not
          // be silently discarded.
          logger.warn(
            { err: error, taskId, intent: 'open_audit' },
            'Reactive post-open audit dispatch threw',
          );
          auditDispatchOutcome = error instanceof Error ? error.message : String(error);
        }
      }
      return ok({
        intent: outcome.intent, fromStatus: outcome.fromStatus,
        toStatus: outcome.intent === 'record_validation' && outcome.validationState === 'passed'
          ? reg.getStatus(taskId) ?? outcome.toStatus ?? null
          : outcome.toStatus ?? null,
        validationState: outcome.validationState,
        ...(convergenceOutcome ? { pendingConvergence: convergenceOutcome } : {}),
        ...(auditDispatchOutcome ? { auditDispatchOutcome } : {}),
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
      const authority = callerAuthority();
      const projectName = authority.projectName;
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
      const tasks = rows.filter((row) => {
        const exact = taskAuthority(row);
        return exact.participantMayRead || exact.coordinatorMayAct;
      });
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
      const exactTaskAuthority = taskAuthority(task);
      if (!task || (!exactTaskAuthority.projectBrainMayRead
        && !exactTaskAuthority.coordinatorMayAct
        && !exactTaskAuthority.participantMayRead)) {
        return err('identity_rejected', 'task is not visible to this caller');
      }
      return ok({ task });
    },

    async [SUPERVISION_MCP_TOOLS.RECOVER](args) {
      const input = (args ?? {}) as Record<string, unknown>;
      const reg = need();
      if (!reg) return err('unavailable', 'supervision registry not bound');
      const recoveryMode = String(input.recoveryMode ?? '').trim();
      const assignmentId = String(input.assignmentId ?? '').trim();
      const rebindSessionName = String(input.rebindSessionName ?? '').trim();
      const expectedRevision = String(input.expectedRevision ?? '').trim();
      const expectedGeneration = typeof input.expectedGeneration === 'number'
        ? input.expectedGeneration
        : undefined;
      const auditAttemptId = String(input.auditAttemptId ?? '').trim();
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
      const coordinatorMayRecover = (task: SupervisionVisibilityItem | undefined) => (
        taskAuthority(task).coordinatorMayAct
      );
      const recoveryTask = assignmentId ? reg.get(taskId) : undefined;
      const recoveryAssignment = recoveryTask?.assignments?.find((candidate) => (
        candidate.assignmentId === assignmentId
      ));
      if (recoveryMode) {
        const resetMode = SUPERVISION_BRAIN_RECOVERY_MODES[0];
        const resetStatus = taskStatus as SupervisionBrainRevisionResetStatus;
        const unexpectedFields = Boolean(
          rebindSessionName || expectedRevision || expectedGeneration !== undefined
          || auditAttemptId || fromRevision || ownedFiles.length > 0
          || evidenceManifestSha256 || assignmentStatus || scopeFiles.length > 0
          || input.toStatus !== undefined || input.completionEvidenceDecision !== undefined
          || input.evidenceId !== undefined || input.targetAssignmentId !== undefined,
        );
        if (recoveryMode !== resetMode || !assignmentId || !toRevision
          || !SUPERVISION_BRAIN_REVISION_RESET_STATUSES.includes(resetStatus)
          || !SUPERVISION_BRAIN_REVISION_RESET_LEASE_ACTIONS.includes(
            leaseAction as typeof SUPERVISION_BRAIN_REVISION_RESET_LEASE_ACTIONS[number],
          )
          || !idempotencyKey || !reason || unexpectedFields) {
          return err(
            'validation_failed',
            `Brain revision reset requires recoveryMode=${resetMode}, assignmentId, toRevision, taskStatus (${SUPERVISION_BRAIN_REVISION_RESET_STATUSES.join('/')}), leaseAction (${SUPERVISION_BRAIN_REVISION_RESET_LEASE_ACTIONS.join('/')}), idempotencyKey and reason only`,
          );
        }
        const task = reg.get(taskId);
        const authorized = isAdmin(caller) || taskAuthority(task).projectBrainMayRead;
        if (!task || !authorized) {
          return err(
            'forbidden',
            'Brain revision reset safety boundary requires the authoritative project Brain or administrator',
          );
        }
        const reset = reg.resetTaskToRevisionAsBrain?.({
          taskId,
          assignmentId,
          toRevision,
          taskStatus: resetStatus,
          leaseAction: leaseAction as SupervisionRecoveryLeaseAction,
          idempotencyKey,
          reason,
        });
        if (!reset) return err('unavailable', 'Brain revision reset is not bound');
        if (!reset.ok) {
          const detail = reset.reason === SUPERVISION_BRAIN_REVISION_RESET_REFUSALS.CLOSED_TASK
            ? 'Brain revision reset rejected by safety boundary: task is committed, pushed, finalized, or archived'
            : reset.reason === 'not_found'
              ? 'Brain revision reset target task or assignment does not exist'
              : reset.reason === 'conflicting_replay'
                ? 'Brain revision reset idempotency key conflicts with another reset request'
                : `Brain revision reset rejected: ${reset.reason}`;
          return err(reset.reason, detail);
        }
        return ok({
          taskId,
          assignmentId,
          toRevision,
          taskStatus: resetStatus,
          replay: reset.replay === true,
        });
      }
      const legacyRecoveryErr = (refusal: string, detail?: string): ToolResult => (
        brainRepairRefusal(reg.get(taskId), refusal, detail, {
          assignmentId,
          toRevision: toRevision || expectedRevision || recoveryAssignment?.auditRevision,
        })
      );
      const evidenceBoundAuditorRecoveryRequested = Boolean(
        assignmentId && rebindSessionName && expectedRevision
        && ownedFiles.length > 0 && evidenceManifestSha256
        && recoveryAssignment?.role === 'auditor'
      );
      const orphanedAuditorRecoveryRequested = Boolean(
        assignmentId && rebindSessionName && recoveryAssignment?.role === 'auditor',
      );
      if (orphanedAuditorRecoveryRequested) {
        const unexpectedRecoveryFields = fromRevision || toRevision || taskStatus || assignmentStatus
          || scopeFiles.length > 0 || leaseAction || input.toStatus !== undefined
          || input.completionEvidenceDecision !== undefined || input.evidenceId !== undefined
          || input.targetAssignmentId !== undefined;
        const invalidEvidenceBoundRequest = evidenceBoundAuditorRecoveryRequested
          && (!reason || Boolean(auditAttemptId && auditAttemptId !== recoveryAssignment?.auditAttemptId));
        const invalidLegacyRequest = !evidenceBoundAuditorRecoveryRequested
          && (ownedFiles.length > 0 || Boolean(evidenceManifestSha256));
        if (unexpectedRecoveryFields || invalidEvidenceBoundRequest || invalidLegacyRequest) {
          return legacyRecoveryErr(
            'validation_failed',
            'auditor recovery requires one exact assignment, revision, attempt and either its frozen evidence or an explicit idempotency key',
          );
        }
        const task = recoveryTask;
        const taskProjectName = typeof task?.projectName === 'string' ? task.projectName : '';
        const authorized = evidenceBoundAuditorRecoveryRequested
          ? coordinatorMayRecover(task)
          : isAdmin(caller) || coordinatorMayRecover(task);
        if (!task || !authorized) {
          return legacyRecoveryErr('forbidden', evidenceBoundAuditorRecoveryRequested
            ? 'evidence-bound auditor recovery requires the authoritative task coordinator'
            : 'orphaned auditor recovery requires the authoritative project Brain or administrator');
        }
        const assignment = task.assignments?.find((candidate) => candidate.assignmentId === assignmentId);
        const effectiveRevision = expectedRevision || String(assignment?.auditRevision ?? '').trim();
        const effectiveAuditAttemptId = evidenceBoundAuditorRecoveryRequested
          ? String(assignment?.auditAttemptId ?? '').trim()
          : auditAttemptId || String(assignment?.auditAttemptId ?? '').trim();
        if (!effectiveRevision || !effectiveAuditAttemptId) {
          return legacyRecoveryErr('invalid_transition', 'auditor recovery requires the existing exact revision and audit attempt');
        }
        const implementers = task.assignments?.filter((candidate) => (
          candidate.role === 'implementer'
          && (!evidenceBoundAuditorRecoveryRequested || candidate.required === true)
          && candidate.status === 'ready_for_audit'
          && candidate.auditRevision === effectiveRevision
        )) ?? [];
        const exactOpenAuditors = task.assignments?.filter((candidate) => (
          candidate.role === 'auditor'
          && candidate.auditRevision === effectiveRevision
          && candidate.status !== 'cancelled'
          && candidate.status !== 'finalized'
          && candidate.status !== 'passed'
          && candidate.status !== 'ready_for_integration'
        )) ?? [];
        const recoverableStatus = evidenceBoundAuditorRecoveryRequested
          ? assignment?.status === 'delegated'
          : assignment?.status === 'delegated'
            || assignment?.status === 'auditing'
            || assignment?.status === 'cancelled';
        if (assignment?.role !== 'auditor'
          || (evidenceBoundAuditorRecoveryRequested && assignment.required !== true)
          || !recoverableStatus
          || assignment.auditAttemptId !== effectiveAuditAttemptId
          || assignment.auditRevision !== effectiveRevision
          || !Number.isSafeInteger(assignment.generation)
          || implementers.length !== 1
          || (assignment.status === 'cancelled'
            ? exactOpenAuditors.length !== 0
            : exactOpenAuditors.length !== 1 || exactOpenAuditors[0]?.assignmentId !== assignmentId)) {
          return legacyRecoveryErr('invalid_transition', 'orphaned auditor recovery requires one exact open auditor and ready implementer');
        }
        const priorSessionName = assignment.identity?.sessionName;
        const priorSessionInstanceId = assignment.identity?.sessionInstanceId;
        const priorRuntimeEpoch = assignment.identity?.runtimeEpoch;
        const implementerProviderFamily = implementers[0]?.identity?.providerFamily;
        const implementerSessionName = implementers[0]?.identity?.sessionName;
        if (!priorSessionName || !priorSessionInstanceId || !priorRuntimeEpoch
          || !implementerProviderFamily || !implementerSessionName) {
          return legacyRecoveryErr('identity_rejected', 'orphaned auditor recovery requires complete durable assignment identities');
        }
        const identity = deps.resolveSessionIdentity?.(rebindSessionName);
        if (!identity) return legacyRecoveryErr('identity_rejected', 'rebind target has no live daemon-observed identity');
        if (identity.role === 'brain') return legacyRecoveryErr('scope_forbidden', 'the project Brain cannot become an auditor');
        if (identity.projectName !== taskProjectName
          || getSessionRuntimeType(identity.agentType) !== 'transport'
          || identity.sessionName === implementerSessionName) {
          return legacyRecoveryErr('identity_rejected', 'orphaned auditor recovery requires one live same-project independent transport target');
        }
        const executionBinding = deps.resolveAuditorRecoveryBinding?.(rebindSessionName);
        if (!executionBinding) {
          return legacyRecoveryErr('identity_rejected', 'orphaned auditor recovery target is not selected in the authoritative execution pool');
        }
        const alreadyRebound = assignment.identity?.sessionName === identity.sessionName
          && assignment.identity?.sessionInstanceId === identity.sessionInstanceId
          && assignment.identity?.runtimeEpoch === identity.runtimeEpoch
          && assignment.identity?.agentType === identity.agentType
          && assignment.identity?.providerFamily === identity.providerFamily
          && supervisionSelectedExecutionBindingMatches(assignment.executionBinding, executionBinding);
        // The audit policy decides the target, from live pool-aware facts. A
        // replay of a completed rebind keeps the routing it was admitted with:
        // availability may have moved since, and the durable record decides.
        let routing: { auditRoutingReason?: SupervisionAuditRoutingReason; auditDegradedReason?: SupervisionAuditDegradedReason };
        if (alreadyRebound) {
          routing = {
            ...(assignment.auditRoutingReason ? { auditRoutingReason: assignment.auditRoutingReason } : {}),
            ...(assignment.auditDegradedReason ? { auditDegradedReason: assignment.auditDegradedReason } : {}),
          };
        } else {
          const sameFamily = identity.providerFamily === implementerProviderFamily;
          let crossVendor: SupervisionAuditorRecoveryCrossVendorAvailability | undefined;
          if (sameFamily && task.auditPolicy === 'auto_allow_degraded') {
            const scopeSessionName = callerSession || task.assignments?.find((candidate) => (
              candidate.role === 'coordinator'
            ))?.identity?.sessionName || '';
            try {
              crossVendor = scopeSessionName
                ? await deps.resolveAuditorRecoveryCrossVendorAvailability?.({
                  scopeSessionName,
                  auditedSessionName: implementerSessionName,
                })
                : undefined;
            } catch {
              crossVendor = undefined;
            }
          }
          const decision = evaluateSupervisionAuditorRecoveryRouting({
            auditPolicy: task.auditPolicy,
            auditedProviderFamily: implementerProviderFamily,
            targetProviderFamily: identity.providerFamily,
            ...(crossVendor ? { crossVendor } : {}),
          });
          if (!decision.ok) {
            return legacyRecoveryErr('identity_rejected', `orphaned auditor recovery target refused by audit policy: ${decision.refusal}`);
          }
          routing = {
            auditRoutingReason: decision.auditRoutingReason,
            ...(decision.auditDegradedReason ? { auditDegradedReason: decision.auditDegradedReason } : {}),
          };
        }
        const deliveryGeneration = alreadyRebound
          ? assignment.generation!
          : assignment.generation! + 1;
        const supersededDeliveryMessageId = deterministicAutomaticAuditDeliveryMessageId(
          assignmentId,
          effectiveAuditAttemptId,
          Math.max(1, deliveryGeneration - 1),
        );
        const deliveryMessageId = deterministicAutomaticAuditDeliveryMessageId(
          assignmentId,
          effectiveAuditAttemptId,
          deliveryGeneration,
        );
        const recoveryInput = {
          taskId,
          assignmentId,
          identity: {
            sessionName: identity.sessionName,
            sessionInstanceId: identity.sessionInstanceId,
            runtimeEpoch: identity.runtimeEpoch,
            agentType: identity.agentType,
            providerFamily: identity.providerFamily,
          },
          executionBinding,
          ...routing,
          expectedGeneration: assignment.generation!,
          expectedRevision: effectiveRevision,
          auditAttemptId: effectiveAuditAttemptId,
          callerProjectName: taskProjectName,
          supersededDeliveryMessageId,
          deliveryMessageId,
          idempotencyKey: idempotencyKey || [
            evidenceBoundAuditorRecoveryRequested ? 'evidence-bound-auditor-rebind' : 'exact-auditor-rebind',
            taskId, assignmentId,
            effectiveAuditAttemptId, effectiveRevision, evidenceManifestSha256,
            rebindSessionName,
          ].join(':'),
          reason,
          ...(evidenceBoundAuditorRecoveryRequested ? { ownedFiles, evidenceManifestSha256 } : {}),
        };
        if (evidenceBoundAuditorRecoveryRequested) {
          const preflight = reg.recoverOrphanedDelegatedAuditor?.({
            ...recoveryInput,
            validateOnly: true,
          });
          if (!preflight) return legacyRecoveryErr('unavailable', 'evidence-bound auditor recovery validation is not bound');
          if (!preflight.ok) return legacyRecoveryErr(preflight.reason, `evidence-bound auditor recovery rejected: ${preflight.reason}`);
        }
        if (!alreadyRebound) {
          const retire = deps.retireSupersededAuditDelivery;
          if (!retire) return legacyRecoveryErr('unavailable', 'exact superseded audit delivery retirement is not bound');
          let retired = false;
          try {
            retired = await retire({
              sessionName: priorSessionName,
              messageId: supersededDeliveryMessageId,
              recipient: {
                sessionInstanceId: priorSessionInstanceId,
                runtimeEpoch: priorRuntimeEpoch,
              },
            });
          } catch {
            return legacyRecoveryErr('unavailable', 'exact superseded audit delivery retirement failed');
          }
          if (!retired) {
            return legacyRecoveryErr('identity_rejected', 'superseded audit delivery identity no longer matches');
          }
        }
        const rebound = alreadyRebound && assignment.status !== 'cancelled'
          ? { ok: true as const, replay: true }
          : reg.recoverOrphanedDelegatedAuditor?.(recoveryInput);
        if (!rebound) return legacyRecoveryErr('unavailable', 'orphaned auditor recovery is not bound');
        if (!rebound.ok) return legacyRecoveryErr(rebound.reason, `orphaned auditor recovery rejected: ${rebound.reason}`);
        let auditTrigger: unknown;
        try {
          auditTrigger = await deps.dispatchReadyAudit?.(taskId);
        } catch {
          // The rebind is authoritative; the bounded boot/tick path retries the
          // same deterministic delivery without creating another auditor.
        }
        return ok({
          taskId,
          assignmentId,
          rebindSessionName,
          expectedRevision: effectiveRevision,
          auditAttemptId: effectiveAuditAttemptId,
          ...routing,
          replay: rebound.replay === true,
          ...(auditTrigger !== undefined ? { auditTrigger } : {}),
        });
      }
      const coordinationFieldsPresent = Boolean(
        taskStatus || assignmentStatus || scopeFiles.length > 0 || leaseAction || idempotencyKey,
      );
      const validatedImplementerRecoveryRequested = Boolean(
        !coordinationFieldsPresent
        && (expectedRevision || (rebindSessionName && (ownedFiles.length > 0 || evidenceManifestSha256))),
      );
      if (validatedImplementerRecoveryRequested) {
        if (!assignmentId || !rebindSessionName || !expectedRevision || ownedFiles.length === 0
          || !evidenceManifestSha256 || fromRevision || toRevision || input.toStatus !== undefined) {
          return legacyRecoveryErr('validation_failed', 'implementer identity recovery requires assignmentId, rebindSessionName, expectedRevision, ownedFiles, evidenceManifestSha256 and reason only');
        }
        const task = reg.get(taskId);
        const taskProjectName = typeof task?.projectName === 'string' ? task.projectName : '';
        const authorized = isAdmin(caller) || coordinatorMayRecover(task);
        if (!task || !authorized) {
          return legacyRecoveryErr('forbidden', 'implementer identity recovery requires the authoritative project Brain or administrator');
        }
        const identity = deps.resolveSessionIdentity?.(rebindSessionName);
        if (!identity) return legacyRecoveryErr('identity_rejected', 'rebind target has no live daemon-observed identity');
        if (identity.role === 'brain') return legacyRecoveryErr('scope_forbidden', 'the project Brain cannot become an implementer');
        const rebound = reg.rebindValidatedImplementerAssignment?.({
          taskId, assignmentId, identity, expectedRevision, ownedFiles,
          evidenceManifestSha256, reason,
        });
        if (!rebound) return legacyRecoveryErr('unavailable', 'implementer identity recovery is not bound');
        if (!rebound.ok) return legacyRecoveryErr(rebound.reason, `implementer identity recovery rejected: ${rebound.reason}`);
        return ok({
          taskId, assignmentId, rebindSessionName, expectedRevision,
          replay: rebound.replay === true,
        });
      }
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
          return legacyRecoveryErr('validation_failed', 'completion evidence resolution requires only taskId, evidenceId, targetAssignmentId, completionEvidenceDecision and reason');
        }
        const task = reg.get(taskId);
        const taskProjectName = typeof task?.projectName === 'string' ? task.projectName : '';
        const authorized = isAdmin(caller) || coordinatorMayRecover(task);
        if (!task || !authorized) return legacyRecoveryErr('forbidden', 'completion evidence resolution requires the authoritative project Brain or administrator');
        const resolved = reg.resolveCompletionEvidence?.({
          taskId, evidenceId, targetAssignmentId,
          decision: completionEvidenceDecision as SupervisionCompletionEvidenceDecision,
          reason,
        });
        if (!resolved) return legacyRecoveryErr('unavailable', 'completion evidence resolution is not bound');
        if (!resolved.ok) return legacyRecoveryErr(resolved.reason, `completion evidence resolution rejected: ${resolved.reason}`);
        return ok({ taskId, evidenceId, targetAssignmentId, decision: completionEvidenceDecision, replay: resolved.replay === true });
      }
      const revisionRecoveryRequested = Boolean(fromRevision || toRevision);
      if (revisionRecoveryRequested) {
        const compatibleProjectionStatus = (value: unknown) => (
          value === undefined || String(value).trim() === 'rework'
        );
        // Each rejection cause gets its own message. They used to share one
        // "requires assignmentId, toRevision, ..." text, so a caller that
        // supplied every required field but also passed an incompatible status
        // (implementing/recovered/...) was told to add fields it already had.
        if (!assignmentId || !toRevision || !reason || !idempotencyKey
          || !SUPERVISION_RECOVERY_LEASE_ACTIONS.includes(leaseAction as SupervisionRecoveryLeaseAction)) {
          return legacyRecoveryErr('validation_failed', `revision recovery requires assignmentId, toRevision, leaseAction (one of ${SUPERVISION_RECOVERY_LEASE_ACTIONS.join('/')}), idempotencyKey and reason; fromRevision/ownedFiles/scopeFiles/evidenceManifestSha256 are optional metadata`);
        }
        if (rebindSessionName) {
          return legacyRecoveryErr('validation_failed', 'revision recovery does not accept rebindSessionName; rebind the session identity with a separate recovery call');
        }
        const incompatibleStatusFields = (['taskStatus', 'assignmentStatus', 'toStatus'] as const)
          .filter((field) => !compatibleProjectionStatus(input[field]));
        if (incompatibleStatusFields.length > 0) {
          return legacyRecoveryErr('validation_failed', `taskStatus/assignmentStatus/toStatus must be omitted or 'rework' for revision recovery (incompatible: ${incompatibleStatusFields.join(', ')})`);
        }
        const task = reg.get(taskId);
        const taskProjectName = typeof task?.projectName === 'string' ? task.projectName : '';
        const authorized = isAdmin(caller) || coordinatorMayRecover(task);
        if (!task || !authorized) {
          return legacyRecoveryErr('forbidden', 'revision recovery requires the authoritative project Brain or administrator');
        }
        const beforeAssignment = task.assignments?.find((candidate) => candidate.assignmentId === assignmentId);
        const alreadyRepaired = task.status === 'rework'
          && task.currentRevision === toRevision
          && beforeAssignment?.status === 'rework'
          && Boolean(beforeAssignment.leaseId)
          && beforeAssignment.auditRevision === toRevision
          && beforeAssignment.verdict?.trim().toUpperCase() === 'REWORK';
        // An exact REWORK receipt may repair a split only within the revision
        // that already owns it. A predecessor receipt must never short-circuit
        // the explicit successor bind below.
        if (task.currentRevision === toRevision) {
          const converged = reg.convergeExactReworkAssignment?.({ taskId, assignmentId });
          const after = reg.get(taskId);
          const repaired = after?.status === 'rework'
            && after.currentRevision === toRevision
            && after.assignments?.some((candidate) => (
              candidate.assignmentId === assignmentId
              && candidate.status === 'rework'
              && candidate.auditRevision === toRevision
              && candidate.verdict?.trim().toUpperCase() === 'REWORK'
            ));
          if (converged && repaired) {
            return ok({
              taskId, assignmentId, toRevision,
              replay: alreadyRepaired,
              converged: 'exact_rework_receipt',
            });
          }
        }
        const rebound = await reg.rebindTaskAssignmentRevision?.({
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
        if (!rebound) return legacyRecoveryErr('unavailable', 'revision recovery is not bound');
        if (!rebound.ok) {
          const detail = rebound.detail;
          const tuple = detail && (detail.taskCurrentRevision !== undefined
            || detail.assignmentAuditRevision !== undefined
            || detail.requestedFromRevision !== undefined
            || detail.requestedToRevision !== undefined)
            ? `; task.currentRevision=${detail.taskCurrentRevision ?? '<unset>'}, assignment.auditRevision=${detail.assignmentAuditRevision ?? '<unset>'}, requested fromRevision=${detail.requestedFromRevision ?? '<unset>'}, requested toRevision=${detail.requestedToRevision ?? '<unset>'}${detail.mismatchedFields?.length ? `, mismatched fields=${detail.mismatchedFields.join(',')}` : ''}`
            : '';
          return legacyRecoveryErr(rebound.reason, `revision recovery rejected: ${rebound.reason}${tuple}`);
        }
        const reboundTask = reg.get(taskId);
        const reboundAssignment = reboundTask?.assignments?.find((candidate) => (
          candidate.assignmentId === assignmentId
        ));
        const successorBound = reboundTask?.currentRevision === toRevision
          && reboundAssignment?.auditRevision === toRevision
          && !reboundAssignment.auditAttemptId
          && !reboundAssignment.verdict;
        if (!successorBound) {
          return legacyRecoveryErr(
            'invalid_transition',
            'revision recovery postcondition failed: authoritative successor state is not bound',
          );
        }
        let convergenceOutcome: string | undefined;
        // Only validation stamped for the successor itself may drive immediate
        // convergence; the registry clears any predecessor outcome on rebind.
        const validatedSuccessor = reboundTask?.validationState === 'passed'
          && reboundAssignment?.validationState === 'passed'
          && (reboundTask as { validatedRevision?: string }).validatedRevision === toRevision
          && (reboundAssignment as { validatedRevision?: string }).validatedRevision === toRevision
          && ['validated', 'ready_for_audit'].includes(reboundTask.status ?? '')
          && ['validated', 'ready_for_audit'].includes(reboundAssignment.status ?? '');
        if (validatedSuccessor) {
          try {
            const convergence = await reg.convergeValidatedAssignment?.({ taskId, assignmentId });
            if (convergence && !Array.isArray(convergence) && convergence.ok === false) {
              convergenceOutcome = convergence.reason;
            }
          } catch (error) {
            convergenceOutcome = error instanceof Error ? error.message : String(error);
          }
          if (!convergenceOutcome) {
            try {
              await deps.dispatchReadyAudit?.(taskId);
            } catch {
              // The same-object successor recovery and immutable freeze are
              // authoritative. The deterministic dispatcher can replay them.
            }
          }
        }
        return ok({
          taskId, assignmentId, ...(fromRevision ? { fromRevision } : {}),
          toRevision, replay: rebound.replay === true,
          ...(convergenceOutcome ? { pendingConvergence: convergenceOutcome } : {}),
        });
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
          return legacyRecoveryErr('validation_failed', 'coordination override requires assignmentId, leaseAction, idempotencyKey, reason, and at least one taskStatus/assignmentStatus/scopeFiles/lease mutation/rebindSessionName field only');
        }
        const task = reg.get(taskId);
        const taskProjectName = typeof task?.projectName === 'string' ? task.projectName : '';
        const authorized = isAdmin(caller) || coordinatorMayRecover(task);
        if (!task || !authorized) {
          return legacyRecoveryErr('forbidden', 'coordination override requires the authoritative project Brain or administrator');
        }
        const identity = rebindSessionName
          ? deps.resolveSessionIdentity?.(rebindSessionName)
          : undefined;
        if (rebindSessionName && !identity) {
          return legacyRecoveryErr('identity_rejected', 'coordination identity target has no live daemon-observed identity');
        }
        if (identity && identity.projectName !== taskProjectName) {
          return legacyRecoveryErr('forbidden', 'coordination identity target must belong to the task project');
        }
        const reboundIdentity = identity ? {
          sessionName: identity.sessionName,
          sessionInstanceId: identity.sessionInstanceId,
          runtimeEpoch: identity.runtimeEpoch,
          agentType: identity.agentType,
          providerFamily: identity.providerFamily,
        } : undefined;
        const assignment = task.assignments?.find((candidate) => candidate.assignmentId === assignmentId);
        if (identity?.role === 'brain' && assignment?.role !== 'coordinator') {
          return legacyRecoveryErr('scope_forbidden', 'the project Brain cannot become an implementer or auditor');
        }
        const refreshesExecutionAuthority = Boolean(
          reboundIdentity && (assignment?.executionBinding || assignment?.provisioning),
        );
        const authoritativeBrainOverride = taskAuthority(task).projectBrainMayRead;
        const coordinationExpectedRevision = expectedRevision || (
          expectedGeneration !== undefined
          && !task.currentRevision
          && !assignment?.auditRevision
            ? SUPERVISION_UNBOUND_REVISION
            : ''
        );
        const coordinationCasPresent = Boolean(
          coordinationExpectedRevision || expectedGeneration !== undefined,
        );
        if (coordinationCasPresent
          && (!coordinationExpectedRevision
            || !Number.isSafeInteger(expectedGeneration) || expectedGeneration! < 0)) {
          return legacyRecoveryErr(
            'validation_failed',
            'coordination recovery requires an exact revision/generation pair',
          );
        }
        if (refreshesExecutionAuthority && !authoritativeBrainOverride && !coordinationCasPresent) {
          return legacyRecoveryErr(
            'validation_failed',
            'coordination execution-authority rebind requires expectedRevision and expectedGeneration',
          );
        }
        if (!refreshesExecutionAuthority && evidenceManifestSha256) {
          return legacyRecoveryErr('validation_failed', 'coordination evidence authority requires an execution-authority rebind');
        }
        const reboundExecutionBinding = refreshesExecutionAuthority
          ? deps.resolveAuditorRecoveryBinding?.(rebindSessionName!)
            ?? deps.resolveManualExecutionBinding?.(rebindSessionName!)
          : undefined;
        if (refreshesExecutionAuthority && !reboundExecutionBinding) {
          return legacyRecoveryErr('identity_rejected', 'coordination identity target has no selected execution binding');
        }
        const reboundProvisioning: SupervisionProvisioningEvidence | undefined = reboundExecutionBinding ? {
          selectedPool: reboundExecutionBinding.pool,
          selectedConfig: reboundExecutionBinding.requested,
          origin: reboundExecutionBinding.origin,
        } : undefined;
        const coordinated = reg.coordinateTaskAssignment?.({
          taskId,
          assignmentId,
          ...(taskStatus ? { taskStatus: taskStatus as SupervisionBrainCoordinationRecoveryStatus } : {}),
          ...(assignmentStatus ? { assignmentStatus: assignmentStatus as SupervisionBrainCoordinationRecoveryStatus } : {}),
          ...(scopeFiles.length > 0 ? { scopeFiles } : {}),
          leaseAction: leaseAction as SupervisionRecoveryLeaseAction,
          ...(reboundIdentity ? { identity: reboundIdentity } : {}),
          ...(reboundExecutionBinding ? {
            executionBinding: reboundExecutionBinding,
            provisioning: reboundProvisioning,
            ...(evidenceManifestSha256 ? { evidenceManifestSha256 } : {}),
          } : {}),
          ...(coordinationCasPresent ? {
            expectedRevision: coordinationExpectedRevision,
            expectedGeneration: expectedGeneration!,
          } : {}),
          idempotencyKey,
          reason,
          ...(authoritativeBrainOverride
            ? { authoritativeBrainOverride: true as const }
            : {}),
        });
        if (!coordinated) return legacyRecoveryErr('unavailable', 'coordination override is not bound');
        if (!coordinated.ok) return legacyRecoveryErr(coordinated.reason, `coordination override rejected: ${coordinated.reason}`);
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
        if (!reason) return legacyRecoveryErr('validation_failed', 'stale auditor cancellation requires a reason');
        const task = reg.get(taskId);
        const taskProjectName = typeof task?.projectName === 'string' ? task.projectName : '';
        if (!task || (!isAdmin(caller) && !coordinatorMayRecover(task))) {
          return legacyRecoveryErr('forbidden', 'stale auditor cancellation requires the authoritative project Brain or administrator');
        }
        const cancelled = reg.cancelStaleAuditorAsProjectBrain?.({
          taskId, auditorAssignmentId: assignmentId, callerProjectName: taskProjectName, reason,
        });
        if (!cancelled) return legacyRecoveryErr('unavailable', 'stale auditor cancellation is not bound');
        if (!cancelled.ok) return legacyRecoveryErr(cancelled.reason, `stale auditor cancellation rejected: ${cancelled.reason}`);
        return ok({ taskId, assignmentId, status: 'cancelled' });
      }
      if (assignmentId || rebindSessionName) {
        if (!assignmentId || !rebindSessionName || !reason) return legacyRecoveryErr('validation_failed', 'audit rebind requires assignmentId, rebindSessionName and reason');
        const task = reg.get(taskId);
        const taskProjectName = typeof task?.projectName === 'string' ? task.projectName : '';
        if (!task || (!isAdmin(caller) && !coordinatorMayRecover(task))) {
          return legacyRecoveryErr('forbidden', 'audit identity rebind requires the authoritative project Brain or administrator');
        }
        const identity = deps.resolveSessionIdentity?.(rebindSessionName);
        if (!identity) return legacyRecoveryErr('identity_rejected', 'rebind target has no live daemon-observed identity');
        if (identity.projectName !== taskProjectName) {
          return legacyRecoveryErr('forbidden', 'audit identity target must belong to the task project');
        }
        const assignment = task.assignments?.find((candidate) => candidate.assignmentId === assignmentId);
        if (identity.role === 'brain' && assignment?.role !== 'coordinator') {
          return legacyRecoveryErr('scope_forbidden', 'the project Brain cannot become an implementer or auditor');
        }
        const reboundExecutionBinding = deps.resolveAuditorRecoveryBinding?.(rebindSessionName)
          ?? deps.resolveManualExecutionBinding?.(rebindSessionName);
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
          ...(taskAuthority(task).projectBrainMayRead
            ? { authoritativeBrainOverride: true as const }
            : {}),
          ...(reboundExecutionBinding ? { executionBinding: reboundExecutionBinding } : {}),
        });
        if (!rebound) return legacyRecoveryErr('unavailable', 'audit identity rebind is not bound');
        if (!rebound.ok) return legacyRecoveryErr(rebound.reason, `audit identity rebind rejected: ${rebound.reason}`);
        return ok({ taskId, assignmentId, rebindSessionName, replay: rebound.replay === true });
      }
      const target = String(input.toStatus ?? '');
      if (!(SUPERVISION_TASK_RECOVERY_TARGET_STATUSES as readonly string[]).includes(target)) {
        return legacyRecoveryErr('invalid_target_status', 'recovery target must be a restricted enum member');
      }
      const current = reg.getStatus(taskId);
      const task = reg.get(taskId);
      const taskProjectName = typeof task?.projectName === 'string' ? task.projectName : '';
      const projectBrainMayRecover = taskAuthority(task).projectBrainMayRead;
      if (!isAdmin(caller) && !projectBrainMayRecover) {
        return legacyRecoveryErr('forbidden', 'administrative recovery is not authorized for this caller');
      }
      if (!current || !isSupervisionTaskLifecycleStatus(current)) return legacyRecoveryErr('unknown_task');
      if (RECOVERY_FORBIDDEN_SOURCES.includes(current)) {
        return legacyRecoveryErr('illegal_transition', `recovery cannot move a ${current} task`);
      }
      if (!reason) return legacyRecoveryErr('reason_required');
      const recovered = reg.recover({ taskId, toStatus: target as SupervisionRecoveryTargetStatus, reason });
      if (recovered && !recovered.ok) return legacyRecoveryErr(recovered.reason, `task recovery rejected: ${recovered.reason}`);
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
