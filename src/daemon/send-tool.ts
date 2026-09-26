import { IMCODES_EXTERNAL_CLI_SENDER } from '../../shared/imcodes-send.js';
import { CHAT_MESSAGE_ORIGINS } from '../../shared/chat-message-origin.js';
import { isPairsEngineProject, isTaskPairEngineActive, projectBrainSession } from './task-pairs/engine.js';
import { taskPairService } from './task-pairs/service.js';
import { getTaskPairStore } from './task-pairs/store.js';
import { taskPairBindingOf } from '../../shared/task-pair.js';
import { DELEGATION_REACHED_DELIVERY_STATUSES } from '../../shared/delegation-claim.js';
import path from 'path';
import { buildAuditSeverityPolicyLines, type AuditSeverity } from '../../shared/audit-convergence.js';
import { attachDaemonUserNotice, DAEMON_USER_NOTICE_CODE } from '../../shared/daemon-user-notices.js';
import logger from '../util/logger.js';
import { timelineEmitter } from './timeline-emitter.js';
import { existsSync } from 'node:fs';
import {
  deriveSupervisionTaskTitle,
  deriveSupervisionTaskTitleFromBrief,
  formatSupervisionTaskIdentityHeader,
  projectSupervisionTaskObjective,
} from '../../shared/supervision-task-identity.js';
import { createHash } from 'node:crypto';
import {
  createSendDispatchId,
  createSendMessageId,
  deterministicAutomaticAuditDeliveryMessageId,
  deterministicSendMessageId,
  type SendDispatchId,
  type SendMessageId,
} from '../../shared/send-message-id.js';
import { IMCODES_SEND_MCP_DISPATCH_FEATURE_FLAG } from '../../shared/imcodes-send.js';
import {
  isAuditTargetReservedByOther,
  reconcileAuditTargetReservations,
  releaseAuditTarget,
  reserveAuditTarget,
} from './supervision-audit-target-reservations.js';
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
  SUPERVISION_BLOCKER_ESCALATION_DISPOSITIONS,
  SUPERVISION_IMPLEMENTATION_CONTINUATION_EXHAUSTED_ERROR,
  buildAgentDelegationBlockerReportInstruction,
  isAgentDelegationOpaqueId,
  isDelegationReplyCapableAgentType,
  type AgentDelegationAuditRequest,
  type SupervisionBlockerEscalationReport,
} from '../../shared/agent-delegation.js';
import {
  SUPERVISION_MODE,
  SUPERVISION_CONTRACT_IDS,
  SUPERVISION_ORPHANED_AUTOMATIC_AUDITOR_REBIND_SOURCE,
  isAuditableSupervisionTaskClassification,
  isAutomaticSupervisionEnabled,
  isTerminalSupervisionTaskStatus,
  isSupervisionTaskAuditPolicy,
  readSupervisionSnapshotFromTransportConfig,
  resolveSupervisionAuditBlockingSeverities,
  supervisionTaskAuditPolicyFromSnapshot,
  type SessionSupervisionSnapshot,
  type SupervisionMode,
  type SupervisionTaskMetadata,
} from '../../shared/supervision-config.js';
import { overlayCachedExecutionPools } from './supervisor-defaults-cache.js';
import { getSessionRuntimeType } from '../../shared/agent-types.js';
import {
  buildSupervisionExecutionCapabilityId,
  evaluateSupervisionExecutionBinding,
  evaluateSupervisionObservedIdentity,
  normalizeSupervisionExecutionModel,
  supervisionSelectedExecutionBindingMatches,
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
import type { SupervisionAuditorRecoveryCrossVendorAvailability } from '../../shared/supervision-auditor-recovery.js';
import { LOAD_VALIDATION_SAFETY_CLAUSE } from '../../shared/load-validation-safety.js';
import type {
  SupervisionAutoProvisionRequest,
  SupervisionAutoProvisionResult,
} from './supervision-auto-provision.js';
import { supervisionTaskCallerAuthority } from './supervision-mcp-tools.js';
import { isExactContinuationEligible } from './supervision-participant-delivery.js';
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
  type PersistedSupervisionAuditReceipt,
  type PersistedSupervisionTaskAssignment,
  type PersistedSupervisionTaskAssignmentIdentity,
  type SupervisionTaskRegistryResult,
  type SupervisionTaskSnapshot,
} from './supervision-state-store.js';
import { getSession, listSessions } from '../store/session-store.js';
import { resolveAuthoritativeBrainIdentity } from './supervision-brain-authority.js';
import { isExecutionClone } from './execution-clone.js';
import {
  createDelegationReplyAuthority,
  expireDelegationReplyAuthority,
} from './delegation-reply-authority.js';
import {
  getDelegationReplyStore,
  type DelegationReplyRecord,
  type PendingAuditDeliveryAuthority,
} from './delegation-reply-store.js';
import { buildServerMemberSharedActorOption as buildSharedServerMemberSharedActorOption, buildSessionDispatchMessage, dispatchSessionMessage, type SessionDispatchMessageResult, type SessionDispatchOptions } from './session-dispatch.js';
import type { SupervisionWorktreeProvisionResult } from './supervision-worktree-provision.js';
import {
  inspectSupervisionAssignmentWorktree,
  resolveSupervisionAssignmentWorktree,
} from './supervision-worktree-inspector.js';
import {
  applySupervisionIntegrationBundle,
  freezeSupervisionIntegrationBundle,
  verifySupervisionIntegrationBundle,
  type SupervisionIntegrationBundle,
} from './supervision-integration-bundle.js';
import {
  projectSupervisionSnapshotToAssignmentScope,
  supervisionBundleMatchesAssignmentScope,
} from './supervision-integration-scope.js';
import { getTransportQueueStore } from './transport-queue-store.js';
import { sessionActivityOf } from './session-activity.js';
import type { QueueSupervisionReference } from '../../shared/transport-queue-types.js';
import {
  SESSION_IDENTITY_SCOPES,
  normalizeSessionIdentityContent,
  sessionIdentityContentError,
} from '../../shared/session-identity.js';

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
  /** Latest participant-authored message and provider tool-call activity. */
  lastMessageAt?: number;
  lastToolCallAt?: number;
  /** Open task-pair memberships, projected without provider calls. */
  openPairs?: Array<{ taskId: string; role: 'brain' | 'executor' | 'auditor'; status: string; round: number; title?: string }>;
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
      /**
       * The caller's project's current authoritative supervision mode (from
       * its unique Brain session), surfaced on the tool the delegation
       * eligibility contract already requires calling before every new
       * dispatch -- so a Brain always sees the live switch state as part of
       * a call it already makes, instead of relying on remembering a
       * previously injected daemon control prompt.
       */
      supervisionMode: SupervisionMode;
      /** `true` exactly when supervisionMode is 'supervised_audit'. */
      autoAudit: boolean;
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

export interface SendMessageAgentIdentity {
  /** Normalized identity contract bytes resolved before dispatch. */
  content: string;
  /** Informational local source path when the MCP caller selected a file. */
  sourceFile?: string;
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
  /** Session-scoped identity applied to an explicitly auto-provisioned Agent. */
  identity?: SendMessageAgentIdentity;
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
  /** Daemon-only control turn: deliver to the agent without projecting a second user-visible message. */
  internalSuppressTimeline?: true;
  /** Daemon-only durable supervision lifecycle identity. */
  internalQueueSupervisionReference?: QueueSupervisionReference;
  /**
   * Daemon-only exact validation-authority snapshot for an automatic audit.
   * Re-verified under the registry lock that materializes the auditor/attempt,
   * so authority revoked after dispatch planning mints nothing.
   */
  internalAuditValidationAuthority?: string;
  /** Daemon-only evidence from an auto-provision refusal before busy-FIFO fallback. */
  internalProvisioningAttempt?: SupervisionProvisioningEvidence;
  /**
   * Daemon-only: `message` is machine-parsed JSON (e.g. a structured blocker
   * escalation report), not agent-readable prose. Suppresses the prepended
   * sender-identification line — prepending text would break `JSON.parse` on
   * the receiving/automation side.
   */
  internalStructuredPayload?: true;
}

export interface SendMessageDelivery {
  target: string;
  messageId?: SendMessageId;
  delegationId?: string;
  taskId?: string;
  assignmentId?: string;
  /** Registry-derived readable title of the bound task (shared/supervision-task-identity.ts). */
  taskTitle?: string;
  /** Full bounded registry objective for expandable task identity surfaces. */
  taskObjective?: string;
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
      /** Registry-derived readable title of the bound task. */
      taskTitle?: string;
      /** Full bounded registry objective for expandable task identity surfaces. */
      taskObjective?: string;
      auditRoutingReason?: SupervisionAuditRoutingReason;
      auditDegradedReason?: SupervisionAuditDegradedReason;
      provisioning?: SupervisionProvisioningEvidence;
      /** Explicit busy targets are never redirected; callers can opt into a new worker on retry. */
      autoProvisionRecommended?: true;
      /**
       * Present ONLY for a control-plane operation that carries task authority
       * without delivering a message. `deliveries` is empty in that case and no
       * delivery record is fabricated, so a caller can tell an authority change
       * from a chat send by structure rather than by reading prose.
       */
      controlPlane?: {
        operation: 'audit_policy_bind';
        auditPolicy: NonNullable<SupervisionTaskMetadata['auditPolicy']>;
        /** Whether this call performed the write or found it already satisfied. */
        policyBound: 'newly_bound' | 'already_bound';
        /** Outcome of the ONE existing ready-audit trigger, never a second dispatcher. */
        auditTrigger: 'skipped' | 'invoked' | 'failed';
      };
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
  /** Exact recipient-side acceptance projection for one auditor attempt. */
  hasVisibleAuditAcceptance?: (input: {
    taskId: string; assignmentId: string; attemptId: string; revision: string;
  }) => boolean;
  /** Durable execution ownership wins over any delivery retry. */
  hasActiveAuditExecutionClaim?: (input: {
    taskId: string; assignmentId: string; attemptId: string; revision: string;
  }) => boolean;
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
  /** Persist and converge an explicit session identity before first task delivery. */
  applyProvisionedIdentity?: (
    target: SessionRecord,
    identity: SendMessageAgentIdentity,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
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

function uniqueAuthoritativeProjectBrain(
  projectName: string,
  sessions: readonly SessionRecord[],
): SessionRecord | undefined {
  const brains = sessions.filter((session) => (
    session.role === 'brain'
    && !session.parentSession
    && session.state !== 'stopped'
    && resolveEffectiveProjectName(session, sessions) === projectName
  ));
  return brains.length === 1 ? brains[0] : undefined;
}

/**
 * Exported so supervision_task_start (memory-mcp-tools.ts) can grant the
 * project's own Brain the same coordinator-attach carve-out this module's own
 * task-continuation gate already grants it -- see that gate's
 * legacyBrainMayCoordinate for the exact semantics being shared, not
 * reimplemented a second time.
 */
export function isUniqueAuthoritativeProjectBrainCaller(
  caller: SessionRecord | undefined,
  projectName: string,
  sessions: readonly SessionRecord[],
): boolean {
  const brain = uniqueAuthoritativeProjectBrain(projectName, sessions);
  return Boolean(brain && caller?.name === brain.name
    && caller.sessionInstanceId?.trim()
    && caller.runtimeEpoch?.trim()
    && brain.sessionInstanceId?.trim()
    && brain.runtimeEpoch?.trim()
    && caller.sessionInstanceId === brain.sessionInstanceId
    && caller.runtimeEpoch === brain.runtimeEpoch);
}

export function exactManualSupervisionExecutionBinding(
  actual: SupervisionObservedExecutionIdentity,
  pool: SupervisionExecutionPoolKind,
): SupervisionExecutionBinding {
  const model = normalizeSupervisionExecutionModel(actual.agentType, actual.model);
  const requested = {
    agentType: actual.agentType,
    providerFamily: actual.providerFamily,
    runtimeType: actual.runtimeType,
    model,
    ...(actual.ccPresetId ? { ccPresetId: actual.ccPresetId } : {}),
  };
  return {
    pool,
    requested: {
      ...requested,
      capabilityId: buildSupervisionExecutionCapabilityId(requested),
    },
    actual,
    origin: 'manual',
  };
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

function assignmentMatchesLiveTargetBase(
  assignment: ReturnType<ReturnType<typeof getSupervisionTaskRegistry>['getAssignment']>,
  target: SessionRecord,
): boolean {
  return Boolean(assignment
    && assignment.role === 'implementer'
    && assignment.required
    && HOOK_WORKTREE_RECOVERY_STATUSES.has(assignment.status)
    && assignment.identity.sessionName === target.name);
}

function assignmentMatchesLiveTarget(
  assignment: ReturnType<ReturnType<typeof getSupervisionTaskRegistry>['getAssignment']>,
  target: SessionRecord,
): boolean {
  return assignmentMatchesLiveTargetBase(assignment, target);
}

/**
 * THE single eligibility rule for an exact continuation, shared by the public
 * send_message resolution AND the hook worktree gate so the two cannot drift.
 * There is deliberately no second role set anywhere: both layers call this.
 *
 * Runtime instance/epoch/agent/provider remain observational metadata. The
 * durable participant key is only projectName + sessionName.
 */
function explicitAssignmentMatchesLiveTarget(
  task: SupervisionTaskSnapshot | undefined,
  assignment: ReturnType<ReturnType<typeof getSupervisionTaskRegistry>['getAssignment']>,
  target: SessionRecord,
): boolean {
  if (!task || !assignment || assignment.taskId !== task.taskId) return false;
  if (assignment.role === 'implementer' && !assignment.required) return false;
  return isExactContinuationEligible({
    taskProjectName: task.projectName,
    taskCurrentRevision: task.currentRevision,
    assignment: {
      role: assignment.role,
      status: assignment.status,
      required: assignment.required,
      auditAttemptId: assignment.auditAttemptId,
      auditRevision: assignment.auditRevision,
      identity: assignment.identity,
    },
    targetProjectName: target.projectName,
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
      const refreshed = registry.convergeImplementationHeartbeatTarget({
        taskId: task.taskId,
        assignmentId: assignment.assignmentId,
        candidates: [{
          projectName: input.target.projectName,
          identity: {
            sessionName: input.target.name,
            sessionInstanceId: input.target.sessionInstanceId ?? '',
            runtimeEpoch: input.target.runtimeEpoch ?? '',
            agentType: input.target.agentType,
            providerFamily: resolvePeerAuditProviderFamily(input.target),
          },
        }],
      });
      if (refreshed.ok) assignment = refreshed.value;
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
  const authoritativeSnapshot = resolveProjectAuthoritativeSupervisionSnapshot(callerProjectName, allSessions);
  return {
    status: 'ok',
    executionPoolsState: executionPools.state,
    supervisionMode: authoritativeSnapshot.mode,
    autoAudit: isAutomaticSupervisionEnabled(authoritativeSnapshot),
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
 *
 * The execution pool specifically is account-level policy keyed by model
 * type, not by which Brain session happens to carry it (see
 * `overlayCachedExecutionPools`). Applying it here, after the
 * per-session/ambiguity resolution above, means every project on the
 * account is eligible for manual task dispatch the moment the account has
 * one configured pool -- a Brain never has to individually re-save it, and
 * an ambiguous or brain-less project still resolves through it rather than
 * only through the narrower ambiguity fallback.
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
  if (brains.length === 0) return overlayCachedExecutionPools(fallback);
  const snapshots = brains.map((brain) => readSupervisionSnapshotFromTransportConfig(brain.transportConfig));
  const encoded = new Set(snapshots.map((snapshot) => JSON.stringify(snapshot)));
  return overlayCachedExecutionPools(encoded.size === 1 ? snapshots[0]! : fallback);
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

/**
 * Resolve the complete selected binding for one already-live target. Recovery
 * callers must never rebuild this tuple from the stale assignment they are
 * replacing: doing so preserves an obsolete requested capability/model while
 * only the observed identity moves.
 */
export function resolveSelectedSupervisionExecutionBinding(
  projectName: string,
  sessions: readonly SessionRecord[],
  target: SessionRecord,
  pool: SupervisionExecutionPoolKind = 'primary',
): SupervisionExecutionBinding | undefined {
  const actual = supervisionObservedIdentityForTarget(target);
  const checked = evaluateSupervisionExecutionBinding({
    pools: resolveProjectAuthoritativeSupervisionPools(projectName, sessions),
    pool,
    actual,
  });
  if (!checked.ok || !actual.sessionName || !actual.sessionInstanceId
    || !actual.runtimeEpoch || !actual.agentType || !actual.providerFamily
    || !actual.runtimeType || !actual.model) return undefined;
  return {
    pool,
    requested: checked.requested,
    actual: actual as SupervisionObservedExecutionIdentity,
    origin: 'reused',
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

function supervisionTaskIdentityForTarget(target: SessionRecord): PersistedSupervisionTaskAssignmentIdentity | undefined {
  if (!target.name.trim()) return undefined;
  return {
    sessionName: target.name,
    sessionInstanceId: target.sessionInstanceId ?? '',
    runtimeEpoch: target.runtimeEpoch ?? '',
    agentType: target.agentType,
    providerFamily: resolvePeerAuditProviderFamily(target),
  };
}

function supervisionIdentityMatches(
  left: PersistedSupervisionTaskAssignmentIdentity,
  right: PersistedSupervisionTaskAssignmentIdentity,
): boolean {
  return Boolean(left.sessionName.trim() && right.sessionName.trim()
    && left.sessionName === right.sessionName);
}

const PAIRS_POOL_TASK_KEYS = ['autoProvision', 'executionPool', 'requestedExecutionType'] as const;

function hasLegacyTaskMetadata(input: SendMessageInput): boolean {
  if (input.audit) return true;
  if (!input.task) return false;
  return Object.keys(input.task).some((key) => !(PAIRS_POOL_TASK_KEYS as readonly string[]).includes(key));
}

function isReachedDelivery(status: string): boolean {
  return (DELEGATION_REACHED_DELIVERY_STATUSES as readonly string[]).includes(status);
}

function stripToPoolMetadata(input: SendMessageInput): SendMessageInput {
  const { audit: _audit, task, ...rest } = input;
  if (!task) return rest;
  const poolTask: Partial<SupervisionTaskMetadata> = {};
  for (const key of PAIRS_POOL_TASK_KEYS) {
    if (task[key] !== undefined) (poolTask as Record<string, unknown>)[key] = task[key];
  }
  return Object.keys(poolTask).length > 0 ? { ...rest, task: poolTask as SupervisionTaskMetadata } : rest;
}

/**
 * Inputs the implicit work-pair rule must not apply to: the inner dispatch of a
 * send that already opened (or decided about) its pair, and scheduled cron
 * sends, which are not a Brain dispatching work.
 */
const noImplicitWorkPair = new WeakSet<SendMessageInput>();

function withoutImplicitWorkPair(input: SendMessageInput): SendMessageInput {
  noImplicitWorkPair.add(input);
  return input;
}

function mintDispatchTaskPairId(caller: SendRuntimeCaller, project: string, input: SendMessageInput): string {
  const idempotencyKey = input.idempotencyKey?.trim();
  return taskPairService.mintTaskId(project, idempotencyKey ? `${caller.sessionName}\0${idempotencyKey}` : undefined);
}

/**
 * The worker a plain Brain dispatch opens a pair for, or undefined when it
 * opens none. Exactly one reached recipient; a worker of the same project
 * (never the Brain); and not already the executor or auditor of an open pair,
 * because a message to a session that is working on a pair continues that
 * pair (the Brain's progress checks, re-dispatches, audit follow-ups) rather
 * than starting a new task.
 */
function implicitWorkPairTarget(
  project: string,
  taskId: string,
  result: Extract<SendMessageResult, { status: 'accepted' }>,
  sessions: readonly SessionRecord[],
): string | undefined {
  const reached = result.deliveries.filter((delivery) => isReachedDelivery(delivery.status));
  if (result.deliveries.length !== 1 || reached.length !== 1) return undefined;
  const target = reached[0]!.target;
  const record = sessions.find((session) => session.name === target);
  if (!record || record.projectName !== project || record.role === 'brain') return undefined;
  // A replay of the same send (same idempotency key, same minted id) names
  // the pair it already opened again.
  if (getTaskPairStore().getPair(project, taskId)?.state.executor === target) return target;
  if (getTaskPairStore().isParticipantOfOpenPair(target)) return undefined;
  return target;
}

/** Open (or record on) the pair for each reached recipient and name it in the receipt. */
function bindAcceptedDispatchToTaskPair(
  caller: SendRuntimeCaller,
  project: string,
  result: Extract<SendMessageResult, { status: 'accepted' }>,
  taskId: string,
  objective: string | undefined,
  // Preserve both the requested executor model and an explicit human title.
  executorModel?: string,
  explicitTitle?: string | null,
  // True only when this taskId is being minted from real task metadata
  // (task.objective), not merely a plain send reinterpreted as one -- see
  // TaskPairService.implicitDispatch's suppressAutoPickAuditor.
  hasObjective?: boolean,
): SendMessageResult {
  const reached = result.deliveries.filter((delivery) => isReachedDelivery(delivery.status));
  const title = deriveSupervisionTaskTitleFromBrief(objective, explicitTitle) ?? deriveSupervisionTaskTitle(objective);
  for (const delivery of reached) {
    taskPairService.implicitDispatch({
      project,
      sender: caller.sessionName!,
      target: delivery.target,
      taskId,
      ...(title ? { title } : {}),
      ...(executorModel ? { executorModel } : {}),
      ...(hasObjective ? { hasObjective } : {}),
      ...(objective ? { brief: objective } : {}),
      eventId: `implicit:${delivery.messageId ?? result.dispatchId}`,
    });
  }
  const pairState = getTaskPairStore().getPair(project, taskId)?.state;
  const pairTitle = pairState?.title;
  const taskIdentity = {
    taskId,
    ...(pairTitle ? { taskTitle: pairTitle } : {}),
    ...(objective && pairTitle === title ? { taskObjective: objective } : {}),
  };
  // Each reached recipient that holds a role slot of the pair gets that
  // slot's binding id as its assignmentId (shared/task-pair.ts).
  const deliveries = result.deliveries.map((delivery) => {
    if (!isReachedDelivery(delivery.status)) return delivery;
    const assignmentId = taskPairBindingOf(pairState, delivery.target);
    return { ...delivery, ...taskIdentity, ...(assignmentId ? { assignmentId } : {}) };
  });
  const bindings = new Set(deliveries.map((delivery) => delivery.assignmentId).filter(Boolean));
  const assignmentId = bindings.size === 1 ? [...bindings][0] : undefined;
  return { ...result, ...taskIdentity, ...(assignmentId ? { assignmentId } : {}), deliveries };
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
  // On the `pairs` engine task/audit metadata is advisory: it can create a
  // missing pair (implicit DISPATCH) but never binds a legacy assignment,
  // triggers automatic audit dispatch, or rejects on identity. Only the
  // execution-pool provisioning fields keep their meaning.
  //
  // The accepted receipt still names the task (taskId, title, objective), as
  // legacy did: a new objective without a taskId opens a pair under a
  // daemon-minted id so the Brain can follow it with markers.
  if (!input.automaticSupervision && isPairsEngineProject(callerProjectName) && hasLegacyTaskMetadata(input)) {
    const objective = projectSupervisionTaskObjective(input.task?.objective);
    const result = await dispatchSendMessage(caller, withoutImplicitWorkPair(stripToPoolMetadata(input)), deps);
    if (result.status !== 'accepted') return result;
    // A new objective opens one pair for its one recipient (an explicit target
    // or an auto-provisioned worker), never for a broadcast or a clone.
    const reached = result.deliveries.filter((delivery) => isReachedDelivery(delivery.status));
    const singleTarget = !input.broadcast && !input.clone && result.deliveries.length === 1 && reached.length === 1
      ? reached[0]!.target
      : undefined;
    const explicitTaskId = input.task?.taskId?.trim();
    // Before minting: a DISPATCH marker for this exact taskId that landed in
    // the same turn (#recentBrainDispatch), or the message naming an existing
    // open pair, continues that pair instead of opening a second one for a
    // follow-up, relay, or handover message. The target merely already
    // holding a role in one open pair does NOT apply here: this branch only
    // runs with real task metadata (hasLegacyTaskMetadata), and an EXPLICIT
    // objective is clearly new work even for an already-busy target -- it
    // still gets its own pair (bullet 2; also how existing callers expect a
    // fresh idempotency key on the same target to open a second pair).
    if (!explicitTaskId && singleTarget) {
      const focused = taskPairService.recentBrainDispatch(callerProjectName, caller.sessionName!, singleTarget);
      if (focused && getTaskPairStore().getPair(callerProjectName, focused)?.state.executor === singleTarget) {
        return bindAcceptedDispatchToTaskPair(caller, callerProjectName, result, focused, objective, input.task?.requestedExecutionType?.model, input.task?.title);
      }
      const mentioned = taskPairService.resolveMentionedOpenPair(callerProjectName, caller.sessionName!, input.message ?? '');
      if (mentioned) {
        // An explicit objective that merely references another open pair in
        // its text is still new work for a target that isn't already part of
        // THAT pair (e.g. "Fix X -- follow-up to tsk_cd_Y" going to a fresh
        // executor): mint its own pair instead of swallowing it into the
        // mentioned one. Only bind when the target already holds a role in
        // the mentioned pair (or is being handed it), matching bullet 1(b)'s
        // participant test rather than the bare-mention test.
        const mentionedState = getTaskPairStore().getPair(callerProjectName, mentioned)?.state;
        const targetAlreadyInMentionedPair = !!mentionedState
          && (mentionedState.executor === singleTarget || mentionedState.auditor === singleTarget);
        if (!objective || targetAlreadyInMentionedPair) {
          return bindAcceptedDispatchToTaskPair(
            caller, callerProjectName, result, mentioned, objective,
            input.task?.requestedExecutionType?.model, input.task?.title,
          );
        }
      }
      if (!objective) {
        const existingTaskId = taskPairService.resolveSingleParticipantOpenPair(caller.sessionName!, singleTarget);
        if (existingTaskId) {
          return bindAcceptedDispatchToTaskPair(
            caller, callerProjectName, result, existingTaskId, objective,
            input.task?.requestedExecutionType?.model, input.task?.title,
          );
        }
      }
    }
    const opensNewTask = !explicitTaskId && !!objective && !!singleTarget;
    const taskId = explicitTaskId || (opensNewTask
      ? mintDispatchTaskPairId(caller, callerProjectName, input)
      : undefined);
    if (!taskId) return result;
    return bindAcceptedDispatchToTaskPair(
      caller,
      callerProjectName,
      result,
      taskId,
      objective,
      input.task?.requestedExecutionType?.model,
      input.task?.title,
      !!objective,
    );
  }
  // A Brain that dispatches work with a plain send_message (no task metadata,
  // no DISPATCH marker) on a `pairs` project with automatic audit still gets a
  // pair: a daemon-level rule, not model guidance, so it holds whatever the
  // Brain's prompt says. See implicitWorkPairTarget for exactly when.
  if (!input.automaticSupervision && !noImplicitWorkPair.has(input)
    && isPairsEngineProject(callerProjectName) && !input.broadcast && !input.clone
    && caller.sessionName === projectBrainSession(callerProjectName)
    && resolveProjectAuthoritativeSupervisionSnapshot(callerProjectName, allSessions).mode === SUPERVISION_MODE.SUPERVISED_AUDIT) {
    const result = await dispatchSendMessage(caller, withoutImplicitWorkPair({ ...input }), deps);
    if (result.status !== 'accepted') return result;
    const reached = result.deliveries.filter((delivery) => isReachedDelivery(delivery.status));
    const target = result.deliveries.length === 1 && reached.length === 1 ? reached[0]!.target : undefined;
    const focused = target ? taskPairService.recentBrainDispatch(callerProjectName, caller.sessionName, target) : undefined;
    // A DISPATCH marker already opened this pair in the same turn: bind the
    // receipt to it and, crucially, do not mint/bind a second implicit pair
    // for the follow-up message.
    if (focused && target && getTaskPairStore().getPair(callerProjectName, focused)?.state.executor === target) {
      return bindAcceptedDispatchToTaskPair(caller, callerProjectName, result, focused, projectSupervisionTaskObjective(input.message));
    }
    // The message names an open pair, or the target already holds a role in
    // exactly one open pair of this Brain: continue that pair, never a
    // second one, for a follow-up, relay, or notice. A plain send like this
    // never carries an objective, so both checks always apply (unlike the
    // task-metadata branch above).
    const existingTaskId = target
      ? taskPairService.resolveMentionedOpenPair(callerProjectName, caller.sessionName, input.message ?? '')
        ?? taskPairService.resolveSingleParticipantOpenPair(caller.sessionName, target)
      : undefined;
    if (existingTaskId) {
      return bindAcceptedDispatchToTaskPair(caller, callerProjectName, result, existingTaskId, projectSupervisionTaskObjective(input.message));
    }
    const taskId = mintDispatchTaskPairId(caller, callerProjectName, input);
    if (!implicitWorkPairTarget(callerProjectName, taskId, result, d.listSessions())) return result;
    return bindAcceptedDispatchToTaskPair(caller, callerProjectName, result, taskId, projectSupervisionTaskObjective(input.message));
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
  if (input.identity && !autoProvision) {
    return {
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
      error: 'identity is available only with task.autoProvision=true',
    };
  }
  if (input.identity) {
    const identityError = sessionIdentityContentError(input.identity.content, SESSION_IDENTITY_SCOPES.SESSION);
    if (identityError) {
      return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: identityError };
    }
    input = {
      ...input,
      identity: { ...input.identity, content: normalizeSessionIdentityContent(input.identity.content) },
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
      ? `@pool:${input.audit ? 'audit' : input.task?.executionPool ?? 'primary'}:${input.task?.requestedExecutionType?.capabilityId ?? '*'}:${input.identity ? createHash('sha256').update(input.identity.content).digest('hex') : '*'}`
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
  let provisioning: SupervisionProvisioningEvidence | undefined = input.internalProvisioningAttempt;
  let auditRoutingReason: SupervisionAuditRoutingReason | undefined;
  let auditDegradedReason: SupervisionAuditDegradedReason | undefined;
  if (autoProvision) {
    const provision = await (deps?.provisionSupervisionTarget ?? defaultProvisionSupervisionTarget)({
      parentSessionName: caller.sessionName,
      pool: input.task?.executionPool ?? 'primary',
      requestedCapabilityId: input.task?.requestedExecutionType?.capabilityId,
      requestedExecutionConfig: input.task?.requestedExecutionType ?? undefined,
      identityPrompt: input.identity?.content,
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
    if (input.identity && deps?.applyProvisionedIdentity) {
      const appliedIdentity = await deps.applyProvisionedIdentity(provision.target, input.identity);
      if (!appliedIdentity.ok) {
        return {
          status: 'error',
          reason: MCP_ERROR_REASONS.INTERNAL_ERROR,
          error: `provisioned identity could not be persisted: ${sanitizeMcpErrorMessage(appliedIdentity.error)}`,
          provisioning: provision.evidence,
        };
      }
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

  // ── Control-plane auditPolicy bind ─────────────────────────────────────
  //
  // `auditPolicy` is TASK authority, not a message. Binding it used to ride on
  // the implementation-delivery path, which requires exactly one dispatchable
  // target, validates that target against the project's execution pool, and
  // reaches the bind only through a task continuation that re-checks the frozen
  // implementer's identity. A historical ready_for_audit task therefore could
  // not acquire a policy once its implementer drifted -- model no longer
  // pool-selected, or a rotated runtime epoch -- and the observed workaround was
  // a manual SAME-assignment identity rebind, after which delivery still failed.
  //
  // This branch runs BEFORE any dispatchable-target, execution-pool or
  // continuation-identity check and AFTER its own exact authority gates. It
  // delivers nothing, fabricates no delivery record, mutates no implementer
  // identity/binding/status/lease/scope/revision/worktree and no historical
  // receipt, and then reuses the ONE existing ready-audit trigger. Every gate
  // below refuses with zero writes.
  //
  // The ordinary send path is untouched: this returns before it, so exact-one-
  // target and pool validation still apply byte-for-byte to every real message.
  // Discriminator: a control-plane bind names a TASK and no assignment. Supplying
  // an assignmentId means "continue this exact assignment", which is a real
  // delivery and must keep the ordinary path byte-for-byte -- including its
  // exact-one-target and execution-pool gates. Only the assignment-less form,
  // which has nothing to deliver and nobody to continue, is control-plane.
  const controlPlaneAuditPolicy = !input.audit
    && input.task?.taskId?.trim()
    && !input.task.assignmentId?.trim()
    ? input.task.auditPolicy ?? undefined
    : undefined;
  if (controlPlaneAuditPolicy) {
    const controlPlaneTaskId = input.task!.taskId!.trim();
    const registry = getSupervisionTaskRegistry();
    const task = registry.get(controlPlaneTaskId);
    const callerRecord = allSessions.find((session) => session.name === caller.sessionName);
    const callerIdentity = callerRecord && supervisionTaskIdentityForTarget(callerRecord);
    const reject = (error: string, reason: SendToolErrorReason = MCP_ERROR_REASONS.VALIDATION_FAILED) => ({
      status: 'error' as const, reason, error,
    });

    if (!task) return reject('task is not visible to this caller', MCP_ERROR_REASONS.IDENTITY_REJECTED);
    // Exact same-project live Brain coordinator, by identity, not by name.
    const exactCoordinator = callerIdentity && task.assignments.find((assignment) => (
      assignment.role === 'coordinator'
      && supervisionIdentityMatches(assignment.identity, callerIdentity)
    ));
    const authoritativeBrainMayCoordinate = isUniqueAuthoritativeProjectBrainCaller(
      callerRecord, callerProjectName, allSessions,
    );
    if (callerRecord?.role !== 'brain' || callerRecord.parentSession
      || task.projectName !== callerProjectName
      || (!exactCoordinator && !authoritativeBrainMayCoordinate)) {
      return reject(
        'task auditPolicy requires the exact authoritative project Brain coordinator',
        MCP_ERROR_REASONS.IDENTITY_REJECTED,
      );
    }
    if (resolveProjectAuthoritativeSupervisionSnapshot(callerProjectName, allSessions).mode
      !== SUPERVISION_MODE.SUPERVISED_AUDIT) {
      return reject('task auditPolicy requires supervised_audit mode on the authoritative project Brain');
    }
    if (!isAuditableSupervisionTaskClassification(task.classification)) {
      return reject('task auditPolicy requires an auditable task classification');
    }
    if (isTerminalSupervisionTaskStatus(task.status) || task.finalization) {
      return reject('task auditPolicy cannot be bound on a terminal task');
    }
    const controlPlaneRevision = task.currentRevision?.trim();
    if (!controlPlaneRevision) return reject('task auditPolicy requires an exact current revision');
    const requestedRevision = input.task!.currentRevision?.trim();
    if (requestedRevision && requestedRevision !== controlPlaneRevision) {
      return reject('task continuation revision does not match the authoritative task revision');
    }
    if (task.auditPolicy && task.auditPolicy !== controlPlaneAuditPolicy) {
      return reject('task auditPolicy conflicts with the immutable task policy');
    }
    // An auditor already holding this revision, or a settled verdict, means the
    // audit round is decided; attaching a policy now would rewrite that history.
    const liveExactAuditors = task.assignments.filter((assignment) => (
      assignment.role === 'auditor'
      && assignment.auditRevision === controlPlaneRevision
      && !['rework', 'cancelled', 'finalized'].includes(assignment.status)
    ));
    if (!task.auditPolicy && liveExactAuditors.length > 0) {
      return reject('task auditPolicy cannot be attached after an auditor exists for the exact revision');
    }
    if (!task.auditPolicy && registry.listAuditReceipts(controlPlaneTaskId).some((receipt) => (
      receipt.revision === controlPlaneRevision && receipt.receiptKind === 'final'
    ))) {
      return reject('task auditPolicy cannot be attached after a final receipt for the exact revision');
    }

    // Only the task row is written, and only when it is not already satisfied.
    let policyBound: 'newly_bound' | 'already_bound' = 'already_bound';
    if (!task.auditPolicy) {
      const bound = registry.updateTask({
        taskId: controlPlaneTaskId, auditPolicy: controlPlaneAuditPolicy, now,
      });
      if (!bound.ok) return reject(`task auditPolicy bind rejected: ${bound.reason}`);
      policyBound = 'newly_bound';
    }

    // The SAME trigger the ordinary path uses. dispatchReadyAudit is itself
    // fail-closed and idempotent, so a replay cannot mint a second auditor and
    // a crash before this line is recovered by the existing boot sweep.
    let auditTrigger: 'skipped' | 'invoked' | 'failed' = 'skipped';
    if (task.status === 'ready_for_audit') {
      try {
        await (deps?.dispatchReadyAudit ?? dispatchReadyAudit)(controlPlaneTaskId);
        auditTrigger = 'invoked';
      } catch {
        auditTrigger = 'failed';
      }
    }
    return {
      status: 'accepted',
      dispatchId: createSendDispatchId(),
      deliveries: [],
      taskId: controlPlaneTaskId,
      controlPlane: {
        operation: 'audit_policy_bind',
        auditPolicy: controlPlaneAuditPolicy,
        policyBound,
        auditTrigger,
      },
    };
  }

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
  /** Readable title derived from the registry objective at dispatch time. */
  let supervisedTaskTitle: string | undefined;
  let supervisedTaskObjective: string | undefined;
  /** The dispatch continues an assignment that already existed. */
  let supervisedAssignmentReused = false;
  let supervisedAssignmentGeneration: number | undefined;
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
  let automaticAuditRoutingRecoveryClear: {
    taskId: string;
    assignmentId: string;
    blocker: string;
  } | undefined;

  if (input.task) {
    const targetRecord = dispatchable[0]!;
    const targetIdentity = supervisionTaskIdentityForTarget(targetRecord);
    if (!targetIdentity) return { status: 'error', reason: MCP_ERROR_REASONS.IDENTITY_REJECTED, error: 'task target identity is unavailable' };
    if (targetRecord.role === 'brain' && !targetRecord.parentSession) {
      return {
        status: 'error',
        reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN,
        error: 'the project Brain may coordinate supervised work but cannot be an implementer or auditor',
      };
    }
    // Task metadata turns both implementation AND audit sends into supervised
    // execution. Validate the exact target against the project's authoritative pool
    // before touching the registry, claims, reply authority or transport.
    // Audit eligibility is an additional gate below, never a pool bypass.
    const callerRecord = allSessions.find((session) => session.name === caller.sessionName);
    const callerSupervisionSnapshot = resolveProjectAuthoritativeSupervisionSnapshot(
      callerProjectName,
      allSessions,
    );
    const registry = getSupervisionTaskRegistry();
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
    const authoritativeBrainManualSelection = Boolean(
      !input.automaticSupervision
      && !autoProvision
      && isUniqueAuthoritativeProjectBrainCaller(callerRecord, callerProjectName, allSessions)
      && resolveEffectiveProjectName(targetRecord, allSessions) === callerProjectName
      && targetRecord.name !== callerRecord?.name
      && targetRecord.state !== 'stopped'
      && (targetRecord.runtimeType ?? getSessionRuntimeType(targetRecord.agentType)) === 'transport'
      && targetRecord.sessionInstanceId?.trim()
      && targetRecord.runtimeEpoch?.trim(),
    );
    const explicitManualSelection = Boolean(
      autoProvision
      && !input.automaticSupervision
      && input.task.requestedExecutionType
      && provisioning?.selectedConfig?.capabilityId === input.task.requestedExecutionType.capabilityId
      && evaluateSupervisionObservedIdentity({
        config: input.task.requestedExecutionType,
        actual,
        pool,
      }).ok,
    );
    const requestedTaskId = input.task.taskId?.trim();
    const recoveryTask = input.audit && requestedTaskId
      ? registry.get(requestedTaskId)
      : undefined;
    const recoveryRevision = String(
      input.task.auditRevision ?? input.task.currentRevision ?? '',
    ).trim();
    const recoveryAttempt = input.task.auditAttemptId?.trim() || input.audit?.attemptId;
    const recoveryImplementers = recoveryTask?.assignments.filter((assignment) => (
      assignment.required
      && (assignment.role === 'implementer' || assignment.role === 'integration_owner')
      && assignment.status === 'ready_for_audit'
      && assignment.auditRevision === recoveryRevision
    )) ?? [];
    const recoveryAuditors = recoveryTask?.assignments.filter((assignment) => (
      assignment.role === 'auditor'
      && assignment.auditRevision === recoveryRevision
      && !['cancelled', 'finalized'].includes(assignment.status)
    )) ?? [];
    const callerIdentity = callerRecord && supervisionTaskIdentityForTarget(callerRecord);
    const callerOwnsRecovery = Boolean(callerIdentity && recoveryTask?.assignments.some((assignment) => (
      assignment.role === 'coordinator'
      && supervisionIdentityMatches(assignment.identity, callerIdentity)
    )));
    // Pool configuration admits new implementation work. It must not make an
    // already-valid ready_for_audit task a permanent dead end. The exact
    // authoritative Brain may bind one explicitly selected live transport as
    // the canonical fresh strict-cross-vendor auditor when every durable fact
    // is exact and the task currently has zero auditors. Any mismatch remains
    // on the ordinary fail-closed pool path.
    const exactUnconfiguredAuditRecovery = Boolean(
      input.audit?.strictCrossVendor === true
      && input.task.assignmentId === undefined
      && recoveryTask
      && recoveryTask.projectName === callerProjectName
      && recoveryTask.status === 'ready_for_audit'
      && recoveryTask.validationState === 'passed'
      && recoveryTask.auditPolicy === 'auto_strict_cross_vendor'
      && input.task.auditPolicy === recoveryTask.auditPolicy
      && recoveryTask.currentRevision === recoveryRevision
      && recoveryAttempt === automaticAuditAttemptId(recoveryTask.taskId, recoveryRevision)
      && recoveryImplementers.length === 1
      && recoveryAuditors.length === 0
      && callerRecord?.role === 'brain'
      && !callerRecord.parentSession
      && callerOwnsRecovery
      && targetRecord.name !== recoveryImplementers[0]?.identity.sessionName
      && targetIdentity.providerFamily !== recoveryImplementers[0]?.identity.providerFamily
      && (targetRecord.runtimeType ?? getSessionRuntimeType(targetRecord.agentType)) === 'transport'
      && targetRecord.sessionInstanceId?.trim()
      && targetRecord.runtimeEpoch?.trim(),
    );
    if (exactUnconfiguredAuditRecovery && recoveryTask && recoveryImplementers[0]) {
      const blocker = matchingAutomaticAuditRoutingBlocker(
        recoveryTask,
        recoveryImplementers[0],
      );
      if (blocker) {
        automaticAuditRoutingRecoveryClear = {
          taskId: recoveryTask.taskId,
          assignmentId: recoveryImplementers[0].assignmentId,
          blocker,
        };
      }
    }
    const poolSelected = targetMatchesConfiguredSupervisionPool(pools, pool, targetRecord, actual)
      && checked.ok;
    if (!poolSelected && !explicitManualSelection && !exactUnconfiguredAuditRecovery
      && !authoritativeBrainManualSelection) {
      return {
        status: 'error',
        reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
        error: `task execution pool rejected target: ${checked.ok ? 'unselected_config' : checked.reason}`,
      };
    }
    const executionBinding: SupervisionExecutionBinding = authoritativeBrainManualSelection && !poolSelected
      ? exactManualSupervisionExecutionBinding(actual as SupervisionObservedExecutionIdentity, pool)
      : poolSelected && checked.ok
      ? {
          pool,
          requested: checked.requested,
          actual: actual as SupervisionObservedExecutionIdentity,
          origin: provisioning?.createdSessionName ? 'spawned' : 'reused',
        }
      : explicitManualSelection && input.task.requestedExecutionType
        ? {
            pool,
            requested: input.task.requestedExecutionType,
            actual: actual as SupervisionObservedExecutionIdentity,
            origin: provisioning?.createdSessionName ? 'spawned' : 'reused',
          }
      : (() => {
          const exactActual = actual as SupervisionObservedExecutionIdentity;
          return {
            pool,
            requested: input.task!.requestedExecutionType ?? {
              capabilityId: buildSupervisionExecutionCapabilityId(exactActual),
              agentType: exactActual.agentType,
              providerFamily: exactActual.providerFamily,
              runtimeType: exactActual.runtimeType,
              model: exactActual.model,
              ...(exactActual.ccPresetId ? { ccPresetId: exactActual.ccPresetId } : {}),
            },
            actual: exactActual,
            origin: 'manual',
          };
        })();
    supervisedExecutionBinding = executionBinding;
    if (input.audit) {
      // Same single validator as the audit-only path above; already run.
      const taskRouteCheck = validateBrainAuditRoute(targetRecord);
      if (!taskRouteCheck.ok) return { status: 'error', reason: taskRouteCheck.reason, error: taskRouteCheck.error };
    }
    const newTaskCoordinatorIdentity = !requestedTaskId && callerRecord?.role === 'brain'
      ? supervisionTaskIdentityForTarget(callerRecord)
      : undefined;
    if (!requestedTaskId && callerRecord?.role === 'brain' && !newTaskCoordinatorIdentity) {
      return { status: 'error', reason: MCP_ERROR_REASONS.IDENTITY_REJECTED, error: 'task coordinator identity is unavailable' };
    }
    let taskId: string;
    if (requestedTaskId) {
      const existing = registry.get(requestedTaskId);
      const existingAuthority = supervisionTaskCallerAuthority({
        item: existing,
        callerSessionName: caller.sessionName,
        callerProjectName,
        liveIdentity: callerRecord ? {
          ...supervisionTaskIdentityForTarget(callerRecord),
          projectName: resolveEffectiveProjectName(callerRecord, allSessions),
        } : undefined,
        liveProjectBrain: isUniqueAuthoritativeProjectBrainCaller(callerRecord, callerProjectName, allSessions),
      });
      const legacyBrainMayCoordinate = Boolean(
        existing
        && existing.projectName === callerProjectName
        && !existing.assignments.some((assignment) => assignment.role === 'coordinator')
        && isUniqueAuthoritativeProjectBrainCaller(callerRecord, callerProjectName, allSessions),
      );
      // Explicit task ids are references, never create requests. Keep missing
      // and unauthorized indistinguishable so send_message is not a task-id
      // existence oracle. Project/role alone is not ownership. The sole legacy
      // exception is one unique live project Brain when the task has no
      // coordinator row at all; ambiguity still fails closed.
      if (!existing
        || existing.projectName !== callerProjectName
        || (!legacyBrainMayCoordinate
          && !existingAuthority.participantMayRead
          && !existingAuthority.coordinatorMayAct)) {
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
      // An audit send that merely RESTATES the already-persisted policy is a
      // no-op, not a bind, so the whole bind block is skipped for it. The block
      // used to be entered on the mere PRESENCE of auditPolicy, which refused an
      // exact audit continuation that echoed back the policy it had just read --
      // observed on tsk_bzp, where the policy was already persisted and an exact
      // auditor/attempt already existed, yet redelivery WITH audit metadata was
      // rejected while the identical append WITHOUT it succeeded. A real bind
      // (no policy yet) and a conflicting value still enter the block and are
      // still refused by the guards inside it.
      const auditRestatesPersistedPolicy = Boolean(input.audit)
        && Boolean(explicitAuditPolicy)
        && existing.auditPolicy === explicitAuditPolicy;
      if (explicitAuditPolicy && !auditRestatesPersistedPolicy) {
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
        if (callerRecord?.role !== 'brain' || callerRecord.parentSession
          || (!exactCoordinator && !authoritativeBrainManualSelection)) {
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
          const auditedOwners = existing.assignments.filter((assignment) => (
            assignment.role === 'implementer'
            && assignment.required
            && assignment.auditRevision === recoveryRevision
            && !['cancelled', 'recovered', 'finalized'].includes(assignment.status)
          ));
          const selectedCxOrCcTransport = isAutomaticAuditTransportTarget(targetRecord);
          const exactStrictSameObjectRecovery = Boolean(
            input.audit.strictCrossVendor === true
            && poolSelected
            && candidate.role === 'auditor'
            && !AUDITOR_TERMINAL_STATUSES.has(candidate.status)
            && ['ready_for_audit', 'ready_for_integration', 'blocked'].includes(existing.status)
            && existing.validationState === 'passed'
            && !existing.finalization
            && existing.currentRevision === recoveryRevision
            && candidate.auditRevision === recoveryRevision
            && candidate.auditAttemptId === recoveryAttempt
            && recoveryAuditors.length === 1
            && recoveryAuditors[0]?.assignmentId === candidate.assignmentId
            && auditedOwners.length === 1
            && auditedOwners[0]?.identity.sessionName === input.audit.auditedSessionName
            && auditedOwners[0]?.identity.providerFamily !== targetIdentity.providerFamily
            && callerRecord?.role === 'brain'
            && !callerRecord.parentSession
            && callerOwnsRecovery
            && resolveEffectiveProjectName(targetRecord, allSessions) === callerProjectName
            && selectedCxOrCcTransport
            && targetRecord.state !== 'stopped'
            && targetRecord.sessionInstanceId?.trim()
            && targetRecord.runtimeEpoch?.trim()
          );
          const authoritativeBrainSameObjectRecovery = Boolean(
            authoritativeBrainManualSelection
            && candidate.role === 'auditor'
            && !AUDITOR_TERMINAL_STATUSES.has(candidate.status)
            && candidate.auditAttemptId === recoveryAttempt
            && candidate.auditRevision === recoveryRevision
            && existing.currentRevision === recoveryRevision,
          );
          const identityDrifted = candidate.identity.sessionName !== targetIdentity.sessionName
            || candidate.identity.sessionInstanceId !== targetIdentity.sessionInstanceId
            || candidate.identity.runtimeEpoch !== targetIdentity.runtimeEpoch
            || candidate.identity.agentType !== targetIdentity.agentType
            || candidate.identity.providerFamily !== targetIdentity.providerFamily
            || (candidate.executionBinding !== undefined
              && !supervisionSelectedExecutionBindingMatches(candidate.executionBinding, executionBinding));
          if (identityDrifted) {
            if (!exactStrictSameObjectRecovery && !authoritativeBrainSameObjectRecovery) {
              return {
                status: 'error',
                reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
                error: 'audit recovery requires one exact open selected Cx/CC transport assignment, attempt and revision',
              };
            }
            const rebound = registry.rebindAuditAssignment({
              taskId: existing.taskId,
              assignmentId: candidate.assignmentId,
              identity: targetIdentity,
              callerProjectName,
              reason: authoritativeBrainSameObjectRecovery
                ? 'authoritative Brain manual SAME-assignment auditor rebind'
                : 'exact selected strict cross-vendor SAME-auditor recovery',
              expectedGeneration: candidate.generation,
              expectedAttemptId: recoveryAttempt,
              expectedRevision: recoveryRevision,
              strictCrossVendor: input.audit.strictCrossVendor === true,
              executionBinding: authoritativeBrainSameObjectRecovery
                ? { ...executionBinding, origin: 'manual' }
                : executionBinding,
              ...(authoritativeBrainSameObjectRecovery ? { authoritativeBrainOverride: true } : {}),
              now,
            });
            if (!rebound.ok) {
              return {
                status: 'error',
                reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
                error: `audit SAME-object rebind rejected: ${rebound.reason}`,
              };
            }
            reusedAuditAssignment = rebound.value;
          } else {
            reusedAuditAssignment = candidate;
          }
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
          if (exact?.role === 'implementer' && authoritativeBrainManualSelection) {
            const identityOrBindingChanged = !supervisionIdentityMatches(exact.identity, targetIdentity)
              || !supervisionSelectedExecutionBindingMatches(exact.executionBinding, executionBinding);
            if (identityOrBindingChanged) {
              const rebound = registry.rebindAuditAssignment({
                taskId: existing.taskId,
                assignmentId: exact.assignmentId,
                identity: targetIdentity,
                callerProjectName,
                reason: 'authoritative Brain manual SAME-assignment implementer rebind',
                expectedGeneration: exact.generation,
                ...(exact.auditRevision ? { expectedRevision: exact.auditRevision } : {}),
                executionBinding: { ...executionBinding, origin: 'manual' },
                authoritativeBrainOverride: true,
                now,
              });
              if (!rebound.ok) {
                return {
                  status: 'error',
                  reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
                  error: `Brain implementer SAME-object rebind rejected: ${rebound.reason}`,
                };
              }
              reusedContinuationAssignment = rebound.value;
            } else {
              reusedContinuationAssignment = exact;
            }
            if (reusedContinuationAssignment
              && ['blocked', 'cancelled'].includes(reusedContinuationAssignment.status)) {
              const reopened = registry.coordinateTaskAssignment({
                taskId: existing.taskId,
                assignmentId: reusedContinuationAssignment.assignmentId,
                ...(['blocked', 'cancelled'].includes(existing.status)
                  ? { taskStatus: 'recovered' as const } : {}),
                assignmentStatus: 'recovered',
                leaseAction: 'renew',
                idempotencyKey: input.idempotencyKey?.trim()
                  ? `brain-send-reopen:${input.idempotencyKey.trim()}`
                  : `brain-send-reopen:${existing.taskId}:${reusedContinuationAssignment.assignmentId}:${targetIdentity.sessionInstanceId}:${targetIdentity.runtimeEpoch}`,
                reason: 'authoritative Brain manual SAME-assignment implementer reopen',
                authoritativeBrainOverride: true,
                now,
              });
              if (!reopened.ok) {
                return {
                  status: 'error',
                  reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
                  error: `Brain implementer SAME-object reopen rejected: ${reopened.reason}`,
                };
              }
              reusedContinuationAssignment = registry.getAssignment(
                reusedContinuationAssignment.assignmentId,
              );
            }
          }
          if (exact && exact.role !== 'implementer') {
            if (!isExactContinuationEligible({
              taskProjectName: existing.projectName,
              taskCurrentRevision: existing.currentRevision,
              assignment: {
                role: exact.role, status: exact.status, required: exact.required,
                auditAttemptId: exact.auditAttemptId, auditRevision: exact.auditRevision,
                identity: exact.identity,
              },
              targetProjectName: targetRecord.projectName,
              targetIdentity,
            })) {
              return {
                status: 'error',
                reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
                error: 'task continuation assignmentId is not an exact continuable assignment for this target',
              };
            }
            // Same stale-revision guard the implementer path applies.
            if (!authoritativeBrainManualSelection
              && input.task.currentRevision && existing.currentRevision
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
            && existing.projectName === targetRecord.projectName;
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
          if (!authoritativeBrainManualSelection
            && input.task.currentRevision && existing.currentRevision
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

      // A continuation is delivered to the daemon's CURRENT runtime, not to
      // the historical instance/epoch stored when the assignment was minted.
      // Refresh that observational tuple before dispatch, on the exact existing
      // task/assignment, so the worker cannot receive an append and then lose
      // its immediately-following task_update/finish to owner_mismatch.
      //
      // Do not synthesize authority from the requested target alone. The
      // registry receives the complete live project/session census and owns the
      // fail-closed decision (terminal lifecycle, wrong project/session, or an
      // ambiguous same-name runtime). No scope, revision, receipt, lease, or
      // assignment id is changed by this convergence.
      if (reusedContinuationAssignment
        && (reusedContinuationAssignment.identity.sessionInstanceId !== targetIdentity.sessionInstanceId
          || reusedContinuationAssignment.identity.runtimeEpoch !== targetIdentity.runtimeEpoch
          || reusedContinuationAssignment.identity.agentType !== targetIdentity.agentType
          || reusedContinuationAssignment.identity.providerFamily !== targetIdentity.providerFamily)) {
        const candidates = allSessions.flatMap((candidate) => {
          const identity = supervisionTaskIdentityForTarget(candidate);
          const projectName = resolveEffectiveProjectName(candidate, allSessions);
          return candidate.state !== 'stopped' && identity && projectName
            ? [{ projectName, identity }]
            : [];
        });
        const converged = registry.convergeImplementationHeartbeatTarget({
          taskId,
          assignmentId: reusedContinuationAssignment.assignmentId,
          candidates,
          now,
        });
        if (!converged.ok) {
          return {
            status: 'error',
            reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
            error: `task continuation identity convergence rejected: ${converged.reason}`,
          };
        }
        reusedContinuationAssignment = converged.value;
      }
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
    if (input.audit && input.internalAuditValidationAuthority !== undefined
      && !registry.validationAuthoritySnapshotHolds(input.internalAuditValidationAuthority, {
        taskId,
        revision: String(input.task.auditRevision ?? input.task.currentRevision ?? ''),
      })) {
      return {
        status: 'error',
        reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
        error: 'task registry rejected assignment: stale_audit_revision',
      };
    }
    const assignment = reusedAssignment
      ? { ok: true as const, value: reusedAssignment, replay: true as const }
      : registry.createAssignment({
          taskId,
          role: input.audit ? 'auditor' : 'implementer',
          identity: targetIdentity,
          scopeFiles: [...(input.task.ownedFiles ?? []), ...(input.task.sharedFiles ?? [])],
          auditAttemptId: input.task.auditAttemptId ?? input.audit?.attemptId,
          auditRevision: input.task.auditRevision ?? input.task.currentRevision,
          ...(executionBinding ? { executionBinding } : {}),
          ...(input.task.economyPolicy ? { economyPolicy: input.task.economyPolicy } : {}),
          ...(auditRoutingReason ? { auditRoutingReason } : {}),
          ...(auditDegradedReason ? { auditDegradedReason } : {}),
          ...(provisioning ? { provisioning } : {}),
          ...(input.audit && input.internalAuditValidationAuthority !== undefined
            ? { validationAuthority: input.internalAuditValidationAuthority }
            : {}),
          idempotencyKey: idempotencyKey ? `send:${idempotencyKey}` : undefined,
          now,
      });
    if (!assignment.ok) return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: `task registry rejected assignment: ${assignment.reason}` };

    // A SAME-assignment continuation is addressed to the explicit live target,
    // while executionBinding.actual is the durable record of where that work
    // was admitted. If an administrative identity rebind updated only one of
    // them, dispatching would deliver to one session and report/authorize the
    // other. Refuse before minting reply authority or touching the transport;
    // the project Brain must atomically converge the existing assignment first.
    const boundSessionName = assignment.value.executionBinding?.actual.sessionName.trim();
    if (assignment.replay && boundSessionName && boundSessionName !== targetIdentity.sessionName) {
      return {
        status: 'error',
        reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
        error: 'task assignment execution binding conflicts with exact target; authoritative rebind required',
      };
    }

    supervisedTaskId = taskId;
    supervisedAssignmentId = assignment.value.assignmentId;
    // The registry objective, never the caller's prose, names the task on every
    // surface: the delivered body, the accepted receipt and the dispatch card.
    supervisedTaskObjective = projectSupervisionTaskObjective(registry.get(taskId)?.objective);
    supervisedTaskTitle = deriveSupervisionTaskTitle(supervisedTaskObjective);
    supervisedAssignmentReused = Boolean(reusedAssignment);
    supervisedAssignmentGeneration = assignment.value.generation;
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
        && authoritativeTask?.projectName === targetRecord.projectName;
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
        const mismatches = [
          ...(assignment.value.role !== 'auditor'
            ? [`role expected="auditor" actual=${JSON.stringify(assignment.value.role)}`] : []),
          ...(AUDITOR_TERMINAL_STATUSES.has(assignment.value.status)
            ? [`status expected="non_terminal" actual=${JSON.stringify(assignment.value.status)}`] : []),
          ...(assignment.value.auditAttemptId !== requestedAttemptId
            ? [`attemptId expected=${JSON.stringify(assignment.value.auditAttemptId ?? '')} actual=${JSON.stringify(requestedAttemptId)}`] : []),
          ...(!requestedRevision || assignment.value.auditRevision !== requestedRevision
            ? [`revision expected=${JSON.stringify(assignment.value.auditRevision ?? '')} actual=${JSON.stringify(requestedRevision)}`] : []),
          ...(authoritativeTask?.currentRevision !== requestedRevision
            ? [`currentRevision expected=${JSON.stringify(authoritativeTask?.currentRevision ?? '')} actual=${JSON.stringify(requestedRevision)}`] : []),
          ...(assignment.value.identity.sessionName !== targetIdentity.sessionName
            ? [`sessionName expected=${JSON.stringify(assignment.value.identity.sessionName)} actual=${JSON.stringify(targetIdentity.sessionName)}`] : []),
          ...(authoritativeTask?.projectName !== targetRecord.projectName
            ? [`projectName expected=${JSON.stringify(authoritativeTask?.projectName ?? '')} actual=${JSON.stringify(targetRecord.projectName ?? '')}`] : []),
          ...(finalReceipt ? ['finalReceipt expected=false actual=true'] : []),
        ];
        return {
          status: 'error',
          reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
          error: `audit redelivery identity rejected: ${mismatches.join('; ')}`,
        };
      }
      const messageId = input.internalMessageId ?? (input.automaticSupervision
        ? deterministicAutomaticAuditDeliveryMessageId(
            assignment.value.assignmentId,
            input.audit.attemptId,
            assignment.value.generation,
          )
        : deterministicSendMessageId(`manual-audit:${assignment.value.assignmentId}:${input.audit.attemptId}`));
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
        ? input.automaticSupervision
          ? deterministicAutomaticAuditDeliveryMessageId(
              supervisedAssignmentId,
              input.audit.attemptId,
              supervisedAssignmentGeneration ?? 1,
            )
          : deterministicSendMessageId(`manual-audit:${supervisedAssignmentId}:${input.audit.attemptId}`)
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
    // Every supervised dispatch -- a new assignment or a continuation of an
    // existing one -- opens with the formal identity the recipient must be able
    // to verify: the registry title and the exact taskId and assignmentId.
    const newAssignmentBinding = Boolean(supervisedExecutionBinding && !reusedContinuationAssignment);
    const assignmentMessage = [
      ...(supervisedTaskId && supervisedAssignmentId ? [
        formatSupervisionTaskIdentityHeader({
          ...(supervisedTaskTitle ? { title: supervisedTaskTitle } : {}),
          taskId: supervisedTaskId,
          assignmentId: supervisedAssignmentId,
        }),
        '',
      ] : []),
      ...(supervisedExecutionBinding && newAssignmentBinding ? [
          JSON.stringify({
            contractRefs: [SUPERVISION_CONTRACT_IDS.DELEGATION_ELIGIBILITY, SUPERVISION_CONTRACT_IDS.MESSAGING],
            binding: {
              mode: 'new_assignment',
              taskId: supervisedTaskId,
              assignmentId: supervisedAssignmentId,
              ...(supervisedTaskTitle ? { title: supervisedTaskTitle } : {}),
              pool: supervisedExecutionBinding.pool,
              requested: supervisedExecutionBinding.requested,
              actual: supervisedExecutionBinding.actual,
            },
          }),
          '',
        ] : []),
      ...(supervisedTaskId && supervisedAssignmentId && !newAssignmentBinding ? [
          JSON.stringify({
            contractRefs: [SUPERVISION_CONTRACT_IDS.MESSAGING],
            binding: {
              mode: supervisedAssignmentReused ? 'continue_existing' : 'new_assignment',
              taskId: supervisedTaskId,
              assignmentId: supervisedAssignmentId,
              ...(supervisedTaskTitle ? { title: supervisedTaskTitle } : {}),
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
      ...(input.internalStructuredPayload ? {} : { from: caller.sessionName, fromLabel: callerRecord?.label }),
      replyTo: replyRequired ? caller.sessionName : null,
      ...(replyAuthority ? { replyAuthority: replyAuthority.authority } : {}),
    });
    try {
      const dispatchResult = await d.dispatchMessage(target, message, {
        dispatchId,
        messageId,
        // Another session (or the daemon's own supervision) wrote this, never the human.
        messageOrigin: input.automaticSupervision ? CHAT_MESSAGE_ORIGINS.SYSTEM : CHAT_MESSAGE_ORIGINS.AGENT,
        ...(input.internalDurableQueue ? { durableQueue: true } : {}),
        ...(input.internalSuppressTimeline ? { suppressTimeline: true } : {}),
        ...(input.internalQueueSupervisionReference
          ? { queueSupervisionReference: input.internalQueueSupervisionReference }
          : {}),
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
        ...(supervisedTaskId && supervisedTaskTitle ? { taskTitle: supervisedTaskTitle } : {}),
        ...(supervisedTaskId && supervisedTaskObjective ? { taskObjective: supervisedTaskObjective } : {}),
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
    ...(supervisedTaskId && supervisedTaskTitle ? { taskTitle: supervisedTaskTitle } : {}),
    ...(supervisedTaskId && supervisedTaskObjective ? { taskObjective: supervisedTaskObjective } : {}),
    ...(auditRoutingReason ? { auditRoutingReason } : {}),
    ...(auditDegradedReason ? { auditDegradedReason } : {}),
    ...(provisioning ? { provisioning } : {}),
    ...(!autoProvision
      && Boolean(input.target)
      && Boolean(input.task)
      && !input.task?.taskId
      && successful.some((delivery) => delivery.status === 'queued')
      ? { autoProvisionRecommended: true as const }
      : {}),
    ...(failed > 0 ? { partial: true } : {}),
  };
  if (automaticAuditRoutingRecoveryClear) {
    getSupervisionTaskRegistry().clearAutomaticAuditRoutingBlocker({
      ...automaticAuditRoutingRecoveryClear,
      now,
    });
  }
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

export type ImplementationBlockerEscalationResult =
  | { status: 'waiting'; report: SupervisionBlockerEscalationReport; replay: boolean }
  | { status: 'needs_input'; report: SupervisionBlockerEscalationReport; replay: boolean }
  | { status: 'ignored'; reason: string };

function readMatchingBlockerEscalation(
  blocker: string | undefined,
  fingerprint: string,
): SupervisionBlockerEscalationReport | undefined {
  if (!blocker?.trim()) return undefined;
  try {
    const parsed = JSON.parse(blocker) as Partial<SupervisionBlockerEscalationReport>;
    return parsed.blockerFingerprint === fingerprint ? parsed as SupervisionBlockerEscalationReport : undefined;
  } catch {
    return undefined;
  }
}

/** What one fail-closed implementer disposition says and how it is persisted. */
export interface ImplementationBlockerEscalationSpec {
  taskId: string;
  assignmentId: string;
  /** The exact implementer must be in this status; otherwise nothing is escalated. */
  eligibleStatus: 'implementing' | 'delegated';
  /** Reported when the implementer is not in `eligibleStatus`. */
  ineligibleReason: string;
  exactError: string;
  completedSafeWork: string;
  /** Options when a live reporter and one authoritative Brain exist. */
  brainOptions: readonly string[];
  brainRecommendedNextAction: string;
  persist: (input: {
    assignmentId: string;
    blocker: string;
    blockerFingerprint: string;
    replaceMatching?: boolean;
    now: number;
  }) => SupervisionTaskRegistryResult<PersistedSupervisionTaskAssignment>;
  /**
   * Re-send the deterministic Brain report when the disposition is already
   * durable but no durable delivery evidence exists (a crash between persist
   * and dispatch). Delivery stays at-most-once per message id.
   */
  redeliverOnReplay?: boolean;
  /**
   * `false` persists the disposition only. Used where no daemon send path
   * exists (the recipient's own MCP process); the daemon delivers it later
   * with `redeliverOnReplay`. Defaults to true.
   */
  deliver?: boolean;
}

/**
 * Persist one durable, actionable implementer disposition and hand it to the
 * authoritative Brain. Persistence happens before delivery, so a daemon
 * restart or a later tick cannot emit another report for the same state; the
 * deterministic message id keeps any redelivery idempotent.
 */
export async function escalateImplementationBlocker(
  spec: ImplementationBlockerEscalationSpec,
  deps: SendToolDeps = {},
): Promise<ImplementationBlockerEscalationResult> {
  const registry = getSupervisionTaskRegistry();
  const task = registry.get(spec.taskId);
  const assignment = task?.assignments.find((candidate) => candidate.assignmentId === spec.assignmentId);
  if (!task || !assignment || assignment.role !== 'implementer') {
    return { status: 'ignored', reason: 'exact_implementer_not_found' };
  }
  if (isTerminalSupervisionTaskStatus(task.status) || isTerminalSupervisionTaskStatus(assignment.status)) {
    return { status: 'ignored', reason: 'terminal' };
  }
  if (assignment.status !== spec.eligibleStatus) {
    return { status: 'ignored', reason: spec.ineligibleReason };
  }

  const sessions = (deps.listSessions ?? listSessions)();
  const reporter = sessions.find((session) => (
    session.name === assignment.identity.sessionName
    && session.state !== 'stopped'
    && resolveEffectiveProjectName(session, sessions) === task.projectName
  ));
  const brain = uniqueAuthoritativeProjectBrain(task.projectName, sessions);
  const revision = task.currentRevision ?? assignment.auditRevision ?? '';
  const fingerprint = createHash('sha256').update(JSON.stringify({
    taskId: task.taskId,
    assignmentId: assignment.assignmentId,
    revision,
    status: assignment.status,
    exactError: spec.exactError,
  })).digest('hex');
  const messageId = deterministicSendMessageId(`implementation-blocker:${fingerprint}`);
  const queueReference: QueueSupervisionReference = {
    kind: 'implementation_blocker', taskId: task.taskId, assignmentId: assignment.assignmentId,
    revision,
    exactError: spec.exactError,
  };
  if (brain) bindExistingQueueSupervisionReference(brain.name, messageId, queueReference);
  const hasEvidence = deps.hasDeliveryEvidence ?? hasDurableDeliveryEvidence;
  const brainCanResolve = Boolean(reporter && brain);
  const replayResult = (durable: SupervisionBlockerEscalationReport): ImplementationBlockerEscalationResult => (
    durable.disposition === SUPERVISION_BLOCKER_ESCALATION_DISPOSITIONS.WAITING_FOR_BRAIN
      ? { status: 'waiting', report: durable, replay: true }
      : { status: 'needs_input', report: durable, replay: true }
  );
  const deliver = spec.deliver !== false;
  const replay = readMatchingBlockerEscalation(assignment.blocker, fingerprint);
  if (replay && !(deliver && spec.redeliverOnReplay && brainCanResolve && brain && !hasEvidence(brain.name, messageId))) {
    return replayResult(replay);
  }

  const report: SupervisionBlockerEscalationReport = {
    taskId: task.taskId,
    assignmentId: assignment.assignmentId,
    exactError: spec.exactError,
    completedSafeWork: spec.completedSafeWork,
    options: brainCanResolve
      ? [...spec.brainOptions]
      : ['provide_missing_external_authority', 'select_one_authoritative_project_brain'],
    recommendedNextAction: brainCanResolve
      ? spec.brainRecommendedNextAction
      : 'provide the missing external authority or identify one authoritative Brain for this project',
    blockerFingerprint: fingerprint,
    disposition: brainCanResolve
      ? SUPERVISION_BLOCKER_ESCALATION_DISPOSITIONS.WAITING_FOR_BRAIN
      : SUPERVISION_BLOCKER_ESCALATION_DISPOSITIONS.NEEDS_INPUT,
    reporter: {
      label: reporter?.label?.trim() || assignment.identity.sessionName,
      sessionName: assignment.identity.sessionName,
    },
    ...(brain ? { brain: { label: brain.label?.trim() || brain.name, sessionName: brain.name } } : {}),
    ...(brainCanResolve ? {} : { missing: 'one live authoritative same-project Brain or external authorization' }),
  };
  const redelivering = Boolean(replay);
  if (!redelivering) {
    const persisted = spec.persist({
      assignmentId: assignment.assignmentId,
      blocker: JSON.stringify(report),
      blockerFingerprint: fingerprint,
      now: (deps.now ?? Date.now)(),
    });
    if (!persisted.ok) {
      if (persisted.reason === 'invalid_transition') {
        return { status: 'ignored', reason: 'terminal' };
      }
      return { status: 'ignored', reason: `blocker_persist_failed:${persisted.reason}` };
    }
    if (persisted.replay) {
      const durable = readMatchingBlockerEscalation(persisted.value.blocker, fingerprint);
      if (!durable) return { status: 'ignored', reason: 'blocker_replay_mismatch' };
      return replayResult(durable);
    }
  }

  if (!brainCanResolve || !reporter || !brain) {
    return { status: 'needs_input', report, replay: redelivering };
  }
  if (!deliver) return { status: 'waiting', report, replay: false };
  if (!hasEvidence(brain.name, messageId)) {
    const dispatched = await dispatchSendMessage({
      userId: reporter.name,
      sessionName: reporter.name,
      projectName: task.projectName,
      projectRoot: reporter.projectDir,
    }, {
      target: brain.name,
      message: JSON.stringify(report),
      idempotencyKey: `implementation-blocker:${fingerprint}`,
      internalMessageId: messageId,
      internalDurableQueue: true,
      internalQueueSupervisionReference: queueReference,
      internalStructuredPayload: true,
    }, deps);
    if (dispatched.status !== 'accepted') {
      const failedReport: SupervisionBlockerEscalationReport = {
        ...report,
        disposition: SUPERVISION_BLOCKER_ESCALATION_DISPOSITIONS.NEEDS_INPUT,
        missing: `Brain escalation delivery failed: ${dispatched.status === 'error' ? dispatched.error : dispatched.reason}`,
      };
      const failedPersist = spec.persist({
        assignmentId: assignment.assignmentId,
        blocker: JSON.stringify(failedReport),
        blockerFingerprint: fingerprint,
        replaceMatching: true,
        now: (deps.now ?? Date.now)(),
      });
      if (!failedPersist.ok && failedPersist.reason === 'invalid_transition') {
        return { status: 'ignored', reason: 'terminal' };
      }
      return { status: 'needs_input', report: failedReport, replay: redelivering };
    }
    if (redelivering && replay?.disposition !== report.disposition) {
      // The durable copy recorded an earlier failed delivery; the report now
      // reached the Brain, so the standing disposition is waiting again.
      spec.persist({
        assignmentId: assignment.assignmentId,
        blocker: JSON.stringify(report),
        blockerFingerprint: fingerprint,
        replaceMatching: true,
        now: (deps.now ?? Date.now)(),
      });
    }
  }
  return { status: 'waiting', report, replay: redelivering };
}

/**
 * Convert exhaustion of the bounded same-object continuation budget into one
 * durable, actionable disposition. A single quiet heartbeat never calls this
 * boundary.
 */
export async function reportImplementationNoProgressBlocker(
  input: { taskId: string; assignmentId: string },
  deps: SendToolDeps = {},
): Promise<ImplementationBlockerEscalationResult> {
  const registry = getSupervisionTaskRegistry();
  return escalateImplementationBlocker({
    ...input,
    // No-progress escalation describes work that actually started. A delegated
    // assignment may merely be waiting behind the original durable FIFO
    // delivery, so treating it as failed implementation fabricates progress and
    // blocks the same object before the worker can claim it.
    eligibleStatus: 'implementing',
    ineligibleReason: 'implementation_not_started',
    exactError: SUPERVISION_IMPLEMENTATION_CONTINUATION_EXHAUSTED_ERROR,
    completedSafeWork: 'the bounded same-assignment continuation budget completed without authoritative provider/runtime or lifecycle progress; no Git or replacement object was created',
    brainOptions: ['repair_same_object_authority', 'resume_exact_assignment'],
    brainRecommendedNextAction: 'the authoritative Brain must repair and resume this same task and assignment in place',
    persist: (record) => registry.recordImplementationNoProgressBlocker(record),
  }, deps);
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
  /** Exact recipient-side acceptance projection for one auditor attempt. */
  hasVisibleAuditAcceptance?: (input: {
    taskId: string; assignmentId: string; attemptId: string; revision: string;
  }) => boolean;
  /** Durable execution ownership wins over any delivery retry. */
  hasActiveAuditExecutionClaim?: (input: {
    taskId: string; assignmentId: string; attemptId: string; revision: string;
  }) => boolean;
  /** Recover a uniquely durable audit brief whose registry row was lost. */
  findAdoptableAuditDelivery?: (input: {
    taskId: string; attemptId: string; revision: string; auditedSessionName: string;
    assignmentAuthority?: {
      assignmentId: string;
      messageId: SendMessageId;
      supersededMessageIds: readonly SendMessageId[];
      supersededDeliveries?: readonly { messageId: string; targetSessionName: string }[];
      origins: readonly DelegationReplyRecord['origin'][];
      target: DelegationReplyRecord['target'];
    };
  }) => PendingAuditDeliveryAuthority;
  /** Internal boot-sweep marker: prior-process handoffs are abandoned. */
  recoverRestartHandoffs?: boolean;
  now?: () => number;
  inspectAssignmentWorktree?: (
    assignment: PersistedSupervisionTaskAssignment,
  ) => import('./supervision-worktree-inspector.js').SupervisionWorktreeSnapshot | undefined
    | Promise<import('./supervision-worktree-inspector.js').SupervisionWorktreeSnapshot | undefined>;
  /** Test seam for the existing bounded, persistent housekeeping scheduler. */
  runScheduledWorktreeGcBatch?: (now: number) => Promise<unknown>;
  /** Test/host seam for exact immutable-bundle integration provisioning. */
  ensureIntegrationWorktree?: typeof defaultEnsureSupervisionAssignmentWorktree;
  /** Test seam; production always applies through the verified bundle helper. */
  applyIntegrationBundle?: typeof applySupervisionIntegrationBundle;
  /** Test seam for one bounded visible note about an auto-provision refusal. */
  recordProvisioningTelemetry?: (input: {
    brainSessionName: string;
    taskId: string;
    revision: string;
    attemptId: string;
    evidence: SupervisionProvisioningEvidence;
  }) => void | Promise<void>;
}

function automaticAuditAttemptId(taskId: string, revision: string): string {
  const digest = createHash('sha256').update(`${taskId}\0${revision}`).digest('hex');
  return `auto-audit-${digest.slice(0, 24)}`;
}

/**
 * Whether a legitimate audit request has happened for this task SINCE the
 * given already-decided final receipt was recorded -- the narrow escape
 * hatch for `dispatchReadyAudit`'s replay-safety check (see its call site's
 * comment for the bug this fixes).
 *
 * The signal is an implementer/integration_owner assignment row written
 * AFTER the receipt. That is deliberately the only thing checked: those rows
 * only change via genuine lifecycle intents (record_validation, start,
 * claim, checkpoint) that require someone to have actually re-engaged the
 * task -- there is no other path, automated or accidental, that touches
 * them post-decision. A stale replay of the SAME already-decided delivery
 * carries no new assignment write, so this stays false and the original
 * replay-safety property (never re-run an already-FINAL attempt) holds
 * exactly as before for that case; it only opens the gate when something
 * real happened after the decision.
 */
function supersededByLaterAuditRequest(
  task: SupervisionTaskSnapshot,
  receipt: PersistedSupervisionAuditReceipt,
): boolean {
  return task.assignments.some((candidate) => (
    (candidate.role === 'implementer' || candidate.role === 'integration_owner')
    && candidate.updatedAt > receipt.createdAt
  ));
}

function hasDurableDeliveryEvidence(sessionName: string, messageId: SendMessageId): boolean {
  try {
    const store = getTransportQueueStore();
    if (store.hasDeliveryTombstone(sessionName, messageId)) return true;
    return store.readSnapshot(sessionName).pendingMessageEntries.some(
      // A committed handoff may already be inside an irreversible provider
      // admission. Treat every pending projection for the deterministic id as
      // delivery evidence; replaying merely because it is no longer `queued`
      // duplicates automatic control traffic in the unknown-outcome window.
      (entry) => entry.clientMessageId === messageId,
    );
  } catch {
    return false;
  }
}

function bindExistingQueueSupervisionReference(
  sessionName: string,
  messageId: SendMessageId,
  reference: QueueSupervisionReference,
): boolean {
  try {
    return getTransportQueueStore().attachSupervisionReference(sessionName, messageId, reference);
  } catch {
    // Missing or conflicting queue authority is never a reason to overwrite.
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
  ));
}

function boundDelegationIdentityMatches(
  bound: DelegationReplyRecord['origin'],
  identity: PersistedSupervisionTaskAssignmentIdentity,
): boolean {
  return bound.sessionName === identity.sessionName
    && bound.sessionInstanceId === identity.sessionInstanceId
    && bound.runtimeEpoch === identity.runtimeEpoch;
}

function adoptExactDurableAuditDelivery(input: {
  task: SupervisionTaskSnapshot;
  implementer: PersistedSupervisionTaskAssignment;
  attemptId: string;
  revision: string;
  sessions: readonly SessionRecord[];
  registry: ReturnType<typeof getSupervisionTaskRegistry>;
  deps: ReadyAuditDispatchDeps;
  existingAssignment?: PersistedSupervisionTaskAssignment;
  /** Exact validation-authority snapshot re-verified under the creation lock. */
  validationAuthority: string;
}): { status: 'none' } | { status: 'blocked'; reason: string } | {
  status: 'adopted'; assignment: PersistedSupervisionTaskAssignment; messageId: SendMessageId;
} {
  if (input.existingAssignment
    && (input.existingAssignment.auditAttemptId !== input.attemptId
      || input.existingAssignment.auditRevision !== input.revision)) {
    return { status: 'none' };
  }
  const exactExistingTarget = input.existingAssignment && input.sessions.find((session) => (
    session.name === input.existingAssignment!.identity.sessionName
    && session.sessionInstanceId === input.existingAssignment!.identity.sessionInstanceId
    && session.runtimeEpoch === input.existingAssignment!.identity.runtimeEpoch
  ));
  // A stale assignment target must reach the existing-auditor fail-closed path
  // without changing durable delivery rows.
  if (input.existingAssignment && !exactExistingTarget) return { status: 'none' };
  const assignmentAuthority = input.existingAssignment && exactExistingTarget ? {
    assignmentId: input.existingAssignment.assignmentId,
    messageId: deterministicAutomaticAuditDeliveryMessageId(
      input.existingAssignment.assignmentId,
      input.attemptId,
      input.existingAssignment.generation,
    ),
    supersededMessageIds: Array.from(
      { length: Math.max(0, input.existingAssignment.generation - 1) },
      (_unused, index) => deterministicAutomaticAuditDeliveryMessageId(
        input.existingAssignment!.assignmentId,
        input.attemptId,
        index + 1,
      ),
    ).concat(deterministicSendMessageId(
      `auto-audit-redelivery:${input.existingAssignment.assignmentId}:${input.attemptId}`,
    )),
    supersededDeliveries: input.registry.listEvents(input.task.taskId).flatMap((event) => {
      if (event.assignmentId !== input.existingAssignment!.assignmentId
        || event.eventType !== 'recovered'
        || event.payload?.source !== SUPERVISION_ORPHANED_AUTOMATIC_AUDITOR_REBIND_SOURCE
        || event.payload?.attemptId !== input.attemptId
        || event.payload?.revision !== input.revision
        || event.payload?.deliveryMessageId !== deterministicAutomaticAuditDeliveryMessageId(
          input.existingAssignment!.assignmentId,
          input.attemptId,
          input.existingAssignment!.generation,
        )) return [];
      const messageId = typeof event.payload?.supersededDeliveryMessageId === 'string'
        ? event.payload.supersededDeliveryMessageId.trim()
        : '';
      const targetSessionName = typeof event.payload?.supersededSessionName === 'string'
        ? event.payload.supersededSessionName.trim()
        : '';
      return messageId && targetSessionName ? [{ messageId, targetSessionName }] : [];
    }),
    origins: input.task.assignments
      .filter((assignment) => assignment.role === 'coordinator'
        || assignment.role === 'implementer'
        || assignment.role === 'integration_owner')
      .map((assignment) => assignment.identity),
    target: input.existingAssignment.identity,
  } : undefined;
  const lookup = input.deps.findAdoptableAuditDelivery
    ?? ((query: {
      taskId: string; attemptId: string; revision: string; auditedSessionName: string;
      assignmentAuthority?: {
        assignmentId: string; messageId: SendMessageId;
        supersededMessageIds: readonly SendMessageId[];
        supersededDeliveries?: readonly { messageId: string; targetSessionName: string }[];
        origins: readonly DelegationReplyRecord['origin'][];
        target: DelegationReplyRecord['target'];
      };
    }) => (
      getDelegationReplyStore().findPendingAuditDelivery({
        taskId: query.taskId,
        auditAttemptId: query.attemptId,
        auditRevision: query.revision,
        auditedSessionName: query.auditedSessionName,
        ...(query.assignmentAuthority ? { assignmentAuthority: query.assignmentAuthority } : {}),
        now: input.deps.now?.() ?? Date.now(),
      })
    ));
  const found = lookup({
    taskId: input.task.taskId,
    attemptId: input.attemptId,
    revision: input.revision,
    auditedSessionName: input.implementer.identity.sessionName,
    ...(assignmentAuthority ? { assignmentAuthority } : {}),
  });
  if (found.status === 'none') return { status: 'none' };
  if (found.status === 'ambiguous') {
    return { status: 'blocked', reason: 'multiple durable audit deliveries claim the exact attempt and revision' };
  }
  const record = found.record;
  if (record.purpose !== AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT
    || record.taskId !== input.task.taskId
    || record.auditAttemptId !== input.attemptId
    || record.auditRevision !== input.revision
    || record.auditedSessionName !== input.implementer.identity.sessionName
    || !record.assignmentId) {
    return { status: 'blocked', reason: 'durable audit delivery binding conflicts with the task registry' };
  }
  const originOwnsTask = input.task.assignments.some((assignment) => (
    (assignment.role === 'coordinator'
      || assignment.role === 'implementer'
      || assignment.role === 'integration_owner')
    && boundDelegationIdentityMatches(record.origin, assignment.identity)
  ));
  if (!originOwnsTask) {
    return { status: 'blocked', reason: 'durable audit delivery origin is not an exact task participant' };
  }
  const target = input.sessions.find((session) => (
    session.name === record.target.sessionName
    && session.sessionInstanceId === record.target.sessionInstanceId
    && session.runtimeEpoch === record.target.runtimeEpoch
  ));
  const targetIdentity = target ? supervisionTaskIdentityForTarget(target) : undefined;
  if (!target || !targetIdentity
    || (target.runtimeType ?? getSessionRuntimeType(target.agentType)) !== 'transport'
    || target.projectName !== input.task.projectName
    || target.name === input.implementer.identity.sessionName) {
    return { status: 'blocked', reason: 'durable audit delivery target is not the exact live transport auditor' };
  }
  const expectedMessageId = deterministicAutomaticAuditDeliveryMessageId(
    record.assignmentId,
    input.attemptId,
    input.existingAssignment?.generation ?? 1,
  );
  if (record.messageId !== expectedMessageId) {
    return { status: 'blocked', reason: 'durable audit delivery message id does not match its exact binding' };
  }
  const auditedSession = input.sessions.find((session) => session.name === input.implementer.identity.sessionName);
  const auditedFamily = auditedSession
    ? resolvePeerAuditProviderFamily(auditedSession)
    : input.implementer.identity.providerFamily;
  if (input.task.auditPolicy === 'auto_strict_cross_vendor'
    && targetIdentity.providerFamily === auditedFamily) {
    return { status: 'blocked', reason: 'durable audit delivery violates strict cross-vendor routing' };
  }
  const existing = input.registry.getAssignment(record.assignmentId);
  if (existing) {
    return existing.role === 'auditor'
      && existing.taskId === input.task.taskId
      && existing.auditAttemptId === input.attemptId
      && existing.auditRevision === input.revision
      && boundDelegationIdentityMatches(record.target, existing.identity)
      ? { status: 'adopted', assignment: existing, messageId: expectedMessageId }
      : { status: 'blocked', reason: 'durable audit delivery binding conflicts with the task registry' };
  }
  const created = input.registry.createAssignment({
    assignmentId: record.assignmentId,
    taskId: input.task.taskId,
    role: 'auditor',
    required: false,
    identity: targetIdentity,
    auditAttemptId: input.attemptId,
    auditRevision: input.revision,
    validationAuthority: input.validationAuthority,
    idempotencyKey: `adopt-durable-audit:${record.messageId}`,
  });
  if (!created.ok) {
    const replay = input.registry.getAssignment(record.assignmentId);
    if (replay?.role === 'auditor'
      && replay.taskId === input.task.taskId
      && replay.auditAttemptId === input.attemptId
      && replay.auditRevision === input.revision
      && boundDelegationIdentityMatches(record.target, replay.identity)) {
      return { status: 'adopted', assignment: replay, messageId: expectedMessageId };
    }
    return { status: 'blocked', reason: `durable audit delivery adoption rejected: ${created.reason}` };
  }
  return { status: 'adopted', assignment: created.value, messageId: expectedMessageId };
}

interface AutomaticAuditTransportTargets {
  ready?: string;
  busy?: string;
}

function isAutomaticAuditTransportTarget(target: SessionRecord): boolean {
  return ((target.agentType === 'codex-sdk' && resolvePeerAuditProviderFamily(target) === 'openai')
    || (target.agentType === 'claude-code-sdk' && resolvePeerAuditProviderFamily(target) === 'anthropic'))
    && (target.runtimeType ?? getSessionRuntimeType(target.agentType)) === 'transport';
}

/**
 * The pool-scoped targets that may take an automatic audit of one audited
 * session: listed in the primary execution pool, dispatchable now (ready or
 * busy), and a live started transport with an exact runtime identity. The ONE
 * eligibility rule automatic routing and orphaned-auditor recovery share.
 */
function automaticAuditPoolEligibleItems(
  items: readonly SendTargetInfo[],
  sessions: readonly SessionRecord[],
  auditedSessionName: string,
): SendTargetInfo[] {
  const liveByName = new Map(sessions.map((session) => [session.name, session]));
  return items
    .filter((item) => (
      item.target !== auditedSessionName
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
}

/**
 * Is any cross-vendor auditor usable for this audited session right now, by the
 * same pool-scoped eligibility automatic audit routing uses? A target that is
 * live but no longer selected by the execution pool is NOT usable. When none
 * is usable, the concrete degraded reason is returned. Anything that cannot be
 * established (no scoped listing, unconfigured pools, unknown audited session)
 * is `undefined`, which never licenses a degradation.
 */
export function resolveAutomaticAuditCrossVendorAvailability(
  input: { scopeSessionName: string; auditedSessionName: string },
  deps: Pick<ReadyAuditDispatchDeps, 'listSessions' | 'listTargets'> = {},
): SupervisionAuditorRecoveryCrossVendorAvailability | undefined {
  const sessions = (deps.listSessions ?? listSessions)();
  const scope = sessions.find((session) => session.name === input.scopeSessionName);
  const audited = sessions.find((session) => session.name === input.auditedSessionName);
  if (!scope || !audited) return undefined;
  const projectName = resolveEffectiveProjectName(scope, sessions);
  if (!projectName || resolveEffectiveProjectName(audited, sessions) !== projectName) return undefined;
  const listed = (deps.listTargets ?? listSendTargets)({
    userId: scope.name,
    sessionName: scope.name,
    projectName,
    projectRoot: scope.projectDir,
  }, { executionPool: 'primary', limit: MAX_TARGET_LIST_LIMIT });
  if (listed.status !== 'ok' || listed.executionPoolsState !== 'configured') return undefined;
  const auditedFamily = resolvePeerAuditProviderFamily(audited);
  const crossVendor = automaticAuditPoolEligibleItems(listed.items, sessions, audited.name)
    .filter((item) => item.providerFamily !== auditedFamily);
  if (crossVendor.length > 0) return { available: true };
  const pools = resolveProjectAuthoritativeSupervisionPools(projectName, sessions);
  if (pools.state !== 'configured') return undefined;
  const crossVendorConfigured = pools.primaryDevelopmentPool.configs.some((config) => (
    config.runtimeType === 'transport' && config.providerFamily !== auditedFamily
  ));
  if (!crossVendorConfigured) return { available: false, degradedReason: 'no_cross_vendor_configured' };
  // Selected cross-vendor transports that exist but cannot take work now.
  const selectedCrossVendor = listed.items.filter((item) => (
    item.target !== audited.name
    && item.providerFamily !== auditedFamily
    && item.eligiblePools?.includes('primary')
  ));
  const states = selectedCrossVendor.map((item) => item.availability);
  if (states.length > 0 && states.every((state) => state === DELEGATION_AVAILABILITY.LIMITED)) {
    return { available: false, degradedReason: 'cross_vendor_limited' };
  }
  if (states.length > 0 && states.every((state) => state === DELEGATION_AVAILABILITY.OFFLINE)) {
    return { available: false, degradedReason: 'cross_vendor_offline' };
  }
  return { available: false, degradedReason: 'cross_vendor_unavailable' };
}

/**
 * Choose an auditor AND claim it, in one synchronous step.
 *
 * Selecting and then awaiting a dispatch is what let four audits in the same
 * tick all pick the same ready peer: the listing's availability had not moved
 * yet, so every route read the same `new_work` and queued behind one session
 * while other ready peers idled. Claiming inside the selection closes that
 * window without inventing any capacity rule -- the claim only bridges the lag
 * in the real availability signal.
 */
function eligibleAutomaticAuditTransportTargets(
  brain: SessionRecord,
  audited: PersistedSupervisionTaskAssignment,
  allowSameFamily: boolean,
  deps: ReadyAuditDispatchDeps,
  reservationOwnerKey: string,
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
  const auditedFamily = resolvePeerAuditProviderFamily(auditedSession);
  const eligible = automaticAuditPoolEligibleItems(listed.items, sessions, audited.identity.sessionName);
  const pick = (items: typeof eligible): string | undefined => (
    items.find((item) => item.providerFamily !== auditedFamily)?.target
    ?? (allowSameFamily ? items.find((item) => item.providerFamily === auditedFamily)?.target : undefined)
  );
  const now = deps.now?.() ?? Date.now();
  const readyItems = eligible.filter((item) => item.dispatchMode === 'new_work');
  // Reconciled against the COMPLETE live-ready pool, deliberately NOT against
  // `readyItems`. This route's candidate set has already dropped its own
  // audited session and every peer it may not use, and releasing a claim just
  // because THIS route cannot consider that peer released other routes' claims:
  // a session reserved as task A's auditor, skipped by task B for being B's own
  // implementer, was handed back by B and then picked again by task C.
  const liveReadyTargets = new Set(
    listed.items.filter((item) => item.dispatchMode === 'new_work').map((item) => item.target),
  );
  // The durable record of which sessions are auditing, so the claims survive a
  // restart and an active one is never dropped by a timer alone.
  const authoritativeClaims = (() => {
    try {
      return (deps.registry ?? getSupervisionTaskRegistry()).listActiveAuditTargets()
        .map((claim) => ({ target: claim.sessionName, ownerKey: claim.attemptId }));
    } catch {
      // Unknown, which must not be read as "nothing is auditing".
      return undefined;
    }
  })();
  reconcileAuditTargetReservations({
    now,
    readyTargets: liveReadyTargets,
    ...(authoritativeClaims ? { authoritativeClaims } : {}),
  });
  const reservedByOther = (item: { target: string }): boolean => (
    isAuditTargetReservedByOther(item.target, reservationOwnerKey, now)
  );
  const ready = pick(readyItems.filter((item) => !reservedByOther(item)));
  // Claimed before this function returns, with no await in between, so a
  // concurrent route observes it as taken and moves to a different peer.
  if (ready) reserveAuditTarget(ready, reservationOwnerKey, now);
  return {
    ready,
    // Busy is the durable-FIFO fallback of last resort and is deliberately not
    // claimed: queueing is exactly what it is for.
    //
    // A ready peer claimed by another route belongs in this pool too. It is
    // about to be busy -- that is what the claim means -- so sending to it
    // queues on the same durable FIFO as an already-busy peer. Leaving it out
    // of BOTH pools is what made a fully-claimed pool look like no pool at all,
    // blocking the audit after the one auto-provision attempt refused instead
    // of falling back. Genuinely busy peers come first so the ordering stays
    // deterministic and prefers the target whose availability is already known.
    busy: pick([
      ...eligible.filter((item) => item.dispatchMode === 'queue_only'),
      ...readyItems.filter((item) => reservedByOther(item)),
    ]),
  };
}

const AUTOMATIC_AUDIT_BUSY_FALLBACK_REASONS = new Set<SupervisionProvisionFailureReason>([
  'max_concurrency',
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

function recordAutomaticAuditProvisioningTelemetry(input: {
  brainSessionName: string;
  taskId: string;
  revision: string;
  attemptId: string;
  evidence: SupervisionProvisioningEvidence;
}): void {
  const reason = input.evidence.failureReason ?? 'unknown';
  timelineEmitter.emit(
    input.brainSessionName,
    'assistant.text',
    {
      ...attachDaemonUserNotice(
        DAEMON_USER_NOTICE_CODE.AUDIT_WORKER_PROVISION_REFUSED,
        `Automatic audit worker provisioning was refused (${reason}); using the bounded busy-session FIFO fallback.`,
        { detail: reason },
      ),
      streaming: false,
      automation: true,
      automationKind: 'supervision-provisioning',
      memoryExcluded: true,
    },
    {
      source: 'daemon',
      confidence: 'high',
      eventId: `supervision-provisioning:${input.taskId}:${input.revision}:${input.attemptId}:${reason}`,
    },
  );
}

function boundedAuditBrief(
  task: SupervisionTaskSnapshot,
  revision: string,
  authoritativeBundle: string,
  authoritativeFiles: readonly import('./supervision-worktree-inspector.js').SupervisionWorktreeFileSnapshot[],
  scope: {
    /** Current durable scope of the audited implementer, independent of touchedFiles/bundle rows. */
    scopeFiles: readonly string[];
    /** Blocking severities from the project Brain's current supervision configuration. */
    blockingSeverities: readonly AuditSeverity[];
    /** Bounded caller-submitted summary on the exact validation event. */
    validationReport?: string;
  },
): string {
  const shorten = (value: string, max = 800) => value.length <= max ? value : `${value.slice(0, max - 1)}…`;
  const files = authoritativeFiles.map((file) => file.path);
  const scopeFiles = [...new Set(scope.scopeFiles.map((file) => file.trim()).filter(Boolean))].sort();
  return [
    '[Daemon-resolved automatic matching audit]',
    `taskId=${task.taskId}`,
    `revision=${revision}`,
    `classification=${task.classification}`,
    `objective=${shorten(task.objective)}`,
    `Authoritative immutable integration bundle: ${authoritativeBundle}`,
    '',
    'Acceptance:',
    ...task.acceptance.slice(0, 20).map((item) => `- ${shorten(item, 500)}`),
    '',
    `Exact-revision implementer validation report: ${scope.validationReport
      ? shorten(scope.validationReport, 2_000)
      : 'registry validationState=passed for this revision; no separate prose summary was supplied'}`,
    '',
    'Audit the exact revision from the frozen code plus the daemon-authorized exact-revision implementer validation report, then return one final PASS/REWORK via peer_audit_reply.',
    'Inspect the manifest and frozen files from the immutable bundle above. Do not inspect the auditor worktree or substitute a mutable implementer worktree.',
    'DEFAULT: accept the implementer report after binding/coherence review and run no tests, typechecks, builds, mutants, probes, or reproductions. Record accepted rows with kind `accepted_implementer_validation`.',
    'EXCEPTIONS: if no usable exact-revision report exists, run only the minimal gap-filling check. If you have a confident concrete suspicion about one specific behavior, run one small targeted check instead of REWORK merely to request it.',
    'HARD LIMIT: one test file or a few named tests, or one mutant; --maxWorkers<=2; seconds-to-a-few-minutes. Never run a full test project, full build, coverage, or e2e. State which small check ran and why.',
    LOAD_VALIDATION_SAFETY_CLAUSE,
    'Do not edit code, stage, commit, push, deploy, install, upgrade, restart, or create a replacement task/audit.',
    'On PASS, integrationOwner is the same-project Brain; on failure report bounded concrete findings.',
    '',
    ...buildAuditSeverityPolicyLines(scope.blockingSeverities),
    '',
    'Assignment scopeFiles (current durable scope):',
    ...(scopeFiles.length > 0
      ? scopeFiles.slice(0, 60).map((file) => `- ${file}`)
      : ['- (none recorded)']),
    ...(scopeFiles.length > 60 ? [`- … ${scopeFiles.length - 60} more`] : []),
    ...(files.length > 0 ? ['', 'Referenced files:', ...[...new Set(files)].sort().slice(0, 40).map((file) => `- ${file}`)] : []),
  ].join('\n');
}

const AUTOMATIC_AUDIT_ROUTING_BLOCKER_KIND = 'automatic_audit_routing';

function automaticBlockerMessage(input: {
  taskId: string;
  assignmentId: string;
  exactError: string;
  revision?: string;
  attemptId?: string;
}): string {
  return JSON.stringify({
    kind: AUTOMATIC_AUDIT_ROUTING_BLOCKER_KIND,
    taskId: input.taskId,
    assignmentId: input.assignmentId,
    ...(input.revision ? { revision: input.revision } : {}),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    exactError: input.exactError,
    completedSafeWork: 'ready_for_audit is durable; no auditor replacement or Git side effect was created',
    recommendedNextAction: 'Brain must recover the same object or manually exact-route one eligible matching auditor for the current revision',
    disposition: SUPERVISION_BLOCKER_ESCALATION_DISPOSITIONS.WAITING_FOR_BRAIN,
  });
}

function matchingAutomaticAuditRoutingBlocker(
  task: SupervisionTaskSnapshot,
  implementer: PersistedSupervisionTaskAssignment,
): string | undefined {
  if (!task.blocker || task.blocker !== implementer.blocker) return undefined;
  try {
    const parsed = JSON.parse(task.blocker) as Record<string, unknown>;
    const revision = task.currentRevision ?? implementer.auditRevision ?? '';
    return parsed.kind === AUTOMATIC_AUDIT_ROUTING_BLOCKER_KIND
      && parsed.taskId === task.taskId
      && parsed.assignmentId === implementer.assignmentId
      && (typeof parsed.revision === 'string' ? parsed.revision : '') === revision
      && (parsed.attemptId === undefined || parsed.attemptId === automaticAuditAttemptId(task.taskId, revision))
      ? task.blocker
      : undefined;
  } catch {
    return undefined;
  }
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
  const durableRevision = task.currentRevision ?? implementer.auditRevision ?? '';
  const messageId = deterministicSendMessageId(`auto-audit-blocker:${task.taskId}:${durableRevision}:${exactError}`);
  const queueReference: QueueSupervisionReference = {
    kind: 'implementation_blocker', taskId: task.taskId, assignmentId: implementer.assignmentId, exactError,
    revision: durableRevision,
  };
  const blocker = automaticBlockerMessage({
    taskId: task.taskId,
    assignmentId: implementer.assignmentId,
    revision: durableRevision || undefined,
    attemptId: task.currentRevision
      ? automaticAuditAttemptId(task.taskId, task.currentRevision)
      : undefined,
    exactError,
  });
  const persisted = (deps.registry ?? getSupervisionTaskRegistry()).recordAutomaticAuditRoutingBlocker({
    taskId: task.taskId,
    assignmentId: implementer.assignmentId,
    blocker,
    now: deps.now?.() ?? Date.now(),
  });
  if (!persisted.ok) return false;
  if (bindExistingQueueSupervisionReference(target.name, messageId, queueReference)) return true;
  const hasEvidence = deps.hasDeliveryEvidence ?? hasDurableDeliveryEvidence;
  if (hasEvidence(target.name, messageId)) return true;
  const dispatched = await (deps.dispatch ?? dispatchSendMessage)({
    userId: origin.name,
    sessionName: origin.name,
    projectName: task.projectName,
    projectRoot: origin.projectDir,
  }, {
    target: target.name,
    message: blocker,
    idempotencyKey: `auto-audit-blocker:${task.taskId}:${durableRevision}:${exactError}`,
    internalMessageId: messageId,
    internalDurableQueue: true,
    internalQueueSupervisionReference: queueReference,
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
    internalStructuredPayload: true,
  });
  return dispatched.status === 'accepted';
}

/**
 * Materialize one automatic matching audit from durable task facts. Repeated
 * calls, concurrent post-open hooks, and boot recovery converge on the same
 * assignment, attempt, and transport message id.
 */
/**
 * True when a policy-less task is genuinely STUCK rather than merely manual.
 *
 * `manual_policy` conflates two very different states: a task nobody intends to
 * auto-audit, and a validated task that reached `ready_for_audit`, cannot
 * materialise an auditor because it has no policy, and has no in-band way to
 * acquire one. The first is silence by design; the second is a dead end that
 * previously produced no signal at all.
 *
 * Deliberately narrow: it requires the task to be genuinely owed an audit --
 * one live required implementer, no auditor already holding this revision, and
 * no settled verdict -- so a manual or already-decided task is never reported.
 */
function isActionableMissingAuditPolicy(
  task: SupervisionTaskSnapshot,
  registry: ReturnType<typeof getSupervisionTaskRegistry>,
  revision: string,
): boolean {
  if (task.status !== 'ready_for_audit') return false;
  if (!isAuditableSupervisionTaskClassification(task.classification)) return false;
  const assignments = registry.listAssignments(task.taskId);
  const implementers = assignments.filter((assignment) => (
    assignment.role === 'implementer'
    && assignment.required
    && assignment.status !== 'cancelled'
    && assignment.status !== 'finalized'
  ));
  if (implementers.length !== 1) return false;
  const liveAuditor = assignments.some((assignment) => (
    assignment.role === 'auditor'
    && assignment.auditRevision?.trim() === revision
    && assignment.status !== 'cancelled'
    && assignment.status !== 'finalized'
  ));
  if (liveAuditor) return false;
  return !registry.listAuditReceipts(task.taskId).some((receipt) => (
    receipt.revision === revision && receipt.receiptKind === 'final'
  ));
}

export async function dispatchReadyAudit(
  taskId: string,
  deps: ReadyAuditDispatchDeps = {},
): Promise<ReadyAuditDispatchResult> {
  const registry = deps.registry ?? getSupervisionTaskRegistry();
  const task = registry.get(taskId);
  if (!task) return { status: 'ignored', reason: 'task_not_found' };
  // No automatic audit dispatch or stale redelivery on a `pairs` project, nor
  // on a project left in mode `off` with no engine configured -- that
  // project's own workflow owns audit dispatch, not the legacy registry.
  if (isPairsEngineProject(task.projectName)) return { status: 'ignored', reason: 'pairs_engine' };
  if (!isTaskPairEngineActive(task.projectName)) return { status: 'ignored', reason: 'task_pair_engine_off' };
  // A task without a policy is normally not auto-audited. The one exception is
  // a pre-existing explicit attempt that is already bound to this revision:
  // routing it is recovery, not automatic materialisation.
  const recoveredAttemptId = task.auditPolicy ? undefined : legacyExplicitAuditRecoveryAttempt(task, registry);
  // Deferred rather than returned here: deciding between "manual" and "stuck"
  // needs the resolved revision and the live coordinator, which are only
  // available further down. Non-actionable tasks still end at `manual_policy`.
  const missingAuditPolicy = !task.auditPolicy && !recoveredAttemptId;
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

  if (missingAuditPolicy) {
    // A task nobody intends to auto-audit stays silent, exactly as before.
    if (!isActionableMissingAuditPolicy(task, registry, revision)) {
      return { status: 'ignored', reason: 'manual_policy' };
    }
    // Stuck: no policy, no auditor, and no in-band way to acquire one. Report
    // it exactly once. reportAutomaticAuditBlocker derives a deterministic
    // messageId and short-circuits on durable delivery evidence, so repeated
    // ticks cannot turn this into a per-tick notification. A missing live
    // coordinator means there is nobody to notify, not that the task is fine,
    // so the blocked status still stands with reported=false.
    const reason = 'missing_audit_policy';
    const reported = reporter && coordinator ? await reportBlocker(reporter, reason) : false;
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
  //
  // `automaticAuditAttemptId` is deterministic on (taskId, revision) ALONE --
  // by design, so a replayed delivery of an already-decided attempt is a safe
  // no-op. But that same determinism means a genuinely NEW audit request for
  // the identical revision (record_validation + open_audit again -- e.g.
  // after correcting acceptance criteria, or simply re-affirming a decision
  // that needs a fresh look) produces the EXACT SAME attemptId as the one the
  // OLD final receipt already decided, so dispatch silently reused the stale
  // verdict forever with no new auditAttemptId and no heartbeat -- confirmed
  // live 3 times today (tsk_udb, tsk_u7q, tsk_ug1). `supersededByLaterAuditRequest`
  // is the fix: it does NOT touch the attemptId derivation (many other call
  // sites rely on it staying a pure function of taskId+revision for
  // matching/dedup), it only teaches this ONE check to recognize a
  // legitimately later request. See its own comment for why comparing
  // against the receipt's own createdAt is the correct, narrow signal.
  const decidedByFinalReceipt = registry.listAuditReceipts(task.taskId).some((receipt) => (
    receipt.attemptId === attemptId
    && receipt.revision === revision
    && receipt.receiptKind === 'final'
    && (receipt.verdict === 'PASS' || receipt.verdict === 'REWORK')
    && !supersededByLaterAuditRequest(task, receipt)
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
    // Aligning is a lifecycle write toward the freeze boundary, so it is only
    // allowed for an owner whose own validation attests THIS revision.
    if (alignable.length === 1 && registry.hasReadyAuditValidationAuthority({
      taskId: task.taskId, assignmentId: alignable[0]!.assignmentId, revision, allowLegacy: false,
    })) {
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

  // The immutable freeze/open-audit boundary. Readiness projections are not
  // validation: a successor that inherited (or never cleared) a predecessor's
  // PASS must not bind a bundle, mint an auditor/attempt or deliver anything.
  //
  // The decision is captured as an exact authority SNAPSHOT and carried to every
  // later locked writer (bundle bind, auditor/attempt materialization) instead
  // of being trusted as a one-time precheck across the awaits below.
  const validationAuthority = registry.readyAuditValidationAuthoritySnapshot({
    taskId: task.taskId, assignmentId: implementer.assignmentId, revision, allowLegacy: true,
  });
  const authorityRevoked = async (): Promise<ReadyAuditDispatchResult> => {
    const exactError = 'automatic audit requires validation passed for the exact current revision';
    const reported = reporter && coordinator
      ? await reportBlocker(implementer, exactError)
      : false;
    return { status: 'blocked', reason: exactError, reported };
  };
  if (!validationAuthority) return authorityRevoked();

  const resolvedArtifact = await resolveIntegrationArtifact(task, implementer, deps, true, validationAuthority);
  // Authority may have been revoked while the worktree was inspected/frozen.
  if (!registry.validationAuthoritySnapshotHolds(validationAuthority, { taskId: task.taskId, revision })) {
    return authorityRevoked();
  }
  if (!resolvedArtifact.artifact) {
    const exactError = resolvedArtifact.failureReason
      ? `authoritative immutable integration bundle unavailable or mismatched (reason: ${resolvedArtifact.failureReason})`
      : 'authoritative immutable integration bundle unavailable or mismatched';
    const reported = reporter && coordinator
      ? await reportBlocker(implementer, exactError)
      : false;
    return { status: 'blocked', reason: exactError, reported };
  }
  const integrationArtifact = resolvedArtifact.artifact;

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
  const adopted = adoptExactDurableAuditDelivery({
    task,
    implementer,
    attemptId,
    revision,
    sessions,
    registry,
    deps,
    existingAssignment: existingAudit,
    validationAuthority,
  });
  if (adopted.status === 'blocked') {
    const reported = await reportBlocker(implementer, adopted.reason);
    return { status: 'blocked', reason: adopted.reason, reported };
  }
  if (adopted.status === 'adopted') {
    return {
      status: 'replayed',
      assignmentId: adopted.assignment.assignmentId,
      attemptId,
      messageId: adopted.messageId,
    };
  }
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
    const messageId = deterministicAutomaticAuditDeliveryMessageId(
      existingAudit.assignmentId,
      attemptId,
      existingAudit.generation,
    );
    const recoveredHandoff = recoverAutomaticAuditHandoff(target.name, messageId, deps);
    const hasEvidence = deps.hasDeliveryEvidence ?? hasDurableDeliveryEvidence;
    const hasExistingEvidence = hasEvidence(target.name, messageId);
    const now = deps.now?.() ?? Date.now();
    const staleDelegated = existingAudit.status === AUDITOR_REDELIVERY_STATUS
      && now - existingAudit.updatedAt >= AUDITOR_STALE_REDELIVERY_MS;
    // Staleness must be checked here even when there is NO delivery evidence
    // at all, not only when evidence exists but the assignee went quiet after
    // starting. The two cases look identical from here on out (still
    // `delegated`, zero engagement) and need the exact same redelivery
    // decision: a real audit (tsk_uzm/asg_v0r) sat for 2.4 hours because this
    // branch used to be gated on `hasExistingEvidence` alone, so a dispatch
    // whose very first send never actually reached the target (no evidence
    // was ever recorded) kept reusing that SAME original `internalMessageId`
    // on every 60s convergence tick. `internalDurableQueue`/`internalMessageId`
    // exist specifically to make repeat calls idempotent, so the periodic tick
    // WAS running -- it just kept "resending" a message id the durable queue
    // had already (silently, from the target's perspective) accepted, and a
    // silently-swallowed first send can never earn a genuinely new delivery
    // attempt without a genuinely new id. Once truly stale, treat "no
    // evidence" the same as "evidence but no engagement" and mint one.
    if (!recoveredHandoff && (hasExistingEvidence || staleDelegated)) {
      const exactExecution = {
        taskId: task.taskId,
        assignmentId: existingAudit.assignmentId,
        attemptId,
        revision,
      };
      const visiblyAccepted = existingAudit.status !== AUDITOR_REDELIVERY_STATUS
        || deps.hasVisibleAuditAcceptance?.(exactExecution) === true;
      const activelyClaimed = deps.hasActiveAuditExecutionClaim?.(exactExecution) === true;
      if (visiblyAccepted || activelyClaimed) {
        return { status: 'replayed', assignmentId: existingAudit.assignmentId, attemptId, messageId };
      }
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
    // An assignment may have been transactionally rebound from an orphaned
    // target. Delivery evidence is target-scoped, so the replacement has none;
    // nevertheless it must reuse the assignment's canonical message id rather
    // than minting a second logical delivery -- unless it is ALSO stale, which
    // the block above has already handled by minting a fresh redelivery id.
    if (!recoveredHandoff && !hasExistingEvidence && !staleDelegated) {
      recoveredExistingMessageId = messageId;
    }
  }

  // Pool scoping context, NOT a relay. The audit envelope is delivered straight
  // to the auditor either way; this session only scopes the eligible-pool query.
  const brain = (coordinator ? exactLiveSessionForAssignment(coordinator, sessions) : undefined)
    ?? exactLiveSessionForAssignment(implementer, sessions);
  if (!brain) {
    const reason = 'automatic audit requires one live same-project session to scope the auditor pool';
    const reported = reporter && coordinator
      ? await reportBlocker(reporter, reason)
      : false;
    return { status: 'blocked', reason, reported };
  }
  const existingAuditTarget = existingAudit
    ? sessions.find((session) => session.name === existingAudit.identity.sessionName)
    : undefined;
  const automaticAuditPools = resolveProjectAuthoritativeSupervisionPools(task.projectName, sessions);
  const existingAuditStillSelected = Boolean(existingAuditTarget && (
    automaticAuditPools.state !== 'configured'
    || resolveSelectedSupervisionExecutionBinding(
      task.projectName, sessions, existingAuditTarget, 'primary',
    )
  ));
  // A durable auditor assignment is the object to preserve, not a permanent
  // exemption for the session/config it used on an earlier delivery.  Resolve
  // a currently selected exact target before dispatch so an obsolete target
  // never produces a user-visible `unselected_config` detour first.
  const repairingUnselectedExisting = Boolean(existingAudit && !existingAuditStillSelected);
  const candidates: AutomaticAuditTransportTargets = existingAuditStillSelected
    ? {}
    : eligibleAutomaticAuditTransportTargets(
      brain,
      implementer,
      task.auditPolicy === 'auto_allow_degraded',
      deps,
      attemptId,
    );
  const caller = {
    userId: brain.name,
    sessionName: brain.name,
    projectName: task.projectName,
    projectRoot: brain.projectDir,
  };
  const buildInput = (
    target?: string,
    autoProvision = false,
    provisioningAttempt?: SupervisionProvisioningEvidence,
  ): SendMessageInput => {
    const exactTarget = target ? sessions.find((session) => session.name === target) : undefined;
    const selectedBinding = exactTarget
      ? resolveSelectedSupervisionExecutionBinding(task.projectName, sessions, exactTarget, 'primary')
      : undefined;
    const validationReport = registry.listEvents(task.taskId).filter((event) => {
      if (event.assignmentId !== implementer.assignmentId || event.eventType !== 'validated') return false;
      const payload = event.payload;
      return payload?.validationState === 'passed' && payload.validatedRevision === revision;
    }).map((event) => typeof event.payload?.note === 'string' ? event.payload.note.trim() : '')
      .filter(Boolean).at(-1);
    return ({
    ...(target ? { target } : {}),
    message: boundedAuditBrief(task, revision, integrationArtifact.path, integrationArtifact.files, {
      scopeFiles: implementer.scopeFiles,
      blockingSeverities: resolveSupervisionAuditBlockingSeverities(
        resolveProjectAuthoritativeSupervisionSnapshot(task.projectName, sessions),
      ),
      ...(validationReport ? { validationReport } : {}),
    }),
    reply: true,
    idempotencyKey: `auto-audit:${task.taskId}:${revision}`,
    ...(existingAudit ? {} : { newWorkload: true }),
    automaticSupervision: true,
    ...(recoveredExistingMessageId ? { internalMessageId: recoveredExistingMessageId } : {}),
    internalDurableQueue: true,
    ...(provisioningAttempt ? { internalProvisioningAttempt: provisioningAttempt } : {}),
    internalAuditValidationAuthority: validationAuthority,
    audit: {
      kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      attemptId,
      auditedSessionName: implementer.identity.sessionName,
      ...(task.auditPolicy === 'auto_strict_cross_vendor' || repairingUnselectedExisting
        || (existingAudit && target && sessions.some((session) => (
          session.name === target
          && resolvePeerAuditProviderFamily(session) !== implementer.identity.providerFamily
        )))
        ? { strictCrossVendor: true }
        : {}),
    },
    task: {
      taskId: task.taskId,
      ...(existingAudit ? { assignmentId: existingAudit.assignmentId } : {}),
      currentRevision: revision,
      auditRevision: revision,
      auditAttemptId: attemptId,
      executionPool: 'primary',
      ...(selectedBinding ? { requestedExecutionType: selectedBinding.requested } : {}),
      ...(autoProvision ? { autoProvision: true } : {}),
    },
    });
  };
  const dispatch = deps.dispatch ?? dispatchSendMessage;
  // Last synchronous authority check before anything is delivered; the send
  // path re-verifies the same snapshot under its materialization lock.
  if (!registry.validationAuthoritySnapshotHolds(validationAuthority, { taskId: task.taskId, revision })) {
    releaseAuditTarget(attemptId);
    return authorityRevoked();
  }
  const directTarget = existingAuditStillSelected
    ? existingAudit?.identity.sessionName
    : candidates.ready ?? (existingAudit ? candidates.busy : undefined);
  // Mandatory routing order: an already-ready authorized transport wins. If
  // none exists, the configured execution pool gets one deterministic spawn
  // attempt. A busy transport is only the final durable-FIFO fallback after a
  // concrete capacity/cooldown/launch/readiness refusal from that attempt.
  let result = await dispatch(caller, buildInput(directTarget, !directTarget));
  if (!directTarget && candidates.busy && mayFallbackToBusyAfterProvision(result)) {
    const provisioningAttempt = result.status === 'error' ? result.provisioning : undefined;
    if (provisioningAttempt) {
      await (deps.recordProvisioningTelemetry ?? recordAutomaticAuditProvisioningTelemetry)({
        brainSessionName: brain.name,
        taskId: task.taskId,
        revision,
        attemptId,
        evidence: provisioningAttempt,
      });
    }
    result = await dispatch(caller, buildInput(candidates.busy, false, provisioningAttempt));
  }
  if (existingAudit && result.status === 'error'
    && result.error.includes('task execution pool rejected target: unselected_config')) {
    // The assignment is the durable audit object; its historical target is not.
    // Re-run the authoritative live pool selection only after the old target's
    // side-effect-free pool rejection, then let the existing exact-assignment
    // continuation atomically rebind and deliver. No auditor/attempt/revision is
    // minted here, and an absent eligible target remains a normal blocker.
    const recoveryCandidates = eligibleAutomaticAuditTransportTargets(
      brain,
      implementer,
      false,
      deps,
      attemptId,
    );
    const recoveryTarget = recoveryCandidates.ready ?? recoveryCandidates.busy;
    if (recoveryTarget) {
      recoveredExistingMessageId = undefined;
      result = await dispatch(caller, buildInput(recoveryTarget));
    }
  }
  if (result.status !== 'accepted' || !result.assignmentId) {
    // Nothing was routed, so nothing may keep holding a ready peer out of the
    // pool. Failing closed on the audit must not also fail closed on capacity.
    releaseAuditTarget(attemptId);
    const reason = result.status === 'error' ? result.error : `automatic audit dispatch ${result.status}`;
    if (reason.includes('no_selected_config')) {
      registry.recordAutomaticAuditRoutingBlocker({
        taskId: task.taskId,
        assignmentId: implementer.assignmentId,
        blocker: automaticBlockerMessage({
          taskId: task.taskId,
          assignmentId: implementer.assignmentId,
          revision,
          attemptId,
          exactError: reason,
        }),
        now: deps.now?.() ?? Date.now(),
      });
    }
    const reported = await reportBlocker(implementer, reason);
    return { status: 'blocked', reason, reported };
  }
  const routingBlocker = matchingAutomaticAuditRoutingBlocker(
    registry.get(task.taskId) ?? task,
    registry.getAssignment(implementer.assignmentId) ?? implementer,
  );
  if (routingBlocker) {
    registry.clearAutomaticAuditRoutingBlocker({
      taskId: task.taskId,
      assignmentId: implementer.assignmentId,
      blocker: routingBlocker,
      now: deps.now?.() ?? Date.now(),
    });
  }
  const acceptedAudit = registry.getAssignment(result.assignmentId);
  const messageId = result.messageId
    ?? deterministicAutomaticAuditDeliveryMessageId(
      result.assignmentId,
      attemptId,
      acceptedAudit?.generation ?? 1,
    );
  return { status: 'dispatched', assignmentId: result.assignmentId, attemptId, messageId };
}

export type DeterministicContinuationDispatchResult =
  | { status: 'ignored'; reason: string }
  | { status: 'replayed'; assignmentId: string; messageId: SendMessageId }
  | { status: 'dispatched'; assignmentId: string; messageId: SendMessageId }
  | { status: 'blocked'; reason: string; reported: boolean };

async function inspectAssignmentForConvergence(
  assignment: PersistedSupervisionTaskAssignment,
  deps: ReadyAuditDispatchDeps,
  baseRevision?: string,
): Promise<import('./supervision-worktree-inspector.js').SupervisionWorktreeSnapshot | undefined> {
  if (deps.inspectAssignmentWorktree) return deps.inspectAssignmentWorktree(assignment);
  // `baseRevision` (the task's registry-tracked base -- see
  // supervision-state-store.ts) makes `files` reflect the actual COMMITTED
  // diff, not just uncommitted working-tree state. Without it, an
  // implementer who correctly committed before validation (the required,
  // documented workflow) has a clean tree relative to their own HEAD, and
  // `files` comes back empty no matter how large the real change is -- the
  // root cause of "authoritative immutable integration bundle unavailable or
  // mismatched" reproduced on tsk_t2f.
  const inspected = await inspectSupervisionAssignmentWorktree({
    sessionName: assignment.identity.sessionName,
    assignmentId: assignment.assignmentId,
    baseRevision,
  });
  return inspected.ok ? inspected.snapshot : undefined;
}

interface ResolvedIntegrationArtifact {
  path: string;
  files: import('./supervision-worktree-inspector.js').SupervisionWorktreeFileSnapshot[];
  bundle?: SupervisionIntegrationBundle;
}

/**
 * A short, stable diagnostic code for why {@link resolveIntegrationArtifact}
 * could not produce an artifact -- surfaced in the blocker message so a Brain
 * facing "authoritative immutable integration bundle unavailable or
 * mismatched" can self-diagnose (e.g. `scope_files_missing_from_worktree`
 * means the bound implementer identity's worktree has none of the assignment's
 * scope files, almost always because the identity was rebound to a session
 * whose worktree holds a different/empty diff) instead of treating every
 * occurrence as an unfixable platform defect.
 */
type IntegrationArtifactFailureReason =
  | 'missing_current_revision'
  | 'worktree_snapshot_unavailable'
  | 'worktree_dirty_staged'
  | 'worktree_dirty_conflicted'
  | `scope_projection_failed:${string}`
  | 'persisted_bundle_stale_no_freeze_allowed'
  | 'refreeze_not_authorized'
  | `freeze_failed:${string}`
  | `verify_failed:${string}`
  | `bundle_bind_rejected:${string}`;

interface ResolveIntegrationArtifactResult {
  artifact?: ResolvedIntegrationArtifact;
  failureReason?: IntegrationArtifactFailureReason;
}

/**
 * Resolve the one immutable artifact shared by audit and integration. An
 * injected worktree inspector is an explicit unit-test seam; production may
 * create a missing bundle only before audit, never after PASS.
 */
async function resolveIntegrationArtifact(
  task: SupervisionTaskSnapshot,
  implementer: PersistedSupervisionTaskAssignment,
  deps: ReadyAuditDispatchDeps,
  allowFreeze: boolean,
  validationAuthority?: string,
): Promise<ResolveIntegrationArtifactResult> {
  const revision = task.currentRevision?.trim();
  if (!revision) return { failureReason: 'missing_current_revision' };
  const persisted = task.integrationBundle;
  if (deps.inspectAssignmentWorktree) {
    const snapshot = await inspectAssignmentForConvergence(implementer, deps, task.baseRevision);
    if (!snapshot) return { failureReason: 'worktree_snapshot_unavailable' };
    const authorityScope = implementer.role === 'integration_owner' && persisted
      ? (persisted.scopeFiles ?? persisted.files.map((file) => file.path))
      : implementer.scopeFiles;
    const projected = projectSupervisionSnapshotToAssignmentScope({
      snapshot, scopeFiles: authorityScope,
    });
    if (!projected.ok) return { failureReason: `scope_projection_failed:${projected.reason}` };
    if (projected.snapshot.stagedPaths.length > 0) return { failureReason: 'worktree_dirty_staged' };
    if (projected.snapshot.conflictedPaths.length > 0) return { failureReason: 'worktree_dirty_conflicted' };
    return { artifact: { path: projected.snapshot.worktreePath, files: projected.snapshot.files } };
  }
  if (persisted) {
    const sourceAssignment = task.assignments.find((candidate) => (
      candidate.assignmentId === persisted.sourceAssignmentId
    ));
    if (persisted.taskId === task.taskId
      && sourceAssignment
      && persisted.revision === revision
      && supervisionBundleMatchesAssignmentScope({
        assignmentScopeFiles: sourceAssignment.scopeFiles,
        bundleScopeFiles: persisted.scopeFiles,
        bundleFiles: persisted.files,
      })
      && verifySupervisionIntegrationBundle(persisted).ok) {
      return { artifact: { path: persisted.bundlePath, files: persisted.files, bundle: persisted } };
    }
    // Do not let a predecessor REWORK bundle permanently mask a validated
    // successor. bindIntegrationBundle owns the narrow, receipt-backed CAS that
    // decides whether this exact stale binding may be replaced; all unrelated
    // or unaudited mismatches still fail closed there.
    if (!allowFreeze) return { failureReason: 'persisted_bundle_stale_no_freeze_allowed' };
    const registry = deps.registry ?? getSupervisionTaskRegistry();
    if (!registry.canRefreezeSupersededReworkBundle({
      taskId: task.taskId,
      assignmentId: implementer.assignmentId,
      identity: implementer.identity,
      revision,
    }) && !registry.canRefreezeScopeMismatchedBundle({
      taskId: task.taskId,
      assignmentId: implementer.assignmentId,
      identity: implementer.identity,
      revision,
    })) return { failureReason: 'refreeze_not_authorized' };
  }
  if (!allowFreeze) return { failureReason: 'persisted_bundle_stale_no_freeze_allowed' };
  const snapshot = await inspectAssignmentForConvergence(implementer, deps, task.baseRevision);
  if (!snapshot) return { failureReason: 'worktree_snapshot_unavailable' };
  const projected = projectSupervisionSnapshotToAssignmentScope({
    snapshot, scopeFiles: implementer.scopeFiles,
  });
  if (!projected.ok) return { failureReason: `scope_projection_failed:${projected.reason}` };
  if (projected.snapshot.stagedPaths.length > 0) return { failureReason: 'worktree_dirty_staged' };
  if (projected.snapshot.conflictedPaths.length > 0) return { failureReason: 'worktree_dirty_conflicted' };
  const frozen = freezeSupervisionIntegrationBundle({
    taskId: task.taskId,
    assignmentId: implementer.assignmentId,
    revision,
    snapshot: projected.snapshot,
    scopeFiles: projected.scopeFiles,
  });
  if (!frozen.ok) return { failureReason: `freeze_failed:${frozen.reason}` };
  const verified = verifySupervisionIntegrationBundle(frozen.bundle);
  if (!verified.ok) return { failureReason: `verify_failed:${verified.reason}` };
  const bound = (deps.registry ?? getSupervisionTaskRegistry()).bindIntegrationBundle({
    taskId: task.taskId,
    assignmentId: implementer.assignmentId,
    identity: implementer.identity,
    revision,
    bundle: frozen.bundle,
    ...(validationAuthority !== undefined ? { validationAuthority } : {}),
    now: (deps.now ?? Date.now)(),
  });
  if (!bound.ok) return { failureReason: `bundle_bind_rejected:${bound.reason}` };
  return { artifact: { path: frozen.bundle.bundlePath, files: frozen.bundle.files, bundle: frozen.bundle } };
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
    internalSuppressTimeline: true,
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
  const exactPassOwners = task.assignments.filter((assignment) => (
    assignment.required && (assignment.role === 'implementer' || assignment.role === 'integration_owner')
    && assignment.status === 'ready_for_integration'
    && assignment.auditRevision === revision && Boolean(assignment.auditAttemptId)
    && assignment.verdict?.trim().toUpperCase() === 'PASS'
    && assignment.crossVendorAuditPassed === true
  ));
  // Once materialized, the integration owner carries the same PASS authority;
  // it is not a second implementation artifact. Prefer the still-live exact
  // implementer, falling back to an owner only after implementers retire.
  const exactImplementers = exactPassOwners.filter((assignment) => assignment.role === 'implementer');
  const implementers = exactImplementers.length > 0 ? exactImplementers : exactPassOwners;
  if (implementers.length !== 1) {
    return { status: 'blocked', reason: 'integration requires one exact PASS artifact owner', reported: false };
  }
  const implementer = implementers[0]!;
  const receipts = (task.auditReceipts ?? []).filter((item) => (
    item.attemptId === implementer.auditAttemptId && item.revision === revision
    && item.receiptKind === 'final' && item.verdict === 'PASS'
  ));
  if (receipts.length !== 1) return { status: 'blocked', reason: 'exact PASS receipt unavailable', reported: false };
  const resolvedArtifact = await resolveIntegrationArtifact(task, implementer, deps, false);
  if (!resolvedArtifact.artifact) {
    const exactError = resolvedArtifact.failureReason
      ? `authoritative immutable integration bundle unavailable or mismatched (reason: ${resolvedArtifact.failureReason})`
      : 'authoritative immutable integration bundle unavailable or mismatched';
    return { status: 'blocked', reason: exactError, reported: false };
  }
  const integrationArtifact = resolvedArtifact.artifact;
  const sessions = (deps.listSessions ?? listSessions)();
  const coordinators = task.assignments.filter((assignment) => assignment.role === 'coordinator');
  const liveCoordinators = coordinators.flatMap((assignment) => {
    const session = exactLiveSessionForAssignment(assignment, sessions);
    return session?.role === 'brain' ? [{ assignment, session }] : [];
  });
  // Legacy tasks predating coordinator attribution carry an exact PASS receipt
  // and a clean worktree but ZERO coordinator rows, so this gate stranded them
  // permanently. Recovery is DEFERRED rather than decided here: minting a
  // coordinator now would create a row for a task whose worktree may still turn
  // out to be unusable, and every existing PASS/revision/attempt/receipt and
  // manifest gate must pass FIRST. Nothing is created on this line.
  let recoveredBrain: SessionRecord | undefined;
  if (liveCoordinators.length !== 1) {
    // Only the zero-row legacy shape is recoverable. A task that HAS coordinator
    // rows but none live is a different, non-legacy condition and stays closed.
    if (coordinators.length > 0) {
      return { status: 'blocked', reason: 'integration requires one exact live Brain coordinator', reported: false };
    }
    // Resolves undefined unless EXACTLY one non-child, non-stopped Brain owns
    // this project, so ambiguous and absent Brains both fail closed here.
    const candidate = uniqueAuthoritativeProjectBrain(task.projectName, sessions);
    // Conflicting historical provenance: another live Brain already appears in
    // this task's assignment lineage. Adopting a different Brain would rewrite
    // whose authority the task was executed under, so refuse rather than guess.
    const conflictingProvenance = candidate
      ? task.assignments.some((assignment) => (
        assignment.identity.sessionName !== candidate.name
        && sessions.some((live) => live.role === 'brain' && live.name === assignment.identity.sessionName)
      ))
      : false;
    if (!candidate || conflictingProvenance) {
      return { status: 'blocked', reason: 'integration requires one exact live Brain coordinator', reported: false };
    }
    recoveredBrain = candidate;
  }
  // Every pre-existing gate has now passed, so the legacy recovery is safe to
  // materialise. Deterministic key: a replay reuses the same row rather than
  // minting a second coordinator.
  let recoveredCoordinator: PersistedSupervisionTaskAssignment | undefined;
  if (recoveredBrain) {
    // A Brain whose runtime identity cannot be resolved cannot carry authority.
    const recoveredIdentity = supervisionTaskIdentityForTarget(recoveredBrain);
    if (!recoveredIdentity) {
      return { status: 'blocked', reason: 'integration requires one exact live Brain coordinator', reported: false };
    }
    const createdCoordinator = registry.createAssignment({
      taskId: task.taskId,
      role: 'coordinator',
      identity: recoveredIdentity,
      scopeFiles: [],
      required: false,
      idempotencyKey: `auto-integration-coordinator:${task.taskId}:${revision}`,
      now: (deps.now ?? Date.now)(),
    });
    if (!createdCoordinator.ok) {
      return {
        status: 'blocked',
        reason: `integration coordinator recovery rejected: ${createdCoordinator.reason}`,
        reported: false,
      };
    }
    recoveredCoordinator = createdCoordinator.value;
  }
  const { assignment: coordinator, session: brain } = recoveredCoordinator && recoveredBrain
    ? { assignment: recoveredCoordinator, session: recoveredBrain }
    : liveCoordinators[0]!;
  const existingOwners = task.assignments.filter((assignment) => (
    assignment.role === 'integration_owner' && assignment.status !== 'cancelled'
    && assignment.status !== 'finalized' && (!assignment.auditRevision || assignment.auditRevision === revision)
  ));
  if (existingOwners.length > 1) return { status: 'blocked', reason: 'multiple live integration owners', reported: false };
  let owner = existingOwners[0];
  // Task snapshots intentionally omit terminal assignments. Resolve the
  // persisted pointer through the registry so a cancelled historical owner is
  // recovered in place instead of becoming invisible and causing a replacement
  // owner to be minted.
  const pointedOwner = task.integrationOwnerAssignmentId
    ? registry.getAssignment(task.integrationOwnerAssignmentId)
    : undefined;
  const staleOwnerPointer = pointedOwner?.taskId === task.taskId
    && pointedOwner.role === 'integration_owner'
    && pointedOwner.status === 'cancelled'
    ? pointedOwner
    : undefined;
  if (!owner && staleOwnerPointer) {
    const recovered = registry.recoverCancelledIntegrationOwner({
      taskId: task.taskId,
      assignmentId: staleOwnerPointer.assignmentId,
      identity: coordinator.identity,
      expectedRevision: revision,
      expectedAttemptId: implementer.auditAttemptId!,
      expectedGeneration: staleOwnerPointer.generation,
      scopeFiles: integrationArtifact.files.map((file) => file.path),
      reason: 'materialize the exact current PASS on the same historical integration owner',
      now: (deps.now ?? Date.now)(),
    });
    if (!recovered.ok) {
      return {
        status: 'blocked',
        reason: `integration owner recovery rejected: ${recovered.reason}`,
        reported: false,
      };
    }
    owner = recovered.value;
  }
  if (!owner) {
    const created = registry.createAssignment({
      taskId: task.taskId,
      role: 'integration_owner',
      identity: coordinator.identity,
      scopeFiles: integrationArtifact.files.map((file) => file.path),
      required: true,
      auditAttemptId: implementer.auditAttemptId,
      auditRevision: revision,
      idempotencyKey: `auto-integration:${task.taskId}:${revision}`,
      now: (deps.now ?? Date.now)(),
    });
    if (!created.ok) return { status: 'blocked', reason: `integration owner materialization rejected: ${created.reason}`, reported: false };
    owner = created.value;
  }
  const blockedAfterOwner = (reason: string): DeterministicContinuationDispatchResult => {
    const recorded = registry.recordIntegrationDispatchBlocker({
      taskId: task.taskId,
      assignmentId: owner!.assignmentId,
      revision,
      reason,
      now: (deps.now ?? Date.now)(),
    });
    return { status: 'blocked', reason, reported: recorded.ok };
  };
  let integrationWorktree: string | undefined;
  if (integrationArtifact.bundle) {
    const ensured = await (deps.ensureIntegrationWorktree ?? defaultEnsureSupervisionAssignmentWorktree)({
      projectRoot: brain.projectDir,
      sessionName: brain.name,
      assignmentId: owner.assignmentId,
      baseRevision: integrationArtifact.bundle.headSha,
    });
    if (!ensured.ok) {
      return blockedAfterOwner(`integration bundle worktree provisioning rejected: ${ensured.reason}`);
    }
    const applied = (deps.applyIntegrationBundle ?? applySupervisionIntegrationBundle)({
      bundle: integrationArtifact.bundle,
      worktreePath: ensured.worktreePath,
    });
    if (!applied.ok) {
      const fingerprints = applied.expected || applied.actual
        ? ` (${[applied.expected, applied.actual].filter(Boolean).join(' vs ')})`
        : '';
      return blockedAfterOwner(
        `integration bundle apply rejected: ${applied.reason}${applied.path ? `:${applied.path}` : ''}${fingerprints}`,
      );
    }
    integrationWorktree = ensured.worktreePath;
  }
  const clearedDispatchBlocker = registry.clearIntegrationDispatchBlocker({
    taskId: task.taskId,
    assignmentId: owner.assignmentId,
    revision,
    now: (deps.now ?? Date.now)(),
  });
  if (!clearedDispatchBlocker.ok) {
    return blockedAfterOwner(`integration dispatch blocker recovery rejected: ${clearedDispatchBlocker.reason}`);
  }
  // Reuse the registry's receipt-authenticated, atomic finish path rather than
  // copying PASS fields onto a delegated row. That path binds the exact final
  // audit, advances the owner to ready_for_integration, and keeps the parent at
  // ready_for_integration in one transaction. A crash before this call is
  // harmless: the idempotent owner is reused and completed on the next tick.
  const readyOwner = registry.finishAssignment({
    assignmentId: owner.assignmentId,
    identity: coordinator.identity,
    revision,
  });
  if (!readyOwner.ok) {
    return blockedAfterOwner(`integration owner PASS bind rejected: ${readyOwner.reason}`);
  }
  owner = readyOwner.value;
  if (owner.status !== 'ready_for_integration'
    || owner.auditAttemptId !== implementer.auditAttemptId
    || owner.auditRevision !== revision
    || owner.verdict?.trim().toUpperCase() !== 'PASS'
    || owner.crossVendorAuditPassed !== true) {
    return blockedAfterOwner('integration owner PASS bind did not converge');
  }
  const messageId = deterministicSendMessageId(`auto-integration:${owner.assignmentId}:${revision}:${implementer.auditAttemptId}`);
  const queueReference: QueueSupervisionReference = {
    kind: 'exact_integration', taskId: task.taskId, assignmentId: owner.assignmentId, revision,
  };
  if (bindExistingQueueSupervisionReference(brain.name, messageId, queueReference)) {
    return { status: 'replayed', assignmentId: owner.assignmentId, messageId };
  }
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
      `authoritativeBundle=${integrationArtifact.path}`,
      ...(integrationWorktree ? [`preparedIntegrationWorktree=${integrationWorktree}`] : []),
      '',
      'Exact pathspec:',
      ...integrationArtifact.files.map((file) => `- ${file.path}`),
      '',
      'Before any Git side effect, call supervision_integration_preflight with this exact task/revision/attempt/owner and destination ref; retain its preflightToken. Integrate only the verified bundle bytes already materialized in the prepared integration worktree. Record real commit/push evidence; if recovering an exact verified bundle commit that is already reachable from that ref, use already_present without repeating Git and the pre-Git token may be omitted. Otherwise call supervision_integration_finalize once with the same metadata and preflightToken. Field-level refusals are recoverable inputs, not a request for Brain to guess an extra task_finish. CI is optional smoke only: record ci_not_configured or ci_unavailable without dummy run ids, and record pending/failure/success only for an exact current-commit observation. Never poll, monitor, or let CI control finalization. Never stage openspec/ or docs/.',
    ].join('\n'),
    idempotencyKey: `auto-integration:${task.taskId}:${revision}`,
    internalMessageId: messageId,
    internalDurableQueue: true,
    internalSuppressTimeline: true,
    internalQueueSupervisionReference: queueReference,
  });
  if (result.status !== 'accepted') {
    return blockedAfterOwner(result.status === 'error' ? result.error : `integration dispatch ${result.status}`);
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
      converged = await registry.convergeLifecycle(now, {
        ...(deps.limit ? { limit: deps.limit } : {}),
        skipProject: (projectName) => isPairsEngineProject(projectName) || !isTaskPairEngineActive(projectName),
        resolveAuthoritativeBrain: (projectName, sessionName) => resolveAuthoritativeBrainIdentity(
          projectName,
          (deps.listSessions ?? listSessions)(),
          sessionName,
        ),
        inspectAssignmentWorktree: async (assignment) => {
          // Same fix as inspectAssignmentForConvergence above: without the
          // task's base, `files` only ever reflects uncommitted working-tree
          // state, which is empty for every properly-committed change.
          const inspected = await inspectSupervisionAssignmentWorktree({
            sessionName: assignment.identity.sessionName,
            assignmentId: assignment.assignmentId,
            baseRevision: registry.getTaskRecord(assignment.taskId)?.baseRevision,
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
    // `dispatchReadyAudit` derives its attempt id canonically from
    // (taskId, currentRevision), so a missing stored attempt is recomputed and
    // an older revision's attempt can never be reused here.
    //
    // Policy-less tasks are admitted ONLY when they are an actionable dead end
    // (validated, owed an audit, no auditor, no settled verdict). Selecting
    // them is what lets the dispatcher report `missing_audit_policy` once
    // instead of leaving them silently stuck; a genuinely manual task is still
    // filtered out here and never reaches the dispatcher. Fixing the
    // dispatcher without this filter would be a no-op, because the sweep would
    // never call it for exactly these tasks.
    const ready = registry.list({ status: 'ready_for_audit' })
      .filter((task) => Boolean(task.auditPolicy)
        || Boolean(legacyExplicitAuditRecoveryAttempt(task, registry))
        || isActionableMissingAuditPolicy(task, registry, task.currentRevision?.trim() ?? ''));
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
    from: caller.sessionName,
    fromLabel: callerRecord?.label,
    replyTo: caller.sessionName,
    replyAuthority: replyAuthority.authority,
  });

  let dispatchResult: SendDispatchMessageResult;
  try {
    dispatchResult = await d.dispatchMessage(cloneRecord, message, {
      dispatchId,
      messageId,
      messageOrigin: CHAT_MESSAGE_ORIGINS.AGENT,
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
      from: input.from,
      fromLabel: callerRecord?.label,
      replyTo: input.reply ? input.from : null,
      ...(replyAuthority ? { replyAuthority: replyAuthority.authority } : {}),
    });
    try {
      const result = await d.dispatchMessage(target, message, {
        dispatchId,
        messageId,
        // A session's send, or a shell/script callback via `imcodes send`; never typed in the chat.
        messageOrigin: input.from === IMCODES_EXTERNAL_CLI_SENDER ? CHAT_MESSAGE_ORIGINS.SYSTEM : CHAT_MESSAGE_ORIGINS.AGENT,
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
  }, withoutImplicitWorkPair({
    target: input.target,
    message: input.message,
    ...(input.reply !== undefined ? { reply: input.reply } : {}),
    ...(input.broadcast !== undefined ? { broadcast: input.broadcast } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    // A cron tick creates work on a schedule nobody is watching, so it gets the
    // wider refusal: firing every N minutes into a target that cannot run the
    // task builds a backlog and burns the retry budget for nothing.
    newWorkload: true,
  }), deps);
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
  const activity = sessionActivityOf(s.name);
  const openPairs = getTaskPairStore().pairsForSession(s.name)
    .filter((pair) => pair.state.brain === s.name || pair.state.executor === s.name || pair.state.auditor === s.name)
    .map((pair) => ({
      taskId: pair.state.taskId,
      role: (pair.state.brain === s.name ? 'brain' : pair.state.executor === s.name ? 'executor' : 'auditor') as 'brain' | 'executor' | 'auditor',
      status: pair.state.status,
      round: pair.state.round,
      ...(pair.state.title ? { title: pair.state.title } : {}),
    }));
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
    ...(activity?.lastMessageAt === undefined ? {} : { lastMessageAt: activity.lastMessageAt }),
    ...(activity?.lastToolCallAt === undefined ? {} : { lastToolCallAt: activity.lastToolCallAt }),
    ...(openPairs.length === 0 ? {} : { openPairs }),
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
