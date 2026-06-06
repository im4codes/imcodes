import type { P2pAdvancedRound } from './p2p-advanced.js';
import {
  OPENSPEC_AUTO_DELIVER_COMBO_IDS,
  type OpenSpecAutoDeliverComboId,
} from './openspec-auto-deliver-constants.js';
import type { OpenSpecAutoDeliverComboDescriptor } from './openspec-auto-deliver-types.js';
import { validateOpenSpecAutoDeliverComboDescriptor } from './openspec-auto-deliver-validators.js';

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
      'Return exactly one JSON payload for OpenSpec Auto Deliver with verdict, module_scores, unchecked_tasks, required_changes, repairs_applied, and evidence. Apply safe in-scope OpenSpec artifact repairs before returning PASS.',
    promptAppend:
      'You are the designated OpenSpec Auto Deliver spec audit-repair combo. Audit proposal/design/specs/tasks, apply safe in-scope artifact repairs, and return strict JSON only through the authoritative result channel. Return BLOCKED for unclear or unsafe scope.',
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
      'Return exactly one JSON payload for OpenSpec Auto Deliver with verdict, module_scores, unchecked_tasks, required_changes, repairs_applied, and evidence. Apply safe in-scope implementation repairs before returning PASS.',
    promptAppend:
      'You are the designated OpenSpec Auto Deliver implementation audit-repair combo. Audit implementation against OpenSpec artifacts, tasks.md, diff, tests, and risk. Apply safe in-scope product/test/tasks.md repairs and return strict JSON only through the authoritative result channel. Return BLOCKED for unclear or unsafe scope.',
  },
];

export const OPENSPEC_AUTO_DELIVER_COMBO_DESCRIPTORS = [
  {
    id: OPENSPEC_AUTO_DELIVER_COMBO_IDS.SPEC_AUDIT_REPAIR,
    title: 'OpenSpec Auto Deliver Spec Audit-Repair',
    capability: {
      stage: 'spec_audit_repair',
      requiredPermissionScope: 'artifact_generation',
      allowedMutationScopes: ['openspec_change_artifacts', 'tasks_md'],
      writeMode: 'single_authoritative_writer',
      strictResultChannel: 'authoritative_summary_json',
      minTransportParticipants: 1,
      supportsGenerationMetadata: true,
      supportsStopCancellation: true,
    },
    rounds: SPEC_AUDIT_REPAIR_ROUNDS,
  },
  {
    id: OPENSPEC_AUTO_DELIVER_COMBO_IDS.IMPLEMENTATION_AUDIT_REPAIR,
    title: 'OpenSpec Auto Deliver Implementation Audit-Repair',
    capability: {
      stage: 'implementation_audit_repair',
      requiredPermissionScope: 'implementation',
      allowedMutationScopes: ['product_files', 'tests', 'tasks_md'],
      writeMode: 'single_authoritative_writer',
      strictResultChannel: 'authoritative_summary_json',
      minTransportParticipants: 1,
      supportsGenerationMetadata: true,
      supportsStopCancellation: true,
    },
    rounds: IMPLEMENTATION_AUDIT_REPAIR_ROUNDS,
  },
] as const satisfies readonly OpenSpecAutoDeliverComboDescriptor[];

export function resolveOpenSpecAutoDeliverCombo(
  id: OpenSpecAutoDeliverComboId,
): OpenSpecAutoDeliverComboDescriptor | null {
  const descriptor = OPENSPEC_AUTO_DELIVER_COMBO_DESCRIPTORS.find((entry) => entry.id === id);
  if (!descriptor) return null;
  return {
    ...descriptor,
    capability: {
      ...descriptor.capability,
      allowedMutationScopes: [...descriptor.capability.allowedMutationScopes],
    },
    rounds: descriptor.rounds.map((round) => ({ ...round, artifactOutputs: round.artifactOutputs ? [...round.artifactOutputs] : undefined })),
  };
}

export function assertOpenSpecAutoDeliverCombosValid(): void {
  for (const descriptor of OPENSPEC_AUTO_DELIVER_COMBO_DESCRIPTORS) {
    const result = validateOpenSpecAutoDeliverComboDescriptor(descriptor);
    if (!result.ok) {
      throw new Error(`Invalid OpenSpec Auto Deliver combo ${descriptor.id}: ${result.issues.map((entry) => entry.code).join(', ')}`);
    }
  }
}

