import type { SharedContextRuntimeBackend } from './context-types.js';
import { CLAUDE_CODE_MODEL_IDS, CODEX_MODEL_IDS } from '../src/shared/models/options.js';
import { QWEN_MODEL_IDS } from './qwen-models.js';
import {
  DEFAULT_CONTEXT_MODEL_BY_BACKEND,
  DEFAULT_PRIMARY_CONTEXT_BACKEND,
  SHARED_CONTEXT_RUNTIME_BACKENDS,
  getDefaultSharedContextModelForBackend,
  inferSharedContextRuntimeBackend,
  isKnownSharedContextModelForBackend,
  normalizeSharedContextPresetValue,
  normalizeOptionalSharedContextRuntimeSelection,
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
import {
  migrateLegacySupervisionExecutionPools,
  type SupervisionEconomyTaskPolicy,
  type SupervisionExecutionConfig,
  type SupervisionExecutionPoolKind,
  type SupervisionExecutionPoolsConfig,
} from './supervision-execution-pool.js';

export const SUPERVISION_CONTRACT_IDS = {
  DECISION: 'supervision_decision_v1',
  DECISION_REPAIR: 'supervision_decision_repair_v1',
  CONTINUE: 'supervision_continue_v1',
  TASK_RUN_STATUS: 'task_run_status_v1',
  OPENSPEC_IMPLEMENTATION_AUDIT: 'openspec_implementation_audit_v1',
  CONTEXTUAL_AUDIT: 'contextual_audit_v1',
  REWORK_BRIEF: 'rework_brief_v1',
  WAITING_HEARTBEAT: 'supervision_waiting_heartbeat_v1',
  AUDIT_HEARTBEAT: 'supervision_audit_heartbeat_v1',
  AUDIT_TARGET_RECOVERY: 'supervision_audit_target_recovery_v1',
  AUDIT_MARKER_CORRECTION: 'supervision_audit_marker_correction_v1',
  ORCHESTRATOR_CONTEXT: 'supervision_orchestrator_context_v1',
  TASK_FINALIZATION: 'supervision_task_finalization_v1',
  DELEGATION_ELIGIBILITY: 'supervision_delegation_eligibility_v1',
  TASK_REGISTRY: 'supervision_task_registry_v1',
} as const;

export const SUPERVISION_AUDIT_TARGET_RECOVERY_AUTOMATION_KIND = 'supervision-audit-target-recovery' as const;
export const SUPERVISION_AUDIT_MARKER_CORRECTION_AUTOMATION_KIND = 'supervision-audit-marker-correction' as const;
export const SUPERVISION_WAITING_HEARTBEAT_AUTOMATION_KIND = 'supervision-waiting-heartbeat' as const;
export const SUPERVISION_AUDIT_HEARTBEAT_AUTOMATION_KIND = 'supervision-audit-heartbeat' as const;

export const SUPERVISION_TRUSTED_EXECUTION_CONTRACT_IDS = [
  SUPERVISION_CONTRACT_IDS.ORCHESTRATOR_CONTEXT,
  SUPERVISION_CONTRACT_IDS.TASK_FINALIZATION,
  SUPERVISION_CONTRACT_IDS.DELEGATION_ELIGIBILITY,
  SUPERVISION_CONTRACT_IDS.TASK_REGISTRY,
] as const;

/**
 * How the standing supervision contracts reach the model.
 *
 * `reinjectEveryEntrypoint` means every entrypoint RE-ASSERTS the contracts in
 * force -- not that every entrypoint restates them verbatim. Prompts that run
 * once per task (preambles, decision) carry the full text; the per-turn prompts
 * (continue, rework brief) re-assert them by id via
 * buildSupervisionContractsInForceLine(), because ~6.5KB of fixed prose on every
 * continuation turn crowds out the task context the contracts exist to protect.
 * SUPERVISION_PROMPT_ENTRYPOINTS records which form each prompt uses, and that
 * record is enforced by test rather than trusted.
 */
export const SUPERVISION_TRUSTED_CONTRACT_DELIVERY = {
  preferredRoles: ['system', 'developer'],
  fallback: 'fixed_daemon_prefix',
  reinjectEveryEntrypoint: true,
  modelTextIsNonAuthoritative: true,
  hardGateAuthority: ['delegation_eligibility', 'audit_reply_capability', 'matching_pass', 'stage_manifest_exact_set'],
} as const;

/**
 * User authority over supervision contracts.
 *
 * Agent/model text stays non-authoritative (see
 * SUPERVISION_TRUSTED_CONTRACT_DELIVERY.modelTextIsNonAuthoritative). A directive
 * from the HUMAN user is different: it is absolute and may override any contract
 * clause or gate, including the pre-matching-PASS stage/commit/push prohibition.
 *
 * The override is deliberately PER-ACTION, not a sticky session mode: contracts
 * keep driving automated work by default, and the user opts out one action at a
 * time so a forgotten switch cannot silently disarm every later change.
 */
export const SUPERVISION_USER_OVERRIDE = {
  authority: 'absolute',
  granularity: 'per_action',
  /** Must be an explicit user directive; never inferred from ambiguity or silence. */
  requiresExplicitUserDirective: true,
  /** Never persists past the single action it authorised. */
  sticky: false,
  /** Every gate below may be waived by an explicit user directive. */
  overridableGates: [
    'delegation_eligibility',
    'audit_reply_capability',
    'matching_pass',
    'stage_manifest_exact_set',
    'pre_pass_stage_commit_push',
  ],
  /** Recorded for attribution; the user owns the outcome of an overridden action. */
  mustRecord: ['who', 'what', 'when', 'gateWaived', 'userDirectiveText'],
} as const;

/**
 * Proportionality: the contract must exercise its own judgement instead of
 * applying one ceremony to every change. Auditing a comment typo with the same
 * loop as a native ABI change is waste, not rigour.
 *
 * A change qualifies as trivial ONLY if it satisfies EVERY condition in
 * `trivialRequiresAll` and matches NONE of `neverTrivial`. Anything unmatched or
 * uncertain falls back to the full gated path — the tier is a narrow, checkable
 * exemption, not a judgement call an agent may argue itself into.
 */
export const SUPERVISION_CHANGE_PROPORTIONALITY = {
  tiers: ['trivial', 'standard', 'gated'],
  trivialRequiresAll: [
    'no_production_byte_change',
    'single_owner_no_shared_files',
    'no_manifest_bound_landing_row',
    'reversible_by_single_revert',
  ],
  /** Any match forces the full gated path regardless of size. */
  neverTrivial: [
    'native_abi_or_build_graph',
    'security_auth_permission_or_credential',
    'cross_owner_or_cross_platform_surface',
    'public_contract_schema_or_protocol',
    'release_packaging_or_signing',
  ],
  /**
   * Documentation-shaped work skips the audit loop even under automation. A
   * comment, README, changelog or translated string cannot change behaviour, so
   * auditing it spends review budget that a real behaviour change then does not
   * get. This is the "is it worth auditing" judgement, made explicit rather than
   * left to whoever is impatient that day.
   */
  docOnlySkipsAuditEvenWhenSupervised: true,
  docOnlyShapes: [
    'markdown_or_text_only',
    'code_comment_only',
    'changelog_or_release_notes',
    'translation_string_only',
    'no_executable_line_changed',
  ],
  /**
   * The hard floor: anything that changes what the software DOES is audited, at
   * any size. A one-line behaviour change is exactly the kind that slips through,
   * and "it was only one line" is not evidence of safety.
   */
  functionalChangeAlwaysAudited: true,
  /** Trivial tier skips the matching cross-vendor audit loop. */
  trivialSkipsMatchingAudit: true,
  /** It never skips these: correctness still has to be demonstrated. */
  trivialStillRequires: ['typecheck', 'affected_tests', 'attribution_record'],
} as const;

/**
 * Where the hard gates actually bind.
 *
 * Under supervision (automated multi-agent development) the gates are machine
 * enforcement: nothing else is watching, so pre-PASS stage/commit/push stays
 * blocked. With supervision off a human is driving and owns the outcome, so the
 * same rules are ADVICE: surface the risk once, then do what the user asked.
 * A gate that blocks an operator working by hand is not quality control, it is
 * an obstacle wearing its badge.
 */
export const SUPERVISION_GATE_ENFORCEMENT = {
  bindingModes: ['supervised', 'supervised_audit'],
  advisoryModes: ['off'],
  /** In advisory mode: warn once, do not refuse, then proceed. */
  advisoryBehaviour: 'warn_once_then_proceed',
  /**
   * Logged automatically. The daemon already knows the caller from the runtime
   * session, so NEVER ask the user to state who they are or to justify a waiver:
   * that is friction billed to the user for information the system already has.
   */
  recordedAutomatically: ['gate', 'waivedAt'],
  identityFromRuntimeCaller: true,
  neverPromptUserForWaiverDetails: true,
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
export const SUPERVISION_SUPPORTED_UI_LOCALES = ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko'] as const;
export type SupervisionUiLocale = typeof SUPERVISION_SUPPORTED_UI_LOCALES[number];
export const DEFAULT_SUPERVISION_BACKEND: SharedContextRuntimeBackend = DEFAULT_PRIMARY_CONTEXT_BACKEND;

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

// Supervisor decisions include queueing, provider startup, bounded provider
// retries, and structured-output repair in one shared budget. Keep both the
// default and the normalized minimum at 30 seconds so a transient startup does
// not consume nearly the whole decision window.
export const SUPERVISION_MIN_TIMEOUT_MS = 30_000;
export const SUPERVISION_DEFAULT_TIMEOUT_MS = SUPERVISION_MIN_TIMEOUT_MS;
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

export const SUPERVISION_ORCHESTRATOR_STATUS_STATES = [
  'planned',
  'delegated',
  'implementing',
  'retrying_external_ci',
  'validated',
  'auditing',
  'rework',
  'passed',
  'ready_for_integration',
  'integrating',
  'final_audit',
  'committed',
  'pushed',
  'recovered',
  'finalized',
  'limited',
  'blocker',
] as const;
export type SupervisionOrchestratorStatusState = typeof SUPERVISION_ORCHESTRATOR_STATUS_STATES[number];

/**
 * The ONE authoritative task lifecycle enum.
 *
 * Everything status-shaped derives from this array: registry columns, MCP
 * schemas, prompts and the transition table. `file_event` and `scope_violation`
 * are deliberately absent -- they are append-only EVENT types
 * (see SUPERVISION_TASK_REGISTRY_EVENT_TYPES) and a task may never hold either
 * as a status. Adding a member (`checkpointed`, `re_audit_required`, ...) is an
 * explicit contract-version migration, never an ad-hoc text edit.
 *
 * The readable string IS the stable, versioned status id. UI labels and
 * localization are separate mutable display data and must never be persisted
 * or compared in place of these ids.
 */
export const SUPERVISION_TASK_LIFECYCLE_STATUSES = [
  'planned',
  'delegated',
  'implementing',
  'retrying_external_ci',
  'validated',
  'ready_for_audit',
  'auditing',
  'rework',
  'passed',
  'ready_for_integration',
  'integrating',
  'final_audit',
  'finalizing',
  'committed',
  'pushed',
  'recovered',
  'finalized',
  'blocked',
  'cancelled',
] as const;
export type SupervisionTaskLifecycleStatus = typeof SUPERVISION_TASK_LIFECYCLE_STATUSES[number];

/**
 * @deprecated Historical name. Identical to SUPERVISION_TASK_LIFECYCLE_STATUSES
 * by construction, so the two can no longer drift.
 */
export const SUPERVISION_TASK_FINALIZATION_STATES = SUPERVISION_TASK_LIFECYCLE_STATUSES;
export type SupervisionTaskFinalizationState = SupervisionTaskLifecycleStatus;

/** Bump only alongside a schema migration that maps every prior status forward. */
export const SUPERVISION_TASK_STATUS_CONTRACT_VERSION = 1;

export const SUPERVISION_TASK_FINALIZATION_FIELDS = [
  'taskId', 'topLevelTaskId', 'acceptance', 'integrationBoundary', 'sliceId', 'ownerSession',
  'integrationOwnerSession', 'revision', 'state', 'ownedFiles', 'dependencies', 'sharedFiles',
  'overlappingFiles', 'integrationTaskId', 'integrationManifest', 'auditAttemptId', 'auditRevision',
  'verdict', 'overallAuditAttemptId', 'overallAuditRevision', 'commitSha', 'pushResult',
  'pushRemoteRef', 'stagedPaths', 'conflictedPaths', 'untrackedOtherOwnerPaths',
] as const;
export type SupervisionTaskFinalizationField = typeof SUPERVISION_TASK_FINALIZATION_FIELDS[number];

export const SUPERVISION_TASK_FINALIZATION_FORBIDDEN_GIT_ADD = ['git add .', 'git add -A'] as const;
export const SUPERVISION_TASK_FINALIZATION_FORBIDDEN_STAGE_PREFIXES = ['openspec/', 'docs/'] as const;

export const SUPERVISION_TASK_FINALIZATION_CONTRACT = {
  contractId: SUPERVISION_CONTRACT_IDS.TASK_FINALIZATION,
  states: SUPERVISION_TASK_FINALIZATION_STATES,
  fields: SUPERVISION_TASK_FINALIZATION_FIELDS,
  forbiddenGitAdd: SUPERVISION_TASK_FINALIZATION_FORBIDDEN_GIT_ADD,
  forbiddenStagePrefixes: SUPERVISION_TASK_FINALIZATION_FORBIDDEN_STAGE_PREFIXES,
} as const;

export interface SupervisionTaskFinalizationRecord {
  taskId?: string | null;
  topLevelTaskId?: string | null;
  acceptance?: readonly string[] | null;
  integrationBoundary?: string | null;
  sliceId?: string | null;
  ownerSession?: string | null;
  integrationOwnerSession?: string | null;
  revision?: string | number | null;
  state?: SupervisionTaskFinalizationState | null;
  ownedFiles?: readonly string[] | null;
  dependencies?: readonly string[] | null;
  sharedFiles?: readonly string[] | null;
  overlappingFiles?: readonly string[] | null;
  integrationTaskId?: string | null;
  integrationManifest?: readonly SupervisionTaskFinalizationRecord[] | null;
  auditAttemptId?: string | null;
  auditRevision?: string | number | null;
  verdict?: 'PASS' | 'REWORK' | string | null;
  overallAuditAttemptId?: string | null;
  overallAuditRevision?: string | number | null;
  commitSha?: string | null;
  pushResult?: string | null;
  pushRemoteRef?: string | null;
  stagedPaths?: readonly string[] | null;
  conflictedPaths?: readonly string[] | null;
  untrackedOtherOwnerPaths?: readonly string[] | null;
}

export interface SupervisionTaskFinalizationReleaseInput {
  attemptId: string;
  revision: string | number;
  verdict: 'PASS' | 'REWORK' | string;
  globalGateBlocked?: boolean;
  pathspecs?: readonly string[] | null;
  stagedPaths?: readonly string[] | null;
  conflictedPaths?: readonly string[] | null;
  untrackedOtherOwnerPaths?: readonly string[] | null;
}

export type SupervisionStageManifestIssue =
  | 'invalid_pathspec'
  | 'missing_manifest'
  | 'missing_staged_paths'
  | 'staged_extra'
  | 'staged_missing'
  | 'owned_files_mismatch'
  | 'shared_file_without_integration_owner'
  | 'staged_conflict'
  | 'untracked_other_owner';

export interface SupervisionStageManifestValidationInput {
  pathspecs?: readonly string[] | null;
  stagedPaths?: readonly string[] | null;
  integrationManifest?: readonly SupervisionTaskFinalizationRecord[] | null;
  ownedFiles?: readonly string[] | null;
  conflictedPaths?: readonly string[] | null;
  untrackedOtherOwnerPaths?: readonly string[] | null;
}

function normalizeSupervisionPathSet(paths: readonly string[] | null | undefined): string[] {
  return [...new Set((paths ?? [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))]
    .sort();
}

function supervisionPathspecContains(pathspec: string, file: string): boolean {
  const trimmed = pathspec.trim();
  if (!trimmed) return false;
  if (trimmed.endsWith('/')) return file.startsWith(trimmed);
  return file === trimmed;
}

function sameSupervisionPathSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function isValidSupervisionOwnedPathspecs(paths: readonly string[] | null | undefined): boolean {
  if (!paths || paths.length === 0) return false;
  return paths.every((pathspec) => {
    if (typeof pathspec !== 'string') return false;
    const trimmed = pathspec.trim();
    if (!trimmed || trimmed === '.' || trimmed === '-A') return false;
    if ((SUPERVISION_TASK_FINALIZATION_FORBIDDEN_GIT_ADD as readonly string[]).includes(`git add ${trimmed}`)) return false;
    return !(SUPERVISION_TASK_FINALIZATION_FORBIDDEN_STAGE_PREFIXES as readonly string[])
      .some((prefix) => trimmed === prefix.slice(0, -1) || trimmed.startsWith(prefix));
  });
}

export function validateSupervisionStageManifest(
  input: SupervisionStageManifestValidationInput,
): { ok: true } | { ok: false; issue: SupervisionStageManifestIssue; path?: string } {
  if (!isValidSupervisionOwnedPathspecs(input.pathspecs)) return { ok: false, issue: 'invalid_pathspec' };
  const pathspecSet = normalizeSupervisionPathSet(input.pathspecs);
  const conflicted = normalizeSupervisionPathSet(input.conflictedPaths);
  if (conflicted.length) return { ok: false, issue: 'staged_conflict', path: conflicted[0] };
  for (const untracked of normalizeSupervisionPathSet(input.untrackedOtherOwnerPaths)) {
    if (pathspecSet.some((pathspec) => supervisionPathspecContains(pathspec, untracked))) {
      return { ok: false, issue: 'untracked_other_owner', path: untracked };
    }
  }
  const manifest = input.integrationManifest ?? [];
  if (manifest.length === 0) return { ok: false, issue: 'missing_manifest' };
  const expected: string[] = [];
  const seen = new Set<string>();
  for (const slice of manifest) {
    const files = normalizeSupervisionPathSet(slice.ownedFiles);
    if (!files.length) return { ok: false, issue: 'missing_manifest' };
    for (const file of files) {
      if (seen.has(file)) return { ok: false, issue: 'shared_file_without_integration_owner', path: file };
      seen.add(file);
      expected.push(file);
    }
  }
  const expectedSet = normalizeSupervisionPathSet(expected);
  const ownedSet = normalizeSupervisionPathSet(input.ownedFiles);
  if (!sameSupervisionPathSet(ownedSet, expectedSet)) return { ok: false, issue: 'owned_files_mismatch' };
  const stagedSet = normalizeSupervisionPathSet(input.stagedPaths);
  if (!stagedSet.length) return { ok: false, issue: 'missing_staged_paths' };
  for (const staged of stagedSet) {
    if (!isValidSupervisionOwnedPathspecs([staged])) return { ok: false, issue: 'invalid_pathspec', path: staged };
    if (!expectedSet.includes(staged)) return { ok: false, issue: 'staged_extra', path: staged };
  }
  for (const expectedPath of expectedSet) {
    if (!stagedSet.includes(expectedPath)) return { ok: false, issue: 'staged_missing', path: expectedPath };
  }
  return { ok: true };
}

export function canMarkSupervisionSliceReadyForIntegration(
  slice: SupervisionTaskFinalizationRecord,
  pass: SupervisionTaskFinalizationReleaseInput,
): boolean {
  if (pass.globalGateBlocked) return false;
  if (pass.verdict !== 'PASS') return false;
  if (!slice.ownerSession) return false;
  if (!slice.topLevelTaskId) return false;
  if (slice.auditAttemptId !== pass.attemptId) return false;
  if (String(slice.revision ?? '') !== String(pass.revision)) return false;
  if (String(slice.auditRevision ?? '') !== String(pass.revision)) return false;
  if (!isValidSupervisionOwnedPathspecs(slice.ownedFiles)) return false;
  return true;
}

export function canReleaseSupervisionTaskFinalization(
  task: SupervisionTaskFinalizationRecord,
  pass: SupervisionTaskFinalizationReleaseInput,
): boolean {
  if (pass.globalGateBlocked) return false;
  if (pass.verdict !== 'PASS') return false;
  const auditAttemptId = task.overallAuditAttemptId ?? task.auditAttemptId;
  const auditRevision = task.overallAuditRevision ?? task.auditRevision;
  if (auditAttemptId !== pass.attemptId) return false;
  if (String(task.revision ?? '') !== String(pass.revision)) return false;
  if (String(auditRevision ?? '') !== String(pass.revision)) return false;
  if (!task.integrationOwnerSession) return false;
  if (!task.topLevelTaskId || !task.integrationBoundary || !task.acceptance?.length) return false;
  if (!task.integrationManifest || task.integrationManifest.length === 0) return false;
  if (!task.integrationManifest.every((slice) => canMarkSupervisionSliceReadyForIntegration(slice, {
    attemptId: String(slice.auditAttemptId ?? ''),
    revision: slice.revision ?? '',
    verdict: 'PASS',
  }))) return false;
  return validateSupervisionStageManifest({
    pathspecs: pass.pathspecs,
    stagedPaths: pass.stagedPaths,
    conflictedPaths: pass.conflictedPaths,
    untrackedOtherOwnerPaths: pass.untrackedOtherOwnerPaths,
    integrationManifest: task.integrationManifest,
    ownedFiles: task.ownedFiles,
  }).ok === true;
}

export const SUPERVISION_DELEGATION_ELIGIBILITY_FORBIDDEN_AGENT_TYPES = ['shell', 'script'] as const;
export type SupervisionDelegationEligibilityForbiddenAgentType = typeof SUPERVISION_DELEGATION_ELIGIBILITY_FORBIDDEN_AGENT_TYPES[number];

export const SUPERVISION_DELEGATION_ELIGIBILITY_REQUIRED_TARGET_FIELDS = [
  'targetSession', 'agentType', 'providerFamily', 'availability', 'limitGroup', 'replyCapable',
] as const;
export type SupervisionDelegationEligibilityRequiredTargetField = typeof SUPERVISION_DELEGATION_ELIGIBILITY_REQUIRED_TARGET_FIELDS[number];

export const SUPERVISION_DELEGATION_ELIGIBILITY_DECISIONS = [
  'eligible', 'queue_only', 'limited', 'offline', 'missing_fields', 'forbidden_agent_type',
  'not_reply_capable', 'same_family_degraded', 'no_cross_vendor_blocker', 'daemon_fixed_target',
] as const;
export type SupervisionDelegationEligibilityDecision = typeof SUPERVISION_DELEGATION_ELIGIBILITY_DECISIONS[number];

export const SUPERVISION_DELEGATION_ELIGIBILITY_TASK_LIST_FIELDS = [
  'targetSession', 'targetAgentType', 'providerFamily', 'availability', 'limitGroup', 'replyCapable',
  'eligibilityDecision', 'limitedReason', 'degradedReason',
] as const;
export type SupervisionDelegationEligibilityTaskListField = typeof SUPERVISION_DELEGATION_ELIGIBILITY_TASK_LIST_FIELDS[number];

export const SUPERVISION_DELEGATION_ELIGIBILITY_POLICY = {
  contractId: SUPERVISION_CONTRACT_IDS.DELEGATION_ELIGIBILITY,
  forbiddenAgentTypes: SUPERVISION_DELEGATION_ELIGIBILITY_FORBIDDEN_AGENT_TYPES,
  requiredTargetFields: SUPERVISION_DELEGATION_ELIGIBILITY_REQUIRED_TARGET_FIELDS,
  decisions: SUPERVISION_DELEGATION_ELIGIBILITY_DECISIONS,
  taskListFields: SUPERVISION_DELEGATION_ELIGIBILITY_TASK_LIST_FIELDS,
} as const;

export const SUPERVISION_TASK_REGISTRY_VERSION = 1 as const;

export const SUPERVISION_TASK_CLASSIFICATIONS = [
  'independent_top_level',
  'integration_slice',
  'integration_task',
] as const;
export type SupervisionTaskClassification = typeof SUPERVISION_TASK_CLASSIFICATIONS[number];

export const SUPERVISION_TASK_FILE_OPERATIONS = ['create', 'modify', 'delete', 'rename'] as const;
export type SupervisionTaskFileOperation = typeof SUPERVISION_TASK_FILE_OPERATIONS[number];

export const SUPERVISION_TASK_FILE_TRACKING_MODE = 'caller_reported_only' as const;
export const SUPERVISION_TASK_SCOPE_RECONCILIATION_MODE = 'caller_supplied_observations_only' as const;

export const SUPERVISION_TASK_REGISTRY_EVENT_TYPES = [
  'created',
  'delegated',
  'implementing',
  'retrying_external_ci',
  'validated',
  'ready_for_audit',
  'audit_requested',
  'audit_replied',
  'rework',
  'passed',
  'ready_for_integration',
  'finalizing',
  'committed',
  'pushed',
  'recovered',
  'finalized',
  'blocked',
  'cancelled',
  'file_event',
  'scope_violation',
] as const;
export type SupervisionTaskRegistryEventType = typeof SUPERVISION_TASK_REGISTRY_EVENT_TYPES[number];

export interface SupervisionTaskOwnerIdentity {
  sessionName: string;
  sessionInstanceId: string;
  runtimeEpoch: string;
  agentType: string;
  providerFamily: string;
}

export interface SupervisionTaskScopeReconciliation {
  trackedPaths?: readonly string[] | null;
  untrackedPaths?: readonly string[] | null;
  deletedPaths?: readonly string[] | null;
  currentRevision?: string | null;
}

export interface SupervisionTaskMetadata {
  topLevelTaskId?: string | null;
  taskId?: string | null;
  sliceId?: string | null;
  classification?: SupervisionTaskClassification | null;
  objective?: string | null;
  acceptance?: readonly string[] | null;
  ownedFiles?: readonly string[] | null;
  sharedFiles?: readonly string[] | null;
  dependencies?: readonly string[] | null;
  integrationOwner?: string | null;
  baseRevision?: string | null;
  currentRevision?: string | null;
  auditAttemptId?: string | null;
  auditRevision?: string | number | null;
  executionPool?: SupervisionExecutionPoolKind | null;
  requestedExecutionType?: SupervisionExecutionConfig | null;
  economyPolicy?: SupervisionEconomyTaskPolicy | null;
}

export const SUPERVISION_TASK_REGISTRY_CONTRACT = {
  contractId: SUPERVISION_CONTRACT_IDS.TASK_REGISTRY,
  version: SUPERVISION_TASK_REGISTRY_VERSION,
  classifications: SUPERVISION_TASK_CLASSIFICATIONS,
  statuses: SUPERVISION_TASK_LIFECYCLE_STATUSES,
  eventTypes: SUPERVISION_TASK_REGISTRY_EVENT_TYPES,
  fileOperations: SUPERVISION_TASK_FILE_OPERATIONS,
  fileTracking: {
    mode: SUPERVISION_TASK_FILE_TRACKING_MODE,
    automaticProviderToolHook: false,
    filesystemOrGitScanner: false,
    reconciliationMode: SUPERVISION_TASK_SCOPE_RECONCILIATION_MODE,
    detectsUnreportedWrites: false,
  },
} as const;

export function isSupervisionTaskClassification(value: unknown): value is SupervisionTaskClassification {
  return typeof value === 'string' && (SUPERVISION_TASK_CLASSIFICATIONS as readonly string[]).includes(value);
}

export function isSupervisionTaskLifecycleStatus(value: unknown): value is SupervisionTaskLifecycleStatus {
  return typeof value === 'string' && (SUPERVISION_TASK_LIFECYCLE_STATUSES as readonly string[]).includes(value);
}

export function isTerminalSupervisionTaskStatus(value: SupervisionTaskLifecycleStatus): boolean {
  return value === 'pushed' || value === 'finalized' || value === 'blocked' || value === 'cancelled';
}

const SUPERVISION_TASK_ALLOWED_TRANSITIONS: Readonly<Record<SupervisionTaskLifecycleStatus, readonly SupervisionTaskLifecycleStatus[]>> = {
  planned: ['delegated', 'implementing', 'blocked', 'cancelled'],
  delegated: ['implementing', 'retrying_external_ci', 'validated', 'ready_for_audit', 'auditing', 'rework', 'ready_for_integration', 'blocked', 'cancelled'],
  implementing: ['retrying_external_ci', 'validated', 'ready_for_audit', 'blocked', 'cancelled'],
  retrying_external_ci: ['implementing', 'recovered', 'validated', 'ready_for_audit', 'blocked', 'cancelled'],
  validated: ['ready_for_audit', 'auditing', 'blocked', 'cancelled'],
  ready_for_audit: ['auditing', 'blocked', 'cancelled'],
  auditing: ['rework', 'passed', 'ready_for_integration', 'blocked', 'cancelled'],
  rework: ['implementing', 'validated', 'ready_for_audit', 'auditing', 'ready_for_integration', 'blocked', 'cancelled'],
  passed: ['ready_for_integration', 'finalizing', 'blocked', 'cancelled'],
  ready_for_integration: ['integrating', 'finalizing', 'blocked', 'cancelled'],
  integrating: ['final_audit', 'validated', 'blocked', 'cancelled'],
  final_audit: ['rework', 'passed', 'finalizing', 'blocked', 'cancelled'],
  finalizing: ['committed', 'blocked', 'cancelled'],
  committed: ['pushed', 'blocked'],
  pushed: ['finalized'],
  recovered: ['finalized', 'validated', 'ready_for_audit', 'blocked', 'cancelled'],
  finalized: [],
  blocked: [],
  cancelled: [],
};

export function canTransitionSupervisionTaskStatus(
  from: SupervisionTaskLifecycleStatus,
  to: SupervisionTaskLifecycleStatus,
): boolean {
  return from === to || (SUPERVISION_TASK_ALLOWED_TRANSITIONS[from] as readonly SupervisionTaskLifecycleStatus[]).includes(to);
}

export const SUPERVISION_EXECUTION_STATUS_MARKERS = {
  ADVANCE: '<!-- IMCODES_EXEC: ADVANCE -->',
  AUDIT_READY: '<!-- IMCODES_EXEC: AUDIT_READY -->',
  NEEDS_INPUT: '<!-- IMCODES_EXEC: NEEDS_INPUT -->',
  WAITING: '<!-- IMCODES_EXEC: WAITING -->',
} as const;

export type SupervisionMode = typeof SUPERVISION_MODE[keyof typeof SUPERVISION_MODE];
export type SupervisionAuditMode = 'audit' | 'review' | 'audit>plan' | 'review>plan' | 'audit>review>plan';
export type TaskRunStatusMarker = keyof typeof TASK_RUN_STATUS_MARKERS;
export type TaskRunTerminalState = 'complete' | 'needs_input' | 'blocked';
export type SupervisionExecutionState =
  | 'advance'
  | 'audit_ready'
  | 'needs_input'
  | 'waiting';
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
  | 'invalid_ui_locale'
  | 'invalid_preset'
  | 'invalid_backup_backend'
  | 'invalid_backup_model'
  | 'invalid_backup_preset'
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
  /** Optional fallback runtime, normalized with the same rules as memory processing. */
  backupBackend?: SharedContextRuntimeBackend;
  backupModel?: string;
  backupPreset?: string;
  /** Exactly two user-configured execution pools. Legacy/unconfigured is fail-closed. */
  executionPools: SupervisionExecutionPoolsConfig;
}

export interface SessionSupervisionSnapshot extends SupervisorDefaultConfig {
  mode: SupervisionMode;
  /** UI language selected by the human who started this supervised task. */
  uiLocale?: SupervisionUiLocale;
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

export function normalizeSupervisionUiLocale(value: unknown): SupervisionUiLocale | undefined {
  const locale = trimString(value);
  return SUPERVISION_SUPPORTED_UI_LOCALES.find((candidate) => candidate === locale);
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
    ?? DEFAULT_SUPERVISION_BACKEND;
  // Presets are only meaningful for backends that declare preset support
  // (qwen or claude-code-sdk). Reuse the shared runtime normalizer so supervision
  // preserves the exact same trim/gating semantics as shared context config.
  const preset = normalizeSharedContextPresetValue(normalizedBackend, typeof merged.preset === 'string' ? merged.preset : undefined);
  const rawModel = trimString(merged.model);
  const model = rawModel && isKnownSharedContextModelForBackend(normalizedBackend, rawModel, preset)
    ? rawModel
    : getDefaultSharedContextModelForBackend(normalizedBackend);
  const customInstructions = trimString(merged.customInstructions);
  const backup = normalizeOptionalSharedContextRuntimeSelection({
    backend: merged.backupBackend,
    model: merged.backupModel,
    preset: merged.backupPreset,
  });
  return {
    backend: normalizedBackend,
    model,
    timeoutMs: normalizePositiveInteger(
      merged.timeoutMs,
      SUPERVISION_DEFAULT_TIMEOUT_MS,
      SUPERVISION_MIN_TIMEOUT_MS,
    ),
    promptVersion: trimString(merged.promptVersion) ?? SUPERVISION_DEFAULT_PROMPT_VERSION,
    maxAutoContinueStreak: normalizeNonNegativeInteger(merged.maxAutoContinueStreak, SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_STREAK),
    maxAutoContinueTotal: normalizeNonNegativeInteger(merged.maxAutoContinueTotal, SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_TOTAL),
    executionPools: migrateLegacySupervisionExecutionPools({
      backend: normalizedBackend,
      model,
      executionPools: merged.executionPools,
    }),
    ...(customInstructions ? { customInstructions } : {}),
    ...(preset ? { preset } : {}),
    ...(backup.backend && backup.model ? {
      backupBackend: backup.backend,
      backupModel: backup.model,
      ...(backup.preset ? { backupPreset: backup.preset } : {}),
    } : {}),
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
  const validTargetName = !!targetName && targetName === rawTargetName && isValidImcodesSessionName(targetName);

  if (hasTargetName && !validTargetName) issues.push('invalid_audit_target_name');
  if (
    record.peerAuditPromptVersion != null
    && record.peerAuditPromptVersion !== PEER_AUDIT_PROMPT_VERSION
  ) {
    issues.push('invalid_peer_audit_prompt_version');
  }
  if (record.peerAuditPromptVersion != null && !validTargetName) {
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
  const backupBackend = trimString(record.backupBackend);
  const backupModel = trimString(record.backupModel);
  const backupPreset = trimString(record.backupPreset);
  if (record.backupBackend != null && (!backupBackend || !isSupportedSupervisionBackend(backupBackend))) {
    issues.push('invalid_backup_backend');
  }
  if (record.backupModel != null && !backupModel) issues.push('invalid_backup_model');
  if (record.backupPreset != null && typeof record.backupPreset !== 'string') issues.push('invalid_backup_preset');
  if (backupModel && !backupBackend && !issues.includes('invalid_backup_backend')) {
    issues.push('invalid_backup_backend');
  }
  if (
    backupBackend
    && isSupportedSupervisionBackend(backupBackend)
    && backupModel
    && backupBackend !== 'openclaw'
    && !isKnownSharedContextModelForBackend(backupBackend, backupModel, backupPreset)
  ) {
    issues.push('invalid_backup_model');
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

  // Keep legacy positive values readable; normalization upgrades them to the
  // current minimum before any supervisor decision runs.
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
  if (record.uiLocale != null && normalizeSupervisionUiLocale(record.uiLocale) === undefined) {
    issues.push('invalid_ui_locale');
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
    // The Supervisor Brain supplies the exact audit route; the daemon never
    // selects one. A supervised_audit snapshot carrying no target is therefore
    // an UNROUTABLE configuration, not a dynamic one: automatic dispatch has
    // nothing to dispatch to. Flag it for repair instead of letting it reach
    // the automation and fail there. A present-but-malformed target already
    // produced invalid_audit_target_name above, so only absence lands here.
    if (!hasTargetName) issues.push('missing_audit_target');
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
  const uiLocale = normalizeSupervisionUiLocale(merged.uiLocale);
  const maxParseRetries = normalizePositiveInteger(merged.maxParseRetries, SUPERVISION_DEFAULT_MAX_PARSE_RETRIES, 1);
  const maxAutoContinueStreak = normalizeNonNegativeInteger(merged.maxAutoContinueStreak, SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_STREAK);
  const maxAutoContinueTotal = normalizeNonNegativeInteger(merged.maxAutoContinueTotal, SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_TOTAL);
  const maxAuditLoops = normalizeNonNegativeInteger(merged.maxAuditLoops, SUPERVISION_DEFAULT_MAX_AUDIT_LOOPS);
  const auditTargetSessionName = trimString(merged.auditTargetSessionName);
  const auditTargetFingerprint = isCanonicalPeerAuditTargetFingerprint(merged.auditTargetFingerprint)
    ? merged.auditTargetFingerprint
    : undefined;
  const hasCanonicalAuditTarget = !!auditTargetSessionName
    && isValidImcodesSessionName(auditTargetSessionName);
  return {
    ...supervisorDefaults,
    mode,
    ...(customInstructions ? { customInstructions } : {}),
    // Only emit the override flag when true, to keep payloads minimal for the
    // default (unchecked = concat) case. Normalizer defaults missing to false.
    ...(customInstructionsOverride ? { customInstructionsOverride: true } : {}),
    ...(globalCustomInstructions ? { globalCustomInstructions } : {}),
    ...(uiLocale ? { uiLocale } : {}),
    maxParseRetries,
    maxAutoContinueStreak,
    maxAutoContinueTotal,
    ...(hasCanonicalAuditTarget ? {
      auditTargetSessionName,
      ...(auditTargetFingerprint ? { auditTargetFingerprint } : {}),
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
  // Legacy auditMode remains read-only compatibility. A valid name-only
  // target is now canonical: automatic audit resolves the live session when
  // it starts rather than blocking settings on persisted runtime metadata.
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

export interface ParsedSupervisionExecutionState {
  state: SupervisionExecutionState | null;
  markerCount: number;
}

export function parseSupervisionExecutionStateDetailsFromText(text: string): ParsedSupervisionExecutionState {
  const matches = [...text.matchAll(/<!--\s*IMCODES_EXEC:\s*(ADVANCE|AUDIT_READY|NEEDS_INPUT|WAITING)\s*-->/g)];
  if (matches.length !== 1) return { state: null, markerCount: matches.length };
  const state = matches[0]?.[1];
  switch (state) {
    case 'ADVANCE':
      return { state: 'advance', markerCount: 1 };
    case 'AUDIT_READY':
      return { state: 'audit_ready', markerCount: 1 };
    case 'NEEDS_INPUT':
      return { state: 'needs_input', markerCount: 1 };
    case 'WAITING':
      return { state: 'waiting', markerCount: 1 };
    default:
      return { state: null, markerCount: matches.length };
  }
}

export function parseSupervisionExecutionStateFromText(text: string): SupervisionExecutionState | null {
  return parseSupervisionExecutionStateDetailsFromText(text).state;
}

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
