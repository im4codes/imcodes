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
  let registered = false;

  pi.on('session_start', async () => {
    if (client || registered) return;
    const nextClient = new Client({ name: 'imcodes-pi-mcp', version: '0.1.0' });
    const nextTransport = new StdioClientTransport({
      command: mcp.command,
      args: mcp.args,
      env: mcp.env,
      stderr: 'pipe',
    });
    try {
      await nextClient.connect(nextTransport);
      const catalog = await nextClient.listTools();
      client = nextClient;
      for (const tool of catalog.tools) {
        pi.registerTool({
          name: tool.name,
          label: tool.title ?? tool.name,
          description: tool.description ?? tool.name,
          // Pi/TypeBox accepts JSON Schema-compatible TSchema values. The MCP
          // contract already provides a standards-compliant object schema.
          parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
          async execute(_toolCallId, params, signal) {
            if (!client) throw new Error('IM.codes MCP connection is unavailable');
            const response = await client.callTool(
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
            return { content: blocks, details: response.structuredContent };
          },
        });
      }
      registered = true;
    } catch {
      await nextClient.close().catch(() => {});
      client = null;
      // MCP is additive. A local MCP startup failure must not prevent Pi from
      // serving the user's model turn with its built-in coding tools.
    }
  });

  pi.on('session_shutdown', async () => {
    const active = client;
    client = null;
    if (active) await active.close().catch(() => {});
  });
}
