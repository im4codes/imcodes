import path from 'path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createSendDispatchId, createSendMessageId, type SendDispatchId, type SendMessageId } from '../../shared/send-message-id.js';
import { IMCODES_SEND_MCP_DISPATCH_FEATURE_FLAG } from '../../shared/imcodes-send.js';
import { MCP_ERROR_REASONS, type MCPErrorReason } from '../../shared/memory-mcp-errors.js';
import {
  MEMORY_MCP_CAPS,
  MEMORY_MCP_SEND_DELIVERY_MODES,
  type MemoryMcpSendDeliveryMode,
} from '../../shared/memory-mcp-contracts.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';
import { resolveEffectiveSessionModel } from '../../shared/session-model.js';
import {
  DELEGATION_AVAILABILITY,
  delegationLimitGroup,
  type DelegationAvailability,
  type DelegationAlternative,
  type DelegationLimitGroup,
  type DelegationTargetAvailability,
} from '../../shared/delegation-availability.js';
import {
  DELEGATION_ADMISSION_REASONS,
  buildDelegationRefusal,
  authorizedDelegationCandidates,
  delegationTargetInputs,
  evaluateDelegationAdmission,
  type DelegationAdmissionReason,
  type DelegationRefusal,
} from './delegation-admission.js';
import { resolveDelegationTargets } from '../../shared/delegation-availability.js';
import { isDiscoverableInterAgentSession, resolveEffectiveProjectName, resolveRuntimeScope } from '../../shared/session-scope.js';
import {
  AGENT_DELEGATION_PURPOSES,
  buildAgentDelegationBlockerReportInstruction,
  isAgentDelegationOpaqueId,
  isDelegationReplyCapableAgentType,
  type AgentDelegationAuditRequest,
} from '../../shared/agent-delegation.js';
import {
  SUPERVISION_CONTRACT_IDS,
  isAuditableSupervisionTaskClassification,
  readSupervisionSnapshotFromTransportConfig,
  supervisionTaskAuditPolicyFromSnapshot,
  type SupervisionTaskMetadata,
} from '../../shared/supervision-config.js';
import { getSessionRuntimeType } from '../../shared/agent-types.js';
import {
  evaluateSupervisionExecutionBinding,
  evaluateSupervisionObservedIdentity,
  type SupervisionExecutionBinding,
  type SupervisionExecutionPoolKind,
  type SupervisionExecutionPoolsConfig,
  type SupervisionObservedExecutionIdentity,
} from '../../shared/supervision-execution-pool.js';
import {
  evaluateBrainAuditRoutePolicy,
  resolvePeerAuditProviderFamily,
  validateBrainAuditRoute as validateBrainAuditRouteAuthority,
} from './peer-audit-candidates.js';
import type {
  SupervisionAuditDegradedReason,
  SupervisionAuditRoutingReason,
  SupervisionProvisioningEvidence,
} from '../../shared/supervision-execution-pool.js';
import type {
  SupervisionAutoProvisionRequest,
  SupervisionAutoProvisionResult,
} from './supervision-auto-provision.js';
import { supervisionCallerParticipates } from './supervision-mcp-tools.js';
import {
  EXECUTION_CLONE_KIND,
  EXECUTION_CLONE_ERROR_CODES,
  EXECUTION_CLONE_TERMINAL_REASONS,
  EXECUTION_CLONE_CAPABILITY_V1,
  defaultDedicatedExecutionRoutingPreference,
  isExecutionCloneParentStage,
  type ExecutionCloneErrorCode,
  type ExecutionCloneParentStage,
  type ExecutionCloneTerminalReason,
} from '../../shared/execution-clone.js';

/**
 * Canonical terminal reason for an explicit destroy (clone create rollback + the
 * destroy tool). Derived from the shared reason list so the literal lives in
 * exactly one place (shared/execution-clone.ts), never hardcoded here.
 */
const EXECUTION_CLONE_TERMINAL_REASON_DESTROYED: ExecutionCloneTerminalReason =
  EXECUTION_CLONE_TERMINAL_REASONS.find((reason) => reason === 'destroyed')
  ?? EXECUTION_CLONE_TERMINAL_REASONS[0];
import type { SessionRecord } from '../store/session-store.js';
import {
  getSupervisionTaskRegistry,
  type PersistedSupervisionTaskAssignment,
  type PersistedSupervisionTaskAssignmentIdentity,
  type SupervisionTaskSnapshot,
} from './supervision-state-store.js';
import { getSession, listSessions } from '../store/session-store.js';
import { isExecutionClone } from './execution-clone.js';
import {
  createDelegationReplyAuthority,
  expireDelegationReplyAuthority,
} from './delegation-reply-authority.js';
import { buildServerMemberSharedActorOption as buildSharedServerMemberSharedActorOption, buildSessionDispatchMessage, dispatchSessionMessage, type SessionDispatchMessageResult, type SessionDispatchOptions } from './session-dispatch.js';
import type { SupervisionWorktreeProvisionResult } from './supervision-worktree-provision.js';
import { resolveSupervisionAssignmentWorktree } from './supervision-worktree-inspector.js';
import { getTransportQueueStore } from './transport-queue-store.js';
import { getProvider } from '../agent/provider-registry.js';
import {
  hasRestartDurableDeliveryIdAcceptance,
  type ProviderRestartDurableDeliveryIdCapability,
} from '../agent/transport-provider.js';

export const SEND_MCP_DISPATCH_FEATURE_FLAG = IMCODES_SEND_MCP_DISPATCH_FEATURE_FLAG;
export const SEND_TOOL_ERROR_REASONS = {
  FEATURE_DISABLED: MCP_ERROR_REASONS.FEATURE_DISABLED,
  SCOPE_FORBIDDEN: MCP_ERROR_REASONS.SCOPE_FORBIDDEN,
  IDENTITY_REJECTED: MCP_ERROR_REASONS.IDENTITY_REJECTED,
  VALIDATION_FAILED: MCP_ERROR_REASONS.VALIDATION_FAILED,
  WRITE_QUOTA_EXCEEDED: MCP_ERROR_REASONS.WRITE_QUOTA_EXCEEDED,
  // The RECIPIENT's provider account is out of quota. Deliberately not folded
  // into WRITE_QUOTA_EXCEEDED, which is about the CALLER writing too much: the
  // two demand opposite responses (slow down vs. route elsewhere).
  TARGET_LIMITED: MCP_ERROR_REASONS.TARGET_LIMITED,
  // Missing / errored / offline. Separate retry semantics: no reset clock.
  TARGET_UNAVAILABLE: MCP_ERROR_REASONS.TARGET_UNAVAILABLE,
  INTERNAL_ERROR: MCP_ERROR_REASONS.INTERNAL_ERROR,
} as const satisfies Record<string, MCPErrorReason>;

const SEND_IDEMPOTENCY_WINDOW_MS = MEMORY_MCP_CAPS.SEND_MESSAGE_IDEMPOTENCY_WINDOW_MS;
const DEFAULT_TARGET_LIST_LIMIT = 50;
const MAX_TARGET_LIST_LIMIT = 100;
const MAX_BROADCAST_RECIPIENTS = 8;

/**
 * Map a typed {@link ExecutionCloneErrorCode} to the MCP error reason surfaced
 * on the `send_message` error result. The raw clone code is preserved in the
 * `error` string so callers (and tests) can discriminate the specific cause
 * even though the `reason` is a coarse MCP reason.
 */
function mapCloneErrorToMcpReason(code: ExecutionCloneErrorCode): SendToolErrorReason {
  switch (code) {
    case EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL:
      return MCP_ERROR_REASONS.WRITE_QUOTA_EXCEEDED;
    case EXECUTION_CLONE_ERROR_CODES.CLONE_OF_CLONE_FORBIDDEN:
    case EXECUTION_CLONE_ERROR_CODES.WORKER_CLONE_FORBIDDEN:
    case EXECUTION_CLONE_ERROR_CODES.CRON_CLONE_FORBIDDEN:
    case EXECUTION_CLONE_ERROR_CODES.DESTROY_FORBIDDEN:
      return MCP_ERROR_REASONS.SCOPE_FORBIDDEN;
    case EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE:
    case EXECUTION_CLONE_ERROR_CODES.TARGET_NOT_FOUND:
    default:
      return MCP_ERROR_REASONS.VALIDATION_FAILED;
  }
}

export interface SendRuntimeCaller {
  userId: string;
  sessionName: string | null;
  projectName: string | null;
  projectRoot: string | null;
}

export interface SendTargetInfo {
  target: string;
  label: string | null;
  sessionName: string;
  role: SessionRecord['role'];
  agentType: string;
  /** Effective concrete model when the session has reported or configured one. */
  model?: string;
  activeModel?: string;
  requestedModel?: string;
  modelDisplay?: string;
  qwenModel?: string;
  status: SessionRecord['state'];
  lastActiveAt: number;
  /**
   * Whether this target can actually take work right now.
   *
   * Distinct from `status`, which is the session's own runtime state and says
   * nothing about its upstream quota: a target can be perfectly `idle` and
   * still be refused by its provider, which is exactly the case an orchestrator
   * used to have no way to see. It would hand over the task, get silence, and
   * then try the next session on the same account and get silence again.
   */
  providerFamily: string;
  availability: DelegationAvailability;
  /**
   * Configured supervision pools whose canonical identity constraints match
   * this target. Present for configured callers only. An empty list means the
   * sibling remains discoverable for ordinary messaging but cannot receive a
   * task/audit send.
   */
  eligiblePools?: SupervisionExecutionPoolKind[];
  /** New supervised work may start now, queue behind a busy turn, or not use it. */
  dispatchMode?: 'new_work' | 'queue_only' | 'unavailable';
  /** Sessions sharing one upstream account share a group, and share its limit. */
  limitGroup: DelegationLimitGroup;
  replyCapable: boolean;
  limitedAt?: number;
  retryAt?: number;
  limitReason?: DelegationTargetAvailability['reason'];
}

export type SendToolErrorReason = (typeof SEND_TOOL_ERROR_REASONS)[keyof typeof SEND_TOOL_ERROR_REASONS];

export type SendListTargetsResult =
  | {
      status: 'ok';
      items: SendTargetInfo[];
      executionPoolsState: SupervisionExecutionPoolsConfig['state'];
      appliedExecutionPool?: SupervisionExecutionPoolKind;
    }
  | { status: 'disabled'; reason: typeof MCP_ERROR_REASONS.FEATURE_DISABLED; disabledFlag: typeof SEND_MCP_DISPATCH_FEATURE_FLAG; items: [] }
  | { status: 'error'; reason: SendToolErrorReason; error: string; items: [] };

/**
 * Strict nested execution-clone request on a `send_message`. When present, the
 * send is routed to a freshly created ephemeral execution clone of the resolved
 * target (template), NOT to the target directly. Shape is fixed: exactly
 * { kind: 'execution_clone', ephemeral: true, parentRunId, parentStage } — no
 * `ttlMs`, no extra keys (the MCP zod schema is `.strict()` and the
 * `pickAllowedMcpArgs` allowlist drops forged keys).
 */
export interface SendMessageCloneRequest {
  kind: typeof EXECUTION_CLONE_KIND;
  ephemeral: true;
  parentRunId: string;
  parentStage: ExecutionCloneParentStage;
}

export interface SendMessageInput {
  target?: string;
  message?: string;
  files?: string[];
  reply?: boolean;
  broadcast?: boolean;
  idempotencyKey?: string;
  /** Defaults to append; queue explicitly preserves ordinary durable FIFO. */
  deliveryMode?: MemoryMcpSendDeliveryMode;
  /** Strict supervision-only metadata. Never infer this purpose from message text. */
  audit?: AgentDelegationAuditRequest;
  /** Optional execution-clone request — see {@link SendMessageCloneRequest}. */
  clone?: SendMessageCloneRequest;
  /** Optional supervised task metadata; when present daemon creates/binds a durable task assignment. */
  task?: SupervisionTaskMetadata;
  /**
   * This send SPAWNS work rather than continuing a conversation (cron ticks,
   * clone bootstraps).
   *
   * Widens the provider-limit gate to refuse unhealthy and unresolvable targets
   * too. A human-initiated send to a struggling session is allowed to queue --
   * that is often how it gets woken -- but a scheduler firing into one just
   * grows a backlog nobody is draining. NOT settable from the MCP tool surface;
   * only internal callers that know they are creating work set it.
   */
  newWorkload?: boolean;
  /** Daemon-only provenance. The published MCP allowlist never accepts it. */
  automaticSupervision?: true;
  /** Daemon-only durable message identity for crash-recoverable control traffic. */
  internalMessageId?: SendMessageId;
  /** Daemon-only: persist to the transport queue before attempting delivery. */
  internalDurableQueue?: true;
}

export interface SendMessageDelivery {
  target: string;
  messageId?: SendMessageId;
  delegationId?: string;
  taskId?: string;
  assignmentId?: string;
  status: 'delivered' | 'queued' | 'failed';
  error?: string;
}

export type SendMessageResult =
  | {
      status: 'accepted';
      dispatchId: SendDispatchId;
      messageId?: SendMessageId;
      deliveries: SendMessageDelivery[];
      partial?: boolean;
      idempotentReplay?: boolean;
      /** Present only when the send created an execution clone (input.clone). */
      clone?: { target: string; sessionName: string; hardTimeoutAt: number };
      taskId?: string;
      assignmentId?: string;
      auditRoutingReason?: SupervisionAuditRoutingReason;
      auditDegradedReason?: SupervisionAuditDegradedReason;
      provisioning?: SupervisionProvisioningEvidence;
    }
  | { status: 'disabled'; reason: typeof MCP_ERROR_REASONS.FEATURE_DISABLED; disabledFlag: typeof SEND_MCP_DISPATCH_FEATURE_FLAG }
  | {
      status: 'error';
      reason: SendToolErrorReason;
      error: string;
      /**
       * Present only on a `target_limited` refusal.
       *
       * Machine-readable so the caller re-routes instead of re-reading prose.
       * `alternatives` is the point of the whole refusal: an orchestrator told
       * only "no" retries the same family, which is the exact behaviour this
       * feature exists to stop.
       */
      limited?: SendTargetLimitedInfo;
      auditRoutingReason?: 'no_cross_vendor_available';
      auditDegradedReason?: SupervisionAuditDegradedReason;
      provisioning?: SupervisionProvisioningEvidence;
    };

/**
 * A cron tick refused because its target's provider is out of quota.
 *
 * A distinct class so the executor can branch on the type instead of matching
 * the message: a limited target is a WAIT, and every other dispatch failure is
 * not, so collapsing them loses the only distinction the scheduler needs.
 */
export class CronSendTargetLimitedError extends Error {
  constructor(
    readonly reason: DelegationAdmissionReason,
    message: string,
    readonly limited: SendTargetLimitedInfo | undefined,
  ) {
    super(message);
    this.name = 'CronSendTargetLimitedError';
  }
}

/**
 * Why a send was refused, and where the work can go instead.
 *
 * Re-exported from the admission service rather than restated: a second shape
 * here would let the tool surface and the service drift apart.
 */
export type SendTargetLimitedInfo = DelegationRefusal;

export interface HookSendDispatchInput {
  from: string;
  targetRecords: SessionRecord[];
  message: string;
  files?: string[];
  projectRoot?: string | null;
  reply?: boolean;
  /** Internal MCP path only: prefer native append, retain FIFO fallback. */
  deliveryMode?: MemoryMcpSendDeliveryMode;
  /** This `/send` spawns work; see {@link SendMessageInput.newWorkload}. */
  newWorkload?: boolean;
  /** Registry binding supplied by the managed MCP bridge for supervised work. */
  supervision?: { taskId: string; assignmentId: string };
}

export interface HookSendDispatchResult {
  dispatchId: SendDispatchId;
  delivered: string[];
  queued: string[];
  errors: string[];
  messages: SendMessageDelivery[];
}

export interface SendToolDeps {
  now?: () => number;
  listSessions?: () => SessionRecord[];
  getSession?: (name: string) => SessionRecord | undefined;
  dispatchMessage?: (target: SessionRecord, message: string, options: SendDispatchMessageOptions) => Promise<SendDispatchMessageResult>;
  /** Force-stop a resolved target's active turn. Returns false when the target
   *  could not be stopped (e.g. session not found). Used by send_stop. */
  cancelSession?: (target: SessionRecord) => Promise<boolean>;
  isDispatchEnabled?: () => boolean;
  exactTargetOnly?: boolean;
  /**
   * Whether the daemon currently advertises {@link EXECUTION_CLONE_CAPABILITY_V1}.
   * The clone send/destroy path is gated on this; defaults to `true` because the
   * capability is part of the daemon's static advertisement. Injected by tests
   * to exercise the capability-missing branch.
   */
  isExecutionCloneCapabilityEnabled?: () => boolean;
  /**
   * Resolve the bounded clone routing limits to use for a clone-create on this
   * send, keyed by the clone's `parentRunId`. When it returns a preference,
   * those RESOLVED (clamped) limits are consumed for the create (so a configured
   * non-default — typically tighter, per-run — cap is enforced); when it is
   * absent or returns `undefined` (no run-authoritative limit source for that
   * run), the canonical defaults are used. The wiring layer (which already
   * imports the orchestrators) resolves the run-level limits by `parentRunId`;
   * `dispatchExecutionCloneSend` passes the validated id through.
   */
  resolveExecutionCloneLimits?: (parentRunId: string) => ReturnType<typeof defaultDedicatedExecutionRoutingPreference> | undefined;
  /**
   * Create an execution clone. Injected for tests; the default lazily delegates
   * to `createExecutionClone` from `./execution-clone.js`. The non-clone send
   * path NEVER invokes this — only the `if (input.clone)` branch does.
   */
  createExecutionClone?: (req: CreateExecutionCloneDepRequest) => Promise<CreateExecutionCloneDepResult>;
  /** Destroy an execution clone. Injected for tests; default delegates to `destroyExecutionClone`. */
  destroyExecutionClone?: (req: DestroyExecutionCloneDepRequest) => Promise<void>;
  /** Explicit Brain-authorized pool reuse/provisioning. Ordinary sends never call it. */
  provisionSupervisionTarget?: (req: SupervisionAutoProvisionRequest) => Promise<SupervisionAutoProvisionResult>;
  /** Create or verify the exact assignment worktree before worker delivery. */
  ensureSupervisionAssignmentWorktree?: (req: {
    projectRoot: string;
    sessionName: string;
    assignmentId: string;
    baseRevision?: string | null;
  }) => Promise<SupervisionWorktreeProvisionResult>;
  /**
   * Authoritative liveness check used when a refresh snapshot momentarily
   * omits a previously routable session. The MCP directory uses this to retain
   * only genuinely live omissions; explicit stopped/error records still win.
   */
  isSessionAuthoritativelyActive?: (session: SessionRecord) => boolean | Promise<boolean>;
}

/** Request passed to the injectable {@link SendToolDeps.createExecutionClone} hook. */
export interface CreateExecutionCloneDepRequest {
  templateSessionName: string;
  parentRunId: string;
  parentStage: ExecutionCloneParentStage;
  ownerSessionName: string;
  owningMainSessionName: string;
  pref: ReturnType<typeof defaultDedicatedExecutionRoutingPreference>;
}

/** Result returned by the injectable {@link SendToolDeps.createExecutionClone} hook. */
export interface CreateExecutionCloneDepResult {
  sessionName: string;
  target: string;
  metadata: { hardTimeoutAt: number };
}

/** Request passed to the injectable {@link SendToolDeps.destroyExecutionClone} hook. */
export interface DestroyExecutionCloneDepRequest {
  target: string;
  callerSessionName?: string;
  reason: string;
  bypassAuth?: boolean;
}

export interface SendDestroyExecutionCloneInput {
  target?: string;
  idempotencyKey?: string;
}

export type SendDestroyExecutionCloneResult =
  | { status: 'ok'; idempotentReplay?: boolean }
  | { status: 'error'; reason: ExecutionCloneErrorCode | SendToolErrorReason; idempotentReplay?: boolean };

export type SendDispatchMessageOptions = SessionDispatchOptions;

export type SendDispatchMessageResult = SessionDispatchMessageResult;

export interface CronSendDispatchInput {
  fromSessionName: string;
  target: string;
  message: string;
  reply?: boolean;
  broadcast?: boolean;
  idempotencyKey?: string;
}

export interface CronSendDispatchResult {
  dispatchId: SendDispatchId;
  status: 'dispatched' | 'partial';
  deliveries: Array<{
    target: string;
    messageId?: SendMessageId;
    status: SendMessageDelivery['status'];
    error?: string;
  }>;
}

interface IdempotencyEntry {
  expiresAt: number;
  result: Extract<SendMessageResult, { status: 'accepted' }>;
}

const idempotencyCache = new Map<string, IdempotencyEntry>();

interface DestroyCloneIdempotencyEntry {
  expiresAt: number;
  result: Extract<SendDestroyExecutionCloneResult, { status: 'ok' }>;
}

const destroyCloneIdempotencyCache = new Map<string, DestroyCloneIdempotencyEntry>();

/**
 * Idempotency cache for the clone-CREATE path (parallel to {@link idempotencyCache}
 * for ordinary sends). A HIT means a clone was already created+dispatched for the
 * same logical request; we MUST NOT create or dispatch a second clone. The cached
 * accepted result records the created clone target so a replay can verify the
 * clone still exists (HIT + alive → replay; HIT + gone → target_not_found, never
 * a recreate). Keyed on a fingerprint of the request (parentRunId, parentStage,
 * resolved template target, message hash) plus an optional caller idempotencyKey.
 */
interface CloneCreateIdempotencyEntry {
  expiresAt: number;
  cloneTarget: string;
  result: Extract<SendMessageResult, { status: 'accepted' }>;
}

const cloneCreateIdempotencyCache = new Map<string, CloneCreateIdempotencyEntry>();

function depsWithDefaults(deps: SendToolDeps = {}): Required<Pick<SendToolDeps, 'now' | 'listSessions' | 'getSession' | 'dispatchMessage' | 'isDispatchEnabled' | 'exactTargetOnly'>> {
  return {
    now: deps.now ?? Date.now,
    listSessions: deps.listSessions ?? (() => listSessions()),
    getSession: deps.getSession ?? getSession,
    dispatchMessage: deps.dispatchMessage ?? dispatchSessionMessage,
    isDispatchEnabled: deps.isDispatchEnabled ?? (() => true),
    exactTargetOnly: deps.exactTargetOnly ?? false,
  };
}

export function clearSendIdempotencyCacheForTests(): void {
  idempotencyCache.clear();
  destroyCloneIdempotencyCache.clear();
  cloneCreateIdempotencyCache.clear();
}

// ── Execution-clone hook defaults ────────────────────────────────────────────
//
// These lazily import `./execution-clone.js` so the execution-clone module is
// loaded ONLY when an execution-clone send/destroy is actually requested. The
// ordinary (non-clone) send path never reaches these helpers, preserving the
// structural-liveness contract: the non-clone ack path neither imports nor calls
// `createExecutionClone`.

async function defaultCreateExecutionClone(req: CreateExecutionCloneDepRequest): Promise<CreateExecutionCloneDepResult> {
  const { createExecutionClone } = await import('./execution-clone.js');
  return createExecutionClone(req);
}

async function defaultDestroyExecutionClone(req: DestroyExecutionCloneDepRequest): Promise<void> {
  const { destroyExecutionClone } = await import('./execution-clone.js');
  await destroyExecutionClone(req);
}

async function defaultProvisionSupervisionTarget(req: SupervisionAutoProvisionRequest): Promise<SupervisionAutoProvisionResult> {
  const { provisionSupervisionTarget } = await import('./supervision-auto-provision.js');
  return provisionSupervisionTarget(req);
}

async function defaultEnsureSupervisionAssignmentWorktree(req: {
  projectRoot: string;
  sessionName: string;
  assignmentId: string;
  baseRevision?: string | null;
}): Promise<SupervisionWorktreeProvisionResult> {
  const provisioner = await import('./supervision-worktree-provision.js');
  const base = await provisioner.resolveSupervisionWorktreeBase({
    projectRoot: req.projectRoot,
    requestedBaseRevision: req.baseRevision,
  });
  if (!base.ok) return base;
  return provisioner.ensureSupervisionAssignmentWorktree({ ...req, baseRevision: base.baseRevision });
}

const HOOK_WORKTREE_RECOVERY_STATUSES = new Set([
  'delegated',
  'implementing',
  'retrying_external_ci',
  'rework',
]);

function assignmentMatchesLiveTargetBase(
  assignment: ReturnType<ReturnType<typeof getSupervisionTaskRegistry>['getAssignment']>,
  target: SessionRecord,
): boolean {
  return Boolean(assignment
    && assignment.role === 'implementer'
    && assignment.required
    && HOOK_WORKTREE_RECOVERY_STATUSES.has(assignment.status)
    && assignment.identity.sessionName === target.name
    && assignment.identity.sessionInstanceId === target.sessionInstanceId
    && assignment.identity.runtimeEpoch === target.runtimeEpoch);
}

function assignmentMatchesLiveTarget(
  assignment: ReturnType<ReturnType<typeof getSupervisionTaskRegistry>['getAssignment']>,
  target: SessionRecord,
): boolean {
  return assignmentMatchesLiveTargetBase(assignment, target)
    && assignment?.identity.agentType === target.agentType
    && assignment.identity.providerFamily === resolvePeerAuditProviderFamily(target);
}

async function ensureHookSupervisionAssignmentWorktree(input: {
  callerRecord?: SessionRecord;
  projectRoot?: string | null;
  target: SessionRecord;
  binding?: { taskId: string; assignmentId: string };
  ensure?: SendToolDeps['ensureSupervisionAssignmentWorktree'];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const registry = getSupervisionTaskRegistry();
  let task = input.binding ? registry.get(input.binding.taskId) : undefined;
  let assignment = input.binding ? registry.getAssignment(input.binding.assignmentId) : undefined;

  if (input.binding) {
    if (!task || !assignment
      || assignment.taskId !== task.taskId
      || !assignmentMatchesLiveTarget(assignment, input.target)
      || (input.callerRecord?.projectName && task.projectName !== input.callerRecord.projectName)) {
      return { ok: false, error: 'supervision binding does not match the live task, implementer, and target identity' };
    }
  } else {
    // Compatibility backstop for an already-running MCP bridge that predates
    // the explicit transport binding. Only a UNIQUE active implementer whose
    // exact worktree path is absent can be recovered; existing (possibly dirty)
    // worktrees are never reset, cleaned, or made a reason to block ordinary
    // messages.
    if (!input.callerRecord?.projectName) return { ok: true };
    const candidates = registry.list({
      projectName: input.callerRecord.projectName,
      ownerSessionName: input.target.name,
    }).flatMap((candidateTask) => candidateTask.assignments
      .filter((candidateAssignment) => assignmentMatchesLiveTargetBase(candidateAssignment, input.target))
      .map((candidateAssignment) => ({ task: candidateTask, assignment: candidateAssignment })));
    if (candidates.some(({ assignment: candidateAssignment }) => (
      !assignmentMatchesLiveTarget(candidateAssignment, input.target)
    ))) {
      return { ok: false, error: 'active implementer identity does not match the live target agent/provider' };
    }
    const missing = candidates
      .filter(({ assignment: candidateAssignment }) => !existsSync(resolveSupervisionAssignmentWorktree({
        sessionName: input.target.name,
        assignmentId: candidateAssignment.assignmentId,
      })));
    if (missing.length === 0) return { ok: true };
    if (missing.length !== 1) {
      return { ok: false, error: `ambiguous missing assignment worktrees for target (${missing.length})` };
    }
    task = missing[0].task;
    assignment = missing[0].assignment;
  }

  const projectRoot = input.projectRoot?.trim() || input.callerRecord?.projectDir?.trim();
  if (!projectRoot || !task || !assignment) {
    return { ok: false, error: 'assignment worktree provisioning requires an authoritative project root and binding' };
  }
  const ensured = await (input.ensure ?? defaultEnsureSupervisionAssignmentWorktree)({
    projectRoot,
    sessionName: input.target.name,
    assignmentId: assignment.assignmentId,
    baseRevision: task.baseRevision,
  });
  if (!ensured.ok) {
    return { ok: false, error: `assignment worktree provisioning blocked: ${ensured.reason}: ${ensured.detail}` };
  }
  if (task.baseRevision !== ensured.baseRevision) {
    const baseBound = registry.updateTask({ taskId: task.taskId, baseRevision: ensured.baseRevision });
    if (!baseBound.ok) {
      return { ok: false, error: `assignment worktree base binding rejected: ${baseBound.reason}` };
    }
  }
  return { ok: true };
}

/** Narrow an unknown error to its `ExecutionCloneError.code` when present. */
function executionCloneErrorCode(err: unknown): ExecutionCloneErrorCode | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    const known = Object.values(EXECUTION_CLONE_ERROR_CODES) as string[];
    if (typeof code === 'string' && known.includes(code)) return code as ExecutionCloneErrorCode;
  }
  return null;
}

export function listSendTargets(
  caller: SendRuntimeCaller,
  input: { query?: string; limit?: number; executionPool?: SupervisionExecutionPoolKind } = {},
  deps?: SendToolDeps,
): SendListTargetsResult {
  const d = depsWithDefaults(deps);
  if (!d.isDispatchEnabled()) {
    return { status: 'disabled', reason: MCP_ERROR_REASONS.FEATURE_DISABLED, disabledFlag: SEND_MCP_DISPATCH_FEATURE_FLAG, items: [] };
  }
  if (!caller.sessionName) {
    return { status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN, error: 'send_list_targets requires a scoped caller', items: [] };
  }
  const allSessions = d.listSessions();
  const callerProjectName = effectiveCallerProjectName(caller, allSessions);
  if (!callerProjectName) {
    return { status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN, error: 'send_list_targets requires a scoped caller', items: [] };
  }

  const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
  const rawLimit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.floor(input.limit) : DEFAULT_TARGET_LIST_LIMIT;
  const limit = Math.max(0, Math.min(MAX_TARGET_LIST_LIMIT, rawLimit));
  const callerRecord = allSessions.find((session) => session.name === caller.sessionName);
  const executionPools = readSupervisionSnapshotFromTransportConfig(callerRecord?.transportConfig).executionPools;
  const requestedPool = input.executionPool;
  // Default discovery remains the ordinary-messaging surface: every scoped,
  // discoverable sibling. Pool filtering is explicit and fail-closed for a
  // legacy-unconfigured caller; supervised sends independently revalidate the
  // exact target below and never trust this projection as authority.
  const candidates = getSiblingSessions({ ...caller, projectName: callerProjectName }, allSessions)
    .map((target) => ({
      target,
      eligiblePools: eligibleSupervisionPoolsForTarget(executionPools, target),
    }))
    .filter(({ eligiblePools }) => requestedPool === undefined || eligiblePools.includes(requestedPool));
  const filtered = query
    ? candidates.filter(({ target }) => [
        target.name,
        target.label,
        target.role,
        target.agentType,
        resolveEffectiveSessionModel(target),
        target.activeModel,
        target.requestedModel,
        target.modelDisplay,
        target.qwenModel,
      ].some((value) => String(value ?? '').toLowerCase().includes(query)))
    : candidates;

  // Resolved over ALL sessions, before the query filter and the slice. Group
  // evidence lives on whichever session met the provider, and that session may
  // be filtered out or fall past the limit -- resolving after either would
  // report a limited family as healthy precisely when the caller narrowed its
  // search. Same resolver as `dispatchSendMessage`, so a target this list
  // offers is never one the next send refuses.
  const availability = resolveDelegationTargets(delegationTargetInputs(allSessions), d.now());
  return {
    status: 'ok',
    executionPoolsState: executionPools.state,
    ...(requestedPool === undefined ? {} : { appliedExecutionPool: requestedPool }),
    items: filtered.slice(0, limit).map(({ target, eligiblePools }) => toTargetInfo(
      target,
      availability.get(target.name) ?? {
        availability: DELEGATION_AVAILABILITY.UNKNOWN,
        limitGroup: delegationLimitGroup(target.agentType),
      },
      executionPools.state === 'configured' ? eligiblePools : undefined,
    )),
  };
}

function supervisionObservedIdentityForTarget(
  target: SessionRecord,
): Partial<SupervisionObservedExecutionIdentity> {
  return {
    sessionName: target.name,
    sessionInstanceId: target.sessionInstanceId,
    runtimeEpoch: target.runtimeEpoch,
    agentType: target.agentType,
    providerFamily: resolvePeerAuditProviderFamily(target),
    runtimeType: target.runtimeType ?? getSessionRuntimeType(target.agentType),
    model: resolveEffectiveSessionModel(target),
    ccPresetId: target.ccPreset,
  };
}

function targetMatchesConfiguredSupervisionPool(
  pools: SupervisionExecutionPoolsConfig,
  pool: SupervisionExecutionPoolKind,
  target: SessionRecord,
  actual = supervisionObservedIdentityForTarget(target),
): boolean {
  if (pools.state !== 'configured') return false;
  const definition = pool === 'primary'
    ? pools.primaryDevelopmentPool
    : pools.economyTaskPool;
  return definition.configs.some((config) => evaluateSupervisionObservedIdentity({
    config,
    actual,
    pool,
  }).ok);
}

function eligibleSupervisionPoolsForTarget(
  pools: SupervisionExecutionPoolsConfig,
  target: SessionRecord,
): SupervisionExecutionPoolKind[] {
  if (pools.state !== 'configured') return [];
  return (['primary', 'economy'] as const).filter((pool) => (
    targetMatchesConfiguredSupervisionPool(pools, pool, target)
  ));
}

function deterministicSendMessageId(seed: string): SendMessageId {
  const hex = createHash('sha256').update(seed).digest('hex');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return `send_message_${uuid}`;
}


function supervisionTaskIdentityForTarget(target: SessionRecord): PersistedSupervisionTaskAssignmentIdentity | undefined {
  if (!target.sessionInstanceId || !target.runtimeEpoch) return undefined;
  return {
    sessionName: target.name,
    sessionInstanceId: target.sessionInstanceId,
    runtimeEpoch: target.runtimeEpoch,
    agentType: target.agentType,
    providerFamily: resolvePeerAuditProviderFamily(target),
  };
}

export async function dispatchSendMessage(
  caller: SendRuntimeCaller,
  input: SendMessageInput,
  deps?: SendToolDeps,
): Promise<SendMessageResult> {
  const d = depsWithDefaults(deps);
  if (!d.isDispatchEnabled()) {
    return { status: 'disabled', reason: MCP_ERROR_REASONS.FEATURE_DISABLED, disabledFlag: SEND_MCP_DISPATCH_FEATURE_FLAG };
  }

  if (!caller.sessionName) {
    return { status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN, error: 'send_message requires a scoped caller' };
  }
  let allSessions = d.listSessions();
  const callerProjectName = effectiveCallerProjectName(caller, allSessions);
  if (!callerProjectName) {
    return { status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN, error: 'send_message requires a scoped caller' };
  }
  const autoProvision = input.task?.autoProvision === true;
  if (!input.target && !input.broadcast && !autoProvision) {
    return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: 'target is required unless broadcast is true' };
  }
  if (autoProvision && (input.target || input.broadcast || input.clone || !input.idempotencyKey?.trim())) {
    return {
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
      error: 'task.autoProvision requires no target/broadcast/clone and a non-empty idempotencyKey',
    };
  }
  if (!input.message || input.message.trim().length === 0) {
    return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: 'message is required' };
  }
  if (input.deliveryMode !== undefined
    && !Object.values(MEMORY_MCP_SEND_DELIVERY_MODES).includes(input.deliveryMode)) {
    return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: 'deliveryMode is invalid' };
  }
  if (input.task?.taskId?.trim()
    && input.deliveryMode === MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE) {
    return {
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
      error: 'an existing task continuation must use deliveryMode=append; queue would fork the logical task',
    };
  }
  if (input.task?.assignmentId?.trim() && !input.task.taskId?.trim()) {
    return {
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
      error: 'task.assignmentId requires an existing taskId',
    };
  }
  if (input.audit && input.task?.assignmentId?.trim()) {
    return {
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
      error: 'audit registration cannot reuse an implementer assignmentId',
    };
  }
  if (Buffer.byteLength(input.message, 'utf8') > MEMORY_MCP_CAPS.SEND_MESSAGE_MAX_BYTES) {
    return { status: 'error', reason: MCP_ERROR_REASONS.WRITE_QUOTA_EXCEEDED, error: `message exceeds ${MEMORY_MCP_CAPS.SEND_MESSAGE_MAX_BYTES} bytes` };
  }
  if (input.audit && (
    input.audit.kind !== AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT
    || !isAgentDelegationOpaqueId(input.audit.attemptId)
    || (input.audit.strictCrossVendor !== undefined && input.audit.strictCrossVendor !== true)
    || input.reply !== true
    || input.broadcast === true
    || Boolean(input.clone)
  )) {
    return {
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
      error: 'audit metadata requires one exact reply-enabled non-clone target and a valid attemptId',
    };
  }

  if (input.task && (input.broadcast === true || Boolean(input.clone))) {
    return {
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
      error: 'task metadata requires one exact non-clone target',
    };
  }

  // ── Execution-clone branch ──────────────────────────────────────────────
  // STRUCTURAL LIVENESS: only this branch references the execution-clone create
  // path. The ordinary (non-clone) send path below NEVER imports or calls
  // `createExecutionClone`, so the daemon-receipt ack is never gated on clone
  // creation. Cron-issued sends (`userId === 'cron'`) may never create clones.
  if (input.clone) {
    if (caller.userId === 'cron') {
      return { status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN, error: `cron sends may not create execution clones (${EXECUTION_CLONE_ERROR_CODES.CRON_CLONE_FORBIDDEN})` };
    }
    return dispatchExecutionCloneSend({ ...caller, projectName: callerProjectName }, input, input.clone, allSessions, d, deps);
  }

  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  const idempotencyTarget = input.broadcast ? '*'
    : autoProvision
      ? `@pool:${input.audit ? 'audit' : input.task?.executionPool ?? 'primary'}:${input.task?.requestedExecutionType?.capabilityId ?? '*'}`
      : input.target ?? '';
  const cacheKey = idempotencyKey ? `${caller.userId}\0${caller.sessionName}\0${idempotencyTarget}\0${idempotencyKey}` : '';
  const now = d.now();
  const ensureAssignmentWorktree = async (taskId: string, assignmentId: string, sessionName: string) => {
    if (!caller.projectRoot) {
      return { ok: false as const, error: 'assignment worktree provisioning requires the caller project root' };
    }
    const registry = getSupervisionTaskRegistry();
    const task = registry.get(taskId);
    const ensured = await (deps?.ensureSupervisionAssignmentWorktree
      ?? defaultEnsureSupervisionAssignmentWorktree)({
        projectRoot: caller.projectRoot,
        sessionName,
        assignmentId,
        baseRevision: task?.baseRevision ?? input.task?.baseRevision,
      });
    if (!ensured.ok) {
      return { ok: false as const, error: `assignment worktree provisioning blocked: ${ensured.reason}: ${ensured.detail}` };
    }
    if (task?.baseRevision !== ensured.baseRevision) {
      const baseBound = registry.updateTask({ taskId, baseRevision: ensured.baseRevision, now });
      if (!baseBound.ok) {
        return { ok: false as const, error: `assignment worktree base binding rejected: ${baseBound.reason}` };
      }
    }
    return { ok: true as const, value: ensured };
  };
  if (cacheKey) {
    const cached = idempotencyCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      if (cached.result.taskId && cached.result.assignmentId) {
        const assignment = getSupervisionTaskRegistry().getAssignment(cached.result.assignmentId);
        if (assignment?.role === 'implementer') {
          const ensured = await ensureAssignmentWorktree(cached.result.taskId, cached.result.assignmentId, assignment.identity.sessionName);
          if (!ensured.ok) return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: ensured.error };
        }
      }
      return { ...cached.result, idempotentReplay: true };
    }
    if (cached) idempotencyCache.delete(cacheKey);
  }

  let resolvedInput = input;
  let provisioning: SupervisionProvisioningEvidence | undefined;
  let auditRoutingReason: SupervisionAuditRoutingReason | undefined;
  let auditDegradedReason: SupervisionAuditDegradedReason | undefined;
  if (autoProvision) {
    const provision = await (deps?.provisionSupervisionTarget ?? defaultProvisionSupervisionTarget)({
      parentSessionName: caller.sessionName,
      pool: input.task?.executionPool ?? 'primary',
      requestedCapabilityId: input.task?.requestedExecutionType?.capabilityId,
      idempotencyKey,
      auditedSessionName: input.audit?.auditedSessionName,
      strictCrossVendor: input.audit?.strictCrossVendor,
    });
    provisioning = provision.evidence;
    auditDegradedReason = provision.auditDegradedReason;
    if (!provision.ok) {
      return {
        status: 'error',
        reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
        error: `supervision target provisioning blocked: ${provision.reason}`,
        auditRoutingReason: input.audit ? 'no_cross_vendor_available' : undefined,
        ...(provision.auditDegradedReason ? { auditDegradedReason: provision.auditDegradedReason } : {}),
        provisioning: provision.evidence,
      };
    }
    auditRoutingReason = provision.auditRoutingReason;
    resolvedInput = { ...input, target: provision.target.name };
    allSessions = d.listSessions();
  }

  // Ordinary exact send: an exact `target === clone.name` may resolve to an
  // execution clone, but ONLY for that clone's creator (`exactCreatorOnly`).
  // Clones are never matched by label/agentType; normal sibling resolution is
  // unchanged (clones are excluded from the discoverable sibling set).
  const targets = resolveScopedTargets({ ...caller, projectName: callerProjectName }, resolvedInput, allSessions, d.exactTargetOnly, 'exactCreatorOnly');
  if (!targets.ok) return { status: 'error', reason: targets.reason, error: targets.error };

  // ── Provider-limit gate ────────────────────────────────────────────────
  // Same resolver, same inputs as `send_list_targets`, so the list and the send
  // can never disagree about one target. Refusing here rather than queueing is
  // the whole point: a message dropped into a limited session's FIFO looks
  // accepted and then sits there, so the orchestrator learns nothing and waits.
  const existingTaskContinuation = Boolean(input.task?.taskId?.trim());
  const gate = evaluateDelegationAdmission(allSessions, targets.targets, now, {
    newWorkload: input.newWorkload === true
      || Boolean(input.task && !existingTaskContinuation)
      || Boolean(input.audit)
      || autoProvision,
  });
  const blockedTargets = gate.blocked;
  const dispatchable = gate.dispatchable;
  if (dispatchable.length === 0 && blockedTargets.length > 0) {
    // Alternatives come from the caller's OWN discoverable sibling set, never
    // from the account-wide evidence pool: suggesting a target the caller may
    // not address would leak other projects' sessions and hidden clones.
    const refusal = buildDelegationRefusal(
      blockedTargets,
      getSiblingSessions({ ...caller, projectName: callerProjectName }, allSessions),
      gate.availability,
    );
    return {
      status: 'error',
      reason: refusal.reason,
      error: blockedTargets.length === 1
        ? `target ${blockedTargets[0]!.target} is ${blockedTargets[0]!.reason}`
        : `every resolved target is unavailable (${refusal.reason})`,
      limited: refusal,
    };
  }

  // An UNKNOWN provider/runtime state remains list-visible for diagnostics,
  // but it is not evidence that a new supervised workload can start. The
  // shared admission service already removes limited/offline targets; close
  // the final unknown-state gap here before any registry or reply side effect.
  if (input.task && !existingTaskContinuation && dispatchable.some((target) => (
    gate.availability.get(target.name)?.availability === DELEGATION_AVAILABILITY.UNKNOWN
  ))) {
    return {
      status: 'error',
      reason: MCP_ERROR_REASONS.TARGET_UNAVAILABLE,
      error: 'task target availability is unknown',
    };
  }

  if (input.task && dispatchable.length !== 1) {
    return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: 'task metadata requires exactly one dispatchable target' };
  }

  const fileRefs = sanitizeFileReferences(input.files, caller.projectRoot);
  if (!fileRefs.ok) return { status: 'error', reason: fileRefs.reason, error: fileRefs.error };

  // THE single audit-route validator. Both the audit-only path and the task
  // path call exactly this, so they can never diverge in strictness.
  //
  // The audited session comes from the Brain-supplied `auditedSessionName` and
  // from nowhere else: not the caller (on a Brain-dispatched audit the caller is
  // the Brain), not the target, not task metadata, not provider/model, not
  // ancestry, not candidate ordering.
  const validateBrainAuditRoute = (auditTarget: SessionRecord):
    | { ok: true }
    | { ok: false; reason: typeof MCP_ERROR_REASONS.IDENTITY_REJECTED | typeof MCP_ERROR_REASONS.VALIDATION_FAILED; error: string } => {
    const route = validateBrainAuditRouteAuthority({
      auditedSessionName: input.audit?.auditedSessionName,
      targetName: auditTarget.name,
      allSessions,
    });
    if (route.ok) return { ok: true };
    return {
      ok: false,
      reason: route.refusal === 'self_audit'
        ? MCP_ERROR_REASONS.IDENTITY_REJECTED
        : MCP_ERROR_REASONS.VALIDATION_FAILED,
      error: route.detail,
    };
  };

  if (input.audit) {
    const auditTarget = dispatchable[0];
    if (!auditTarget) return { status: 'error', reason: MCP_ERROR_REASONS.IDENTITY_REJECTED, error: 'audit target is unavailable' };
    const routeCheck = validateBrainAuditRoute(auditTarget);
    if (!routeCheck.ok) return { status: 'error', reason: routeCheck.reason, error: routeCheck.error };
    // Explicit pool provisioning already evaluated cross-vendor preference,
    // quota/offline evidence, strict mode and the configured-pool boundary.
    // Re-running the account-wide candidate policy here would incorrectly let
    // an unselected historical session override the user's pool configuration.
    if (!provisioning || !auditRoutingReason) {
      const policy = evaluateBrainAuditRoutePolicy({
        auditedSessionName: input.audit.auditedSessionName,
        targetName: auditTarget.name,
        allSessions,
        availability: gate.availability,
        strictCrossVendor: input.audit.strictCrossVendor,
      });
      if (!policy.ok) {
        return {
          status: 'error',
          reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
          error: policy.detail,
          auditRoutingReason: 'no_cross_vendor_available',
          auditDegradedReason: policy.degradedReason,
          ...(provisioning ? { provisioning } : {}),
        };
      }
      auditRoutingReason = policy.auditRoutingReason;
      auditDegradedReason = policy.auditRoutingReason === 'same_family_degraded'
        ? policy.degradedReason : undefined;
    }
  }

  let supervisedTaskId: string | undefined;
  let supervisedAssignmentId: string | undefined;
  let supervisedExecutionBinding: SupervisionExecutionBinding | undefined;
  let supervisedWorktree: Extract<SupervisionWorktreeProvisionResult, { ok: true }> | undefined;
  let reusedContinuationAssignment: ReturnType<ReturnType<typeof getSupervisionTaskRegistry>['getAssignment']>;

  if (input.task) {
    const targetRecord = dispatchable[0]!;
    const targetIdentity = supervisionTaskIdentityForTarget(targetRecord);
    if (!targetIdentity) return { status: 'error', reason: MCP_ERROR_REASONS.IDENTITY_REJECTED, error: 'task target identity is unavailable' };
    // Task metadata turns both implementation AND audit sends into supervised
    // execution. Validate the exact target against the caller's current pool
    // before touching the registry, claims, reply authority or transport.
    // Audit eligibility is an additional gate below, never a pool bypass.
    const callerRecord = allSessions.find((session) => session.name === caller.sessionName);
    const actual = supervisionObservedIdentityForTarget(targetRecord);
    const pool = input.task.executionPool ?? 'primary';
    const pools = readSupervisionSnapshotFromTransportConfig(callerRecord?.transportConfig).executionPools;
    const checked = evaluateSupervisionExecutionBinding({
      pools,
      pool,
      actual,
      requestedCapabilityId: input.task.requestedExecutionType?.capabilityId,
      economyPolicy: input.task.economyPolicy ?? undefined,
    });
    if (!targetMatchesConfiguredSupervisionPool(pools, pool, targetRecord, actual) || !checked.ok) {
      return {
        status: 'error',
        reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
        error: `task execution pool rejected target: ${checked.ok ? 'unselected_config' : checked.reason}`,
      };
    }
    const executionBinding: SupervisionExecutionBinding = {
      pool,
      requested: checked.requested,
      actual: actual as SupervisionObservedExecutionIdentity,
      origin: provisioning?.createdSessionName ? 'spawned' : 'reused',
    };
    supervisedExecutionBinding = executionBinding;
    if (input.audit) {
      // Same single validator as the audit-only path above; already run.
      const taskRouteCheck = validateBrainAuditRoute(targetRecord);
      if (!taskRouteCheck.ok) return { status: 'error', reason: taskRouteCheck.reason, error: taskRouteCheck.error };
    }
    const registry = getSupervisionTaskRegistry();
    const requestedTaskId = input.task.taskId?.trim();
    const newTaskCoordinatorIdentity = !requestedTaskId && callerRecord?.role === 'brain'
      ? supervisionTaskIdentityForTarget(callerRecord)
      : undefined;
    if (!requestedTaskId && callerRecord?.role === 'brain' && !newTaskCoordinatorIdentity) {
      return { status: 'error', reason: MCP_ERROR_REASONS.IDENTITY_REJECTED, error: 'task coordinator identity is unavailable' };
    }
    let taskId: string;
    if (requestedTaskId) {
      const existing = registry.get(requestedTaskId);
      // Explicit task ids are references, never create requests. Keep missing
      // and unauthorized indistinguishable so send_message is not a task-id
      // existence oracle. Project/role alone is not ownership: even a Brain
      // may continue only a task to which the registry authoritatively binds
      // its exact session identity.
      if (!existing
        || existing.projectName !== callerProjectName
        || !supervisionCallerParticipates(existing, caller.sessionName)) {
        return {
          status: 'error',
          reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
          error: 'task is not visible to this caller',
        };
      }
      if (input.audit && !isAuditableSupervisionTaskClassification(existing.classification)) {
        return {
          status: 'error',
          reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
          error: 'integration_slice cannot register an audit; merge validated slices into one integration_task revision first',
        };
      }
      if (!input.audit) {
        const implementers = existing.assignments.filter((assignment) => assignment.role === 'implementer');
        if (input.task.assignmentId?.trim() && implementers.length === 0) {
          return {
            status: 'error',
            reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
            error: 'task continuation assignmentId is not an exact reusable implementer assignment',
          };
        }
        if (implementers.length > 0) {
          const requestedAssignmentId = input.task.assignmentId?.trim();
          const reusableImplementers = implementers.filter((assignment) => (
            ['delegated', 'implementing', 'retrying_external_ci', 'rework', 'validated', 'ready_for_audit', 'recovered'] as const
          ).includes(assignment.status as 'delegated' | 'implementing' | 'retrying_external_ci' | 'rework' | 'validated' | 'ready_for_audit' | 'recovered'));
          const continuation = requestedAssignmentId
            ? reusableImplementers.find((assignment) => assignment.assignmentId === requestedAssignmentId)
            : reusableImplementers.length === 1 ? reusableImplementers[0] : undefined;
          if (!continuation) {
            return {
              status: 'error',
              reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
              error: requestedAssignmentId
                ? 'task continuation assignmentId is not an exact reusable implementer assignment'
                : 'task continuation has no unique reusable implementer assignment; provide the exact assignmentId or use authoritative recovery',
            };
          }
          const sameTarget = continuation.identity.sessionName === targetIdentity.sessionName
            && continuation.identity.sessionInstanceId === targetIdentity.sessionInstanceId
            && continuation.identity.runtimeEpoch === targetIdentity.runtimeEpoch
            && continuation.identity.agentType === targetIdentity.agentType
            && continuation.identity.providerFamily === targetIdentity.providerFamily;
          if (!sameTarget) {
            return {
              status: 'error',
              reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
              error: 'task continuation must append to the authoritative active implementer assignment',
            };
          }
          // ownedFiles/sharedFiles are append-only attribution hints, not an
          // edit ACL. The assignment worktree is the implementation boundary;
          // stale or incomplete metadata must not deadlock a continuation.
          if (input.task.currentRevision && existing.currentRevision
            && input.task.currentRevision !== existing.currentRevision) {
            return {
              status: 'error',
              reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
              error: 'task continuation revision does not match the authoritative task revision',
            };
          }
          reusedContinuationAssignment = continuation;
        }
      }
      taskId = existing.taskId;
    } else {
      const classification = input.task.classification ?? 'integration_slice';
      const taskAuditPolicy = isAuditableSupervisionTaskClassification(classification)
        ? supervisionTaskAuditPolicyFromSnapshot(readSupervisionSnapshotFromTransportConfig(callerRecord?.transportConfig))
        : undefined;
      if (input.audit && !isAuditableSupervisionTaskClassification(classification)) {
        return {
          status: 'error',
          reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
          error: 'audit task metadata must classify the combined revision as integration_task or independent_top_level',
        };
      }
      const task = registry.createOrGet({
        projectName: callerProjectName,
        topLevelTaskId: input.task.topLevelTaskId,
        classification,
        objective: input.task.objective,
        acceptance: input.task.acceptance,
        ...(taskAuditPolicy ? { auditPolicy: taskAuditPolicy } : {}),
        baseRevision: input.task.baseRevision,
        currentRevision: input.task.currentRevision,
        idempotencyKey: idempotencyKey ? `send:${idempotencyKey}` : undefined,
        now,
      });
      if (!task.ok) return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: `task registry rejected task: ${task.reason}` };
      taskId = task.value.taskId;

      // Bind the creating Brain as a non-blocking coordinator. This is the
      // durable attribution that permits a later explicit-task continuation;
      // without it, widening visibility to every same-project Brain turns an
      // opaque task id into authority over another owner's task. Reuse the
      // send idempotency key so a post-restart replay cannot mint duplicates.
      if (newTaskCoordinatorIdentity) {
        const coordinator = registry.createAssignment({
          taskId,
          role: 'coordinator',
          identity: newTaskCoordinatorIdentity,
          scopeFiles: [],
          required: false,
          idempotencyKey: idempotencyKey ? `send:${idempotencyKey}` : undefined,
          // Registry snapshots order by createdAt. Keep the delegated target
          // as the primary/first assignment for existing consumers while
          // recording coordinator attribution immediately after it.
          now: now + 1,
        });
        if (!coordinator.ok) {
          return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: `task registry rejected coordinator attribution: ${coordinator.reason}` };
        }
      }
    }
    const assignment = reusedContinuationAssignment
      ? { ok: true as const, value: reusedContinuationAssignment, replay: true as const }
      : registry.createAssignment({
          taskId,
          role: input.audit ? 'auditor' : 'implementer',
          identity: targetIdentity,
          scopeFiles: [...(input.task.ownedFiles ?? []), ...(input.task.sharedFiles ?? [])],
          claimMode: input.audit ? 'read_only' : 'exclusive',
          auditAttemptId: input.task.auditAttemptId ?? input.audit?.attemptId,
          auditRevision: input.task.auditRevision ?? input.task.currentRevision,
          ...(executionBinding ? { executionBinding } : {}),
          ...(input.task.economyPolicy ? { economyPolicy: input.task.economyPolicy } : {}),
          ...(auditRoutingReason ? { auditRoutingReason } : {}),
          ...(auditDegradedReason ? { auditDegradedReason } : {}),
          ...(provisioning ? { provisioning } : {}),
          idempotencyKey: idempotencyKey ? `send:${idempotencyKey}` : undefined,
          now,
      });
    if (!assignment.ok) return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: `task registry rejected assignment: ${assignment.reason}` };

    supervisedTaskId = taskId;
    supervisedAssignmentId = assignment.value.assignmentId;
    if (!input.audit) {
      const ensured = await ensureAssignmentWorktree(taskId, assignment.value.assignmentId, targetIdentity.sessionName);
      if (!ensured.ok) {
        return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: ensured.error };
      }
      supervisedWorktree = ensured.value;
    }
  }

  const delegatedAuditRevision = input.task
    ? String(input.task.auditRevision ?? input.task.currentRevision ?? '').trim()
    : '';
  const dispatchId = createSendDispatchId();
  const callerRecord = allSessions.find((session) => session.name === caller.sessionName);
  const deliveries: SendMessageDelivery[] = [];

  // A partial broadcast still reports the limited recipients. Dropping them
  // silently would let the caller read "accepted" and believe every sibling got
  // the message.
  for (const blockedTarget of blockedTargets) {
    deliveries.push({
      target: blockedTarget.target,
      status: 'failed',
      error: `${blockedTarget.reason}: target cannot accept work`,
    });
  }

  for (const target of dispatchable) {
    const messageId = input.internalMessageId
      ?? (input.automaticSupervision && supervisedAssignmentId && input.audit
        ? deterministicSendMessageId(`auto-audit:${supervisedAssignmentId}:${input.audit.attemptId}`)
        : createSendMessageId());
    // A newly registered assignment must always have an authenticated return
    // path. Without this, a worker that hits illegal_transition or a contract
    // contradiction can only print NEEDS_INPUT in its own transcript and
    // silently strand the coordinating Brain. Existing continuations retain
    // that assignment's original channel; ordinary untracked messages keep
    // their opt-in reply behavior.
    // A continuation appends to an already-authorized assignment and must not
    // mint a second reply authority/card merely to deliver an addendum. The
    // original assignment's append-only reply channel remains authoritative;
    // callers can still explicitly request a fresh ordinary reply channel.
    const replyRequired = !reusedContinuationAssignment && (
      input.reply === true || Boolean(supervisedTaskId && supervisedAssignmentId)
    );
    const replyAuthority = replyRequired
      ? createDelegationReplyAuthority({
          origin: callerRecord,
          target,
          dispatchId,
          messageId,
          ...(input.audit ? { audit: input.audit } : {}),
          ...(input.audit && delegatedAuditRevision
            ? { auditRevision: delegatedAuditRevision }
            : {}),
          ...(supervisedTaskId ? { taskId: supervisedTaskId } : {}),
          ...(supervisedAssignmentId ? { assignmentId: supervisedAssignmentId } : {}),
          now,
        })
      : null;
    if (replyRequired && !replyAuthority) {
      deliveries.push({
        target: target.name,
        status: 'failed',
        error: 'reply-capable session identity is unavailable',
      });
      continue;
    }
    const taskBlockerContract = supervisedTaskId && supervisedAssignmentId
      ? buildAgentDelegationBlockerReportInstruction({
          taskId: supervisedTaskId,
          assignmentId: supervisedAssignmentId,
        })
      : '';
    const assignmentMessage = [
      ...(supervisedExecutionBinding && !reusedContinuationAssignment ? [
          JSON.stringify({
            contractRefs: [SUPERVISION_CONTRACT_IDS.DELEGATION_ELIGIBILITY, SUPERVISION_CONTRACT_IDS.MESSAGING],
            binding: {
              mode: 'new_assignment',
              taskId: supervisedTaskId,
              assignmentId: supervisedAssignmentId,
              pool: supervisedExecutionBinding.pool,
              requested: supervisedExecutionBinding.requested,
              actual: supervisedExecutionBinding.actual,
            },
          }),
          '',
        ] : []),
      ...(supervisedWorktree && !reusedContinuationAssignment ? [
        '[Authoritative assignment worktree]',
        `Path: ${supervisedWorktree.worktreePath}`,
        `Base: ${supervisedWorktree.baseRevision}`,
        '',
      ] : []),
      ...(input.automaticSupervision && input.audit ? [
        JSON.stringify({
          automaticAudit: true,
          eligibilityDecision: auditRoutingReason,
          ...(auditDegradedReason ? { degradedReason: auditDegradedReason } : {}),
        }),
        '',
      ] : []),
      input.message,
      ...(taskBlockerContract ? ['', taskBlockerContract] : []),
    ].join('\n');
    const message = buildSessionDispatchMessage({
      message: assignmentMessage,
      files: fileRefs.files,
      replyTo: replyRequired ? caller.sessionName : null,
      ...(replyAuthority ? { replyAuthority: replyAuthority.authority } : {}),
    });
    try {
      const dispatchResult = await d.dispatchMessage(target, message, {
        dispatchId,
        messageId,
        ...(input.internalDurableQueue ? { durableQueue: true } : {}),
        deliveryMode: input.deliveryMode ?? MEMORY_MCP_SEND_DELIVERY_MODES.APPEND,
        ...(!input.audit && supervisedTaskId && supervisedAssignmentId
          ? { supervision: { taskId: supervisedTaskId, assignmentId: supervisedAssignmentId } }
          : {}),
        ...buildSharedServerMemberSharedActorOption(caller, callerRecord, target, messageId, now),
      });
      deliveries.push({
        target: target.name,
        messageId,
        ...(replyAuthority ? { delegationId: replyAuthority.record.delegationId } : {}),
        ...(supervisedTaskId ? { taskId: supervisedTaskId } : {}),
        ...(supervisedAssignmentId ? { assignmentId: supervisedAssignmentId } : {}),
        status: dispatchResult === 'queued' ? 'queued' : 'delivered',
      });
    } catch (err) {
      if (replyAuthority) expireDelegationReplyAuthority(replyAuthority.record.delegationId);
      deliveries.push({ target: target.name, status: 'failed', error: sanitizeMcpErrorMessage(err) });
    }
  }

  const successful = deliveries.filter((delivery) => delivery.status !== 'failed');
  const failed = deliveries.length - successful.length;
  if (successful.length === 0) {
    return {
      status: 'error',
      reason: MCP_ERROR_REASONS.INTERNAL_ERROR,
      error: failed === 1 ? deliveries[0]?.error ?? 'send dispatch failed' : 'send dispatch failed for all targets',
    };
  }

  const accepted: Extract<SendMessageResult, { status: 'accepted' }> = {
    status: 'accepted',
    dispatchId,
    ...(deliveries.length === 1 && successful[0]?.messageId ? { messageId: successful[0].messageId } : {}),
    deliveries,
    ...(supervisedTaskId ? { taskId: supervisedTaskId } : {}),
    ...(supervisedAssignmentId ? { assignmentId: supervisedAssignmentId } : {}),
    ...(auditRoutingReason ? { auditRoutingReason } : {}),
    ...(auditDegradedReason ? { auditDegradedReason } : {}),
    ...(provisioning ? { provisioning } : {}),
    ...(failed > 0 ? { partial: true } : {}),
  };
  if (cacheKey && failed === 0) idempotencyCache.set(cacheKey, { expiresAt: now + SEND_IDEMPOTENCY_WINDOW_MS, result: accepted });
  return accepted;
}

export type ReadyAuditDispatchResult =
  | { status: 'ignored'; reason: string }
  | { status: 'replayed'; assignmentId: string; attemptId: string; messageId?: SendMessageId }
  | { status: 'dispatched'; assignmentId: string; attemptId: string; messageId: SendMessageId }
  | { status: 'blocked'; reason: string; reported: boolean };

export interface ReadyAuditDispatchDeps {
  registry?: ReturnType<typeof getSupervisionTaskRegistry>;
  listSessions?: () => SessionRecord[];
  listTargets?: typeof listSendTargets;
  dispatch?: typeof dispatchSendMessage;
  hasDeliveryEvidence?: (sessionName: string, messageId: SendMessageId) => boolean;
  resolveRestartDurableDeliveryIdCapability?: (
    session: SessionRecord,
  ) => ProviderRestartDurableDeliveryIdCapability | undefined;
  /** Internal boot-sweep marker: prior-process handoffs are abandoned. */
  recoverRestartHandoffs?: boolean;
  now?: () => number;
}

function automaticAuditAttemptId(taskId: string, revision: string): string {
  const digest = createHash('sha256').update(`${taskId}\0${revision}`).digest('hex');
  return `auto-audit-${digest.slice(0, 24)}`;
}

function hasDurableDeliveryEvidence(sessionName: string, messageId: SendMessageId): boolean {
  try {
    const store = getTransportQueueStore();
    if (store.hasDeliveryTombstone(sessionName, messageId)) return true;
    return store.readSnapshot(sessionName).pendingMessageEntries.some(
      (entry) => entry.clientMessageId === messageId && entry.status === 'queued',
    );
  } catch {
    return false;
  }
}

function restartDurableDeliveryIdCapability(
  session: SessionRecord,
  deps: ReadyAuditDispatchDeps,
): ProviderRestartDurableDeliveryIdCapability | undefined {
  const injected = deps.resolveRestartDurableDeliveryIdCapability?.(session);
  if (injected) return injected;
  const providerId = session.providerId?.trim();
  if (!providerId) return undefined;
  return getProvider(providerId)?.capabilities.restartDurableDeliveryId;
}

function hasProvenAutomaticAuditDelivery(
  session: SessionRecord,
  deps: ReadyAuditDispatchDeps,
): boolean {
  return hasRestartDurableDeliveryIdAcceptance(
    restartDurableDeliveryIdCapability(session, deps),
  );
}

function recoverAutomaticAuditHandoff(
  sessionName: string,
  messageId: SendMessageId,
  deps: ReadyAuditDispatchDeps,
): boolean {
  try {
    const store = getTransportQueueStore();
    const before = store.readSnapshot(sessionName, 'automatic_audit_handoff_recovery_before');
    if (!before.pendingMessageEntries.some((entry) => (
      entry.clientMessageId === messageId && entry.status === 'handoff_inflight'
    ))) return false;
    const after = store.restoreExpiredHandoffs(sessionName, (deps.now ?? Date.now)(), {
      includeUnexpired: deps.recoverRestartHandoffs === true,
    });
    return after.pendingMessageEntries.some((entry) => (
      entry.clientMessageId === messageId && entry.status === 'queued'
    ));
  } catch {
    return false;
  }
}

function exactLiveSessionForAssignment(
  assignment: PersistedSupervisionTaskAssignment,
  sessions: readonly SessionRecord[],
): SessionRecord | undefined {
  return sessions.find((session) => (
    session.name === assignment.identity.sessionName
    && session.sessionInstanceId === assignment.identity.sessionInstanceId
    && session.runtimeEpoch === assignment.identity.runtimeEpoch
  ));
}

function eligibleAutomaticAuditTransportTarget(
  brain: SessionRecord,
  audited: PersistedSupervisionTaskAssignment,
  allowSameFamily: boolean,
  deps: ReadyAuditDispatchDeps,
): string | undefined {
  const sessions = (deps.listSessions ?? listSessions)();
  const auditedSession = sessions.find(
    (session) => session.name === audited.identity.sessionName,
  );
  if (!auditedSession) return undefined;
  const listed = (deps.listTargets ?? listSendTargets)({
    userId: brain.name,
    sessionName: brain.name,
    projectName: brain.projectName ?? null,
    projectRoot: brain.projectDir,
  }, { executionPool: 'primary', limit: MAX_TARGET_LIST_LIMIT });
  if (listed.status !== 'ok') return undefined;
  const liveByName = new Map(sessions.map((session) => [session.name, session]));
  const auditedFamily = resolvePeerAuditProviderFamily(auditedSession);
  const eligible = listed.items
    .filter((item) => (
      item.target !== audited.identity.sessionName
      && item.replyCapable
      && (item.dispatchMode === 'new_work' || item.dispatchMode === 'queue_only')
      && item.eligiblePools?.includes('primary')
      && (() => {
        const live = liveByName.get(item.target);
        return Boolean(
          live
          && (live.runtimeType ?? getSessionRuntimeType(live.agentType)) === 'transport'
          && hasProvenAutomaticAuditDelivery(live, deps),
        );
      })()
    ))
    .sort((left, right) => left.target.localeCompare(right.target));
  return eligible.find((item) => item.providerFamily !== auditedFamily)?.target
    ?? (allowSameFamily ? eligible.find((item) => item.providerFamily === auditedFamily)?.target : undefined);
}

function boundedAuditBrief(task: SupervisionTaskSnapshot, revision: string): string {
  const shorten = (value: string, max = 800) => value.length <= max ? value : `${value.slice(0, max - 1)}…`;
  const files = task.touchedFiles.length > 0
    ? task.touchedFiles
    : task.assignments.flatMap((assignment) => assignment.scopeFiles);
  return [
    '[Daemon-resolved automatic matching audit]',
    `taskId=${task.taskId}`,
    `revision=${revision}`,
    `classification=${task.classification}`,
    `objective=${shorten(task.objective)}`,
    '',
    'Acceptance:',
    ...task.acceptance.slice(0, 20).map((item) => `- ${shorten(item, 500)}`),
    '',
    'Evidence-first independent audit. Verify the exact revision and return one final PASS/REWORK via peer_audit_reply.',
    'Do not edit code, stage, commit, push, deploy, install, upgrade, restart, or create a replacement task/audit.',
    'On PASS, integrationOwner is the same-project Brain; on failure report bounded concrete findings.',
    ...(files.length > 0 ? ['', 'Referenced files:', ...[...new Set(files)].sort().slice(0, 40).map((file) => `- ${file}`)] : []),
  ].join('\n');
}

function automaticBlockerMessage(input: {
  taskId: string;
  assignmentId: string;
  exactError: string;
}): string {
  return JSON.stringify({
    taskId: input.taskId,
    assignmentId: input.assignmentId,
    exactError: input.exactError,
    completedSafeWork: 'ready_for_audit is durable; no auditor replacement or Git side effect was created',
    recommendedNextAction: 'Brain must recover the same object or manually exact-route one eligible matching auditor for the current revision',
  });
}

async function reportAutomaticAuditBlocker(
  task: SupervisionTaskSnapshot,
  implementer: PersistedSupervisionTaskAssignment,
  coordinator: PersistedSupervisionTaskAssignment,
  exactError: string,
  deps: ReadyAuditDispatchDeps,
): Promise<boolean> {
  const sessions = (deps.listSessions ?? listSessions)();
  const origin = exactLiveSessionForAssignment(implementer, sessions);
  const target = exactLiveSessionForAssignment(coordinator, sessions);
  if (!origin || !target || target.role !== 'brain') return false;
  const messageId = deterministicSendMessageId(`auto-audit-blocker:${task.taskId}:${task.currentRevision ?? ''}:${exactError}`);
  const hasEvidence = deps.hasDeliveryEvidence ?? hasDurableDeliveryEvidence;
  if (hasEvidence(target.name, messageId)) return true;
  const dispatched = await (deps.dispatch ?? dispatchSendMessage)({
    userId: origin.name,
    sessionName: origin.name,
    projectName: task.projectName,
    projectRoot: origin.projectDir,
  }, {
    target: target.name,
    message: automaticBlockerMessage({ taskId: task.taskId, assignmentId: implementer.assignmentId, exactError }),
    idempotencyKey: `auto-audit-blocker:${task.taskId}:${task.currentRevision ?? ''}:${exactError}`,
    internalMessageId: messageId,
    internalDurableQueue: true,
  });
  return dispatched.status === 'accepted';
}

/**
 * Materialize one automatic matching audit from durable task facts. Repeated
 * calls, concurrent post-open hooks, and boot recovery converge on the same
 * assignment, attempt, and transport message id.
 */
export async function dispatchReadyAudit(
  taskId: string,
  deps: ReadyAuditDispatchDeps = {},
): Promise<ReadyAuditDispatchResult> {
  const registry = deps.registry ?? getSupervisionTaskRegistry();
  const task = registry.get(taskId);
  if (!task) return { status: 'ignored', reason: 'task_not_found' };
  if (!task.auditPolicy) return { status: 'ignored', reason: 'manual_policy' };
  if (!isAuditableSupervisionTaskClassification(task.classification)) {
    return { status: 'ignored', reason: 'classification_not_auditable' };
  }
  if (task.status !== 'ready_for_audit') return { status: 'ignored', reason: 'not_ready_for_audit' };
  const sessions = (deps.listSessions ?? listSessions)();
  const coordinators = task.assignments.filter((assignment) => assignment.role === 'coordinator');
  const coordinator = coordinators.find((assignment) => exactLiveSessionForAssignment(assignment, sessions)?.role === 'brain');
  const reporter = task.assignments.find((assignment) => (
    (assignment.role === 'implementer' || assignment.role === 'integration_owner')
    && Boolean(exactLiveSessionForAssignment(assignment, sessions))
  ));
  const revision = task.currentRevision?.trim();
  if (!revision) {
    const reason = 'missing_current_revision';
    const reported = reporter && coordinator
      ? await reportAutomaticAuditBlocker(task, reporter, coordinator, reason, deps)
      : false;
    return { status: 'blocked', reason, reported };
  }

  const implementers = task.assignments.filter((assignment) => (
    (assignment.role === 'implementer' || assignment.role === 'integration_owner')
    && assignment.status === 'ready_for_audit'
    && assignment.auditRevision === revision
  ));
  const implementer = implementers.length === 1 ? implementers[0] : undefined;
  if (!implementer || !coordinator) {
    const exactError = !implementer ? 'automatic audit requires one exact ready implementer revision' : 'automatic audit requires the live same-project Brain coordinator';
    const reported = reporter && coordinator
      ? await reportAutomaticAuditBlocker(task, reporter, coordinator, exactError, deps)
      : false;
    return { status: 'blocked', reason: exactError, reported };
  }

  const attemptId = automaticAuditAttemptId(task.taskId, revision);
  const existingAudits = task.assignments.filter((assignment) => (
    assignment.role === 'auditor'
    && assignment.auditRevision === revision
    && !['rework', 'cancelled', 'finalized'].includes(assignment.status)
  ));
  if (existingAudits.length > 1) {
    const reason = 'multiple live auditors exist for the exact revision';
    const reported = await reportAutomaticAuditBlocker(task, implementer, coordinator, reason, deps);
    return { status: 'blocked', reason, reported };
  }
  const existingAudit = existingAudits[0];
  let recoveredExistingMessageId: SendMessageId | undefined;
  // A Brain may have used the documented manual fallback after an automatic
  // routing failure. Its live exact assignment is authoritative and must not
  // receive a second automatic brief.
  if (existingAudit?.auditAttemptId && existingAudit.auditAttemptId !== attemptId) {
    return { status: 'replayed', assignmentId: existingAudit.assignmentId, attemptId: existingAudit.auditAttemptId };
  }
  if (existingAudit) {
    const target = exactLiveSessionForAssignment(existingAudit, sessions);
    if (!target) {
      const reason = 'existing automatic auditor identity is no longer live';
      const reported = await reportAutomaticAuditBlocker(task, implementer, coordinator, reason, deps);
      return { status: 'blocked', reason, reported };
    }
    if ((target.runtimeType ?? getSessionRuntimeType(target.agentType)) !== 'transport') {
      const reason = 'existing automatic auditor is not a transport runtime target';
      const reported = await reportAutomaticAuditBlocker(task, implementer, coordinator, reason, deps);
      return { status: 'blocked', reason, reported };
    }
    if (!hasProvenAutomaticAuditDelivery(target, deps)) {
      const reason = 'existing automatic auditor lacks proven restart-durable stable-delivery-id acceptance';
      const reported = await reportAutomaticAuditBlocker(task, implementer, coordinator, reason, deps);
      return { status: 'blocked', reason, reported };
    }
    const messageId = deterministicSendMessageId(`auto-audit:${existingAudit.assignmentId}:${attemptId}`);
    const recoveredHandoff = recoverAutomaticAuditHandoff(target.name, messageId, deps);
    if (!recoveredHandoff && (deps.hasDeliveryEvidence ?? hasDurableDeliveryEvidence)(target.name, messageId)) {
      return { status: 'replayed', assignmentId: existingAudit.assignmentId, attemptId, messageId };
    }
    if (recoveredHandoff) recoveredExistingMessageId = messageId;
  }

  const brain = exactLiveSessionForAssignment(coordinator, sessions)!;
  // Automatic materialization is deliberately transport-only. Process peers
  // remain valid for the existing Brain-controlled exact/manual audit path,
  // but plain tmux delivery has no recipient-side durable command-id boundary
  // and therefore cannot satisfy restart-safe exactly-once auto delivery.
  const target = existingAudit
    ? existingAudit.identity.sessionName
    : eligibleAutomaticAuditTransportTarget(
      brain,
      implementer,
      task.auditPolicy === 'auto_allow_degraded',
      deps,
    );
  if (!target) {
    const reason = task.auditPolicy === 'auto_strict_cross_vendor'
      ? 'automatic audit requires one live reply-capable cross-vendor transport target with proven restart-durable stable-delivery-id acceptance'
      : 'automatic audit requires one live reply-capable transport target with proven restart-durable stable-delivery-id acceptance';
    const reported = await reportAutomaticAuditBlocker(task, implementer, coordinator, reason, deps);
    return { status: 'blocked', reason, reported };
  }
  const result = await (deps.dispatch ?? dispatchSendMessage)({
    userId: brain.name,
    sessionName: brain.name,
    projectName: task.projectName,
    projectRoot: brain.projectDir,
  }, {
    target,
    message: boundedAuditBrief(task, revision),
    reply: true,
    idempotencyKey: `auto-audit:${task.taskId}:${revision}`,
    newWorkload: true,
    automaticSupervision: true,
    ...(recoveredExistingMessageId ? { internalMessageId: recoveredExistingMessageId } : {}),
    internalDurableQueue: true,
    audit: {
      kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      attemptId,
      auditedSessionName: implementer.identity.sessionName,
      ...(task.auditPolicy === 'auto_strict_cross_vendor' ? { strictCrossVendor: true } : {}),
    },
    task: {
      taskId: task.taskId,
      currentRevision: revision,
      auditRevision: revision,
      auditAttemptId: attemptId,
      executionPool: 'primary',
    },
  });
  if (result.status !== 'accepted' || !result.assignmentId) {
    const reason = result.status === 'error' ? result.error : `automatic audit dispatch ${result.status}`;
    const reported = await reportAutomaticAuditBlocker(task, implementer, coordinator, reason, deps);
    return { status: 'blocked', reason, reported };
  }
  const messageId = result.messageId
    ?? deterministicSendMessageId(`auto-audit:${result.assignmentId}:${attemptId}`);
  return { status: 'dispatched', assignmentId: result.assignmentId, attemptId, messageId };
}

/** One bounded startup recovery pass; no interval worker or new state machine. */
export async function dispatchReadyAuditSweep(deps: ReadyAuditDispatchDeps = {}): Promise<ReadyAuditDispatchResult[]> {
  const registry = deps.registry ?? getSupervisionTaskRegistry();
  const ready = registry.list({ status: 'ready_for_audit' })
    .filter((task) => Boolean(task.auditPolicy));
  const results: ReadyAuditDispatchResult[] = [];
  for (const task of ready) results.push(await dispatchReadyAudit(task.taskId, {
    ...deps,
    registry,
    recoverRestartHandoffs: true,
  }));
  return results;
}

/**
 * Execution-clone send branch. Validates the clone request, creates an ephemeral
 * clone of the resolved template, dispatches the worker message to the CLONE
 * (never the template), and returns the accepted result with `clone` metadata.
 * On dispatch failure AFTER creation it rolls the clone back (destroy) so no
 * orphan is left. Only reachable from the `if (input.clone)` branch above.
 */
async function dispatchExecutionCloneSend(
  caller: SendRuntimeCaller,
  input: SendMessageInput,
  clone: SendMessageCloneRequest,
  allSessions: SessionRecord[],
  d: ReturnType<typeof depsWithDefaults>,
  deps: SendToolDeps | undefined,
): Promise<SendMessageResult> {
  // Capability gate — the clone path requires the daemon to advertise
  // EXECUTION_CLONE_CAPABILITY_V1. Defaults to enabled (static advertisement).
  const capabilityEnabled = deps?.isExecutionCloneCapabilityEnabled?.() ?? true;
  if (!capabilityEnabled) {
    return { status: 'error', reason: MCP_ERROR_REASONS.FEATURE_DISABLED, error: `${EXECUTION_CLONE_CAPABILITY_V1} is not advertised` };
  }

  // Structural shape validation (defense-in-depth; the MCP zod schema is strict).
  if (clone.kind !== EXECUTION_CLONE_KIND || clone.ephemeral !== true) {
    return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: 'invalid clone request shape' };
  }
  if (typeof clone.parentRunId !== 'string' || clone.parentRunId.trim().length === 0) {
    return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: 'clone.parentRunId is required' };
  }
  if (!isExecutionCloneParentStage(clone.parentStage)) {
    return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: 'clone.parentStage is invalid' };
  }
  if (input.broadcast) {
    return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: 'broadcast is not allowed with clone' };
  }
  // A clone send always carries a reply path (the worker reports back to the
  // creator). Explicit `reply:false` is rejected BEFORE any clone is created
  // (design "Reject clone + reply:false"); omitted/`reply:true` still force the
  // reply path below.
  if (input.reply === false) {
    return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: 'reply:false is not allowed with clone' };
  }

  // The caller may not itself be an execution clone (no clone-of-clone via send).
  const callerRecord = allSessions.find((session) => session.name === caller.sessionName);
  if (callerRecord?.executionCloneMetadata?.kind === EXECUTION_CLONE_KIND) {
    return { status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN, error: `caller is an execution clone (${EXECUTION_CLONE_ERROR_CODES.WORKER_CLONE_FORBIDDEN})` };
  }

  // Resolve the target to the template session name (exact, project-scoped). The
  // clone send always uses exact-target resolution regardless of exactTargetOnly.
  // `templateCandidate` lets an exact clone name resolve so the create path can
  // surface `clone_of_clone_forbidden` (via validateExecutionTemplateCandidate)
  // instead of this resolver pre-filtering the clone into a generic not-found.
  const targets = resolveScopedTargets(caller, { target: input.target }, allSessions, true, 'templateCandidate');
  if (!targets.ok) return { status: 'error', reason: targets.reason, error: targets.error };
  if (targets.targets.length !== 1) {
    return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: 'clone requires exactly one target template' };
  }
  const templateSessionName = targets.targets[0].name;

  // ── Provider-limit gate, on the TEMPLATE ────────────────────────────────
  // A clone inherits its template's agentType, so it inherits the template's
  // provider account and therefore its limit. Creating one anyway spawns a
  // worker that cannot do anything, and because the clone is ephemeral with a
  // hard timeout it would be torn down having burned its whole lifetime
  // waiting on a quota that was already exhausted before it started.
  //
  // Checked BEFORE the idempotency cache and the create call: refusing after
  // creation would leave an orphan to reap.
  const cloneGate = evaluateDelegationAdmission(allSessions, targets.targets, d.now(), { newWorkload: true });
  if (cloneGate.blocked.length > 0) {
    const refusal = buildDelegationRefusal(
      cloneGate.blocked,
      getSiblingSessions(caller, allSessions),
      cloneGate.availability,
    );
    return {
      status: 'error',
      reason: refusal.reason,
      error: `clone template ${templateSessionName} is ${cloneGate.blocked[0]!.reason}`,
      limited: refusal,
    };
  }

  const fileRefs = sanitizeFileReferences(input.files, caller.projectRoot);
  if (!fileRefs.ok) return { status: 'error', reason: fileRefs.reason, error: fileRefs.error };

  // ── Clone-create idempotency ────────────────────────────────────────────
  // Parallel to the ordinary-send idempotency cache. The fingerprint binds the
  // request to (parentRunId, parentStage, resolved template, message hash); the
  // caller's optional idempotencyKey is folded into the cache key so distinct
  // logical retries never collide. A HIT means a clone was already created for
  // this request — we MUST NOT create/dispatch a second one:
  //   • HIT + clone still exists  → replay the cached accepted result.
  //   • HIT + clone already gone  → target_not_found (NEVER a recreate).
  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  const messageHash = createHash('sha256').update(input.message!, 'utf8').digest('hex');
  const fingerprint = `${clone.parentRunId.trim()}\0${clone.parentStage}\0${templateSessionName}\0${messageHash}`;
  const cloneCacheKey = `${caller.userId}\0${caller.sessionName}\0clone\0${fingerprint}${idempotencyKey ? `\0${idempotencyKey}` : ''}`;
  const nowForCache = d.now();
  const cachedClone = cloneCreateIdempotencyCache.get(cloneCacheKey);
  if (cachedClone && cachedClone.expiresAt > nowForCache) {
    const existing = d.getSession(cachedClone.cloneTarget);
    if (existing && isExecutionClone(existing)) {
      return { ...cachedClone.result, idempotentReplay: true };
    }
    // The previously-created clone is gone — surface target_not_found and do NOT
    // recreate it (the orchestrator must observe the terminal clone, not a new one).
    return {
      status: 'error',
      reason: mapCloneErrorToMcpReason(EXECUTION_CLONE_ERROR_CODES.TARGET_NOT_FOUND),
      error: `execution clone no longer exists (${EXECUTION_CLONE_ERROR_CODES.TARGET_NOT_FOUND})`,
    };
  }
  if (cachedClone) cloneCreateIdempotencyCache.delete(cloneCacheKey);

  // Consume the RESOLVED (clamped) clone routing limits when a resolver is
  // injected — so a configured non-default cap (e.g. maxParallelClones) is
  // enforced on the create. Limits are now resolved per `parentRunId` (the
  // wiring layer looks up the run-authoritative limits for this run); falls back
  // to the canonical defaults only when no run-level preference source resolves.
  const pref = deps?.resolveExecutionCloneLimits?.(clone.parentRunId.trim()) ?? defaultDedicatedExecutionRoutingPreference();

  // Owning main/orchestrator: the caller's parentSession when it is a sub-session,
  // else the caller itself (it is a main/brain/orchestrator session).
  const owningMainSessionName = callerRecord?.parentSession ?? caller.sessionName!;

  const createClone = deps?.createExecutionClone ?? defaultCreateExecutionClone;
  const destroyClone = deps?.destroyExecutionClone ?? defaultDestroyExecutionClone;

  let created: CreateExecutionCloneDepResult;
  try {
    created = await createClone({
      templateSessionName,
      parentRunId: clone.parentRunId.trim(),
      parentStage: clone.parentStage,
      ownerSessionName: caller.sessionName!,
      owningMainSessionName,
      pref,
    });
  } catch (err) {
    const code = executionCloneErrorCode(err);
    if (code) return { status: 'error', reason: mapCloneErrorToMcpReason(code), error: `${sanitizeMcpErrorMessage(err)} (${code})` };
    return { status: 'error', reason: MCP_ERROR_REASONS.INTERNAL_ERROR, error: sanitizeMcpErrorMessage(err) };
  }

  // Dispatch the worker message to the CLONE (force reply:true). On failure
  // AFTER creation, roll back by destroying the clone so no orphan is left.
  const dispatchId = createSendDispatchId();
  const messageId = createSendMessageId();
  const now = d.now();
  const cloneRecord = d.getSession(created.target) ?? ({
    name: created.target,
    projectName: caller.projectName,
    role: 'w1',
    agentType: targets.targets[0].agentType,
    projectDir: targets.targets[0].projectDir,
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: now,
    updatedAt: now,
  } as SessionRecord);
  const replyAuthority = createDelegationReplyAuthority({
    origin: callerRecord,
    target: cloneRecord,
    dispatchId,
    messageId,
    now,
  });
  if (!replyAuthority) {
    await destroyClone({ target: created.target, reason: EXECUTION_CLONE_TERMINAL_REASON_DESTROYED, bypassAuth: true }).catch(() => {});
    return {
      status: 'error',
      reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
      error: 'reply-capable clone identity is unavailable',
    };
  }
  const message = buildSessionDispatchMessage({
    message: input.message!,
    files: fileRefs.files,
    replyTo: caller.sessionName,
    replyAuthority: replyAuthority.authority,
  });

  let dispatchResult: SendDispatchMessageResult;
  try {
    dispatchResult = await d.dispatchMessage(cloneRecord, message, {
      dispatchId,
      messageId,
      ...buildSharedServerMemberSharedActorOption(caller, callerRecord, cloneRecord, messageId, now),
    });
  } catch (err) {
    expireDelegationReplyAuthority(replyAuthority.record.delegationId);
    // Rollback — destroy the just-created clone before surfacing the error.
    await destroyClone({ target: created.target, reason: EXECUTION_CLONE_TERMINAL_REASON_DESTROYED, bypassAuth: true }).catch(() => {});
    return { status: 'error', reason: MCP_ERROR_REASONS.INTERNAL_ERROR, error: sanitizeMcpErrorMessage(err) };
  }

  const accepted: Extract<SendMessageResult, { status: 'accepted' }> = {
    status: 'accepted',
    dispatchId,
    messageId,
    deliveries: [{
      target: created.target,
      messageId,
      delegationId: replyAuthority.record.delegationId,
      status: dispatchResult === 'queued' ? 'queued' : 'delivered',
    }],
    clone: {
      target: created.target,
      sessionName: created.sessionName,
      hardTimeoutAt: created.metadata.hardTimeoutAt,
    },
  };
  // Store AFTER a successful create+dispatch so a retry replays this result
  // rather than creating a second clone.
  cloneCreateIdempotencyCache.set(cloneCacheKey, {
    expiresAt: nowForCache + SEND_IDEMPOTENCY_WINDOW_MS,
    cloneTarget: created.target,
    result: accepted,
  });
  return accepted;
}

/**
 * MCP `destroy_execution_clone`: destroy a clone the caller created. Authorization
 * (caller must equal `createdBySessionName`) is enforced by the destroy path
 * itself. A replay after the clone is already gone returns `target_not_found`,
 * never a recreate.
 */
export async function dispatchDestroyExecutionClone(
  caller: SendRuntimeCaller,
  input: SendDestroyExecutionCloneInput,
  deps?: SendToolDeps,
): Promise<SendDestroyExecutionCloneResult> {
  const d = depsWithDefaults(deps);
  if (!d.isDispatchEnabled()) {
    return { status: 'error', reason: MCP_ERROR_REASONS.FEATURE_DISABLED };
  }
  if (!caller.sessionName) {
    return { status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN };
  }
  const capabilityEnabled = deps?.isExecutionCloneCapabilityEnabled?.() ?? true;
  if (!capabilityEnabled) {
    return { status: 'error', reason: MCP_ERROR_REASONS.FEATURE_DISABLED };
  }
  const target = typeof input.target === 'string' ? input.target.trim() : '';
  if (!target) {
    return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED };
  }

  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  const cacheKey = idempotencyKey ? `${caller.userId}\0${caller.sessionName}\0destroy-clone\0${target}\0${idempotencyKey}` : '';
  const now = d.now();
  if (cacheKey) {
    const cached = destroyCloneIdempotencyCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return { ...cached.result, idempotentReplay: true };
    if (cached) destroyCloneIdempotencyCache.delete(cacheKey);
  }

  const destroyClone = deps?.destroyExecutionClone ?? defaultDestroyExecutionClone;
  try {
    await destroyClone({
      target,
      callerSessionName: caller.sessionName,
      reason: EXECUTION_CLONE_TERMINAL_REASON_DESTROYED,
    });
  } catch (err) {
    const code = executionCloneErrorCode(err);
    return { status: 'error', reason: code ?? MCP_ERROR_REASONS.INTERNAL_ERROR };
  }

  const result: SendDestroyExecutionCloneResult = { status: 'ok' };
  if (cacheKey) destroyCloneIdempotencyCache.set(cacheKey, { expiresAt: now + SEND_IDEMPOTENCY_WINDOW_MS, result });
  return result;
}

export interface SendStopInput {
  target?: string;
  broadcast?: boolean;
  idempotencyKey?: string;
}

/**
 * MCP-side `send_stop`: resolve scoped sibling target(s) exactly like
 * send_message, then force-stop each via the injected `cancelSession` hook
 * (production routes it to the daemon hook server's /stop endpoint, which runs
 * stopSessionNow on the priority lane). Returns the same shape as send_message
 * so callers get per-target status. Idempotent within the send window.
 */
export async function dispatchSendStop(
  caller: SendRuntimeCaller,
  input: SendStopInput,
  deps?: SendToolDeps,
): Promise<SendMessageResult> {
  const d = depsWithDefaults(deps);
  if (!d.isDispatchEnabled()) {
    return { status: 'disabled', reason: MCP_ERROR_REASONS.FEATURE_DISABLED, disabledFlag: SEND_MCP_DISPATCH_FEATURE_FLAG };
  }
  if (!caller.sessionName) {
    return { status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN, error: 'send_stop requires a scoped caller' };
  }
  const cancelSession = deps?.cancelSession;
  if (!cancelSession) {
    return { status: 'error', reason: MCP_ERROR_REASONS.INTERNAL_ERROR, error: 'stop dispatch is not configured' };
  }
  const allSessions = d.listSessions();
  const callerProjectName = effectiveCallerProjectName(caller, allSessions);
  if (!callerProjectName) {
    return { status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN, error: 'send_stop requires a scoped caller' };
  }
  if (!input.target && !input.broadcast) {
    return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: 'target is required unless broadcast is true' };
  }

  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  const idempotencyTarget = input.broadcast ? '*' : input.target ?? '';
  const cacheKey = idempotencyKey ? `${caller.userId}\0${caller.sessionName}\0stop\0${idempotencyTarget}\0${idempotencyKey}` : '';
  const now = d.now();
  if (cacheKey) {
    const cached = idempotencyCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return { ...cached.result, idempotentReplay: true };
    if (cached) idempotencyCache.delete(cacheKey);
  }

  // send_stop mirrors ordinary exact send: an exact clone name may be stopped,
  // but ONLY by the clone's creator (`exactCreatorOnly`); broadcast uses the
  // discoverable set (clones excluded). Clones are never matched by label/agentType.
  const targets = resolveScopedTargets({ ...caller, projectName: callerProjectName }, { target: input.target, broadcast: input.broadcast }, allSessions, d.exactTargetOnly, 'exactCreatorOnly');
  if (!targets.ok) return { status: 'error', reason: targets.reason, error: targets.error };

  const dispatchId = createSendDispatchId();
  const deliveries: SendMessageDelivery[] = [];
  for (const target of targets.targets) {
    try {
      const stopped = await cancelSession(target);
      if (stopped === false) {
        deliveries.push({ target: target.name, status: 'failed', error: 'session not found or not stoppable' });
      } else {
        deliveries.push({ target: target.name, status: 'delivered' });
      }
    } catch (err) {
      deliveries.push({ target: target.name, status: 'failed', error: sanitizeMcpErrorMessage(err) });
    }
  }

  const delivered = deliveries.filter((delivery) => delivery.status === 'delivered');
  const failed = deliveries.length - delivered.length;
  if (delivered.length === 0) {
    return {
      status: 'error',
      reason: MCP_ERROR_REASONS.INTERNAL_ERROR,
      error: failed === 1 ? deliveries[0]?.error ?? 'stop dispatch failed' : 'stop dispatch failed for all targets',
    };
  }

  const accepted: Extract<SendMessageResult, { status: 'accepted' }> = {
    status: 'accepted',
    dispatchId,
    deliveries,
    ...(failed > 0 ? { partial: true } : {}),
  };
  if (cacheKey && failed === 0) idempotencyCache.set(cacheKey, { expiresAt: now + SEND_IDEMPOTENCY_WINDOW_MS, result: accepted });
  return accepted;
}

export async function dispatchHookSend(input: HookSendDispatchInput, deps?: SendToolDeps): Promise<HookSendDispatchResult> {
  const d = depsWithDefaults(deps);
  // `/send` is the transport used by both the managed MCP bridge and the
  // `imcodes send` compatibility CLI. Node-to-node messages therefore prefer
  // append by default; the runtime boundary retains the durable FIFO fallback
  // when the provider cannot admit an active-turn append.
  const deliveryMode = input.deliveryMode ?? MEMORY_MCP_SEND_DELIVERY_MODES.APPEND;
  const fileRefs = sanitizeFileReferences(input.files, input.projectRoot ?? null);
  if (!fileRefs.ok) throw new Error(fileRefs.error);

  const dispatchId = createSendDispatchId();
  const delivered: string[] = [];
  const queued: string[] = [];
  const errors: string[] = [];
  const messages: SendMessageDelivery[] = [];
  const callerRecord = d.getSession(input.from) ?? undefined;
  const now = d.now();

  // ── Provider-limit gate ────────────────────────────────────────────────
  // Same admission service as `send_message`, so `/send` cannot become
  // the way around it. This path takes `targetRecords` directly rather than
  // resolving them, which is exactly why it needed its own call: nothing
  // upstream of here consults availability.
  const hookSessions = d.listSessions();
  const hookGate = evaluateDelegationAdmission(hookSessions, input.targetRecords, now, {
    newWorkload: input.newWorkload === true,
  });
  for (const blocked of hookGate.blocked) {
    const refusal = buildDelegationRefusal(
      [blocked],
      getSiblingSessions(
        { userId: input.from, sessionName: input.from, projectName: callerRecord?.projectName ?? null, projectRoot: null },
        hookSessions,
      ),
      hookGate.availability,
    );
    errors.push(
      `${blocked.target}: ${blocked.reason}`
      + `${blocked.retryAt === undefined ? '' : ` (retry after ${new Date(blocked.retryAt).toISOString()})`}`
      + `${refusal.alternatives.length === 0 ? '' : `; alternatives: ${refusal.alternatives.map((a) => a.target).join(', ')}`}`,
    );
  }

  for (const target of hookGate.dispatchable) {
    const worktreeGate = await ensureHookSupervisionAssignmentWorktree({
      callerRecord,
      projectRoot: input.projectRoot,
      target,
      ...(input.supervision ? { binding: input.supervision } : {}),
      ...(deps?.ensureSupervisionAssignmentWorktree
        ? { ensure: deps.ensureSupervisionAssignmentWorktree }
        : {}),
    });
    if (!worktreeGate.ok) {
      errors.push(`${target.name}: ${worktreeGate.error}`);
      continue;
    }
    const messageId = createSendMessageId();
    const replyAuthority = input.reply
      ? createDelegationReplyAuthority({
          origin: callerRecord,
          target,
          dispatchId,
          messageId,
          now,
        })
      : null;
    if (input.reply && !replyAuthority) {
      errors.push(`${target.name}: reply-capable session identity is unavailable`);
      continue;
    }
    const message = buildSessionDispatchMessage({
      message: input.message,
      files: fileRefs.files,
      replyTo: input.reply ? input.from : null,
      ...(replyAuthority ? { replyAuthority: replyAuthority.authority } : {}),
    });
    try {
      const result = await d.dispatchMessage(target, message, {
        dispatchId,
        messageId,
        deliveryMode,
        ...buildSharedServerMemberSharedActorOption(
          {
            userId: input.from,
            sessionName: input.from,
            projectName: callerRecord?.projectName ?? null,
            projectRoot: input.projectRoot ?? callerRecord?.projectDir ?? null,
          },
          callerRecord,
          target,
          messageId,
          now,
        ),
      });
      if (result === 'queued') queued.push(target.name);
      else delivered.push(target.name);
      messages.push({
        target: target.name,
        messageId,
        ...(replyAuthority ? { delegationId: replyAuthority.record.delegationId } : {}),
        status: result === 'queued' ? 'queued' : 'delivered',
      });
    } catch (err) {
      if (replyAuthority) expireDelegationReplyAuthority(replyAuthority.record.delegationId);
      errors.push(`${target.name}: ${(err as Error).message}`);
    }
  }

  return { dispatchId, delivered, queued, errors, messages };
}

export async function dispatchCronSend(input: CronSendDispatchInput, deps?: SendToolDeps): Promise<CronSendDispatchResult> {
  const d = depsWithDefaults(deps);
  const fromSession = d.getSession(input.fromSessionName);
  if (!fromSession) throw new Error(`cron send source session not found: ${input.fromSessionName}`);
  const result = await dispatchSendMessage({
    userId: 'cron',
    sessionName: fromSession.name,
    projectName: fromSession.projectName,
    projectRoot: fromSession.projectDir,
  }, {
    target: input.target,
    message: input.message,
    ...(input.reply !== undefined ? { reply: input.reply } : {}),
    ...(input.broadcast !== undefined ? { broadcast: input.broadcast } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    // A cron tick creates work on a schedule nobody is watching, so it gets the
    // wider refusal: firing every N minutes into a target that cannot run the
    // task builds a backlog and burns the retry budget for nothing.
    newWorkload: true,
  }, deps);
  if (result.status !== 'accepted') {
    if (result.status === 'error'
      && (result.reason === SEND_TOOL_ERROR_REASONS.TARGET_LIMITED
        || result.reason === SEND_TOOL_ERROR_REASONS.TARGET_UNAVAILABLE)) {
      // Thrown as a TYPED refusal, not a bare message. A scheduler needs to
      // tell "wait for the reset at T" apart from "this target is gone" --
      // flattening both into an Error string makes the first look permanent and
      // the second look retryable, which is exactly backwards. The reason is
      // carried through rather than fixed, so the two stay distinguishable all
      // the way to the control plane.
      throw new CronSendTargetLimitedError(result.reason, result.error, result.limited);
    }
    throw new Error(result.status === 'disabled' ? `send disabled: ${result.disabledFlag}` : result.error);
  }
  return {
    dispatchId: result.dispatchId,
    status: result.partial ? 'partial' : 'dispatched',
    deliveries: result.deliveries.map((delivery) => ({
      target: delivery.target,
      messageId: delivery.messageId,
      status: delivery.status,
      ...(delivery.error ? { error: delivery.error } : {}),
    })),
  };
}

function optionalModelField(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toTargetInfo(
  s: SessionRecord,
  availability: DelegationTargetAvailability,
  eligiblePools?: SupervisionExecutionPoolKind[],
): SendTargetInfo {
  const model = resolveEffectiveSessionModel(s);
  const activeModel = optionalModelField(s.activeModel);
  const requestedModel = optionalModelField(s.requestedModel);
  const modelDisplay = optionalModelField(s.modelDisplay);
  const qwenModel = optionalModelField(s.qwenModel);
  return {
    target: s.name,
    label: s.label ?? null,
    sessionName: s.name,
    role: s.role,
    agentType: s.agentType,
    ...(model ? { model } : {}),
    ...(activeModel ? { activeModel } : {}),
    ...(requestedModel ? { requestedModel } : {}),
    ...(modelDisplay ? { modelDisplay } : {}),
    ...(qwenModel ? { qwenModel } : {}),
    status: s.state,
    lastActiveAt: s.updatedAt,
    providerFamily: resolvePeerAuditProviderFamily(s),
    availability: availability.availability,
    ...(eligiblePools === undefined ? {} : {
      eligiblePools,
      dispatchMode: eligiblePools.length === 0
        ? 'unavailable' as const
        : availability.availability === DELEGATION_AVAILABILITY.READY
          ? 'new_work' as const
          : availability.availability === DELEGATION_AVAILABILITY.BUSY
            ? 'queue_only' as const
            : 'unavailable' as const,
    }),
    limitGroup: availability.limitGroup,
    replyCapable: isDelegationReplyCapableAgentType(s.agentType),
    ...(availability.limitedAt === undefined ? {} : { limitedAt: availability.limitedAt }),
    ...(availability.retryAt === undefined ? {} : { retryAt: availability.retryAt }),
    ...(availability.reason === undefined ? {} : { limitReason: availability.reason }),
  };
}

/**
 * Discoverable sibling sessions — used by `send_list_targets` and broadcast.
 * Execution clones are EXCLUDED here so they are never listed or broadcast to
 * (their only legitimate follow-up target is the `result.clone.target` returned
 * by the originating clone send). This is the `discoverable` resolution mode.
 */
/**
 * Delegates to the ONE authorized-candidate resolver.
 *
 * Kept as a local name because the send tool calls it in several places, but
 * the rule itself lives in the admission service so the P2P orchestrator gets
 * the identical answer. It previously approximated one for itself and leaked
 * the caller's own session and a hidden execution clone as "alternatives".
 */
function getSiblingSessions(caller: SendRuntimeCaller, allSessions: SessionRecord[]): SessionRecord[] {
  return authorizedDelegationCandidates(caller, allSessions);
}

/**
 * Whether `caller` may control (exact `send_message` / `send_stop`) the given
 * execution-clone record. Creator-only: the caller MUST equal the clone's
 * `createdBySessionName` — the same authorization anchor `destroy_execution_clone`
 * uses. Owning-main / arbitrary same-project siblings are NOT granted control,
 * so knowing/guessing a `deck_sub_*` name is never sufficient to drive another
 * run's worker.
 */
function canCallerControlExecutionClone(callerSessionName: string | null, clone: SessionRecord): boolean {
  const creator = clone.executionCloneMetadata?.createdBySessionName;
  return Boolean(callerSessionName) && creator === callerSessionName;
}

/**
 * Clone resolution mode for {@link resolveScopedTargets}. Execution clones are
 * hidden from discovery yet must remain addressable for two explicit purposes,
 * so the boolean `!isExecutionClone` filter is split into three modes:
 *
 *  - `exclude`         — discoverable/broadcast: never resolve an execution clone
 *                        (unchanged behavior; list/broadcast keep hiding clones).
 *  - `exactCreatorOnly`— ordinary exact `send_message`/`send_stop`: an exact
 *                        `target === clone.name` resolves ONLY for the clone's
 *                        creator; clones are NEVER matched by label/agentType.
 *  - `templateCandidate` — clone-CREATE template resolution: an exact clone name
 *                        resolves so the downstream create path surfaces
 *                        `clone_of_clone_forbidden` (instead of generic not-found).
 */
type CloneTargeting = 'exclude' | 'exactCreatorOnly' | 'templateCandidate';

function resolveScopedTargets(
  caller: SendRuntimeCaller,
  input: SendMessageInput,
  allSessions: SessionRecord[],
  exactTargetOnly = false,
  cloneTargeting: CloneTargeting = 'exclude',
): { ok: true; targets: SessionRecord[] } | { ok: false; reason: SendToolErrorReason; error: string } {
  const siblings = getSiblingSessions(caller, allSessions);
  if (input.broadcast) {
    // Broadcast always uses the discoverable set (clones excluded).
    if (siblings.length === 0) return { ok: false, reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: 'no sibling sessions found' };
    return { ok: true, targets: siblings.slice(0, MAX_BROADCAST_RECIPIENTS) };
  }

  const target = String(input.target ?? '').trim();

  // Normal (non-clone) sibling resolution — completely unchanged. `getSiblingSessions`
  // already excludes execution clones, so neither the exact-name match nor the
  // label/agentType fuzzy match can ever land on a clone here.
  const matches = siblings.filter((s) => (
    s.name === target
    || (!exactTargetOnly && (s.label?.toLowerCase() === target.toLowerCase() || s.agentType === target))
  ));
  if (matches.length === 1) return { ok: true, targets: matches };
  if (matches.length > 1) return { ok: false, reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: `ambiguous target "${target}"` };

  // ── Execution-clone exact-match branches ──────────────────────────────────
  // Reached only when no normal sibling matched. Clones are resolved by EXACT
  // name only (never label/agentType) and only in the two addressable modes.
  if (cloneTargeting !== 'exclude' && target.length > 0) {
    const callerProjectName = effectiveCallerProjectName(caller, allSessions);
    const cloneMatch = allSessions.find((s) => (
      s.name === target
      && isExecutionClone(s)
      && s.name !== caller.sessionName
      && effectiveProjectName(s, allSessions) === callerProjectName
    ));
    if (cloneMatch) {
      if (cloneTargeting === 'exactCreatorOnly' && !canCallerControlExecutionClone(caller.sessionName, cloneMatch)) {
        // Creator-only: a non-creator (even same-project) caller may not drive
        // another run's clone worker. Reuse the scope-forbidden reason (the same
        // authorization family `destroy_execution_clone` surfaces).
        return { ok: false, reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN, error: `target is an execution clone the caller did not create (${EXECUTION_CLONE_ERROR_CODES.DESTROY_FORBIDDEN})` };
      }
      // `exactCreatorOnly` (authorized) → control the clone; `templateCandidate`
      // → pass it through so the create path returns `clone_of_clone_forbidden`.
      return { ok: true, targets: [cloneMatch] };
    }
  }

  const crossProjectMatch = allSessions.some((s) => (
    s.state !== 'stopped'
    && effectiveProjectName(s, allSessions) !== caller.projectName
    && (s.name === target || (!exactTargetOnly && (s.label?.toLowerCase() === target.toLowerCase() || s.agentType === target)))
  ));
  if (crossProjectMatch) return { ok: false, reason: MCP_ERROR_REASONS.IDENTITY_REJECTED, error: 'target is outside the caller project' };
  return { ok: false, reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: `target "${target}" not found` };
}

function effectiveCallerProjectName(caller: SendRuntimeCaller, allSessions: SessionRecord[]): string | null {
  return resolveRuntimeScope(caller, allSessions).projectName;
}

function effectiveProjectName(session: SessionRecord, allSessions: SessionRecord[]): string {
  return resolveEffectiveProjectName(session, allSessions);
}

function sanitizeFileReferences(files: string[] | undefined, projectRoot: string | null): { ok: true; files: string[] } | { ok: false; reason: SendToolErrorReason; error: string } {
  if (!files || files.length === 0) return { ok: true, files: [] };
  if (!projectRoot) return { ok: false, reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN, error: 'projectRoot is required when files are provided' };
  if (files.length > MEMORY_MCP_CAPS.SEND_FILES_MAX_COUNT) {
    return { ok: false, reason: MCP_ERROR_REASONS.WRITE_QUOTA_EXCEEDED, error: `files exceeds ${MEMORY_MCP_CAPS.SEND_FILES_MAX_COUNT} entries` };
  }

  const root = path.resolve(projectRoot);
  const refs: string[] = [];
  for (const raw of files) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return { ok: false, reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: 'files must be non-empty path strings' };
    }
    if (raw.length > MEMORY_MCP_CAPS.SEND_FILE_PATH_MAX_CHARS) {
      return { ok: false, reason: MCP_ERROR_REASONS.WRITE_QUOTA_EXCEEDED, error: `file path exceeds ${MEMORY_MCP_CAPS.SEND_FILE_PATH_MAX_CHARS} characters` };
    }
    if (/[\u0000-\u001f\u007f]/.test(raw)) {
      return { ok: false, reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: 'file paths must not contain control characters' };
    }
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return { ok: false, reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN, error: `file path is outside projectRoot: ${raw}` };
    }
    const ref = path.relative(root, resolved) || '.';
    if (ref.length > MEMORY_MCP_CAPS.SEND_FILE_PATH_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(ref)) {
      return { ok: false, reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: 'file path reference is invalid' };
    }
    refs.push(ref);
  }
  return { ok: true, files: refs };
}
