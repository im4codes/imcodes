import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMemoryMcpServer, mergeDefaultToolDeps, sharedMachineAuthorityFromHookResponse } from '../../src/daemon/memory-mcp-server.js';
import { MEMORY_MCP_TOOL_NAMES as N } from '../../shared/memory-mcp-contracts.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../shared/mcp-tool-discovery.js';
import { SHARED_MACHINE_AUTHORITY_HOOK_PATH } from '../../shared/shared-machine-authority.js';
import { mcpToolPayload } from '../helpers/mcp-tool-result.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';

afterEach(() => vi.restoreAllMocks());

it('node authority accepts only coherent explicit owner/participant replies', () => {
  for (const reply of [{}, { ok: true }, { required: false }, { ok: true, required: 'false' }, { ok: false, required: false },
    { ok: true, required: true, authority: null }, { ok: true, required: true, authority: '' },
    { ok: true, required: false, authority: 'participant' }]) {
    expect(() => sharedMachineAuthorityFromHookResponse(reply)).toThrow('shared_machine_authority_invalid_response');
  }
  expect(sharedMachineAuthorityFromHookResponse({ ok: true, required: false, authority: null })).toBeNull();
  expect(sharedMachineAuthorityFromHookResponse({ ok: true, required: true, authority: 'signed' })).toBe('signed');
});

it.each([{}, { ok: true }, { ok: true, required: true, authority: null }, { ok: true, required: 'false' }])(
  'the actual merged hook loader refuses unknown node authority without blocking non-node tools (%j)', async (reply) => {
    const home = process.env.IMCODES_HOME!;
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'server.json'), JSON.stringify({ workerUrl: 'http://127.0.0.1:1', serverId: 'full-source', token: 'fixture-only' }));
    const dispatch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ machines: [] }), { headers: { 'content-type': 'application/json' } }));
    const hook = createServer((req, res) => {
      expect(req.url).toBe(SHARED_MACHINE_AUTHORITY_HOOK_PATH);
      req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply)); });
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    const address = hook.address(); if (!address || typeof address === 'string') throw Error('expected TCP hook');
    const caller: McpRuntimeCaller = { userId: 'owner', namespace: { scope: 'user_private', userId: 'owner', projectId: 'fixture' },
      sessionName: 'deck_e2e_fixture_brain', projectName: 'fixture', transport: 'in_process' };
    const deps = mergeDefaultToolDeps(caller, {}, { sessionName: caller.sessionName!, sessionInstanceId: 'instance', runtimeEpoch: 'epoch' }, {
      resolveHookAuthority: async () => ({ ok: true, port: address.port } as never),
    });
    const server = createMemoryMcpServer(caller, deps);
    const client = new Client({ name: 'hook-policy', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(b), client.connect(a)]);
    try {
      await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: N.LIST_MACHINES } }); await client.listTools();
      const denied = await client.callTool({ name: N.LIST_MACHINES, arguments: {} });
      expect(denied.isError).toBe(true);
      expect(mcpToolPayload(denied)).toMatchObject({ reason: 'control_plane_unavailable', message: 'shared_machine_authority_invalid_response' });
      expect(dispatch).not.toHaveBeenCalled();
      await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: N.COMPUTER_USE_DOCS } }); await client.listTools();
      expect((await client.callTool({ name: N.COMPUTER_USE_DOCS, arguments: { topic: 'overview' } })).isError).not.toBe(true);
    } finally { await client.close(); await server.close(); await new Promise<void>((resolve, reject) => hook.close((error) => error ? reject(error) : resolve())); }
  },
);
