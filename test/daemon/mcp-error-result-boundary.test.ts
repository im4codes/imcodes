import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { installMcpErrorResultBoundary } from '../../src/daemon/mcp-error-result-boundary.js';
import { registerMcpToolDiscovery } from '../../src/daemon/mcp-tool-discovery.js';
import { buildMcpErrorResult } from '../../shared/memory-mcp-contracts.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../shared/mcp-tool-discovery.js';

const NAME = 'test_typed_boundary';
const refusal = buildMcpErrorResult(MCP_ERROR_REASONS.SCOPE_FORBIDDEN, 'owner permission required');
const typed = z.strictObject({ status: z.literal('ok'), count: z.number().int() });
const result = (structuredContent: Record<string, unknown>, isError = false): CallToolResult => ({
  structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }], isError,
});

async function exercise(opts: { adapt?: boolean; output?: z.ZodType; response: CallToolResult }, run: (client: Client) => Promise<void>) {
  const server = new McpServer({ name: NAME, version: '1' });
  if (opts.adapt !== false) { installMcpErrorResultBoundary(server); installMcpErrorResultBoundary(server); }
  const registered = server.registerTool(NAME, { inputSchema: z.strictObject({}), ...(opts.output ? { outputSchema: opts.output } : {}) }, () => opts.response);
  registerMcpToolDiscovery(server, new Map([[NAME, registered]]));
  const client = new Client({ name: `${NAME}-client`, version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: NAME } });
    await client.listTools();
    await run(client);
  } finally { await client.close(); await server.close(); }
}
const direct = { name: NAME, arguments: {} };
const fallback = { name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: NAME, fallbackCall: direct } };

describe('shared schema-aware error boundary with real SDK output validators', () => {
  it('the unadapted counterexample throws -32602, the adapted refusal is usable', async () => {
    await exercise({ adapt: false, output: typed, response: result(refusal, true) }, async (client) => {
      await expect(client.callTool(direct)).rejects.toMatchObject({ code: -32602 });
    });
    await exercise({ output: typed, response: result(refusal, true) }, async (client) => {
      for (const request of [direct, fallback]) {
        const response = await client.callTool(request);
        expect(response.isError).toBe(true);
        expect(response.structuredContent).toBeUndefined();
        expect(response.content).toEqual(result(refusal, true).content);
      }
    });
  });

  it('preserves schema-compatible errors and untyped tool results exactly', async () => {
    for (const output of [z.strictObject({ status: z.literal('error'), reason: z.string(), message: z.string(), recoverable: z.boolean() }), undefined]) {
      const response = result(refusal, true);
      await exercise({ output, response }, async (client) => {
        for (const request of [direct, fallback]) expect(await client.callTool(request)).toEqual(response);
      });
    }
  });

  it('keeps valid successes structured and does not repair or weaken malformed success', async () => {
    await exercise({ output: typed, response: result({ status: 'ok', count: 7 }) }, async (client) => {
      for (const request of [direct, fallback]) expect((await client.callTool(request)).structuredContent).toEqual({ status: 'ok', count: 7 });
    });
    await exercise({ output: typed, response: result({ status: 'ok', count: 'not-a-number' }) }, async (client) => {
      const response = await client.callTool(direct);
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).toContain('Output validation error');
      const fallbackResponse = await client.callTool(fallback);
      expect(fallbackResponse.isError).toBe(true);
      expect(JSON.stringify(fallbackResponse)).toContain('fallback tool output failed validation');
    });
  });

  it('adds parseable typed text if an error handler emitted only a human message', async () => {
    const response = { ...result(refusal, true), content: [{ type: 'text' as const, text: 'short message' }] };
    await exercise({ output: typed, response }, async (client) => {
      const adapted = await client.callTool(direct);
      expect(adapted.content).toEqual([...response.content, ...result(refusal, true).content]);
      expect(adapted.isError).toBe(true);
      expect(adapted.structuredContent).toBeUndefined();
    });
  });
});
