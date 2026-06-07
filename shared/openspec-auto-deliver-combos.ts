import {
  OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID,
  OPENSPEC_AUTO_DELIVER_UNSUPPORTED_LEGACY_COMBO_IDS,
  OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_PROMPT_ID,
  OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_PROMPT_ID,
  type OpenSpecAutoDeliverStage,
  type OpenSpecAutoDeliverStagePromptId,
} from './openspec-auto-deliver-constants.js';

export type OpenSpecAutoDeliverAuditRepairStage = Extract<OpenSpecAutoDeliverStage, 'spec_audit_repair' | 'implementation_audit_repair'>;

export interface OpenSpecAutoDeliverCompatibilityResult {
  ok: boolean;
  reason?: 'custom_combo_unsupported' | 'legacy_combo_unsupported' | 'combo_unsupported' | 'invalid_stage_prompt';
}

export function activeOpenSpecPromptIdForAutoDeliverStage(
  stage: OpenSpecAutoDeliverAuditRepairStage,
): OpenSpecAutoDeliverStagePromptId {
  return stage === 'spec_audit_repair'
    ? OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_PROMPT_ID
    : OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_PROMPT_ID;
}

export function evaluateOpenSpecAutoDeliverComboCompatibility(
  selectedTeamComboId: string,
  stage: OpenSpecAutoDeliverAuditRepairStage,
  activeOpenSpecPromptId = activeOpenSpecPromptIdForAutoDeliverStage(stage),
): OpenSpecAutoDeliverCompatibilityResult {
  if (
    selectedTeamComboId === OPENSPEC_AUTO_DELIVER_UNSUPPORTED_LEGACY_COMBO_IDS.SPEC_AUDIT_REPAIR
    || selectedTeamComboId === OPENSPEC_AUTO_DELIVER_UNSUPPORTED_LEGACY_COMBO_IDS.IMPLEMENTATION_AUDIT_REPAIR
  ) {
    return { ok: false, reason: 'legacy_combo_unsupported' };
  }
  if (
    (stage === 'spec_audit_repair' && activeOpenSpecPromptId !== OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_PROMPT_ID)
    || (stage === 'implementation_audit_repair' && activeOpenSpecPromptId !== OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_PROMPT_ID)
  ) {
    return { ok: false, reason: 'invalid_stage_prompt' };
  }
  if (selectedTeamComboId === OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID) {
    return { ok: true };
  }
  return { ok: false, reason: 'custom_combo_unsupported' };
}
