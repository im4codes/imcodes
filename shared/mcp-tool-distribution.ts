import type { SessionAgentType } from './agent-types.js';

/** Canonical shared contract for every IM.codes MCP-consuming runtime. */
export const MCP_TOOL_DISTRIBUTION_CONTRACT_VERSION = 1 as const;

export const MCP_TOOL_CATALOG_LIMITS = Object.freeze({
  PAGES: 64,
  TOOLS: 1_024,
});

export type McpToolHostDelivery =
  | 'shared_catalog_with_exact_fallback'
  | 'host_refresh_with_exact_fallback'
  | 'external_config_with_exact_fallback'
  | 'not_applicable';

export interface McpToolDistributionContract {
  agentType: SessionAgentType;
  delivery: McpToolHostDelivery;
  managedMcp: boolean;
  backendToolsAlreadyActive: true;
  boundedPublication: true;
  directCallRequiresPublishedSchema: true;
  exactFallback: boolean;
  reconnectColdHydration: boolean;
  boundary: 'managed_mcp' | 'external_mcp_config' | 'gateway_native' | 'raw_command';
}

interface McpToolRuntimeBoundary {
  delivery: McpToolHostDelivery;
  boundary: McpToolDistributionContract['boundary'];
}

/**
 * Exhaustive runtime census. `satisfies Record<SessionAgentType, ...>` makes a
 * newly-added provider a compile-time decision instead of silently inheriting
 * a provider-specific default.
 *
 * OpenClaw is gateway-native in this repository and does not mount the
 * IM.codes MCP server. Raw shell/script sessions have no tool host. The four
 * process CLIs consume this same server only when their own MCP configuration
 * mounts it; daemon publication/fallback semantics stay provider-neutral.
 */
export const MCP_TOOL_RUNTIME_BOUNDARIES = Object.freeze({
  'claude-code-sdk': { delivery: 'host_refresh_with_exact_fallback', boundary: 'managed_mcp' },
  'claude-code': { delivery: 'external_config_with_exact_fallback', boundary: 'external_mcp_config' },
  'codex-sdk': { delivery: 'host_refresh_with_exact_fallback', boundary: 'managed_mcp' },
  'qoder-sdk': { delivery: 'host_refresh_with_exact_fallback', boundary: 'managed_mcp' },
  codex: { delivery: 'external_config_with_exact_fallback', boundary: 'external_mcp_config' },
  'copilot-sdk': { delivery: 'host_refresh_with_exact_fallback', boundary: 'managed_mcp' },
  'cursor-headless': { delivery: 'host_refresh_with_exact_fallback', boundary: 'managed_mcp' },
  'opencode-sdk': { delivery: 'host_refresh_with_exact_fallback', boundary: 'managed_mcp' },
  opencode: { delivery: 'external_config_with_exact_fallback', boundary: 'external_mcp_config' },
  'gemini-sdk': { delivery: 'host_refresh_with_exact_fallback', boundary: 'managed_mcp' },
  'grok-sdk': { delivery: 'host_refresh_with_exact_fallback', boundary: 'managed_mcp' },
  gemini: { delivery: 'external_config_with_exact_fallback', boundary: 'external_mcp_config' },
  qwen: { delivery: 'host_refresh_with_exact_fallback', boundary: 'managed_mcp' },
  openclaw: { delivery: 'not_applicable', boundary: 'gateway_native' },
  'kimi-sdk': { delivery: 'host_refresh_with_exact_fallback', boundary: 'managed_mcp' },
  'hermes-acp': { delivery: 'host_refresh_with_exact_fallback', boundary: 'managed_mcp' },
  'deepseek-harness': { delivery: 'host_refresh_with_exact_fallback', boundary: 'managed_mcp' },
  pi: { delivery: 'shared_catalog_with_exact_fallback', boundary: 'managed_mcp' },
  'codebuddy-cn': { delivery: 'host_refresh_with_exact_fallback', boundary: 'managed_mcp' },
  'codebuddy-international': { delivery: 'host_refresh_with_exact_fallback', boundary: 'managed_mcp' },
  shell: { delivery: 'not_applicable', boundary: 'raw_command' },
  script: { delivery: 'not_applicable', boundary: 'raw_command' },
} as const satisfies Record<SessionAgentType, McpToolRuntimeBoundary>);

/**
 * This is a delivery classification, never an activation or authorization
 * table. All registered backend tools are already active. A runtime either
 * observes a complete same-connection catalog generation or invokes one exact
 * registered target through mcp_tool_search's original-schema fallback.
 */
export function getMcpToolDistributionContract(agentType: SessionAgentType): McpToolDistributionContract {
  const { delivery, boundary } = MCP_TOOL_RUNTIME_BOUNDARIES[agentType];
  const applies = delivery !== 'not_applicable';
  return Object.freeze({
    agentType,
    delivery,
    managedMcp: boundary === 'managed_mcp',
    backendToolsAlreadyActive: true,
    boundedPublication: true,
    directCallRequiresPublishedSchema: true,
    exactFallback: applies,
    reconnectColdHydration: applies,
    boundary,
  });
}

/**
 * Tracked model/developer guidance shared by process and transport runtimes.
 * Keep this provider-neutral: external hosts may support live refresh, while
 * the exact wrapper fallback is the safe same-turn path when they do not.
 */
export const MCP_TOOL_DISCOVERY_REFRESH_INSTRUCTIONS = [
  'All registered IM.codes MCP tools and backing services are already backend-active; discovery changes only a bounded callable-schema view and never installs, enables, authorizes, or grants authority.',
  'notifications/tools/list_changed is invalidation only: a supporting host must force a complete paginated tools/list refetch on the same connection and atomically replace its callable catalog, including the current model turn.',
  'A fresh or resumed connection is callable-ready only after a validated complete tools/list generation; missing generation requires cold hydration before direct calls.',
  'If the exact selected tool is absent from the host schema, call mcp_tool_search again with that exact tool name and fallbackCall { name, arguments }; the wrapper invokes only that registered tool through its original validation and authority handler.',
  'For OCU, Open Computer Use, computer use, or computer control requests, never infer unavailability from the initial callable list: search the exact alias ocu to publish the bounded file-transfer-computer-use group, then use computer_use_docs or computer_use_call; if either schema is still absent in the current turn, invoke that exact tool through mcp_tool_search fallbackCall.',
  'Unknown or unregistered names, caller-supplied schemas, wildcard/prefix fallback, and full long-tail publication must fail closed.',
].join(' ');

export const MCP_TOOL_DISCOVERY_DESCRIPTION =
  'Use mcp_tool_search for one exact IM.codes tool/group. All are backend-active. After list_changed refetch every tools/list page; if the target stays absent, call again with exact fallbackCall { name, arguments }.';
