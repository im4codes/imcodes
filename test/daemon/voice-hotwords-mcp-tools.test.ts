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
import { VOICE_HOTWORDS_MCP_TOOL_CONTRACTS } from '../../shared/memory-mcp-contracts.js';
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
      scope: 'project',
      projectKey: 'srv:srv-1::codedeck',
      raw: 'codex-sdk',
      mode: 'merge',
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

  it('projects requested scope cleanly, rejects project writes without caller binding, and denies participant turns', async () => {
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
          'srv:srv-1::codedeck': { raw: '', updatedAt: 30, source: 'mcp' },
        },
        shareWithOthers: { enabled: false, updatedAt: 0 },
      },
    });

    const handlers = createVoiceHotwordsMcpToolHandlers(caller, {
      getVoiceHotwords: getMock,
      setVoiceHotwords: setMock,
    });

    // Default scope is 'all'
    const allRes = await handlers.voice_hotwords_get({});
    expect(getMock).toHaveBeenCalledWith({}, 'srv:srv-1::codedeck');
    expect(allRes).toMatchObject({
      status: 'ok',
      scope: 'all',
      projectKey: 'srv:srv-1::codedeck',
      user: { raw: 'Antigravity' },
      project: { raw: 'IM.codes\n错别词 => IM.codes' },
      compiled: { terms: ['IM.codes', 'Antigravity'] },
    });

    // scope='project' MUST NOT return user field or user terms in compiled
    const projOnly = await handlers.voice_hotwords_get({ scope: 'project' });
    expect(projOnly).not.toHaveProperty('user');
    expect(projOnly).toMatchObject({
      status: 'ok',
      scope: 'project',
      compiled: { terms: ['IM.codes'] },
    });

    // scope='user' MUST NOT return project field or project terms in compiled
    const userOnly = await handlers.voice_hotwords_get({ scope: 'user' });
    expect(userOnly).not.toHaveProperty('project');
    expect(userOnly).toMatchObject({
      status: 'ok',
      scope: 'user',
      compiled: { terms: ['Antigravity'] },
    });

    // Clear with empty entries[] + mode='replace'
    const clearRes = await handlers.voice_hotwords_set({
      scope: 'project',
      entries: [],
      mode: 'replace',
    });
    expect(setMock).toHaveBeenCalledWith({
      scope: 'project',
      projectKey: 'srv:srv-1::codedeck',
      raw: '',
      mode: 'replace',
    }, {});
    expect(clearRes).toMatchObject({ status: 'ok', entry: { raw: '' } });

    // Caller whose raw projectName contains reserved srv:...::... MUST STILL bind its trusted serverId
    const reservedShapeCallerHandlers = createVoiceHotwordsMcpToolHandlers({
      ...caller,
      projectName: 'srv:srv-remote::custom-proj',
      serverId: 'srv-other',
    }, { getVoiceHotwords: getMock, setVoiceHotwords: setMock });
    await reservedShapeCallerHandlers.voice_hotwords_get({ scope: 'all' });
    expect(getMock).toHaveBeenLastCalledWith({}, 'srv:srv-other::srv:srv-remote::custom-proj');

    // Two machines with identical projectName produce distinct bound keys
    const machineOneHandlers = createVoiceHotwordsMcpToolHandlers({
      ...caller,
      projectName: 'codedeck',
      serverId: 'srv-1',
    }, { getVoiceHotwords: getMock, setVoiceHotwords: setMock });
    const machineTwoHandlers = createVoiceHotwordsMcpToolHandlers({
      ...caller,
      projectName: 'codedeck',
      serverId: 'srv-2',
    }, { getVoiceHotwords: getMock, setVoiceHotwords: setMock });
    await machineOneHandlers.voice_hotwords_get({ scope: 'project' });
    expect(getMock).toHaveBeenLastCalledWith({}, 'srv:srv-1::codedeck');
    await machineTwoHandlers.voice_hotwords_get({ scope: 'project' });
    expect(getMock).toHaveBeenLastCalledWith({}, 'srv:srv-2::codedeck');

    // Unbound projectName: scope='project' fails, scope='all' omits project cleanly
    const unboundHandlers = createVoiceHotwordsMcpToolHandlers({
      userId: 'user-1',
      sessionName: 'deck_global_brain',
      namespace: { scope: 'personal', userId: 'user-1' },
    }, { getVoiceHotwords: getMock, setVoiceHotwords: setMock });
    expect(await unboundHandlers.voice_hotwords_get({ scope: 'project' })).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
    });
    expect(await unboundHandlers.voice_hotwords_set({ scope: 'project', raw: 'foo' })).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
    });
    const unboundAll = await unboundHandlers.voice_hotwords_get({});
    expect(unboundAll).toMatchObject({ status: 'ok', scope: 'all', projectKey: null });
    expect(unboundAll).not.toHaveProperty('project');

    // Participant turn denied
    const participantHandlers = createVoiceHotwordsMcpToolHandlers({
      ...caller,
      isParticipantTurn: true,
    }, { getVoiceHotwords: getMock, setVoiceHotwords: setMock });
    expect(await participantHandlers.voice_hotwords_get({})).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN,
    });
    expect(await participantHandlers.voice_hotwords_set({ scope: 'user', raw: 'X' })).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN,
    });
  });

  it('discovers and enforces strict shared schemas over real MCP transport (all, raw/entries, empty replace, reject override args)', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        record: {
          version: 1,
          user: { raw: 'GlobalWord', updatedAt: 10, source: 'web' },
          projects: {
            'srv:srv-1::codedeck': { raw: 'ProjWord', updatedAt: 20, source: 'web' },
          },
          shareWithOthers: { enabled: false, updatedAt: 0 },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        record: {
          version: 1,
          user: { raw: 'GlobalWord\nEntryOne\n错词 => RightWord', updatedAt: 50, source: 'mcp' },
          projects: {
            'srv:srv-1::codedeck': { raw: 'ProjWord', updatedAt: 20, source: 'web' },
          },
          shareWithOthers: { enabled: false, updatedAt: 0 },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        record: {
          version: 1,
          user: { raw: 'GlobalWord\nEntryOne\n错词 => RightWord', updatedAt: 50, source: 'mcp' },
          projects: {
            'srv:srv-1::codedeck': { raw: '', updatedAt: 60, source: 'mcp' },
          },
          shareWithOthers: { enabled: false, updatedAt: 0 },
        },
      }), { status: 200 }));

    // Contracts exist in shared/memory-mcp-contracts.ts
    expect(VOICE_HOTWORDS_MCP_TOOL_CONTRACTS[VOICE_HOTWORDS_MCP_TOOLS.GET]).toBeDefined();
    expect(VOICE_HOTWORDS_MCP_TOOL_CONTRACTS[VOICE_HOTWORDS_MCP_TOOLS.SET]).toBeDefined();

    const server = createMemoryMcpServer(caller, {
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

      const tools = (await client.listTools()).tools;
      const getSchema = tools.find((t) => t.name === VOICE_HOTWORDS_MCP_TOOLS.GET)?.inputSchema as any;
      const setSchema = tools.find((t) => t.name === VOICE_HOTWORDS_MCP_TOOLS.SET)?.inputSchema as any;
      expect(getSchema?.properties?.scope?.enum).toEqual(['all', 'project', 'user']);
      expect(getSchema?.properties?.projectName).toBeUndefined();
      expect(getSchema?.properties?.serverId).toBeUndefined();
      expect(setSchema?.properties?.raw).toBeDefined();
      expect(setSchema?.properties?.entries).toBeDefined();
      expect(setSchema?.properties?.hotwords).toBeUndefined();
      expect(setSchema?.properties?.projectName).toBeUndefined();
      expect(setSchema?.properties?.serverId).toBeUndefined();

      // Default GET uses 'all'
      const defaultGet = await client.callTool({ name: VOICE_HOTWORDS_MCP_TOOLS.GET, arguments: {} });
      expect(defaultGet.isError).not.toBe(true);
      expect(defaultGet.structuredContent).toMatchObject({
        status: 'ok',
        scope: 'all',
        projectKey: 'srv:srv-1::codedeck',
        user: { raw: 'GlobalWord' },
        project: { raw: 'ProjWord' },
      });

      // Strict schema rejects projectName / serverId override attempts
      const rejectedOverride = await client.callTool({
        name: VOICE_HOTWORDS_MCP_TOOLS.SET,
        arguments: { scope: 'project', projectName: 'other', raw: 'Hack' },
      });
      expect(rejectedOverride.isError).toBe(true);

      // entries[] merge on user scope
      const setEntries = await client.callTool({
        name: VOICE_HOTWORDS_MCP_TOOLS.SET,
        arguments: { scope: 'user', entries: ['EntryOne', '错词 => RightWord'] },
      });
      expect(setEntries.isError).not.toBe(true);
      expect(setEntries.structuredContent).toMatchObject({
        status: 'ok',
        scope: 'user',
        mode: 'merge',
      });

      // empty replace clear on bound project
      const clearProj = await client.callTool({
        name: VOICE_HOTWORDS_MCP_TOOLS.SET,
        arguments: { scope: 'project', raw: '', mode: 'replace' },
      });
      expect(clearProj.isError).not.toBe(true);
      expect(clearProj.structuredContent).toMatchObject({
        status: 'ok',
        scope: 'project',
        projectKey: 'srv:srv-1::codedeck',
        entry: { raw: '' },
      });
    } finally {
      await client.close();
    }
  });
});
