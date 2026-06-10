export const OPENSPEC_AUTO_DELIVER_PROTOCOL_NAMESPACE = 'openspec_auto_deliver' as const;

export const OPENSPEC_AUTO_DELIVER_MSG = {
  LAUNCH: 'openspec_auto_deliver.launch',
  LAUNCH_ACK: 'openspec_auto_deliver.launch_ack',
  LAUNCH_ERROR: 'openspec_auto_deliver.launch_error',
  CONTINUE: 'openspec_auto_deliver.continue',
  CONTINUE_ACK: 'openspec_auto_deliver.continue_ack',
  STOP: 'openspec_auto_deliver.stop',
  STOP_ACK: 'openspec_auto_deliver.stop_ack',
  STATUS_REQUEST: 'openspec_auto_deliver.status_request',
  STATUS_PROJECTION: 'openspec_auto_deliver.status_projection',
  LIST_REQUEST: 'openspec_auto_deliver.list_request',
  LIST_RESPONSE: 'openspec_auto_deliver.list_response',
  PROJECTION: 'openspec_auto_deliver.projection',
  CONFLICT_SUMMARY: 'openspec_auto_deliver.conflict_summary',
  TERMINAL: 'openspec_auto_deliver.terminal',
} as const;

export type OpenSpecAutoDeliverMsgType = (typeof OPENSPEC_AUTO_DELIVER_MSG)[keyof typeof OPENSPEC_AUTO_DELIVER_MSG];

export const OPENSPEC_AUTO_DELIVER_PRESET_IDS = ['fast', 'standard', 'strict', 'deep', 'custom'] as const;
export type OpenSpecAutoDeliverPresetId = (typeof OPENSPEC_AUTO_DELIVER_PRESET_IDS)[number];

export const OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET_ID = 'standard' as const satisfies OpenSpecAutoDeliverPresetId;

export interface OpenSpecAutoDeliverRoundLimits {
  specAuditRepairRounds: number;
  implementationAuditRepairRounds: number;
}

export interface OpenSpecAutoDeliverMaterializedLimits extends OpenSpecAutoDeliverRoundLimits {
  maxImplementationPrompts: number;
  maxElapsedMinutes: number;
}

export const OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_ROUNDS_MIN = 0 as const;
export const OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_ROUNDS_MAX = 3 as const;
export const OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_ROUNDS_MIN = 1 as const;
export const OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_ROUNDS_MAX = 5 as const;
export const OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_IMPLEMENTATION_PROMPTS = 12 as const;
/** Max consecutive idle reminders (no task progress and no completion marker)
 *  before the implementation phase escalates to needs_human instead of
 *  re-prompting the agent forever. */
export const OPENSPEC_AUTO_DELIVER_MAX_IMPLEMENTATION_MARKER_REMINDERS = 6 as const;
export const OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_ELAPSED_MINUTES = 240 as const;
export const OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID = 'audit>review>plan' as const;
export const OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_PROMPT_ID = 'proposal_audit' as const;
export const OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_PROMPT_ID = 'implementation_audit' as const;
export type OpenSpecAutoDeliverStagePromptId =
  | typeof OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_PROMPT_ID
  | typeof OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_PROMPT_ID;

export const OPENSPEC_AUTO_DELIVER_STAGES = [
  'proposed',
  'spec_audit_repair',
  'implementation_task_loop',
  'implementation_audit_repair',
  'commit_push',
  'stopping',
  'passed',
  'needs_human',
  'failed',
  'stopped',
] as const;
export type OpenSpecAutoDeliverStage = (typeof OPENSPEC_AUTO_DELIVER_STAGES)[number];

export const OPENSPEC_AUTO_DELIVER_TERMINAL_STAGES = ['passed', 'needs_human', 'failed', 'stopped'] as const;
export type OpenSpecAutoDeliverTerminalStage = (typeof OPENSPEC_AUTO_DELIVER_TERMINAL_STAGES)[number];

export const OPENSPEC_AUTO_DELIVER_TERMINAL_REASONS = {
  INVALID_AUTHORITATIVE_RESULT_PATH: 'invalid_authoritative_result_path',
} as const;
export type OpenSpecAutoDeliverTerminalReason = (typeof OPENSPEC_AUTO_DELIVER_TERMINAL_REASONS)[keyof typeof OPENSPEC_AUTO_DELIVER_TERMINAL_REASONS];

export function isOpenSpecAutoDeliverMessageType(value: unknown): value is OpenSpecAutoDeliverMsgType {
  return typeof value === 'string'
    && (Object.values(OPENSPEC_AUTO_DELIVER_MSG) as string[]).includes(value);
}

export function isOpenSpecAutoDeliverStage(value: unknown): value is OpenSpecAutoDeliverStage {
  return typeof value === 'string'
    && (OPENSPEC_AUTO_DELIVER_STAGES as readonly string[]).includes(value);
}

export function isOpenSpecAutoDeliverTerminalStage(value: unknown): value is OpenSpecAutoDeliverTerminalStage {
  return typeof value === 'string'
    && (OPENSPEC_AUTO_DELIVER_TERMINAL_STAGES as readonly string[]).includes(value);
}

export const OPENSPEC_AUTO_DELIVER_VERDICTS = ['PASS', 'REWORK', 'BLOCKED'] as const;
export type OpenSpecAutoDeliverVerdict = (typeof OPENSPEC_AUTO_DELIVER_VERDICTS)[number];

export const OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS = [
  'spec',
  'tasks',
  'implementation',
  'tests',
  'risk',
] as const;
export type OpenSpecAutoDeliverScoreModuleId = (typeof OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS)[number];
export const OPENSPEC_AUTO_DELIVER_MIN_ACCEPTABLE_MODULE_SCORE = 6 as const;

export const OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_RESULT_FIELDS = [
  'auto_deliver',
  'verdict',
  'module_scores',
  'unchecked_tasks',
  'required_changes',
  'repairs_applied',
  'evidence',
] as const;
export type OpenSpecAutoDeliverAuthoritativeResultField = (typeof OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_RESULT_FIELDS)[number];

export const OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_VERDICT_FIELDS = [
  'verdict',
  'module_scores',
  'unchecked_tasks',
  'required_changes',
  'repairs_applied',
  'evidence',
] as const;
export type OpenSpecAutoDeliverAuthoritativeVerdictField = (typeof OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_VERDICT_FIELDS)[number];

export const OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_METADATA_FIELDS = [
  'runId',
  'changeName',
  'resolvedChangeRootIdentity',
  'stage',
  'selectedTeamComboId',
  'activeOpenSpecPromptId',
  'roundIndex',
  'attemptId',
  'authoritativeResultPath',
  'owningMainSessionName',
  'executionSessionName',
  'generation',
] as const;
export type OpenSpecAutoDeliverAuthoritativeMetadataField = (typeof OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_METADATA_FIELDS)[number];

export const OPENSPEC_AUTO_DELIVER_MODULE_SCORE_FIELDS = [
  'module',
  'score',
  'max_score',
  'summary',
] as const;
export type OpenSpecAutoDeliverModuleScoreField = (typeof OPENSPEC_AUTO_DELIVER_MODULE_SCORE_FIELDS)[number];

export const OPENSPEC_AUTO_DELIVER_REPAIR_SUMMARY_FIELDS = [
  'files',
  'reason',
] as const;
export type OpenSpecAutoDeliverRepairSummaryField = (typeof OPENSPEC_AUTO_DELIVER_REPAIR_SUMMARY_FIELDS)[number];

export const OPENSPEC_AUTO_DELIVER_EVIDENCE_REQUIRED_FIELDS = [
  'source',
  'summary',
] as const;
export type OpenSpecAutoDeliverEvidenceRequiredField = (typeof OPENSPEC_AUTO_DELIVER_EVIDENCE_REQUIRED_FIELDS)[number];

export const OPENSPEC_AUTO_DELIVER_EVIDENCE_OPTIONAL_FIELDS = [
  'command',
  'exitCode',
] as const;
export type OpenSpecAutoDeliverEvidenceOptionalField = (typeof OPENSPEC_AUTO_DELIVER_EVIDENCE_OPTIONAL_FIELDS)[number];

export const OPENSPEC_AUTO_DELIVER_EVIDENCE_PROVENANCE = [
  'daemon',
  'implementation_reported',
  'audit_reported',
  'none',
] as const;
export type OpenSpecAutoDeliverEvidenceProvenance = (typeof OPENSPEC_AUTO_DELIVER_EVIDENCE_PROVENANCE)[number];

export const OPENSPEC_AUTO_DELIVER_UNSUPPORTED_LEGACY_COMBO_IDS = {
  SPEC_AUDIT_REPAIR: 'openspec_auto_deliver.spec_audit_repair',
  IMPLEMENTATION_AUDIT_REPAIR: 'openspec_auto_deliver.implementation_audit_repair',
} as const;
export type OpenSpecAutoDeliverUnsupportedLegacyComboId = (typeof OPENSPEC_AUTO_DELIVER_UNSUPPORTED_LEGACY_COMBO_IDS)[keyof typeof OPENSPEC_AUTO_DELIVER_UNSUPPORTED_LEGACY_COMBO_IDS];

export const OPENSPEC_AUTO_DELIVER_COMBO_WRITE_MODES = [
  'single_authoritative_writer',
  'serialized_patch_apply',
] as const;
export type OpenSpecAutoDeliverComboWriteMode = (typeof OPENSPEC_AUTO_DELIVER_COMBO_WRITE_MODES)[number];

export const OPENSPEC_AUTO_DELIVER_MUTATION_SCOPES = [
  'openspec_change_artifacts',
  'product_files',
  'tests',
  'tasks_md',
] as const;
export type OpenSpecAutoDeliverMutationScope = (typeof OPENSPEC_AUTO_DELIVER_MUTATION_SCOPES)[number];

export const OPENSPEC_AUTO_DELIVER_LOCK_OWNER = 'openspec_auto_deliver' as const;
export const OPENSPEC_AUTO_DELIVER_PROJECTION_VISIBILITIES = ['full', 'conflict'] as const;
export type OpenSpecAutoDeliverProjectionVisibility = (typeof OPENSPEC_AUTO_DELIVER_PROJECTION_VISIBILITIES)[number];
export const OPENSPEC_AUTO_DELIVER_VIEW_MODES = ['fullRunbar', 'compactRecovery', 'conflict', 'hidden'] as const;
export type OpenSpecAutoDeliverViewMode = (typeof OPENSPEC_AUTO_DELIVER_VIEW_MODES)[number];

export const OPENSPEC_AUTO_DELIVER_REQUEST_ID_MAX_BYTES = 128 as const;
export const OPENSPEC_AUTO_DELIVER_CHANGE_SLUG_MAX_BYTES = 160 as const;
export const OPENSPEC_AUTO_DELIVER_VERDICT_JSON_MAX_BYTES = 64 * 1024;

export const OPENSPEC_AUTO_DELIVER_PRESET_LIMITS = {
  fast: {
    specAuditRepairRounds: 0,
    implementationAuditRepairRounds: 1,
    maxImplementationPrompts: 6,
    maxElapsedMinutes: 180,
  },
  standard: {
    specAuditRepairRounds: 1,
    implementationAuditRepairRounds: 2,
    maxImplementationPrompts: OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_IMPLEMENTATION_PROMPTS,
    maxElapsedMinutes: OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_ELAPSED_MINUTES,
  },
  strict: {
    specAuditRepairRounds: 2,
    implementationAuditRepairRounds: 2,
    maxImplementationPrompts: 16,
    maxElapsedMinutes: 360,
  },
  deep: {
    specAuditRepairRounds: 2,
    implementationAuditRepairRounds: 3,
    maxImplementationPrompts: 24,
    maxElapsedMinutes: 480,
  },
  custom: {
    specAuditRepairRounds: 1,
    implementationAuditRepairRounds: 2,
    maxImplementationPrompts: OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_IMPLEMENTATION_PROMPTS,
    maxElapsedMinutes: OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_ELAPSED_MINUTES,
  },
} as const satisfies Record<OpenSpecAutoDeliverPresetId, OpenSpecAutoDeliverMaterializedLimits>;

export function materializeOpenSpecAutoDeliverPreset(
  presetId: OpenSpecAutoDeliverPresetId,
): OpenSpecAutoDeliverMaterializedLimits {
  return { ...OPENSPEC_AUTO_DELIVER_PRESET_LIMITS[presetId] };
}
