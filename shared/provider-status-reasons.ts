export const PROVIDER_STATUS_REASON = {
  PROVIDER_NOT_CONNECTED: 'provider_not_connected',
  QODER_RUNTIME_MISSING: 'qoder_runtime_missing',
  QODER_RUNTIME_INCOMPATIBLE: 'qoder_runtime_incompatible',
  QODER_AUTH_MISSING: 'qoder_auth_missing',
  QODER_AUTH_FAILED: 'qoder_auth_failed',
  QODER_MCP_IDENTITY_MISSING: 'qoder_mcp_identity_missing',
  QODER_MCP_STATUS_UNAVAILABLE: 'qoder_mcp_status_unavailable',
  QODER_UNPROVEN_CAPABILITY: 'qoder_unproven_capability',
  QODER_CONFIG_REJECTED: 'qoder_config_rejected',
  QODER_SUPPLY_CHAIN_PRECHECK_FAILED: 'qoder_supply_chain_precheck_failed',
} as const;

export type ProviderStatusReason =
  (typeof PROVIDER_STATUS_REASON)[keyof typeof PROVIDER_STATUS_REASON];
