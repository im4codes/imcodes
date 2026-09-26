import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mcp = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  tools: [{
      name: 'send_message',
      title: 'Send message',
      description: 'Send to another IM.codes session',
      inputSchema: { type: 'object', properties: { target: { type: 'string' } } },
    }],
  listTools: vi.fn(async () => ({ tools: mcp.tools })),
  callTool: vi.fn(async () => ({
    content: [{ type: 'text', text: 'delivered' }],
    structuredContent: { delivered: true },
  })),
  notificationHandler: undefined as undefined | (() => void | Promise<void>),
  close: vi.fn(async () => {}),
  transports: [] as Array<Record<string, unknown>>,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mcp.connect;
    listTools = mcp.listTools;
    callTool = mcp.callTool;
    getServerCapabilities = () => ({ tools: { listChanged: true } });
    setNotificationHandler = (_schema: unknown, handler: () => void | Promise<void>) => {
      mcp.notificationHandler = handler;
    };
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

function createPiApi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const tools = new Map<string, RegisteredTool>();
  let activeTools = ['read'];
  return {
    handlers,
    tools,
    get activeTools() { return activeTools; },
    api: {
      registerProvider: () => {},
      registerTool: (tool: RegisteredTool) => { tools.set(tool.name, tool); },
      getActiveTools: () => [...activeTools],
      setActiveTools: (names: string[]) => { activeTools = [...names]; },
      on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
    },
  };
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
    mcp.notificationHandler = undefined;
    mcp.tools = [{
      name: 'send_message',
      title: 'Send message',
      description: 'Send to another IM.codes session',
      inputSchema: { type: 'object', properties: { target: { type: 'string' } } },
    }];
  });

  afterEach(() => vi.unstubAllEnvs());

  it('registers the third-party route without copying its credential into provider config', async () => {
    const providers: Array<[string, Record<string, unknown>]> = [];
    await imcodesPiExtension({
      registerProvider: (name, config) => providers.push([name, config]),
      registerTool: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
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
    const pi = createPiApi();
    await imcodesPiExtension(pi.api);

    await pi.handlers.get('session_start')?.();
    expect(mcp.transports).toEqual([expect.objectContaining({
      command: 'imcodes',
      args: ['memory', 'mcp'],
      env: { IMCODES_SESSION: 'deck_test_brain' },
    })]);
    expect([...pi.tools.keys()]).toEqual(['send_message']);
    expect(pi.activeTools).toEqual(['read', 'send_message']);

    const result = await pi.tools.get('send_message')!.execute('tool-1', { target: 'deck_sub' });
    expect(mcp.callTool).toHaveBeenCalledWith(
      { name: 'send_message', arguments: { target: 'deck_sub' } },
      undefined,
      undefined,
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: 'delivered' }],
      details: { delivered: true },
    });

    await pi.handlers.get('session_shutdown')?.();
    expect(mcp.close).toHaveBeenCalledOnce();
  });

  it('atomically updates the current model-visible tool map on list_changed and cold-hydrates a reconnect', async () => {
    const pi = createPiApi();
    await imcodesPiExtension(pi.api);
    await pi.handlers.get('session_start')?.();

    mcp.tools = [{
      name: 'computer_use_docs',
      description: 'Computer use docs',
      inputSchema: { type: 'object', properties: { topic: { type: 'string' } } },
    }];
    await mcp.notificationHandler?.();
    expect(pi.activeTools).toEqual(['read', 'computer_use_docs']);
    expect(pi.tools.get('computer_use_docs')?.parameters).toMatchObject({
      properties: { topic: { type: 'string' } },
    });
    await expect(pi.tools.get('send_message')?.execute('stale', {})).rejects.toThrow('not callable');

    mcp.tools = [{
      name: 'computer_use_docs',
      description: 'Computer use docs v2',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    }];
    await mcp.notificationHandler?.();
    expect(pi.tools.get('computer_use_docs')?.parameters).toMatchObject({
      required: ['query'], properties: { query: { type: 'string' } },
    });
    expect(pi.activeTools).toEqual(['read', 'computer_use_docs']);

    await pi.handlers.get('session_shutdown')?.();
    mcp.tools = [{
      name: 'capability_status',
      description: 'Capability status',
      inputSchema: { type: 'object', properties: { capabilityId: { type: 'string' } } },
    }];
    await pi.handlers.get('session_start')?.();
    expect(pi.activeTools).toEqual(['read', 'capability_status']);
    expect(mcp.connect).toHaveBeenCalledTimes(2);
    expect(mcp.listTools.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('forces a same-turn refresh after discovery even when the host notification is absent', async () => {
    const pi = createPiApi();
    await imcodesPiExtension(pi.api);
    await pi.handlers.get('session_start')?.();

    mcp.callTool.mockImplementationOnce(async () => {
      mcp.tools = [{
        name: 'mcp_tool_search',
        description: 'Search tools',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      }, {
        name: 'computer_use_call',
        description: 'Computer use',
        inputSchema: { type: 'object', properties: { action: { type: 'string' } } },
      }];
      return {
        content: [{ type: 'text', text: 'published' }],
        structuredContent: { status: 'ok', published: ['computer_use_call'] },
      };
    });
    // Initial catalog does not contain the discovery tool in this compact
    // fixture, so publish it once and deliver one list invalidation first.
    mcp.tools = [{
      name: 'mcp_tool_search',
      description: 'Search tools',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    }];
    await mcp.notificationHandler?.();

    await pi.tools.get('mcp_tool_search')!.execute('search', { query: 'computer_use_call' });
    expect(pi.activeTools).toEqual(['read', 'mcp_tool_search', 'computer_use_call']);
    expect(pi.tools.has('computer_use_call')).toBe(true);

    await pi.handlers.get('session_shutdown')?.();
    mcp.tools = [{
      name: 'mcp_tool_search',
      description: 'Search tools',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    }];
    mcp.callTool.mockImplementationOnce(async (request) => {
      expect(request).toEqual({
        name: 'mcp_tool_search',
        arguments: { query: 'computer_use_call' },
      });
      mcp.tools = [mcp.tools[0], {
        name: 'computer_use_call',
        description: 'Computer use',
        inputSchema: { type: 'object', properties: { action: { type: 'string' } } },
      }];
      return {
        content: [{ type: 'text', text: 'republished' }],
        structuredContent: { status: 'ok', published: ['computer_use_call'] },
      };
    });
    await pi.handlers.get('session_start')?.();
    expect(pi.activeTools).toEqual(['read', 'mcp_tool_search', 'computer_use_call']);
  });
});
