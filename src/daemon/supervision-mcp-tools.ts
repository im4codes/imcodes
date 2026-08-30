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
  SUPERVISION_TASK_LIFECYCLE_STATUSES,
  isSupervisionTaskLifecycleStatus,
  type SupervisionTaskLifecycleStatus,
} from '../../shared/supervision-config.js';
import { SUPERVISION_CONSOLE_VALIDATION_STATES } from '../../shared/supervision-task-console.js';
import type { McpRuntimeCaller } from './memory-mcp-caller.js';

type ToolResult = Record<string, unknown>;

/**
 * Statuses an administrative recovery may target.
 *
 * Narrow on purpose: recovery exists to un-wedge a task, not to hand an
 * operator a way to declare arbitrary completion. `finalized`/`pushed` are
 * absent so recovery can never fabricate a shipped state.
 */
export const SUPERVISION_RECOVERY_TARGET_STATUSES = ['recovered', 'blocked', 'cancelled'] as const;
export type SupervisionRecoveryTargetStatus = typeof SUPERVISION_RECOVERY_TARGET_STATUSES[number];

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
  assignments?: ReadonlyArray<{
    assignmentId?: string;
    role?: string;
    status?: string;
    leaseId?: string;
    auditAttemptId?: string;
    identity?: { sessionName?: string };
  }>;
}

/**
 * Who may see a task: any session holding an assignment on it.
 *
 * Absence of an assignment list is NOT read as "open to everyone" -- it yields
 * an empty participant set, so the caller is refused.
 */
export function supervisionTaskParticipants(item: SupervisionVisibilityItem | undefined): string[] {
  if (!item || !Array.isArray(item.assignments)) return [];
  return item.assignments
    .map((assignment) => assignment?.identity?.sessionName)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

export function supervisionCallerParticipates(
  item: SupervisionVisibilityItem | undefined,
  callerSessionName: string,
): boolean {
  if (!callerSessionName) return false;
  return supervisionTaskParticipants(item).includes(callerSessionName);
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
  }): { ok: true; value: unknown; replay?: boolean } | { ok: false; reason: string };
  list(filter: {
    projectName?: string; status?: string; topLevelTaskId?: string; ownerSessionName?: string;
    includeArchived?: boolean; history?: boolean; cursor?: string; limit?: number;
  }): SupervisionVisibilityItem[];
  get(taskId: string): SupervisionVisibilityItem | undefined;
  recover(input: { taskId: string; toStatus: SupervisionRecoveryTargetStatus; reason: string }):
    | void
    | { ok: true; value?: { status?: string }; replay?: boolean }
    | { ok: false; reason: string };
  rebindAuditAssignment?(input: {
    taskId: string;
    assignmentId: string;
    identity: {
      sessionName: string; sessionInstanceId: string; runtimeEpoch: string;
      agentType: string; providerFamily: string;
    };
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
  resolveSessionIdentity?: (sessionName: string) => {
    sessionName: string; sessionInstanceId: string; runtimeEpoch: string;
    agentType: string; providerFamily: string;
  } | undefined;
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
    toStatus: z.enum([...SUPERVISION_RECOVERY_TARGET_STATUSES] as [string, ...string[]]).optional(),
    assignmentId: z.string().min(1).optional(),
    rebindSessionName: z.string().min(1).optional(),
    reason: z.string().min(1).max(2000),
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
  const need = (): SupervisionRegistryPort | undefined => registry;

  return {
    async [SUPERVISION_MCP_TOOLS.INTENT](args) {
      const input = (args ?? {}) as Record<string, unknown>;
      const reg = need();
      if (!reg) return err('unavailable', 'supervision registry not bound');
      const taskId = String(input.taskId ?? '');
      const task = reg.get(taskId);
      const requestedAssignmentId = input.assignmentId === undefined ? undefined : String(input.assignmentId);
      const callerAssignments = (task?.assignments ?? []).filter(
        (assignment) => assignment.identity?.sessionName === callerSession && assignment.assignmentId,
      );
      const boundAssignmentId = requestedAssignmentId
        ? callerAssignments.find((assignment) => assignment.assignmentId === requestedAssignmentId)?.assignmentId
        : callerAssignments.length === 1 ? callerAssignments[0]?.assignmentId : undefined;
      if (requestedAssignmentId && !boundAssignmentId) {
        return err('identity_rejected', 'assignment is not visible to this caller');
      }
      const intent = String(input.intent ?? '');
      const boundAssignment = boundAssignmentId
        ? callerAssignments.find((assignment) => assignment.assignmentId === boundAssignmentId)
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
        const finished = reg.finishAssignment({ assignmentId: boundAssignmentId, callerSessionName: callerSession });
        return finished.ok
          ? ok({ intent: 'finish', fromStatus: task?.status ?? reg.getStatus(taskId), toStatus: (finished.value as { status?: unknown }).status ?? null, item: finished.value, idempotentReplay: finished.replay === true })
          : err(finished.reason, `task finish rejected: ${finished.reason}`);
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
        currentStatus: (intent === 'start' || intent === 'claim')
          && task?.status === 'implementing'
          && boundAssignment?.status === 'delegated'
          && Boolean(boundAssignment.leaseId)
          ? 'delegated'
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
      return ok({
        intent: outcome.intent, fromStatus: outcome.fromStatus,
        toStatus: outcome.toStatus ?? null, validationState: outcome.validationState,
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
      const tasks = rows.filter((row) => supervisionCallerParticipates(row, callerSession));
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
      if (!task || (!brainMayRead && !supervisionCallerParticipates(task, callerSession))) {
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
      const reason = String(input.reason ?? '').trim();
      const taskId = String(input.taskId ?? '');
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
        const rebound = reg.rebindAuditAssignment?.({ taskId, assignmentId, identity, reason });
        if (!rebound) return err('unavailable', 'audit identity rebind is not bound');
        if (!rebound.ok) return err(rebound.reason, `audit identity rebind rejected: ${rebound.reason}`);
        return ok({ taskId, assignmentId, rebindSessionName, replay: rebound.replay === true });
      }
      const target = String(input.toStatus ?? '');
      if (!(SUPERVISION_RECOVERY_TARGET_STATUSES as readonly string[]).includes(target)) {
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
      return ok({ result });
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
