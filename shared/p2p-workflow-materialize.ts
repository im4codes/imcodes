import { BUILT_IN_ADVANCED_PRESETS, type P2pAdvancedRound } from './p2p-advanced.js';
import { P2P_WORKFLOW_SCHEMA_VERSION, type P2pPermissionScope, type P2pPresetKey } from './p2p-workflow-constants.js';
import type { P2pWorkflowDraft, P2pWorkflowEdgeDraft, P2pWorkflowNodeDraft } from './p2p-workflow-types.js';

export interface P2pOldAdvancedMaterializeInput {
  advancedPresetKey?: string | null;
  advancedRounds?: P2pAdvancedRound[] | null;
  advancedRunTimeoutMinutes?: number | null;
}

function normalizeOldPreset(preset: string): P2pPresetKey {
  if (preset === 'discussion') return 'discuss';
  if (
    preset === 'openspec_propose' ||
    preset === 'proposal_audit' ||
    preset === 'implementation' ||
    preset === 'implementation_audit' ||
    preset === 'custom'
  ) {
    return preset;
  }
  return 'custom';
}

function nodeKindForRound(round: P2pAdvancedRound): P2pWorkflowNodeDraft['nodeKind'] {
  return round.permissionScope === 'implementation' && round.preset === 'custom' ? 'script' : 'llm';
}

function permissionScopeForRound(scope: string): P2pPermissionScope {
  if (scope === 'artifact_generation' || scope === 'implementation') return scope;
  return 'analysis_only';
}

function cloneRounds(rounds: P2pAdvancedRound[]): P2pAdvancedRound[] {
  return JSON.parse(JSON.stringify(rounds)) as P2pAdvancedRound[];
}

export function materializeOldAdvancedConfigToWorkflowDraft(
  input: P2pOldAdvancedMaterializeInput,
): P2pWorkflowDraft {
  const rounds = input.advancedRounds?.length
    ? cloneRounds(input.advancedRounds)
    : input.advancedPresetKey === 'openspec'
      ? cloneRounds(BUILT_IN_ADVANCED_PRESETS.openspec)
      : [];
  if (rounds.length === 0) {
    throw new Error('Old advanced P2P materialization requires advancedPresetKey or advancedRounds');
  }

  const nodes: P2pWorkflowNodeDraft[] = rounds.map((round) => ({
    id: round.id,
    title: round.title,
    nodeKind: nodeKindForRound(round),
    preset: normalizeOldPreset(round.preset),
    dispatchStyle: round.executionMode === 'single_main' ? 'single_main' : 'multi_dispatch',
    permissionScope: permissionScopeForRound(round.permissionScope),
    ...(round.promptAppend ? { promptAppend: round.promptAppend } : {}),
    ...(round.timeoutMinutes ? { timeoutMs: round.timeoutMinutes * 60_000 } : {}),
    artifacts: round.permissionScope === 'artifact_generation'
      ? [{
        convention: round.preset === 'openspec_propose' ? 'openspec_convention' : 'explicit_paths',
        paths: round.artifactOutputs?.length ? [...round.artifactOutputs].sort() : ['openspec/changes'],
        permissionScope: 'artifact_generation',
        symlinkPolicy: 'reject_all',
      }]
      : [],
  }));

  const edges: P2pWorkflowEdgeDraft[] = [];
  for (let index = 0; index < rounds.length - 1; index += 1) {
    edges.push({
      id: `edge_${rounds[index]!.id}_to_${rounds[index + 1]!.id}`,
      fromNodeId: rounds[index]!.id,
      toNodeId: rounds[index + 1]!.id,
      edgeKind: 'default',
    });
  }
  const loopBudgets: Record<string, number> = {};
  for (const round of rounds) {
    if (!round.jumpRule) continue;
    const edgeId = `edge_${round.id}_to_${round.jumpRule.targetRoundId}_rework`;
    edges.push({
      id: edgeId,
      fromNodeId: round.id,
      toNodeId: round.jumpRule.targetRoundId,
      edgeKind: 'conditional',
      condition: {
        kind: 'verdict_marker_equals',
        equals: round.jumpRule.marker ?? 'REWORK',
      },
    });
    loopBudgets[edgeId] = round.jumpRule.maxTriggers;
  }

  return {
    schemaVersion: P2P_WORKFLOW_SCHEMA_VERSION,
    id: input.advancedPresetKey ? `old_${input.advancedPresetKey}` : 'old_custom_advanced',
    title: input.advancedPresetKey ? `Old advanced preset: ${input.advancedPresetKey}` : 'Old advanced workflow',
    nodes,
    edges,
    rootNodeId: nodes[0]!.id,
    variables: [],
    loopBudgets,
  };
}
