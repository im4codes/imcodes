/**
 * Audit fix (e940d73f-a8e / N5) — validator diagnostic fieldPath
 * specificity. Pins the contract that
 * `validateNodeCombination()` produces field-precise paths so the
 * inspector can pinpoint the broken dropdown instead of surfacing a
 * cryptic `nodes[N] invalid`.
 */
import { describe, expect, it } from 'vitest';
import { validateP2pWorkflowDraft } from '../../shared/p2p-workflow-validators.js';
import type { P2pWorkflowDraft } from '../../shared/p2p-workflow-types.js';

const wrap = (node: P2pWorkflowDraft['nodes'][number]): P2pWorkflowDraft => ({
  schemaVersion: 1,
  id: 'wf-1',
  nodes: [node],
  edges: [],
  rootNodeId: node.id,
});

describe('validateNodeCombination diagnostic fieldPath specificity (N5)', () => {
  it('logic + non-custom preset → fieldPath ends in .preset', () => {
    const draft = wrap({ id: 'n', title: 'n', nodeKind: 'logic', preset: 'discuss', permissionScope: 'analysis_only' });
    const { ok, diagnostics } = validateP2pWorkflowDraft(draft);
    expect(ok).toBe(false);
    const presetDiag = diagnostics.find((d) => d.fieldPath?.endsWith('.preset'));
    expect(presetDiag).toBeTruthy();
    expect(presetDiag?.fieldPath).toBe('nodes[0].preset');
  });

  it('logic + non-analysis_only scope → fieldPath ends in .permissionScope', () => {
    const draft = wrap({ id: 'n', title: 'n', nodeKind: 'logic', preset: 'custom', permissionScope: 'implementation' });
    const { ok, diagnostics } = validateP2pWorkflowDraft(draft);
    expect(ok).toBe(false);
    const scopeDiag = diagnostics.find((d) => d.fieldPath?.endsWith('.permissionScope'));
    expect(scopeDiag).toBeTruthy();
    expect(scopeDiag?.fieldPath).toBe('nodes[0].permissionScope');
  });

  it('logic with BOTH preset+scope wrong → two distinct diagnostics', () => {
    const draft = wrap({ id: 'n', title: 'n', nodeKind: 'logic', preset: 'discuss', permissionScope: 'implementation' });
    const { ok, diagnostics } = validateP2pWorkflowDraft(draft);
    expect(ok).toBe(false);
    const fieldPaths = diagnostics
      .map((d) => d.fieldPath)
      .filter((p): p is string => !!p);
    expect(fieldPaths).toEqual(expect.arrayContaining(['nodes[0].preset', 'nodes[0].permissionScope']));
  });

  it('script + non-custom preset → fieldPath ends in .preset', () => {
    const draft = wrap({ id: 'n', title: 'n', nodeKind: 'script', preset: 'discuss', permissionScope: 'analysis_only' });
    const { ok, diagnostics } = validateP2pWorkflowDraft(draft);
    expect(ok).toBe(false);
    const presetDiag = diagnostics.find((d) => d.fieldPath?.endsWith('.preset'));
    expect(presetDiag).toBeTruthy();
    expect(presetDiag?.fieldPath).toBe('nodes[0].preset');
  });

  it('llm with valid combination produces zero combination diagnostics', () => {
    const draft = wrap({ id: 'n', title: 'n', nodeKind: 'llm', preset: 'discuss', permissionScope: 'analysis_only' });
    const { ok } = validateP2pWorkflowDraft(draft);
    expect(ok).toBe(true);
  });

  it('openspec_propose missing artifact reports artifacts fieldPath', () => {
    const draft = wrap({
      id: 'n', title: 'n', nodeKind: 'llm', preset: 'openspec_propose',
      permissionScope: 'artifact_generation', artifacts: [],
    });
    const { ok, diagnostics } = validateP2pWorkflowDraft(draft);
    expect(ok).toBe(false);
    const artifactDiag = diagnostics.find((d) => d.fieldPath?.endsWith('.artifacts'));
    expect(artifactDiag).toBeTruthy();
    expect(artifactDiag?.fieldPath).toBe('nodes[0].artifacts');
  });
});
