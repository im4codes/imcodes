import type { P2pAdvancedRound } from './p2p-advanced.js';
import { P2P_PRESET_DEFAULT_SUMMARY_PROMPT } from './p2p-workflow-constants.js';
import {
  OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID,
  OPENSPEC_AUTO_DELIVER_COMBO_IDS,
  OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_PROMPT_ID,
  OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_PROMPT_ID,
  type OpenSpecAutoDeliverStage,
  type OpenSpecAutoDeliverStagePromptId,
} from './openspec-auto-deliver-constants.js';

const SPEC_AUDIT_REPAIR_ROUNDS: P2pAdvancedRound[] = [
  {
    id: 'spec_audit_repair_apply',
    title: 'OpenSpec Spec Audit-Repair',
    preset: 'proposal_audit',
    executionMode: 'single_main',
    permissionScope: 'artifact_generation',
    artifactConvention: 'openspec_convention',
    artifactOutputs: ['openspec/changes'],
    timeoutMinutes: 8,
    verdictPolicy: 'none',
    effectiveSummaryPrompt:
      `${P2P_PRESET_DEFAULT_SUMMARY_PROMPT.proposal_audit}\n\nOpenSpec Auto Deliver result contract: write the authoritative result file as raw JSON only at the requested path; discussion text is not authoritative.`,
  },
];

const IMPLEMENTATION_AUDIT_REPAIR_ROUNDS: P2pAdvancedRound[] = [
  {
    id: 'implementation_audit_repair_apply',
    title: 'OpenSpec Implementation Audit-Repair',
    preset: 'implementation_audit',
    executionMode: 'single_main',
    permissionScope: 'implementation',
    timeoutMinutes: 10,
    verdictPolicy: 'none',
    effectiveSummaryPrompt:
      `${P2P_PRESET_DEFAULT_SUMMARY_PROMPT.implementation_audit}\n\nOpenSpec Auto Deliver result contract: write the authoritative result file as raw JSON only at the requested path; discussion text is not authoritative.`,
  },
];

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
    selectedTeamComboId === OPENSPEC_AUTO_DELIVER_COMBO_IDS.SPEC_AUDIT_REPAIR
    || selectedTeamComboId === OPENSPEC_AUTO_DELIVER_COMBO_IDS.IMPLEMENTATION_AUDIT_REPAIR
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

export function materializeOpenSpecAutoDeliverStageRound(
  stage: OpenSpecAutoDeliverAuditRepairStage,
  selectedTeamComboId: string = OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID,
): { round: P2pAdvancedRound; activeOpenSpecPromptId: OpenSpecAutoDeliverStagePromptId } | { error: OpenSpecAutoDeliverCompatibilityResult['reason'] } {
  const activeOpenSpecPromptId = activeOpenSpecPromptIdForAutoDeliverStage(stage);
  const compatibility = evaluateOpenSpecAutoDeliverComboCompatibility(selectedTeamComboId, stage, activeOpenSpecPromptId);
  if (!compatibility.ok) return { error: compatibility.reason ?? 'combo_unsupported' };
  const template = stage === 'spec_audit_repair' ? SPEC_AUDIT_REPAIR_ROUNDS[0] : IMPLEMENTATION_AUDIT_REPAIR_ROUNDS[0];
  if (!template) return { error: 'combo_unsupported' };
  return {
    activeOpenSpecPromptId,
    round: {
      ...template,
      artifactOutputs: template.artifactOutputs ? [...template.artifactOutputs] : undefined,
    },
  };
}
