import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeObjectSchema, safeParseAsync } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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
import logger from '../util/logger.js';

export type RegisteredMcpToolCatalog = ReadonlyMap<string, RegisteredTool>;

const searchInput = z.strictObject({
  query: z.string().trim().min(1).max(MCP_TOOL_DISCOVERY_LIMITS.QUERY_CHARS)
    .describe('Exact tool name, task phrase, or group:<id>.'),
  activate: z.boolean().optional()
    .describe('Legacy name; defaults true and publishes a bounded schema view without changing service activation.'),
  // Kept as one compact map so the always-visible bootstrap schema remains
  // inside its hard byte budget. Runtime validation below still requires the
  // exact { name, arguments } shape before invoking an authoritative handler.
  fallbackCall: z.record(z.string(), z.unknown()).optional(),
});

type CallableRegisteredTool = (
  args: unknown,
  extra: unknown,
) => CallToolResult | Promise<CallToolResult>;

type ZeroArgumentRegisteredTool = (
  extra: unknown,
) => CallToolResult | Promise<CallToolResult>;

function discoveryError(error: string) {
  const result = {
    status: MCP_TOOL_DISCOVERY_STATUS.ERROR,
    reason: MCP_TOOL_DISCOVERY_REASON.VALIDATION_FAILED,
    error,
  };
  return { structuredContent: result, content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
}

async function invokeFallbackTool(
  tool: RegisteredTool,
  argumentsValue: Record<string, unknown>,
  extra: unknown,
): Promise<CallToolResult> {
  if (!tool.enabled || typeof tool.handler !== 'function') {
    return discoveryError('fallback tool is not callable');
  }

  let result: CallToolResult;
  if (tool.inputSchema) {
    const schema = normalizeObjectSchema(tool.inputSchema) ?? tool.inputSchema;
    const parsed = await safeParseAsync(schema, argumentsValue);
    if (!parsed.success) {
      return discoveryError('fallback tool arguments failed validation');
    }
    result = await (tool.handler as CallableRegisteredTool)(parsed.data, extra);
  } else {
    if (Object.keys(argumentsValue).length > 0) {
      return discoveryError('fallback tool arguments failed validation');
    }
    result = await (tool.handler as ZeroArgumentRegisteredTool)(extra);
  }

  // Direct fallback must preserve the same output-schema boundary as the
  // SDK's ordinary tools/call route. Error results intentionally skip output
  // validation, exactly as the SDK does; successful typed tools must provide
  // schema-valid structuredContent before anything reaches the model.
  if (tool.outputSchema && !result.isError) {
    if (!result.structuredContent) {
      return discoveryError('fallback tool output failed validation');
    }
    const schema = normalizeObjectSchema(tool.outputSchema) ?? tool.outputSchema;
    const parsed = await safeParseAsync(schema, result.structuredContent);
    if (!parsed.success) {
      return discoveryError('fallback tool output failed validation');
    }
  }
  return result;
}

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

function normalizeGroupAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Keep one tiny bootstrap surface visible while every registered tool remains
 * service-active. RegisteredTool.enabled is used only as this connection's
 * bounded schema-publication switch; it is not capability activation,
 * installation, eligibility, or authority. Discovery republishes
 * tools/list_changed even for an unchanged selection so a host that missed an
 * earlier notification (or rehydrated a connection) can refresh the real
 * callable schemas without exposing the full catalog.
 */
export function registerMcpToolDiscovery(
  server: McpServer,
  tools: RegisteredMcpToolCatalog,
): RegisteredTool {
  // Core schemas stay published so an agent that never calls mcp_tool_search
  // still works. Long-tail services are already active/registered; only their
  // per-connection schema publication starts hidden.
  for (const [name, tool] of tools) tool.enabled = isDefaultActiveMcpTool(name);
  let catalogGeneration = 1;

  return server.registerTool(MCP_TOOL_DISCOVERY_NAME, {
    // This is the sole model-visible copy of the lazy-routing hint. Publishing
    // it as server instructions makes some hosts repeat it on every tool.
    description: MCP_TOOL_DISCOVERY_DESCRIPTION,
    inputSchema: searchInput,
  }, async ({ query, activate, fallbackCall }, extra) => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      const result = {
        status: MCP_TOOL_DISCOVERY_STATUS.ERROR,
        reason: MCP_TOOL_DISCOVERY_REASON.VALIDATION_FAILED,
        error: 'query is required',
      };
      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }], isError: true };
    }

    if (normalizedQuery === '*') {
      return discoveryError('wildcard MCP tool discovery is not supported; query one exact tool or group');
    }
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
    const normalizedGroupAlias = normalizeGroupAlias(normalizedQuery);
    const aliasedGroup = explicitGroupId === null
      ? MCP_TOOL_GROUPS.find((group) => group.aliases?.some(
          (alias) => normalizeGroupAlias(alias) === normalizedGroupAlias,
        )) ?? null
      : null;

    const candidates = tools.has(normalizedQuery)
      ? [[normalizedQuery, tools.get(normalizedQuery)!] as const]
      : [...tools.entries()];
    const matches = candidates
      .map(([name, tool]) => ({
        name,
        description: compactDescription(tool.description),
        score: matchScore(normalizedQuery, name, tool.description ?? ''),
      }))
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
      .slice(0, MCP_TOOL_DISCOVERY_LIMITS.RESULTS);

    const groupMatches = MCP_TOOL_GROUPS
      .map((group) => ({
        group,
        score: explicitGroupId === group.id
            ? 100
            : group === aliasedGroup
              ? 100
              : matchScore(normalizedQuery, group.id, `${group.summary} ${(group.aliases ?? []).join(' ')}`),
      }))
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score || left.group.id.localeCompare(right.group.id));

    const shouldPublish = activate !== false;
    // Free-text discovery is preview-only except for an exact, predeclared
    // group alias. Publication remains limited to one canonical exact tool or
    // one bounded group; arbitrary phrases can never become a long-tail
    // wildcard.
    const exactToolName = tools.has(normalizedQuery) ? normalizedQuery : null;
    const exactGroup = explicitGroupId === null
      ? aliasedGroup
      : MCP_TOOL_GROUPS.find((group) => group.id === explicitGroupId) ?? null;
    const publishedNames = exactToolName
      ? [exactToolName]
      : exactGroup
        ? exactGroup.tools.filter((name) => tools.has(name))
        : [];
    const publishedGroupIds = exactGroup && publishedNames.length > 0 ? [exactGroup.id] : [];
    if (shouldPublish) {
      const nextPublished = new Set(publishedNames);
      for (const [name, tool] of tools) {
        // The legacy `activate` input replaces only this connection's
        // published tail. It never changes whether a registered service/tool
        // is active or authorized, and it cannot retire a core schema.
        const shouldBeEnabled = nextPublished.has(name) || isDefaultActiveMcpTool(name);
        if (tool.enabled !== shouldBeEnabled) {
          // Mutate the registered handles as one publication transaction.
          tool.enabled = shouldBeEnabled;
        }
      }
      // Always re-emit for a non-empty legitimate selection. A host may have
      // missed the previous notification even though the service was already
      // active and the server-side publication state is unchanged.
      if (publishedNames.length > 0) {
        catalogGeneration += 1;
        server.sendToolListChanged();
      }
    }

    if (fallbackCall) {
      const fallbackName = typeof fallbackCall.name === 'string' ? fallbackCall.name.trim() : '';
      const fallbackArguments = fallbackCall.arguments === undefined
        ? {}
        : fallbackCall.arguments;
      const fallbackKeys = Object.keys(fallbackCall);
      const exactTool = tools.get(fallbackName);
      if (!shouldPublish
        || normalizedQuery !== fallbackName.toLowerCase()
        || !exactTool
        || !publishedNames.includes(fallbackName)
        || !exactTool.enabled
        || fallbackKeys.some((key) => key !== 'name' && key !== 'arguments')
        || !fallbackKeys.includes('name')
        || typeof fallbackArguments !== 'object'
        || fallbackArguments === null
        || Array.isArray(fallbackArguments)) {
        return discoveryError('fallbackCall requires one exact registered tool query with activation enabled');
      }
      logger.info({ wrapper: MCP_TOOL_DISCOVERY_NAME, target: fallbackName }, 'MCP exact fallback invocation');
      return invokeFallbackTool(exactTool, fallbackArguments as Record<string, unknown>, extra);
    }

    const result = {
      status: MCP_TOOL_DISCOVERY_STATUS.OK,
      query,
      matches: matches.map((match) => ({
        name: match.name,
        description: match.description,
        // Registration proves service activity/availability. Publication is
        // deliberately reported separately so callers never mistake schema
        // visibility for capability activation.
        active: true,
        published: tools.get(match.name)?.enabled === true,
        direct: tools.get(match.name)?.enabled === true,
      })),
      groups: groupMatches.map(({ group }) => {
        const registeredTools = group.tools.filter((name) => tools.has(name));
        return {
          id: group.id,
          name: group.id,
          selector: `${MCP_TOOL_GROUP_QUERY_PREFIX}${group.id}`,
          summary: group.summary,
          toolCount: registeredTools.length,
          tools: registeredTools,
          active: registeredTools.length > 0,
          published: registeredTools.length > 0
            && registeredTools.every((name) => tools.get(name)?.enabled === true),
          direct: registeredTools.length > 0
            && registeredTools.every((name) => tools.get(name)?.enabled === true),
        };
      }),
      // Compatibility aliases retained on the wire. They mean selected for
      // schema publication, never service/capability activation.
      activatedGroups: shouldPublish ? publishedGroupIds : [],
      activated: shouldPublish ? publishedNames : [],
      publishedGroups: shouldPublish ? publishedGroupIds : [],
      published: shouldPublish ? publishedNames : [],
      catalogGeneration,
    };
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
}
