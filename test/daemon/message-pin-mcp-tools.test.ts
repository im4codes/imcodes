import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ContextNamespace } from '../../shared/context-types.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../shared/mcp-tool-discovery.js';
import {
  MESSAGE_PIN_ERRORS,
  MESSAGE_PIN_MCP_TOOLS,
  type MessagePin,
} from '../../shared/message-pins.js';
import { createMemoryMcpServer } from '../../src/daemon/memory-mcp-server.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import {
  createMessagePinMcpToolHandlers,
  MESSAGE_PIN_MCP_TOOL_NAME_LIST,
} from '../../src/daemon/message-pin-mcp-tools.js';
import {
  messagePinMcpDelete,
  messagePinMcpGet,
  messagePinMcpList,
  messagePinMcpSave,
  type MessagePinServerEndpoint,
} from '../../src/daemon/message-pin-mcp-client.js';

function caller(overrides: Partial<McpRuntimeCaller> = {}): McpRuntimeCaller {
  const namespace: ContextNamespace = { scope: 'user_private', userId: 'user-1', projectId: 'repo-1' };
  return {
    userId: 'user-1',
    namespace,
    sessionName: 'deck_project_brain',
    projectName: 'project',
    projectRoot: '/tmp/project',
    serverId: 'srv-1',
    transport: 'in_process',
    ...overrides,
  };
}

function pin(overrides: Partial<MessagePin> = {}): MessagePin {
  return {
    id: 'pin-1',
    serverId: 'srv-1',
    sessionName: 'deck_project_brain',
    eventId: 'event-1',
    eventTs: 123,
    eventType: 'assistant.text',
    text: 'Pinned content',
    createdAt: 456,
    updatedAt: 456,
    ...overrides,
  };
}

const ENDPOINT: MessagePinServerEndpoint = {
  serverId: 'srv-1',
  workerUrl: 'https://example.test/',
  token: 'owner-token',
};

describe('message pin MCP tools', () => {
  it('lists current-session pins as bounded previews without accepting caller identity', async () => {
    const fullText = 'x'.repeat(700);
    const listPins = vi.fn<typeof messagePinMcpList>(async () => ({ status: 'ok', pins: [pin({ text: fullText })] }));
    const handlers = createMessagePinMcpToolHandlers(caller(), { listPins });
    const result = await handlers[MESSAGE_PIN_MCP_TOOLS.LIST]({
      scope: 'current',
      query: 'content',
      serverId: 'attacker-server',
      sessionName: 'deck_attacker',
    });

    expect(listPins).toHaveBeenCalledWith({ sessionName: 'deck_project_brain', query: 'content' }, {});
    const item = (result as { pins: Array<Record<string, unknown>> }).pins[0]!;
    expect(item.textPreview).toBe('x'.repeat(500));
    expect(item.textTruncated).toBe(true);
    expect(item).not.toHaveProperty('text');
    expect(item).not.toHaveProperty('serverId');
  });

  it('lists all authorized sessions only when explicitly requested', async () => {
    const listPins = vi.fn<typeof messagePinMcpList>(async () => ({ status: 'ok', pins: [] }));
    const handlers = createMessagePinMcpToolHandlers(caller(), { listPins });
    await handlers[MESSAGE_PIN_MCP_TOOLS.LIST]({ scope: 'all', eventType: 'user.message', limit: 10 });
    expect(listPins).toHaveBeenCalledWith({ eventType: 'user.message', limit: 10 }, {});
  });

  it('pins only into the runtime-bound current session', async () => {
    const savePin = vi.fn<typeof messagePinMcpSave>(async (_sessionName, input) => ({
      status: 'ok',
      pin: pin({ eventId: input.eventId, eventTs: input.eventTs, eventType: input.eventType, text: input.text }),
    }));
    const handlers = createMessagePinMcpToolHandlers(caller(), { savePin });
    const result = await handlers[MESSAGE_PIN_MCP_TOOLS.SAVE]({
      eventId: 'event-2', eventTs: 999, eventType: 'user.message', text: 'Remember this', sessionName: 'deck_attacker',
    });
    expect(result.status).toBe('ok');
    expect(savePin).toHaveBeenCalledWith('deck_project_brain', {
      eventId: 'event-2', eventTs: 999, eventType: 'user.message', text: 'Remember this',
    }, {});
  });

  it('rejects current-session operations for an unscoped runtime caller', async () => {
    const savePin = vi.fn<typeof messagePinMcpSave>();
    const listPins = vi.fn<typeof messagePinMcpList>();
    const handlers = createMessagePinMcpToolHandlers(caller({ sessionName: null }), { savePin, listPins });
    await expect(handlers[MESSAGE_PIN_MCP_TOOLS.SAVE]({})).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
    await expect(handlers[MESSAGE_PIN_MCP_TOOLS.LIST]({ scope: 'current' })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
    expect(savePin).not.toHaveBeenCalled();
    expect(listPins).not.toHaveBeenCalled();
  });

  it('passes get/delete not-found through as non-error results', async () => {
    const getPin = vi.fn<typeof messagePinMcpGet>(async (id) => ({ status: 'ok', found: false, id, reason: MESSAGE_PIN_ERRORS.NOT_FOUND }));
    const deletePin = vi.fn<typeof messagePinMcpDelete>(async (id) => ({ status: 'ok', deleted: false, id, reason: MESSAGE_PIN_ERRORS.NOT_FOUND }));
    const handlers = createMessagePinMcpToolHandlers(caller(), { getPin, deletePin });
    await expect(handlers[MESSAGE_PIN_MCP_TOOLS.GET]({ id: 'missing' })).resolves.toMatchObject({ status: 'ok', found: false });
    await expect(handlers[MESSAGE_PIN_MCP_TOOLS.DELETE]({ id: 'missing' })).resolves.toMatchObject({ status: 'ok', deleted: false });
  });

  it('registers all four tools with strict identity-free schemas', async () => {
    const server = createMemoryMcpServer(caller());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'pin-mcp-test', version: '0.1.0' });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: '*' } });
      const tools = (await client.listTools()).tools;
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([...MESSAGE_PIN_MCP_TOOL_NAME_LIST]));
      for (const name of MESSAGE_PIN_MCP_TOOL_NAME_LIST) {
        const schema = tools.find((tool) => tool.name === name)?.inputSchema;
        expect(JSON.stringify(schema)).not.toContain('serverId');
        expect(JSON.stringify(schema)).not.toContain('sessionName');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('uses the bound credential and pod-sticky server id for HTTP requests', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ pins: [pin()] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const result = await messagePinMcpList({ sessionName: 'deck_project_brain', query: 'Pinned', limit: 5 }, {
      endpoint: ENDPOINT,
      fetchImpl,
    });
    expect(result.status).toBe('ok');
    expect(calls[0]?.url).toBe('https://example.test/api/message-pins?sessionName=deck_project_brain&q=Pinned&limit=5&serverId=srv-1');
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer owner-token');
    expect((calls[0]?.init?.headers as Record<string, string>)['X-Server-Id']).toBe('srv-1');
  });

  it('defaults HTTP list requests to the bounded 200-result limit', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ pins: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await messagePinMcpList({ sessionName: 'deck_project_brain' }, {
      endpoint: ENDPOINT,
      fetchImpl,
    });

    expect(calls).toEqual([
      'https://example.test/api/message-pins?sessionName=deck_project_brain&limit=200&serverId=srv-1',
    ]);
  });
});
