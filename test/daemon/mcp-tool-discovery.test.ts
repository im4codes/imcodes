import { describe, expect, it, vi } from 'vitest';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { registerMcpToolDiscovery } from '../../src/daemon/mcp-tool-discovery.js';
import { MCP_TOOL_CATALOG_MODES, type McpToolCatalogMode } from '../../shared/mcp-tool-discovery.js';

function registeredTool(input: {
  name: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  handler: (...args: any[]) => any;
}): RegisteredTool {
  return {
    name: input.name,
    title: input.name,
    description: input.name,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    handler: input.handler,
    enabled: true,
    enable() { this.enabled = true; },
    disable() { this.enabled = false; },
    update() {},
    remove() {},
  } as RegisteredTool;
}

function harness(targets: RegisteredTool[], catalogMode?: McpToolCatalogMode) {
  let discovery: RegisteredTool | undefined;
  const sendToolListChanged = vi.fn();
  const server = {
    registerTool(name: string, config: Record<string, unknown>, handler: (...args: any[]) => any) {
      discovery = registeredTool({ name, ...config, handler });
      return discovery;
    },
    sendToolListChanged,
  } as unknown as McpServer;
  const tools = new Map(targets.map((tool) => [tool.name, tool]));
  registerMcpToolDiscovery(server, tools, { catalogMode });
  return {
    sendToolListChanged,
    call: (args: Record<string, unknown>, extra: unknown = {}) => (
      (discovery!.handler as (...handlerArgs: any[]) => any)(args, extra)
    ),
  };
}

describe('exact MCP discovery fallback', () => {
  it('keeps every registered schema initially callable for static standard-MCP hosts', async () => {
    const targets = ['core_visible', 'long_tail_one', 'long_tail_two'].map((name) => registeredTool({
      name,
      inputSchema: z.object({ value: z.string() }).strict(),
      handler: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
    }));
    const { call, sendToolListChanged } = harness(targets, MCP_TOOL_CATALOG_MODES.STATIC_FULL);

    expect(targets.every((tool) => tool.enabled)).toBe(true);
    await call({ query: 'long_tail_one' });
    await call({ query: 'unrelated fuzzy preview' });
    expect(targets.every((tool) => tool.enabled)).toBe(true);
    expect(sendToolListChanged).not.toHaveBeenCalled();
  });

  it('publishes only the bounded computer-use group for exact OCU aliases', async () => {
    const names = [
      MEMORY_MCP_TOOL_NAMES.SEND_FILE_TO_MACHINE,
      MEMORY_MCP_TOOL_NAMES.FETCH_FILE_FROM_MACHINE,
      MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_DOCS,
      MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL,
      'unrelated_hidden_tool',
    ];
    const targets = names.map((name) => registeredTool({
      name,
      handler: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
    }));
    const { call, sendToolListChanged } = harness(targets);
    const expected = names.slice(0, 4);

    for (const query of ['ocu', 'Open Computer Use', 'computer-control', 'computer_use']) {
      await expect(call({ query })).resolves.toMatchObject({
        structuredContent: {
          status: 'ok',
          publishedGroups: ['file-transfer-computer-use'],
          published: expected,
          groups: [expect.objectContaining({
            id: 'file-transfer-computer-use',
            selector: 'group:file-transfer-computer-use',
            tools: expected,
            published: true,
          })],
        },
      });
      expect(targets.find((tool) => tool.name === 'unrelated_hidden_tool')?.enabled).toBe(false);
    }
    expect(sendToolListChanged).toHaveBeenCalledTimes(4);

    const preview = await call({ query: 'control the desktop please' });
    expect(preview).toMatchObject({
      structuredContent: { publishedGroups: [], published: [] },
    });
    expect((preview.structuredContent as { matches: unknown[] }).matches).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ fallbackContract: expect.anything() }),
    ]));
    expect(targets.every((tool) => tool.enabled === false)).toBe(true);
  });

  it('uses the canonical target input/output schemas and passes the original authority context', async () => {
    const authority = { authInfo: { token: 'opaque-test-authority' }, requestId: 'request-1' };
    const handler = vi.fn(async (_args, extra) => extra === authority
      ? {
          content: [{ type: 'text' as const, text: 'ok' }],
          structuredContent: { ok: true },
        }
      : {
          content: [{ type: 'text' as const, text: 'forbidden' }],
          isError: true,
        });
    const target = registeredTool({
      name: 'secure_exact_tool',
      inputSchema: z.object({ value: z.string().min(1) }).strict(),
      outputSchema: z.object({ ok: z.boolean() }).strict(),
      handler,
    });
    const { call, sendToolListChanged } = harness([target]);

    await expect(call({ query: 'secure_exact_tool' })).resolves.toMatchObject({
      structuredContent: {
        matches: [expect.objectContaining({
          name: 'secure_exact_tool',
          fallbackContract: {
            query: 'secure_exact_tool',
            name: 'secure_exact_tool',
            inputSchema: expect.objectContaining({
              type: 'object',
              properties: expect.objectContaining({ value: expect.objectContaining({ type: 'string' }) }),
              required: ['value'],
            }),
          },
        })],
      },
    });

    const fuzzyPreview = await call({ query: 'secure exact' });
    expect(fuzzyPreview.structuredContent.matches).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ fallbackContract: expect.anything() }),
    ]));

    await expect(call({
      query: 'secure_exact_tool',
      fallbackCall: { name: 'secure_exact_tool', arguments: { value: 'approved' } },
    }, authority)).resolves.toMatchObject({ structuredContent: { ok: true } });
    expect(handler).toHaveBeenCalledWith({ value: 'approved' }, authority);
    expect(sendToolListChanged).toHaveBeenCalledTimes(2);

    const otherAuthority = { authInfo: { token: 'different-authority' }, requestId: 'request-2' };
    await expect(call({
      query: 'secure_exact_tool',
      fallbackCall: { name: 'secure_exact_tool', arguments: { value: 'approved' } },
    }, otherAuthority)).resolves.toMatchObject({ isError: true });
    expect(handler).toHaveBeenLastCalledWith({ value: 'approved' }, otherAuthority);
  });

  it('fails closed for malformed args/output, caller schemas, unknown, prefix, and wildcard targets', async () => {
    const validHandler = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: { ok: true },
    }));
    const malformedOutputHandler = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'bad' }],
      structuredContent: { ok: 'not-a-boolean' },
    }));
    const exact = registeredTool({
      name: 'exact_tool',
      inputSchema: z.object({ value: z.string() }).strict(),
      outputSchema: z.object({ ok: z.boolean() }).strict(),
      handler: validHandler,
    });
    const malformed = registeredTool({
      name: 'malformed_output_tool',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ ok: z.boolean() }).strict(),
      handler: malformedOutputHandler,
    });
    const { call } = harness([exact, malformed]);

    for (const args of [
      { query: 'exact_tool', fallbackCall: { name: 'exact_tool', arguments: { value: 7 } } },
      { query: 'exact_tool', fallbackCall: { name: 'exact_tool', arguments: { value: 'ok' }, schema: {} } },
      { query: 'missing_tool', fallbackCall: { name: 'missing_tool', arguments: {} } },
      { query: 'exact', fallbackCall: { name: 'exact_tool', arguments: { value: 'ok' } } },
      { query: '*', fallbackCall: { name: 'exact_tool', arguments: { value: 'ok' } } },
    ]) {
      await expect(call(args)).resolves.toMatchObject({
        isError: true,
        structuredContent: { status: 'error', reason: 'validation_failed' },
      });
    }
    expect(validHandler).not.toHaveBeenCalled();

    await expect(call({
      query: 'malformed_output_tool',
      fallbackCall: { name: 'malformed_output_tool', arguments: {} },
    })).resolves.toMatchObject({
      isError: true,
      structuredContent: { status: 'error', error: 'fallback tool output failed validation' },
    });
    expect(malformedOutputHandler).toHaveBeenCalledOnce();
  });
});
