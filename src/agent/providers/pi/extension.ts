/**
 * IM.codes integration extension loaded into the external Pi RPC process.
 *
 * It performs two narrowly scoped jobs:
 *  1. register the selected ccPreset as a Pi provider/model, and
 *  2. expose the session-bound IM.codes MCP server as ordinary Pi tools.
 *
 * Credentials/config arrive only through the child environment. The provider
 * adapter never writes API keys or MCP identity material to Pi settings files.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  PI_MCP_CONFIG_ENV,
  PI_PROVIDER_API_KEY_ENV,
  PI_PROVIDER_CONFIG_ENV,
  type PiLlmConfig,
} from '../../../../shared/pi-agent.js';
import { McpToolCatalog, type McpToolCatalogSnapshot } from '../../mcp-tool-catalog.js';

interface PiExtensionApi {
  registerProvider(name: string, config: Record<string, unknown>): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<{ content: Array<Record<string, unknown>>; details?: unknown }>;
  }): void;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
  on(event: string, handler: (...args: unknown[]) => unknown): void;
}

interface PiMcpConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function parseEnvJson<T>(name: string): T | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function textContent(text: string): Array<Record<string, unknown>> {
  return [{ type: 'text', text }];
}

function normalizeMcpContent(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return textContent(JSON.stringify(value ?? null));
  const result: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      result.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      result.push({ type: 'image', data: block.data, mimeType: block.mimeType });
    } else {
      // Pi tools accept text/image blocks. Preserve other MCP content types as
      // bounded JSON text instead of silently discarding a resource or link.
      result.push({ type: 'text', text: JSON.stringify(block) });
    }
  }
  return result.length > 0 ? result : textContent('MCP tool returned no content.');
}

function registerPublishedTools(
  pi: PiExtensionApi,
  snapshot: McpToolCatalogSnapshot,
  knownMcpTools: Set<string>,
  getClient: () => Client | null,
  getCatalog: () => McpToolCatalog | null,
  rememberPublicationQuery: (query: string) => void,
): void {
  const previouslyKnown = new Set(knownMcpTools);
  for (const tool of snapshot.tools) {
    knownMcpTools.add(tool.name);
    pi.registerTool({
      name: tool.name,
      label: tool.title ?? tool.name,
      description: tool.description ?? tool.name,
      // Pi/TypeBox accepts JSON Schema-compatible TSchema values. The MCP
      // contract already provides a standards-compliant object schema.
      parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      async execute(_toolCallId, params, signal) {
        const activeClient = getClient();
        const activeTool = getCatalog()?.getTool(tool.name);
        if (!activeClient || !activeTool) throw new Error(`IM.codes MCP tool ${tool.name} is not callable`);
        const response = await activeClient.callTool(
          { name: tool.name, arguments: params },
          undefined,
          signal ? { signal } : undefined,
        );
        const blocks = normalizeMcpContent(response.content);
        if (response.isError) {
          const message = blocks
            .filter((block) => block.type === 'text')
            .map((block) => String(block.text ?? ''))
            .join('\n') || `MCP tool ${tool.name} failed`;
          throw new Error(message);
        }
        if (tool.name === 'mcp_tool_search'
          && typeof params.query === 'string'
          && params.activate !== false) {
          const normalizedQuery = params.query.trim().toLowerCase();
          const published = response.structuredContent
            && typeof response.structuredContent === 'object'
            && Array.isArray((response.structuredContent as Record<string, unknown>).published)
              ? (response.structuredContent as { published: unknown[] }).published
              : [];
          const isExactSelector = normalizedQuery.startsWith('group:')
            || published.some((name) => typeof name === 'string' && name.toLowerCase() === normalizedQuery);
          // Reconnect replays only a bounded selector. Never retain a free-text
          // preview or fallback arguments/execution across authority contexts.
          if (isExactSelector && params.fallbackCall === undefined) {
            rememberPublicationQuery(params.query.trim());
          }
          // Hosts must not wait for a future turn merely because their
          // notification delivery races the tool result. Force the same
          // connection's complete catalog refresh before this search call
          // returns to Pi's agent loop.
          await getCatalog()?.refresh('discovery-call');
        }
        return { content: blocks, details: response.structuredContent };
      },
    });
  }

  // registerTool refreshes Pi's registry even during an active agent loop.
  // Replace the active MCP subset only after the complete MCP generation is
  // registered, so add/update/remove/rename is model-visible atomically. This
  // is also the permission reset boundary for removed or schema-changed tools.
  const activeNonMcp = pi.getActiveTools().filter((name) => !previouslyKnown.has(name) && !knownMcpTools.has(name));
  pi.setActiveTools(snapshot.ready
    ? [...activeNonMcp, ...snapshot.tools.map((tool) => tool.name)]
    : activeNonMcp);
}

export default async function imcodesPiExtension(pi: PiExtensionApi): Promise<void> {
  const provider = parseEnvJson<PiLlmConfig>(PI_PROVIDER_CONFIG_ENV);
  if (provider?.provider && provider.model) {
    pi.registerProvider(provider.provider, {
      name: provider.provider,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      apiKey: `$${PI_PROVIDER_API_KEY_ENV}`,
      api: 'anthropic-messages',
      models: [{
        id: provider.model,
        name: provider.model,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: provider.contextWindow ?? 200_000,
        maxTokens: provider.maxTokens ?? 32_768,
      }],
    });
  }

  const mcp = parseEnvJson<PiMcpConfig>(PI_MCP_CONFIG_ENV);
  if (!mcp?.command) return;

  let client: Client | null = null;
  let catalog: McpToolCatalog | null = null;
  const knownMcpTools = new Set<string>();
  let lastPublicationQuery: string | null = null;

  pi.on('session_start', async () => {
    if (client) return;
    const nextClient = new Client({ name: 'imcodes-pi-mcp', version: '0.1.0' });
    const nextTransport = new StdioClientTransport({
      command: mcp.command,
      args: mcp.args,
      env: mcp.env,
      stderr: 'pipe',
    });
    try {
      await nextClient.connect(nextTransport);
      client = nextClient;
      const nextCatalog = new McpToolCatalog({
        publish: (snapshot) => registerPublishedTools(
          pi,
          snapshot,
          knownMcpTools,
          () => client,
          () => catalog,
          (query) => { lastPublicationQuery = query; },
        ),
      });
      catalog = nextCatalog;
      await nextCatalog.connect(nextClient);

      // A new stdio process starts with the bounded bootstrap view. Replay only
      // the last exact discovery selector (never fallback arguments/execution),
      // then force a complete refresh so a missed notification cannot strand
      // the reconnected model on a stale schema generation.
      if (lastPublicationQuery) {
        await nextClient.callTool({
          name: 'mcp_tool_search',
          arguments: { query: lastPublicationQuery },
        });
        await nextCatalog.refresh('reconnect-publication');
      }
    } catch {
      catalog?.disconnect();
      catalog = null;
      await nextClient.close().catch(() => {});
      client = null;
      // MCP is additive. A local MCP startup failure must not prevent Pi from
      // serving the user's model turn with its built-in coding tools.
    }
  });

  pi.on('session_shutdown', async () => {
    const active = client;
    client = null;
    catalog?.disconnect();
    catalog = null;
    if (active) await active.close().catch(() => {});
  });
}
