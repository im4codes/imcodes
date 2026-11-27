import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMemoryMcpServer } from '../../src/daemon/memory-mcp-server.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import {
  voiceHotwordsMcpGet,
  voiceHotwordsMcpSet,
} from '../../src/daemon/voice-hotwords-mcp-client.js';
import { createVoiceHotwordsMcpToolHandlers } from '../../src/daemon/voice-hotwords-mcp-tools.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../shared/mcp-tool-discovery.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../shared/shared-machine-authority.js';
import {
  VOICE_HOTWORDS_API_PATH,
  VOICE_HOTWORDS_MCP_TOOLS,
} from '../../shared/voice-hotwords.js';

const caller: McpRuntimeCaller = {
  userId: 'user-1',
  sessionName: 'deck_proj_brain',
  projectName: 'codedeck',
  serverId: 'srv-1',
  namespace: {
    scope: 'personal',
    userId: 'user-1',
    projectId: 'codedeck',
  },
};

describe('voice hotwords MCP client & tools', () => {
  it('calls GET and PUT /api/voice-hotwords with daemon auth and shared-machine authority headers', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        record: {
          version: 1,
          user: { raw: 'Antigravity', updatedAt: 10, source: 'web' },
          projects: {
            'srv:srv-1::codedeck': { raw: 'IM.codes', updatedAt: 20, source: 'web' },
          },
          shareWithOthers: { enabled: false, updatedAt: 0 },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        record: {
          version: 1,
          user: { raw: 'Antigravity', updatedAt: 10, source: 'web' },
          projects: {
            'srv:srv-1::codedeck': { raw: 'IM.codes\ncodex-sdk', updatedAt: 30, source: 'mcp' },
          },
          shareWithOthers: { enabled: false, updatedAt: 0 },
        },
      }), { status: 200 }));

    const opts = {
      endpoint: { serverId: 'srv-1', workerUrl: 'https://worker.example.invalid/', token: 'tok-1' },
      fetchImpl: fetchMock,
      loadSharedMachineAuthority: async () => 'authority-jwt',
    };

    const getRes = await voiceHotwordsMcpGet(opts, 'srv:srv-1::codedeck');
    expect(getRes.status).toBe('ok');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://worker.example.invalid${VOICE_HOTWORDS_API_PATH}?projectKey=srv%3Asrv-1%3A%3Acodedeck`);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer tok-1',
      'X-Server-Id': 'srv-1',
      [SHARED_MACHINE_AUTHORITY_HEADER]: 'authority-jwt',
    });

    const setRes = await voiceHotwordsMcpSet({
      project: { projectKey: 'srv:srv-1::codedeck', raw: 'codex-sdk', mode: 'merge' },
    }, opts);
    expect(setRes.status).toBe('ok');
    if (setRes.status === 'ok') {
      expect(setRes.record.projects['srv:srv-1::codedeck']?.raw).toBe('IM.codes\ncodex-sdk');
    }

    const failFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'shared_participant_forbidden' }), { status: 403 }),
    );
    const forbidden = await voiceHotwordsMcpGet({ ...opts, fetchImpl: failFetch });
    expect(forbidden).toEqual({
      status: 'error',
      reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN,
      message: 'shared_participant_forbidden',
    });
  });

  it('defaults projectName/serverId from caller, supports user & project scopes, and denies participant turns', async () => {
    const getMock = vi.fn().mockResolvedValue({
      status: 'ok',
      record: {
        version: 1,
        user: { raw: 'Antigravity', updatedAt: 10, source: 'web' },
        projects: {
          'srv:srv-1::codedeck': { raw: 'IM.codes\n错别词 => IM.codes', updatedAt: 20, source: 'web' },
        },
        shareWithOthers: { enabled: false, updatedAt: 0 },
      },
    });
    const setMock = vi.fn().mockResolvedValue({
      status: 'ok',
      record: {
        version: 1,
        user: { raw: 'Antigravity', updatedAt: 10, source: 'web' },
        projects: {
          'srv:srv-1::codedeck': { raw: 'IM.codes\n错别词 => IM.codes\nworktree', updatedAt: 30, source: 'mcp' },
        },
        shareWithOthers: { enabled: false, updatedAt: 0 },
      },
    });

    const handlers = createVoiceHotwordsMcpToolHandlers(caller, {
      getVoiceHotwords: getMock,
      setVoiceHotwords: setMock,
    });

    const got = await handlers.voice_hotwords_get({ scope: 'effective' });
    expect(getMock).toHaveBeenCalledWith({}, 'srv:srv-1::codedeck');
    expect(got).toMatchObject({
      status: 'ok',
      scope: 'effective',
      projectKey: 'srv:srv-1::codedeck',
      compiled: {
        terms: ['IM.codes', 'Antigravity'],
        replacements: [{ from: '错别词', to: 'IM.codes' }],
      },
    });

    const setRes = await handlers.voice_hotwords_set({
      scope: 'project',
      hotwords: 'worktree',
    });
    expect(setMock).toHaveBeenCalledWith({
      project: { projectKey: 'srv:srv-1::codedeck', raw: 'worktree', mode: 'merge' },
    }, {});
    expect(setRes).toMatchObject({
      status: 'ok',
      scope: 'project',
      projectKey: 'srv:srv-1::codedeck',
      mode: 'merge',
    });

    const participantHandlers = createVoiceHotwordsMcpToolHandlers({
      ...caller,
      isParticipantTurn: true,
    }, {
      getVoiceHotwords: getMock,
      setVoiceHotwords: setMock,
    });
    expect(await participantHandlers.voice_hotwords_get({})).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN,
    });
    expect(await participantHandlers.voice_hotwords_set({ scope: 'user', hotwords: 'X' })).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN,
    });
  });

  it('discovers and invokes voice_hotwords_get/set via mcp_tool_search on demand without polluting default bootstrap', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        record: {
          version: 1,
          user: { raw: 'UserTerm', updatedAt: 100, source: 'mcp' },
          projects: {},
          shareWithOthers: { enabled: false, updatedAt: 0 },
        },
      }), { status: 200 }));

    const server = createMemoryMcpServer(caller, {}, {
      voiceHotwordsClientOptions: {
        endpoint: { serverId: 'srv-1', workerUrl: 'https://worker.example.invalid', token: 'tok-1' },
        fetchImpl: fetchMock,
      },
    });
    const client = new Client({ name: 'voice-hotwords-mcp-test', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const bootstrapNames = (await client.listTools()).tools.map((t) => t.name);
      expect(bootstrapNames).not.toContain(VOICE_HOTWORDS_MCP_TOOLS.GET);
      expect(bootstrapNames).not.toContain(VOICE_HOTWORDS_MCP_TOOLS.SET);

      const searchRes = await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: 'group:voice-hotwords' },
      });
      expect(searchRes.isError).not.toBe(true);

      const activeNames = (await client.listTools()).tools.map((t) => t.name);
      expect(activeNames).toContain(VOICE_HOTWORDS_MCP_TOOLS.GET);
      expect(activeNames).toContain(VOICE_HOTWORDS_MCP_TOOLS.SET);

      const callRes = await client.callTool({
        name: VOICE_HOTWORDS_MCP_TOOLS.SET,
        arguments: { scope: 'user', hotwords: 'UserTerm', mode: 'replace' },
      });
      expect(callRes.isError).not.toBe(true);
      expect(callRes.structuredContent).toMatchObject({
        status: 'ok',
        scope: 'user',
        entry: { raw: 'UserTerm', updatedAt: 100, source: 'mcp' },
      });
    } finally {
      await client.close();
    }
  });
});
