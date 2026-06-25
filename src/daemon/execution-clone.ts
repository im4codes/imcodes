/**
 * Daemon execution-clone creator + lifecycle GC.
 *
 * Execution clones are ephemeral sub-sessions copied from an eligible
 * (non-main) execution TEMPLATE session. They inherit runtime CONFIGURATION
 * (provider/model/preset/cwd/effort/transportConfig) but NEVER runtime
 * IDENTITY (provider/CLI session ids, resume tokens, pane handles, restart
 * counters, memory-dedup state, quota caches). Clone records carry first-class
 * {@link ExecutionCloneMetadata} (NEVER inside `transportConfig`, which the
 * transport-identity scrubber would silently strip) and are garbage-collected
 * by the daemon health-poller sweep.
 *
 * This module owns: clone detection, the active-clone count for cap
 * enforcement, the copy-allowlist / identity-denylist, template eligibility
 * validation, the launch-spec + metadata builders, the daemon→server
 * identity-scrub overrides, and the create / destroy / sweep operations.
 *
 * Pure functions (validate/build/scrub/sweep) take their inputs explicitly so
 * they are deterministic and unit-testable; the side-effecting create/destroy
 * delegate to the existing session-store + sub-session launch/stop path.
 */

import { randomUUID } from 'node:crypto';
import {
  EXECUTION_CLONE_KIND,
  EXECUTION_CLONE_ERROR_CODES,
  EXECUTION_CLONE_TIMELINE,
  parseDedicatedExecutionRoutingPreference,
  type ExecutionCloneErrorCode,
  type ExecutionCloneMetadata,
  type ExecutionCloneParentStage,
  type ExecutionCloneTerminalReason,
  type DedicatedExecutionRoutingGlobalPreference,
} from '../../shared/execution-clone.js';
import { cloneTransportConfigWithoutRuntimeIdentity } from '../../shared/transport-identity-scrub.js';
import { isSessionAgentType } from '../../shared/agent-types.js';
import { isRoleCompatibleMainSession } from '../../shared/session-group-clone.js';
import {
  getSession,
  listSessions,
  upsertSession,
  type SessionRecord,
} from '../store/session-store.js';
import { subSessionName, startSubSession, stopSubSession, normalizeShellBinForHost, type SubSessionRecord } from './subsession-manager.js';
import { timelineEmitter } from './timeline-emitter.js';
import type { TimelineEventType } from './timeline-event.js';
import logger from '../util/logger.js';

// ── Copy allowlist / identity denylist ──────────────────────────────────────
//
// Exported for tests. The allowlist is the ONLY set of fields copied from the
// template into the clone launch spec; the denylist is the set of identity /
// runtime-state fields that MUST NEVER be carried onto a clone (regardless of
// provider family). Anything not in the allowlist is dropped by construction.

/** Configuration fields safe to copy from a template onto a clone. */
export const EXECUTION_CLONE_COPY_ALLOWLIST: string[] = [
  'agentType',
  'runtimeType',
  'providerId',
  'projectDir',
  'requestedModel',
  'activeModel',
  'qwenModel',
  'effort',
  'ccPreset',
  'presetContextWindow',
  'transportConfig',
  // shell/script launch binary. Config, NOT identity — copied only for
  // shell/script templates (host-normalized so a cross-OS path is dropped).
  'shellBin',
];

/** Identity / runtime-state fields that MUST NEVER be carried onto a clone. */
export const EXECUTION_CLONE_IDENTITY_DENYLIST: string[] = [
  'providerSessionId',
  'providerResumeId',
  'ccSessionId',
  'codexSessionId',
  'geminiSessionId',
  'opencodeSessionId',
  'paneId',
  'state',
  'restarts',
  'restartTimestamps',
  'startupMemoryInjected',
  'recentInjectionHistory',
  'qwenFreshOnResume',
  'label',
  'quotaLabel',
  'quotaUsageLabel',
  'quotaMeta',
];

// ── Errors ──────────────────────────────────────────────────────────────────

/** Typed error thrown by the execution-clone create/destroy surface. */
export class ExecutionCloneError extends Error {
  constructor(public readonly code: ExecutionCloneErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ExecutionCloneError';
  }
}

// ── Detection + counting ────────────────────────────────────────────────────

/** True iff the record is an execution-clone sub-session. */
export function isExecutionClone(record: SessionRecord | undefined): boolean {
  return record?.executionCloneMetadata?.kind === EXECUTION_CLONE_KIND;
}

/**
 * Count the RUNNING execution clones for `parentRunId` — only `cleanupState ===
 * 'active'`. Used for the per-parent-run `maxParallelClones` cap. A
 * `collecting`/`destroying`/`destroyed` clone is cap-neutral: a `collecting`
 * clone's worker has ALREADY EXITED (`state:'stopped'`, `completedAt` set) so it
 * occupies no running concurrency slot and must not reserve a cap slot for its
 * (up-to-1h) retention window; `destroying`/`destroyed` clones are likewise gone.
 * Only `active` clones count toward the cap.
 */
export function countActiveExecutionClones(parentRunId: string): number {
  let count = 0;
  for (const record of listSessions()) {
    const meta = record.executionCloneMetadata;
    if (!meta || meta.kind !== EXECUTION_CLONE_KIND) continue;
    if (meta.parentRunId !== parentRunId) continue;
    if (meta.cleanupState === 'active') count += 1;
  }
  return count;
}

// ── Template eligibility ────────────────────────────────────────────────────

type ValidateResult = { ok: true } | { ok: false; code: ExecutionCloneErrorCode };

/** Returns true when `name` matches the main/brain session pattern `deck_<proj>_brain`. */
function isMainSessionName(name: string): boolean {
  return /^deck_.+_brain$/.test(name);
}

/**
 * Template states a clone may be copied from. A clone must inherit a LIVE,
 * launchable configuration; a `stopped`/`error` template is not a valid clone
 * source (fail-closed so the UI never offers — and the creator never accepts —
 * a terminal/crashed template).
 */
const EXECUTION_TEMPLATE_ALLOWED_STATES: ReadonlySet<string> = new Set(['idle', 'running']);

export interface ValidateExecutionTemplateCandidateOptions {
  /**
   * Caller/owner session name to reject self-cloning. Empty string (the default)
   * means "caller-independent base eligibility" — the "clone yourself" exclusion
   * is intentionally NOT applied (it is the calling session's concern in the UI).
   */
  callerSessionName?: string;
}

/**
 * Validate a candidate record as an execution-clone TEMPLATE. This is the single
 * base predicate shared by create-time validation
 * ({@link validateExecutionCloneRequest}) and the daemon-authoritative UI
 * eligibility projection (`computeExecutionTemplateEligibility`) so the two can
 * never diverge.
 *
 * Rejections (all map to existing error codes — no MCP contract churn):
 *  - missing record → template_ineligible;
 *  - `state` not in {idle, running} (i.e. stopped/error) → template_ineligible;
 *  - an execution clone (clone-of-clone) → clone_of_clone_forbidden
 *    (checked BEFORE the main gate so a clone never reports the wrong code);
 *  - a main/brain session (role==='brain' OR name matches `deck_<proj>_brain`)
 *    → template_ineligible;
 *  - blank `projectDir` → template_ineligible;
 *  - unknown/unsupported `agentType` (per `isSessionAgentType`) → template_ineligible;
 *  - the caller cloning ITSELF (only when `callerSessionName` is provided)
 *    → template_ineligible.
 */
export function validateExecutionTemplateCandidate(
  record: SessionRecord | undefined,
  opts: ValidateExecutionTemplateCandidateOptions = {},
): ValidateResult {
  if (!record) return { ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE };
  if (!EXECUTION_TEMPLATE_ALLOWED_STATES.has(record.state)) {
    return { ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE };
  }
  // Clone-of-clone is checked before the main-session gate so a (hypothetical)
  // clone never reports the wrong code.
  if (isExecutionClone(record)) {
    return { ok: false, code: EXECUTION_CLONE_ERROR_CODES.CLONE_OF_CLONE_FORBIDDEN };
  }
  if (record.role === 'brain' || isMainSessionName(record.name)) {
    return { ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE };
  }
  if (!record.projectDir || record.projectDir.trim().length === 0) {
    return { ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE };
  }
  if (!record.agentType || !isSessionAgentType(record.agentType)) {
    return { ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE };
  }
  const caller = opts.callerSessionName;
  if (caller && record.name === caller) {
    return { ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE };
  }
  return { ok: true };
}

/** Resolved+validated request: the three records the create path needs. */
export type ValidateExecutionCloneRequestResult =
  | { ok: true; template: SessionRecord; owner: SessionRecord; owningMain: SessionRecord }
  | { ok: false; code: ExecutionCloneErrorCode };

/**
 * Resolve and validate a full execution-clone create request before any side
 * effects. On top of {@link validateExecutionTemplateCandidate} (applied to the
 * template with the owner as the self-clone caller) this additionally requires:
 *  - `ownerSessionName` resolves to an existing record;
 *  - `owningMainSessionName` resolves to an existing record that is a
 *    role-compatible main session (`isRoleCompatibleMainSession`);
 *  - template, owner, and owning main all share the same `projectName`;
 *  - template ≠ owner (also covered by the candidate self-clone check).
 *
 * Returns the three resolved records on success, or a typed failure code
 * (existing `template_ineligible`/`clone_of_clone_forbidden` codes — no new MCP
 * contract surface).
 */
export function validateExecutionCloneRequest(
  req: ExecutionCloneRequest,
): ValidateExecutionCloneRequestResult {
  const template = getSession(req.templateSessionName);
  const candidate = validateExecutionTemplateCandidate(template, {
    callerSessionName: req.ownerSessionName,
  });
  if (!candidate.ok) return { ok: false, code: candidate.code };
  // `template` is defined — validateExecutionTemplateCandidate rejects undefined.
  const resolvedTemplate = template as SessionRecord;

  const owner = getSession(req.ownerSessionName);
  if (!owner) return { ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE };

  const owningMain = getSession(req.owningMainSessionName);
  if (!owningMain) return { ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE };
  if (!isRoleCompatibleMainSession(owningMain)) {
    return { ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE };
  }

  // Same-project scope across template + owner + owning main. A cross-project
  // template would leak prompts/files and break UI grouping/cleanup.
  if (
    resolvedTemplate.projectName !== owner.projectName
    || resolvedTemplate.projectName !== owningMain.projectName
  ) {
    return { ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE };
  }

  // Template must not be the owner/caller (also caught by the candidate check
  // when owner === template, but kept explicit for the request-level contract).
  if (resolvedTemplate.name === owner.name) {
    return { ok: false, code: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE };
  }

  return { ok: true, template: resolvedTemplate, owner, owningMain };
}

// ── Launch-spec builder (copy allowlist only) ───────────────────────────────

/**
 * Request shape for building/creating an execution clone. `ownerSessionName`
 * is the authorized creator (destroy authz anchor); `owningMainSessionName`
 * is the owning main/orchestrator session that scopes the project/UI and is
 * written as `parentSession`.
 */
export interface ExecutionCloneRequest {
  templateSessionName: string;
  parentRunId: string;
  parentStage: ExecutionCloneParentStage;
  ownerSessionName: string;
  owningMainSessionName: string;
  pref: DedicatedExecutionRoutingGlobalPreference;
}

/**
 * Launch config for a clone — copies ONLY the allowlist (with a SCRUBBED
 * `transportConfig`) and EXCLUDES every denylist field. `fresh:true` is
 * mandatory and provider-family-independent so the launch path starts a
 * brand-new provider/CLI session and never resumes.
 */
export interface ExecutionCloneSpec {
  agentType: string;
  runtimeType?: SessionRecord['runtimeType'];
  providerId?: string;
  projectDir: string;
  requestedModel?: string;
  activeModel?: string;
  qwenModel?: string;
  effort?: SessionRecord['effort'];
  ccPreset?: string;
  presetContextWindow?: number;
  transportConfig?: Record<string, unknown>;
  /** shell/script launch binary (host-normalized). Set ONLY for shell/script
   *  templates — config, NOT identity. Dropped when the template's stored path
   *  is not runnable on this host (cross-OS). */
  shellBin?: string | null;
  /** ALWAYS true — clone launch never resumes a prior provider/CLI session. */
  fresh: true;
}

/**
 * Build the clone launch spec from a template. Provider-family-independent:
 * NO identity is carried for ANY provider. `transportConfig` is passed through
 * the shared transport-identity scrubber so nested identity keys are dropped
 * even though `transportConfig` itself is on the allowlist.
 */
export function buildExecutionCloneSpec(
  template: SessionRecord,
  _req: ExecutionCloneRequest,
): ExecutionCloneSpec {
  const scrubbedTransport = cloneTransportConfigWithoutRuntimeIdentity(template.transportConfig);
  const spec: ExecutionCloneSpec = {
    agentType: template.agentType,
    projectDir: template.projectDir,
    fresh: true,
  };
  if (template.runtimeType !== undefined) spec.runtimeType = template.runtimeType;
  if (template.providerId !== undefined) spec.providerId = template.providerId;
  if (template.requestedModel !== undefined) spec.requestedModel = template.requestedModel;
  if (template.activeModel !== undefined) spec.activeModel = template.activeModel;
  if (template.qwenModel !== undefined) spec.qwenModel = template.qwenModel;
  if (template.effort !== undefined) spec.effort = template.effort;
  if (template.ccPreset !== undefined) spec.ccPreset = template.ccPreset;
  if (template.presetContextWindow !== undefined) spec.presetContextWindow = template.presetContextWindow;
  if (scrubbedTransport) spec.transportConfig = scrubbedTransport;
  // shellBin is a shell/script-only launch binary (config, not identity). Copy
  // it ONLY for shell/script templates, host-normalized so a cross-OS path is
  // dropped rather than carried onto the clone broken. Non-shell templates
  // never carry a shellBin.
  if (template.agentType === 'shell' || template.agentType === 'script') {
    const normalized = normalizeShellBinForHost(template.shellBin);
    if (normalized !== undefined) spec.shellBin = normalized;
  }
  return spec;
}

// ── Metadata builder ────────────────────────────────────────────────────────

/**
 * Build first-class clone metadata. `createdAt = now`,
 * `hardTimeoutAt = now + cloneHardTimeoutMs`, `retentionExpiresAt = null`
 * (set only at completion), `cleanupState = 'active'`. `pref` MUST be the
 * normalized (parser-bounded) preference — `cloneRetentionMs` is persisted from
 * it so completion can compute `retentionExpiresAt = completedAt +
 * cloneRetentionMs` with the configured (not defaulted) value.
 */
export function buildExecutionCloneMetadata(
  req: ExecutionCloneRequest,
  now: number,
  pref: DedicatedExecutionRoutingGlobalPreference,
): ExecutionCloneMetadata {
  return {
    kind: EXECUTION_CLONE_KIND,
    ephemeral: true,
    cloneOfSessionName: req.templateSessionName,
    parentRunId: req.parentRunId,
    parentStage: req.parentStage,
    createdBySessionName: req.ownerSessionName,
    createdAt: now,
    hardTimeoutAt: now + pref.cloneHardTimeoutMs,
    cloneRetentionMs: pref.cloneRetentionMs,
    retentionExpiresAt: null,
    cleanupState: 'active',
    autoDestroy: true,
  };
}

/**
 * Resolve the retention duration (ms) to apply when reaping a completed clone.
 * Reads the value persisted at create from {@link ExecutionCloneMetadata} and
 * sanitizes it through the shared preference parser so old/rolling records
 * (`undefined`), `NaN`, negative, and finite out-of-bounds values all resolve to
 * a safe bounded duration — `undefined` falls back to `DEFAULT_CLONE_RETENTION_MS`.
 * Used by BOTH completion paths (`completeExecutionCloneOnRuntimeExit` here and
 * `completeExecutionCloneOnPaneDeath` in lifecycle.ts) so retention is computed
 * identically regardless of which signal terminated the clone.
 */
export function resolveExecutionCloneRetentionMs(meta: ExecutionCloneMetadata | undefined): number {
  return parseDedicatedExecutionRoutingPreference({
    cloneRetentionMs: meta?.cloneRetentionMs,
  }).cloneRetentionMs;
}

// ── Daemon→server identity-scrub overrides ──────────────────────────────────

/**
 * Identity fields to force-undefined when syncing a clone record to the
 * server, so the daemon→server sync never leaks template identity (and the
 * server upsert's COALESCE cannot resurrect a stale identity column). Returns
 * an empty object for non-clone records.
 */
export function buildScrubbedSyncOverrides(record: SessionRecord): Partial<SessionRecord> {
  if (!isExecutionClone(record)) return {};
  return {
    ccSessionId: undefined,
    codexSessionId: undefined,
    geminiSessionId: undefined,
    opencodeSessionId: undefined,
    providerSessionId: undefined,
    providerResumeId: undefined,
    paneId: undefined,
  };
}

// ── Create ──────────────────────────────────────────────────────────────────

export interface CreateExecutionCloneResult {
  sessionName: string;
  target: string;
  metadata: ExecutionCloneMetadata;
}

/** Allocate a fresh unique sub-session id whose `deck_sub_*` name is unused. */
function allocateFreshCloneId(): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    if (!getSession(subSessionName(id))) return id;
  }
  throw new ExecutionCloneError(
    EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    'Unable to allocate a fresh execution-clone session id',
  );
}

/**
 * Create an execution clone from a template.
 *
 * Order of operations (matches the design's create→dispatch rollback model):
 *  1. validate template eligibility (throws on !ok);
 *  2. enforce the per-parent-run concurrency cap (capacity_full when full);
 *  3. allocate a FRESH unique `deck_sub_*` name — HARD-ERROR if a record
 *     already exists for it (a same-name record is a collision, NEVER a
 *     resume source);
 *  4. build spec + metadata;
 *  5. PERSIST the SessionRecord with `executionCloneMetadata` in the FIRST
 *     upsert (before launch/sync) so a crash leaves a sweepable record;
 *  6. launch via the existing sub-session launch path forcing `fresh:true`,
 *     with `parentSession = owningMainSessionName`.
 *
 * On any failure AFTER the first upsert, best-effort destroy the partial clone.
 */
export async function createExecutionClone(
  req: ExecutionCloneRequest,
): Promise<CreateExecutionCloneResult> {
  // Full request validation BEFORE the cap check and the first upsert: template
  // candidate eligibility + owner/owningMain existence + role-compatible main +
  // same-project scope. Fail-closed on any invalid relationship.
  const validation = validateExecutionCloneRequest(req);
  if (!validation.ok) {
    throw new ExecutionCloneError(validation.code);
  }
  const resolvedTemplate = validation.template;

  // Normalize the preference BEFORE the cap check + metadata build so every
  // numeric is finite + clamped to `[MIN,MAX]`. This makes the cap comparison
  // NaN-safe (a `NaN` cap would make `count >= cap` always false → unbounded)
  // and `hardTimeoutAt` always finite — for the MCP path AND as a backstop for
  // the programmatic path (which normalizes at its own entry too). The shared
  // parser is the single SSOT for this; never read a raw `req.pref` numeric.
  const pref = parseDedicatedExecutionRoutingPreference(req.pref);

  if (countActiveExecutionClones(req.parentRunId) >= pref.maxParallelClones) {
    throw new ExecutionCloneError(EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL);
  }

  const id = allocateFreshCloneId();
  const sessionName = subSessionName(id);
  // Re-check under the just-allocated name — a record here is a hard collision,
  // never a resume source.
  if (getSession(sessionName)) {
    throw new ExecutionCloneError(
      EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
      `Execution-clone session name collision: ${sessionName}`,
    );
  }

  const now = Date.now();
  const spec = buildExecutionCloneSpec(resolvedTemplate, req);
  const metadata = buildExecutionCloneMetadata(req, now, pref);

  // FIRST upsert — persist the clone record WITH metadata before any launch or
  // sync, so a crash between create and launch still leaves a sweepable record.
  const record: SessionRecord = {
    name: sessionName,
    projectName: resolvedTemplate.projectName,
    role: 'w1',
    agentType: spec.agentType,
    projectDir: spec.projectDir,
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: now,
    updatedAt: now,
    parentSession: req.owningMainSessionName,
    userCreated: true,
    executionCloneMetadata: metadata,
    ...(spec.runtimeType !== undefined ? { runtimeType: spec.runtimeType } : {}),
    ...(spec.providerId !== undefined ? { providerId: spec.providerId } : {}),
    ...(spec.requestedModel !== undefined ? { requestedModel: spec.requestedModel } : {}),
    ...(spec.activeModel !== undefined ? { activeModel: spec.activeModel } : {}),
    ...(spec.qwenModel !== undefined ? { qwenModel: spec.qwenModel } : {}),
    ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
    ...(spec.ccPreset !== undefined ? { ccPreset: spec.ccPreset } : {}),
    ...(spec.presetContextWindow !== undefined ? { presetContextWindow: spec.presetContextWindow } : {}),
    ...(spec.transportConfig !== undefined ? { transportConfig: spec.transportConfig } : {}),
    ...(spec.shellBin != null ? { shellBin: spec.shellBin } : {}),
  };
  upsertSession(record);

  try {
    // Launch via the existing sub-session path, forcing fresh:true so the
    // provider/CLI starts a brand-new session and never resumes. NO identity
    // ids are passed — the denylist is enforced by construction (we only set
    // allowlist fields on the sub-session launch record).
    const sub: SubSessionRecord = {
      id,
      type: spec.agentType,
      cwd: spec.projectDir,
      runtimeType: spec.runtimeType ?? null,
      providerId: spec.providerId ?? null,
      // Launch-model fallback (mirrors session-group-clone): a template may carry
      // only activeModel or only qwenModel; without this fallback the clone would
      // launch on the provider default instead of the template's model.
      requestedModel: spec.requestedModel ?? spec.activeModel ?? spec.qwenModel ?? null,
      activeModel: spec.activeModel ?? null,
      qwenModel: spec.qwenModel ?? null,
      transportConfig: spec.transportConfig ?? null,
      ccPreset: spec.ccPreset ?? null,
      parentSession: req.owningMainSessionName,
      fresh: true,
      ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
      ...(spec.shellBin != null ? { shellBin: spec.shellBin } : {}),
    };
    await startSubSession(sub);
  } catch (err) {
    // Best-effort rollback — a partially-created clone must not leak.
    logger.warn(
      { sessionName, parentRunId: req.parentRunId, err },
      'Execution-clone launch failed after first upsert; destroying partial clone',
    );
    await destroyExecutionClone({ target: sessionName, reason: 'destroyed', bypassAuth: true }).catch(() => {});
    throw err;
  }

  return { sessionName, target: sessionName, metadata };
}

// ── Destroy ─────────────────────────────────────────────────────────────────

export interface DestroyExecutionCloneRequest {
  target: string;
  /** When provided, must equal the clone's `createdBySessionName` unless `bypassAuth`. */
  callerSessionName?: string;
  reason: ExecutionCloneTerminalReasonLike;
  /** Set by the daemon GC to bypass creator-only authorization. */
  bypassAuth?: boolean;
}

/** Reason recorded on the terminal event (kept loose to accept GC/sweep reasons). */
type ExecutionCloneTerminalReasonLike = string;

/**
 * Destroy a clone: authorize → mark `destroying` → stop the sub-session →
 * emit the terminal timeline event.
 *
 * Clone-only, fail-closed: a missing record OR a record that is NOT an
 * execution clone (`executionCloneMetadata.kind !== EXECUTION_CLONE_KIND`) →
 * `target_not_found`, thrown BEFORE authorization and BEFORE `stopSubSession`,
 * EVEN when `bypassAuth` is set. Post-P0 a genuine clone keeps its metadata
 * across every upsert, so rollback/GC of real clones still works; this only
 * stops a wrong-target string (or a normal sub-session) from being torn down
 * through the clone destroy path.
 *
 * Authorization: when `callerSessionName` is provided it MUST equal the
 * clone's `createdBySessionName`, unless `bypassAuth` (daemon GC) is set —
 * otherwise `destroy_forbidden`.
 */
export async function destroyExecutionClone(req: DestroyExecutionCloneRequest): Promise<void> {
  const record = getSession(req.target);
  // Clone-kind guard FIRST — before auth and before stopSubSession, even for
  // bypassAuth GC/rollback callers. A non-clone target is never torn down here.
  if (!record || record.executionCloneMetadata?.kind !== EXECUTION_CLONE_KIND) {
    throw new ExecutionCloneError(EXECUTION_CLONE_ERROR_CODES.TARGET_NOT_FOUND);
  }
  const meta = record.executionCloneMetadata;

  if (
    req.callerSessionName !== undefined
    && !req.bypassAuth
    && meta?.createdBySessionName !== req.callerSessionName
  ) {
    throw new ExecutionCloneError(EXECUTION_CLONE_ERROR_CODES.DESTROY_FORBIDDEN);
  }

  const now = Date.now();
  if (meta) {
    upsertSession({
      ...record,
      executionCloneMetadata: {
        ...meta,
        destroyRequestedAt: meta.destroyRequestedAt ?? now,
        completedAt: meta.completedAt ?? now,
        cleanupState: 'destroying',
      },
    });
  }

  await stopSubSession(req.target);

  // `EXECUTION_CLONE_TIMELINE.TERMINAL` is the canonical event name from
  // shared/execution-clone.ts. The `TimelineEventType` union in
  // src/shared/timeline/types.ts is extended by the timeline-integration task
  // (a separate owner); cast here so this module compiles against the current
  // union without copying or redefining the event-name constant.
  timelineEmitter.emit(
    req.target,
    EXECUTION_CLONE_TIMELINE.TERMINAL as unknown as TimelineEventType,
    {
      sessionName: req.target,
      parentRunId: meta?.parentRunId,
      reason: req.reason,
    },
  );
}

// ── Transport runtime-exit completion ────────────────────────────────────────

/**
 * Mark an execution clone whose runtime exited (a transport clone has no tmux
 * pane, so the pane-death poller never fires for it) as completed, so the GC
 * retention reap can later remove it. Mirrors `completeExecutionCloneOnPaneDeath`
 * (lifecycle.ts): sets `completedAt`, `retentionExpiresAt = now +
 * resolveExecutionCloneRetentionMs(meta)` (the configured retention persisted at
 * create, falling back to the parser default for old records),
 * `cleanupState: 'collecting'`, `state: 'stopped'`, and emits
 * `EXECUTION_CLONE_TIMELINE.TERMINAL`.
 *
 * Idempotent + safe: a no-op when the record is not a clone, is already
 * completed, or is already in `destroying`/`destroyed`. Intended to run on the
 * transport-runtime teardown success path (subsession-manager.ts — a separate
 * owner) BEFORE the record is removed, so a sweep can reap it. This does NOT
 * replace the periodic creator-gone orphan sweep; it only covers a transport
 * worker torn down via an explicit stop while its orchestrator is still alive.
 */
export function completeExecutionCloneOnRuntimeExit(
  record: SessionRecord,
  reason: ExecutionCloneTerminalReason,
): void {
  const meta = record.executionCloneMetadata;
  if (!meta || meta.kind !== EXECUTION_CLONE_KIND) return;
  if (meta.completedAt || meta.cleanupState === 'destroying' || meta.cleanupState === 'destroyed') return;
  const now = Date.now();
  upsertSession({
    ...record,
    state: 'stopped',
    updatedAt: now,
    executionCloneMetadata: {
      ...meta,
      completedAt: now,
      retentionExpiresAt: now + resolveExecutionCloneRetentionMs(meta),
      cleanupState: 'collecting',
    },
  });
  timelineEmitter.emit(
    record.name,
    EXECUTION_CLONE_TIMELINE.TERMINAL as unknown as TimelineEventType,
    {
      sessionName: record.name,
      parentRunId: meta.parentRunId,
      reason,
    },
  );
}

// ── Sweep (GC) ──────────────────────────────────────────────────────────────

export interface SweepExecutionClonesDeps {
  /**
   * True ONLY when the clone's parent is provably terminal — i.e. its creator
   * session is gone / stopped / errored. This is the only POSITIVE terminal
   * signal: registry membership is ambiguous (registries DELETE runs on
   * completion), so an absent run cannot prove terminality and must NOT trigger
   * a sweep. Creator liveness, by contrast, is a positive signal and covers all
   * parent stages (every clone records its `createdBySessionName`). When the
   * creator is unknown/alive this MUST return false (protect → fall back to the
   * retention / hardTimeout backstop).
   */
  isCloneParentTerminal: (record: SessionRecord) => boolean;
  /** Destroy a clone target with the given terminal reason. */
  destroy: (target: string, reason: ExecutionCloneTerminalReasonLike) => Promise<void>;
  /** Whether the clone backend (pane/runtime) is still running. */
  isRunning: (record: SessionRecord) => boolean;
}

/**
 * Walk every execution-clone record and apply the GC precedence (per the
 * lifecycle state machine):
 *
 *  1. creator-gone orphan sweep → destroy('sweep'): the creator session that
 *     owns this clone is gone/stopped/errored, so no owner remains to collect
 *     its results. A creator-gone clone is destroyed even if its worker is
 *     still "running" (it is an orphan — nobody will read its output).
 *  2. running AND now ≥ hardTimeoutAt → destroy('hard_timeout') (running bound).
 *  3. NOT running AND retentionExpiresAt != null AND now ≥ retentionExpiresAt
 *     → destroy('sweep') (completed/terminal record past retention).
 *
 * This is a creator-gone orphan sweep + retention/hardTimeout backstop — NOT a
 * full parent-run-terminal sweep: when the parent run has reached terminal
 * state but the creator session is still alive, the clone is protected and
 * reaped only by retention / hardTimeout. A running clone whose retention
 * window elapsed but whose creator is still alive and which has not breached
 * its hard timeout is NOT touched — `cloneRetentionMs` governs reaping of
 * completed records only.
 *
 * Deps are injected so this is deterministic and unit-testable.
 */
export async function sweepExecutionClones(
  now: number,
  deps: SweepExecutionClonesDeps,
): Promise<{ swept: string[] }> {
  const swept: string[] = [];
  for (const record of listSessions()) {
    const meta = record.executionCloneMetadata;
    if (!meta || meta.kind !== EXECUTION_CLONE_KIND) continue;

    let reason: ExecutionCloneTerminalReasonLike | null = null;
    const running = deps.isRunning(record);
    if (deps.isCloneParentTerminal(record)) {
      reason = 'sweep';
    } else if (running && now >= meta.hardTimeoutAt) {
      reason = 'hard_timeout';
    } else if (!running && meta.retentionExpiresAt != null && now >= meta.retentionExpiresAt) {
      reason = 'sweep';
    }

    if (reason !== null) {
      swept.push(record.name);
      await deps.destroy(record.name, reason).catch((err) => {
        logger.warn({ sessionName: record.name, reason, err }, 'Execution-clone sweep destroy failed');
      });
    }
  }
  return { swept };
}
