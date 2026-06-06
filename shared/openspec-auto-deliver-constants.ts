export const OPENSPEC_AUTO_DELIVER_PROTOCOL_NAMESPACE = 'openspec_auto_deliver' as const;

export const OPENSPEC_AUTO_DELIVER_MSG = {
  LAUNCH: 'openspec_auto_deliver.launch',
  LAUNCH_ACK: 'openspec_auto_deliver.launch_ack',
  LAUNCH_ERROR: 'openspec_auto_deliver.launch_error',
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

export const OPENSPEC_AUTO_DELIVER_PRESET_LIMITS = {
  fast: { specAuditRepairRounds: 0, implementationAuditRepairRounds: 1 },
  standard: { specAuditRepairRounds: 1, implementationAuditRepairRounds: 2 },
  strict: { specAuditRepairRounds: 2, implementationAuditRepairRounds: 2 },
  deep: { specAuditRepairRounds: 2, implementationAuditRepairRounds: 3 },
  custom: { specAuditRepairRounds: 1, implementationAuditRepairRounds: 2 },
} as const satisfies Record<OpenSpecAutoDeliverPresetId, OpenSpecAutoDeliverRoundLimits>;

export const OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET_ID = 'standard' as const satisfies OpenSpecAutoDeliverPresetId;

export interface OpenSpecAutoDeliverRoundLimits {
  specAuditRepairRounds: number;
  implementationAuditRepairRounds: number;
}

export const OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_ROUNDS_MIN = 0 as const;
export const OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_ROUNDS_MAX = 3 as const;
export const OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_ROUNDS_MIN = 1 as const;
export const OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_ROUNDS_MAX = 5 as const;
export const OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_IMPLEMENTATION_PROMPTS = 12 as const;
export const OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_ELAPSED_MINUTES = 60 as const;
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
  'stopping',
  'passed',
  'needs_human',
  'failed',
  'stopped',
] as const;
export type OpenSpecAutoDeliverStage = (typeof OPENSPEC_AUTO_DELIVER_STAGES)[number];

export const OPENSPEC_AUTO_DELIVER_TERMINAL_STAGES = ['passed', 'needs_human', 'failed', 'stopped'] as const;
export type OpenSpecAutoDeliverTerminalStage = (typeof OPENSPEC_AUTO_DELIVER_TERMINAL_STAGES)[number];

export function isOpenSpecAutoDeliverMessageType(value: unknown): value is OpenSpecAutoDeliverMsgType {
  return typeof value === 'string'
    && (Object.values(OPENSPEC_AUTO_DELIVER_MSG) as string[]).includes(value);
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

export const OPENSPEC_AUTO_DELIVER_EVIDENCE_PROVENANCE = [
  'daemon',
  'implementation_reported',
  'audit_reported',
  'none',
] as const;
export type OpenSpecAutoDeliverEvidenceProvenance = (typeof OPENSPEC_AUTO_DELIVER_EVIDENCE_PROVENANCE)[number];

export const OPENSPEC_AUTO_DELIVER_COMBO_IDS = {
  SPEC_AUDIT_REPAIR: 'openspec_auto_deliver.spec_audit_repair',
  IMPLEMENTATION_AUDIT_REPAIR: 'openspec_auto_deliver.implementation_audit_repair',
} as const;
export type OpenSpecAutoDeliverComboId = (typeof OPENSPEC_AUTO_DELIVER_COMBO_IDS)[keyof typeof OPENSPEC_AUTO_DELIVER_COMBO_IDS];

export const OPENSPEC_AUTO_DELIVER_COMBO_WRITE_MODES = [
  'single_authoritative_writer',
  'serialized_patch_apply',
] as const;
export type OpenSpecAutoDeliverComboWriteMode = (typeof OPENSPEC_AUTO_DELIVER_COMBO_WRITE_MODES)[number];

export const OPENSPEC_AUTO_DELIVER_STRICT_RESULT_CHANNELS = [
  'authoritative_summary_json',
  'structured_p2p_result',
] as const;
export type OpenSpecAutoDeliverStrictResultChannel = (typeof OPENSPEC_AUTO_DELIVER_STRICT_RESULT_CHANNELS)[number];

export const OPENSPEC_AUTO_DELIVER_MUTATION_SCOPES = [
  'openspec_change_artifacts',
  'product_files',
  'tests',
  'tasks_md',
] as const;
export type OpenSpecAutoDeliverMutationScope = (typeof OPENSPEC_AUTO_DELIVER_MUTATION_SCOPES)[number];

export const OPENSPEC_AUTO_DELIVER_LOCK_OWNER = 'openspec_auto_deliver' as const;
export const OPENSPEC_AUTO_DELIVER_LAUNCH_ORIGIN = 'openspec_auto_deliver_internal' as const;
export const OPENSPEC_AUTO_DELIVER_PROJECTION_VISIBILITIES = ['full', 'conflict'] as const;
export type OpenSpecAutoDeliverProjectionVisibility = (typeof OPENSPEC_AUTO_DELIVER_PROJECTION_VISIBILITIES)[number];
export const OPENSPEC_AUTO_DELIVER_VIEW_MODES = ['fullRunbar', 'compactRecovery', 'conflict', 'hidden'] as const;
export type OpenSpecAutoDeliverViewMode = (typeof OPENSPEC_AUTO_DELIVER_VIEW_MODES)[number];

export const OPENSPEC_AUTO_DELIVER_REQUEST_ID_MAX_BYTES = 128 as const;
export const OPENSPEC_AUTO_DELIVER_CHANGE_SLUG_MAX_BYTES = 160 as const;
export const OPENSPEC_AUTO_DELIVER_VERDICT_JSON_MAX_BYTES = 64 * 1024;

export function materializeOpenSpecAutoDeliverPreset(
  presetId: OpenSpecAutoDeliverPresetId,
): OpenSpecAutoDeliverRoundLimits {
  return { ...OPENSPEC_AUTO_DELIVER_PRESET_LIMITS[presetId] };
}
