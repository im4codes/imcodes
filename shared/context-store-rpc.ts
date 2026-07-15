/**
 * Context-store worker RPC contract — the SINGLE SOURCE OF TRUTH for the
 * cross-thread protocol between the daemon main thread
 * (`src/store/context-store-worker-client.ts`) and the context-store worker
 * (`src/store/context-store-worker.ts`).
 *
 * Per the project's no-duplicate-constants rule, every op name, error code,
 * priority lane, timeout tier, and backpressure cap lives here and is imported
 * by both sides — there are NO hardcoded RPC-name strings across daemon/worker.
 *
 * Three call layers (see the change's design.md, Decision 1):
 *   - L1 — allowlisted direct store wrappers (1:1 with a `context-store.ts`
 *     export of the same name). The worker calls the real store function ONLY
 *     when the op is in this allowlist AND resolves to a callable export; it
 *     never falls through to an arbitrary object property.
 *   - L2 — aggregate / single-transaction orchestration ops the worker
 *     implements by composing store calls inside one SQLite transaction.
 *   - L3 — bounded front-of-turn recall orchestration ops: collect + rank +
 *     redact + slice happen INSIDE the worker, only `<=limit` items cross back.
 *   - R5 management recall ops: same bounded worker execution, but default to
 *     normal priority so management/MCP search never competes with R1 recall.
 *
 * This module is daemon/server/web-agnostic (no `node:sqlite` import), so the
 * op list is plain strings; the worker validates each L1 op against the real
 * store export surface at dispatch time, and the Foundation test suite asserts
 * every L1 op resolves to a callable `context-store.ts` export.
 */

/** Priority lane for a context-store worker RPC. `high` (front-of-turn recall)
 *  jumps ahead of `normal`; `low` (checkpoint, backfill, lazy embedding fill)
 *  runs only when no `high`/`normal` work is queued. */
export const CONTEXT_STORE_RPC_PRIORITY = {
  high: 'high',
  normal: 'normal',
  low: 'low',
} as const;
export type ContextStoreRpcPriority =
  (typeof CONTEXT_STORE_RPC_PRIORITY)[keyof typeof CONTEXT_STORE_RPC_PRIORITY];

// ── L1: allowlisted direct store wrappers (each maps 1:1 to a context-store.ts export) ──
export const CONTEXT_STORE_L1_OPS = [
  // reads
  'getProcessedProjectionById',
  'listProcessedProjections',
  'listProcessedProjectionsByIds',
  'hasProcessedProjectionsInNamespace',
  'queryProcessedProjections',
  'getProcessedProjectionStats',
  'listMemoryProjectSummaries',
  'listProjectionSources',
  'getLocalProcessedFreshness',
  'listDirtyTargets',
  'listContextEvents',
  'queryPendingContextEvents',
  'getStagedEvent',
  'getArchivedEvent',
  'listArchivedEventsForTarget',
  'searchArchiveFts',
  'countStagedTokens',
  'estimateStagedTokenUpperBound',
  'countConsecutiveFailedJobs',
  'listContextNamespaces',
  'listContextObservations',
  'listStartupContextObservations',
  'getContextObservationById',
  'listObservationPromotionAudits',
  'listPinnedNotes',
  'listReplicationStates',
  'getReplicationState',
  'listLatestRecentSummarySessions',
  'getLatestRecentSummaryUpdatedAtForTarget',
  'getLatestMasterSummaryUpdatedAt',
  'listAllProcessedProjectionsByNamespace',
  'getContextMeta',
  'getProjectionEmbedding',
  'getProjectionEmbeddings',
  'listProjectionsMissingEmbedding',
  'countProjectionsMissingEmbedding',
  'summarizeCompressionRuns',
  'summarizeTurnUsage',
  'getOrCreateUsageAuthorityId',
  'ensureTurnUsageSyncMetadata',
  'backfillTurnUsageSyncMetadata',
  'selectTurnUsageSyncBatch',
  'getTurnUsageSyncDiagnostics',
  // writes / mutations
  'recordContextEvent',
  'enqueueContextJob',
  'claimContextJob',
  'updateContextJob',
  'deleteStagedEventsByIds',
  'deleteTentativeProjections',
  'writeProcessedProjection',
  'writeContextObservation',
  'updateContextObservationText',
  'updateProcessedProjectionSummary',
  'promoteContextObservation',
  'rejectAutomaticObservationPromotion',
  'deleteContextObservation',
  'ensureContextNamespace',
  'addPinnedNote',
  'upsertPinnedNote',
  'removePinnedNote',
  'archiveEventsForMaterialization',
  'insertProjectionSources',
  'setReplicationState',
  'clearDirtyTarget',
  'setContextMeta',
  'saveProjectionEmbedding',
  'recordCompressionRun',
  'recordTurnUsage',
  'recordTurnUsageSyncResults',
  'recordTurnUsageSyncRequestFailure',
  'recordMemoryHits',
  'pruneLocalMemory',
  'pruneArchiveIfDue',
  'pruneCompressionRuns',
  'pruneTurnUsage',
  'restoreArchivedMemory',
  'archiveMemory',
  'deleteMemory',
  'runArchiveBackfillBatch',
  'removeMemoryNoiseProjections',
  'repairMaterializationState',
  'backfillNamespacesAndObservations',
  'repairObservationStore',
  'checkpointWal',
] as const;

// ── L2: aggregate / single-transaction orchestration ops ──
export const CONTEXT_STORE_L2_OPS = [
  /** record event + read dirty/trigger inputs in one RPC; trigger decision and job enqueue stay on the caller */
  'ingestContextEvent',
  /** post-SDK materialization commit bundle in ONE worker SQLite transaction */
  'commitMaterialization',
] as const;

// ── L3: bounded front-of-turn recall orchestration ops (high priority by default) ──
export const CONTEXT_STORE_L3_OPS = [
  'searchLocalMemoryBounded',
  'searchLocalMemorySemanticBounded',
  'selectStartupMemoryBounded',
] as const;

// ── R5: bounded management/MCP recall orchestration ops (normal priority by default) ──
export const CONTEXT_STORE_R5_MANAGEMENT_OPS = [
  'searchLocalMemoryAuthorizedBounded',
] as const;

/** The full allowlist — the ONLY op names the worker will dispatch. */
export const CONTEXT_STORE_RPC_OPS = [
  ...CONTEXT_STORE_L1_OPS,
  ...CONTEXT_STORE_L2_OPS,
  ...CONTEXT_STORE_L3_OPS,
  ...CONTEXT_STORE_R5_MANAGEMENT_OPS,
] as const;

export type ContextStoreL1Op = (typeof CONTEXT_STORE_L1_OPS)[number];
export type ContextStoreL2Op = (typeof CONTEXT_STORE_L2_OPS)[number];
export type ContextStoreL3Op = (typeof CONTEXT_STORE_L3_OPS)[number];
export type ContextStoreR5ManagementOp = (typeof CONTEXT_STORE_R5_MANAGEMENT_OPS)[number];
export type ContextStoreRpcOp = (typeof CONTEXT_STORE_RPC_OPS)[number];

const L1_OP_SET: ReadonlySet<string> = new Set(CONTEXT_STORE_L1_OPS);
const L2_OP_SET: ReadonlySet<string> = new Set(CONTEXT_STORE_L2_OPS);
const L3_OP_SET: ReadonlySet<string> = new Set(CONTEXT_STORE_L3_OPS);
const R5_MANAGEMENT_OP_SET: ReadonlySet<string> = new Set(CONTEXT_STORE_R5_MANAGEMENT_OPS);
const RPC_OP_SET: ReadonlySet<string> = new Set(CONTEXT_STORE_RPC_OPS);

export function isContextStoreRpcOp(op: string): op is ContextStoreRpcOp {
  return RPC_OP_SET.has(op);
}
export function isContextStoreL1Op(op: string): op is ContextStoreL1Op {
  return L1_OP_SET.has(op);
}
export function isContextStoreL2Op(op: string): op is ContextStoreL2Op {
  return L2_OP_SET.has(op);
}
export function isContextStoreL3Op(op: string): op is ContextStoreL3Op {
  return L3_OP_SET.has(op);
}
export function isContextStoreR5ManagementOp(op: string): op is ContextStoreR5ManagementOp {
  return R5_MANAGEMENT_OP_SET.has(op);
}

/** Ops dispatched fire-and-forget (R2): best-effort telemetry and lazy embedding
 *  fill, never awaited on a hot path.
 *  NOTE: `recordTurnUsage` is deliberately NOT here — audit finding A1 made it a
 *  SYNCHRONOUS durable write (the deferred/fire-and-forget path lost rows under
 *  SIGTERM races); it is the documented sync-durability exception (design
 *  Decision 5), so it must never be dispatched fire-and-forget. */
export const CONTEXT_STORE_FIRE_AND_FORGET_OPS = [
  'recordMemoryHits',
  'saveProjectionEmbedding',
] as const;
/** The ONLY ops `client.fireAndForget()` accepts — narrows the method so a
 *  durable mutation (e.g. `writeContextObservation`) can never be silently
 *  dropped/reordered through the fire-and-forget lane. */
export type ContextStoreFireAndForgetOp = (typeof CONTEXT_STORE_FIRE_AND_FORGET_OPS)[number];
const FIRE_AND_FORGET_SET: ReadonlySet<string> = new Set(
  CONTEXT_STORE_FIRE_AND_FORGET_OPS,
);
export function isFireAndForgetOp(op: string): boolean {
  return FIRE_AND_FORGET_SET.has(op);
}

/** Ops that should run on the LOW lane (only when no high/normal work queued). */
export const CONTEXT_STORE_LOW_PRIORITY_OPS = [
  'checkpointWal',
  'runArchiveBackfillBatch',
  'saveProjectionEmbedding',
  'pruneArchiveIfDue',
  'pruneCompressionRuns',
  'pruneTurnUsage',
  'backfillTurnUsageSyncMetadata',
  'backfillNamespacesAndObservations',
  'repairObservationStore',
] as const;
const LOW_PRIORITY_SET: ReadonlySet<string> = new Set(
  CONTEXT_STORE_LOW_PRIORITY_OPS,
);

/** Default dispatch priority for an op when the caller does not override it. */
export function defaultPriorityForOp(op: ContextStoreRpcOp): ContextStoreRpcPriority {
  if (L3_OP_SET.has(op)) return CONTEXT_STORE_RPC_PRIORITY.high;
  if (LOW_PRIORITY_SET.has(op)) return CONTEXT_STORE_RPC_PRIORITY.low;
  return CONTEXT_STORE_RPC_PRIORITY.normal;
}

// ── Wire protocol ──────────────────────────────────────────────────────────
export interface ContextStoreRpcRequest {
  id: number;
  priority: ContextStoreRpcPriority;
  op: ContextStoreRpcOp;
  /** Arguments applied to the op. MUST be structured-cloneable (no functions). */
  args: unknown[];
}

export interface ContextStoreRpcError {
  code: string;
  message: string;
}

export type ContextStoreRpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: ContextStoreRpcError };

/** Stable, serialized error codes shared by worker and client. */
export const CONTEXT_STORE_RPC_ERROR = {
  /** op not in the allowlist or not a callable store export */
  unsupportedOperation: 'unsupported_operation',
  /** pending-request cap exceeded; awaited mutation rejected */
  overloaded: 'context_store_overloaded',
  /** per-RPC client timeout elapsed before a response */
  timeout: 'context_store_timeout',
  /** worker thread exited */
  workerExit: 'context_store_worker_exit',
  /** worker thread emitted an error event */
  workerError: 'context_store_worker_error',
  /** client disposed while the request was pending */
  disposed: 'context_store_disposed',
  /** worker threw while executing the op */
  opFailed: 'context_store_op_failed',
  /** request arguments could not be structured-cloned into the worker */
  cloneError: 'context_store_clone_error',
  /** the production worker owner is spawned but not ready / unavailable, and the
   *  failure policy forbids a main-thread in-process fallback — R3 mutations and
   *  R5 reads reject with this; R4 background callers convert it to requeue/backoff */
  unavailable: 'context_store_unavailable',
} as const;
export type ContextStoreRpcErrorCode =
  (typeof CONTEXT_STORE_RPC_ERROR)[keyof typeof CONTEXT_STORE_RPC_ERROR];

/** Per-RPC timeout tiers in milliseconds (see spec "Async client reliability").
 *  R1 is the front-of-turn read ceiling, capped against the live transport
 *  context budget at the call site; R2 telemetry is fire-and-forget (no await). */
export const CONTEXT_STORE_RPC_TIMEOUT_MS = {
  /** R1 front-of-turn read upper bound (further capped to the transport budget). */
  r1FrontOfTurnMax: 2000,
  /** R3 management/MCP read + R5 user mutation. */
  r3r5Management: 5000,
  /** R4 background pipeline (materialization, replication). */
  r4Background: 30000,
} as const;

/** Backpressure caps (see spec "Async client reliability"). */
export const CONTEXT_STORE_RPC_BACKPRESSURE = {
  /** max simultaneously-awaited pending requests before mutations are rejected */
  maxAwaitedPending: 128,
  /** max in-flight fire-and-forget entries before telemetry is dropped/coalesced */
  maxFireAndForgetPending: 64,
} as const;

/** Self-heal policy — mirror the timeline-projection worker watchdog.
 *  TWO INDEPENDENT throttle clocks for two distinct fault domains:
 *   - timeout (worker alive-but-slow): `respawnCooldownMs` after N consecutive
 *     awaited timeouts;
 *   - warmup/crash (worker cannot stay up): exponential `warmupBackoff*` after
 *     consecutive generations that died WITHOUT serving a successful op. */
export const CONTEXT_STORE_RPC_SELF_HEAL = {
  /** consecutive timeouts before the watchdog respawns the worker */
  consecutiveTimeoutsBeforeRespawn: 3,
  /** cooldown (ms) between timeout-driven respawns */
  respawnCooldownMs: 60_000,
  /** base backoff (ms) for the SECOND+ consecutive warmup/crash respawn failure
   *  (the FIRST failure retries immediately to preserve transient fast-recovery). */
  warmupBackoffBaseMs: 500,
  /** cap (ms) for the warmup/crash exponential backoff. */
  warmupBackoffMaxMs: 60_000,
} as const;

/** Reason a worker generation became unavailable. Keeps the timeout-respawn
 *  cooldown and the warmup/crash backoff independent, and ensures an intentional
 *  dispose never pollutes either failure counter. */
export const CONTEXT_STORE_WORKER_DOWN_REASON = {
  warmupError: 'warmup_error',
  workerError: 'worker_error',
  workerExit: 'worker_exit',
  timeoutRespawn: 'timeout_respawn',
  dispose: 'dispose',
} as const;
export type ContextStoreWorkerDownReason =
  (typeof CONTEXT_STORE_WORKER_DOWN_REASON)[keyof typeof CONTEXT_STORE_WORKER_DOWN_REASON];
