import { describe, expect, it } from 'vitest';
import { materializeOldAdvancedConfigToWorkflowDraft } from '../../shared/p2p-workflow-materialize.js';

describe('p2p workflow old advanced materialization', () => {
  it('materializes the built-in openspec preset deterministically', () => {
    const first = materializeOldAdvancedConfigToWorkflowDraft({ advancedPresetKey: 'openspec' });
    const second = materializeOldAdvancedConfigToWorkflowDraft({ advancedPresetKey: 'openspec' });

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(1);
    expect(first.nodes.map((node) => node.preset)).toEqual([
      'discuss',
      'openspec_propose',
      'proposal_audit',
      'implementation',
      'implementation_audit',
    ]);
    expect(first.loopBudgets).toEqual({ edge_implementation_audit_to_implementation_rework: 2 });
  });

  it('materializes custom old rounds into a visible draft chain', () => {
    const draft = materializeOldAdvancedConfigToWorkflowDraft({
      advancedRounds: [
        {
          id: 'a',
          title: 'A',
          preset: 'custom',
          executionMode: 'single_main',
          permissionScope: 'analysis_only',
        },
        {
          id: 'b',
          title: 'B',
          preset: 'custom',
          executionMode: 'multi_dispatch',
          permissionScope: 'artifact_generation',
          artifactOutputs: ['openspec/changes/demo/proposal.md'],
        },
      ],
    });

    expect(draft.rootNodeId).toBe('a');
    expect(draft.edges).toEqual([{ id: 'edge_a_to_b', fromNodeId: 'a', toNodeId: 'b', edgeKind: 'default' }]);
    expect(draft.nodes[1]?.artifacts?.[0]?.paths).toEqual(['openspec/changes/demo/proposal.md']);
  });
});
