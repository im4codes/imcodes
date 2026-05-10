import {
  P2P_WORKFLOW_CAPABILITY_V1,
  P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1,
  P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1,
  P2P_WORKFLOW_SCHEMA_VERSION,
  P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
  P2P_WORKFLOW_SCRIPT_INTERPRETER_CAPABILITY_V1,
} from './p2p-workflow-constants.js';
import { makeP2pWorkflowDiagnostic, type P2pWorkflowDiagnostic } from './p2p-workflow-diagnostics.js';
import { hashP2pStaticPolicy, stableHash, stableStringify } from './p2p-workflow-policy.js';
import type {
  P2pCompiledNode,
  P2pCompiledWorkflow,
  P2pRoutingAuthority,
  P2pStaticPolicy,
  P2pWorkflowDraft,
  P2pWorkflowEdgeDraft,
  P2pWorkflowNodeDraft,
} from './p2p-workflow-types.js';
import { validateP2pWorkflowDraft, validateP2pWorkflowVariables } from './p2p-workflow-validators.js';
import { validateP2pLogicContract } from './p2p-workflow-logic-evaluator.js';

export type P2pWorkflowCompileResult =
  | { ok: true; workflow: P2pCompiledWorkflow; diagnostics: P2pWorkflowDiagnostic[] }
  | { ok: false; diagnostics: P2pWorkflowDiagnostic[] };

export function compileP2pWorkflowDraft(draft: P2pWorkflowDraft, staticPolicy: P2pStaticPolicy): P2pWorkflowCompileResult {
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  const draftValidation = validateP2pWorkflowDraft(draft);
  diagnostics.push(...draftValidation.diagnostics);
  if (!draftValidation.ok) return { ok: false, diagnostics };

  if (draft.nodes.length > staticPolicy.maxNodes || draft.edges.length > staticPolicy.maxEdges) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { summary: 'Workflow exceeds static policy size limits.' }));
  }

  diagnostics.push(...validateGraphShape(draft));
  diagnostics.push(...validateP2pWorkflowVariables(draft.variables ?? []));
  diagnostics.push(...validateLoopBudgets(draft));
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { ok: false, diagnostics };
  }

  const nodes = [...draft.nodes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((node) => compileNode(node, draft.edges));
  const edges = [...draft.edges].sort((left, right) => left.id.localeCompare(right.id));
  const variables = [...(draft.variables ?? [])].sort((left, right) => left.name.localeCompare(right.name));
  const staticPolicyHash = hashP2pStaticPolicy(staticPolicy);
  const derivedRequiredCapabilities = deriveRequiredCapabilities(nodes);
  const rootNodeId = draft.rootNodeId ?? findRootNodeId(draft)!;
  const contractInput = {
    schemaVersion: P2P_WORKFLOW_SCHEMA_VERSION,
    workflowId: draft.id,
    rootNodeId,
    nodes,
    edges,
    variables,
    loopBudgets: sortedRecord(draft.loopBudgets ?? {}),
    derivedRequiredCapabilities,
    staticPolicyHash,
  };
  const workflow: P2pCompiledWorkflow = {
    ...contractInput,
    diagnostics: [],
    workflowContractHash: stableHash(stableStringify(contractInput)),
  };
  return { ok: true, workflow, diagnostics };
}

function compileNode(node: P2pWorkflowNodeDraft, edges: P2pWorkflowEdgeDraft[]): P2pCompiledNode {
  return {
    id: node.id,
    ...(node.title ? { title: node.title } : {}),
    nodeKind: node.nodeKind,
    preset: node.preset,
    ...(node.dispatchStyle ? { dispatchStyle: node.dispatchStyle } : {}),
    permissionScope: node.permissionScope ?? 'analysis_only',
    ...(node.promptAppend ? { promptAppend: node.promptAppend } : {}),
    routingAuthority: node.routingAuthority ?? deriveRoutingAuthority(node, edges),
    ...(node.script ? { script: node.script } : {}),
    // R3 v1b follow-up — pass logic contract through unchanged so the
    // executor can evaluate it against the run's variable state.
    ...(node.logic ? { logic: node.logic } : {}),
    artifacts: [...(node.artifacts ?? [])],
  };
}

function deriveRoutingAuthority(node: P2pWorkflowNodeDraft, edges: P2pWorkflowEdgeDraft[]): P2pRoutingAuthority {
  const conditionalEdges = edges.filter((edge) => edge.fromNodeId === node.id && edge.edgeKind === 'conditional');
  if (conditionalEdges.length === 0) return { kind: 'none' };
  if (node.nodeKind === 'script') {
    return {
      kind: 'script_routing_key',
      allowedKeys: conditionalEdges.map((edge) => edge.condition?.equals).filter((value): value is string => !!value).sort(),
    };
  }
  if (node.nodeKind === 'logic') {
    return {
      kind: 'logic_marker',
      allowedMarkers: conditionalEdges.map((edge) => edge.condition?.equals).filter((value): value is string => !!value).sort(),
    };
  }
  return {
    kind: 'audit_verdict_marker',
    allowedMarkers: conditionalEdges.map((edge) => edge.condition?.equals).filter((value): value is string => !!value).sort(),
  };
}

function deriveRequiredCapabilities(nodes: P2pCompiledNode[]): string[] {
  const capabilities = new Set<string>([P2P_WORKFLOW_CAPABILITY_V1]);
  // Audit:R3 PR-β / V-5 — script nodes always require argv capability; nodes
  // with `commandKind: 'interpreter'` ADDITIONALLY require the interpreter
  // capability. Spec `Interpreter script requires interpreter capability`
  // scenario; daemon must advertise BOTH caps to bind such workflows.
  if (nodes.some((node) => node.nodeKind === 'script')) capabilities.add(P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1);
  if (nodes.some((node) => node.nodeKind === 'script' && node.script?.commandKind === 'interpreter')) {
    capabilities.add(P2P_WORKFLOW_SCRIPT_INTERPRETER_CAPABILITY_V1);
  }
  if (nodes.some((node) => node.artifacts.some((artifact) => artifact.convention === 'openspec_convention'))) {
    capabilities.add(P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1);
  }
  if (nodes.some((node) => node.permissionScope === 'implementation')) capabilities.add(P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1);
  return [...capabilities].sort();
}

function validateGraphShape(draft: P2pWorkflowDraft): P2pWorkflowDiagnostic[] {
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  const nodeIds = new Set<string>();
  // R3 v2 PR-ζ (Cx1-A3 / O1-a / ζ-15) — A workflow MAY declare at most
  // one `openspec_convention` artifact contract. The daemon's
  // `runArtifactRootCache` keys by `runId` only and `getOrFreezeRunArtifactRoot`
  // takes the first matching contract; multi-contract workflows would
  // silently use the first node's frozen identity for every other
  // node's verify step. Reject at compile time so authors see the
  // problem immediately instead of debugging false missing-file
  // diagnostics later.
  const openspecNodeIds = draft.nodes
    .filter((node) => Array.isArray(node.artifacts) && node.artifacts.some((artifact) => artifact.convention === 'openspec_convention'))
    .map((node) => node.id);
  if (openspecNodeIds.length > 1) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', {
      summary: `At most one node may declare an openspec_convention artifact contract per workflow (found: ${openspecNodeIds.join(', ')}).`,
    }));
  }
  for (const node of draft.nodes) {
    if (nodeIds.has(node.id)) diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: `nodes.${node.id}`, summary: 'Duplicate node id.' }));
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of draft.edges) {
    if (edgeIds.has(edge.id)) diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: `edges.${edge.id}`, summary: 'Duplicate edge id.' }));
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: `edges.${edge.id}`, summary: 'Edge points to missing node.' }));
    }
  }
  const rootNodeId = draft.rootNodeId ?? findRootNodeId(draft);
  if (!rootNodeId || !nodeIds.has(rootNodeId)) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: 'rootNodeId', summary: 'Workflow must have exactly one root.' }));
  }
  for (const node of draft.nodes) {
    // R3 v1b follow-up — logic node MUST declare a `logic` contract; non-logic
    // nodes MUST NOT carry one (the executor only evaluates `logic` for
    // `nodeKind === 'logic'`).
    if (node.nodeKind === 'logic') {
      if (!node.logic) {
        diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', {
          fieldPath: `nodes.${node.id}.logic`,
          summary: 'Logic node MUST declare a `logic` contract.',
        }));
      } else {
        for (const issue of validateP2pLogicContract(node.logic, `nodes.${node.id}.logic`)) {
          diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', {
            fieldPath: issue.fieldPath,
            summary: issue.summary,
          }));
        }
      }
    } else if (node.logic !== undefined) {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', {
        fieldPath: `nodes.${node.id}.logic`,
        summary: 'Only nodeKind: \'logic\' nodes may declare a `logic` contract.',
      }));
    }
    const defaultOutgoing = draft.edges.filter((edge) => edge.fromNodeId === node.id && edge.edgeKind === 'default');
    if (defaultOutgoing.length > 1) {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: `nodes.${node.id}`, summary: 'Multiple default edges are not supported.' }));
    }
    const conditionalOutgoing = draft.edges.filter((edge) => edge.fromNodeId === node.id && edge.edgeKind === 'conditional');
    if (conditionalOutgoing.length > 0) {
      // R3 PR-γ (W4) — v1 cap: at most ONE conditional outgoing edge per
      // node. The legacy adapter projection (`compiledWorkflowToLegacyAdvancedRounds`)
      // only carries a single `jumpRule` per round so additional conditional
      // edges would be silently dropped on the legacy executor; the new
      // envelope_compiled executor (PR-β) walks `compiled.edges` directly
      // but selects the FIRST matching condition. Either way the v1
      // semantics require uniqueness — the compiler enforces it here so
      // authoring tools fail closed instead of silently misrouting.
      if (conditionalOutgoing.length > 1) {
        diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', {
          fieldPath: `nodes.${node.id}`,
          summary: `Multiple conditional outgoing edges (${conditionalOutgoing.length}) are not supported in v1; declare at most one per node.`,
        }));
      }
      const authority = node.routingAuthority ?? deriveRoutingAuthority(node, draft.edges);
      if (authority.kind === 'none') {
        diagnostics.push(makeP2pWorkflowDiagnostic('invalid_routing_authority', 'compile', { fieldPath: `nodes.${node.id}.routingAuthority` }));
      }
      for (const edge of conditionalOutgoing) {
        if (!edge.condition) {
          diagnostics.push(makeP2pWorkflowDiagnostic('invalid_edge_condition', 'compile', { fieldPath: `edges.${edge.id}.condition` }));
        }
      }
    }
  }
  if (rootNodeId) {
    const reachable = collectReachable(rootNodeId, draft.edges);
    for (const node of draft.nodes) {
      if (!reachable.has(node.id)) {
        diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: `nodes.${node.id}`, summary: 'Unreachable node.' }));
      }
    }
  }
  return diagnostics;
}

function findRootNodeId(draft: P2pWorkflowDraft): string | null {
  if (draft.rootNodeId) return draft.rootNodeId;
  const targets = new Set(draft.edges.map((edge) => edge.toNodeId));
  const roots = draft.nodes.map((node) => node.id).filter((id) => !targets.has(id));
  return roots.length === 1 ? roots[0]! : null;
}

function collectReachable(rootNodeId: string, edges: P2pWorkflowEdgeDraft[]): Set<string> {
  const reachable = new Set<string>([rootNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (reachable.has(edge.fromNodeId) && !reachable.has(edge.toNodeId)) {
        reachable.add(edge.toNodeId);
        changed = true;
      }
    }
  }
  return reachable;
}

function validateLoopBudgets(draft: P2pWorkflowDraft): P2pWorkflowDiagnostic[] {
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  const nodeOrder = new Map(draft.nodes.map((node, index) => [node.id, index]));
  for (const edge of draft.edges) {
    const fromIndex = nodeOrder.get(edge.fromNodeId);
    const toIndex = nodeOrder.get(edge.toNodeId);
    if (fromIndex === undefined || toIndex === undefined) continue;
    if (toIndex <= fromIndex && draft.loopBudgets?.[edge.id] === undefined) {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: `loopBudgets.${edge.id}`, summary: 'Backward edges require edge-scoped loop budgets.' }));
    }
    const budget = draft.loopBudgets?.[edge.id];
    if (budget !== undefined && (!Number.isInteger(budget) || budget < 0)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: `loopBudgets.${edge.id}`, summary: 'Loop budget must be a non-negative integer.' }));
    }
  }
  for (const key of Object.keys(draft.loopBudgets ?? {})) {
    if (!draft.edges.some((edge) => edge.id === key)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'compile', { fieldPath: `loopBudgets.${key}`, summary: 'Loop budgets must be keyed by edge id.' }));
    }
  }
  return diagnostics;
}

function sortedRecord(input: Record<string, number>): Record<string, number> {
  const output: Record<string, number> = {};
  for (const key of Object.keys(input).sort()) output[key] = input[key]!;
  return output;
}
