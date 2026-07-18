import type { SharedContextRuntimeBackend } from './context-types.js';
import { CLAUDE_CODE_MODEL_IDS, CODEX_MODEL_IDS } from '../src/shared/models/options.js';
import { QWEN_MODEL_IDS } from './qwen-models.js';
import {
  DEFAULT_CONTEXT_MODEL_BY_BACKEND,
  SHARED_CONTEXT_RUNTIME_BACKENDS,
  getDefaultSharedContextModelForBackend,
  inferSharedContextRuntimeBackend,
  isKnownSharedContextModelForBackend,
  normalizeSharedContextPresetValue,
  normalizeSharedContextRuntimeBackend,
} from './shared-context-runtime-config.js';
import { PROCESS_SESSION_AGENT_TYPES, TRANSPORT_SESSION_AGENT_TYPES } from './agent-types.js';
import { PROVIDER_STATUS_REASON } from './provider-status-reasons.js';
import {
  PEER_AUDIT_PROMPT_VERSION,
  isPeerAuditOpaqueId,
  peerAuditByteLength,
  type PeerAuditTargetFingerprint,
} from './peer-audit.js';
import { isValidImcodesSessionName } from './session-scope.js';

export const SUPERVISION_CONTRACT_IDS = {
  DECISION: 'supervision_decision_v1',
  DECISION_REPAIR: 'supervision_decision_repair_v1',
  CONTINUE: 'supervision_continue_v1',
  TASK_RUN_STATUS: 'task_run_status_v1',
  OPENSPEC_IMPLEMENTATION_AUDIT: 'openspec_implementation_audit_v1',
  CONTEXTUAL_AUDIT: 'contextual_audit_v1',
  REWORK_BRIEF: 'rework_brief_v1',
  AUDIT_TARGET_RECOVERY: 'supervision_audit_target_recovery_v1',
} as const;

export const SUPERVISION_AUDIT_TARGET_RECOVERY_AUTOMATION_KIND = 'supervision-audit-target-recovery' as const;

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

// Supervision keeps accepting historical two-step audit modes even when they are
// no longer promoted as default Team/P2P combo presets.
export const SUPERVISION_AUDIT_MODES = SUPERVISION_AUDIT_MODE_ALLOWLIST;

// Default supervisor timeout aligns with design.md §5 (12_000 ms). Queue wait time
// counts against the same budget, so this must stay conservative.
export const SUPERVISION_DEFAULT_TIMEOUT_MS = 12_000;
export const SUPERVISION_DEFAULT_MAX_PARSE_RETRIES = 1;
export const SUPERVISION_DEFAULT_AUDIT_MODE: SupervisionAuditMode = 'audit';
export const SUPERVISION_DEFAULT_MAX_AUDIT_LOOPS = 2;
export const SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_STREAK = 2;
export const SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_TOTAL = 0;
export const SUPERVISION_DEFAULT_PROMPT_VERSION = SUPERVISION_CONTRACT_IDS.DECISION;
export const SUPERVISION_DEFAULT_TASK_RUN_PROMPT_VERSION = SUPERVISION_CONTRACT_IDS.TASK_RUN_STATUS;

// Reasons surfaced when the supervision layer cannot produce a structured model
// decision (provider, snapshot, or queue failure). Kept distinct from model-issued
// ask_human verdicts so UI/UX can present a "repair required" path.
export const SUPERVISION_UNAVAILABLE_REASONS = {
  PROVIDER_NOT_CONNECTED: PROVIDER_STATUS_REASON.PROVIDER_NOT_CONNECTED,
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

export type SupervisionMode = typeof SUPERVISION_MODE[keyof typeof SUPERVISION_MODE];
export type SupervisionAuditMode = 'audit' | 'review' | 'audit>plan' | 'review>plan' | 'audit>review>plan';
export type TaskRunStatusMarker = keyof typeof TASK_RUN_STATUS_MARKERS;
export type TaskRunTerminalState = 'complete' | 'needs_input' | 'blocked';
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
  | 'invalid_task_run_prompt_version'
  | 'legacy_audit_mode_requires_repair'
  | 'missing_audit_target'
  | 'invalid_audit_target_name'
  | 'missing_audit_target_fingerprint'
  | 'invalid_audit_target_fingerprint'
  | 'invalid_peer_audit_prompt_version';
export interface ParsedTaskRunTerminalState {
  state: TaskRunTerminalState | null;
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
   * `doesSharedContextBackendSupportPresets()` (`qwen` or `claude-code-sdk`). When
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
  /** @deprecated Read-only compatibility field. New normalized writes omit it. */
  auditMode?: SupervisionAuditMode;
  /** Exact remembered auditor session name, scoped to this audited session. */
  auditTargetSessionName?: string;
  /** Confirmation fingerprint. Name-only legacy targets are never fast-path eligible. */
  auditTargetFingerprint?: PeerAuditTargetFingerprint;
  /** Present only with a canonical target + fingerprint. */
  peerAuditPromptVersion?: typeof PEER_AUDIT_PROMPT_VERSION;
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

function isCanonicalPeerAuditDimension(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return false;
  if (peerAuditByteLength(value) > 256) return false;
  return !/[\u0000-\u001f\u007f]/.test(value);
}

export function isCanonicalPeerAuditTargetFingerprint(value: unknown): value is PeerAuditTargetFingerprint {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.every((key) => ['sessionInstanceId', 'normalizedModelId', 'providerFamily'].includes(key))) {
    return false;
  }
  return isPeerAuditOpaqueId(value.sessionInstanceId)
    && isCanonicalPeerAuditDimension(value.normalizedModelId)
    && isCanonicalPeerAuditDimension(value.providerFamily);
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
  // (qwen or claude-code-sdk). Reuse the shared runtime normalizer so supervision
  // preserves the exact same trim/gating semantics as shared context config.
  const preset = normalizeSharedContextPresetValue(normalizedBackend, typeof merged.preset === 'string' ? merged.preset : undefined);
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

  const issues: SessionSupervisionSnapshotIssue[] = [];
  const rawTargetName = record.auditTargetSessionName;
  const targetName = trimString(rawTargetName);
  const hasTargetName = rawTargetName != null;
  const hasFingerprint = record.auditTargetFingerprint != null;
  const validTargetName = !!targetName && targetName === rawTargetName && isValidImcodesSessionName(targetName);
  const validFingerprint = isCanonicalPeerAuditTargetFingerprint(record.auditTargetFingerprint);

  if (hasTargetName && !validTargetName) issues.push('invalid_audit_target_name');
  if (hasFingerprint && !validFingerprint) issues.push('invalid_audit_target_fingerprint');
  if (hasTargetName && validTargetName && !hasFingerprint) issues.push('missing_audit_target_fingerprint');
  if (!hasTargetName && hasFingerprint) issues.push('missing_audit_target');
  if (
    record.peerAuditPromptVersion != null
    && record.peerAuditPromptVersion !== PEER_AUDIT_PROMPT_VERSION
  ) {
    issues.push('invalid_peer_audit_prompt_version');
  }
  if (record.peerAuditPromptVersion != null && (!validTargetName || !validFingerprint)) {
    if (!issues.includes('invalid_peer_audit_prompt_version')) issues.push('invalid_peer_audit_prompt_version');
  }

  // `off` remains a valid persisted state because Quick audit may remember a
  // peer while automatic supervision is disabled. Only target-shape issues are
  // relevant in that mode; supervisor broker fields are intentionally ignored.
  if (mode === SUPERVISION_MODE.OFF) return issues;

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
    if (record.auditMode != null) {
      if (record.auditMode !== '' && !isSupportedSupervisionAuditMode(String(record.auditMode))) issues.push('invalid_audit_mode');
      else issues.push('legacy_audit_mode_requires_repair');
    }
    if (!hasTargetName) issues.push('missing_audit_target');
    else if (validTargetName && !hasFingerprint && !issues.includes('missing_audit_target_fingerprint')) {
      issues.push('missing_audit_target_fingerprint');
    }
    if (validTargetName && validFingerprint && record.peerAuditPromptVersion !== PEER_AUDIT_PROMPT_VERSION) {
      issues.push('invalid_peer_audit_prompt_version');
    }
    if (
      record.maxAuditLoops != null
      && (typeof record.maxAuditLoops !== 'number' || !Number.isFinite(record.maxAuditLoops) || Math.floor(record.maxAuditLoops) < 0)
    ) {
      issues.push('invalid_max_audit_loops');
    }
    if (record.taskRunPromptVersion != null && !trimString(record.taskRunPromptVersion)) {
      issues.push('invalid_task_run_prompt_version');
    }
  }

  return [...new Set(issues)];
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
  const maxAuditLoops = normalizeNonNegativeInteger(merged.maxAuditLoops, SUPERVISION_DEFAULT_MAX_AUDIT_LOOPS);
  const auditTargetSessionName = trimString(merged.auditTargetSessionName);
  const auditTargetFingerprint = isCanonicalPeerAuditTargetFingerprint(merged.auditTargetFingerprint)
    ? merged.auditTargetFingerprint
    : undefined;
  const hasCanonicalAuditTarget = !!auditTargetSessionName
    && isValidImcodesSessionName(auditTargetSessionName)
    && !!auditTargetFingerprint;
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
    ...(hasCanonicalAuditTarget ? {
      auditTargetSessionName,
      auditTargetFingerprint,
      peerAuditPromptVersion: PEER_AUDIT_PROMPT_VERSION,
    } : {}),
    maxAuditLoops,
    taskRunPromptVersion: trimString(merged.taskRunPromptVersion) ?? SUPERVISION_DEFAULT_TASK_RUN_PROMPT_VERSION,
  };
}

export function parseSessionSupervisionSnapshot(value: unknown): SessionSupervisionSnapshot | null {
  const issues = getSessionSupervisionSnapshotIssues(value);
  const repairOnly = new Set<SessionSupervisionSnapshotIssue>([
    'legacy_audit_mode_requires_repair',
    'invalid_audit_mode',
    'missing_audit_target',
    'invalid_audit_target_name',
    'missing_audit_target_fingerprint',
    'invalid_audit_target_fingerprint',
    'invalid_peer_audit_prompt_version',
  ]);
  if (issues.some((issue) => !repairOnly.has(issue))) return null;
  const record = value as Partial<SessionSupervisionSnapshot>;
  const normalized = normalizeSessionSupervisionSnapshot(record);
  // Legacy read compatibility is deliberately separate from the new-write
  // normalizer: a name-only target/auditMode can be shown for repair, but an
  // embed/save immediately drops them until a confirmed fingerprint exists.
  const legacyTargetName = trimString(record.auditTargetSessionName);
  return {
    ...normalized,
    ...(legacyTargetName && isValidImcodesSessionName(legacyTargetName) && !normalized.auditTargetSessionName
      ? { auditTargetSessionName: legacyTargetName }
      : {}),
    ...(isSupportedSupervisionAuditMode(record.auditMode) ? { auditMode: record.auditMode } : {}),
  };
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
  return getSessionSupervisionSnapshotIssues(transportConfig[SUPERVISION_TRANSPORT_CONFIG_KEY]).length > 0;
}

/** Stable repair issues used by daemon/Web to keep legacy data readable while
 * refusing automatic or remembered-fast-path dispatch. */
export function getPeerAuditSnapshotRepairIssues(
  value: unknown,
): SessionSupervisionSnapshotIssue[] {
  const peerIssues = new Set<SessionSupervisionSnapshotIssue>([
    'legacy_audit_mode_requires_repair',
    'invalid_audit_mode',
    'missing_audit_target',
    'invalid_audit_target_name',
    'missing_audit_target_fingerprint',
    'invalid_audit_target_fingerprint',
    'invalid_peer_audit_prompt_version',
  ]);
  return getSessionSupervisionSnapshotIssues(value).filter((issue) => peerIssues.has(issue));
}

export function buildTransportConfigWithSupervision(
  transportConfig: Record<string, unknown> | null | undefined,
  snapshot: Partial<SessionSupervisionSnapshot> | null | undefined,
): Record<string, unknown> | null {
  const normalized = normalizeSessionSupervisionSnapshot(snapshot);
  if (normalized.mode === SUPERVISION_MODE.OFF && !normalized.auditTargetSessionName) {
    if (!transportConfig) return null;
    const next = { ...transportConfig };
    delete next[SUPERVISION_TRANSPORT_CONFIG_KEY];
    return Object.keys(next).length > 0 ? next : null;
  }
  return embedSessionSupervisionSnapshot(transportConfig, normalized);
}

/**
 * Apply the peer-audit target as a field-level patch over the latest persisted
 * supervision snapshot. Callers must pass the current transport config read at
 * the CAS boundary; stale UI/command snapshots are deliberately not accepted
 * here. All non-target supervision fields and unrelated transport keys survive
 * byte-for-byte through the merge.
 */
export function patchPeerAuditTargetInTransportConfig(
  transportConfig: Record<string, unknown> | null | undefined,
  target: {
    auditTargetSessionName: string;
    auditTargetFingerprint: PeerAuditTargetFingerprint;
  },
): Record<string, unknown> {
  const latest = readSupervisionSnapshotFromTransportConfig(transportConfig);
  return embedSessionSupervisionSnapshot(transportConfig, {
    ...latest,
    auditTargetSessionName: target.auditTargetSessionName,
    auditTargetFingerprint: target.auditTargetFingerprint,
    peerAuditPromptVersion: PEER_AUDIT_PROMPT_VERSION,
  });
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
