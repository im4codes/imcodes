import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  MCP_TOOL_DISCOVERY_LIMITS,
  MCP_TOOL_DISCOVERY_NAME,
  MCP_TOOL_DISCOVERY_REASON,
  MCP_TOOL_DISCOVERY_STATUS,
  isDefaultActiveMcpTool,
} from '../../shared/mcp-tool-discovery.js';

export type RegisteredMcpToolCatalog = ReadonlyMap<string, RegisteredTool>;

const searchInput = z.strictObject({
  query: z.string().trim().min(1).max(MCP_TOOL_DISCOVERY_LIMITS.QUERY_CHARS)
    .describe('Tool name or task phrase, for example cron, pin message, remote machine, or capability install.'),
  activate: z.boolean().optional()
    .describe('Defaults to true. Activating replaces the previously exposed result set.'),
});

function compactDescription(value: string | undefined): string {
  if (!value) return '';
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length <= 180 ? singleLine : `${singleLine.slice(0, 177)}...`;
}

function matchScore(query: string, name: string, description: string): number {
  const normalizedName = name.toLowerCase();
  const normalizedDescription = description.toLowerCase();
  if (normalizedName === query) return 100;
  if (normalizedName.startsWith(query)) return 80;
  if (normalizedName.includes(query)) return 60;
  const tokens = query.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const matched = tokens.filter((token) => normalizedName.includes(token) || normalizedDescription.includes(token));
  return matched.length === tokens.length ? 20 + matched.length : 0;
}

/**
 * Keep one tiny bootstrap tool visible and hold every functional tool disabled
 * until a model asks for it. Enabling/disabling RegisteredTool handles emits
 * MCP tools/list_changed through the SDK, so clients receive the real schemas
 * only when they are useful.
 */
export function registerMcpToolDiscovery(
  server: McpServer,
  tools: RegisteredMcpToolCatalog,
): RegisteredTool {
  // Core tools stay live so an agent that never calls mcp_tool_search still
  // works. Only the long tail starts hidden.
  for (const [name, tool] of tools) {
    if (!isDefaultActiveMcpTool(name)) tool.disable();
  }

  return server.registerTool(MCP_TOOL_DISCOVERY_NAME, {
    description: 'Search and activate MCP tools on demand. Hidden tools do not consume the default model tool surface.',
    inputSchema: searchInput,
  }, async ({ query, activate }) => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      const result = {
        status: MCP_TOOL_DISCOVERY_STATUS.ERROR,
        reason: MCP_TOOL_DISCOVERY_REASON.VALIDATION_FAILED,
        error: 'query is required',
      };
      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }], isError: true };
    }

    const wildcard = normalizedQuery === '*';
    const candidates = tools.has(normalizedQuery)
      ? [[normalizedQuery, tools.get(normalizedQuery)!] as const]
      : [...tools.entries()];
    const matches = candidates
      .map(([name, tool]) => ({
        name,
        description: compactDescription(tool.description),
        score: wildcard ? 1 : matchScore(normalizedQuery, name, tool.description ?? ''),
      }))
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
      .slice(0, wildcard ? tools.size : MCP_TOOL_DISCOVERY_LIMITS.RESULTS);

    const shouldActivate = activate !== false;
    if (shouldActivate) {
      const nextActive = new Set(matches.map((match) => match.name));
      for (const [name, tool] of tools) {
        // `activate` replaces the discovered set, but it must not be able to
        // retire a core tool the caller is relying on mid-workflow.
        const shouldBeEnabled = nextActive.has(name) || isDefaultActiveMcpTool(name);
        if (shouldBeEnabled && !tool.enabled) tool.enable();
        if (!shouldBeEnabled && tool.enabled) tool.disable();
      }
    }

    const result = {
      status: MCP_TOOL_DISCOVERY_STATUS.OK,
      query,
      matches: matches.map((match) => ({
        name: match.name,
        description: match.description,
        active: tools.get(match.name)?.enabled === true,
      })),
      activated: shouldActivate ? matches.map((match) => match.name) : [],
    };
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
}
