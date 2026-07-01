import path from 'path';
import { createHash } from 'node:crypto';
import { createSendDispatchId, createSendMessageId, type SendDispatchId, type SendMessageId } from '../../shared/send-message-id.js';
import { IMCODES_SEND_MCP_DISPATCH_FEATURE_FLAG } from '../../shared/imcodes-send.js';
import { MCP_ERROR_REASONS, type MCPErrorReason } from '../../shared/memory-mcp-errors.js';
import { MEMORY_MCP_CAPS } from '../../shared/memory-mcp-contracts.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';
import { isValidImcodesSessionName, resolveEffectiveProjectName, resolveRuntimeScope } from '../../shared/session-scope.js';
import type { SharedActorEnvelope } from '../../shared/tab-sharing.js';
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
import { getSession, listSessions } from '../store/session-store.js';
import { isExecutionClone } from './execution-clone.js';
import { timelineEmitter } from './timeline-emitter.js';
import { buildTransportQueueSnapshotPayload } from './transport-queue-projection.js';

export const SEND_MCP_DISPATCH_FEATURE_FLAG = IMCODES_SEND_MCP_DISPATCH_FEATURE_FLAG;
export const SEND_TOOL_ERROR_REASONS = {
  FEATURE_DISABLED: MCP_ERROR_REASONS.FEATURE_DISABLED,
  SCOPE_FORBIDDEN: MCP_ERROR_REASONS.SCOPE_FORBIDDEN,
  IDENTITY_REJECTED: MCP_ERROR_REASONS.IDENTITY_REJECTED,
  VALIDATION_FAILED: MCP_ERROR_REASONS.VALIDATION_FAILED,
  WRITE_QUOTA_EXCEEDED: MCP_ERROR_REASONS.WRITE_QUOTA_EXCEEDED,
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
  status: SessionRecord['state'];
  lastActiveAt: number;
}

export type SendToolErrorReason = (typeof SEND_TOOL_ERROR_REASONS)[keyof typeof SEND_TOOL_ERROR_REASONS];

export type SendListTargetsResult =
  | { status: 'ok'; items: SendTargetInfo[] }
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
  /** Optional execution-clone request — see {@link SendMessageCloneRequest}. */
  clone?: SendMessageCloneRequest;
}

export interface SendMessageDelivery {
  target: string;
  messageId?: SendMessageId;
  status: 'delivered' | 'failed';
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
    }
  | { status: 'disabled'; reason: typeof MCP_ERROR_REASONS.FEATURE_DISABLED; disabledFlag: typeof SEND_MCP_DISPATCH_FEATURE_FLAG }
  | { status: 'error'; reason: SendToolErrorReason; error: string };

export interface HookSendDispatchInput {
  from: string;
  targetRecords: SessionRecord[];
  message: string;
  files?: string[];
  projectRoot?: string | null;
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

export interface SendDispatchMessageOptions {
  dispatchId: SendDispatchId;
  messageId: SendMessageId;
  sharedActor?: SharedActorEnvelope;
}

export type SendDispatchMessageResult = 'sent' | 'queued' | void;

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
  input: { query?: string; limit?: number } = {},
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
  const candidates = getSiblingSessions({ ...caller, projectName: callerProjectName }, allSessions);
  const filtered = query
    ? candidates.filter((s) => [s.name, s.label, s.role, s.agentType].some((value) => String(value ?? '').toLowerCase().includes(query)))
    : candidates;

  return {
    status: 'ok',
    items: filtered.slice(0, limit).map(toTargetInfo),
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
  const allSessions = d.listSessions();
  const callerProjectName = effectiveCallerProjectName(caller, allSessions);
  if (!callerProjectName) {
    return { status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN, error: 'send_message requires a scoped caller' };
  }
  if (!input.target && !input.broadcast) {
    return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: 'target is required unless broadcast is true' };
  }
  if (!input.message || input.message.trim().length === 0) {
    return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: 'message is required' };
  }
  if (Buffer.byteLength(input.message, 'utf8') > MEMORY_MCP_CAPS.SEND_MESSAGE_MAX_BYTES) {
    return { status: 'error', reason: MCP_ERROR_REASONS.WRITE_QUOTA_EXCEEDED, error: `message exceeds ${MEMORY_MCP_CAPS.SEND_MESSAGE_MAX_BYTES} bytes` };
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
  const idempotencyTarget = input.broadcast ? '*' : input.target ?? '';
  const cacheKey = idempotencyKey ? `${caller.userId}\0${caller.sessionName}\0${idempotencyTarget}\0${idempotencyKey}` : '';
  const now = d.now();
  if (cacheKey) {
    const cached = idempotencyCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return { ...cached.result, idempotentReplay: true };
    if (cached) idempotencyCache.delete(cacheKey);
  }

  // Ordinary exact send: an exact `target === clone.name` may resolve to an
  // execution clone, but ONLY for that clone's creator (`exactCreatorOnly`).
  // Clones are never matched by label/agentType; normal sibling resolution is
  // unchanged (clones are excluded from the discoverable sibling set).
  const targets = resolveScopedTargets({ ...caller, projectName: callerProjectName }, input, allSessions, d.exactTargetOnly, 'exactCreatorOnly');
  if (!targets.ok) return { status: 'error', reason: targets.reason, error: targets.error };

  const fileRefs = sanitizeFileReferences(input.files, caller.projectRoot);
  if (!fileRefs.ok) return { status: 'error', reason: fileRefs.reason, error: fileRefs.error };

  const dispatchId = createSendDispatchId();
  const message = buildSendMessage(input.message, {
    files: fileRefs.files,
    replyTo: input.reply ? caller.sessionName : null,
  });
  const callerRecord = allSessions.find((session) => session.name === caller.sessionName);
  const deliveries: SendMessageDelivery[] = [];

  for (const target of targets.targets) {
    const messageId = createSendMessageId();
    try {
      await d.dispatchMessage(target, message, {
        dispatchId,
        messageId,
        ...buildServerMemberSharedActorOption(caller, callerRecord, target, messageId, now),
      });
      deliveries.push({ target: target.name, messageId, status: 'delivered' });
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
      error: failed === 1 ? deliveries[0]?.error ?? 'send dispatch failed' : 'send dispatch failed for all targets',
    };
  }

  const accepted: Extract<SendMessageResult, { status: 'accepted' }> = {
    status: 'accepted',
    dispatchId,
    ...(deliveries.length === 1 && delivered[0]?.messageId ? { messageId: delivered[0].messageId } : {}),
    deliveries,
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
  const message = buildSendMessage(input.message!, {
    files: fileRefs.files,
    replyTo: caller.sessionName, // force reply: true
  });
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

  try {
    await d.dispatchMessage(cloneRecord, message, {
      dispatchId,
      messageId,
      ...buildServerMemberSharedActorOption(caller, callerRecord, cloneRecord, messageId, now),
    });
  } catch (err) {
    // Rollback — destroy the just-created clone before surfacing the error.
    await destroyClone({ target: created.target, reason: EXECUTION_CLONE_TERMINAL_REASON_DESTROYED, bypassAuth: true }).catch(() => {});
    return { status: 'error', reason: MCP_ERROR_REASONS.INTERNAL_ERROR, error: sanitizeMcpErrorMessage(err) };
  }

  const accepted: Extract<SendMessageResult, { status: 'accepted' }> = {
    status: 'accepted',
    dispatchId,
    messageId,
    deliveries: [{ target: created.target, messageId, status: 'delivered' }],
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
  const fileRefs = sanitizeFileReferences(input.files, input.projectRoot ?? null);
  if (!fileRefs.ok) throw new Error(fileRefs.error);

  const dispatchId = createSendDispatchId();
  const delivered: string[] = [];
  const queued: string[] = [];
  const errors: string[] = [];
  const messages: SendMessageDelivery[] = [];
  const message = buildSendMessage(input.message, { files: fileRefs.files, replyTo: null });
  const callerRecord = d.getSession(input.from) ?? undefined;
  const now = d.now();

  for (const target of input.targetRecords) {
    const messageId = createSendMessageId();
    try {
      const result = await d.dispatchMessage(target, message, {
        dispatchId,
        messageId,
        ...buildServerMemberSharedActorOption(
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
      messages.push({ target: target.name, messageId, status: 'delivered' });
    } catch (err) {
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
  }, deps);
  if (result.status !== 'accepted') {
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

function toTargetInfo(s: SessionRecord): SendTargetInfo {
  return {
    target: s.name,
    label: s.label ?? null,
    sessionName: s.name,
    role: s.role,
    agentType: s.agentType,
    status: s.state,
    lastActiveAt: s.updatedAt,
  };
}

/**
 * Discoverable sibling sessions — used by `send_list_targets` and broadcast.
 * Execution clones are EXCLUDED here so they are never listed or broadcast to
 * (their only legitimate follow-up target is the `result.clone.target` returned
 * by the originating clone send). This is the `discoverable` resolution mode.
 */
function getSiblingSessions(caller: SendRuntimeCaller, allSessions: SessionRecord[]): SessionRecord[] {
  const callerProjectName = effectiveCallerProjectName(caller, allSessions);
  return allSessions.filter((s) => (
    s.state !== 'stopped'
    && s.name !== caller.sessionName
    && !isExecutionClone(s)
    && effectiveProjectName(s, allSessions) === callerProjectName
  ));
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

function isSubSessionRecord(sessionName: string | null | undefined, record?: SessionRecord): boolean {
  return Boolean(
    record?.parentSession
    || record?.userCreated === true && (record.name.startsWith('deck_sub_') || sessionName?.startsWith('deck_sub_'))
    || sessionName?.startsWith('deck_sub_'),
  );
}

function shouldAttachServerMemberActor(callerName: string | null, callerRecord: SessionRecord | undefined, target: SessionRecord): boolean {
  return isSubSessionRecord(callerName, callerRecord) || isSubSessionRecord(target.name, target);
}

function formatServerMemberActorName(callerName: string, callerRecord?: SessionRecord): string {
  const label = callerRecord?.label?.trim();
  if (label) return label;
  return callerRecord?.name || callerName;
}

function buildServerMemberSharedActorOption(
  caller: SendRuntimeCaller,
  callerRecord: SessionRecord | undefined,
  target: SessionRecord,
  actionId: string,
  now: number,
): { sharedActor: SharedActorEnvelope } | Record<string, never> {
  if (!caller.sessionName || !isValidImcodesSessionName(caller.sessionName)) return {};
  if (!shouldAttachServerMemberActor(caller.sessionName, callerRecord, target)) return {};
  const actorDisplayName = formatServerMemberActorName(caller.sessionName, callerRecord);
  const targetSnapshot = target.name.startsWith('deck_sub_')
    ? {
        kind: 'subsession' as const,
        serverId: 'local',
        subSessionId: target.name,
        ...(target.label ? { subSessionDisplayName: target.label } : {}),
      }
    : {
        kind: 'main' as const,
        serverId: 'local',
        sessionName: target.name,
      };
  return {
    sharedActor: {
      actorUserId: caller.userId || caller.sessionName,
      actorDisplayName,
      snapshot: {
        target: targetSnapshot,
        effectiveRole: 'participant',
        historyCutoffAt: 0,
        nextCoverageRecheckAt: null,
        coveringShareIds: [],
        primaryShareId: null,
        authorizedAt: now,
      },
      primaryShareId: null,
      effectiveActorRole: 'server-member',
      actionId,
      origin: 'server-member',
      authorizedAt: now,
      queuedAt: now,
    },
  };
}

function buildSendMessage(message: string, options: { files: string[]; replyTo: string | null }): string {
  let result = message;
  if (options.files.length > 0) {
    result += `\n\nReferenced files:\n${options.files.map((file) => `- ${file}`).join('\n')}`;
  }
  if (options.replyTo) {
    if (!isValidImcodesSessionName(options.replyTo)) return result;
    result += `\n\nAfter completing the above task, send your response using: imcodes send --no-reply ${JSON.stringify(options.replyTo)} ${JSON.stringify('Task: <brief summary of the request>\nResult: <your response>')}`;
  }
  return result;
}

async function dispatchSessionMessage(
  target: SessionRecord,
  message: string,
  options: SendDispatchMessageOptions,
): Promise<SendDispatchMessageResult> {
  if (target.runtimeType === 'transport') {
    const { getTransportRuntime } = await import('../agent/session-manager.js');
    const runtime = getTransportRuntime(target.name);
    if (!runtime) throw new Error(`no transport runtime for session ${target.name}`);
    const result = options.sharedActor
      ? runtime.send(message, options.messageId, undefined, undefined, { sharedActor: options.sharedActor })
      : runtime.send(message, options.messageId);
    if (result === 'sent') {
      emitStructuredTransportUserMessage(target.name, message, options.messageId, options.sharedActor);
    } else if (result === 'queued') {
      const queuePayload = buildTransportQueueSnapshotPayload(target.name, 'send_tool');
      timelineEmitter.emit(target.name, 'session.state', {
        state: 'queued',
        ...queuePayload,
      }, { source: 'daemon', confidence: 'high' });
    }
    return result;
  }

  const { sendProcessSessionMessageForAutomation } = await import('./command-handler.js');
  await sendProcessSessionMessageForAutomation(target.name, message);
}

function emitStructuredTransportUserMessage(
  sessionName: string,
  message: string,
  messageId: SendMessageId,
  sharedActor?: SharedActorEnvelope,
): void {
  timelineEmitter.emit(
    sessionName,
    'user.message',
    {
      text: message,
      allowDuplicate: true,
      commandId: messageId,
      clientMessageId: messageId,
      ...(sharedActor ? { sharedActor } : {}),
    },
    { source: 'daemon', confidence: 'high', eventId: `transport-user:${messageId}` },
  );
}
