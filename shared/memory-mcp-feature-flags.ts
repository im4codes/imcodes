export const MCP_FEATURE_FLAGS_BY_NAME = {
  memorySurface: 'mem.feature.mcp_surface',
  sendDispatch: 'send.feature.mcp_dispatch',
  cronRead: 'cron.feature.mcp_read',
  cronWrite: 'cron.feature.mcp_write',
} as const;

export type MCPFeatureFlag = (typeof MCP_FEATURE_FLAGS_BY_NAME)[keyof typeof MCP_FEATURE_FLAGS_BY_NAME];

export type MCPFeatureFlagValues = Partial<Record<MCPFeatureFlag, boolean>>;

export function isMcpFeatureEnabled(values: MCPFeatureFlagValues | undefined, flag: MCPFeatureFlag): boolean {
  return values?.[flag] !== false;
}
