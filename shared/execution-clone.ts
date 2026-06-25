/**
 * Shared contracts + preference layer for dedicated execution clone sessions.
 *
 * Execution clones are ephemeral sub-sessions copied from an eligible
 * (non-main) execution template session. They inherit runtime configuration
 * but never runtime identity, are bounded by hard-timeout / retention timers,
 * and are garbage-collected by the daemon. This module owns the canonical
 * constants, lifecycle states, error codes, metadata type, and the dedicated
 * execution routing preference (global enabled flag + bounded limits) plus the
 * per-project (server-namespaced) execution template key helper.
 *
 * Capability id is NEW and distinct from `session-group-clone:v1` so the two
 * features version and negotiate independently.
 */

// ── Capability + kind ────────────────────────────────────────────────────

/** Daemon capability gating the execution-clone MCP/send path. NOT the group-clone capability. */
export const EXECUTION_CLONE_CAPABILITY_V1 = 'execution-clone:v1' as const;

/** Discriminant `kind` marking a sub-session record as an execution clone. */
export const EXECUTION_CLONE_KIND = 'execution_clone' as const;

// ── Parent stages ─────────────────────────────────────────────────────────

/**
 * Execution entry-point stages that may create clones. Each keeps distinct
 * prompt semantics while sharing one routing preference.
 */
export const EXECUTION_CLONE_PARENT_STAGES = [
  'generic_execution',
  'team_final_execution',
  'openspec_implementation',
  'auto_deliver_implementation',
] as const;

export type ExecutionCloneParentStage = typeof EXECUTION_CLONE_PARENT_STAGES[number];

export function isExecutionCloneParentStage(x: unknown): x is ExecutionCloneParentStage {
  return typeof x === 'string'
    && (EXECUTION_CLONE_PARENT_STAGES as readonly string[]).includes(x);
}

// ── Cleanup / lifecycle states ────────────────────────────────────────────

/**
 * Clone teardown state machine:
 * active → collecting → destroying → destroyed.
 */
export const EXECUTION_CLONE_CLEANUP_STATES = [
  'active',
  'collecting',
  'destroying',
  'destroyed',
] as const;

export type ExecutionCloneCleanupState = typeof EXECUTION_CLONE_CLEANUP_STATES[number];

export function isExecutionCloneCleanupState(x: unknown): x is ExecutionCloneCleanupState {
  return typeof x === 'string'
    && (EXECUTION_CLONE_CLEANUP_STATES as readonly string[]).includes(x);
}

// ── Error codes ───────────────────────────────────────────────────────────

/** Error codes used across the execution-clone MCP/create/destroy surface. */
export const EXECUTION_CLONE_ERROR_CODES = {
  CAPACITY_FULL: 'capacity_full',
  /**
   * The per-parent-run cap is consumed by clones OUTSIDE the requesting
   * orchestration pool (which owns zero in-flight slots), so the pool can make
   * no progress. The orchestration fails closed with this code instead of
   * busy-looping against a cap it can never free.
   */
  CAPACITY_EXTERNALLY_SATURATED: 'capacity_externally_saturated',
  TEMPLATE_INELIGIBLE: 'template_ineligible',
  CLONE_OF_CLONE_FORBIDDEN: 'clone_of_clone_forbidden',
  WORKER_CLONE_FORBIDDEN: 'worker_clone_forbidden',
  CRON_CLONE_FORBIDDEN: 'cron_clone_forbidden',
  TARGET_NOT_FOUND: 'target_not_found',
  DESTROY_FORBIDDEN: 'destroy_forbidden',
} as const;

export type ExecutionCloneErrorCode =
  typeof EXECUTION_CLONE_ERROR_CODES[keyof typeof EXECUTION_CLONE_ERROR_CODES];

// ── Timeline event + terminal reasons ─────────────────────────────────────

/** Timeline event names emitted for execution-clone lifecycle transitions. */
export const EXECUTION_CLONE_TIMELINE = {
  TERMINAL: 'execution_clone.terminal',
} as const;

export type ExecutionCloneTimelineEvent =
  typeof EXECUTION_CLONE_TIMELINE[keyof typeof EXECUTION_CLONE_TIMELINE];

/** Reason recorded on an `execution_clone.terminal` event — which signal/path terminated the clone. */
export const EXECUTION_CLONE_TERMINAL_REASONS = [
  'reply',
  'pane_death',
  'hard_timeout',
  'destroyed',
  'sweep',
] as const;

export type ExecutionCloneTerminalReason = typeof EXECUTION_CLONE_TERMINAL_REASONS[number];

export function isExecutionCloneTerminalReason(x: unknown): x is ExecutionCloneTerminalReason {
  return typeof x === 'string'
    && (EXECUTION_CLONE_TERMINAL_REASONS as readonly string[]).includes(x);
}

// ── Clone metadata (first-class session field, NEVER inside transportConfig) ─

/**
 * Multi-timestamp execution-clone metadata. Persisted as a dedicated first-class
 * field on the sub-session record — NEVER inside `transportConfig` (the
 * transport-identity scrubber would silently drop identity-like keys).
 *
 * Record-relationship fields are distinct and must not be conflated:
 * - `cloneOfSessionName` = the TEMPLATE session this clone was copied from.
 * - `createdBySessionName` = the authorized creator (orchestrator/main); the destroy authz anchor.
 * (The owning main/orchestrator session lives in `SessionRecord.parentSession`.)
 */
export interface ExecutionCloneMetadata {
  kind: typeof EXECUTION_CLONE_KIND;
  ephemeral: true;
  /** The TEMPLATE session this clone was copied from (NOT the owner). */
  cloneOfSessionName: string;
  parentRunId: string;
  parentStage: ExecutionCloneParentStage;
  /** The authorized creator that issued the clone request; destroy authz anchor. */
  createdBySessionName: string;
  createdAt: number;
  /** createdAt + cloneHardTimeoutMs; bounds a RUNNING worker. */
  hardTimeoutAt: number;
  /**
   * Resolved retention duration (ms) persisted at create from the normalized
   * preference. Completion computes `retentionExpiresAt = completedAt +
   * cloneRetentionMs` from it. OPTIONAL for old/rolling records — completion
   * falls back to the parser default when it is absent/malformed.
   */
  cloneRetentionMs?: number;
  /** Set when non-running/completed/orphaned; reap deadline = completedAt + cloneRetentionMs. */
  retentionExpiresAt: number | null;
  completedAt?: number;
  destroyRequestedAt?: number;
  cleanupState: ExecutionCloneCleanupState;
  autoDestroy: true;
}

// ── Dedicated execution routing preference ────────────────────────────────

/**
 * GLOBAL routing preference key. Holds the enabled flag + bounded limits.
 * The selected template session is stored SEPARATELY, per-project, under
 * `executionTemplatePrefKey(serverId)` — mirroring the p2p config-scope split.
 */
export const EXECUTION_ROUTING_PREF_KEY = 'exec_routing.global.v1' as const;

/** Prefix for the per-project (server-namespaced) execution template preference key. */
export const EXECUTION_TEMPLATE_PREF_PREFIX = 'exec_routing.template' as const;

/** Sentinel namespace used when no serverId is available. */
export const EXECUTION_TEMPLATE_PREF_DEFAULT_SCOPE = 'default' as const;

/**
 * Per-project (server-namespaced) execution template preference key. Mirrors
 * `p2pScopedSessionKey`: a present serverId namespaces the key; a missing one
 * falls back to a stable `default` scope so the key is always well-defined.
 */
export function executionTemplatePrefKey(serverId?: string | null): string {
  const scope = serverId && serverId.length > 0 ? serverId : EXECUTION_TEMPLATE_PREF_DEFAULT_SCOPE;
  return `${EXECUTION_TEMPLATE_PREF_PREFIX}:${scope}`;
}

/** Legacy/global (un-namespaced) template key fallback for migration reads. */
export function executionTemplateLegacyPrefKey(): string {
  return EXECUTION_TEMPLATE_PREF_PREFIX;
}

/**
 * Global dedicated execution routing preference. `enabled` plus bounded limits.
 * The per-project template session name is stored separately (see
 * `executionTemplatePrefKey`) and is NOT part of this object.
 *
 * The retired `cloneTtlMs` field is intentionally absent — it conflated
 * record-retention with running-worker hard-timeout and is replaced by the two
 * distinct timers below.
 */
export interface DedicatedExecutionRoutingGlobalPreference {
  enabled: boolean;
  /** Per parent run. */
  maxParallelClones: number;
  /** Orchestrator-side pending-queue bound for over-decomposed work. */
  maxQueuedClones: number;
  /** Bounds a RUNNING worker; on breach the daemon stops → collects → destroys. */
  cloneHardTimeoutMs: number;
  /** Reaps a NON-running / completed / orphaned record after completion. */
  cloneRetentionMs: number;
}

// Default constants.
export const DEFAULT_MAX_PARALLEL_CLONES = 3;
export const DEFAULT_MAX_QUEUED_CLONES = 64;
export const DEFAULT_CLONE_HARD_TIMEOUT_MS = 60 * 60 * 1000; // 60 min
export const DEFAULT_CLONE_RETENTION_MS = 5 * 60 * 1000; // 5 min

// Bounds.
export const MIN_MAX_PARALLEL_CLONES = 1;
export const MAX_MAX_PARALLEL_CLONES = 16;
export const MIN_MAX_QUEUED_CLONES = 0;
export const MAX_MAX_QUEUED_CLONES = 1024;
export const MIN_CLONE_HARD_TIMEOUT_MS = 60_000; // 1 min
export const MAX_CLONE_HARD_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 hours
export const MIN_CLONE_RETENTION_MS = 0;
export const MAX_CLONE_RETENTION_MS = 60 * 60 * 1000; // 1 hour

export function defaultDedicatedExecutionRoutingPreference(): DedicatedExecutionRoutingGlobalPreference {
  return {
    enabled: false,
    maxParallelClones: DEFAULT_MAX_PARALLEL_CLONES,
    maxQueuedClones: DEFAULT_MAX_QUEUED_CLONES,
    cloneHardTimeoutMs: DEFAULT_CLONE_HARD_TIMEOUT_MS,
    cloneRetentionMs: DEFAULT_CLONE_RETENTION_MS,
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.round(num);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

/**
 * Tolerant parser for the global routing preference.
 *
 * - Non-object input → canonical defaults.
 * - Each numeric field is coerced and clamped into its bounds (NaN/missing →
 *   the field default before clamping).
 * - `enabled` is true ONLY when the raw value is strictly the boolean `true`.
 * - Any legacy `cloneTtlMs` field is ignored entirely and never appears in the
 *   output.
 */
export function parseDedicatedExecutionRoutingPreference(
  raw: unknown,
): DedicatedExecutionRoutingGlobalPreference {
  const defaults = defaultDedicatedExecutionRoutingPreference();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaults;
  }
  const record = raw as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    maxParallelClones: clampInt(
      record.maxParallelClones,
      defaults.maxParallelClones,
      MIN_MAX_PARALLEL_CLONES,
      MAX_MAX_PARALLEL_CLONES,
    ),
    maxQueuedClones: clampInt(
      record.maxQueuedClones,
      defaults.maxQueuedClones,
      MIN_MAX_QUEUED_CLONES,
      MAX_MAX_QUEUED_CLONES,
    ),
    cloneHardTimeoutMs: clampInt(
      record.cloneHardTimeoutMs,
      defaults.cloneHardTimeoutMs,
      MIN_CLONE_HARD_TIMEOUT_MS,
      MAX_CLONE_HARD_TIMEOUT_MS,
    ),
    cloneRetentionMs: clampInt(
      record.cloneRetentionMs,
      defaults.cloneRetentionMs,
      MIN_CLONE_RETENTION_MS,
      MAX_CLONE_RETENTION_MS,
    ),
  };
}

/**
 * Normalize a preference for storage — clamps/rounds every field through the
 * same tolerant parser so a round-trip is stable. Never emits `cloneTtlMs`.
 */
export function serializeDedicatedExecutionRoutingPreference(
  pref: DedicatedExecutionRoutingGlobalPreference,
): DedicatedExecutionRoutingGlobalPreference {
  return parseDedicatedExecutionRoutingPreference(pref);
}

/**
 * Resolved execution routing — the global preference combined with the
 * per-project template session resolved from `executionTemplatePrefKey`.
 * `templateSessionName` is null when no valid template is configured.
 */
export interface ResolvedExecutionRouting extends DedicatedExecutionRoutingGlobalPreference {
  templateSessionName: string | null;
}

export function resolveExecutionRouting(
  global: DedicatedExecutionRoutingGlobalPreference,
  templateSessionName: string | null,
): ResolvedExecutionRouting {
  return { ...global, templateSessionName: templateSessionName ?? null };
}
