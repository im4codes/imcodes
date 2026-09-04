import path from 'path';
import logger from '../util/logger.js';
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
import {
  buildSupervisionExecutionSummary,
  type SupervisionExecutionSummary,
} from '../../shared/supervision-execution-summary.js';
import { isDiscoverableInterAgentSession, resolveEffectiveProjectName, resolveRuntimeScope } from '../../shared/session-scope.js';
import {
  AGENT_DELEGATION_PURPOSES,
  buildAgentDelegationBlockerReportInstruction,
  isAgentDelegationOpaqueId,
  isDelegationReplyCapableAgentType,
  type AgentDelegationAuditRequest,
} from '../../shared/agent-delegation.js';
import {
  SUPERVISION_MODE,
  SUPERVISION_CONTRACT_IDS,
  isAuditableSupervisionTaskClassification,
  isTerminalSupervisionTaskStatus,
  isSupervisionTaskAuditPolicy,
  readSupervisionSnapshotFromTransportConfig,
  supervisionTaskAuditPolicyFromSnapshot,
  type SessionSupervisionSnapshot,
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
  validateAutomaticAuditTransportRoute,
  validateBrainAuditRoute as validateBrainAuditRouteAuthority,
} from './peer-audit-candidates.js';
import type {
  SupervisionAuditDegradedReason,
  SupervisionAuditRoutingReason,
  SupervisionProvisionFailureReason,
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
  type SupervisionLifecycleConvergenceAction,
  type PersistedSupervisionTaskAssignment,
  type PersistedSupervisionTaskAssignmentIdentity,
  type SupervisionTaskSnapshot,
} from './supervision-state-store.js';
import { getSession, listSessions } from '../store/session-store.js';
import { resolveAuthoritativeBrainIdentity } from './supervision-brain-authority.js';
import { isExecutionClone } from './execution-clone.js';
import {
  createDelegationReplyAuthority,
  expireDelegationReplyAuthority,
} from './delegation-reply-authority.js';
import { getDelegationReplyStore } from './delegation-reply-store.js';
import { buildServerMemberSharedActorOption as buildSharedServerMemberSharedActorOption, buildSessionDispatchMessage, dispatchSessionMessage, type SessionDispatchMessageResult, type SessionDispatchOptions } from './session-dispatch.js';
import type { SupervisionWorktreeProvisionResult } from './supervision-worktree-provision.js';
import {
  inspectSupervisionAssignmentWorktree,
  resolveSupervisionAssignmentWorktree,
} from './supervision-worktree-inspector.js';
import { getTransportQueueStore } from './transport-queue-store.js';

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
  /**
   * Who actually runs this, resolved at dispatch time.
   *
   * Without it a receipt is three opaque ids, and answering "which session,
   * which model, which provider, which pool" costs a second round trip for a
   * large task object plus a model turn to read it -- per id, every time.
   * Absent when the executor cannot be established without guessing.
   */
  execution?: SupervisionExecutionSummary;
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
  /**
   * Registry binding supplied by the managed MCP bridge for supervised work.
   *
   * `auditAttemptId`/`auditRevision` make the binding an EXACT four-tuple. When
   * present they are matched strictly: a mismatch is reported as a stale audit
   * revision instead of silently falling back to the compatibility scan, where
   * unrelated sibling assignments on the same target used to make the result
   * ambiguous.
   */
  supervision?: { taskId: string; assignmentId: string; auditAttemptId?: string; auditRevision?: string };
  /** Stable supervised delivery id supplied by the managed MCP bridge. */
  messageId?: SendMessageId;
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
  /** Testable boundary for an already durably accepted supervised delivery. */
  hasDeliveryEvidence?: (sessionName: string, messageId: SendMessageId) => boolean;
  /** Testable post-append recovery hook for an explicitly bound task policy. */
  dispatchReadyAudit?: (taskId: string) => Promise<ReadyAuditDispatchResult>;
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

const AUDITOR_REDELIVERY_STATUS = 'delegated';
const AUDITOR_STALE_REDELIVERY_MS = 10 * 60_000;
/**
 * Audit states that must never accept a redelivery. `passed` is included on
 * purpose: a returned verdict is authority, and re-routing to it would let a
 * closed audit be reopened by an ordinary send.
 */
const AUDITOR_TERMINAL_STATUSES = new Set<string>(['cancelled', 'finalized', 'passed', 'ready_for_integration']);

/**
 * Non-auditor roles that own long-lived work and must stay continuable by an
 * exact task+assignment+identity binding. Routing used to send only
 * `implementer` down the reuse path, so a coordinator or integration_owner
 * with a perfectly valid binding fell through to the compatibility scan and
 * was reported as an unrelated worktree ambiguity.
 */
const OWNER_CONTINUATION_ROLES = new Set<string>(['integration_owner', 'coordinator']);

/**
 * Terminal states for those owner roles. This is deliberately NOT the auditor
 * set: `ready_for_integration` ends an audit but is the WORKING state of an
 * integration owner, so sharing one set would make every owner unreachable
 * exactly when it needs to be driven.
 */
const OWNER_TERMINAL_STATUSES = new Set<string>(['cancelled', 'finalized']);

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

/** The exact five-field identity match shared by every exact-binding role. */
function identityMatchesLiveTarget(
  assignment: NonNullable<ReturnType<ReturnType<typeof getSupervisionTaskRegistry>['getAssignment']>>,
  target: SessionRecord,
): boolean {
  return assignment.identity.sessionName === target.name
    && assignment.identity.sessionInstanceId === target.sessionInstanceId
    && assignment.identity.runtimeEpoch === target.runtimeEpoch
    && assignment.identity.agentType === target.agentType
    && assignment.identity.providerFamily === resolvePeerAuditProviderFamily(target);
}

/**
 * THE single eligibility rule for an exact continuation, shared by the public
 * send_message resolution AND the hook worktree gate so the two cannot drift.
 * There is deliberately no second role set anywhere: both layers call this.
 *
 * `targetIdentity` is already-resolved identity, so callers holding a
 * SessionRecord must map it (including resolvePeerAuditProviderFamily) first.
 */
export function isExactContinuationEligible(input: {
  taskCurrentRevision?: string | undefined;
  assignment: {
    role: string; status: string; required?: boolean;
    auditAttemptId?: string | undefined; auditRevision?: string | undefined;
    identity: { sessionName: string; sessionInstanceId: string; runtimeEpoch: string; agentType: string; providerFamily: string };
  };
  targetIdentity: {
    sessionName?: string | undefined; sessionInstanceId?: string | undefined;
    runtimeEpoch?: string | undefined; agentType?: string | undefined; providerFamily?: string | undefined;
  };
}): boolean {
  const { assignment, targetIdentity } = input;
  // Fail closed on any missing identity field, so two `undefined`s can never
  // be treated as a match.
  if ([targetIdentity.sessionName, targetIdentity.sessionInstanceId, targetIdentity.runtimeEpoch,
    targetIdentity.agentType, targetIdentity.providerFamily].some((value) => !value)) return false;
  const identityMatches = assignment.identity.sessionName === targetIdentity.sessionName
    && assignment.identity.sessionInstanceId === targetIdentity.sessionInstanceId
    && assignment.identity.runtimeEpoch === targetIdentity.runtimeEpoch
    && assignment.identity.agentType === targetIdentity.agentType
    && assignment.identity.providerFamily === targetIdentity.providerFamily;
  if (!identityMatches) return false;
  if (assignment.role === 'implementer') {
    return HOOK_WORKTREE_RECOVERY_STATUSES.has(assignment.status);
  }
  if (OWNER_CONTINUATION_ROLES.has(assignment.role)) {
    if (OWNER_TERMINAL_STATUSES.has(assignment.status)) return false;
    // A bound revision must still agree with the task, so a stale owner cannot
    // be driven against a revision the task has moved past.
    return !assignment.auditRevision || input.taskCurrentRevision === assignment.auditRevision;
  }
  if (assignment.role === 'auditor') {
    return !AUDITOR_TERMINAL_STATUSES.has(assignment.status)
      && Boolean(assignment.auditAttemptId)
      && Boolean(assignment.auditRevision)
      && input.taskCurrentRevision === assignment.auditRevision;
  }
  return false;
}

function explicitAssignmentMatchesLiveTarget(
  task: SupervisionTaskSnapshot | undefined,
  assignment: ReturnType<ReturnType<typeof getSupervisionTaskRegistry>['getAssignment']>,
  target: SessionRecord,
): boolean {
  if (!task || !assignment || assignment.taskId !== task.taskId) return false;
  if (assignment.role === 'implementer' && !assignment.required) return false;
  return isExactContinuationEligible({
    taskCurrentRevision: task.currentRevision,
    assignment: {
      role: assignment.role,
      status: assignment.status,
      required: assignment.required,
      auditAttemptId: assignment.auditAttemptId,
      auditRevision: assignment.auditRevision,
      identity: assignment.identity,
    },
    targetIdentity: {
      sessionName: target.name,
      sessionInstanceId: target.sessionInstanceId,
      runtimeEpoch: target.runtimeEpoch,
      agentType: target.agentType,
      providerFamily: resolvePeerAuditProviderFamily(target),
    },
  });
}

/**
 * Renders a stale-binding rejection. Only control-plane state is included --
 * statuses, revision names, and attempt ids -- so the caller can tell WHICH
 * side is stale without any payload or credential material being echoed back.
 */
function formatStaleAuditBindingError(detail: {
  taskStatus: string;
  assignmentStatus: string;
  expectedRevision?: string;
  actualRevision?: string;
  expectedAttemptId?: string;
  actualAttemptId?: string;
  taskRevision?: string;
}): string {
  const fields = [
    `taskStatus=${detail.taskStatus}`,
    `assignmentStatus=${detail.assignmentStatus}`,
    `expectedRevision=${detail.expectedRevision ?? '<none>'}`,
    `actualRevision=${detail.actualRevision ?? '<none>'}`,
    `taskRevision=${detail.taskRevision ?? '<none>'}`,
    `expectedAttemptId=${detail.expectedAttemptId ?? '<none>'}`,
    `actualAttemptId=${detail.actualAttemptId ?? '<none>'}`,
  ].join(', ');
  return `stale_audit_revision: supervision binding no longer matches the current audit attempt (${fields})`;
}

async function ensureHookSupervisionAssignmentWorktree(input: {
  callerRecord?: SessionRecord;
  projectRoot?: string | null;
  target: SessionRecord;
  binding?: { taskId: string; assignmentId: string; auditAttemptId?: string; auditRevision?: string };
  ensure?: SendToolDeps['ensureSupervisionAssignmentWorktree'];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const registry = getSupervisionTaskRegistry();
  let task = input.binding ? registry.get(input.binding.taskId) : undefined;
  let assignment = input.binding ? registry.getAssignment(input.binding.assignmentId) : undefined;

  if (input.binding) {
    // An exact four-tuple binding is adjudicated BEFORE anything else. A stale
    // revision must be reported as such and must not fall through to delivery,
    // worktree creation, or the compatibility scan, where sibling assignments
    // on the same target would report a misleading ambiguity instead.
    if (task && assignment && assignment.taskId === task.taskId) {
      const submittedRevision = input.binding.auditRevision;
      const submittedAttempt = input.binding.auditAttemptId;
      const revisionIsStale = submittedRevision !== undefined
        && (submittedRevision !== assignment.auditRevision || submittedRevision !== task.currentRevision);
      const attemptIsStale = submittedAttempt !== undefined && submittedAttempt !== assignment.auditAttemptId;
      if (revisionIsStale || attemptIsStale) {
        return {
          ok: false,
          error: formatStaleAuditBindingError({
            taskStatus: task.status,
            assignmentStatus: assignment.status,
            expectedRevision: assignment.auditRevision,
            actualRevision: submittedRevision,
            expectedAttemptId: assignment.auditAttemptId,
            actualAttemptId: submittedAttempt,
            taskRevision: task.currentRevision,
          }),
        };
      }
    }
    if (!task || !assignment
      || assignment.taskId !== task.taskId
      || !explicitAssignmentMatchesLiveTarget(task, assignment, input.target)
      || (input.callerRecord?.projectName && task.projectName !== input.callerRecord.projectName)) {
      return { ok: false, error: 'supervision binding does not match the live task, assignment, revision, and target identity' };
    }
    // Same tsk_4d0 rule at the worktree gate: PROGRESS does not close an
    // auditor, only a FINAL verdict does. Blocking on any receipt made an
    // in-progress auditor permanently unreachable.
    const boundAudit = assignment?.role === 'auditor' ? assignment : undefined;
    if (boundAudit && task && registry.listAuditReceipts(task.taskId).some((receipt) => (
      receipt.assignmentId === boundAudit.assignmentId
      && receipt.attemptId === boundAudit.auditAttemptId
      && receipt.revision === boundAudit.auditRevision
      && receipt.receiptKind === 'final'
    ))) {
      return { ok: false, error: 'supervision auditor binding already returned a final verdict' };
    }
    // An exact continuation owns this already-provisioned worktree. Its
    // implementation bytes may be dirty by design, so do not run the clean
    // provisioning gate again. Missing paths still use the normal provisioner.
    if (existsSync(resolveSupervisionAssignmentWorktree({
      sessionName: input.target.name,
      assignmentId: assignment.assignmentId,
    }))) return { ok: true };
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
  const executionPools = resolveProjectAuthoritativeSupervisionPools(callerProjectName, allSessions);
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

/**
 * Read the one project-owned execution-pool snapshot for every legitimate
 * project participant. Read authority is project membership; only mutation of
 * the snapshot remains Brain-owned. Falling back to a sub-session's private
 * snapshot made the same target alternately configured/unconfigured depending
 * on who called send_list_targets (tsk_79u).
 *
 * Multiple active Brain snapshots are accepted only when byte-equivalent;
 * disagreement is genuine authority ambiguity and fails closed as
 * legacy_unconfigured rather than selecting by array order.
 */
export function resolveProjectAuthoritativeSupervisionSnapshot(
  projectName: string,
  sessions: readonly SessionRecord[],
): SessionSupervisionSnapshot {
  const fallback = readSupervisionSnapshotFromTransportConfig(undefined);
  const brains = sessions.filter((session) => (
    session.role === 'brain'
    && !session.parentSession
    && resolveEffectiveProjectName(session, sessions) === projectName
  ));
  if (brains.length === 0) return fallback;
  const snapshots = brains.map((brain) => readSupervisionSnapshotFromTransportConfig(brain.transportConfig));
  const encoded = new Set(snapshots.map((snapshot) => JSON.stringify(snapshot)));
  return encoded.size === 1 ? snapshots[0]! : fallback;
}

export function resolveProjectAuthoritativeSupervisionPools(
  projectName: string,
  sessions: readonly SessionRecord[],
): SupervisionExecutionPoolsConfig {
  return resolveProjectAuthoritativeSupervisionSnapshot(projectName, sessions).executionPools;
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

function supervisionIdentityMatches(
  left: PersistedSupervisionTaskAssignmentIdentity,
  right: PersistedSupervisionTaskAssignmentIdentity,
): boolean {
  return left.sessionName === right.sessionName
    && left.sessionInstanceId === right.sessionInstanceId
    && left.runtimeEpoch === right.runtimeEpoch
    && left.agentType === right.agentType
    && left.providerFamily === right.providerFamily;
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
  if (input.audit && input.task?.auditAttemptId?.trim()
    && input.task.auditAttemptId.trim() !== input.audit.attemptId) {
    return {
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
      error: 'audit task binding attemptId does not match audit metadata',
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
  const ensureAssignmentWorktree = async (
    taskId: string,
    assignmentId: string,
    sessionName: string,
    existingAssignment = false,
  ) => {
    const registry = getSupervisionTaskRegistry();
    const task = registry.get(taskId);
    const worktreePath = resolveSupervisionAssignmentWorktree({ sessionName, assignmentId });
    if (existingAssignment && existsSync(worktreePath)) {
      return {
        ok: true as const,
        value: {
          ok: true as const,
          worktreePath,
          baseRevision: task?.baseRevision ?? '',
          created: false,
        },
      };
    }
    if (!caller.projectRoot) {
      return { ok: false as const, error: 'assignment worktree provisioning requires the caller project root' };
    }
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
        if (assignment?.role === 'implementer' || assignment?.role === 'auditor') {
          const ensured = await ensureAssignmentWorktree(
            cached.result.taskId,
            cached.result.assignmentId,
            assignment.identity.sessionName,
            true,
          );
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
      provenance: input.automaticSupervision ? 'automatic_supervision' : 'manual_explicit',
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
    const route = (input.automaticSupervision
      ? validateAutomaticAuditTransportRoute
      : validateBrainAuditRouteAuthority)({
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
        automaticSupervision: input.automaticSupervision,
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
  /** The task's ORIGINAL coordinator assignment, stamped onto the durable return
   *  authority so the reply is bound to that assignment rather than to whoever
   *  later holds the origin session name. */
  let supervisedCoordinatorAssignmentId: string | undefined;
  let supervisedExecutionBinding: SupervisionExecutionBinding | undefined;
  let supervisedWorktree: Extract<SupervisionWorktreeProvisionResult, { ok: true }> | undefined;
  let reusedContinuationAssignment: ReturnType<ReturnType<typeof getSupervisionTaskRegistry>['getAssignment']>;
  let reusedAuditAssignment: ReturnType<ReturnType<typeof getSupervisionTaskRegistry>['getAssignment']>;
  let triggerReadyAuditAfterSend = false;
  let pendingTaskAuditPolicy: NonNullable<SupervisionTaskMetadata['auditPolicy']> | undefined;

  if (input.task) {
    const targetRecord = dispatchable[0]!;
    const targetIdentity = supervisionTaskIdentityForTarget(targetRecord);
    if (!targetIdentity) return { status: 'error', reason: MCP_ERROR_REASONS.IDENTITY_REJECTED, error: 'task target identity is unavailable' };
    // Task metadata turns both implementation AND audit sends into supervised
    // execution. Validate the exact target against the project's authoritative pool
    // before touching the registry, claims, reply authority or transport.
    // Audit eligibility is an additional gate below, never a pool bypass.
    const callerRecord = allSessions.find((session) => session.name === caller.sessionName);
    const callerSupervisionSnapshot = resolveProjectAuthoritativeSupervisionSnapshot(
      callerProjectName,
      allSessions,
    );
    const actual = supervisionObservedIdentityForTarget(targetRecord);
    const pool = input.task.executionPool ?? 'primary';
    const pools = resolveProjectAuthoritativeSupervisionPools(callerProjectName, allSessions);
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
        || !supervisionCallerParticipates(
          existing,
          callerRecord ? supervisionTaskIdentityForTarget(callerRecord) : undefined,
        )) {
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
      const explicitAuditPolicy = input.task.auditPolicy ?? undefined;
      if (explicitAuditPolicy) {
        if (input.audit) {
          return {
            status: 'error',
            reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
            error: 'task auditPolicy must be bound by a task continuation before audit dispatch',
          };
        }
        const callerIdentity = callerRecord && supervisionTaskIdentityForTarget(callerRecord);
        const exactCoordinator = callerIdentity && existing.assignments.find((assignment) => (
          assignment.role === 'coordinator'
          && supervisionIdentityMatches(assignment.identity, callerIdentity)
        ));
        if (callerRecord?.role !== 'brain' || callerRecord.parentSession || !exactCoordinator) {
          return {
            status: 'error',
            reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
            error: 'task auditPolicy requires the exact authoritative project Brain coordinator',
          };
        }
        if (callerSupervisionSnapshot.mode !== SUPERVISION_MODE.SUPERVISED_AUDIT) {
          return {
            status: 'error',
            reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
            error: 'task auditPolicy requires supervised_audit mode on the authoritative project Brain',
          };
        }
        if (!isAuditableSupervisionTaskClassification(existing.classification)) {
          return {
            status: 'error',
            reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
            error: 'task auditPolicy requires an auditable task classification',
          };
        }
        if (existing.auditPolicy && existing.auditPolicy !== explicitAuditPolicy) {
          return {
            status: 'error',
            reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
            error: 'task auditPolicy conflicts with the immutable task policy',
          };
        }
        const liveExactAuditors = existing.assignments.filter((assignment) => (
          assignment.role === 'auditor'
          && assignment.auditRevision === existing.currentRevision
          && !['rework', 'cancelled', 'finalized'].includes(assignment.status)
        ));
        if (!existing.auditPolicy && liveExactAuditors.length > 0) {
          return {
            status: 'error',
            reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
            error: 'task auditPolicy cannot be attached after an auditor exists for the exact revision',
          };
        }
        if (!existing.auditPolicy) pendingTaskAuditPolicy = explicitAuditPolicy;
        triggerReadyAuditAfterSend = existing.status === 'ready_for_audit';
      }
      if (input.audit) {
        const requestedAssignmentId = input.task.assignmentId?.trim();
        if (requestedAssignmentId) {
          const candidate = existing.assignments.find((assignment) => assignment.assignmentId === requestedAssignmentId);
          if (!candidate) {
            return {
              status: 'error',
              reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
              error: 'audit redelivery requires an exact existing assignment',
            };
          }
          reusedAuditAssignment = candidate;
        }
      } else {
        const requestedExactId = input.task.assignmentId?.trim();
        if (requestedExactId) {
          // R4: an EXACT assignmentId is resolved against every continuable
          // role through the ONE canonical eligibility rule, not against
          // implementers only. Previously this rejected before the owner-role
          // logic could run, so an exact coordinator or integration_owner
          // continuation was unreachable through the public tool even though
          // the hook layer accepted it.
          const exact = existing.assignments.find((assignment) => assignment.assignmentId === requestedExactId);
          if (exact && exact.role !== 'implementer') {
            if (!isExactContinuationEligible({
              taskCurrentRevision: existing.currentRevision,
              assignment: {
                role: exact.role, status: exact.status, required: exact.required,
                auditAttemptId: exact.auditAttemptId, auditRevision: exact.auditRevision,
                identity: exact.identity,
              },
              targetIdentity,
            })) {
              return {
                status: 'error',
                reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
                error: 'task continuation assignmentId is not an exact continuable assignment for this target',
              };
            }
            // Same stale-revision guard the implementer path applies.
            if (input.task.currentRevision && existing.currentRevision
              && input.task.currentRevision !== existing.currentRevision) {
              return {
                status: 'error',
                reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
                error: 'task continuation revision does not match the authoritative task revision',
              };
            }
            reusedContinuationAssignment = exact;
          }
        }
        const implementers = existing.assignments.filter((assignment) => assignment.role === 'implementer');
        if (requestedExactId && implementers.length === 0 && !reusedContinuationAssignment) {
          return {
            status: 'error',
            reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
            error: 'task continuation assignmentId is not an exact reusable implementer assignment',
          };
        }
        if (implementers.length > 0 && !reusedContinuationAssignment) {
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
      if (pendingTaskAuditPolicy) {
        const bound = registry.updateTask({ taskId: existing.taskId, auditPolicy: pendingTaskAuditPolicy, now });
        if (!bound.ok) {
          return {
            status: 'error',
            reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
            error: `task auditPolicy bind rejected: ${bound.reason}`,
          };
        }
      }
      taskId = existing.taskId;
    } else {
      const classification = input.task.classification ?? 'integration_slice';
      const explicitAuditPolicy = input.task.auditPolicy ?? undefined;
      if (explicitAuditPolicy && (!isSupervisionTaskAuditPolicy(explicitAuditPolicy)
        || callerRecord?.role !== 'brain' || callerRecord.parentSession || !newTaskCoordinatorIdentity)) {
        return {
          status: 'error',
          reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
          error: 'task auditPolicy requires the exact authoritative project Brain coordinator',
        };
      }
      if (explicitAuditPolicy && !isAuditableSupervisionTaskClassification(classification)) {
        return {
          status: 'error',
          reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
          error: 'task auditPolicy requires an auditable task classification',
        };
      }
      if (explicitAuditPolicy && callerSupervisionSnapshot.mode !== SUPERVISION_MODE.SUPERVISED_AUDIT) {
        return {
          status: 'error',
          reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
          error: 'task auditPolicy requires supervised_audit mode on the authoritative project Brain',
        };
      }
      const taskAuditPolicy = explicitAuditPolicy ?? (isAuditableSupervisionTaskClassification(classification)
        ? supervisionTaskAuditPolicyFromSnapshot(callerSupervisionSnapshot)
        : undefined);
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
    const reusedAssignment = reusedAuditAssignment ?? reusedContinuationAssignment;
    const assignment = reusedAssignment
      ? { ok: true as const, value: reusedAssignment, replay: true as const }
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
    // Resolve the task's coordinator assignment ONCE, from the registry, and by
    // exact identity where the caller is that coordinator. This is the authority
    // a pending return may later be advanced under.
    {
      const boundTask = registry.get(taskId);
      const callerCoordinatorIdentity = callerRecord && supervisionTaskIdentityForTarget(callerRecord);
      const coordinators = (boundTask?.assignments ?? []).filter((candidate) => candidate.role === 'coordinator');
      const exact = callerCoordinatorIdentity
        ? coordinators.find((candidate) => supervisionIdentityMatches(candidate.identity, callerCoordinatorIdentity))
        : undefined;
      supervisedCoordinatorAssignmentId = (exact ?? (coordinators.length === 1 ? coordinators[0] : undefined))
        ?.assignmentId;
    }
    if (input.audit && assignment.replay) {
      const authoritativeTask = registry.get(taskId);
      const requestedAttemptId = input.task.auditAttemptId?.trim() || input.audit.attemptId;
      const requestedRevision = String(
        input.task.auditRevision ?? input.task.currentRevision ?? authoritativeTask?.currentRevision ?? '',
      ).trim();
      const receipts = registry.listAuditReceipts(taskId).filter((receipt) => (
        receipt.assignmentId === assignment.value.assignmentId
        && receipt.attemptId === assignment.value.auditAttemptId
        && receipt.revision === assignment.value.auditRevision
      ));
      const sameTarget = assignment.value.identity.sessionName === targetIdentity.sessionName
        && assignment.value.identity.sessionInstanceId === targetIdentity.sessionInstanceId
        && assignment.value.identity.runtimeEpoch === targetIdentity.runtimeEpoch
        && assignment.value.identity.agentType === targetIdentity.agentType
        && assignment.value.identity.providerFamily === targetIdentity.providerFamily;
      // tsk_4d0 shape: an auditor that had already started (status past
      // `delegated`) and had recorded PROGRESS could not be continued, so the
      // assignment sat in `implementing` with an idle session and Brain had no
      // continue, cancel, or replace path. Existing progress is exactly why the
      // SAME auditor must be reachable -- it owns this attempt. Only terminal
      // audits and a returned final verdict stay closed.
      const finalReceipt = receipts.some((receipt) => receipt.receiptKind === 'final');
      if (assignment.value.role !== 'auditor'
        || AUDITOR_TERMINAL_STATUSES.has(assignment.value.status)
        || assignment.value.auditAttemptId !== requestedAttemptId
        || !requestedRevision
        || assignment.value.auditRevision !== requestedRevision
        || authoritativeTask?.currentRevision !== requestedRevision
        || !sameTarget
        || finalReceipt) {
        return {
          status: 'error',
          reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
          error: 'audit redelivery requires the exact non-terminal assignment, target, attempt, revision and identity, and no final verdict',
        };
      }
      const messageId = deterministicSendMessageId(
        `${input.automaticSupervision ? 'auto' : 'manual'}-audit:${assignment.value.assignmentId}:${input.audit.attemptId}`,
      );
      if ((deps?.hasDeliveryEvidence ?? hasDurableDeliveryEvidence)(targetIdentity.sessionName, messageId)) {
        return {
          status: 'error',
          reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
          error: 'audit redelivery rejected because durable delivery evidence already exists',
        };
      }
    }
    const ensured = await ensureAssignmentWorktree(
      taskId,
      assignment.value.assignmentId,
      targetIdentity.sessionName,
      Boolean(reusedAssignment),
    );
    if (!ensured.ok) {
      return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: ensured.error };
    }
    supervisedWorktree = ensured.value;
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
      ?? (supervisedAssignmentId && input.audit
        ? deterministicSendMessageId(`${input.automaticSupervision ? 'auto' : 'manual'}-audit:${supervisedAssignmentId}:${input.audit.attemptId}`)
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
    const replyRequired = input.reply === true
      || (!reusedContinuationAssignment && Boolean(supervisedTaskId && supervisedAssignmentId));
    let replyAuthority: ReturnType<typeof createDelegationReplyAuthority> = null;
    let createdReplyAuthority = false;
    if (replyRequired && reusedContinuationAssignment && input.reply === true
      && supervisedTaskId && supervisedAssignmentId
      && callerRecord?.sessionInstanceId?.trim() && callerRecord.runtimeEpoch?.trim()
      && target.sessionInstanceId?.trim() && target.runtimeEpoch?.trim()) {
      const current = getDelegationReplyStore().findCurrentAssignmentAuthority({
        taskId: supervisedTaskId,
        assignmentId: supervisedAssignmentId,
        origin: {
          sessionName: callerRecord.name,
          sessionInstanceId: callerRecord.sessionInstanceId.trim(),
          runtimeEpoch: callerRecord.runtimeEpoch.trim(),
        },
        target: {
          sessionName: target.name,
          sessionInstanceId: target.sessionInstanceId.trim(),
          runtimeEpoch: target.runtimeEpoch.trim(),
        },
        now,
      });
      if (current.status === 'ambiguous') {
        deliveries.push({
          target: target.name,
          status: 'failed',
          error: 'task continuation has multiple current reply authorities',
        });
        continue;
      }
      if (current.status === 'matched') {
        replyAuthority = {
          record: current.record,
          authority: { delegationId: current.record.delegationId },
        };
      }
    }
    if (replyRequired && !replyAuthority) {
      replyAuthority = createDelegationReplyAuthority({
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
          ...(supervisedCoordinatorAssignmentId
            ? { coordinatorAssignmentId: supervisedCoordinatorAssignmentId }
            : {}),
          now,
        });
      createdReplyAuthority = Boolean(replyAuthority);
    }
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
        ...(supervisedTaskId && supervisedAssignmentId
          ? { supervision: { taskId: supervisedTaskId, assignmentId: supervisedAssignmentId } }
          : {}),
        ...buildSharedServerMemberSharedActorOption(caller, callerRecord, target, messageId, now),
      });
      const execution = resolveDeliveryExecution(target, supervisedAssignmentId);
      deliveries.push({
        target: target.name,
        messageId,
        ...(replyAuthority ? { delegationId: replyAuthority.record.delegationId } : {}),
        ...(supervisedTaskId ? { taskId: supervisedTaskId } : {}),
        ...(supervisedAssignmentId ? { assignmentId: supervisedAssignmentId } : {}),
        status: dispatchResult === 'queued' ? 'queued' : 'delivered',
        ...(execution ? { execution } : {}),
      });
    } catch (err) {
      if (replyAuthority && createdReplyAuthority) expireDelegationReplyAuthority(replyAuthority.record.delegationId);
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
  if (triggerReadyAuditAfterSend && supervisedTaskId) {
    try {
      await (deps?.dispatchReadyAudit ?? dispatchReadyAudit)(supervisedTaskId);
    } catch {
      // The explicit policy bind is durable. The dispatcher owns its blocker
      // report and the boot sweep retries a crash after this accepted append.
    }
  }
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
  /** Internal boot-sweep marker: prior-process handoffs are abandoned. */
  recoverRestartHandoffs?: boolean;
  now?: () => number;
  inspectAssignmentWorktree?: (
    assignment: PersistedSupervisionTaskAssignment,
  ) => import('./supervision-worktree-inspector.js').SupervisionWorktreeSnapshot | undefined;
  /** Test seam for the existing bounded, persistent housekeeping scheduler. */
  runScheduledWorktreeGcBatch?: (now: number) => Promise<unknown>;
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

interface AutomaticAuditTransportTargets {
  ready?: string;
  busy?: string;
}

function eligibleAutomaticAuditTransportTargets(
  brain: SessionRecord,
  audited: PersistedSupervisionTaskAssignment,
  allowSameFamily: boolean,
  deps: ReadyAuditDispatchDeps,
): AutomaticAuditTransportTargets {
  const sessions = (deps.listSessions ?? listSessions)();
  const auditedSession = sessions.find(
    (session) => session.name === audited.identity.sessionName,
  );
  if (!auditedSession) return {};
  const listed = (deps.listTargets ?? listSendTargets)({
    userId: brain.name,
    sessionName: brain.name,
    projectName: brain.projectName ?? null,
    projectRoot: brain.projectDir,
  }, { executionPool: 'primary', limit: MAX_TARGET_LIST_LIMIT });
  if (listed.status !== 'ok') return {};
  const liveByName = new Map(sessions.map((session) => [session.name, session]));
  const auditedFamily = resolvePeerAuditProviderFamily(auditedSession);
  const eligible = listed.items
    .filter((item) => (
      item.target !== audited.identity.sessionName
      && (item.dispatchMode === 'new_work' || item.dispatchMode === 'queue_only')
      && item.eligiblePools?.includes('primary')
      && (() => {
        const live = liveByName.get(item.target);
        return Boolean(
          live
          && (live.runtimeType ?? getSessionRuntimeType(live.agentType)) === 'transport'
          && live.sessionInstanceId?.trim()
          && live.runtimeEpoch?.trim(),
        );
      })()
    ))
    .sort((left, right) => left.target.localeCompare(right.target));
  const pick = (items: typeof eligible): string | undefined => (
    items.find((item) => item.providerFamily !== auditedFamily)?.target
    ?? (allowSameFamily ? items.find((item) => item.providerFamily === auditedFamily)?.target : undefined)
  );
  return {
    ready: pick(eligible.filter((item) => item.dispatchMode === 'new_work')),
    busy: pick(eligible.filter((item) => item.dispatchMode === 'queue_only')),
  };
}

const AUTOMATIC_AUDIT_BUSY_FALLBACK_REASONS = new Set<SupervisionProvisionFailureReason>([
  'max_spawned',
  'cooldown',
  'launch_failed',
  'readiness_timeout',
]);

function mayFallbackToBusyAfterProvision(result: SendMessageResult): boolean {
  return result.status === 'error'
    && Boolean(result.provisioning?.failureReason)
    && AUTOMATIC_AUDIT_BUSY_FALLBACK_REASONS.has(result.provisioning!.failureReason!);
}

function boundedAuditBrief(
  task: SupervisionTaskSnapshot,
  revision: string,
  authoritativeWorktree: string,
): string {
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
    `Authoritative implementer worktree: ${authoritativeWorktree}`,
    '',
    'Acceptance:',
    ...task.acceptance.slice(0, 20).map((item) => `- ${shorten(item, 500)}`),
    '',
    'Evidence-first independent audit. Verify the exact revision and return one final PASS/REWORK via peer_audit_reply.',
    'Reconstruct and inspect the frozen bytes from the authoritative implementer worktree above. Do not inspect the auditor worktree as a substitute.',
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

interface CancelledCompletionEvidenceDecisionRequest {
  kind: 'cancelled_completion_evidence_conflict';
  actionRequired: 'adopt_or_discard';
  evidenceId: string;
  sourceAssignmentId: string;
  successorAssignmentId: string;
  revision: string;
  manifestSha256: string;
  worktreePath: string;
}

function cancelledCompletionEvidenceDecisionRequest(
  task: SupervisionTaskSnapshot,
): CancelledCompletionEvidenceDecisionRequest | undefined {
  if (!task.blocker) return undefined;
  try {
    const parsed = JSON.parse(task.blocker) as Partial<CancelledCompletionEvidenceDecisionRequest>;
    if (parsed.kind !== 'cancelled_completion_evidence_conflict'
      || parsed.actionRequired !== 'adopt_or_discard'
      || !parsed.evidenceId || !parsed.sourceAssignmentId || !parsed.successorAssignmentId
      || !parsed.revision || !parsed.manifestSha256 || !parsed.worktreePath) return undefined;
    return parsed as CancelledCompletionEvidenceDecisionRequest;
  } catch {
    return undefined;
  }
}

async function reportCancelledCompletionEvidenceDecision(
  task: SupervisionTaskSnapshot,
  deps: ReadyAuditDispatchDeps,
): Promise<boolean> {
  const request = cancelledCompletionEvidenceDecisionRequest(task);
  if (!request) return false;
  const sessions = (deps.listSessions ?? listSessions)();
  const coordinators = task.assignments.flatMap((assignment) => {
    if (assignment.role !== 'coordinator') return [];
    const live = exactLiveSessionForAssignment(assignment, sessions);
    return live?.role === 'brain' ? [live] : [];
  });
  const successor = task.assignments.find((assignment) => (
    assignment.assignmentId === request.successorAssignmentId
  ));
  const origin = successor ? exactLiveSessionForAssignment(successor, sessions) : undefined;
  if (coordinators.length !== 1 || !origin) return false;
  const target = coordinators[0]!;
  const messageId = deterministicSendMessageId(`cancelled-completion-decision:${request.evidenceId}`);
  const hasEvidence = deps.hasDeliveryEvidence ?? hasDurableDeliveryEvidence;
  if (hasEvidence(target.name, messageId)) return true;
  const dispatched = await (deps.dispatch ?? dispatchSendMessage)({
    userId: origin.name,
    sessionName: origin.name,
    projectName: task.projectName,
    projectRoot: origin.projectDir,
  }, {
    target: target.name,
    message: JSON.stringify({ taskId: task.taskId, ...request }),
    idempotencyKey: `cancelled-completion-decision:${request.evidenceId}`,
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
  // A task without a policy is normally not auto-audited. The one exception is
  // a pre-existing explicit attempt that is already bound to this revision:
  // routing it is recovery, not automatic materialisation.
  const recoveredAttemptId = task.auditPolicy ? undefined : legacyExplicitAuditRecoveryAttempt(task, registry);
  if (!task.auditPolicy && !recoveredAttemptId) return { status: 'ignored', reason: 'manual_policy' };
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
  // Blocker reporting is a Brain-EXCEPTION channel: when no coordinator is
  // live there is simply nobody to notify, which must never stop the daemon
  // from making its own deterministic progress.
  const reportBlocker = async (
    from: PersistedSupervisionTaskAssignment,
    reason: string,
  ): Promise<boolean> => (coordinator
    ? reportAutomaticAuditBlocker(task, from, coordinator, reason, deps)
    : false);

  const revision = task.currentRevision?.trim();
  if (!revision) {
    const reason = 'missing_current_revision';
    const reported = reporter && coordinator
      ? await reportBlocker(reporter, reason)
      : false;
    return { status: 'blocked', reason, reported };
  }

  // Never replace a recovered human attempt with the canonical derivation.
  const attemptId = recoveredAttemptId ?? automaticAuditAttemptId(task.taskId, revision);
  // PREFLIGHT, and it must stay AHEAD OF EVERY LIFECYCLE WRITE.
  //
  // The R12 audit caught this below the implementer alignment: a replay did
  // correctly report `final_receipt_recorded`, but the alignment had already
  // moved the owner implementing -> ready_for_audit, so the next successor
  // bind failed with `old_revision`. Audit readiness is never INFERRED here --
  // it is read from durable receipts before anything is written.
  // An accepted FINAL receipt for this exact attempt+revision means
  // the audit is already decided, whatever the assignment/task rows still say.
  // Observed on tsk_4d0/asg_6h3: a queued replay arrived before the tick that
  // closes the auditor, so the whole audit was re-delivered and re-run, and the
  // duplicate was only caught at the very end by `attempt_mismatch` on
  // peer_audit_reply -- after the artifacts had been read and the tests re-run.
  // Checking the durable receipt FIRST makes that a deterministic no-op, and it
  // must not depend on convergence having already advanced the task.
  const decidedByFinalReceipt = registry.listAuditReceipts(task.taskId).some((receipt) => (
    receipt.attemptId === attemptId
    && receipt.revision === revision
    && receipt.receiptKind === 'final'
    && (receipt.verdict === 'PASS' || receipt.verdict === 'REWORK')
  ));
  if (decidedByFinalReceipt) return { status: 'ignored', reason: 'final_receipt_recorded' };

  const implementers = task.assignments.filter((assignment) => (
    (assignment.role === 'implementer' || assignment.role === 'integration_owner')
    && assignment.status === 'ready_for_audit'
    && assignment.auditRevision === revision
  ));
  let implementer = implementers.length === 1 ? implementers[0] : undefined;
  if (!implementer) {
    // A record status is a projection of durable facts, not a gate the model
    // must unlock in order. After a valid REWORK and resumed implementation the
    // owner sits at `implementing` while the TASK is ready_for_audit, so the
    // strict filter above found nothing and the round stalled on
    // `automatic audit requires one exact ready implementer revision`.
    //
    // When the facts are unambiguous -- exactly ONE non-terminal implementation
    // owner whose revision does not contradict task.currentRevision -- align the
    // projection atomically on that same assignment and continue. Nothing is
    // fabricated: the revision comes from the task, and a contradicting or
    // ambiguous revision still fails closed below.
    const alignable = task.assignments.filter((assignment) => (
      (assignment.role === 'implementer' || assignment.role === 'integration_owner')
      && !isTerminalSupervisionTaskStatus(assignment.status)
      && (!assignment.auditRevision?.trim() || assignment.auditRevision === revision)
    ));
    if (alignable.length === 1) {
      const target = alignable[0]!;
      const aligned = registry.updateAssignment({
        assignmentId: target.assignmentId,
        identity: target.identity,
        status: 'ready_for_audit',
        revision,
        auditRevision: revision,
      });
      if (aligned.ok) implementer = registry.get(taskId)?.assignments
        .find((assignment) => assignment.assignmentId === target.assignmentId);
    }
  }
  if (!implementer) {
    const exactError = 'automatic audit requires one exact ready implementer revision';
    const reported = reporter && coordinator
      ? await reportBlocker(reporter, exactError)
      : false;
    return { status: 'blocked', reason: exactError, reported };
  }

  // attemptId and the final-receipt PREFLIGHT are established above, ahead of
  // every lifecycle write.
  const existingAudits = task.assignments.filter((assignment) => (
    assignment.role === 'auditor'
    && assignment.auditRevision === revision
    && !['rework', 'cancelled', 'finalized'].includes(assignment.status)
  ));
  if (existingAudits.length > 1) {
    const reason = 'multiple live auditors exist for the exact revision';
    const reported = await reportBlocker(implementer, reason);
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
      const reported = await reportBlocker(implementer, reason);
      return { status: 'blocked', reason, reported };
    }
    if ((target.runtimeType ?? getSessionRuntimeType(target.agentType)) !== 'transport') {
      const reason = 'existing automatic auditor is not a transport runtime target';
      const reported = await reportBlocker(implementer, reason);
      return { status: 'blocked', reason, reported };
    }
    const messageId = deterministicSendMessageId(`auto-audit:${existingAudit.assignmentId}:${attemptId}`);
    const recoveredHandoff = recoverAutomaticAuditHandoff(target.name, messageId, deps);
    const hasEvidence = deps.hasDeliveryEvidence ?? hasDurableDeliveryEvidence;
    if (!recoveredHandoff && hasEvidence(target.name, messageId)) {
      const now = deps.now?.() ?? Date.now();
      const staleDelegated = existingAudit.status === AUDITOR_REDELIVERY_STATUS
        && now - existingAudit.updatedAt >= AUDITOR_STALE_REDELIVERY_MS;
      if (!staleDelegated) {
        return { status: 'replayed', assignmentId: existingAudit.assignmentId, attemptId, messageId };
      }
      const redeliveryMessageId = deterministicSendMessageId(
        `auto-audit-redelivery:${existingAudit.assignmentId}:${attemptId}`,
      );
      if (hasEvidence(target.name, redeliveryMessageId)) {
        return {
          status: 'replayed', assignmentId: existingAudit.assignmentId, attemptId,
          messageId: redeliveryMessageId,
        };
      }
      recoveredExistingMessageId = redeliveryMessageId;
    }
    if (recoveredHandoff) recoveredExistingMessageId = messageId;
  }

  // Pool scoping context, NOT a relay. The audit envelope is delivered straight
  // to the auditor either way; this session only scopes the eligible-pool query
  // (userId/sessionName/project). Requiring it to be a live Brain made the
  // normal automatic path depend on a Brain session being up, and when it was
  // not the daemon blocked and a human had to drive the manual two-step relay.
  // The implementer is same-project and already authoritative here, so it is a
  // correct fallback scope; identity, pool eligibility and the cross-vendor
  // pick below are unchanged.
  const brain = (coordinator ? exactLiveSessionForAssignment(coordinator, sessions) : undefined)
    ?? exactLiveSessionForAssignment(implementer, sessions);
  if (!brain) {
    const reason = 'automatic audit requires one live same-project session to scope the auditor pool';
    const reported = reporter && coordinator
      ? await reportBlocker(reporter, reason)
      : false;
    return { status: 'blocked', reason, reported };
  }
  // Automatic materialization is deliberately transport-only. Process peers
  // remain valid for the existing Brain-controlled exact/manual audit path,
  // but plain tmux delivery has no recipient-side durable command-id boundary
  // and therefore cannot satisfy restart-safe exactly-once auto delivery.
  const candidates: AutomaticAuditTransportTargets = existingAudit
    ? {}
    : eligibleAutomaticAuditTransportTargets(
      brain,
      implementer,
      task.auditPolicy === 'auto_allow_degraded',
      deps,
    );
  const caller = {
    userId: brain.name,
    sessionName: brain.name,
    projectName: task.projectName,
    projectRoot: brain.projectDir,
  };
  const authoritativeWorktree = inspectAssignmentForConvergence(implementer, deps)?.worktreePath
    ?? resolveSupervisionAssignmentWorktree({
      sessionName: implementer.identity.sessionName,
      assignmentId: implementer.assignmentId,
    });
  const buildInput = (target?: string, autoProvision = false): SendMessageInput => ({
    ...(target ? { target } : {}),
    message: boundedAuditBrief(task, revision, authoritativeWorktree),
    reply: true,
    idempotencyKey: `auto-audit:${task.taskId}:${revision}`,
    ...(existingAudit ? {} : { newWorkload: true }),
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
      ...(existingAudit ? { assignmentId: existingAudit.assignmentId } : {}),
      currentRevision: revision,
      auditRevision: revision,
      auditAttemptId: attemptId,
      executionPool: 'primary',
      ...(autoProvision ? { autoProvision: true } : {}),
    },
  });
  const dispatch = deps.dispatch ?? dispatchSendMessage;
  const directTarget = existingAudit?.identity.sessionName ?? candidates.ready;
  // Mandatory routing order: an already-ready authorized transport wins. If
  // none exists, the configured execution pool gets one deterministic spawn
  // attempt. A busy transport is only the final durable-FIFO fallback after a
  // concrete capacity/cooldown/launch/readiness refusal from that attempt.
  let result = await dispatch(caller, buildInput(directTarget, !directTarget));
  if (!directTarget && candidates.busy && mayFallbackToBusyAfterProvision(result)) {
    result = await dispatch(caller, buildInput(candidates.busy));
  }
  if (result.status !== 'accepted' || !result.assignmentId) {
    const reason = result.status === 'error' ? result.error : `automatic audit dispatch ${result.status}`;
    const reported = await reportBlocker(implementer, reason);
    return { status: 'blocked', reason, reported };
  }
  const messageId = result.messageId
    ?? deterministicSendMessageId(`auto-audit:${result.assignmentId}:${attemptId}`);
  return { status: 'dispatched', assignmentId: result.assignmentId, attemptId, messageId };
}

export type DeterministicContinuationDispatchResult =
  | { status: 'ignored'; reason: string }
  | { status: 'replayed'; assignmentId: string; messageId: SendMessageId }
  | { status: 'dispatched'; assignmentId: string; messageId: SendMessageId }
  | { status: 'blocked'; reason: string; reported: boolean };

function inspectAssignmentForConvergence(
  assignment: PersistedSupervisionTaskAssignment,
  deps: ReadyAuditDispatchDeps,
): import('./supervision-worktree-inspector.js').SupervisionWorktreeSnapshot | undefined {
  if (deps.inspectAssignmentWorktree) return deps.inspectAssignmentWorktree(assignment);
  const inspected = inspectSupervisionAssignmentWorktree({
    sessionName: assignment.identity.sessionName,
    assignmentId: assignment.assignmentId,
  });
  return inspected.ok ? inspected.snapshot : undefined;
}

/** Deliver one exact REWORK receipt back to the same implementation object. */
export async function dispatchReadyRework(
  taskId: string,
  deps: ReadyAuditDispatchDeps = {},
): Promise<DeterministicContinuationDispatchResult> {
  const registry = deps.registry ?? getSupervisionTaskRegistry();
  const task = registry.get(taskId);
  if (!task || task.status !== 'rework') return { status: 'ignored', reason: 'not_ready_for_rework' };
  const revision = task.currentRevision?.trim();
  if (!revision) return { status: 'blocked', reason: 'missing_current_revision', reported: false };
  const candidates = task.assignments.filter((assignment) => (
    assignment.required && assignment.role === 'implementer' && assignment.status === 'rework'
    && assignment.auditRevision === revision && Boolean(assignment.auditAttemptId)
    && assignment.verdict?.trim().toUpperCase() === 'REWORK'
  ));
  if (candidates.length !== 1) {
    return { status: 'blocked', reason: 'rework requires one exact implementer', reported: false };
  }
  const implementer = candidates[0]!;
  const receipt = (task.auditReceipts ?? []).filter((item) => (
    item.attemptId === implementer.auditAttemptId && item.revision === revision
    && item.receiptKind === 'final' && item.verdict === 'REWORK'
  ));
  if (receipt.length !== 1) return { status: 'blocked', reason: 'exact REWORK receipt unavailable', reported: false };
  const sessions = (deps.listSessions ?? listSessions)();
  const target = sessions.find((session) => session.name === implementer.identity.sessionName);
  const targetIdentity = target && supervisionTaskIdentityForTarget(target);
  if (!target || !targetIdentity) return { status: 'blocked', reason: 'implementer runtime unavailable', reported: false };
  const liveBrains = task.assignments
    .filter((assignment) => assignment.role === 'coordinator')
    .flatMap((assignment) => {
      const session = exactLiveSessionForAssignment(assignment, sessions);
      return session?.role === 'brain' ? [session] : [];
    });
  if (liveBrains.length !== 1) {
    return { status: 'blocked', reason: 'rework requires one exact live Brain coordinator', reported: false };
  }
  const brain = liveBrains[0]!;
  const messageId = deterministicSendMessageId(`auto-rework:${task.taskId}:${revision}:${implementer.auditAttemptId}`);
  const hasEvidence = deps.hasDeliveryEvidence ?? hasDurableDeliveryEvidence;
  if (hasEvidence(target.name, messageId)) return { status: 'replayed', assignmentId: implementer.assignmentId, messageId };
  const findings = receipt[0]!.findings.trim();
  const caller = {
    userId: brain.name, sessionName: brain.name, projectName: task.projectName, projectRoot: brain.projectDir,
  };
  const result = await (deps.dispatch ?? dispatchSendMessage)(caller, {
    target: target.name,
    message: [
      '[Daemon-resolved exact REWORK continuation]',
      `taskId=${task.taskId}`,
      `assignmentId=${implementer.assignmentId}`,
      `revision=${revision}`,
      `attemptId=${implementer.auditAttemptId}`,
      '',
      findings,
      '',
      'Resume the same assignment and worktree. Repair only these exact findings, then re-freeze and validate; do not create a replacement task or assignment.',
    ].join('\n'),
    idempotencyKey: `auto-rework:${task.taskId}:${revision}:${implementer.auditAttemptId}`,
    internalMessageId: messageId,
    internalDurableQueue: true,
    task: {
      taskId: task.taskId,
      assignmentId: implementer.assignmentId,
      currentRevision: revision,
      auditRevision: revision,
      auditAttemptId: implementer.auditAttemptId,
      executionPool: 'primary',
    },
  });
  if (result.status !== 'accepted') {
    return { status: 'blocked', reason: result.status === 'error' ? result.error : `rework dispatch ${result.status}`, reported: false };
  }
  const resumed = registry.updateAssignment({
    assignmentId: implementer.assignmentId,
    identity: targetIdentity,
    status: 'implementing',
    revision,
    auditAttemptId: implementer.auditAttemptId,
    auditRevision: revision,
    blocker: findings,
  });
  if (!resumed.ok) return { status: 'blocked', reason: `rework resume rejected: ${resumed.reason}`, reported: false };
  return { status: 'dispatched', assignmentId: implementer.assignmentId, messageId };
}

/** Materialize and directly dispatch the unique integration owner after PASS. */
export async function dispatchReadyIntegration(
  taskId: string,
  deps: ReadyAuditDispatchDeps = {},
): Promise<DeterministicContinuationDispatchResult> {
  const registry = deps.registry ?? getSupervisionTaskRegistry();
  const task = registry.get(taskId);
  if (!task || task.status !== 'ready_for_integration' || task.finalization) {
    return { status: 'ignored', reason: 'not_ready_for_integration' };
  }
  const revision = task.currentRevision?.trim();
  if (!revision) return { status: 'blocked', reason: 'missing_current_revision', reported: false };
  const implementers = task.assignments.filter((assignment) => (
    assignment.required && (assignment.role === 'implementer' || assignment.role === 'integration_owner')
    && assignment.status === 'ready_for_integration'
    && assignment.auditRevision === revision && Boolean(assignment.auditAttemptId)
    && assignment.verdict?.trim().toUpperCase() === 'PASS'
    && assignment.crossVendorAuditPassed === true
  ));
  if (implementers.length !== 1) {
    return { status: 'blocked', reason: 'integration requires one exact PASS artifact owner', reported: false };
  }
  const implementer = implementers[0]!;
  const receipts = (task.auditReceipts ?? []).filter((item) => (
    item.attemptId === implementer.auditAttemptId && item.revision === revision
    && item.receiptKind === 'final' && item.verdict === 'PASS'
  ));
  if (receipts.length !== 1) return { status: 'blocked', reason: 'exact PASS receipt unavailable', reported: false };
  const sessions = (deps.listSessions ?? listSessions)();
  const coordinators = task.assignments.filter((assignment) => assignment.role === 'coordinator');
  const liveCoordinators = coordinators.flatMap((assignment) => {
    const session = exactLiveSessionForAssignment(assignment, sessions);
    return session?.role === 'brain' ? [{ assignment, session }] : [];
  });
  if (liveCoordinators.length !== 1) {
    return { status: 'blocked', reason: 'integration requires one exact live Brain coordinator', reported: false };
  }
  const { assignment: coordinator, session: brain } = liveCoordinators[0]!;
  const snapshot = inspectAssignmentForConvergence(implementer, deps);
  if (!snapshot || snapshot.stagedPaths.length > 0 || snapshot.conflictedPaths.length > 0) {
    return { status: 'blocked', reason: 'authoritative implementation manifest unavailable', reported: false };
  }
  const existingOwners = task.assignments.filter((assignment) => (
    assignment.role === 'integration_owner' && assignment.status !== 'cancelled'
    && assignment.status !== 'finalized' && (!assignment.auditRevision || assignment.auditRevision === revision)
  ));
  if (existingOwners.length > 1) return { status: 'blocked', reason: 'multiple live integration owners', reported: false };
  let owner = existingOwners[0];
  if (!owner) {
    const created = registry.createAssignment({
      taskId: task.taskId,
      role: 'integration_owner',
      identity: coordinator.identity,
      scopeFiles: snapshot.files.map((file) => file.path),
      required: true,
      auditAttemptId: implementer.auditAttemptId,
      auditRevision: revision,
      idempotencyKey: `auto-integration:${task.taskId}:${revision}`,
      now: (deps.now ?? Date.now)(),
    });
    if (!created.ok) return { status: 'blocked', reason: `integration owner materialization rejected: ${created.reason}`, reported: false };
    owner = created.value;
  }
  if (owner.verdict?.trim().toUpperCase() !== 'PASS' || owner.crossVendorAuditPassed !== true) {
    const bound = registry.updateAssignment({
      assignmentId: owner.assignmentId,
      identity: coordinator.identity,
      auditAttemptId: implementer.auditAttemptId,
      auditRevision: revision,
      verdict: 'PASS',
      crossVendorAuditPassed: true,
    });
    if (!bound.ok) return { status: 'blocked', reason: `integration owner PASS bind rejected: ${bound.reason}`, reported: false };
    owner = bound.value;
  }
  const messageId = deterministicSendMessageId(`auto-integration:${owner.assignmentId}:${revision}:${implementer.auditAttemptId}`);
  const hasEvidence = deps.hasDeliveryEvidence ?? hasDurableDeliveryEvidence;
  if (hasEvidence(brain.name, messageId)) return { status: 'replayed', assignmentId: owner.assignmentId, messageId };
  const origin = exactLiveSessionForAssignment(implementer, sessions) ?? brain;
  const result = await (deps.dispatch ?? dispatchSendMessage)({
    userId: origin.name, sessionName: origin.name, projectName: task.projectName, projectRoot: origin.projectDir,
  }, {
    target: brain.name,
    message: [
      '[Daemon-resolved exact PASS integration]',
      `taskId=${task.taskId}`,
      `assignmentId=${owner.assignmentId}`,
      `implementerAssignmentId=${implementer.assignmentId}`,
      `revision=${revision}`,
      `attemptId=${implementer.auditAttemptId}`,
      `authoritativeWorktree=${snapshot.worktreePath}`,
      '',
      'Exact pathspec:',
      ...snapshot.files.map((file) => `- ${file.path}`),
      '',
      'Integrate only these frozen bytes. Record real commit/push evidence; if already present, record that fact. CI is optional smoke only: record ci_not_configured or ci_unavailable without dummy run ids, and record pending/failure/success only for an exact current-commit observation. Never poll, monitor, or let CI control finalization. Never stage openspec/ or docs/.',
    ].join('\n'),
    idempotencyKey: `auto-integration:${task.taskId}:${revision}`,
    internalMessageId: messageId,
    internalDurableQueue: true,
  });
  if (result.status !== 'accepted') {
    return { status: 'blocked', reason: result.status === 'error' ? result.error : `integration dispatch ${result.status}`, reported: false };
  }
  return { status: 'dispatched', assignmentId: owner.assignmentId, messageId };
}

/**
 * Recover a PRE-EXISTING explicit audit intent that a missing task-level
 * `auditPolicy` would otherwise strand forever (the tsk_569 shape).
 *
 * "No policy means no automatic audit" is the right rule for an ordinary task
 * that never had an audit intent. It is the wrong rule for a task where a human
 * already minted an exact attempt and bound it to the implementer: that attempt
 * IS the intent, and the daemon may re-route it without inventing anything.
 *
 * This deliberately mints nothing: it returns the attempt that already exists,
 * or undefined. It never writes `auditPolicy`, never derives a canonical
 * attempt, and never inherits routing from an older revision.
 *
 * Fail-closed on every ambiguity: a revision that does not match exactly, more
 * than one required implementer, a live auditor already on this revision, or
 * any final receipt already recorded for it.
 */
export function legacyExplicitAuditRecoveryAttempt(
  task: SupervisionTaskSnapshot,
  registry: ReturnType<typeof getSupervisionTaskRegistry>,
): string | undefined {
  if (task.status !== 'ready_for_audit') return undefined;
  // A task WITH a policy is owned by the ordinary canonical-attempt path.
  if (task.auditPolicy) return undefined;
  const revision = task.currentRevision?.trim();
  if (!revision) return undefined;

  const assignments = registry.listAssignments(task.taskId);
  const implementers = assignments.filter((assignment) => (
    assignment.role === 'implementer'
    && assignment.required
    && assignment.status !== 'cancelled'
    && assignment.status !== 'finalized'
  ));
  if (implementers.length !== 1) return undefined;
  const implementer = implementers[0]!;
  // The attempt must belong to THIS revision; older routing is never inherited.
  if (implementer.auditRevision?.trim() !== revision) return undefined;
  const attemptId = implementer.auditAttemptId?.trim();
  if (!attemptId) return undefined;

  // Already materialised: replay is a no-op, not a second auditor.
  const liveAuditor = assignments.some((assignment) => (
    assignment.role === 'auditor'
    && assignment.auditRevision?.trim() === revision
    && assignment.status !== 'cancelled'
    && assignment.status !== 'finalized'
  ));
  if (liveAuditor) return undefined;
  const settled = registry.listAuditReceipts(task.taskId).some((receipt) => (
    receipt.revision === revision && receipt.receiptKind === 'final'
  ));
  if (settled) return undefined;

  return attemptId;
}

/** Result of one periodic convergence tick. */
export interface SupervisionConvergenceTickResult {
  converged: SupervisionLifecycleConvergenceAction[];
  audits: ReadyAuditDispatchResult[];
  reworks?: DeterministicContinuationDispatchResult[];
  integrations?: DeterministicContinuationDispatchResult[];
  /** True when a previous tick was still running and this one yielded. */
  skipped?: boolean;
}

/**
 * Re-entrancy guard. The tick is driven by an existing interval, so a slow
 * dispatch must never be overlapped by the next tick -- that is how duplicate
 * auditors get materialised.
 */
let supervisionConvergenceTickRunning = false;

/** Test seam: clears the re-entrancy latch between cases. */
export function __resetSupervisionConvergenceTickForTests(): void {
  if (process.env.NODE_ENV !== 'test') return;
  supervisionConvergenceTickRunning = false;
}

/**
 * One bounded periodic convergence step.
 *
 * Boot-only recovery cannot close a window that opens at any time: a task can
 * become ready_for_audit long after startup, and a slice can be consumed by a
 * parent finalization at any moment. This runs the same idempotent operations
 * on the existing bounded tick instead of adding a polling state machine.
 *
 * Unlike the boot sweep it does NOT set `recoverRestartHandoffs`: mid-run a
 * pending handoff belongs to this live process and must not be abandoned.
 */
export async function runSupervisionConvergenceTick(
  deps: ReadyAuditDispatchDeps & { limit?: number } = {},
): Promise<SupervisionConvergenceTickResult> {
  if (supervisionConvergenceTickRunning) return { converged: [], audits: [], skipped: true };
  supervisionConvergenceTickRunning = true;
  try {
    const registry = deps.registry ?? getSupervisionTaskRegistry();
    const now = deps.now?.() ?? Date.now();
    let converged: SupervisionLifecycleConvergenceAction[] = [];
    try {
      converged = registry.convergeLifecycle(now, {
        ...(deps.limit ? { limit: deps.limit } : {}),
        resolveAuthoritativeBrain: (projectName) => resolveAuthoritativeBrainIdentity(
          projectName,
          (deps.listSessions ?? listSessions)(),
        ),
        inspectAssignmentWorktree: (assignment) => {
          const inspected = inspectSupervisionAssignmentWorktree({
            sessionName: assignment.identity.sessionName,
            assignmentId: assignment.assignmentId,
          });
          return inspected.ok ? inspected.snapshot : undefined;
        },
      });
    } catch (error) {
      logger.warn({ err: error }, 'supervision lifecycle convergence failed');
    }
    // Conflicting successor bytes are the one cancellation-evidence shape the
    // daemon cannot decide. Keep the request durable and deterministic: scan
    // the persisted blocker on every bounded tick so a crash between the
    // atomic registry write and delivery is recovered, while delivery evidence
    // makes all later ticks a no-op.
    const decisionRequests = registry.list()
      .filter((task) => Boolean(cancelledCompletionEvidenceDecisionRequest(task)))
      .slice(0, deps.limit ?? 100);
    for (const task of decisionRequests) {
      await reportCancelledCompletionEvidenceDecision(task, deps);
    }
    // `dispatchReadyAudit` already refuses a task without an auditPolicy
    // (`manual_policy`) and derives its attempt id canonically from
    // (taskId, currentRevision), so a missing stored attempt is recomputed and
    // an older revision's attempt can never be reused here.
    const ready = registry.list({ status: 'ready_for_audit' })
      .filter((task) => Boolean(task.auditPolicy)
        || Boolean(legacyExplicitAuditRecoveryAttempt(task, registry)));
    const audits: ReadyAuditDispatchResult[] = [];
    const reworks: DeterministicContinuationDispatchResult[] = [];
    for (const task of registry.list({ status: 'rework' })) {
      reworks.push(await dispatchReadyRework(task.taskId, deps));
    }
    for (const task of ready) {
      audits.push(await dispatchReadyAudit(task.taskId, { ...deps, registry }));
    }
    const integrations: DeterministicContinuationDispatchResult[] = [];
    for (const task of registry.list({ status: 'ready_for_integration' })) {
      integrations.push(await dispatchReadyIntegration(task.taskId, { ...deps, registry }));
    }
    try {
      if (deps.runScheduledWorktreeGcBatch) {
        await deps.runScheduledWorktreeGcBatch(now);
      } else {
        const { runScheduledSupervisionWorktreeGcBatch } = await import('./supervision-registry-port.js');
        await runScheduledSupervisionWorktreeGcBatch(now);
      }
    } catch (error) {
      logger.warn({ err: error }, 'Scheduled supervision worktree GC failed');
    }
    return {
      converged,
      audits,
      ...(reworks.length > 0 ? { reworks } : {}),
      ...(integrations.length > 0 ? { integrations } : {}),
    };
  } finally {
    supervisionConvergenceTickRunning = false;
  }
}

/**
 * One bounded startup recovery pass; no interval worker or new state machine.
 *
 * It runs the SAME convergence the periodic tick runs, rather than a narrower
 * copy of it. Two rules had drifted apart: the boot pass selected only tasks
 * carrying an `auditPolicy` (missing the legacy explicit-audit recovery set the
 * tick includes) and it never ran `convergeLifecycle` at all, so after a
 * restart a stale coordinator epoch, an unprojected revision, a passed
 * validation or an already-recorded audit receipt sat untouched until the first
 * 60s watchdog tick. Delegating keeps ONE selection rule and one bounded pass;
 * the tick's re-entrancy guard also stops a boot sweep from racing a tick into
 * a double dispatch.
 */
export async function dispatchReadyAuditSweep(deps: ReadyAuditDispatchDeps = {}): Promise<ReadyAuditDispatchResult[]> {
  const { audits } = await runSupervisionConvergenceTick({ ...deps, recoverRestartHandoffs: true });
  return audits;
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
    const messageId = input.messageId ?? createSendMessageId();
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

/**
 * Resolve the executor for one delivery: durable binding first, live second.
 *
 * The persisted binding is the identity the work was admitted under, so it wins
 * over the live record even when the same name now reports something else. The
 * live path is used for ordinary sends and for assignments minted before
 * bindings were persisted; it reads the exact record being dispatched to, so
 * there is no name lookup to be ambiguous about. Pool is omitted there because
 * an unbound send genuinely has no lane, and a guessed one would be worse than
 * none. One O(1) registry read, no inference.
 */
function resolveDeliveryExecution(
  target: SessionRecord,
  assignmentId?: string,
): SupervisionExecutionSummary | null {
  let binding: SupervisionExecutionBinding | undefined;
  let assignmentStatus: string | undefined;
  if (assignmentId) {
    try {
      const assignment = getSupervisionTaskRegistry().getAssignment(assignmentId);
      binding = assignment?.executionBinding;
      assignmentStatus = assignment?.status;
    } catch {
      // A registry that cannot answer must not fail the send it is annotating.
      binding = undefined;
    }
  }
  return buildSupervisionExecutionSummary({
    ...(binding ? { binding } : {}),
    ...(assignmentStatus ? { assignmentStatus } : {}),
    sessionName: target.name,
    candidates: [{
      sessionName: target.name,
      label: target.label ?? null,
      agentType: target.agentType,
      providerFamily: resolvePeerAuditProviderFamily(target),
      model: resolveEffectiveSessionModel(target),
      status: target.state,
    }],
  });
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
