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
