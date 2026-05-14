import { describe, expect, it } from 'vitest';
import { compileP2pWorkflowDraft } from '../../shared/p2p-workflow-compiler.js';
import { buildDefaultP2pStaticPolicy, hashP2pStaticPolicy } from '../../shared/p2p-workflow-policy.js';
import type { P2pWorkflowDraft } from '../../shared/p2p-workflow-types.js';

const policy = buildDefaultP2pStaticPolicy({ allowOpenSpecArtifacts: true, allowImplementationPermission: true });

describe('p2p workflow compiler', () => {
  it('compiles deterministic workflow contracts', () => {
    const draft: P2pWorkflowDraft = {
      schemaVersion: 1,
      id: 'wf',
      rootNodeId: 'start',
      nodes: [
        { id: 'start', nodeKind: 'llm', preset: 'audit', permissionScope: 'analysis_only' },
        {
          id: 'impl',
          nodeKind: 'llm',
          preset: 'implementation',
          permissionScope: 'implementation',
          artifacts: [{ convention: 'openspec_convention', paths: ['openspec/changes/demo'], symlinkPolicy: 'reject_all' }],
        },
      ],
      edges: [{ id: 'edge_start_impl', fromNodeId: 'start', toNodeId: 'impl', edgeKind: 'default' }],
      variables: [{ name: 'topic', value: 'demo' }],
    };

    const first = compileP2pWorkflowDraft(draft, policy);
    const second = compileP2pWorkflowDraft(draft, policy);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.workflow).toEqual(second.workflow);
      expect(first.workflow.staticPolicyHash).toBe(hashP2pStaticPolicy(policy));
      expect(first.workflow.derivedRequiredCapabilities).toEqual([
        'p2p.workflow.implementation.v1',
        'p2p.workflow.openspec-artifacts.v1',
        'p2p.workflow.v1',
      ]);
    }
  });

  it('rejects duplicate nodes, unreachable nodes, and multiple default edges', () => {
    const result = compileP2pWorkflowDraft({
      schemaVersion: 1,
      id: 'bad',
      rootNodeId: 'a',
      nodes: [
        { id: 'a', nodeKind: 'llm', preset: 'audit' },
        { id: 'b', nodeKind: 'llm', preset: 'review' },
        { id: 'c', nodeKind: 'llm', preset: 'plan' },
        { id: 'c', nodeKind: 'llm', preset: 'plan' },
      ],
      edges: [
        { id: 'ab', fromNodeId: 'a', toNodeId: 'b', edgeKind: 'default' },
        { id: 'ac', fromNodeId: 'a', toNodeId: 'c', edgeKind: 'default' },
      ],
    }, policy);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('invalid_workflow_graph');
  });

  it('requires edge-scoped loop budgets for backward edges', () => {
    const base: P2pWorkflowDraft = {
      schemaVersion: 1,
      id: 'loop',
      rootNodeId: 'a',
      nodes: [
        { id: 'a', nodeKind: 'llm', preset: 'audit' },
        { id: 'b', nodeKind: 'llm', preset: 'implementation_audit' },
      ],
      edges: [
        { id: 'ab', fromNodeId: 'a', toNodeId: 'b', edgeKind: 'default' },
        { id: 'ba', fromNodeId: 'b', toNodeId: 'a', edgeKind: 'conditional', condition: { kind: 'verdict_marker_equals', equals: 'REWORK' } },
      ],
    };
    expect(compileP2pWorkflowDraft(base, policy).ok).toBe(false);
    expect(compileP2pWorkflowDraft({ ...base, loopBudgets: { ba: 2 } }, policy).ok).toBe(true);
  });

  // R3 PR-γ (W4) — multiple conditional outgoing edges from the same node
  // are rejected at compile time. Both the legacy adapter (`jumpRule`
  // single-slot) and the new envelope_compiled executor (first-match wins)
  // would otherwise silently misroute. Author-time failure beats run-time
  // surprise.
  it('rejects more than one conditional outgoing edge per node (PR-γ W4)', () => {
    const draft: P2pWorkflowDraft = {
      schemaVersion: 1,
      id: 'multi-cond',
      rootNodeId: 'a',
      nodes: [
        { id: 'a', nodeKind: 'llm', preset: 'audit', routingAuthority: { kind: 'audit_verdict_marker', allowedMarkers: ['PASS', 'REWORK'] } },
        { id: 'b', nodeKind: 'llm', preset: 'audit' },
        { id: 'c', nodeKind: 'llm', preset: 'audit' },
      ],
      edges: [
        { id: 'ab', fromNodeId: 'a', toNodeId: 'b', edgeKind: 'conditional', condition: { kind: 'verdict_marker_equals', equals: 'PASS' } },
        { id: 'ac', fromNodeId: 'a', toNodeId: 'c', edgeKind: 'conditional', condition: { kind: 'verdict_marker_equals', equals: 'REWORK' } },
      ],
      loopBudgets: { ab: 1, ac: 1 },
    };
    const result = compileP2pWorkflowDraft(draft, policy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.diagnostics.map((d) => d.code);
      expect(codes).toContain('invalid_workflow_graph');
      const conditionalDiagnostic = result.diagnostics.find((d) => /conditional outgoing/i.test(d.summary ?? ''));
      expect(conditionalDiagnostic).toBeDefined();
      expect(conditionalDiagnostic?.fieldPath).toBe('nodes.a');
    }
  });

  it('accepts exactly one conditional outgoing edge per node (PR-γ W4 baseline)', () => {
    const draft: P2pWorkflowDraft = {
      schemaVersion: 1,
      id: 'single-cond',
      rootNodeId: 'a',
      nodes: [
        { id: 'a', nodeKind: 'llm', preset: 'audit', routingAuthority: { kind: 'audit_verdict_marker', allowedMarkers: ['PASS'] } },
        { id: 'b', nodeKind: 'llm', preset: 'audit' },
      ],
      edges: [
        { id: 'ab', fromNodeId: 'a', toNodeId: 'b', edgeKind: 'conditional', condition: { kind: 'verdict_marker_equals', equals: 'PASS' } },
      ],
      loopBudgets: { ab: 2 },
    };
    expect(compileP2pWorkflowDraft(draft, policy).ok).toBe(true);
  });

  // R3 v1b follow-up — logic node contract. Logic nodes MUST use
  // `preset: 'custom'` + `permissionScope: 'analysis_only'` per the
  // existing `validateNodeCombination` rule.
  it('rejects logic node missing a `logic` contract', () => {
    const draft: P2pWorkflowDraft = {
      schemaVersion: 1,
      id: 'logic-missing',
      rootNodeId: 'l',
      nodes: [{ id: 'l', nodeKind: 'logic', preset: 'custom', permissionScope: 'analysis_only' }],
      edges: [],
    };
    const result = compileP2pWorkflowDraft(draft, policy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: 'invalid_workflow_graph',
        fieldPath: 'nodes.l.logic',
      }));
    }
  });

  it('rejects non-logic node carrying a `logic` contract (only nodeKind: logic may declare one)', () => {
    const draft: P2pWorkflowDraft = {
      schemaVersion: 1,
      id: 'logic-on-llm',
      rootNodeId: 'a',
      nodes: [{
        id: 'a',
        nodeKind: 'llm',
        preset: 'discuss',
        permissionScope: 'analysis_only',
        logic: { rules: [], default: 'fallback' },
      }],
      edges: [],
    };
    const result = compileP2pWorkflowDraft(draft, policy);
    expect(result.ok).toBe(false);
  });

  it('compiles a logic node with a valid contract and propagates it through to compiled.nodes', () => {
    const draft: P2pWorkflowDraft = {
      schemaVersion: 1,
      id: 'logic-ok',
      rootNodeId: 'l',
      nodes: [{
        id: 'l',
        nodeKind: 'logic',
        preset: 'custom',
        permissionScope: 'analysis_only',
        routingAuthority: { kind: 'logic_marker', allowedMarkers: ['go', 'rework'] },
        logic: {
          rules: [
            { if: { kind: 'variable_equals', name: 'verdict', equals: 'pass' }, emit: 'go' },
          ],
          default: 'rework',
        },
      }],
      edges: [],
    };
    const result = compileP2pWorkflowDraft(draft, policy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const node = result.workflow.nodes.find((n) => n.id === 'l');
      expect(node?.logic?.default).toBe('rework');
      expect(node?.logic?.rules).toHaveLength(1);
    }
  });
});
