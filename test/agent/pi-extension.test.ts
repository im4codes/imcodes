import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mcp = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  listTools: vi.fn(async () => ({
    tools: [{
      name: 'send_message',
      title: 'Send message',
      description: 'Send to another IM.codes session',
      inputSchema: { type: 'object', properties: { target: { type: 'string' } } },
    }],
  })),
  callTool: vi.fn(async () => ({
    content: [{ type: 'text', text: 'delivered' }],
    structuredContent: { delivered: true },
  })),
  close: vi.fn(async () => {}),
  transports: [] as Array<Record<string, unknown>>,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mcp.connect;
    listTools = mcp.listTools;
    callTool = mcp.callTool;
    close = mcp.close;
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(config: Record<string, unknown>) {
      mcp.transports.push(config);
    }
  },
}));

import imcodesPiExtension from '../../src/agent/providers/pi/extension.js';
import {
  PI_MCP_CONFIG_ENV,
  PI_PROVIDER_API_KEY_ENV,
  PI_PROVIDER_CONFIG_ENV,
} from '../../shared/pi-agent.js';

interface RegisteredTool {
  name: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: Array<Record<string, unknown>>; details?: unknown }>;
}

describe('Pi IM.codes extension', () => {
  beforeEach(() => {
    vi.stubEnv(PI_PROVIDER_API_KEY_ENV, 'child-only-key');
    vi.stubEnv(PI_PROVIDER_CONFIG_ENV, JSON.stringify({
      provider: 'minimax',
      model: 'MiniMax-M2.7',
      baseUrl: 'https://api.minimax.io/anthropic',
      contextWindow: 123_456,
    }));
    vi.stubEnv(PI_MCP_CONFIG_ENV, JSON.stringify({
      command: 'imcodes',
      args: ['memory', 'mcp'],
      env: { IMCODES_SESSION: 'deck_test_brain' },
    }));
    vi.clearAllMocks();
    mcp.transports.length = 0;
  });

  afterEach(() => vi.unstubAllEnvs());

  it('registers the third-party route without copying its credential into provider config', async () => {
    const providers: Array<[string, Record<string, unknown>]> = [];
    await imcodesPiExtension({
      registerProvider: (name, config) => providers.push([name, config]),
      registerTool: () => {},
      on: () => {},
    });

    expect(providers).toEqual([[
      'minimax',
      expect.objectContaining({
        baseUrl: 'https://api.minimax.io/anthropic',
        apiKey: `$${PI_PROVIDER_API_KEY_ENV}`,
        models: [expect.objectContaining({ id: 'MiniMax-M2.7', contextWindow: 123_456 })],
      }),
    ]]);
    expect(JSON.stringify(providers)).not.toContain('child-only-key');
  });

  it('mounts MCP tools on session start, proxies execution, and closes on shutdown', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const tools: RegisteredTool[] = [];
    await imcodesPiExtension({
      registerProvider: () => {},
      registerTool: (tool) => tools.push(tool as RegisteredTool),
      on: (event, handler) => handlers.set(event, handler),
    });

    await handlers.get('session_start')?.();
    expect(mcp.transports).toEqual([expect.objectContaining({
      command: 'imcodes',
      args: ['memory', 'mcp'],
      env: { IMCODES_SESSION: 'deck_test_brain' },
    })]);
    expect(tools.map((tool) => tool.name)).toEqual(['send_message']);

    const result = await tools[0].execute('tool-1', { target: 'deck_sub' });
    expect(mcp.callTool).toHaveBeenCalledWith(
      { name: 'send_message', arguments: { target: 'deck_sub' } },
      undefined,
      undefined,
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: 'delivered' }],
      details: { delivered: true },
    });

    await handlers.get('session_shutdown')?.();
    expect(mcp.close).toHaveBeenCalledOnce();
  });
});
