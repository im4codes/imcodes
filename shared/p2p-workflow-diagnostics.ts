export const P2P_WORKFLOW_DIAGNOSTIC_CODES = [
  'forbidden_envelope_field',
  'unsupported_schema_version',
  'unknown_future_schema_read_only',
  'mixed_advanced_schema_fields',
  'static_policy_mismatch_recompiled',
  'missing_required_capability',
  'capability_stale',
  'capability_downgraded_during_run',
  'invalid_launch_envelope',
  'invalid_workflow_graph',
  'invalid_routing_authority',
  'invalid_edge_condition',
  'loop_budget_exhausted',
  'invalid_workflow_variable',
  'invalid_prompt_append',
  'missing_context_source',
  'context_source_too_large',
  'unsafe_artifact_path',
  'artifact_identity_collision_resolved',
  'artifact_baseline_too_large',
  'artifact_baseline_mismatch',
  'artifact_contract_not_satisfied',
  'invalid_script_contract',
  'script_executable_denied',
  'script_machine_output_invalid',
  'script_timeout',
  'script_cancelled',
  'daemon_busy',
  'workflow_stale_after_restart',
  'private_projection_field_dropped',
  'legacy_progress_snapshot_sanitized',
  'unknown_p2p_message',
  /**
   * R3 v2 PR-η — envelope_compiled executor exit reason. Emitted when a
   * round's outgoing edges include conditional but NONE match the
   * round's route (script routingKey / verdict marker / logic marker)
   * AND no default edge exists. Defends against the v1b array-order
   * fallback that silently executed sibling nodes regardless of route.
   */
  'unmatched_edge_route',
] as const;

export type P2pWorkflowDiagnosticCode = (typeof P2P_WORKFLOW_DIAGNOSTIC_CODES)[number];

export const P2P_WORKFLOW_DIAGNOSTIC_PHASES = [
  'parse',
  'compile',
  'bind',
  'execute',
  'project',
  'sanitize',
  'server_ingress',
  'web_validate',
] as const;

export type P2pWorkflowDiagnosticPhase = (typeof P2P_WORKFLOW_DIAGNOSTIC_PHASES)[number];

export const P2P_WORKFLOW_DIAGNOSTIC_SEVERITIES = ['info', 'warning', 'error'] as const;
export type P2pWorkflowDiagnosticSeverity = (typeof P2P_WORKFLOW_DIAGNOSTIC_SEVERITIES)[number];

export interface P2pWorkflowDiagnostic {
  code: P2pWorkflowDiagnosticCode;
  phase: P2pWorkflowDiagnosticPhase;
  severity: P2pWorkflowDiagnosticSeverity;
  messageKey: `p2p.workflow.diagnostics.${P2pWorkflowDiagnosticCode}`;
  summary?: string;
  nodeId?: string;
  runId?: string;
  fieldPath?: string;
}

export const P2P_WORKFLOW_DIAGNOSTIC_PHASE_MATRIX: Record<P2pWorkflowDiagnosticCode, readonly P2pWorkflowDiagnosticPhase[]> = {
  forbidden_envelope_field: ['parse'],
  unsupported_schema_version: ['parse', 'web_validate'],
  unknown_future_schema_read_only: ['web_validate'],
  mixed_advanced_schema_fields: ['parse', 'web_validate'],
  static_policy_mismatch_recompiled: ['bind'],
  missing_required_capability: ['bind', 'execute', 'web_validate'],
  capability_stale: ['bind', 'web_validate'],
  capability_downgraded_during_run: ['execute'],
  invalid_launch_envelope: ['parse'],
  invalid_workflow_graph: ['compile'],
  invalid_routing_authority: ['compile'],
  invalid_edge_condition: ['compile'],
  loop_budget_exhausted: ['execute'],
  invalid_workflow_variable: ['compile', 'execute'],
  invalid_prompt_append: ['compile'],
  missing_context_source: ['bind', 'execute'],
  context_source_too_large: ['bind', 'execute'],
  unsafe_artifact_path: ['compile', 'bind', 'execute'],
  artifact_identity_collision_resolved: ['bind'],
  artifact_baseline_too_large: ['bind'],
  artifact_baseline_mismatch: ['execute'],
  artifact_contract_not_satisfied: ['execute'],
  invalid_script_contract: ['compile', 'bind'],
  script_executable_denied: ['bind', 'execute'],
  script_machine_output_invalid: ['execute'],
  script_timeout: ['execute'],
  script_cancelled: ['execute'],
  daemon_busy: ['bind'],
  workflow_stale_after_restart: ['bind', 'execute'],
  private_projection_field_dropped: ['sanitize'],
  legacy_progress_snapshot_sanitized: ['sanitize'],
  unknown_p2p_message: ['server_ingress'],
  unmatched_edge_route: ['execute'],
};

const WARNING_CODES = new Set<P2pWorkflowDiagnosticCode>([
  'artifact_identity_collision_resolved',
  'static_policy_mismatch_recompiled',
  'private_projection_field_dropped',
  'legacy_progress_snapshot_sanitized',
]);

export function makeP2pWorkflowDiagnostic(
  code: P2pWorkflowDiagnosticCode,
  phase?: P2pWorkflowDiagnosticPhase,
  extras: Omit<Partial<P2pWorkflowDiagnostic>, 'code' | 'phase' | 'messageKey' | 'severity'> = {},
): P2pWorkflowDiagnostic {
  const phases = P2P_WORKFLOW_DIAGNOSTIC_PHASE_MATRIX[code];
  const resolvedPhase = phase ?? phases[0];
  return {
    code,
    phase: resolvedPhase,
    severity: WARNING_CODES.has(code) ? 'warning' : 'error',
    messageKey: `p2p.workflow.diagnostics.${code}`,
    ...extras,
  };
}

export function makeP2pWorkflowWarning(
  code: P2pWorkflowDiagnosticCode,
  phase?: P2pWorkflowDiagnosticPhase,
  extras: Omit<Partial<P2pWorkflowDiagnostic>, 'code' | 'phase' | 'messageKey' | 'severity'> = {},
): P2pWorkflowDiagnostic {
  return {
    ...makeP2pWorkflowDiagnostic(code, phase, extras),
    severity: 'warning',
  };
}

export function assertP2pDiagnosticMatrixComplete(): void {
  for (const code of P2P_WORKFLOW_DIAGNOSTIC_CODES) {
    if (!P2P_WORKFLOW_DIAGNOSTIC_PHASE_MATRIX[code]?.length) {
      throw new Error(`Missing P2P workflow diagnostic phase mapping: ${code}`);
    }
  }
}
