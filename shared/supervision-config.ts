import type { SharedContextRuntimeBackend } from './context-types.js';
import { CLAUDE_CODE_MODEL_IDS, CODEX_MODEL_IDS } from '../src/shared/models/options.js';
import { QWEN_MODEL_IDS } from './qwen-models.js';
import {
  DEFAULT_CONTEXT_MODEL_BY_BACKEND,
  SHARED_CONTEXT_RUNTIME_BACKENDS,
  doesSharedContextBackendSupportPresets,
  getDefaultSharedContextModelForBackend,
  inferSharedContextRuntimeBackend,
  isKnownSharedContextModelForBackend,
  normalizeSharedContextRuntimeBackend,
} from './shared-context-runtime-config.js';
import { COMBO_PRESETS } from './p2p-modes.js';
import { PROCESS_SESSION_AGENT_TYPES, TRANSPORT_SESSION_AGENT_TYPES } from './agent-types.js';

export const SUPERVISION_CONTRACT_IDS = {
  DECISION: 'supervision_decision_v1',
  DECISION_REPAIR: 'supervision_decision_repair_v1',
  CONTINUE: 'supervision_continue_v1',
  TASK_RUN_STATUS: 'task_run_status_v1',
  OPENSPEC_IMPLEMENTATION_AUDIT: 'openspec_implementation_audit_v1',
  CONTEXTUAL_AUDIT: 'contextual_audit_v1',
  REWORK_BRIEF: 'rework_brief_v1',
} as const;

export const SUPERVISION_MODE = {
  OFF: 'off',
  SUPERVISED: 'supervised',
  SUPERVISED_AUDIT: 'supervised_audit',
} as const;

export const SUPERVISION_TRANSPORT_CONFIG_KEY = 'supervision' as const;
export const SUPERVISION_USER_DEFAULT_PREF_KEY = 'supervision.user_default' as const;

export const SUPERVISION_SUPPORTED_BACKENDS = SHARED_CONTEXT_RUNTIME_BACKENDS;
export const SUPERVISION_SUPPORTED_TARGET_SESSION_TYPES = TRANSPORT_SESSION_AGENT_TYPES;
export const SUPERVISION_UNSUPPORTED_TARGET_SESSION_TYPES = PROCESS_SESSION_AGENT_TYPES;

const SUPERVISION_AUDIT_MODE_ALLOWLIST = [
  'audit',
  'audit>plan',
  'review',
  'review>plan',
  'audit>review>plan',
] as const;

export const SUPERVISION_AUDIT_MODES = SUPERVISION_AUDIT_MODE_ALLOWLIST.filter((mode) => {
  if (!mode.includes('>')) return true;
  return COMBO_PRESETS.some((preset) => preset.key === mode);
}) as SupervisionAuditMode[];

// Default supervisor timeout aligns with design.md §5 (12_000 ms). Queue wait time
// counts against the same budget, so this must stay conservative.
export const SUPERVISION_DEFAULT_TIMEOUT_MS = 12_000;
export const SUPERVISION_DEFAULT_MAX_PARSE_RETRIES = 1;
export const SUPERVISION_DEFAULT_AUDIT_MODE: SupervisionAuditMode = 'audit';
export const SUPERVISION_DEFAULT_MAX_AUDIT_LOOPS = 2;
export const SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_STREAK = 2;
export const SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_TOTAL = 8;
export const SUPERVISION_DEFAULT_PROMPT_VERSION = SUPERVISION_CONTRACT_IDS.DECISION;
export const SUPERVISION_DEFAULT_TASK_RUN_PROMPT_VERSION = SUPERVISION_CONTRACT_IDS.TASK_RUN_STATUS;

// Reasons surfaced when the supervision layer cannot produce a structured model
// decision (provider, snapshot, or queue failure). Kept distinct from model-issued
// ask_human verdicts so UI/UX can present a "repair required" path.
export const SUPERVISION_UNAVAILABLE_REASONS = {
  PROVIDER_NOT_CONNECTED: 'provider_not_connected',
  INVALID_SNAPSHOT: 'invalid_snapshot',
  QUEUE_TIMEOUT: 'queue_timeout',
  DECISION_TIMEOUT: 'decision_timeout',
  INVALID_OUTPUT: 'invalid_output',
  PROVIDER_ERROR: 'provider_error',
} as const;
export type SupervisionUnavailableReason =
  typeof SUPERVISION_UNAVAILABLE_REASONS[keyof typeof SUPERVISION_UNAVAILABLE_REASONS];

// Backwards-compatible alias: retained because `web/` still imports this name.
// Prefer `SUPERVISION_DEFAULT_TIMEOUT_MS` in new code.
export const DEFAULT_SUPERVISION_TIMEOUT_MS = SUPERVISION_DEFAULT_TIMEOUT_MS;

export const TASK_RUN_STATUS_MARKERS = {
  COMPLETE: '<!-- IMCODES_TASK_RUN: COMPLETE -->',
  NEEDS_INPUT: '<!-- IMCODES_TASK_RUN: NEEDS_INPUT -->',
  BLOCKED: '<!-- IMCODES_TASK_RUN: BLOCKED -->',
} as const;

export const AUDIT_VERDICT_MARKERS = {
  PASS: '<!-- P2P_VERDICT: PASS -->',
  REWORK: '<!-- P2P_VERDICT: REWORK -->',
} as const;

export type SupervisionMode = typeof SUPERVISION_MODE[keyof typeof SUPERVISION_MODE];
export type SupervisionAuditMode = 'audit' | 'review' | 'audit>plan' | 'review>plan' | 'audit>review>plan';
export type TaskRunStatusMarker = keyof typeof TASK_RUN_STATUS_MARKERS;
export type AuditVerdictMarker = keyof typeof AUDIT_VERDICT_MARKERS;
export type TaskRunTerminalState = 'complete' | 'needs_input' | 'blocked';
export type AuditVerdict = 'PASS' | 'REWORK';
export type SessionSupervisionSnapshotIssue =
  | 'invalid_shape'
  | 'invalid_mode'
  | 'missing_backend'
  | 'invalid_backend'
  | 'missing_model'
  | 'invalid_model'
  | 'invalid_timeout'
  | 'invalid_prompt_version'
  | 'invalid_custom_instructions'
  | 'invalid_custom_instructions_override'
  | 'invalid_global_custom_instructions'
  | 'invalid_preset'
  | 'invalid_max_parse_retries'
  | 'invalid_max_auto_continue_streak'
  | 'invalid_max_auto_continue_total'
  | 'missing_audit_mode'
  | 'invalid_audit_mode'
  | 'invalid_max_audit_loops'
  | 'invalid_task_run_prompt_version';
export interface ParsedTaskRunTerminalState {
  state: TaskRunTerminalState | null;
  markerCount: number;
}

export interface ParsedAuditVerdict {
  verdict: AuditVerdict | null;
  markerCount: number;
}

export interface SupervisorDefaultConfig {
  backend: SharedContextRuntimeBackend;
  model: string;
  timeoutMs: number;
  promptVersion: string;
  maxAutoContinueStreak: number;
  maxAutoContinueTotal: number;
  /**
   * Optional global supervision custom instructions. Free text appended to the
   * supervisor prompt for every Auto-enabled session that does not set
   * `customInstructionsOverride` on its session snapshot. Persisted in the
   * user-default prefs; the daemon sees it via the per-session
   * `SessionSupervisionSnapshot.globalCustomInstructions` cache field, which
   * the web client keeps in sync.
   */
  customInstructions?: string;
  /**
   * Optional preset name for backends that expose them via
   * `doesSharedContextBackendSupportPresets()` (currently only `qwen`). When
   * set, the daemon broker routes the supervisor session through the preset's
   * env bundle by delegating to `resolveProcessingProviderSessionConfig`.
   */
  preset?: string;
}

export interface SessionSupervisionSnapshot extends SupervisorDefaultConfig {
  mode: SupervisionMode;
  /** Session-scoped supervision custom instructions. See merge rule in design §2. */
  customInstructions?: string;
  /**
   * When `true`, the session's own `customInstructions` replaces the global
   * value for this session (including when empty). When `false` or missing,
   * the daemon merges global + session as `global + "\n\n" + session`.
   */
  customInstructionsOverride?: boolean;
  /**
   * Cache mirror of the user-default global `customInstructions` value at the
   * time of the most recent session-snapshot write. The daemon treats this as
   * the authoritative "global layer" for merge resolution at dispatch time and
   * does not itself read user-default prefs. The web client keeps this in
   * sync: every snapshot save includes the currently known global value, and
   * global-only saves fan out cache-update patches to every currently-enabled
   * transport session.
   */
  globalCustomInstructions?: string;
  maxParseRetries: number;
  maxAutoContinueStreak: number;
  maxAutoContinueTotal: number;
  auditMode: SupervisionAuditMode;
  maxAuditLoops: number;
  taskRunPromptVersion: string;
}

export type SupervisionSessionSnapshot = SessionSupervisionSnapshot;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function trimString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizePositiveInteger(value: unknown, fallback: number, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const int = Math.floor(value);
  return int >= minimum ? int : fallback;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const int = Math.floor(value);
  return int >= 0 ? int : fallback;
}

export function isSupportedSupervisionBackend(value: string | null | undefined): value is SharedContextRuntimeBackend {
  const trimmed = trimString(value);
  return !!trimmed && SUPERVISION_SUPPORTED_BACKENDS.includes(trimmed as SharedContextRuntimeBackend);
}

export function isSupportedSupervisionTargetSessionType(value: string | null | undefined): boolean {
  const trimmed = trimString(value);
  return !!trimmed && SUPERVISION_SUPPORTED_TARGET_SESSION_TYPES.includes(trimmed as typeof TRANSPORT_SESSION_AGENT_TYPES[number]);
}

export function isSupportedSupervisionAuditMode(value: string | null | undefined): value is SupervisionAuditMode {
  const trimmed = trimString(value);
  return !!trimmed && (SUPERVISION_AUDIT_MODES as readonly string[]).includes(trimmed);
}

export function normalizeSupervisionMode(
  value: unknown,
  fallback: SupervisionMode = SUPERVISION_MODE.OFF,
): SupervisionMode {
  if (value === SUPERVISION_MODE.OFF || value === SUPERVISION_MODE.SUPERVISED || value === SUPERVISION_MODE.SUPERVISED_AUDIT) {
    return value;
  }
  return fallback;
}

export function normalizeSupervisorDefaultConfig(
  input: Partial<SupervisorDefaultConfig> | null | undefined,
  fallback?: Partial<SupervisorDefaultConfig> | null,
): SupervisorDefaultConfig {
  const merged = {
    ...(fallback ?? {}),
    ...(input ?? {}),
  } as Partial<SupervisorDefaultConfig>;

  const normalizedBackend = normalizeSharedContextRuntimeBackend(merged.backend)
    ?? inferSharedContextRuntimeBackend(merged.model)
    ?? SUPERVISION_SUPPORTED_BACKENDS[0];
  // Presets are only meaningful for backends that declare preset support
  // (currently qwen). We retain the trimmed value only in that case so
  // switching to a non-preset backend silently drops the stored preset.
  const rawPreset = trimString(merged.preset);
  const preset = rawPreset && doesSharedContextBackendSupportPresets(normalizedBackend) ? rawPreset : undefined;
  const rawModel = trimString(merged.model);
  const model = rawModel && isKnownSharedContextModelForBackend(normalizedBackend, rawModel, preset)
    ? rawModel
    : getDefaultSharedContextModelForBackend(normalizedBackend);
  const customInstructions = trimString(merged.customInstructions);
  return {
    backend: normalizedBackend,
    model,
    timeoutMs: normalizePositiveInteger(merged.timeoutMs, SUPERVISION_DEFAULT_TIMEOUT_MS, 1),
    promptVersion: trimString(merged.promptVersion) ?? SUPERVISION_DEFAULT_PROMPT_VERSION,
    maxAutoContinueStreak: normalizeNonNegativeInteger(merged.maxAutoContinueStreak, SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_STREAK),
    maxAutoContinueTotal: normalizeNonNegativeInteger(merged.maxAutoContinueTotal, SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_TOTAL),
    ...(customInstructions ? { customInstructions } : {}),
    ...(preset ? { preset } : {}),
  };
}

export function parseSupervisorDefaultConfig(value: unknown): SupervisorDefaultConfig | null {
  if (!isPlainObject(value)) return null;
  return normalizeSupervisorDefaultConfig(value);
}

export function getSessionSupervisionSnapshotIssues(
  value: unknown,
): SessionSupervisionSnapshotIssue[] {
  if (!isPlainObject(value)) return ['invalid_shape'];
  const record = value as Record<string, unknown>;
  const mode = record.mode;
  if (mode !== SUPERVISION_MODE.OFF && mode !== SUPERVISION_MODE.SUPERVISED && mode !== SUPERVISION_MODE.SUPERVISED_AUDIT) {
    return ['invalid_mode'];
  }
  if (mode === SUPERVISION_MODE.OFF) return [];

  const issues: SessionSupervisionSnapshotIssue[] = [];
  const backend = trimString(record.backend);
  if (!backend) issues.push('missing_backend');
  else if (!isSupportedSupervisionBackend(backend)) issues.push('invalid_backend');

  const model = trimString(record.model);
  // Preset is validated here as a non-empty string (when present) — the
  // backend-gating happens in the normalizer. We do NOT reject presets for
  // non-preset backends at validation time because the normalizer strips them.
  const preset = trimString(record.preset);
  if (record.preset != null && typeof record.preset !== 'string') {
    issues.push('invalid_preset');
  }
  if (!model) {
    issues.push('missing_model');
  } else if (
    backend
    && isSupportedSupervisionBackend(backend)
    && backend !== 'openclaw'
    // Pass `preset` so qwen + preset combos (e.g. `MiniMax-M2.5`) don't get
    // flagged as invalid_model. See design.md §3.
    && !isKnownSharedContextModelForBackend(backend, model, preset)
  ) {
    issues.push('invalid_model');
  }

  if (typeof record.timeoutMs !== 'number' || !Number.isFinite(record.timeoutMs) || record.timeoutMs <= 0) {
    issues.push('invalid_timeout');
  }
  if (!trimString(record.promptVersion)) issues.push('invalid_prompt_version');
  if (record.customInstructions != null && typeof record.customInstructions !== 'string') issues.push('invalid_custom_instructions');
  if (record.customInstructionsOverride != null && typeof record.customInstructionsOverride !== 'boolean') {
    issues.push('invalid_custom_instructions_override');
  }
  if (record.globalCustomInstructions != null && typeof record.globalCustomInstructions !== 'string') {
    issues.push('invalid_global_custom_instructions');
  }
  if (
    record.maxParseRetries != null
    && (typeof record.maxParseRetries !== 'number' || !Number.isFinite(record.maxParseRetries) || Math.floor(record.maxParseRetries) < 1)
  ) {
    issues.push('invalid_max_parse_retries');
  }
  if (
    record.maxAutoContinueStreak != null
    && (
      typeof record.maxAutoContinueStreak !== 'number'
      || !Number.isFinite(record.maxAutoContinueStreak)
      || Math.floor(record.maxAutoContinueStreak) < 0
    )
  ) {
    issues.push('invalid_max_auto_continue_streak');
  }
  if (
    record.maxAutoContinueTotal != null
    && (
      typeof record.maxAutoContinueTotal !== 'number'
      || !Number.isFinite(record.maxAutoContinueTotal)
      || Math.floor(record.maxAutoContinueTotal) < 0
    )
  ) {
    issues.push('invalid_max_auto_continue_total');
  }

  if (mode === SUPERVISION_MODE.SUPERVISED_AUDIT) {
    if (record.auditMode != null && record.auditMode !== '' && !isSupportedSupervisionAuditMode(String(record.auditMode))) {
      issues.push('invalid_audit_mode');
    }
    if (
      record.maxAuditLoops != null
      && (typeof record.maxAuditLoops !== 'number' || !Number.isFinite(record.maxAuditLoops) || Math.floor(record.maxAuditLoops) < 1)
    ) {
      issues.push('invalid_max_audit_loops');
    }
    if (record.taskRunPromptVersion != null && !trimString(record.taskRunPromptVersion)) {
      issues.push('invalid_task_run_prompt_version');
    }
  }

  return issues;
}

export function normalizeSessionSupervisionSnapshot(
  input: Partial<SessionSupervisionSnapshot> | null | undefined,
  fallback?: Partial<SessionSupervisionSnapshot> | null,
): SessionSupervisionSnapshot {
  const merged = {
    ...(fallback ?? {}),
    ...(input ?? {}),
  } as Partial<SessionSupervisionSnapshot>;

  const supervisorDefaults = normalizeSupervisorDefaultConfig(merged, fallback);
  const mode = normalizeSupervisionMode(merged.mode, SUPERVISION_MODE.OFF);
  const customInstructions = trimString(merged.customInstructions);
  const customInstructionsOverride = typeof merged.customInstructionsOverride === 'boolean'
    ? merged.customInstructionsOverride
    : false;
  const globalCustomInstructions = trimString(merged.globalCustomInstructions);
  const maxParseRetries = normalizePositiveInteger(merged.maxParseRetries, SUPERVISION_DEFAULT_MAX_PARSE_RETRIES, 1);
  const maxAutoContinueStreak = normalizeNonNegativeInteger(merged.maxAutoContinueStreak, SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_STREAK);
  const maxAutoContinueTotal = normalizeNonNegativeInteger(merged.maxAutoContinueTotal, SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_TOTAL);
  const auditMode = isSupportedSupervisionAuditMode(merged.auditMode) ? merged.auditMode : SUPERVISION_DEFAULT_AUDIT_MODE;
  const maxAuditLoops = normalizePositiveInteger(merged.maxAuditLoops, SUPERVISION_DEFAULT_MAX_AUDIT_LOOPS, 1);
  return {
    ...supervisorDefaults,
    mode,
    ...(customInstructions ? { customInstructions } : {}),
    // Only emit the override flag when true, to keep payloads minimal for the
    // default (unchecked = concat) case. Normalizer defaults missing to false.
    ...(customInstructionsOverride ? { customInstructionsOverride: true } : {}),
    ...(globalCustomInstructions ? { globalCustomInstructions } : {}),
    maxParseRetries,
    maxAutoContinueStreak,
    maxAutoContinueTotal,
    auditMode,
    maxAuditLoops,
    taskRunPromptVersion: trimString(merged.taskRunPromptVersion) ?? SUPERVISION_DEFAULT_TASK_RUN_PROMPT_VERSION,
  };
}

export function parseSessionSupervisionSnapshot(value: unknown): SessionSupervisionSnapshot | null {
  if (getSessionSupervisionSnapshotIssues(value).length > 0) return null;
  return normalizeSessionSupervisionSnapshot(value as Partial<SessionSupervisionSnapshot>);
}

export function extractSessionSupervisionSnapshot(
  transportConfig: Record<string, unknown> | null | undefined,
): SessionSupervisionSnapshot | null {
  if (!transportConfig || typeof transportConfig !== 'object' || Array.isArray(transportConfig)) return null;
  return parseSessionSupervisionSnapshot(transportConfig[SUPERVISION_TRANSPORT_CONFIG_KEY]);
}

export function embedSessionSupervisionSnapshot(
  transportConfig: Record<string, unknown> | null | undefined,
  snapshot: Partial<SessionSupervisionSnapshot> | null | undefined,
): Record<string, unknown> {
  const normalized = normalizeSessionSupervisionSnapshot(snapshot);
  return {
    ...(transportConfig ?? {}),
    [SUPERVISION_TRANSPORT_CONFIG_KEY]: normalized,
  };
}

export function readSupervisionSnapshotFromTransportConfig(
  transportConfig: Record<string, unknown> | null | undefined,
): SessionSupervisionSnapshot {
  return extractSessionSupervisionSnapshot(transportConfig)
    ?? normalizeSessionSupervisionSnapshot({ mode: SUPERVISION_MODE.OFF });
}

export function hasInvalidSessionSupervisionSnapshot(
  transportConfig: Record<string, unknown> | null | undefined,
): boolean {
  if (!transportConfig || typeof transportConfig !== 'object' || Array.isArray(transportConfig)) return false;
  if (!(SUPERVISION_TRANSPORT_CONFIG_KEY in transportConfig)) return false;
  return parseSessionSupervisionSnapshot(transportConfig[SUPERVISION_TRANSPORT_CONFIG_KEY]) == null;
}

export function buildTransportConfigWithSupervision(
  transportConfig: Record<string, unknown> | null | undefined,
  snapshot: Partial<SessionSupervisionSnapshot> | null | undefined,
): Record<string, unknown> | null {
  const normalized = normalizeSessionSupervisionSnapshot(snapshot);
  if (normalized.mode === SUPERVISION_MODE.OFF) {
    if (!transportConfig) return null;
    const next = { ...transportConfig };
    delete next[SUPERVISION_TRANSPORT_CONFIG_KEY];
    return Object.keys(next).length > 0 ? next : null;
  }
  return embedSessionSupervisionSnapshot(transportConfig, normalized);
}

/**
 * Merge an incoming `transportConfig` payload over an existing one without
 * silently wiping a locally-set supervision snapshot.
 *
 * Symmetric to the daemon's `mergeWorkerSessionSnapshot`: the server/daemon
 * session_list broadcasts that fire _between_ the user's PATCH and the daemon
 * authoritatively processing it can arrive with a `transportConfig` that lacks
 * the supervision key (server default `{}`, unrelated hydrator updates, etc.).
 * A naive `incoming ?? existing` merge would let those stale payloads flash
 * the Auto dropdown back to `off`. Instead, when the incoming payload does
 * not carry its own `supervision` key we preserve the one we already had.
 *
 * - `incoming == null` → keep existing (broadcast omitted transportConfig entirely).
 * - `incoming` carries its own supervision key → authoritative, use as-is
 *   (this is how explicit off / mode changes land).
 * - `incoming` lacks supervision but existing has one → overlay existing
 *   supervision on top of incoming keys.
 */
export function mergeTransportConfigPreservingSupervision(
  incoming: Record<string, unknown> | null | undefined,
  existing: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (incoming == null) return existing ?? null;
  if (!isPlainObject(incoming)) return existing ?? null;
  if (SUPERVISION_TRANSPORT_CONFIG_KEY in incoming) {
    return incoming;
  }
  if (isPlainObject(existing) && SUPERVISION_TRANSPORT_CONFIG_KEY in existing) {
    return {
      ...incoming,
      [SUPERVISION_TRANSPORT_CONFIG_KEY]: existing[SUPERVISION_TRANSPORT_CONFIG_KEY],
    };
  }
  return incoming;
}

export function getSupportedSupervisionBackendOptions(): readonly SharedContextRuntimeBackend[] {
  return SUPERVISION_SUPPORTED_BACKENDS;
}

export function getSupervisionModelOptions(backend: SharedContextRuntimeBackend): readonly string[] {
  switch (backend) {
    case 'claude-code-sdk':
      return CLAUDE_CODE_MODEL_IDS;
    case 'codex-sdk':
      return CODEX_MODEL_IDS;
    case 'qwen':
      return QWEN_MODEL_IDS;
    case 'openclaw':
      return [];
  }
}

export function resolveSupervisionModelForBackend(
  nextBackend: SharedContextRuntimeBackend,
  currentModel: string,
  previousBackend?: SharedContextRuntimeBackend,
): string {
  const trimmed = currentModel.trim();
  if (!trimmed) return getDefaultSharedContextModelForBackend(nextBackend);
  if (previousBackend && trimmed === getDefaultSharedContextModelForBackend(previousBackend)) {
    return getDefaultSharedContextModelForBackend(nextBackend);
  }
  if (nextBackend === 'openclaw') return trimmed;
  if (!isKnownSharedContextModelForBackend(nextBackend, trimmed)) {
    return getDefaultSharedContextModelForBackend(nextBackend);
  }
  return trimmed;
}

export function getAutomationAuditModeOptions(): readonly SupervisionAuditMode[] {
  return SUPERVISION_AUDIT_MODES;
}

export const SUPERVISION_MODES = Object.values(SUPERVISION_MODE) as readonly SupervisionMode[];
export const SUPERVISION_PROMPT_VERSION = SUPERVISION_DEFAULT_PROMPT_VERSION;
export const SUPERVISION_REPAIR_PROMPT_VERSION = SUPERVISION_CONTRACT_IDS.DECISION_REPAIR;
export const TASK_RUN_PROMPT_VERSION = SUPERVISION_DEFAULT_TASK_RUN_PROMPT_VERSION;
export const DEFAULT_SUPERVISION_AUDIT_MODE = SUPERVISION_DEFAULT_AUDIT_MODE;
export const DEFAULT_SUPERVISION_MAX_AUDIT_LOOPS = SUPERVISION_DEFAULT_MAX_AUDIT_LOOPS;
export const DEFAULT_SUPERVISION_MAX_PARSE_RETRIES = SUPERVISION_DEFAULT_MAX_PARSE_RETRIES;
export const DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_STREAK = SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_STREAK;
export const DEFAULT_SUPERVISION_MAX_AUTO_CONTINUE_TOTAL = SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_TOTAL;

export function parseTaskRunTerminalStateDetailsFromText(text: string): ParsedTaskRunTerminalState {
  const matches = [...text.matchAll(/<!--\s*IMCODES_TASK_RUN:\s*(COMPLETE|NEEDS_INPUT|BLOCKED)\s*-->/g)];
  if (matches.length !== 1) return { state: null, markerCount: matches.length };
  const state = matches[0]?.[1];
  switch (state) {
    case 'COMPLETE':
      return { state: 'complete', markerCount: 1 };
    case 'NEEDS_INPUT':
      return { state: 'needs_input', markerCount: 1 };
    case 'BLOCKED':
      return { state: 'blocked', markerCount: 1 };
    default:
      return { state: null, markerCount: matches.length };
  }
}

export function parseTaskRunTerminalStateFromText(text: string): TaskRunTerminalState | null {
  return parseTaskRunTerminalStateDetailsFromText(text).state;
}

export function parseAuditVerdictDetailsFromText(text: string): ParsedAuditVerdict {
  const matches = [...text.matchAll(/<!--\s*P2P_VERDICT:\s*(PASS|REWORK)\s*-->/g)];
  if (matches.length !== 1) return { verdict: null, markerCount: matches.length };
  const verdict = matches[0]?.[1];
  switch (verdict) {
    case 'PASS':
      return { verdict: 'PASS', markerCount: 1 };
    case 'REWORK':
      return { verdict: 'REWORK', markerCount: 1 };
    default:
      return { verdict: null, markerCount: matches.length };
  }
}

export function parseAuditVerdictFromText(text: string): AuditVerdict | null {
  return parseAuditVerdictDetailsFromText(text).verdict;
}

export function getSupportedSupervisionAuditModes(): readonly SupervisionAuditMode[] {
  return SUPERVISION_AUDIT_MODES;
}

export function isSupportedSupervisionSessionType(value: string | null | undefined): boolean {
  return isSupportedSupervisionTargetSessionType(value);
}

export const DEFAULT_SUPERVISION_BACKEND: SharedContextRuntimeBackend = SUPERVISION_SUPPORTED_BACKENDS[0];
export const DEFAULT_SUPERVISION_MODEL_BY_BACKEND: Record<SharedContextRuntimeBackend, string> = DEFAULT_CONTEXT_MODEL_BY_BACKEND;

/**
 * Merge rule for supervision custom instructions. See design.md §2 of
 * openspec/changes/supervision-global-custom-instructions.
 *
 * - override === true           → session only (even if empty), global ignored
 * - session empty (override false) → global
 * - global empty (override false)  → session
 * - both non-empty (override false) → `global + "\n\n" + session`
 *
 * Inputs are trimmed before comparison. Returns the empty string when the
 * resulting block should be omitted entirely.
 */
export function mergeSupervisionCustomInstructions(
  global: string | null | undefined,
  session: string | null | undefined,
  override: boolean | null | undefined,
): string {
  const g = typeof global === 'string' ? global.trim() : '';
  const s = typeof session === 'string' ? session.trim() : '';
  if (override === true) return s;
  if (!s) return g;
  if (!g) return s;
  return `${g}\n\n${s}`;
}

/**
 * Convenience wrapper around `mergeSupervisionCustomInstructions` that pulls
 * all three inputs directly from a session supervision snapshot.
 */
export function resolveEffectiveCustomInstructions(
  snapshot: Partial<SessionSupervisionSnapshot> | null | undefined,
): string {
  if (!snapshot) return '';
  return mergeSupervisionCustomInstructions(
    snapshot.globalCustomInstructions,
    snapshot.customInstructions,
    snapshot.customInstructionsOverride,
  );
}

/** Where the effective custom-instructions block came from. Drives the
 *  human-readable label shown to the supervisor prompt so the user's global
 *  defaults aren't mislabeled as a session-specific override. */
export type SupervisionCustomInstructionsSource = 'global' | 'session' | 'merged' | 'none';

export interface SupervisionCustomInstructionsDetail {
  /** Trimmed, merged text ready to inject into the prompt. Empty when
   *  `source === 'none'`. */
  text: string;
  source: SupervisionCustomInstructionsSource;
}

/**
 * Classify the three custom-instruction inputs into an effective text + a
 * source tag. The tag is what supervision-prompts uses to pick the right
 * label ("Global…" vs "Session-specific…" vs "User supervision instructions
 * (global + per-session override)") so the prompt never misattributes the
 * user's intent. Defaults-only → 'global'. Session-only (either because
 * there is no global, or because override=true) → 'session'. Both present
 * without override → 'merged'. Nothing set → 'none'.
 */
export function classifySupervisionCustomInstructions(
  global: string | null | undefined,
  session: string | null | undefined,
  override: boolean | null | undefined,
): SupervisionCustomInstructionsDetail {
  const g = typeof global === 'string' ? global.trim() : '';
  const s = typeof session === 'string' ? session.trim() : '';
  if (override === true) {
    if (!s) return { text: '', source: 'none' };
    return { text: s, source: 'session' };
  }
  if (!g && !s) return { text: '', source: 'none' };
  if (!g) return { text: s, source: 'session' };
  if (!s) return { text: g, source: 'global' };
  return { text: `${g}\n\n${s}`, source: 'merged' };
}

/** Snapshot-shaped convenience wrapper around classifySupervisionCustomInstructions. */
export function resolveSupervisionCustomInstructionsDetail(
  snapshot: Partial<SessionSupervisionSnapshot> | null | undefined,
): SupervisionCustomInstructionsDetail {
  if (!snapshot) return { text: '', source: 'none' };
  return classifySupervisionCustomInstructions(
    snapshot.globalCustomInstructions,
    snapshot.customInstructions,
    snapshot.customInstructionsOverride,
  );
}
