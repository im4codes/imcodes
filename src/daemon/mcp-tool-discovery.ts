import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  MCP_TOOL_DISCOVERY_LIMITS,
  MCP_TOOL_DISCOVERY_DESCRIPTION,
  MCP_TOOL_GROUP_QUERY_PREFIX,
  MCP_TOOL_GROUPS,
  MCP_TOOL_DISCOVERY_NAME,
  MCP_TOOL_DISCOVERY_REASON,
  MCP_TOOL_DISCOVERY_STATUS,
  isDefaultActiveMcpTool,
} from '../../shared/mcp-tool-discovery.js';

export type RegisteredMcpToolCatalog = ReadonlyMap<string, RegisteredTool>;

const searchInput = z.strictObject({
  query: z.string().trim().min(1).max(MCP_TOOL_DISCOVERY_LIMITS.QUERY_CHARS)
    .describe('Tool name, task phrase, group:<id>, or * for the complete catalog.'),
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
  for (const [name, tool] of tools) tool.enabled = isDefaultActiveMcpTool(name);

  return server.registerTool(MCP_TOOL_DISCOVERY_NAME, {
    // This is the sole model-visible copy of the lazy-routing hint. Publishing
    // it as server instructions makes some hosts repeat it on every tool.
    description: MCP_TOOL_DISCOVERY_DESCRIPTION,
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
    const explicitGroupId = normalizedQuery.startsWith(MCP_TOOL_GROUP_QUERY_PREFIX)
      ? normalizedQuery.slice(MCP_TOOL_GROUP_QUERY_PREFIX.length)
      : null;
    if (explicitGroupId !== null && !MCP_TOOL_GROUPS.some((group) => group.id === explicitGroupId)) {
      const result = {
        status: MCP_TOOL_DISCOVERY_STATUS.ERROR,
        reason: MCP_TOOL_DISCOVERY_REASON.VALIDATION_FAILED,
        error: `unknown MCP tool group: ${explicitGroupId || '(empty)'}`,
      };
      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }], isError: true };
    }

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

    const groupMatches = MCP_TOOL_GROUPS
      .map((group) => ({
        group,
        score: wildcard
          ? 1
          : explicitGroupId === group.id
            ? 100
            : matchScore(normalizedQuery, group.id, group.summary),
      }))
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score || left.group.id.localeCompare(right.group.id));

    const shouldActivate = activate !== false;
    const groupToolNames = groupMatches.flatMap(({ group }) => group.tools.filter((name) => tools.has(name)));
    const activatedNames = [...new Set([
      ...matches.map((match) => match.name),
      ...groupToolNames,
    ])];
    if (shouldActivate) {
      const nextActive = new Set(activatedNames);
      let changed = false;
      for (const [name, tool] of tools) {
        // `activate` replaces the discovered set, but it must not be able to
        // retire a core tool the caller is relying on mid-workflow.
        const shouldBeEnabled = nextActive.has(name) || isDefaultActiveMcpTool(name);
        if (tool.enabled !== shouldBeEnabled) {
          // Mutate the registered handles as one transaction, then publish one
          // tools/list_changed notification for the complete authoritative set.
          tool.enabled = shouldBeEnabled;
          changed = true;
        }
      }
      if (changed) server.sendToolListChanged();
    }

    const result = {
      status: MCP_TOOL_DISCOVERY_STATUS.OK,
      query,
      matches: matches.map((match) => ({
        name: match.name,
        description: match.description,
        active: tools.get(match.name)?.enabled === true,
      })),
      groups: groupMatches.map(({ group }) => {
        const registeredTools = group.tools.filter((name) => tools.has(name));
        return {
          id: group.id,
          name: group.id,
          summary: group.summary,
          toolCount: registeredTools.length,
          tools: registeredTools,
          active: registeredTools.length > 0
            && registeredTools.every((name) => tools.get(name)?.enabled === true),
        };
      }),
      activatedGroups: shouldActivate ? groupMatches.map(({ group }) => group.id) : [],
      activated: shouldActivate ? activatedNames : [],
    };
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
}
