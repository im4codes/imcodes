import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { MCP_TOOL_DISCOVERY_NAME } from '../../shared/mcp-tool-discovery.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { MEMORY_MCP_TOOL_NAMES, isToolAvailableForRole } from '../../shared/memory-mcp-contracts.js';
import { PORT_FORWARD_LIMITS, PORT_FORWARD_TRANSPORT, PORT_FORWARD_TRANSPORT_PREF } from '../../shared/port-forward.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { createDaemonMachineToolDeps } from '../../src/daemon/machine-mcp-deps.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import { createMemoryMcpServerFromEnv } from '../../src/daemon/memory-mcp-server.js';
import type { MachineToolDeps } from '../../src/daemon/memory-mcp-tools.js';
import { mcpToolPayload } from '../helpers/mcp-tool-result.js';

const caller: McpRuntimeCaller = {
  backend: 'claude-code-sdk',
  sessionName: 'deck_pf_brain',
  providerId: 'claude-code',
  serverId: 'srv_full_1',
};

async function connectMcp(machineDeps: MachineToolDeps, env?: Record<string, string>) {
  const server = createMemoryMcpServerFromEnv({
    env: {
      IMCODES_MCP_SESSION_NAME: caller.sessionName,
      IMCODES_MCP_BACKEND: caller.backend,
      IMCODES_MCP_PROVIDER_ID: caller.providerId,
      IMCODES_MCP_SERVER_ID: caller.serverId,
      ...env,
    },
    toolDeps: { machineDeps },
  });
  const client = new Client({ name: 'pf-mcp-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return client;
}

describe('port forwarding MCP tools & discovery', () => {
  it('enforces FULL-only role gate and keeps bootstrap surface slim until discovered', async () => {
    expect(isToolAvailableForRole(MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_OPEN, NODE_ROLE.CONTROLLED)).toBe(false);
    expect(isToolAvailableForRole(MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_LIST, NODE_ROLE.CONTROLLED)).toBe(false);
    expect(isToolAvailableForRole(MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_CLOSE, NODE_ROLE.CONTROLLED)).toBe(false);
    expect(isToolAvailableForRole(MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_OPEN, NODE_ROLE.FULL)).toBe(true);

    const deps = createDaemonMachineToolDeps({ loadCredential: async () => null });
    const client = await connectMcp(deps);
    try {
      const initial = (await client.listTools()).tools.map((t) => t.name);
      expect(initial).not.toContain(MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_OPEN);
      expect(initial).not.toContain(MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_LIST);
      expect(initial).not.toContain(MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_CLOSE);

      // Chinese / English discovery aliases resolve group:port-forwarding cleanly.
      for (const query of ['group:port-forwarding', 'port forward', '端口转发', 'p2p']) {
        const res = await client.callTool({
          name: MCP_TOOL_DISCOVERY_NAME,
          arguments: { query },
        });
        expect(res.isError).not.toBe(true);
        const text = JSON.stringify(res.structuredContent ?? res.content);
        expect(text).toContain(MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_OPEN);
        expect(text).toContain(MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_LIST);
        expect(text).toContain(MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_CLOSE);
      }

      const refreshed = (await client.listTools()).tools.map((t) => t.name);
      expect(refreshed).toEqual(expect.arrayContaining([
        MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_OPEN,
        MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_LIST,
        MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_CLOSE,
      ]));
    } finally {
      await client.close();
    }
  });

  it('calls port_forward_open, port_forward_list, and port_forward_close via static_full and fallbackCall without leaking capabilities', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const expiresAt = Date.now() + 1800_000;
    const sampleTunnel = {
      tunnelId: 'pf_00112233445566778899aabbccddeeff',
      listenNode: 'self',
      listenServerId: 'srv_full_1',
      listenHost: PORT_FORWARD_LIMITS.LISTEN_HOST,
      listenPort: 41234,
      localEndpoint: '127.0.0.1:41234',
      targetNode: '1234567890',
      targetServerId: 'srv_ctl_1',
      targetNodeId: '1234567890',
      targetHost: '127.0.0.1',
      targetPort: 8080,
      transportMode: PORT_FORWARD_TRANSPORT.DIRECT_UDP_P2P,
      activeConnections: 2,
      bytesSent: 1024,
      bytesReceived: 4096,
      createdAt: expiresAt - 1800_000,
      expiresAt,
      label: 'api-test',
    };

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, tunnel: sampleTunnel }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, tunnels: [sampleTunnel] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, closedCount: 1, closedTunnelIds: [sampleTunnel.tunnelId] }), { status: 200 }));

    const deps = createDaemonMachineToolDeps({
      loadCredential: async () => ({ serverUrl: 'https://example.invalid', serverId: 'srv_full_1', token: 'tok_secret' }),
      loadSharedMachineAuthority: async () => null,
      openPortForward: (opts) => import('../../src/daemon/port-forward-client.js').then((m) => m.openPortForward({ ...opts, fetchImpl: fetchMock })),
      listPortForwards: (opts) => import('../../src/daemon/port-forward-client.js').then((m) => m.listPortForwards({ ...opts, fetchImpl: fetchMock })),
      closePortForward: (opts) => import('../../src/daemon/port-forward-client.js').then((m) => m.closePortForward({ ...opts, fetchImpl: fetchMock })),
    });

    const client = await connectMcp(deps);
    try {
      await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: 'group:port-forwarding' },
      });
      const opened = await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: {
          query: MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_OPEN,
          fallbackCall: {
            name: MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_OPEN,
            arguments: { targetNode: '^^(1234567890)', targetPort: 8080, transport: PORT_FORWARD_TRANSPORT_PREF.AUTO, label: 'api-test' },
          },
        },
      });
      expect(opened.isError).not.toBe(true);
      expect(opened.structuredContent).toEqual({
        status: 'ok',
        tunnelId: sampleTunnel.tunnelId,
        listenNode: 'self',
        listenHost: '127.0.0.1',
        listenPort: 41234,
        localEndpoint: '127.0.0.1:41234',
        targetNode: '1234567890',
        targetNodeId: '1234567890',
        targetHost: '127.0.0.1',
        targetPort: 8080,
        transportMode: PORT_FORWARD_TRANSPORT.DIRECT_UDP_P2P,
        expiresAt,
        label: 'api-test',
      });
      expect(JSON.stringify(opened)).not.toContain('capability');
      expect(JSON.stringify(opened)).not.toContain('listenServerId');

      const listed = await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: {
          query: MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_LIST,
          fallbackCall: {
            name: MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_LIST,
            arguments: {},
          },
        },
      });
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent).toMatchObject({
        status: 'ok',
        tunnels: [{ tunnelId: sampleTunnel.tunnelId, activeConnections: 2, bytesSent: 1024, bytesReceived: 4096 }],
      });

      const closed = await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: {
          query: MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_CLOSE,
          fallbackCall: {
            name: MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_CLOSE,
            arguments: { tunnelId: sampleTunnel.tunnelId },
          },
        },
      });
      expect(closed.isError).not.toBe(true);
      expect(closed.structuredContent).toEqual({
        status: 'ok',
        closedCount: 1,
        closedTunnelIds: [sampleTunnel.tunnelId],
      });
    } finally {
      await client.close();
    }
  });

  it('maps server denial reasons and validates arguments strictly fail-closed', async () => {
    const fetchDenied = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, reason: 'exec_disabled', error: 'node disabled' }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, reason: 'node_offline', error: 'node offline' }), { status: 503 }));

    const deps = createDaemonMachineToolDeps({
      loadCredential: async () => ({ serverUrl: 'https://example.invalid', serverId: 'srv_full_1', token: 'tok_secret' }),
      loadSharedMachineAuthority: async () => null,
      openPortForward: (opts) => import('../../src/daemon/port-forward-client.js').then((m) => m.openPortForward({ ...opts, fetchImpl: fetchDenied })),
    });

    const client = await connectMcp(deps, { IMCODES_MCP_TOOL_CATALOG_MODE: 'static_full' });
    try {
      const denied = await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_OPEN,
        arguments: { targetNode: '1234567890', targetPort: 8080 },
      });
      expect(denied.isError).toBe(true);
      expect(mcpToolPayload(denied)).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.EXEC_DISABLED });

      const offline = await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_OPEN,
        arguments: { targetNode: '1234567890', targetPort: 8080 },
      });
      expect(offline.isError).toBe(true);
      expect(mcpToolPayload(offline)).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.EXEC_OFFLINE });

      const missingCloseArgs = await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_CLOSE,
        arguments: {},
      });
      expect(missingCloseArgs.isError).toBe(true);
      expect(mcpToolPayload(missingCloseArgs)).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
    } finally {
      await client.close();
    }
  });
});
