export const MCP_ERROR_REASONS = {
  INVALID_NAMESPACE: 'invalid_namespace',
  FEATURE_DISABLED: 'feature_disabled',
  IDENTITY_REJECTED: 'identity_rejected',
  WRITE_QUOTA_EXCEEDED: 'write_quota_exceeded',
  SCOPE_FORBIDDEN: 'scope_forbidden',
  PROJECTION_UNAVAILABLE: 'projection_unavailable',
  VALIDATION_FAILED: 'validation_failed',
  RATE_LIMITED: 'rate_limited',
  INTERNAL_ERROR: 'internal_error',
  // Machine remote-exec tool surface (list_machines / exec_remote). A typed
  // reason for each way a target can be unusable, so the agent tool never
  // returns an ad-hoc string (controlled-node-remote-exec 10.12).
  MACHINE_NOT_FOUND: 'machine_not_found',
  MACHINE_AMBIGUOUS: 'machine_ambiguous',
  EXEC_OFFLINE: 'exec_offline',
  EXEC_DISABLED: 'exec_disabled',
} as const;

export type MCPErrorReason = (typeof MCP_ERROR_REASONS)[keyof typeof MCP_ERROR_REASONS];

export const RECOVERABLE_MCP_ERROR_REASONS: ReadonlySet<MCPErrorReason> = new Set([
  MCP_ERROR_REASONS.FEATURE_DISABLED,
  MCP_ERROR_REASONS.PROJECTION_UNAVAILABLE,
  MCP_ERROR_REASONS.RATE_LIMITED,
]);

export function isRecoverableMcpErrorReason(reason: unknown): reason is MCPErrorReason {
  return RECOVERABLE_MCP_ERROR_REASONS.has(reason as MCPErrorReason);
}
