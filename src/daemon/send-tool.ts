import path from 'path';
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
import { readSupervisionSnapshotFromTransportConfig, type SupervisionTaskMetadata } from '../../shared/supervision-config.js';
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
import { getSupervisionTaskRegistry, type PersistedSupervisionTaskAssignmentIdentity } from './supervision-state-store.js';
import { getSession, listSessions } from '../store/session-store.js';
import { isExecutionClone } from './execution-clone.js';
import {
  createDelegationReplyAuthority,
  expireDelegationReplyAuthority,
} from './delegation-reply-authority.js';
import { buildServerMemberSharedActorOption as buildSharedServerMemberSharedActorOption, buildSessionDispatchMessage, dispatchSessionMessage, type SessionDispatchMessageResult, type SessionDispatchOptions } from './session-dispatch.js';

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
  if (cacheKey) {
    const cached = idempotencyCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return { ...cached.result, idempotentReplay: true };
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
  const gate = evaluateDelegationAdmission(allSessions, targets.targets, now, {
    newWorkload: input.newWorkload === true || Boolean(input.task) || Boolean(input.audit) || autoProvision,
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
  if (input.task && dispatchable.some((target) => (
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
      taskId = existing.taskId;
    } else {
      const task = registry.createOrGet({
        projectName: callerProjectName,
        topLevelTaskId: input.task.topLevelTaskId,
        classification: input.task.classification ?? 'integration_slice',
        objective: input.task.objective,
        acceptance: input.task.acceptance,
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
    const assignment = registry.createAssignment({
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
    const messageId = createSendMessageId();
    // A registered task must always have an authenticated return path. Without
    // this, a worker that hits illegal_transition or a contract contradiction
    // can only print NEEDS_INPUT in its own transcript and silently strand the
    // coordinating Brain. Ordinary untracked messages keep their opt-in reply
    // behavior.
    const replyRequired = input.reply === true || Boolean(supervisedTaskId && supervisedAssignmentId);
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
      ...(supervisedExecutionBinding ? [
          '[Daemon-resolved development assignment]',
          `Pool: ${supervisedExecutionBinding.pool}`,
          `Requested config: ${JSON.stringify(supervisedExecutionBinding.requested)}`,
          `Observed runtime identity: ${JSON.stringify(supervisedExecutionBinding.actual)}`,
          'Eligibility was decided by the coordinator from daemon evidence. Start the task directly; do not self-report or guess your model.',
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
        deliveryMode: input.deliveryMode ?? MEMORY_MCP_SEND_DELIVERY_MODES.APPEND,
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
