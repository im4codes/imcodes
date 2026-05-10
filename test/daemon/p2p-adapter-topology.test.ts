/**
 * PR-α (A1 / A2 / W3 / Cu1-N3) — adapter regression tests.
 *
 * Lock the post-fix invariants of `compiledWorkflowToLegacyAdvancedRounds`
 * + the helper trio (`orderCompiledNodesForExecution`,
 * `mapCompiledNodeToLegacyRound`, `mapConditionalEdgeToJumpRule`):
 *
 * - Topological traversal honours `rootNodeId` + DEFAULT edges, not lexical
 *   id ordering (A2).
 * - `nodeKind` / `script` / `routingAuthority` / `artifactConvention`
 *   propagate through the adapter (A1 / W3).
 * - Conditional-edge mapping preserves the raw marker for `PASS|REWORK` and
 *   only compresses non-{PASS,REWORK} markers to `REWORK` (A8 limit).
 * - Each helper is independently invocable, supporting unit-level review
 *   (Cu1-N3).
 */

import { describe, expect, it } from 'vitest';
import type {
  P2pCompiledNode,
  P2pCompiledWorkflow,
  P2pScriptNodeContract,
} from '../../shared/p2p-workflow-types.js';
import {
  mapCompiledNodeToLegacyRound,
  mapConditionalEdgeToJumpRule,
  orderCompiledNodesForExecution,
} from '../../src/daemon/command-handler.js';

function buildScriptContract(overrides: Partial<P2pScriptNodeContract> = {}): P2pScriptNodeContract {
  return {
    commandKind: 'argv',
    argv: ['/usr/bin/jq', '.'],
    timeoutMs: 5_000,
    requireMachineOutput: true,
    declaresArtifacts: false,
    declaresVariables: false,
    ...overrides,
  } as P2pScriptNodeContract;
}

function buildCompiledNode(overrides: Partial<P2pCompiledNode> = {}): P2pCompiledNode {
  return {
    id: 'node',
    title: 'Node',
    nodeKind: 'llm',
    preset: 'discussion',
    permissionScope: 'analysis_only',
    artifacts: [],
    routingAuthority: { kind: 'none' },
    ...overrides,
  } as P2pCompiledNode;
}

describe('orderCompiledNodesForExecution (A2 / W3)', () => {
  it('walks rootNodeId then DEFAULT edges, not lexical id order', () => {
    const workflow: P2pCompiledWorkflow = {
      schemaVersion: 1,
      workflowId: 'wf',
      rootNodeId: 'zzz-root',
      nodes: [
        buildCompiledNode({ id: 'aaa-helper' }),
        buildCompiledNode({ id: 'bbb-helper' }),
        buildCompiledNode({ id: 'zzz-root' }),
      ],
      edges: [
        { id: 'edge-1', fromNodeId: 'zzz-root', toNodeId: 'aaa-helper', edgeKind: 'default' },
        { id: 'edge-2', fromNodeId: 'aaa-helper', toNodeId: 'bbb-helper', edgeKind: 'default' },
      ],
      variables: [],
      loopBudgets: {},
      derivedRequiredCapabilities: [],
      staticPolicyHash: 'h',
      workflowContractHash: 'c',
      diagnostics: [],
    };
    const ordered = orderCompiledNodesForExecution(workflow);
    expect(ordered.map((n) => n.id)).toEqual(['zzz-root', 'aaa-helper', 'bbb-helper']);
  });

  it('appends unreachable nodes in declaration order so legacy projection still surfaces them', () => {
    const workflow: P2pCompiledWorkflow = {
      schemaVersion: 1,
      workflowId: 'wf',
      rootNodeId: 'root',
      nodes: [
        buildCompiledNode({ id: 'root' }),
        buildCompiledNode({ id: 'orphan-z' }),
        buildCompiledNode({ id: 'orphan-a' }),
      ],
      edges: [],
      variables: [],
      loopBudgets: {},
      derivedRequiredCapabilities: [],
      staticPolicyHash: 'h',
      workflowContractHash: 'c',
      diagnostics: [],
    };
    const ordered = orderCompiledNodesForExecution(workflow);
    expect(ordered.map((n) => n.id)).toEqual(['root', 'orphan-z', 'orphan-a']);
  });
});

describe('mapCompiledNodeToLegacyRound (A1 / W3)', () => {
  const baseWorkflow: P2pCompiledWorkflow = {
    schemaVersion: 1,
    workflowId: 'wf',
    rootNodeId: 'node',
    nodes: [],
    edges: [],
    variables: [],
    loopBudgets: {},
    derivedRequiredCapabilities: [],
    staticPolicyHash: 'h',
    workflowContractHash: 'c',
    diagnostics: [],
  };

  it('preserves nodeKind / script / routingAuthority on the legacy carrier', () => {
    const script = buildScriptContract();
    const compiled = buildCompiledNode({
      id: 'node',
      nodeKind: 'script',
      script,
      routingAuthority: { kind: 'script_routing_key', allowedKeys: ['go-review', 'finish'] },
    });
    const round = mapCompiledNodeToLegacyRound(compiled, { ...baseWorkflow, nodes: [compiled] });
    expect(round.nodeKind).toBe('script');
    expect(round.script).toBe(script);
    expect(round.routingAuthority).toEqual({ kind: 'script_routing_key', allowedKeys: ['go-review', 'finish'] });
  });

  it('preserves artifactConvention from the FIRST artifact contract (W3)', () => {
    const compiled = buildCompiledNode({
      id: 'node',
      artifacts: [{ convention: 'explicit', paths: ['proposal.md'] }] as P2pCompiledNode['artifacts'],
    });
    const round = mapCompiledNodeToLegacyRound(compiled, { ...baseWorkflow, nodes: [compiled] });
    expect(round.artifactConvention).toBe('explicit');
  });

  /*
   * R3 v2 PR-μ — Adapter must populate `effectiveSummaryPrompt` from
   * either the user's override or the per-preset default. Empty /
   * whitespace-only overrides are treated as "use default".
   */
  it('R3 v2 PR-μ — uses summaryPromptOverride when the user set one', () => {
    const compiled = buildCompiledNode({
      id: 'node',
      preset: 'implementation' as P2pCompiledNode['preset'],
      summaryPromptOverride: 'Custom summary by user',
    });
    const round = mapCompiledNodeToLegacyRound(compiled, { ...baseWorkflow, nodes: [compiled] });
    expect(round.effectiveSummaryPrompt).toBe('Custom summary by user');
  });

  it('R3 v2 PR-μ — falls back to P2P_PRESET_DEFAULT_SUMMARY_PROMPT when no override', () => {
    const compiled = buildCompiledNode({
      id: 'node',
      preset: 'implementation' as P2pCompiledNode['preset'],
    });
    const round = mapCompiledNodeToLegacyRound(compiled, { ...baseWorkflow, nodes: [compiled] });
    // Default for `implementation` is non-empty and starts with the
    // structured "Implementation Summary" header.
    expect(round.effectiveSummaryPrompt).toBeTruthy();
    expect(round.effectiveSummaryPrompt!).toMatch(/Implementation Summary/);
  });

  it('R3 v2 PR-μ — whitespace-only override falls back to default', () => {
    const compiled = buildCompiledNode({
      id: 'node',
      preset: 'audit' as P2pCompiledNode['preset'],
      summaryPromptOverride: '   \n   ',
    });
    const round = mapCompiledNodeToLegacyRound(compiled, { ...baseWorkflow, nodes: [compiled] });
    // Default for `audit` is the structured "Audit Report" prompt, not whitespace.
    expect(round.effectiveSummaryPrompt!).toMatch(/Audit Report/);
  });
});

describe('mapConditionalEdgeToJumpRule (A8 / Cu1-N3)', () => {
  it('returns none + undefined jumpRule when no conditional edge', () => {
    const result = mapConditionalEdgeToJumpRule(undefined, {});
    expect(result.verdictPolicy).toBe('none');
    expect(result.jumpRule).toBeUndefined();
  });

  it('preserves PASS marker', () => {
    const result = mapConditionalEdgeToJumpRule(
      { id: 'edge-1', fromNodeId: 'a', toNodeId: 'b', edgeKind: 'conditional', condition: { kind: 'verdict_marker_equals', equals: 'PASS' } },
      { 'edge-1': 3 },
    );
    expect(result.verdictPolicy).toBe('forced_rework');
    expect(result.jumpRule).toEqual({ targetRoundId: 'b', marker: 'PASS', minTriggers: 0, maxTriggers: 3 });
  });

  it('compresses non-PASS markers to REWORK at the legacy boundary (A8 documented limit)', () => {
    const result = mapConditionalEdgeToJumpRule(
      { id: 'edge-1', fromNodeId: 'a', toNodeId: 'b', edgeKind: 'conditional', condition: { kind: 'verdict_marker_equals', equals: 'INVESTIGATE' } },
      { 'edge-1': 1 },
    );
    expect(result.jumpRule?.marker).toBe('REWORK');
  });

  it('emits forced_rework without jumpRule when loopBudget is missing', () => {
    const result = mapConditionalEdgeToJumpRule(
      { id: 'edge-1', fromNodeId: 'a', toNodeId: 'b', edgeKind: 'conditional', condition: { kind: 'verdict_marker_equals', equals: 'PASS' } },
      {},
    );
    expect(result.verdictPolicy).toBe('forced_rework');
    expect(result.jumpRule).toBeUndefined();
  });
});
